# User instructions

This file is loaded by pi for every working directory. The pi-spec block below is
maintained by the pi-spec extension; project-specific instructions belong outside it.

<!-- pi-spec:global:begin -->
## pi-spec workspaces

Some projects carry a pi-spec workspace. It is identified by a `.pi_spec/` folder:
the directory containing it is the project root.

### Background lives in `.pi_spec/`

- `.pi_spec/PROJECT.md` — overview: layout, manifests, entry points
- `.pi_spec/INDEX.md` — every file with symbols and one-line summaries
- `.pi_spec/KNOWLEDGE.md` — digest (pi-spec also injects it into the prompt)
- `.pi_spec/files.json` — inventory searched by the `spec_lookup` tool
- `.pi_spec/ARCHITECTURE.md`, `.pi_spec/GLOSSARY.md` — after `/spec analyze`

Read these before broad exploration, and prefer `spec_lookup` to locate files and
symbols over crawling the tree.

### Generated scripts go to `.pi_spec/script/`

One-off scripts, codemods, experiments, and helper tooling belong there rather than in
the project source. Treat the original code as read-only unless the user asks for a
source change. Name scripts after what they do and run them from the project root.

### Outputs go to `.pi_output/`

Every generated artifact — reports, exports, logs, datasets, rendered files — goes to
`.pi_output/`, never next to source files.

### Project rules and freshness

A project root may also have an `AGENTS.md` with a block between
`<!-- pi-spec:begin -->` and `<!-- pi-spec:end -->`; instructions outside those markers
belong to the project and take precedence. Rebuild the knowledge base with `/spec
refresh` after structural changes; `/spec` shows the active root.
<!-- pi-spec:global:end -->
