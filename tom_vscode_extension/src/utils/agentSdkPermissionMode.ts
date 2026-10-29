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
 * vscode-free.
 */

export type AgentSdkPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk' | 'auto';
export type ToolApprovalMode = 'always' | 'never';

/** The permission mode a send on a profile with `approvalMode` runs in. */
export function effectivePermissionMode(
    approvalMode: ToolApprovalMode,
    configuredMode: AgentSdkPermissionMode | undefined,
): AgentSdkPermissionMode {
    if (approvalMode === 'never') { return 'bypassPermissions'; }
    if (!configuredMode || configuredMode === 'bypassPermissions') { return 'default'; }
    return configuredMode;
}

/**
 * Why the configured mode is not the one used, when it is not: "Always" on a
 * configuration in `bypassPermissions`. Undefined otherwise.
 */
export function permissionModeOverride(
    approvalMode: ToolApprovalMode,
    configuredMode: AgentSdkPermissionMode | undefined,
): string | undefined {
    if (approvalMode !== 'always' || configuredMode !== 'bypassPermissions') { return undefined; }
    return 'the configuration\'s permissionMode bypassPermissions is ignored: the profile\'s Tool Approval is "Always", '
        + 'so the send runs in permissionMode default and write tools ask for approval';
}
