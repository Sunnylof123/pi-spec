/**
 * Root registry for pi-spec.
 *
 * Stores the known project roots (alias -> directory) in
 * `~/.pi/agent/pi-spec/roots.json`.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Name of the knowledge folder created inside every project root. */
export const SPEC_DIR = process.env.PI_SPEC_DIR || ".pi_spec";

/** Folder for generated outputs (reports, exports, logs, data). */
export const OUTPUT_DIR = process.env.PI_SPEC_OUTPUT_DIR || ".pi_output";

export interface RootEntry {
	/** Short user-chosen name, unique in the registry. */
	alias: string;
	/** Canonical absolute path of the project root. */
	root: string;
	createdAt: number;
	lastUsedAt: number;
	/** Set once pi-spec created AGENTS.md / .pi_output for this root. */
	initializedAt?: number;
}

export interface Registry {
	version: 1;
	lastAlias?: string;
	roots: RootEntry[];
}

export function registryPath(): string {
	return join(getAgentDir(), "pi-spec", "roots.json");
}

export function statePath(...parts: string[]): string {
	return join(getAgentDir(), "pi-spec", ...parts);
}

export function loadRegistry(): Registry {
	const file = registryPath();
	try {
		if (!existsSync(file)) return { version: 1, roots: [] };
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Registry>;
		const roots = Array.isArray(parsed.roots) ? parsed.roots : [];
		return {
			version: 1,
			lastAlias: typeof parsed.lastAlias === "string" ? parsed.lastAlias : undefined,
			roots: roots
				.filter((r): r is RootEntry => Boolean(r && typeof r.alias === "string" && typeof r.root === "string"))
				.map((r) => ({
					alias: r.alias,
					root: canonical(r.root),
					createdAt: r.createdAt ?? Date.now(),
					lastUsedAt: r.lastUsedAt ?? 0,
					initializedAt: typeof r.initializedAt === "number" ? r.initializedAt : undefined,
				})),
		};
	} catch {
		return { version: 1, roots: [] };
	}
}

export function saveRegistry(registry: Registry): void {
	const file = registryPath();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

/** Resolve symlinks where possible, fall back to a plain absolute path. */
export function canonical(path: string): string {
	const absolute = resolve(path.replace(/^~(?=$|\/)/, process.env.HOME || "~"));
	try {
		return realpathSync(absolute);
	} catch {
		return absolute;
	}
}

export function slugify(input: string): string {
	const slug = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "root";
}

export function byAlias(registry: Registry, alias: string): RootEntry | undefined {
	return registry.roots.find((r) => r.alias === alias);
}

/** True when `child` is `parent` or lives inside it. */
export function isInside(child: string, parent: string): boolean {
	const a = canonical(child);
	const b = canonical(parent);
	return a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
}

/**
 * Deepest registered root containing `dir`, if any.
 * This is what makes a re-selection of an already known directory "redirect"
 * to the existing root instead of creating a duplicate entry.
 */
export function containingRoot(registry: Registry, dir: string): RootEntry | undefined {
	const target = canonical(dir);
	let best: RootEntry | undefined;
	for (const entry of registry.roots) {
		if (!isInside(target, entry.root)) continue;
		if (!best || entry.root.length > best.root.length) best = entry;
	}
	return best;
}

export function uniqueAlias(registry: Registry, desired: string, root: string): string {
	const base = slugify(desired || basename(root));
	const existing = byAlias(registry, base);
	if (!existing || canonical(existing.root) === canonical(root)) return base;
	let n = 2;
	while (byAlias(registry, `${base}-${n}`)) n++;
	return `${base}-${n}`;
}

export interface AddRootResult {
	entry: RootEntry;
	/** Set when the directory was already covered by a registered root. */
	redirectedTo?: RootEntry;
	created: boolean;
}

/**
 * Add (or reuse) a root. If `dir` is already registered or lives inside an
 * existing root, the existing entry is returned and `redirectedTo` is set.
 */
export function addRoot(registry: Registry, dir: string, aliasInput?: string): AddRootResult {
	const root = canonical(dir);
	const existing = containingRoot(registry, root);
	if (existing) {
		existing.lastUsedAt = Date.now();
		registry.lastAlias = existing.alias;
		return { entry: existing, redirectedTo: existing, created: false };
	}

	const alias = uniqueAlias(registry, aliasInput || basename(root), root);
	const now = Date.now();
	const entry: RootEntry = { alias, root, createdAt: now, lastUsedAt: now };
	registry.roots.push(entry);
	registry.lastAlias = alias;
	return { entry, created: true };
}

export function touch(registry: Registry, alias: string): void {
	const entry = byAlias(registry, alias);
	if (!entry) return;
	entry.lastUsedAt = Date.now();
	registry.lastAlias = alias;
}

export function removeRoot(registry: Registry, alias: string): boolean {
	const before = registry.roots.length;
	registry.roots = registry.roots.filter((r) => r.alias !== alias);
	if (registry.lastAlias === alias) registry.lastAlias = undefined;
	return registry.roots.length !== before;
}

export function sortedRoots(registry: Registry): RootEntry[] {
	return [...registry.roots].sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.alias.localeCompare(b.alias));
}
