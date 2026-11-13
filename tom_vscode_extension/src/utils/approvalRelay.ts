/**
 * Brings tool-approval requests in front of the user in the @CHAT panel.
 *
 * A request (the Anthropic handler's `onApprovalNeeded`, from a panel send or
 * a queue item) must be seen whatever the bottom panel shows: the relay
 * reveals the chat view (opening it when it was never resolved) and hands the
 * request to its webview as soon as the webview is ready, which then shows
 * its Anthropic subpanel with the dialog. Requests wait here until they are
 * settled (answered or aborted), so a webview that is created or reloaded
 * later still shows the ones open. vscode-free: the host is injected.
 */

export interface ApprovalRequestLike {
    toolUseId: string;
    toolName: string;
    inputSummary: string;
    /** The process run the turn works in (vscimpb81): named in the dialog unless `default`. */
    run?: string;
}

export interface ApprovalRelayHost {
    /** The chat view exists and its webview script has started. */
    isReady(): boolean;
    /** Bring the chat view to the front; open it when it does not exist yet. */
    reveal(): void;
    /** Post a message to the chat webview. */
    post(message: Record<string, unknown>): void;
}

export class ApprovalRelay {
    private readonly open = new Map<string, ApprovalRequestLike>();

    constructor(private readonly host: ApprovalRelayHost) {}

    /** A new request: keep it, bring the view forward, show it when the webview can. */
    request(req: ApprovalRequestLike): void {
        this.open.set(req.toolUseId, req);
        this.host.reveal();
        if (this.host.isReady()) { this.host.post(approvalMessage(req)); }
    }

    /** The webview (re)started: show every request still open, oldest first. */
    ready(): void {
        if (this.open.size === 0) { return; }
        this.host.reveal();
        for (const req of this.open.values()) { this.host.post(approvalMessage(req)); }
    }

    /** A request was answered or aborted: the webview drops it. */
    settled(toolUseId: string): void {
        if (!this.open.delete(toolUseId)) { return; }
        if (this.host.isReady()) { this.host.post({ type: 'anthropicToolApprovalSettled', toolId: toolUseId }); }
    }

    /** The ids still waiting for an answer. */
    get openIds(): string[] { return [...this.open.keys()]; }
}

function approvalMessage(req: ApprovalRequestLike): Record<string, unknown> {
    const inputSummary = req.run && req.run !== 'default' ? `[run ${req.run}]\n${req.inputSummary}` : req.inputSummary;
    return { type: 'anthropicToolApproval', toolId: req.toolUseId, toolName: req.toolName, inputSummary };
}
