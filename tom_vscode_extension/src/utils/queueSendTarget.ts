/**
 * Where a queue send goes, in the words the 'Tom Prompt Queue' log uses.
 * vscode-free so it can be tested in plain Node.
 */

/** A stage's resolved target, as `PromptQueueManager.resolveStageTransport` answers it. */
export interface QueueSendTarget {
    transport: string;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    session?: string;
}

const given = (value: string | undefined): string | undefined => (value && value.trim() ? value.trim() : undefined);

/**
 * `via copilot`, or `via anthropic (profile <id>[, configuration <id>][, session <name>])`
 * — `default profile` when none is named. The configuration is named only
 * when one is set explicitly (otherwise it is the profile's own).
 */
export function describeQueueSendTarget(target: QueueSendTarget): string {
    if (target.transport !== 'anthropic') { return `via ${target.transport}`; }
    const parts = [given(target.anthropicProfileId) ? `profile ${given(target.anthropicProfileId)}` : 'default profile'];
    if (given(target.anthropicConfigId)) { parts.push(`configuration ${given(target.anthropicConfigId)}`); }
    if (given(target.session)) { parts.push(`session ${given(target.session)}`); }
    return `via anthropic (${parts.join(', ')})`;
}
