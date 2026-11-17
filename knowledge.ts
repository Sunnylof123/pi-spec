/**
 * Deterministic knowledge builder for pi-spec.
 *
 * Scans a project root and writes a small, model-friendly knowledge base into
 * `<root>/.pi_spec/`:
 *
 *   PROJECT.md    human readable overview
 *   INDEX.md      per-file outline (path, kind, size, symbols, summary)
 *   files.json    machine readable inventory (used by the spec_lookup tool)
 *   KNOWLEDGE.md  compact digest injected into the system prompt
 *   meta.json     build metadata (alias, root, stats, git)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { extname, join, posix } from "node:path";
import { OUTPUT_DIR, SPEC_DIR } from "./registry.ts";

const MAX_FILES = Number(process.env.PI_SPEC_MAX_FILES || 6000);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINES_READ = 8000;
const MAX_DEPTH = 14;
const DIGEST_LIMIT = 12000;

const SKIP_DIRS = new Set([
	".git",
	".hg",
	".svn",
	".pi",
	SPEC_DIR,
	"node_modules",
	"bower_components",
	"vendor",
	"dist",
	"build",
	"out",
	"target",
	"obj",
	".next",
	".nuxt",
	".svelte-kit",
	".turbo",
	".parcel-cache",
	".cache",
	".venv",
	"venv",
	"env",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".tox",
	"coverage",
	".nyc_output",
	".gradle",
	"Pods",
	".terraform",
	".idea",
	".vscode",
	".DS_Store",
]);

const ALLOWED_HIDDEN = new Set([".github", ".devcontainer", ".circleci", ".gitlab", ".husky"]);

const LANGUAGE_BY_EXT: Record<string, string> = {
	".ts": "TypeScript",
	".tsx": "TypeScript",
	".mts": "TypeScript",
	".cts": "TypeScript",
	".js": "JavaScript",
	".jsx": "JavaScript",
	".mjs": "JavaScript",
	".cjs": "JavaScript",
	".py": "Python",
	".go": "Go",
	".rs": "Rust",
	".java": "Java",
	".kt": "Kotlin",
	".kts": "Kotlin",
	".scala": "Scala",
	".rb": "Ruby",
	".php": "PHP",
	".c": "C",
	".h": "C",
	".cc": "C++",
	".cpp": "C++",
	".hpp": "C++",
	".cs": "C#",
	".swift": "Swift",
	".m": "Objective-C",
	".ex": "Elixir",
	".exs": "Elixir",
	".erl": "Erlang",
	".hs": "Haskell",
	".lua": "Lua",
	".sh": "Shell",
	".bash": "Shell",
	".zsh": "Shell",
	".fish": "Shell",
	".ps1": "PowerShell",
	".sql": "SQL",
	".md": "Markdown",
	".mdx": "Markdown",
	".rst": "reStructuredText",
	".txt": "Text",
	".json": "JSON",
	".jsonc": "JSON",
	".yaml": "YAML",
	".yml": "YAML",
	".toml": "TOML",
	".ini": "Config",
	".cfg": "Config",
	".conf": "Config",
	".xml": "XML",
	".html": "HTML",
	".htm": "HTML",
	".css": "CSS",
	".scss": "CSS",
	".sass": "CSS",
	".less": "CSS",
	".vue": "Vue",
	".svelte": "Svelte",
	".proto": "Protobuf",
	".graphql": "GraphQL",
	".gql": "GraphQL",
	".tf": "Terraform",
	".nix": "Nix",
	".dockerfile": "Docker",
	".xsd": "XML Schema",
	".xsl": "XML Schema",
	".plist": "XML",
	".properties": "Config",
	".ipynb": "Notebook",
};

const KNOWN_FILES: Record<string, string> = {
	".env": "Env",
	".editorconfig": "Config",
	".gitignore": "Config",
	".gitattributes": "Config",
	".npmrc": "Config",
	".nvmrc": "Config",
	".python-version": "Config",
	".dockerignore": "Config",
	".prettierrc": "Config",
	".eslintrc": "Config",
	Makefile: "Make",
	Justfile: "Make",
	justfile: "Make",
	Rakefile: "Ruby",
	Dockerfile: "Docker",
	"docker-compose.yml": "Docker",
	"docker-compose.yaml": "Docker",
	LICENSE: "License",
	"LICENSE.md": "License",
	"requirements.txt": "Dependencies",
	Gemfile: "Dependencies",
};

const BINARY_EXT = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
	".ico",
	".pdf",
	".zip",
	".gz",
	".tgz",
	".bz2",
	".xz",
	".7z",
	".rar",
	".jar",
	".war",
	".class",
	".o",
	".a",
	".so",
	".dylib",
	".dll",
	".exe",
	".bin",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	".mp3",
	".mp4",
	".mov",
	".avi",
	".mkv",
	".wav",
	".flac",
	".sqlite",
	".db",
	".pyc",
	".wasm",
	".lock",
]);

export interface FileInfo {
	path: string;
	kind: string;
	ext: string;
	bytes: number;
	lines: number;
	symbols: string[];
	summary: string;
}

export interface GitInfo {
	branch?: string;
	commit?: string;
	remote?: string;
	dirty?: boolean;
}

export interface BuildStats {
	files: number;
	dirs: number;
	lines: number;
	languages: Record<string, number>;
}

export interface SpecMeta {
	version: number;
	alias: string;
	root: string;
	createdAt: number;
	updatedAt: number;
	stats: BuildStats;
	git?: GitInfo;
	truncated: boolean;
}

export interface SpecPaths {
	dir: string;
	project: string;
	index: string;
	files: string;
	knowledge: string;
	meta: string;
	/** Generated scripts (instead of changes to the original code). */
	script: string;
}

export function specPaths(root: string): SpecPaths {
	const dir = join(root, SPEC_DIR);
	return {
		dir,
		project: join(dir, "PROJECT.md"),
		index: join(dir, "INDEX.md"),
		files: join(dir, "files.json"),
		knowledge: join(dir, "KNOWLEDGE.md"),
		meta: join(dir, "meta.json"),
		script: join(dir, "script"),
	};
}

export function hasSpec(root: string): boolean {
	return existsSync(specPaths(root).knowledge);
}

export function readKnowledge(root: string): string | undefined {
	const file = specPaths(root).knowledge;
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

export function readFilesIndex(root: string): FileInfo[] {
	try {
		const parsed = JSON.parse(readFileSync(specPaths(root).files, "utf8"));
		return Array.isArray(parsed.files) ? (parsed.files as FileInfo[]) : [];
	} catch {
		return [];
	}
}

export function readMeta(root: string): SpecMeta | undefined {
	try {
		return JSON.parse(readFileSync(specPaths(root).meta, "utf8")) as SpecMeta;
	} catch {
		return undefined;
	}
}

interface WalkResult {
	files: string[];
	dirs: string[];
	truncated: boolean;
}

async function walk(root: string): Promise<WalkResult> {
	const files: string[] = [];
	const dirs: string[] = [];
	const queue: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
	let truncated = false;

	while (queue.length > 0) {
		const { rel, depth } = queue.shift() as { rel: string; depth: number };
		const abs = rel ? join(root, rel) : root;
		let entries;
		try {
			entries = await readdir(abs, { withFileTypes: true });
		} catch {
			continue;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") && !ALLOWED_HIDDEN.has(entry.name)) continue;
				if (SKIP_DIRS.has(entry.name)) continue;
				if (depth + 1 > MAX_DEPTH) {
					truncated = true;
					continue;
				}
				dirs.push(childRel);
				queue.push({ rel: childRel, depth: depth + 1 });
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				if (files.length >= MAX_FILES) {
					truncated = true;
					continue;
				}
				files.push(childRel);
			}
		}
		if (files.length >= MAX_FILES) {
			truncated = true;
			break;
		}
	}
	return { files, dirs, truncated };
}

function baseName(relPath: string): string {
	const parts = relPath.split("/");
	return parts[parts.length - 1] || relPath;
}

function kindFor(relPath: string, ext: string): string {
	const base = baseName(relPath);
	if (KNOWN_FILES[base]) return KNOWN_FILES[base] as string;
	if (LANGUAGE_BY_EXT[ext]) return LANGUAGE_BY_EXT[ext] as string;
	return ext ? ext.replace(".", "").toUpperCase() : "File";
}

const SYMBOL_RULES: Array<{ file: RegExp; patterns: RegExp[] }> = [
	{
		file: /\.[cm]?[jt]sx?$/,
		patterns: [
			/^export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let)\s+([A-Za-z_$][\w$]*)/,
			/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
			/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
		],
	},
	{ file: /\.py$/, patterns: [/^(?:class|def)\s+([A-Za-z_]\w*)/, /^async\s+def\s+([A-Za-z_]\w*)/] },
	{ file: /\.go$/, patterns: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)/] },
	{
		file: /\.rs$/,
		patterns: [
			/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|mod)\s+([A-Za-z_]\w*)/,
			/^impl(?:<[^>]*>)?\s+([A-Za-z_]\w*)/,
		],
	},
	{
		file: /\.(java|kt|kts|cs|scala|swift)$/,
		patterns: [/^\s*(?:public|private|protected|internal|static|final|abstract|data|sealed|open|\s)*\s*(?:class|interface|enum|fun|struct|record)\s+([A-Za-z_]\w*)/],
	},
	{ file: /\.(rb|php)$/, patterns: [/^\s*(?:class|module|def|function|public function)\s+([A-Za-z_]\w*)/] },
	{ file: /\.(sh|bash|zsh)$/, patterns: [/^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/] },
];

const SYMBOL_STOPWORDS = new Set(["if", "for", "while", "switch", "return", "catch", "constructor"]);

function extractSymbols(relPath: string, content: string): string[] {
	const rule = SYMBOL_RULES.find((entry) => entry.file.test(relPath));
	if (!rule) return [];
	const seen = new Set<string>();
	for (const line of content.split("\n")) {
		for (const pattern of rule.patterns) {
			const match = pattern.exec(line);
			if (!match) continue;
			const name = match[1] as string;
			if (!name || SYMBOL_STOPWORDS.has(name)) continue;
			seen.add(name);
			break;
		}
		if (seen.size >= 20) break;
	}
	return [...seen];
}

function cleanComment(line: string): string | undefined {
	const match = /^\s*(?:\/\/+|#+|--|\*+|\/\*+)\s*(.*)$/.exec(line);
	if (!match) return undefined;
	const body = (match[1] || "").trim();
	if (body.length < 3) return undefined;
	if (/^[-=*_#~·—\u2500-\u257f\s]+$/.test(body)) return undefined;
	if (/^(eslint|prettier|biome|@ts-|noinspection|copyright|license|spdx)/i.test(body)) return undefined;
	// Skip banner comments such as "─── Types ───" that are mostly punctuation.
	const alnum = (body.match(/[A-Za-z0-9]/g) || []).length;
	if (alnum / body.length < 0.6) return undefined;
	return body;
}

function stripFrontmatter(lines: string[]): string[] {
	if ((lines[0] || "").trim() !== "---") return lines;
	for (let index = 1; index < lines.length; index++) {
		if ((lines[index] || "").trim() === "---") return lines.slice(index + 1);
	}
	return lines;
}

function firstParagraph(lines: string[]): string {
	const buffer: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			if (buffer.length > 0) break;
			continue;
		}
		if (trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("<!--")) continue;
		if (trimmed.startsWith("|") || trimmed.startsWith("```") || trimmed.startsWith("---")) continue;
		buffer.push(trimmed);
		if (buffer.join(" ").length > 180) break;
	}
	return buffer.join(" ").slice(0, 180);
}

function summarize(relPath: string, content: string, ext: string): string {
	const rawLines = content.split("\n");
	const lines = stripFrontmatter(rawLines);
	if (/\.(md|mdx|rst|txt)$/.test(ext)) {
		const heading = lines.find((l) => /^#{1,3}\s+\S/.test(l.trim()));
		const paragraph = firstParagraph(lines.filter((l) => !/^#{1,6}\s/.test(l.trim())));
		const title = heading ? heading.replace(/^#+\s*/, "").trim() : "";
		return [title, paragraph].filter(Boolean).join(" — ").slice(0, 220);
	}
	if (relPath.endsWith("package.json")) {
		try {
			const pkg = JSON.parse(content);
			const scripts = pkg.scripts ? Object.keys(pkg.scripts).slice(0, 8).join(", ") : "";
			return [`npm package ${pkg.name ?? ""}${pkg.version ? `@${pkg.version}` : ""}`, scripts ? `scripts: ${scripts}` : ""].filter(Boolean).join(" · ");
		} catch {
			return "";
		}
	}
	if (relPath.endsWith("go.mod")) {
		const mod = /^module\s+(\S+)/m.exec(content);
		return mod ? `Go module ${mod[1]}` : "";
	}
	if (relPath.endsWith("Cargo.toml")) {
		const name = /^name\s*=\s*"([^"]+)"/m.exec(content);
		return name ? `Rust crate ${name[1]}` : "";
	}
	if (relPath.endsWith("pyproject.toml") || relPath.endsWith("setup.py")) {
		const name = /name\s*=\s*["']([^"']+)["']/.exec(content);
		return name ? `Python package ${name[1]}` : "Python project manifest";
	}
	for (const line of lines.slice(0, 15)) {
		const comment = cleanComment(line);
		if (comment) return comment.slice(0, 180);
	}
	const symbols = extractSymbols(relPath, content);
	if (symbols.length > 0) return `defines ${symbols.slice(0, 6).join(", ")}`;
	return "";
}

async function inspect(root: string, relPath: string): Promise<FileInfo | undefined> {
	const abs = join(root, relPath);
	const ext = extname(relPath).toLowerCase();
	let bytes = 0;
	try {
		const stat = statSync(abs);
		if (!stat.isFile()) return undefined;
		bytes = stat.size;
	} catch {
		return undefined;
	}

	const info: FileInfo = { path: relPath, kind: kindFor(relPath, ext), ext, bytes, lines: 0, symbols: [], summary: "" };
	if (BINARY_EXT.has(ext) || bytes === 0 || bytes > MAX_FILE_BYTES) return info;

	let handle;
	try {
		handle = await open(abs, "r");
		const length = Math.min(bytes, MAX_FILE_BYTES);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		const slice = buffer.subarray(0, bytesRead);
		if (slice.includes(0)) return info; // binary
		const text = slice.toString("utf8");
		const lines = text.split("\n");
		info.lines = Math.min(lines.length, MAX_LINES_READ);
		info.symbols = extractSymbols(relPath, text);
		info.summary = summarize(relPath, text, ext);
	} catch {
		// keep what we have
	} finally {
		await handle?.close().catch(() => {});
	}
	return info;
}

function gitInfo(root: string): GitInfo | undefined {
	const run = (args: string[]): string | undefined => {
		try {
			return execFileSync("git", ["-C", root, ...args], {
				encoding: "utf8",
				timeout: 2500,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			return undefined;
		}
	};
	const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!branch) return undefined;
	const commit = run(["log", "-1", "--format=%h %s"]);
	const remote = run(["config", "--get", "remote.origin.url"]);
	const status = run(["status", "--porcelain"]);
	return { branch, commit, remote, dirty: Boolean(status) };
}

/** Count files in a directory tree, capped by depth. */
function countFiles(dir: string, maxDepth = 2): number {
	let count = 0;
	const visit = (current: string, depth: number): void => {
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (depth < maxDepth && !entry.name.startsWith(".")) visit(join(current, entry.name), depth + 1);
			} else if (!entry.name.startsWith(".")) {
				count++;
			}
		}
	};
	visit(dir, 0);
	return count;
}

/** Live counts for the generated-artifact folders (not cached in the digest). */
export function countArtifacts(root: string): { scripts: number; outputs: number } {
	return {
		scripts: countFiles(specPaths(root).script),
		outputs: countFiles(join(root, OUTPUT_DIR)),
	};
}

function topLevelEntries(files: FileInfo[], dirs: string[]): Array<{ name: string; files: number; isDir: boolean }> {
	const map = new Map<string, number>();
	for (const file of files) {
		const top = file.path.includes("/") ? `${file.path.split("/")[0] as string}/` : file.path;
		map.set(top, (map.get(top) || 0) + 1);
	}
	for (const dir of dirs) {
		if (dir.includes("/")) continue;
		if (!map.has(`${dir}/`)) map.set(`${dir}/`, 0);
	}
	return [...map.entries()]
		.map(([name, count]) => ({ name, files: count, isDir: name.endsWith("/") }))
		.sort((a, b) => Number(b.isDir) - Number(a.isDir) || b.files - a.files || a.name.localeCompare(b.name));
}

const ENTRY_POINT_RE = /(^|\/)(index|main|app|cli|server|bootstrap|program|lib)\.[a-z]+$/;
const NOISY_PATH_RE = /^(old|vendor|third_party|third-party|examples?|test|tests|__tests__|fixtures?|benchmarks?|samples?)\//;

function entryPointFiles(files: FileInfo[], limit: number): FileInfo[] {
	return files
		.filter((file) => ENTRY_POINT_RE.test(file.path) && LANGUAGE_BY_EXT[file.ext] && !NOISY_PATH_RE.test(file.path))
		.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))
		.slice(0, limit);
}

function notableFiles(files: FileInfo[], limit: number): FileInfo[] {
	return files
		.filter((file) => file.symbols.length > 0 && !MANIFESTS.has(baseName(file.path)))
		.sort((a, b) => b.symbols.length - a.symbols.length || b.lines - a.lines)
		.slice(0, limit);
}
const MANIFESTS = new Set([
	"package.json",
	"go.mod",
	"Cargo.toml",
	"pyproject.toml",
	"setup.py",
	"requirements.txt",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"Makefile",
	"justfile",
	"Dockerfile",
	"docker-compose.yml",
	"docker-compose.yaml",
	"flake.nix",
	"composer.json",
	"Gemfile",
]);

function renderProjectMd(alias: string, meta: SpecMeta, files: FileInfo[], dirs: string[]): string {
	const scriptCount = countFiles(specPaths(meta.root).script);
	const outputCount = countFiles(join(meta.root, OUTPUT_DIR));
	const langs = Object.entries(meta.stats.languages)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 12)
		.map(([lang, count]) => `| ${lang} | ${count} |`)
		.join("\n");
	const manifests = files.filter((f) => MANIFESTS.has(posix.basename(f.path)) || f.path === "Makefile" || f.path === "Dockerfile");
	const entries = entryPointFiles(files, 12);
	const docs = files.filter((f) => /\.(md|mdx|rst)$/i.test(f.path) && !f.path.startsWith("node_modules/")).slice(0, 25);
	const top = topLevelEntries(files, dirs).slice(0, 40);
	const git = meta.git
		? `- Branch: \`${meta.git.branch}\`${meta.git.dirty ? " (dirty)" : ""}\n- Last commit: ${meta.git.commit ?? "?"}\n- Remote: ${meta.git.remote ?? "(none)"}`
		: "- Not a git repository";

	return `# ${alias}

> Generated by pi-spec. Rebuild with \`/spec refresh\`.

- Root: \`${meta.root}\`
- Generated: ${new Date(meta.updatedAt).toISOString()}
- Files: ${meta.stats.files} (${meta.stats.lines} lines) in ${meta.stats.dirs} directories
${meta.truncated ? "- Scan truncated: some directories were skipped\n" : ""}
## Git
${git}

## Languages
| Language | Files |
|---|---|
${langs || "| (none) | 0 |"}

## Top level
${top.map((t) => (t.isDir ? `- \`${t.name}\` — ${t.files} files` : `- \`${t.name}\``)).join("\n") || "- (empty)"}

## Manifests
${manifests.map((f) => `- \`${f.path}\` — ${f.summary || f.kind}`).join("\n") || "- (none found)"}

## Entry points
${entries.map((f) => `- \`${f.path}\`${f.summary ? ` — ${f.summary}` : ""}`).join("\n") || "- (none detected)"}

## Documentation
${docs.map((f) => `- \`${f.path}\`${f.summary ? ` — ${f.summary}` : ""}`).join("\n") || "- (none found)"}

## Generated artifacts
- \`${SPEC_DIR}/script/\` — ${scriptCount} generated script(s); one-off work goes here, not into the source tree
- \`${OUTPUT_DIR}/\` — ${outputCount} output file(s); reports, exports, logs, and datasets go here

## Knowledge files
- \`${SPEC_DIR}/INDEX.md\` — every file with size, symbols, and summary
- \`${SPEC_DIR}/files.json\` — machine readable inventory
- \`${SPEC_DIR}/KNOWLEDGE.md\` — digest injected into the system prompt
- \`${SPEC_DIR}/meta.json\` — build metadata
`;
}

function renderIndexMd(alias: string, files: FileInfo[], dirs: string[]): string {
	const byDir = new Map<string, FileInfo[]>();
	for (const file of files) {
		const dir = posix.dirname(file.path) === "." ? "" : posix.dirname(file.path);
		const list = byDir.get(dir) || [];
		list.push(file);
		byDir.set(dir, list);
	}
	const dirNames = [...byDir.keys()].sort();
	const lines: string[] = [
		`# File index — ${alias}`,
		"",
		`${files.length} files, ${dirs.length} directories. Generated by pi-spec.`,
		"",
	];
	for (const dir of dirNames) {
		lines.push(`## ${dir ? `${dir}/` : "(root)"}`, "");
		for (const file of (byDir.get(dir) || []).sort((a, b) => a.path.localeCompare(b.path))) {
			const bits = [file.lines ? `${file.lines} lines` : `${file.bytes} B`, file.kind];
			if (file.symbols.length > 0) bits.push(file.symbols.slice(0, 8).join(", "));
			const suffix = file.summary ? ` — ${file.summary}` : "";
			lines.push(`- \`${posix.basename(file.path)}\` (${bits.join(" · ")})${suffix}`);
		}
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

function renderKnowledgeMd(alias: string, meta: SpecMeta, files: FileInfo[], dirs: string[]): string {
	const langs = Object.entries(meta.stats.languages)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 8)
		.map(([lang, count]) => `${lang} ${count}`)
		.join(", ");
	const top = topLevelEntries(files, dirs);
	const manifests = files.filter((f) => MANIFESTS.has(posix.basename(f.path)));
	const entries = entryPointFiles(files, 8);
	const docs = files.filter((f) => /\.(md|mdx|rst)$/i.test(f.path)).slice(0, 10);
	const important = notableFiles(files, 16);

	const out: string[] = [
		`Workspace root: ${meta.root}`,
		`Alias: ${alias}`,
		`Size: ${meta.stats.files} files, ${meta.stats.dirs} directories, ${meta.stats.lines} lines${meta.truncated ? " (scan truncated)" : ""}`,
		`Languages: ${langs || "unknown"}`,
	];
	if (meta.git) out.push(`Git: ${meta.git.branch}${meta.git.dirty ? " (dirty)" : ""} · ${meta.git.commit ?? ""}`.trim());
	out.push(
		`Artifacts: one-off scripts → ${SPEC_DIR}/script/, generated outputs → ${OUTPUT_DIR}/ (never into the source tree)`,
	);
	out.push(
		"",
		"Top level:",
		...top.slice(0, 18).map((t) => (t.isDir ? `  ${t.name} (${t.files} files)` : `  ${t.name}`)),
	);
	if (manifests.length > 0) {
		out.push("", "Manifests:", ...manifests.slice(0, 8).map((f) => `  ${f.path} — ${f.summary || f.kind}`));
	}
	if (entries.length > 0) {
		out.push("", "Entry points:", ...entries.map((f) => `  ${f.path}${f.summary ? ` — ${f.summary}` : ""}`));
	}
	if (docs.length > 0) {
		out.push("", "Docs:", ...docs.map((f) => `  ${f.path}${f.summary ? ` — ${f.summary}` : ""}`));
	}
	if (important.length > 0) {
		out.push(
			"",
			"Notable files:",
			...important.slice(0, 12).map((f) => {
				const symbols = f.symbols.length > 0 ? ` [${f.symbols.slice(0, 6).join(", ")}]` : "";
				return `  ${f.path}${symbols}`;
			}),
		);
	}
	const directories = [...new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")))].filter(Boolean);
	if (directories.length > 0) out.push("", `Directories: ${directories.sort().slice(0, 40).join(", ")}`);
	out.push("", `Knowledge: ${SPEC_DIR}/INDEX.md · ${SPEC_DIR}/files.json · ${SPEC_DIR}/PROJECT.md · generated scripts: ${SPEC_DIR}/script/`);

	let text = out.join("\n");
	if (text.length > DIGEST_LIMIT) text = `${text.slice(0, DIGEST_LIMIT)}\n… (digest truncated, read ${SPEC_DIR}/INDEX.md for the full list)`;
	return text;
}

export interface BuildOptions {
	onProgress?: (message: string) => void;
}

export interface BuildResult extends SpecMeta {
	paths: SpecPaths;
	digest: string;
}

export async function buildKnowledge(root: string, alias: string, options: BuildOptions = {}): Promise<BuildResult> {
	const paths = specPaths(root);
	const progress = (message: string) => options.onProgress?.(message);

	progress("scanning directories…");
	const { files: relFiles, dirs, truncated } = await walk(root);

	progress(`reading ${relFiles.length} files…`);
	const infos: FileInfo[] = [];
	const concurrency = 12;
	let cursor = 0;
	let done = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, relFiles.length) }, async () => {
			for (;;) {
				const index = cursor++;
				const rel = relFiles[index];
				if (!rel) return;
				const info = await inspect(root, rel);
				if (info) infos.push(info);
				done++;
				if (done % 200 === 0) progress(`analyzed ${done}/${relFiles.length} files…`);
			}
		}),
	);
	infos.sort((a, b) => a.path.localeCompare(b.path));

	const languages: Record<string, number> = {};
	let lines = 0;
	for (const info of infos) {
		languages[info.kind] = (languages[info.kind] || 0) + 1;
		lines += info.lines;
	}

	const previous = readMeta(root);
	const now = Date.now();
	const meta: SpecMeta = {
		version: 1,
		alias,
		root,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
		stats: { files: infos.length, dirs: dirs.length, lines, languages },
		git: gitInfo(root),
		truncated,
	};

	const digest = renderKnowledgeMd(alias, meta, infos, dirs);
	mkdirSync(paths.dir, { recursive: true });
	mkdirSync(paths.script, { recursive: true });
	writeFileSync(paths.project, renderProjectMd(alias, meta, infos, dirs), "utf8");
	writeFileSync(paths.index, renderIndexMd(alias, infos, dirs), "utf8");
	writeFileSync(paths.files, `${JSON.stringify({ alias, root, updatedAt: now, files: infos }, null, 2)}\n`, "utf8");
	writeFileSync(paths.knowledge, `${digest}\n`, "utf8");
	writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

	progress(`knowledge ready: ${infos.length} files`);
	return { ...meta, paths, digest };
}
