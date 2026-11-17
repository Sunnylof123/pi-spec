/**
 * Directory picker for pi-spec.
 *
 * Prefers `fzf` (with `fd` producing candidates) rendered inside the TUI by
 * suspending it; falls back to a plain TUI browser when fzf or fd is missing.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_BROWSE_ENTRIES = 400;

export function which(binary: string): string | undefined {
	const path = process.env.PATH || "";
	for (const dir of path.split(":")) {
		if (!dir) continue;
		const candidate = join(dir, binary);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// keep looking
		}
	}
	return undefined;
}

export function homeDir(): string {
	return process.env.HOME || homedir();
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function listDirectories(dir: string): string[] {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const dirs: string[] = [];
	for (const entry of entries) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(full))) dirs.push(entry.name);
	}
	return dirs.sort((a, b) => (a.startsWith(".") === b.startsWith(".") ? a.localeCompare(b) : a.startsWith(".") ? 1 : -1));
}

async function pickWithFzf(
	ctx: ExtensionContext,
	startDir: string,
	fzf: string,
	title: string,
): Promise<{ picked?: string; failed: boolean }> {
	const fd = which("fd");
	const source = fd
		? `${shellQuote(fd)} --color=never --type dir --hidden --exclude .git --exclude node_modules --exclude .venv --exclude venv --exclude .cache --exclude .npm --exclude .nvm --exclude .cargo --exclude .rustup --exclude .local --exclude .m2 --exclude .gradle --max-depth ${process.env.PI_SPEC_FZF_DEPTH || 6} . ${shellQuote(startDir)}`
		: `find ${shellQuote(startDir)} -maxdepth ${process.env.PI_SPEC_FZF_DEPTH || 6} -type d -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null`;
	const command = `${source} | ${shellQuote(fzf)} --height=100% --info=inline --pointer='▶' --marker='✓' --prompt=${shellQuote(`${title} ❯ `)} --header=${shellQuote("enter: choose · esc: cancel · type to filter")}`;
	const shell = process.env.SHELL || "/bin/sh";

	const outcome = await ctx.ui.custom<{ output: string; failed: boolean } | null>((tui, _theme, _kb, done) => {
		let output = "";
		let failed = false;
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");
		try {
			const spawned = spawnSync(shell, ["-c", command], {
				stdio: ["inherit", "pipe", "inherit"],
				encoding: "utf8",
				env: process.env,
			});
			output = (spawned.stdout || "").trim();
			failed = Boolean(spawned.error) || spawned.status === 127;
		} finally {
			tui.start();
			tui.requestRender(true);
		}
		done({ output, failed });
		return { render: () => [], invalidate: () => {} };
	});

	if (!outcome) return { failed: false };
	if (outcome.failed) return { failed: true };
	if (!outcome.output) return { failed: false };
	const cleaned = resolve(startDir, outcome.output.replace(/\/+$/, ""));
	return { picked: isDirectory(cleaned) ? cleaned : undefined, failed: false };
}

async function browseWithSelect(
	ctx: ExtensionContext,
	startDir: string,
	title: string,
): Promise<string | undefined> {
	let current = resolve(startDir);
	for (;;) {
		const dirs = listDirectories(current).slice(0, MAX_BROWSE_ENTRIES);
		const actions = new Map<string, string | (() => void)>();
		const options: string[] = [];

		const useLabel = `✔ use this directory — ${current}`;
		options.push(useLabel);
		actions.set(useLabel, "use");

		if (dirname(current) !== current) {
			const parent = dirname(current);
			const label = `⬆ .. ${basename(parent) || parent}`;
			options.push(label);
			actions.set(label, () => {
				current = parent;
			});
		}
		const home = homeDir();
		if (current !== home) {
			const label = `🏠 ${home}`;
			options.push(label);
			actions.set(label, () => {
				current = home;
			});
		}
		const typedLabel = "✏️ type a path…";
		options.push(typedLabel);
		actions.set(typedLabel, "typed");

		for (const name of dirs) {
			const label = `📁 ${name}${name.startsWith(".") ? "" : "/"}`;
			options.push(label);
			actions.set(label, () => {
				current = join(current, name);
			});
		}

		const choice = await ctx.ui.select(`${title} — ${current}`, options);
		if (!choice) return undefined;
		const action = actions.get(choice);
		if (action === "use") return current;
		if (action === "typed") {
			const typed = await ctx.ui.input("Directory path", current);
			if (!typed) continue;
			const target = resolve(typed.replace(/^~(?=$|\/)/, home));
			if (!isDirectory(target)) {
				ctx.ui.notify(`Not a directory: ${target}`, "warning");
				continue;
			}
			current = target;
			continue;
		}
		if (typeof action === "function") action();
	}
}

export interface PickerOptions {
	title?: string;
	startDir?: string;
}

/**
 * Ask the user for a directory. Uses fzf when available, otherwise a TUI browser.
 */
export async function pickDirectory(ctx: ExtensionContext, options: PickerOptions = {}): Promise<string | undefined> {
	const title = options.title || "Project root";
	const startDir = resolve(options.startDir || homeDir());
	if (!ctx.hasUI) return undefined;

	const forceBrowse = process.env.PI_SPEC_PICKER === "browse";
	const fzf = forceBrowse ? undefined : which("fzf");
	if (fzf && ctx.mode === "tui") {
		const result = await pickWithFzf(ctx, startDir, fzf, title);
		if (!result.failed) return result.picked;
		ctx.ui.notify("fzf failed to start, using the built-in browser", "warning");
	}
	return browseWithSelect(ctx, startDir, title);
}
