/**
 * pi-spec — project-root picker + knowledge base for pi.
 *
 * Every new conversation starts by asking where to go:
 *   - pick a known project root (alias), or
 *   - add a new one via fzf (or the built-in browser), then name it.
 *
 * A chosen root creates `<root>/.pi_spec/` with a deterministic knowledge base
 * (overview, file index, inventory, digest). The digest is injected into the
 * system prompt, and the built-in file/bash tools are bound to that root for
 * the rest of the conversation.
 *
 * Commands: /spec [status|root|add|use|refresh|analyze|list|forget|alias]
 * Tool:     spec_lookup
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildKnowledge, countArtifacts, hasSpec, readFilesIndex, readKnowledge, readMeta, specPaths } from "./knowledge.ts";
import { pickDirectory, homeDir, which } from "./picker.ts";
import { ensureGlobalAgentsFile, ensureScaffolding } from "./scaffold.ts";
import { debugLog, relaunchPi, type RelaunchResult } from "./relaunch.ts";
import {
	OUTPUT_DIR,
	SPEC_DIR,
	addRoot,
	byAlias,
	canonical,
	containingRoot,
	loadRegistry,
	removeRoot,
	saveRegistry,
	sortedRoots,
	touch,
} from "./registry.ts";

const STATUS_KEY = "pi-spec";
const WIDGET_KEY = "pi-spec-build";
const ENTRY_TYPE = "pi-spec-root";
const SUBCOMMANDS = [
	"status",
	"global",
	"root",
	"add",
	"use",
	"refresh",
	"restart",
	"init",
	"analyze",
	"list",
	"forget",
	"alias",
] as const;

interface ActiveRoot {
	alias: string;
	root: string;
}

const state: {
	active?: ActiveRoot;
	digest?: { root: string; mtimeMs: number; text: string };
} = {};

let api: ExtensionAPI | undefined;

type AnyToolDefinition = ToolDefinition<any, any, any>;

const TOOL_FACTORIES: Record<string, (cwd: string) => AnyToolDefinition> = {
	read: (cwd) => createReadToolDefinition(cwd),
	write: (cwd) => createWriteToolDefinition(cwd),
	edit: (cwd) => createEditToolDefinition(cwd),
	bash: (cwd) => createBashToolDefinition(cwd),
	grep: (cwd) => createGrepToolDefinition(cwd),
	find: (cwd) => createFindToolDefinition(cwd),
	ls: (cwd) => createLsToolDefinition(cwd),
};

const definitionCache = new Map<string, Map<string, AnyToolDefinition>>();

function definitionsFor(root: string): Map<string, AnyToolDefinition> {
	let definitions = definitionCache.get(root);
	if (!definitions) {
		definitions = new Map();
		for (const [name, factory] of Object.entries(TOOL_FACTORIES)) definitions.set(name, factory(root));
		definitionCache.set(root, definitions);
	}
	return definitions;
}

function statusText(active: ActiveRoot | undefined): string | undefined {
	return active ? `⬢ ${active.alias} · ${active.root}` : undefined;
}

function absoluteActivePath(): string | undefined {
	return state.active?.root;
}

function setActive(input: ActiveRoot, ctx: ExtensionContext, persist: boolean): void {
	let active = input;
	if (persist) {
		const registry = loadRegistry();
		const existing = byAlias(registry, active.alias);
		if (existing && canonical(existing.root) === canonical(active.root)) {
			touch(registry, active.alias);
		} else {
			const added = addRoot(registry, active.root, active.alias);
			if (added.redirectedTo) active = { alias: added.redirectedTo.alias, root: added.redirectedTo.root };
			else active = { alias: added.entry.alias, root: added.entry.root };
		}
		saveRegistry(registry);
		try {
			api?.appendEntry(ENTRY_TYPE, { alias: active.alias, root: active.root });
		} catch {
			// ephemeral sessions cannot store entries
		}
	}
	state.active = active;
	state.digest = undefined;
	ctx.ui.setStatus(STATUS_KEY, statusText(active));
}

function readActiveFromSession(ctx: ExtensionContext): ActiveRoot | undefined {
	try {
		const entries = ctx.sessionManager.getEntries();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
			if (entry?.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as { alias?: unknown; root?: unknown } | undefined;
			if (!data || typeof data.root !== "string") continue;
			return { alias: typeof data.alias === "string" ? data.alias : basename(data.root), root: data.root };
		}
	} catch {
		// ignore unreadable sessions
	}
	return undefined;
}

const MAX_AGE_MS = Number(process.env.PI_SPEC_MAX_AGE_HOURS || 24) * 3_600_000;

/** True when this process was started by pi-spec to sit in `PI_SPEC_ROOT`. */
function isRelaunchedChild(ctx: ExtensionContext): boolean {
	if (process.env.PI_SPEC_RELAUNCHED !== "1") return false;
	const root = process.env.PI_SPEC_ROOT;
	return Boolean(root) && canonical(root as string) === canonical(ctx.cwd);
}

function consumeRelaunchMarkers(): void {
	delete process.env.PI_SPEC_RELAUNCHED;
	delete process.env.PI_SPEC_ROOT;
	delete process.env.PI_SPEC_ALIAS;
}

function relaunchTargetActive(ctx: ExtensionContext): ActiveRoot {
	const registry = loadRegistry();
	const alias = process.env.PI_SPEC_ALIAS;
	const entry = (alias ? byAlias(registry, alias) : undefined) ?? containingRoot(registry, ctx.cwd);
	if (entry) return { alias: entry.alias, root: entry.root };
	return { alias: alias || basename(ctx.cwd) || "workspace", root: canonical(ctx.cwd) };
}

function isStale(root: string): boolean {
	const meta = readMeta(root);
	return !meta || Date.now() - meta.updatedAt > MAX_AGE_MS;
}

function getDigest(root: string): string | undefined {
	const file = specPaths(root).knowledge;
	try {
		const stat = statSync(file);
		if (state.digest && state.digest.root === root && state.digest.mtimeMs === stat.mtimeMs) return state.digest.text;
		const text = readKnowledge(root);
		if (!text) return undefined;
		state.digest = { root, mtimeMs: stat.mtimeMs, text };
		return text;
	} catch {
		return undefined;
	}
}

async function ensureKnowledge(active: ActiveRoot, ctx: ExtensionContext, force = false): Promise<boolean> {
	if (!existsSync(active.root)) {
		ctx.ui.setStatus(STATUS_KEY, statusText(state.active));
		ctx.ui.notify(`pi-spec: root does not exist: ${active.root}`, "error");
		return false;
	}
	if (!force && hasSpec(active.root)) return true;
	if (!ctx.hasUI) return hasSpec(active.root);
	ctx.ui.setStatus(STATUS_KEY, `⬢ ${active.alias} · scanning…`);
	try {
		const result = await buildKnowledge(active.root, active.alias, {
			onProgress: (message) => ctx.ui.setWidget(WIDGET_KEY, [`${SPEC_DIR}: ${message}`]),
		});
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		state.digest = undefined;
		ctx.ui.setStatus(STATUS_KEY, statusText(state.active));
		ctx.ui.notify(
			`${active.alias}: indexed ${result.stats.files} files → ${join(active.root, SPEC_DIR)}`,
			"info",
		);
		return true;
	} catch (error) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, statusText(state.active));
		ctx.ui.notify(`pi-spec: knowledge build failed: ${(error as Error).message}`, "error");
		return false;
	}
}

async function refreshKnowledge(active: ActiveRoot, ctx: ExtensionContext): Promise<void> {
	if (!active) return;
	await ensureKnowledge(active, ctx, true);
}

/** Ask for a directory and register it, returning the resulting root entry. */
async function addRootInteractive(
	ctx: ExtensionContext,
	options: { startDir?: string } = {},
): Promise<ActiveRoot | undefined> {
	const registry = loadRegistry();
	const directory = await pickDirectory(ctx, {
		title: "Pick the project root",
		startDir: options.startDir || homeDir(),
	});
	if (!directory) return undefined;

	const existing = containingRoot(registry, directory);
	if (existing) {
		ctx.ui.notify(`Already registered as "${existing.alias}" — using ${existing.root}`, "info");
		return { alias: existing.alias, root: existing.root };
	}

	const suggestion = basename(canonical(directory));
	const aliasInput = await ctx.ui.input(`Alias for ${directory} (enter = ${suggestion})`, suggestion);
	if (aliasInput === undefined) return undefined;

	const result = addRoot(registry, directory, aliasInput.trim() || suggestion);
	saveRegistry(registry);
	if (result.entry.alias !== (aliasInput.trim() || suggestion)) {
		ctx.ui.notify(`Alias "${aliasInput.trim()}" is taken — using "${result.entry.alias}"`, "info");
	}
	return { alias: result.entry.alias, root: result.entry.root };
}

function promptLabel(entry: { alias: string; root: string }, current?: ActiveRoot): string {
	const marker = current && current.root === entry.root ? "● " : "  ";
	return `${marker}${entry.alias} — ${entry.root}`;
}

/** Startup/new-conversation prompt. */
async function promptForRoot(ctx: ExtensionContext, defaultRoot?: ActiveRoot): Promise<ActiveRoot | undefined> {
	const registry = loadRegistry();
	const roots = sortedRoots(registry);
	const current = defaultRoot ?? (state.active ? { ...state.active } : undefined);

	const options: string[] = [];
	const actions = new Map<string, () => Promise<ActiveRoot | undefined> | ActiveRoot | undefined>();

	for (const entry of roots) {
		const label = promptLabel(entry, current);
		options.push(label);
		actions.set(label, () => ({ alias: entry.alias, root: entry.root }));
	}
	const addLabel = "＋ Add a new project root…";
	options.push(addLabel);
	actions.set(addLabel, () => addRootInteractive(ctx));

	const here = canonical(ctx.cwd);
	const home = canonical(homeDir());
	const tooBroad = here === "/" || here === home || home.startsWith(`${here}/`);
	if (!tooBroad && !containingRoot(registry, here)) {
		const hereLabel = `• Use current directory — ${here}`;
		options.push(hereLabel);
		actions.set(hereLabel, () => ({ alias: basename(here) || "workspace", root: here }));
	}

	const title = current ? `Where to? (now: ${current.alias})` : "Where to? Pick a project root";
	const choice = await ctx.ui.select(title, options);
	if (!choice) return undefined;
	const action = actions.get(choice);
	if (!action) return undefined;
	return await action();
}

function startPromptForKnowledge(active: ActiveRoot, ctx: ExtensionContext, force = false): void {
	void ensureKnowledge(active, ctx, force);
}

/** Build knowledge when missing/stale, otherwise just report what is indexed. */
function announceKnowledge(active: ActiveRoot, ctx: ExtensionContext): void {
	const stale = hasSpec(active.root) && isStale(active.root);
	if (!hasSpec(active.root) || stale) {
		if (stale) ctx.ui.notify(`pi-spec: knowledge for ${active.alias} is stale — refreshing in the background`, "info");
		startPromptForKnowledge(active, ctx, stale);
		return;
	}
	const meta = readMeta(active.root);
	if (!meta) return;
	ctx.ui.notify(
		`${active.alias}: ${meta.stats.files} files indexed${meta.git?.branch ? ` · ${meta.git.branch}` : ""} — /spec refresh to rebuild`,
		"info",
	);
}

/**
 * First-selection scaffolding: AGENTS.md rules, `.pi_output/`, `.pi_spec/script/`.
 * Runs once per registry entry; `force` refreshes the files again.
 */
function ensureRootSetup(active: ActiveRoot, ctx: ExtensionContext, force = false): void {
	const registry = loadRegistry();
	const entry =
		byAlias(registry, active.alias) ?? registry.roots.find((item) => canonical(item.root) === canonical(active.root));
	const first = force || !entry?.initializedAt;
	const result = ensureScaffolding(active.root, active.alias);

	if (result.agents === "failed") {
		ctx.ui.notify(`pi-spec: could not write ${join(active.root, "AGENTS.md")}`, "warning");
	}
	if (entry && !entry.initializedAt) {
		entry.initializedAt = Date.now();
		saveRegistry(registry);
	}
	if (first) {
		const agents = result.agents === "created" ? "AGENTS.md created" : `AGENTS.md ${result.agents}`;
		ctx.ui.notify(
			`pi-spec: initialized ${active.alias} — ${agents}, ${OUTPUT_DIR}/ ready, generated scripts → ${SPEC_DIR}/script/`,
			"info",
		);
	}
}

/** Relaunch pi inside `target.root`; returns true when the process was replaced. */
async function restartInRoot(
	target: ActiveRoot,
	ctx: ExtensionContext,
	options: { keepPrompts: boolean },
): Promise<boolean> {
	ensureRootSetup(target, ctx);
	await ensureKnowledge(target, ctx);
	ctx.ui.notify(`pi-spec: starting pi in ${target.root}…`, "info");
	const result: RelaunchResult = await relaunchPi(ctx, target, options);
	if (!result.launched || result.failed) {
		const reason = result.error ?? `pi exited with status ${result.status ?? "?"}`;
		ctx.ui.notify(`pi-spec: could not restart pi (${reason}) — tools stay bound to the root`, "error");
		return false;
	}
	ctx.shutdown();
	return true;
}

export default function (pi: ExtensionAPI) {
	api = pi;
	debugLog(`extension loaded in ${process.cwd()} (argv=${JSON.stringify(process.argv.slice(2))})`);

	// The file/bash tools follow the active root for the whole conversation.
	for (const name of Object.keys(TOOL_FACTORIES)) {
		const template = definitionsFor(process.cwd()).get(name) as AnyToolDefinition;
		const wrapper: AnyToolDefinition = {
			...template,
			async execute(toolCallId, params, signal, onUpdate, toolCtx) {
				const root = absoluteActivePath() ?? toolCtx.cwd;
				const definition = definitionsFor(root).get(name);
				if (!definition) throw new Error(`pi-spec: tool ${name} is not available`);
				// Built-in tools prefer ctx.cwd over their constructor cwd, so rebind it here.
				const boundCtx = toolCtx ? { ...toolCtx, cwd: root } : toolCtx;
				return definition.execute(toolCallId, params, signal, onUpdate, boundCtx);
			},
		};
		pi.registerTool(wrapper);
	}

	pi.registerTool({
		name: "spec_lookup",
		label: "Spec Lookup",
		description:
			"Search the .pi_spec knowledge base of the active project root. Matches paths, symbol names, file summaries and the knowledge digest. Use it to find where logic lives before reading files.",
		parameters: Type.Object({
			query: Type.String({ description: "Substring or path glob fragment to search for" }),
			limit: Type.Optional(Type.Number({ description: "Maximum matches to return (default 25)" })),
		}),
		async execute(_toolCallId, params) {
			const active = state.active;
			if (!active) {
				return {
					content: [{ type: "text" as const, text: "pi-spec: no active project root. Run /spec root to choose one." }],
					details: { matches: 0 },
				};
			}
			const query = params.query.trim().toLowerCase();
			const limit = Math.max(1, Math.min(params.limit ?? 25, 200));
			const files = readFilesIndex(active.root);
			const matches = files
				.filter((file) => {
					if (!query) return true;
					return (
						file.path.toLowerCase().includes(query) ||
						file.summary.toLowerCase().includes(query) ||
						file.symbols.some((symbol) => symbol.toLowerCase().includes(query))
					);
				})
				.slice(0, limit);

			const digest = getDigest(active.root) || "";
			const digestLines = query
				? digest.split("\n").filter((line) => line.toLowerCase().includes(query)).slice(0, 8)
				: [];
			const meta = readMeta(active.root);

			const lines = [
				`Project: ${active.alias} (${active.root})`,
				meta ? `${meta.stats.files} files · ${meta.stats.dirs} dirs · ${meta.stats.lines} lines` : "",
				"",
				matches.length > 0 ? "Matches:" : "No file matches.",
				...matches.map((file) => {
					const symbols = file.symbols.length > 0 ? ` [${file.symbols.slice(0, 5).join(", ")}]` : "";
					return `- ${file.path} (${file.kind}${file.lines ? `, ${file.lines} lines` : ""})${symbols}${file.summary ? ` — ${file.summary}` : ""}`;
				}),
			].filter(Boolean);
			if (digestLines.length > 0) lines.push("", "Digest matches:", ...digestLines);
			lines.push("", `Full index: ${join(active.root, SPEC_DIR, "INDEX.md")}`);

			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { matches: matches.length } };
		},
	});

	pi.on("session_start", async (event, ctx) => {
		const restored = readActiveFromSession(ctx);
		debugLog(
			`session_start reason=${event.reason} mode=${ctx.mode} hasUI=${ctx.hasUI} cwd=${ctx.cwd} marker=${process.env.PI_SPEC_RELAUNCHED ?? "-"} markerRoot=${process.env.PI_SPEC_ROOT ?? "-"} restored=${restored?.alias ?? "-"}`,
		);

		// Reloads and resumed sessions keep whatever root the session already had.
		if (event.reason === "reload") {
			if (restored) setActive(restored, ctx, false);
			return;
		}
		if (event.reason === "resume" || event.reason === "fork") {
			if (restored) {
				setActive(restored, ctx, false);
				if (!hasSpec(restored.root)) startPromptForKnowledge(restored, ctx);
			}
			return;
		}

		// Fresh process started by the relaunch path: the cwd already is the root.
		if (event.reason === "startup" && isRelaunchedChild(ctx)) {
			const active = relaunchTargetActive(ctx);
			consumeRelaunchMarkers();
			setActive(active, ctx, true);
			ensureRootSetup(active, ctx);
			announceKnowledge(active, ctx);
			return;
		}

		const interactive = ctx.hasUI && ctx.mode === "tui";
		if (!interactive) {
			// print/json/rpc without dialogs: attach to cwd or its registered root.
			const registry = loadRegistry();
			const covered = containingRoot(registry, ctx.cwd);
			const active: ActiveRoot = covered
				? { alias: covered.alias, root: covered.root }
				: { alias: basename(ctx.cwd) || "workspace", root: canonical(ctx.cwd) };
			setActive(active, ctx, false);
			return;
		}

		const chosen = await promptForRoot(ctx, restored);
		if (!chosen) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		if (canonical(chosen.root) !== canonical(ctx.cwd)) {
			// pi's own cwd cannot be changed in-process: restart pi inside the root.
			setActive(chosen, ctx, true);
			await restartInRoot(chosen, ctx, { keepPrompts: event.reason === "startup" });
			return;
		}

		setActive(chosen, ctx, true);
		ensureRootSetup(chosen, ctx);
		announceKnowledge(chosen, ctx);
	});

	pi.on("before_agent_start", async (event) => {
		const active = state.active;
		if (!active) return;
		const options = event.systemPromptOptions;
		const digest = getDigest(active.root);

		options.cwd = active.root;
		const sections = options.sections ?? (options.sections = {});
		const parts = [
			`Project root: ${active.root}`,
			`Alias: ${active.alias}`,
			`All file, grep, find, ls, edit, write and bash tools operate with this root as their working directory; resolve relative paths against it.`,
			`A deterministic knowledge base lives in ${SPEC_DIR}/ (PROJECT.md, INDEX.md, files.json, KNOWLEDGE.md). Call spec_lookup to search it, and read those files for overviews instead of crawling the tree.`,
			`Generated scripts, codemods, and one-off helpers belong in ${SPEC_DIR}/script/ — do not add throwaway scripts to the project source. All generated artifacts (reports, exports, logs, datasets) belong in ${OUTPUT_DIR}/.`,
			`The rules are also recorded in ${join(active.root, "AGENTS.md")} under the pi-spec markers.`,
		];
		const artifacts = countArtifacts(active.root);
		parts.push(`Artifacts so far: ${artifacts.scripts} script(s) in ${SPEC_DIR}/script/, ${artifacts.outputs} file(s) in ${OUTPUT_DIR}/.`);
		if (digest) parts.push("", digest.trim());
		else parts.push("", `Knowledge base not built yet. Run /spec refresh to index this root.`);
		sections["pi-spec"] = parts.join("\n");

		const guidelines = options.promptGuidelines ?? (options.promptGuidelines = []);
		if (!guidelines.some((line) => line.includes("spec_lookup"))) {
			guidelines.push(`Use spec_lookup to locate files and symbols in ${SPEC_DIR} before broad greps.`);
		}

		// pi loads AGENTS.md from the process cwd; load the root's copy explicitly.
		const agents = join(active.root, "AGENTS.md");
		if (existsSync(agents)) {
			const contextFiles = options.contextFiles ?? (options.contextFiles = []);
			if (!contextFiles.some((file) => canonical(file.path) === canonical(agents))) {
				try {
					contextFiles.push({ path: agents, content: readFileSync(agents, "utf8").slice(0, 40_000) });
				} catch {
					// ignore unreadable context file
				}
			}
		}
	});

	pi.on("session_shutdown", () => {
		state.active = undefined;
		state.digest = undefined;
	});
	pi.registerCommand("spec", {
		description: "pi-spec: show/change the project root, rebuild or analyze the knowledge base",
		getArgumentCompletions: (prefix) =>
			SUBCOMMANDS.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const [rawCommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const command = rawCommand || "status";
			const aliasArg = rest.join(" ").trim();

			const requireActive = (): ActiveRoot | undefined => {
				if (!state.active) {
					ctx.ui.notify("pi-spec: no active root. Run /spec root.", "warning");
					return undefined;
				}
				return state.active;
			};

			switch (command) {
				case "status": {
					if (process.env.PI_SPEC_DEBUG_LOG) {
						const files = (ctx.getSystemPromptOptions().contextFiles ?? []).map((file) => file.path);
						debugLog(`context files: ${JSON.stringify(files)}`);
					}
					await showStatus(ctx, requireActive());
					return;
				}
				case "root":
				case "use": {
					if (aliasArg) {
						const registry = loadRegistry();
						const entry = byAlias(registry, aliasArg);
						if (!entry) {
							ctx.ui.notify(`pi-spec: unknown alias "${aliasArg}". Known: ${registry.roots.map((r) => r.alias).join(", ") || "(none)"}`, "warning");
							return;
						}
						await activate({ alias: entry.alias, root: entry.root }, ctx);
						return;
					}
					const chosen = await promptForRoot(ctx, state.active);
					if (chosen) await activate(chosen, ctx);
					return;
				}
				case "add": {
					const added = await addRootInteractive(ctx);
					if (added) await activate(added, ctx);
					return;
				}
				case "refresh": {
					const active = requireActive();
					if (!active) return;
					await refreshKnowledge(active, ctx);
					await showStatus(ctx, active);
					return;
				}
				case "global": {
					const file = join(getAgentDir(), "AGENTS.md");
					const result = ensureGlobalAgentsFile(getAgentDir());
					if (result === "failed") {
						ctx.ui.notify(`pi-spec: could not write ${file}`, "error");
						return;
					}
					ctx.ui.notify(`pi-spec: global rules ${result} in ${file}`, "info");
					return;
				}
				case "init": {
					const active = requireActive();
					if (!active) return;
					ensureRootSetup(active, ctx, true);
					ctx.ui.notify(
						`pi-spec: refreshed ${join(active.root, "AGENTS.md")}, ${join(active.root, OUTPUT_DIR)}/, ${join(active.root, SPEC_DIR, "script")}/`,
						"info",
					);
					return;
				}
				case "restart": {
					const active = requireActive();
					if (!active) return;
					if (canonical(active.root) === canonical(ctx.cwd)) {
						ctx.ui.notify("pi-spec: pi already runs inside this root.", "info");
						return;
					}
					const restarted = await restartInRoot(active, ctx, { keepPrompts: false });
					if (!restarted) await activate(active, ctx);
					return;
				}
				case "analyze":
					void runAnalyze(ctx, requireActive(), aliasArg);
					return;
				case "list": {
					const registry = loadRegistry();
					if (registry.roots.length === 0) {
						ctx.ui.notify("pi-spec: registry is empty. Use /spec add.", "info");
						return;
					}
					const lines = sortedRoots(registry).map(
						(entry) => `${entry.alias === state.active?.alias ? "●" : " "} ${entry.alias} — ${entry.root}`,
					);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				case "forget": {
					if (!aliasArg) {
						ctx.ui.notify("Usage: /spec forget <alias>", "warning");
						return;
					}
					const registry = loadRegistry();
					if (!removeRoot(registry, aliasArg)) {
						ctx.ui.notify(`pi-spec: no alias "${aliasArg}"`, "warning");
						return;
					}
					saveRegistry(registry);
					if (state.active?.alias === aliasArg) {
						state.active = undefined;
						state.digest = undefined;
						ctx.ui.setStatus(STATUS_KEY, undefined);
					}
					ctx.ui.notify(`pi-spec: removed "${aliasArg}" from the registry (files untouched)`, "info");
					return;
				}
				case "alias": {
					const active = requireActive();
					if (!active) return;
					if (!aliasArg) {
						ctx.ui.notify(`Current alias: ${active.alias}. Usage: /spec alias <new-name>`, "info");
						return;
					}
					const registry = loadRegistry();
					const entry = byAlias(registry, active.alias);
					if (!entry) {
						ctx.ui.notify("pi-spec: current root is not in the registry", "warning");
						return;
					}
					const desired = aliasArg.trim();
					if (byAlias(registry, desired) && desired !== entry.alias) {
						ctx.ui.notify(`pi-spec: "${desired}" already exists`, "warning");
						return;
					}
					entry.alias = desired;
					registry.lastAlias = desired;
					saveRegistry(registry);
					state.active = { alias: desired, root: entry.root };
					ctx.ui.setStatus(STATUS_KEY, statusText(state.active));
					ctx.ui.notify(`pi-spec: renamed to "${desired}"`, "info");
					return;
				}
				default:
					ctx.ui.notify(`pi-spec: unknown subcommand "${command}". Try: ${SUBCOMMANDS.join(", ")}`, "warning");
			}
		},
	});

	async function activate(next: ActiveRoot, ctx: ExtensionCommandContext): Promise<void> {
		const native = canonical(next.root) === canonical(ctx.cwd);
		if (!native && ctx.hasUI && ctx.mode === "tui") {
			const restart = await ctx.ui.confirm(
				`Move pi into ${next.root}?`,
				`pi restarts in that directory; this conversation stays saved.\n\nChoose No to keep this session and bind the tools to the root instead.`,
			);
			if (restart) {
				setActive(next, ctx, true);
				await restartInRoot(next, ctx, { keepPrompts: false });
				return;
			}
		}
		setActive(next, ctx, true);
		ensureRootSetup(next, ctx);
		ctx.ui.notify(`pi-spec: root → ${next.alias} (${next.root})${native ? "" : " (tools bound)"}`, "info");
		await ensureKnowledge(next, ctx);
	}

	async function showStatus(ctx: ExtensionCommandContext, active: ActiveRoot | undefined): Promise<void> {
		const registry = loadRegistry();
		const lines: string[] = [];
		if (active) {
			const meta = readMeta(active.root);
			lines.push(`Active: ${active.alias} → ${active.root}`);
			if (meta) {
				lines.push(
					`Indexed: ${meta.stats.files} files, ${meta.stats.dirs} dirs, ${meta.stats.lines} lines (${new Date(meta.updatedAt).toLocaleString()})`,
				);
				if (meta.git) lines.push(`Git: ${meta.git.branch ?? "?"}${meta.git.dirty ? " (dirty)" : ""} · ${meta.git.commit ?? ""}`);
			} else {
				lines.push("Indexed: not yet — run /spec refresh");
			}
			lines.push(`Knowledge: ${join(active.root, SPEC_DIR)}`);
			lines.push(
				existsSync(join(active.root, "AGENTS.md"))
					? `Rules: ${join(active.root, "AGENTS.md")} (pi-spec block) · artifacts: ${SPEC_DIR}/script/, ${OUTPUT_DIR}/`
					: `Rules: AGENTS.md missing — run /spec init`,
			);
			lines.push(
				canonical(active.root) === canonical(ctx.cwd)
					? `Mode: native — pi runs inside the root`
					: `Mode: bound — pi cwd is ${ctx.cwd}; /spec restart moves pi into the root`,
			);
		} else {
			lines.push("No active root.");
		}
		const globalAgents = join(getAgentDir(), "AGENTS.md");
		lines.push(
			"",
			existsSync(globalAgents) ? `Global rules: ${globalAgents}` : `Global rules: missing — run /spec global`,
			`fzf: ${which("fzf") ?? "not installed (built-in browser used)"}`,
			`Registry (${registry.roots.length}):`,
			...sortedRoots(registry).map((entry) => `  ${entry.alias} — ${entry.root}`),
		);
		ctx.ui.notify(lines.join("\n"), "info");
	}
}

/** Kick off an agent run that turns the deterministic knowledge into analysis docs. */
async function runAnalyze(ctx: ExtensionCommandContext, active: ActiveRoot | undefined, focus?: string): Promise<void> {
	if (!active) return;
	if (!hasSpec(active.root)) {
		await ensureKnowledge(active, ctx, true);
	}
	const specDir = join(active.root, SPEC_DIR);
	const prompt = [
		`Deep-analyze the project at ${active.root} (alias: ${active.alias}) and extend its knowledge base.`,
		``,
		`Read first:`,
		`- ${join(specDir, "PROJECT.md")}`,
		`- ${join(specDir, "INDEX.md")}`,
		`- ${join(specDir, "KNOWLEDGE.md")}`,
		`- ${join(specDir, "files.json")} (inventory; use it instead of crawling the whole tree)`,
		``,
		`Then read the most important source files and documentation, and write:`,
		`1. ${join(specDir, "ARCHITECTURE.md")} — how the logic is organized: components, data flow, entry points, external dependencies, conventions, and risky areas. Cite file paths.`,
		`2. ${join(specDir, "GLOSSARY.md")} — domain terms with one-line definitions and where they live in code.`,
		``,
		focus ? `Focus this pass on: ${focus}.` : `Cover code and documentation, not just code.`,
		``,
		`Only write inside ${specDir}/. Do not modify source files. Keep both documents concise and navigable.`,
	].join("\n");
	ctx.ui.notify("pi-spec: asking the agent for a deep analysis…", "info");
	api?.sendUserMessage(prompt);
}
