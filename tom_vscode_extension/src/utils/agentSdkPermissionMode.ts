/**
 * Which Agent SDK permission mode a send runs in: the profile's Tool Approval
 * decides, the configuration's `agentSdk.permissionMode` only where it does
 * not contradict it.
 *
 * The SDK calls `canUseTool` — where the extension asks the user before a
 * write tool — in every mode but `bypassPermissions`. So:
 *   - Tool Approval "Never": `bypassPermissions`, nothing is asked.
 *   - Tool Approval "Always": never `bypassPermissions` — a configuration that
 *     sets it runs in `default`, so the approval is asked; `acceptEdits` and
 *     `plan` are kept (the extension's tools still pass `canUseTool` there).
 *
 * Why the profile wins (user decision, vscode_extension finishvsd5): a profile
 * set to "Always" on a bypassing configuration never asked, and nothing on
 * screen said so.
 *
 * Claude Code's own built-ins (a profile's `useBuiltInTools`) go through the
 * same approval (CC-2): the writers ask like the `tomAi_*` writers, the
 * readers run unasked ({@link builtInToolNeedsApproval}). With the built-ins
 * on, "Always" also runs a configured `acceptEdits` or `auto` as `default`:
 * both let writes through without calling `canUseTool`.
 *
 * vscode-free.
 */

export type AgentSdkPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk' | 'auto';
export type ToolApprovalMode = 'always' | 'never';

/** The permission mode a send on a profile with `approvalMode` runs in. */
export function effectivePermissionMode(
    approvalMode: ToolApprovalMode,
    configuredMode: AgentSdkPermissionMode | undefined,
    builtInTools = false,
): AgentSdkPermissionMode {
    if (approvalMode === 'never') { return 'bypassPermissions'; }
    if (!configuredMode || configuredMode === 'bypassPermissions') { return 'default'; }
    if (builtInTools && ACCEPTS_WRITES_UNASKED.has(configuredMode)) { return 'default'; }
    return configuredMode;
}

/** The modes in which the SDK lets a built-in write without calling `canUseTool`. */
const ACCEPTS_WRITES_UNASKED: ReadonlySet<AgentSdkPermissionMode> = new Set(['acceptEdits', 'auto']);

/**
 * Why the configured mode is not the one used, when it is not: "Always" on a
 * configuration in `bypassPermissions`. Undefined otherwise.
 */
export function permissionModeOverride(
    approvalMode: ToolApprovalMode,
    configuredMode: AgentSdkPermissionMode | undefined,
    builtInTools = false,
): string | undefined {
    if (approvalMode !== 'always' || !configuredMode) { return undefined; }
    if (configuredMode === 'bypassPermissions') {
        return 'the configuration\'s permissionMode bypassPermissions is ignored: the profile\'s Tool Approval is "Always", '
            + 'so the send runs in permissionMode default and write tools ask for approval';
    }
    if (builtInTools && ACCEPTS_WRITES_UNASKED.has(configuredMode)) {
        return `the configuration's permissionMode ${configuredMode} is ignored: the profile's Tool Approval is "Always" `
            + 'and Claude Code\'s built-in tools are on, so the send runs in permissionMode default and the writing built-ins ask for approval';
    }
    return undefined;
}

/**
 * Claude Code's built-ins that change something: they ask under "Always", like
 * the `tomAi_*` writers. `KillBash` is the older name of `KillShell`.
 */
export const BUILT_IN_WRITERS: ReadonlySet<string> = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'KillShell', 'KillBash']);

/** Claude Code's built-ins that only read or plan: they run without asking. */
export const BUILT_IN_READERS: ReadonlySet<string> = new Set([
    'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'BashOutput', 'NotebookRead',
    'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'Task', 'TaskOutput', 'ExitPlanMode', 'ListMcpResources', 'ReadMcpResource', 'Skill', 'SlashCommand',
]);

/**
 * Whether a Claude Code built-in asks under Tool Approval "Always": the
 * writers do, the readers do not, and a built-in neither list knows asks —
 * a new tool should be asked about once rather than write unasked.
 */
export function builtInToolNeedsApproval(name: string): boolean {
    return !BUILT_IN_READERS.has(name);
}

/**
 * What an approval request for a built-in shows: the command for Bash, the
 * file for the edit tools, the shell for KillShell; otherwise the input as
 * JSON. At most 200 characters.
 */
export function builtInApprovalSummary(name: string, input: Record<string, unknown>): string {
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
    let text: string | undefined;
    if (name === 'Bash') { text = str(input.command); }
    else if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') { text = str(input.file_path); }
    else if (name === 'NotebookEdit') { text = str(input.notebook_path); }
    else if (name === 'KillShell' || name === 'KillBash') { text = str(input.shell_id); }
    if (!text) {
        try { text = JSON.stringify(input); } catch { text = '[unserializable input]'; }
    }
    return text.length > 200 ? text.slice(0, 197) + '...' : text;
}
