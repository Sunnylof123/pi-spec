/**
 * First-time setup for a project root.
 *
 * When a directory is selected for the first time pi-spec creates:
 *
 *   AGENTS.md            rules for follow-up work (merged into an existing file)
 *   .pi_output/          all generated artifacts, ignored by git
 *   .pi_spec/script/     generated scripts instead of edits to original code
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { OUTPUT_DIR, SPEC_DIR } from "./registry.ts";

const AGENTS_BEGIN = "<!-- pi-spec:begin -->";
const AGENTS_END = "<!-- pi-spec:end -->";
const GLOBAL_BEGIN = "<!-- pi-spec:global:begin -->";
const GLOBAL_END = "<!-- pi-spec:global:end -->";

export type AgentsResult = "created" | "updated" | "unchanged" | "failed";

function rulesBlock(alias: string, outputDir: string): string {
	const name = alias || "this project";
	return `${AGENTS_BEGIN}
## pi-spec workspace (${name})

Background for this project lives in \`${SPEC_DIR}/\`:

- \`${SPEC_DIR}/PROJECT.md\` — overview, layout, manifests, entry points
- \`${SPEC_DIR}/INDEX.md\` — every file with symbols and one-line summaries
- \`${SPEC_DIR}/KNOWLEDGE.md\` — digest (also injected into the system prompt)
- \`${SPEC_DIR}/files.json\` — inventory searched by the \`spec_lookup\` tool
- \`${SPEC_DIR}/ARCHITECTURE.md\`, \`${SPEC_DIR}/GLOSSARY.md\` — after \`/spec analyze\`

Read this knowledge base before broad exploration, and use \`spec_lookup\` to locate
files and symbols before grepping the tree.

### Generated scripts go to \`${SPEC_DIR}/script/\`

Write one-off scripts, codemods, experiments, and helper tooling to
\`${SPEC_DIR}/script/\` instead of adding them to the project source. Treat the
original code as read-only unless the user explicitly asks for a source change.
Name scripts after what they do and keep them runnable from the project root.

### Outputs go to \`${outputDir}/\`

Every generated artifact — reports, exports, logs, datasets, rendered files — goes to
\`${outputDir}/\`. Do not leave outputs next to source files.

### Keep the knowledge base current

After structural changes, run \`/spec refresh\`. Record durable decisions in
\`${SPEC_DIR}/\`.
${AGENTS_END}`;
}

/** Rules installed in the agent directory so every pi session recognizes the layout. */
function globalRulesBlock(): string {
	return `${GLOBAL_BEGIN}
## pi-spec workspaces

Some projects carry a pi-spec workspace. It is identified by a \`${SPEC_DIR}/\` folder:
the directory containing it is the project root.

### Background lives in \`${SPEC_DIR}/\`

- \`${SPEC_DIR}/PROJECT.md\` — overview: layout, manifests, entry points
- \`${SPEC_DIR}/INDEX.md\` — every file with symbols and one-line summaries
- \`${SPEC_DIR}/KNOWLEDGE.md\` — digest (pi-spec also injects it into the prompt)
- \`${SPEC_DIR}/files.json\` — inventory searched by the \`spec_lookup\` tool
- \`${SPEC_DIR}/ARCHITECTURE.md\`, \`${SPEC_DIR}/GLOSSARY.md\` — after \`/spec analyze\`

Read these before broad exploration, and prefer \`spec_lookup\` to locate files and
symbols over crawling the tree.

### Generated scripts go to \`${SPEC_DIR}/script/\`

One-off scripts, codemods, experiments, and helper tooling belong there rather than in
the project source. Treat the original code as read-only unless the user asks for a
source change. Name scripts after what they do and run them from the project root.

### Outputs go to \`${OUTPUT_DIR}/\`

Every generated artifact — reports, exports, logs, datasets, rendered files — goes to
\`${OUTPUT_DIR}/\`, never next to source files.

### Project rules and freshness

A project root may also have an \`AGENTS.md\` with a block between
\`<!-- pi-spec:begin -->\` and \`<!-- pi-spec:end -->\`; instructions outside those markers
belong to the project and take precedence. Rebuild the knowledge base with \`/spec
refresh\` after structural changes; \`/spec\` shows the active root.
${GLOBAL_END}`;
}

function replaceManagedBlock(content: string, block: string, begin: string, endMarker: string): string | undefined {
	const start = content.indexOf(begin);
	const end = content.indexOf(endMarker);
	if (start === -1 || end === -1 || end < start) return undefined;
	return `${content.slice(0, start)}${block}${content.slice(end + endMarker.length)}`;
}

/** Create or refresh a managed block in a markdown file, preserving user content. */
function mergeManagedFile(
	file: string,
	block: string,
	begin: string,
	endMarker: string,
	header: string,
): AgentsResult {
	let existing = "";
	try {
		existing = readFileSync(file, "utf8");
	} catch {
		existing = "";
	}
	try {
		if (!existing.trim()) {
			writeFileSync(file, `${header}${block}\n`, "utf8");
			return "created";
		}
		const replaced = replaceManagedBlock(existing, block, begin, endMarker);
		if (replaced !== undefined) {
			if (replaced === existing) return "unchanged";
			writeFileSync(file, replaced.endsWith("\n") ? replaced : `${replaced}\n`, "utf8");
			return "updated";
		}
		writeFileSync(file, `${existing.trimEnd()}\n\n${block}\n`, "utf8");
		return "updated";
	} catch {
		return "failed";
	}
}

/**
 * Install the workspace-structure rules into `<agent-dir>/AGENTS.md`, which pi loads
 * for every working directory.
 */
export function ensureGlobalAgentsFile(agentDir: string): AgentsResult {
	mkdirSync(agentDir, { recursive: true });
	const header = `# User instructions\n\nThis file is loaded by pi for every working directory. The pi-spec block below is\nmaintained by the pi-spec extension; project-specific instructions belong outside it.\n\n`;
	return mergeManagedFile(join(agentDir, "AGENTS.md"), globalRulesBlock(), GLOBAL_BEGIN, GLOBAL_END, header);
}

/** Create or refresh the pi-spec block inside `<root>/AGENTS.md`. */
export function ensureAgentsFile(root: string, alias: string): AgentsResult {
	const header = `# Agent rules — ${alias || basename(root)}\n\nThis file is maintained by pi-spec. Project-specific rules belong outside the\npi-spec markers below.\n\n`;
	return mergeManagedFile(join(root, "AGENTS.md"), rulesBlock(alias, OUTPUT_DIR), AGENTS_BEGIN, AGENTS_END, header);
}

export interface ScaffoldResult {
	agents: AgentsResult;
	outputDir: string;
	scriptDir: string;
}

/**
 * Ensure the workspace folders exist and AGENTS.md carries the pi-spec rules.
 * Safe to call on every activation; file writes only happen when content changes.
 */
export function ensureScaffolding(root: string, alias: string): ScaffoldResult {
	const outputDir = join(root, OUTPUT_DIR);
	const scriptDir = join(root, SPEC_DIR, "script");
	try {
		mkdirSync(outputDir, { recursive: true });
		const gitignore = join(outputDir, ".gitignore");
		if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n!.gitignore\n", "utf8");
	} catch {
		// keep going: the knowledge build reports real failures
	}
	try {
		mkdirSync(scriptDir, { recursive: true });
	} catch {
		// keep going
	}
	return { agents: ensureAgentsFile(root, alias), outputDir, scriptDir };
}
