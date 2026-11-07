/**
 * Claude Code's hooks for every transport (CC-12 (a)).
 *
 * Hooks are shell commands in the `hooks` block of Claude Code's settings
 * files — `~/.claude/settings.json` (user), `<workspace>/.claude/settings.json`
 * (project), `<workspace>/.claude/settings.local.json` (local):
 *
 *   { "hooks": { "PreToolUse": [ { "matcher": "Edit|Write",
 *       "hooks": [ { "type": "command", "command": "…", "timeout": 60 } ] } ] } }
 *
 * The extension runs PreToolUse, PostToolUse, UserPromptSubmit, Stop and
 * SessionStart itself on the transports with its own loop (direct, Local LLM,
 * VS Code LM: AnthropicHandler), with Claude Code's semantics:
 *
 * - **Input**: JSON on stdin — `session_id`, `transcript_path`, `cwd`,
 *   `hook_event_name` and the event's fields (`tool_name`, `tool_input`,
 *   `tool_response`, `prompt`, `stop_hook_active`, `source`);
 *   `CLAUDE_PROJECT_DIR` is the workspace root, the command runs there in a
 *   shell, killed after its timeout (60 s by default).
 * - **Exit 0**: success. JSON on stdout decides (`hookSpecificOutput.
 *   permissionDecision` allow / deny / ask with its reason and
 *   `updatedInput`, the legacy `decision` approve / block, `decision: block`
 *   with `reason`, `additionalContext`, `continue: false` with `stopReason`,
 *   `systemMessage`); plain stdout is context for UserPromptSubmit and
 *   SessionStart only.
 * - **Exit 2**: a block, stderr the reason — the tool call is refused
 *   (PreToolUse), the reason goes to the model (PostToolUse, Stop), the
 *   prompt is refused (UserPromptSubmit).
 * - **Any other exit, a crash, a timeout**: a non-blocking error, shown to
 *   the user; the work goes on.
 *
 * All hooks matching an event run in parallel; for PreToolUse deny wins over
 * ask over allow. On the Agent SDK the SDK runs the hooks of the setting
 * sources it loads; the others go to it as callbacks
 * ({@link sdkHookCallbacks}), so every hook runs once.
 *
 * vscode-free.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SessionStart';
export const HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart'];

export type HookSource = 'user' | 'project' | 'local';

/** Claude Code's default hook timeout. */
export const DEFAULT_HOOK_TIMEOUT_SEC = 60;

export interface CommandHook {
    event: HookEvent;
    /** The matcher as written (tool name pattern; the source for SessionStart); undefined matches everything. */
    matcher?: string;
    command: string;
    timeoutSec: number;
    source: HookSource;
    /** The settings file it came from. */
    file: string;
}

let homeOverride: string | undefined;

/** The home folder whose `.claude/settings.json` holds the user's hooks. */
export function hooksHomeDir(): string {
    return homeOverride ?? os.homedir();
}

/** Tests only: read the user's hooks from `dir` (undefined: the real home again). */
export function __setHooksHomeForTests(dir: string | undefined): void {
    homeOverride = dir;
}

/** The settings files hooks are read from, in Claude Code's order. */
export function hookSettingsFiles(wsRoot: string, homeDir: string): Array<{ source: HookSource; file: string }> {
    return [
        { source: 'user', file: path.join(homeDir, '.claude', 'settings.json') },
        { source: 'project', file: path.join(wsRoot, '.claude', 'settings.json') },
        { source: 'local', file: path.join(wsRoot, '.claude', 'settings.local.json') },
    ];
}

/** The command hooks of the settings files (of `sources`, default all three). */
export function loadHooks(wsRoot: string, homeDir: string, sources?: readonly HookSource[]): CommandHook[] {
    const out: CommandHook[] = [];
    for (const { source, file } of hookSettingsFiles(wsRoot, homeDir)) {
        if (sources && !sources.includes(source)) { continue; }
        let parsed: unknown;
        try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
        const hooks = (parsed as { hooks?: unknown })?.hooks;
        if (!hooks || typeof hooks !== 'object') { continue; }
        for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
            if (!HOOK_EVENTS.includes(event as HookEvent) || !Array.isArray(groups)) { continue; }
            for (const group of groups as Array<{ matcher?: unknown; hooks?: unknown }>) {
                const matcher = typeof group?.matcher === 'string' && group.matcher !== '' ? group.matcher : undefined;
                for (const h of Array.isArray(group?.hooks) ? group.hooks as Array<Record<string, unknown>> : []) {
                    if (h?.type !== 'command' || typeof h.command !== 'string' || !h.command.trim()) { continue; }
                    const timeout = typeof h.timeout === 'number' && h.timeout > 0 ? h.timeout : DEFAULT_HOOK_TIMEOUT_SEC;
                    out.push({ event: event as HookEvent, ...(matcher ? { matcher } : {}), command: h.command, timeoutSec: timeout, source, file });
                }
            }
        }
    }
    return out;
}

/** Whether `matcher` matches `value` — a regular expression over the whole value; none and '*' match all. */
export function matcherMatches(matcher: string | undefined, value: string | undefined): boolean {
    if (matcher === undefined || matcher === '' || matcher === '*') { return true; }
    if (value === undefined) { return false; }
    try {
        return new RegExp(`^(?:${matcher})$`).test(value);
    } catch {
        return matcher === value;
    }
}

/** The hooks of `event` whose matcher matches `value` (the tool name, or SessionStart's source). */
export function hooksFor(hooks: readonly CommandHook[], event: HookEvent, value?: string): CommandHook[] {
    return hooks.filter((h) => h.event === event && matcherMatches(h.matcher, value));
}

export interface HookRunOptions {
    /** The workspace root: the command's folder and CLAUDE_PROJECT_DIR. */
    cwd: string;
    sessionId: string;
    transcriptPath: string;
}

export interface HookRun {
    hook: CommandHook;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    /** stdout parsed as a JSON object, when it is one. */
    json?: Record<string, unknown>;
}

/** Run one command hook with `input` on stdin. Never throws: a failed start is an exit code null run. */
export function runCommandHook(hook: CommandHook, input: Record<string, unknown>, opts: { cwd: string }): Promise<HookRun> {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const finish = (exitCode: number | null): void => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            const trimmed = stdout.trim();
            let json: Record<string, unknown> | undefined;
            if (trimmed.startsWith('{')) {
                try {
                    const parsed: unknown = JSON.parse(trimmed);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { json = parsed as Record<string, unknown>; }
                } catch { /* not JSON: plain output */ }
            }
            resolve({ hook, exitCode, stdout, stderr, timedOut, ...(json ? { json } : {}) });
        };
        const child = spawn(hook.command, {
            shell: true,
            cwd: opts.cwd,
            env: { ...process.env, CLAUDE_PROJECT_DIR: opts.cwd },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
            finish(null);
        }, hook.timeoutSec * 1000);
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (e) => { stderr += e.message; finish(null); });
        child.on('close', (code) => finish(code));
        child.stdin.on('error', () => { /* the hook did not read its input */ });
        child.stdin.end(JSON.stringify(input));
    });
}

/** What the hooks of one event decided, all runs together. */
export interface HookOutcome {
    /** PreToolUse: deny over ask over allow; undefined when no hook decided. */
    decision?: 'allow' | 'deny' | 'ask';
    /** PostToolUse, UserPromptSubmit, Stop: a hook blocked. */
    block: boolean;
    /** The reasons given with a deny / block (joined). */
    reason?: string;
    /** PreToolUse: the tool input a hook replaced. */
    updatedInput?: Record<string, unknown>;
    /** Context for the model (additionalContext; plain stdout of UserPromptSubmit / SessionStart). */
    additionalContext: string[];
    /** For the user: systemMessage, non-blocking errors. */
    userMessages: string[];
    /** `continue: false`: stop the whole send. */
    stop?: { reason: string };
}

const DECISION_RANK = { allow: 1, ask: 2, deny: 3 } as const;

/** Claude Code's reading of the runs of one event (see the module comment). */
export function interpretHookRuns(event: HookEvent, runs: readonly HookRun[]): HookOutcome {
    const outcome: HookOutcome = { block: false, additionalContext: [], userMessages: [] };
    const reasons: string[] = [];
    const decide = (d: 'allow' | 'deny' | 'ask', reason?: string): void => {
        if (!outcome.decision || DECISION_RANK[d] > DECISION_RANK[outcome.decision]) { outcome.decision = d; }
        if (d === 'deny' && reason) { reasons.push(reason); }
    };
    for (const run of runs) {
        const name = `${event} hook \`${run.hook.command}\``;
        if (run.timedOut) {
            outcome.userMessages.push(`${name} timed out after ${run.hook.timeoutSec} s`);
            continue;
        }
        if (run.exitCode === 2) {
            const reason = run.stderr.trim() || `${event} hook blocked`;
            if (event === 'PreToolUse') { decide('deny', reason); } else if (event === 'SessionStart') {
                outcome.userMessages.push(reason);
            } else {
                outcome.block = true;
                reasons.push(reason);
            }
            continue;
        }
        if (run.exitCode !== 0) {
            outcome.userMessages.push(`${name} failed (exit ${run.exitCode ?? 'none'}): ${run.stderr.trim()}`.trim());
            continue;
        }
        const json = run.json;
        if (!json) {
            const text = run.stdout.trim();
            if (text && (event === 'UserPromptSubmit' || event === 'SessionStart')) { outcome.additionalContext.push(text); }
            continue;
        }
        if (json.continue === false) {
            outcome.stop = { reason: typeof json.stopReason === 'string' ? json.stopReason : '' };
        }
        if (typeof json.systemMessage === 'string' && json.systemMessage) { outcome.userMessages.push(json.systemMessage); }
        const specific = (json.hookSpecificOutput && typeof json.hookSpecificOutput === 'object' ? json.hookSpecificOutput : {}) as Record<string, unknown>;
        if (typeof specific.additionalContext === 'string' && specific.additionalContext) { outcome.additionalContext.push(specific.additionalContext); }
        const reason = typeof json.reason === 'string' ? json.reason : undefined;
        if (event === 'PreToolUse') {
            const d = specific.permissionDecision;
            const why = typeof specific.permissionDecisionReason === 'string' ? specific.permissionDecisionReason : reason;
            if (d === 'allow' || d === 'deny' || d === 'ask') { decide(d, why); } else if (json.decision === 'approve') { decide('allow'); } else if (json.decision === 'block') { decide('deny', why); }
            if (specific.updatedInput && typeof specific.updatedInput === 'object' && !outcome.updatedInput) {
                outcome.updatedInput = specific.updatedInput as Record<string, unknown>;
            }
        } else if (json.decision === 'block') {
            outcome.block = true;
            if (reason) { reasons.push(reason); }
        }
    }
    if (reasons.length > 0) { outcome.reason = reasons.join('\n'); }
    return outcome;
}

/** Run the hooks of `event` matching `matchValue` (all in parallel) and read their outcome. */
export async function runHooks(
    hooks: readonly CommandHook[],
    event: HookEvent,
    fields: Record<string, unknown>,
    opts: HookRunOptions,
    matchValue?: string,
): Promise<HookOutcome> {
    const value = matchValue ?? (typeof fields.tool_name === 'string' ? fields.tool_name : typeof fields.source === 'string' ? fields.source : undefined);
    const matching = hooksFor(hooks, event, value);
    if (matching.length === 0) { return { block: false, additionalContext: [], userMessages: [] }; }
    /* eslint-disable @typescript-eslint/naming-convention -- Claude Code's hook input fields */
    const input = {
        session_id: opts.sessionId,
        transcript_path: opts.transcriptPath,
        cwd: opts.cwd,
        hook_event_name: event,
        ...fields,
    };
    /* eslint-enable @typescript-eslint/naming-convention */
    const runs = await Promise.all(matching.map((h) => runCommandHook(h, input, { cwd: opts.cwd })));
    return interpretHookRuns(event, runs);
}

/** A hook callback as the Agent SDK takes it. */
export type SdkHookCallback = (input: Record<string, unknown>, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

/** The answer the SDK expects from a callback, made from a command run (Claude Code's JSON). */
function sdkOutput(event: HookEvent, run: HookRun): Record<string, unknown> {
    if (run.exitCode === 2) {
        const reason = run.stderr.trim() || `${event} hook blocked`;
        return event === 'PreToolUse'
            ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
            : { decision: 'block', reason };
    }
    if (run.exitCode !== 0 || run.timedOut) {
        return { systemMessage: run.timedOut ? `${event} hook timed out` : `${event} hook failed (exit ${run.exitCode ?? 'none'}): ${run.stderr.trim()}` };
    }
    if (run.json) { return run.json; }
    const text = run.stdout.trim();
    return text && (event === 'UserPromptSubmit' || event === 'SessionStart')
        ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } }
        : {};
}

/**
 * The hooks as the Agent SDK's `hooks` option: per event, one entry per hook
 * with its matcher; the callback runs the command with the input the SDK
 * gives (Claude Code's own hook input) and answers Claude Code's JSON.
 */
export function sdkHookCallbacks(
    hooks: readonly CommandHook[],
    opts: { cwd: string },
): Partial<Record<HookEvent, Array<{ matcher?: string; hooks: SdkHookCallback[]; timeout?: number }>>> {
    const out: Partial<Record<HookEvent, Array<{ matcher?: string; hooks: SdkHookCallback[]; timeout?: number }>>> = {};
    for (const hook of hooks) {
        const callback: SdkHookCallback = async (input) => sdkOutput(hook.event, await runCommandHook(hook, input, opts));
        (out[hook.event] ??= []).push({ ...(hook.matcher ? { matcher: hook.matcher } : {}), hooks: [callback], timeout: hook.timeoutSec });
    }
    return out;
}
