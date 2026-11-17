# pi-spec

Pick a project root when you start a conversation, and pi keeps a small knowledge base for
that project so it stops re-learning the layout every session.

Every new conversation starts with one question — **where to?** — then pi moves into that
directory, indexes it under `.pi_spec/`, and injects the digest into the system prompt.

```
 Where to? Pick a project root

 →   pipkg — /home/sunny/git/pi-packages
     ＋ Add a new project root…
     • Use current directory — /tmp/scratch
```

---

## Contents

- [Installation](#installation) — requirements, global/symlink/project-local setup, update, uninstall
- [Quick start](#quick-start) — first conversation, step by step
- [What gets created for you](#what-gets-created-for-you) — `AGENTS.md`, `.pi_spec/`, `.pi_output/`
- [Global rules (every pi session)](#global-rules-every-pi-session) — `<agent-dir>/AGENTS.md`
- [Day-to-day usage](#day-to-day-usage) — switching roots, refresh, analyze, scripts, outputs
- [Commands](#commands) — `/spec …` reference and `spec_lookup`
- [How it works](#how-it-works) — relaunch, injected context, tool binding
- [Configuration](#configuration) — environment variables and registry file
- [Extension layout](#extension-layout)
- [Troubleshooting](#troubleshooting)
- [Limits](#limits)

---

## Installation

> Extensions run with your full system permissions. Read the source before installing
> anything you did not write yourself.

### Requirements

| Need | Notes |
|---|---|
| pi ≥ 1.5 | The extension uses `session_start`, `ctx.ui`, `process.execve`, and tool overrides. |
| Node ≥ 22.15 | For `process.execve`, so pi can *move* into the root. Older Node falls back to a child process. |
| `fzf` (recommended) | Full-screen fuzzy picker. Without it a built-in TUI browser is used. |
| `fd` (optional) | Faster candidate list for `fzf`; `find` is used otherwise. |

### Install globally (recommended)

pi auto-discovers extensions in `<agent-dir>/extensions/` (`~/.pi/agent/extensions/` by
default). Copy the folder there:

```bash
git clone <your-repo-url> ~/src/pi-spec            # or copy it from wherever it lives
mkdir -p ~/.pi/agent/extensions
cp -r ~/src/pi-spec ~/.pi/agent/extensions/pi-spec
```

Or symlink a checkout, so edits take effect on reload:

```bash
ln -s ~/src/pi-spec ~/.pi/agent/extensions/pi-spec
```

If you run pi with a custom agent directory (`PI_CODING_AGENT_DIR`), use
`$PI_CODING_AGENT_DIR/extensions/` instead of `~/.pi/agent/extensions/`.

Then restart pi, or run `/reload` in a running session. The next new conversation starts
with the **Where to?** prompt.

### Install fzf and fd

```bash
# Debian / Ubuntu
sudo apt install fzf fd-find

# Fedora
sudo dnf install fzf fd-find

# macOS
brew install fzf fd
```

Optional — without `fzf` pi-spec opens its built-in directory browser instead
(`PI_SPEC_PICKER=browse` forces it).

### Try it without installing

```bash
pi -ne -e /path/to/pi-spec/index.ts
```

`-ne` disables extension discovery so the extension is not loaded twice; the explicit
`-e` path still loads it for this run.

### Project-local install (optional)

```bash
mkdir -p .pi/extensions
cp -r /path/to/pi-spec .pi/extensions/pi-spec
```

It loads only in that project, after you trust it. If the global copy is also installed,
start with `pi -ne -e .pi/extensions/pi-spec/index.ts` to avoid loading both.

### Install the global rules

Inside pi:

```
/spec global
```

This writes the managed pi-spec block into `<agent-dir>/AGENTS.md`, so every future
session — in any directory — recognizes `.pi_spec/`, `.pi_spec/script/`, and
`.pi_output/`. A reference copy is `global-AGENTS.md` in the extension folder. `/spec`
status shows whether the file is installed.

### Verify

```bash
ls ~/.pi/agent/extensions/pi-spec
# README.md  global-AGENTS.md  index.ts  knowledge.ts  picker.ts  registry.ts  relaunch.ts  scaffold.ts
```

Inside pi, `/spec` should show the active root (or “no active root”), the `fzf` path, and
`Global rules: …/AGENTS.md`. If the picker did not appear, check that the extension is in
the auto-discovered path and run `/reload`.

### Update

```bash
cd ~/src/pi-spec && git pull
```

then `/reload` (or restart pi). Your roots live outside the extension folder in
`~/.pi/agent/pi-spec/roots.json`, so they survive updates. Run `/spec global` again if
the rules block changed.

### Uninstall

```bash
rm -rf ~/.pi/agent/extensions/pi-spec
rm -rf ~/.pi/agent/pi-spec          # optional: forget all roots
```

Then remove the `<!-- pi-spec:global:begin -->` … `<!-- pi-spec:global:end -->` block from
`~/.pi/agent/AGENTS.md`. Per project, optionally delete `.pi_spec/`, `.pi_output/`, and the
`<!-- pi-spec:begin -->` … `<!-- pi-spec:end -->` block in `AGENTS.md`. Restart pi or run
`/reload`.

---

## Quick start

1. Start pi anywhere:

   ```bash
   cd ~
   pi
   ```

2. Choose **＋ Add a new project root…**. `fzf` opens at your home directory.

   ```
   Pick the project root ❯
     /home/you/git/api/
   ▶ /home/you/git/web/
   ```

   Type to filter (`git/web`), `enter` to choose, `esc` to cancel.

3. Name it. The alias prompt shows the default:

   ```
   Alias for /home/you/git/web (enter = web)
   ```

   Press `enter` to accept, or type `webapp`. Aliases must be unique; collisions become
   `webapp-2`.

4. pi restarts inside `/home/you/git/web` (same process, same shell job) and scaffolds:

   ```
   pi-spec: initialized webapp — AGENTS.md created, .pi_output/ ready,
   generated scripts → .pi_spec/script/
   webapp: 143 files indexed — /spec refresh to rebuild
   ```

   The footer now shows `⬢ webapp · /home/you/git/web`.

5. Work normally. Ask it where things live — `spec_lookup` searches the index instead of
   crawling the tree.

Next time you start pi, `webapp` is the first option (most recently used). Pressing
`enter` re-attaches.

---

## What gets created for you

First time a root is selected:

```
web/
├── AGENTS.md                 # rules for this project (pi-spec block; your text is kept)
├── .pi_output/               # every generated artifact lands here
│   └── .gitignore            # keeps outputs out of git
└── .pi_spec/
    ├── PROJECT.md            # overview: layout, languages, manifests, entry points
    ├── INDEX.md              # every file with size, symbols, one-line summary
    ├── KNOWLEDGE.md          # compact digest injected into the system prompt
    ├── files.json            # machine-readable inventory (spec_lookup)
    ├── meta.json             # alias, root, stats, git info, timestamps
    └── script/               # generated scripts, codemods, one-off helpers
```

`AGENTS.md` gets a managed block that tells the agent to:

- read `.pi_spec/` before broad exploration and use `spec_lookup`;
- put one-off scripts in `.pi_spec/script/` and keep the original code read-only;
- write reports/exports/logs/datasets to `.pi_output/`;
- run `/spec refresh` after structural changes.

The block lives between `<!-- pi-spec:begin -->` and `<!-- pi-spec:end -->`; anything
outside it is never touched, and re-running setup only refreshes the block.

`.pi_spec/` and `.pi_output/` are ordinary untracked data — ignore or delete them freely,
`/spec refresh` rebuilds.

## Global rules (every pi session)

pi loads `<agent-dir>/AGENTS.md` for every working directory, so pi-spec installs a
workspace-structure section there too:

```
~/.pi/agent/AGENTS.md
<!-- pi-spec:global:begin -->
## pi-spec workspaces
... `.pi_spec/`, `.pi_spec/script/`, `.pi_output/` layout and rules ...
<!-- pi-spec:global:end -->
```

That way any pi session — even in a project that was never scaffolded — recognizes a
`.pi_spec/` folder and knows where background, generated scripts, and outputs belong.
Your own global instructions stay outside the managed markers.

Install or refresh it with:

```
/spec global
```

A reference copy lives at `~/.pi/agent/extensions/pi-spec/global-AGENTS.md`. `/spec`
status shows whether the global file is present.

---

## Day-to-day usage

### Choose a different root

Run `/spec root`. Same picker as startup.

### Switch to a root you already registered

```
/spec use webapp
```

If the target differs from the current directory, pi asks:

```
 Move pi into /home/you/git/web?

 → Yes
   No
```

- **Yes** restarts pi inside the root. The current conversation stays saved and resumable
  (`pi --resume` from the old directory).
- **No** keeps the conversation and binds `read`/`write`/`edit`/`bash`/`grep`/`find`/`ls`
  to the root for the rest of the session. `pwd` still prints the root; pi's own cwd does
  not change. `/spec restart` moves pi later.

### Add another project without restarting

`/spec add` → pick a directory → name it → it becomes active (restart prompt as above).

### Re-selecting a known directory

If you pick a directory that is already registered, or that sits *inside* a registered
root, pi-spec does not create a duplicate — it redirects to the existing root:

```
Already registered as "webapp" — using /home/you/git/web
```

### Keep the knowledge current

The digest is rebuilt automatically when it is older than 24 hours. After big structural
changes, run:

```
/spec refresh
```

It re-scans the tree and prints `webapp: 143 files indexed`.

### Deeper analysis (uses the model)

```
/spec analyze
```

The agent reads `PROJECT.md`, `INDEX.md`, `files.json`, then writes:

- `.pi_spec/ARCHITECTURE.md` — components, data flow, entry points, conventions, risks;
- `.pi_spec/GLOSSARY.md` — domain terms and where they live in code.

Narrow it with `/spec analyze billing logic`.

### Generated scripts and outputs

Ask normally; the rules steer the result:

> “Write a one-off script that counts lines per language and save the report.”

→ script in `.pi_spec/script/count_lines.sh`, output in `.pi_output/line_counts.txt`.
The injected prompt also reports live counts: `Artifacts so far: 1 script(s), 1 file(s)`.

### Rename or forget

```
/spec alias frontend        # rename the active root
/spec list                  # show the registry
/spec forget frontend       # remove from registry (files untouched)
```

### Resume

`pi --resume` re-attaches to the root recorded in the resumed session without asking.
`/reload` and `/fork` do the same.

---

## Commands

| Command | What it does |
|---|---|
| `/spec` | Status: active root, mode, index stats, git, rules file, registry, `fzf` availability |
| `/spec root` | Pick a root (asks before restarting pi) |
| `/spec use <alias>` | Switch to a registered alias |
| `/spec global` | Install/refresh the workspace rules in `<agent-dir>/AGENTS.md` |
| `/spec add` | Add a new root now and activate it |
| `/spec restart` | Restart pi inside the active root |
| `/spec refresh` | Rebuild `.pi_spec/` for the active root |
| `/spec init` | Refresh `AGENTS.md`, `.pi_output/`, `.pi_spec/script/` |
| `/spec analyze [focus]` | Agent writes `ARCHITECTURE.md` / `GLOSSARY.md` |
| `/spec list` | Show the registry |
| `/spec alias <name>` | Rename the active root |
| `/spec forget <alias>` | Remove from the registry |

`/spec <tab>` completes subcommands.

### `spec_lookup`

Registered as a tool the model can call on its own:

```
spec_lookup query="permission" limit=25
```

It matches paths, symbol names, and summaries from `.pi_spec/files.json`, plus digest
lines, and returns the matching files with symbols. Ask “where is the permission logic?”
instead of letting it grep blindly.

---

## How it works

**Startup / `/new`** — `session_start` shows the picker. `resume`, `fork`, and `reload`
restore the session's root silently. In `print`/`json`/`rpc` modes there is no prompt: the
root is the current directory (or its registered parent).

**Moving into the root** — pi cannot `chdir` in-process, so pi-spec does:

```
tui.stop()  →  chdir(root)  →  execve(same pi command)
```

same PID, same terminal job, no wrapper process. Session-selection flags (`-c`,
`--resume`, `--session`, `--fork`, `--session-dir`) are dropped, everything else
(`--model`, `--thinking`, `-e`, `--tools`, prompts) is preserved. If the restart fails,
pi stays alive and tools stay bound to the root.

**Injected context** — `before_agent_start` adds a `pi-spec` section with the root, alias,
rules, live artifact counts, and the knowledge digest, plus `<root>/AGENTS.md` as a
context file.

**Tool binding** — `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` are registered
against the active root and rebind `ctx.cwd`, so relative paths and `pwd` are correct in
every mode (native or bound).

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PI_SPEC_DIR` | `.pi_spec` | Knowledge folder name inside the root |
| `PI_SPEC_OUTPUT_DIR` | `.pi_output` | Folder for generated outputs |
| `PI_SPEC_PICKER` | auto | `browse` forces the built-in browser instead of fzf |
| `PI_SPEC_FZF_DEPTH` | `6` | Max directory depth offered by fzf |
| `PI_SPEC_MAX_FILES` | `6000` | Scan cap; larger trees are marked truncated |
| `PI_SPEC_MAX_AGE_HOURS` | `24` | Rebuild the digest in the background when older |
| `PI_SPEC_NO_EXEC` | unset | `1` disables `execve`; pi runs as a child instead |
| `PI_SPEC_DEBUG_LOG` | unset | Append session/relaunch diagnostics to this file |

Registry file: `~/.pi/agent/pi-spec/roots.json`.

```json
{
  "version": 1,
  "lastAlias": "webapp",
  "roots": [
    { "alias": "webapp", "root": "/home/you/git/web", "createdAt": 0, "lastUsedAt": 0, "initializedAt": 0 }
  ]
}
```

## Extension layout

```
~/.pi/agent/extensions/pi-spec/
├── index.ts      # events, commands, prompt injection, tool binding
├── registry.ts   # alias → root registry, dedupe/redirect
├── picker.ts     # fzf picker + TUI browser fallback
├── knowledge.ts  # scanner and knowledge-base writer
├── scaffold.ts   # AGENTS.md rules (project + global), .pi_output/, .pi_spec/script/
├── global-AGENTS.md # reference copy of the global rules block
└── relaunch.ts   # execve/child-process restart into the chosen root
```

---

## Troubleshooting

**The picker doesn't look like fzf.** `fzf` is missing from `PATH`. Install it, or keep
using the built-in browser (`PI_SPEC_PICKER=browse`). `/spec` shows which one is active.

**The prompt doesn't appear.** It is skipped for `resume`/`fork`/`reload` and for
non-TUI modes (`-p`, `--mode json`, RPC). Run `/spec root` to pick one manually.

**pi shows `Mode: bound`.** The process did not move: you answered **No** to the restart
prompt, used `PI_SPEC_NO_EXEC=1`, ran on Node < 22.15, or the restart failed. Tools still
point at the root; `/spec restart` retries.

**“root does not exist”.** The registered directory was moved or deleted. `/spec forget`
it and add the new location.

**Global rules are not loaded.** Check `/spec` for `Global rules:`; if missing run
`/spec global`, then `/reload`.

**The digest looks outdated.** It refreshes after 24h or on `/spec refresh`. Use
`PI_SPEC_MAX_AGE_HOURS=0` to always rebuild.

**Trust prompt after selecting a root.** pi asks to trust projects containing `.pi/`,
`AGENTS.md`, or `.agents/skills`. pi-spec creates `AGENTS.md`, so this is expected; choose
trust to load project-local resources.

**Debug a restart.** `PI_SPEC_DEBUG_LOG=/tmp/pi-spec.log pi` records
`session_start`, `relaunch`, `execve`, and child-exit lines.

**Reset everything.** Delete `~/.pi/agent/pi-spec/roots.json` (registry), and remove
`.pi_spec/`, `.pi_output/`, and the pi-spec block in `AGENTS.md` from a project. To
uninstall, delete `~/.pi/agent/extensions/pi-spec/`.

---

## Limits

- O(6000) files per scan, 512 KB per file for summaries; deeper trees are marked truncated.
- `.git`, `node_modules`, virtualenvs, build output, and caches are skipped.
- The scanner is deterministic — it does not call the model. Use `/spec analyze` for
  LLM-written architecture and glossary notes.
- The knowledge base is per root, not per conversation; switching roots does not merge them.
