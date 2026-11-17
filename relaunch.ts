/**
 * Process relaunch for pi-spec.
 *
 * pi has no API to change its process working directory, so moving the whole
 * process into a project root means starting a new pi process with that cwd.
 * The current TUI is suspended, the child runs in the root, and when it exits
 * the caller shuts the parent down.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonical } from "./registry.ts";

/** Append a diagnostic line when PI_SPEC_DEBUG_LOG is set. */
export function debugLog(message: string): void {
	const file = process.env.PI_SPEC_DEBUG_LOG;
	if (!file) return;
	try {
		appendFileSync(file, `${new Date().toISOString()} [pid ${process.pid}] ${message}\n`);
	} catch {
		// logging must never break the extension
	}
}

export interface RelaunchTarget {
	alias: string;
	root: string;
}

/** Session selection flags would re-bind the child to the old cwd. */
const DROP_FLAGS = new Set([
	"-c",
	"--continue",
	"-r",
	"--resume",
	"--session",
	"--session-id",
	"--fork",
	"--session-dir",
	"--export",
]);

/** Flags whose next argument is their value rather than a prompt or a file. */
const VALUE_FLAGS = new Set([
	"-e",
	"--extension",
	"--skill",
	"--prompt-template",
	"--theme",
	"--use-theme",
	"--provider",
	"--model",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--mode",
	"--session",
	"--session-id",
	"--fork",
	"--session-dir",
	"--export",
	"--name",
	"-n",
	"--tools",
	"-t",
	"--exclude-tools",
	"-xt",
	"--models",
	"--thinking",
	"--tui-mode",
]);

function splitFlag(arg: string): { flag: string; hasInlineValue: boolean } {
	const equals = arg.indexOf("=");
	return equals === -1
		? { flag: arg, hasInlineValue: false }
		: { flag: arg.slice(0, equals), hasInlineValue: true };
}

/**
 * Rebuild the CLI arguments for the child process.
 * `keepPrompts: false` drops positional prompts (used when relaunching from /new).
 */
export function filterRelaunchArgs(args: string[], options: { keepPrompts: boolean }): string[] {
	const out: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg === "--") {
			if (options.keepPrompts) out.push(...args.slice(index));
			break;
		}
		if (!arg.startsWith("-")) {
			if (options.keepPrompts) out.push(arg);
			continue;
		}
		const { flag, hasInlineValue } = splitFlag(arg);
		const takesValue = !hasInlineValue && VALUE_FLAGS.has(flag);
		if (DROP_FLAGS.has(flag)) {
			if (takesValue) index++;
			continue;
		}
		out.push(arg);
		if (takesValue) {
			const value = args[index + 1];
			if (value !== undefined) {
				out.push(value);
				index++;
			}
		}
	}
	return out;
}

interface Program {
	/** File to execute: pi's JS entry, or a shebang shim such as `.bin/pi`. */
	command: string;
	/** Arguments after the program name. */
	args: string[];
}

function relaunchProgram(args: string[]): Program | undefined {
	const raw = process.argv[1];
	if (!raw) return undefined;
	// Resolve before the child chdirs, so relative script paths keep working.
	const script = resolve(raw);
	if (/\.(?:c|m)?js$/.test(script)) return { command: process.execPath, args: [script, ...args] };
	if (script.includes("/")) return { command: script, args };
	return undefined;
}

type Execve = (file: string, args: string[], env: NodeJS.ProcessEnv) => never;

/** Node >= 22.15 can replace the process image, which keeps the PID and job control. */
function execve(): Execve | undefined {
	if (process.env.PI_SPEC_NO_EXEC === "1") return undefined;
	const candidate = (process as unknown as { execve?: Execve }).execve;
	return typeof candidate === "function" ? candidate.bind(process) : undefined;
}

export interface RelaunchResult {
	/** The child process actually started. */
	launched: boolean;
	/** Child exit status (null when it was killed by a signal). */
	status: number | null;
	/** Spawn error message, when the child could not start. */
	error?: string;
	/** The child died almost immediately with an error; treat the relaunch as failed. */
	failed?: boolean;
}

/**
 * Replace this process with pi in `target.root` (same PID, same terminal job).
 * Only returns when the replacement failed.
 */
async function execInRoot(
	ctx: ExtensionContext,
	program: Program,
	env: NodeJS.ProcessEnv,
	exec: Execve,
): Promise<RelaunchResult> {
	const previousCwd = process.cwd();
	const outcome = await ctx.ui.custom<RelaunchResult>((tui, _theme, _kb, done) => {
		let error: string | undefined;
		tui.stop();
		try {
			process.chdir(env.PI_SPEC_ROOT as string);
			debugLog(`execve ${program.command} ${JSON.stringify(program.args)} in ${env.PI_SPEC_ROOT}`);
			exec(program.command, [program.command, ...program.args], env);
			error = "execve returned without replacing the process";
		} catch (thrown) {
			error = (thrown as Error).message;
		}
		// Only reached when exec failed: restore the terminal and cwd.
		try {
			process.chdir(previousCwd);
		} catch {
			// keep the new cwd; it is reported through the error
		}
		tui.start();
		tui.requestRender(true);
		debugLog(`execve failed: ${error}`);
		done({ launched: false, status: null, error });
		return { render: () => [], invalidate: () => {} };
	});
	return outcome ?? { launched: false, status: null, error: "relaunch cancelled" };
}

/**
 * Move pi into `target.root`.
 *
 * Preferred path: suspend the TUI, `chdir`, and `execve` the same pi command so
 * the process (and the shell's job control) is preserved. Older Node versions
 * fall back to running pi as a child process.
 */
export async function relaunchPi(
	ctx: ExtensionContext,
	target: RelaunchTarget,
	options: { keepPrompts: boolean },
): Promise<RelaunchResult> {
	const args = filterRelaunchArgs(process.argv.slice(2), options);
	const program = relaunchProgram(args);
	if (!program) return { launched: false, status: null, error: "cannot reconstruct the pi command line" };
	debugLog(
		`relaunch → ${target.root} (alias ${target.alias}) command=${program.command} args=${JSON.stringify(program.args)}`,
	);

	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_SPEC_RELAUNCHED: "1",
		PI_SPEC_ROOT: canonical(target.root),
		PI_SPEC_ALIAS: target.alias,
	};

	const exec = execve();
	if (exec) return execInRoot(ctx, program, env, exec);
	return spawnInRoot(ctx, target, program, env);
}

/** Fallback: run pi as a child in the root; the parent exits when the child does. */
async function spawnInRoot(
	ctx: ExtensionContext,
	target: RelaunchTarget,
	program: Program,
	env: NodeJS.ProcessEnv,
): Promise<RelaunchResult> {
	const outcome = await ctx.ui.custom<RelaunchResult>((tui, _theme, _kb, done) => {
		let result: RelaunchResult = { launched: false, status: null };
		const startedAt = Date.now();
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");

		// A terminal Ctrl+C/SIGTERM reaches the whole process group. Ignore those
		// signals in the suspended parent so only the child reacts to them.
		const ignore = () => {};
		const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
		for (const signal of signals) process.on(signal, ignore);
		try {
			const spawned = spawnSync(program.command, program.args, {
				cwd: target.root,
				stdio: "inherit",
				env,
			});
			const elapsed = Date.now() - startedAt;
			result = {
				launched: !spawned.error,
				status: spawned.status,
				error: spawned.error?.message,
				failed: Boolean(spawned.error) || (spawned.status !== 0 && elapsed < 2000),
			};
		} catch (error) {
			result = { launched: false, status: null, error: (error as Error).message };
		} finally {
			for (const signal of signals) process.removeListener(signal, ignore);
			tui.start();
			tui.requestRender(true);
		}
		debugLog(`child exited status=${result.status} launched=${result.launched}${result.error ? ` error=${result.error}` : ""}`);
		done(result);
		return { render: () => [], invalidate: () => {} };
	});

	return outcome ?? { launched: false, status: null, error: "relaunch cancelled" };
}
