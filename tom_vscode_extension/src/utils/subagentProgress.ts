/**
 * The Agent SDK's own sub-agents in the status line (CC-11): the parent's
 * delegating call (the Task / Agent tool — recognised by its `subagent_type`
 * input, whatever the tool is called) starts one, the sub-agent's tool calls
 * arrive with `parent_tool_use_id` set to that call, and the call's
 * tool_result ends it. Pure: the transport feeds the stream's blocks in and
 * `report` gets one line per event.
 */

export class SubagentProgress {
    /** The running sub-agents: delegating tool_use id → label. */
    private readonly running = new Map<string, string>();
    private readonly calls = new Map<string, number>();

    constructor(private readonly report: (line: string) => void) {}

    /** A tool_use block of the stream; `parentToolUseId` is the message's `parent_tool_use_id`. */
    onToolUse(block: { id?: unknown; name?: unknown; input?: unknown }, parentToolUseId: string | null | undefined): void {
        const input = block.input && typeof block.input === 'object' ? block.input as Record<string, unknown> : {};
        if (typeof input.subagent_type === 'string' && typeof block.id === 'string') {
            const label = input.subagent_type;
            this.running.set(block.id, label);
            this.calls.set(block.id, 0);
            const what = typeof input.description === 'string' && input.description.trim() ? `: ${input.description.trim()}` : '';
            this.report(`Sub-agent ${label} started${what}`);
            return;
        }
        const label = parentToolUseId ? this.running.get(parentToolUseId) : undefined;
        if (label === undefined || typeof block.name !== 'string') { return; }
        const n = (this.calls.get(parentToolUseId!) ?? 0) + 1;
        this.calls.set(parentToolUseId!, n);
        this.report(`Sub-agent ${label}: ${block.name} (call ${n})`);
    }

    /** A tool_result block: the delegating call's result ends its sub-agent. */
    onToolResult(toolUseId: string | undefined): void {
        if (!toolUseId) { return; }
        const label = this.running.get(toolUseId);
        if (label === undefined) { return; }
        this.report(`Sub-agent ${label} done: ${this.calls.get(toolUseId) ?? 0} tool calls`);
        this.running.delete(toolUseId);
        this.calls.delete(toolUseId);
    }
}
