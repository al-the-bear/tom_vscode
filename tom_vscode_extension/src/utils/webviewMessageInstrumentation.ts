/**
 * The debug log's record of what a webview posts to the extension, and the
 * exception report of a listener that throws.
 *
 * A message is logged ONCE per webview, by one listener subscribed when the
 * webview is instrumented. Logging inside every wrapped listener printed a
 * message once per listener: the chat panel has two (its message switch and
 * the completion wiring), so one approval click showed up as two approvals in
 * the log, which is what a live check counts.
 *
 * vscode-free: it takes anything with an `onDidReceiveMessage` event.
 */

/** What this needs of a VS Code webview. */
export interface MessageSource {
    onDidReceiveMessage(listener: (message: unknown) => unknown, thisArgs?: unknown, disposables?: unknown): unknown;
}

export interface WebviewMessageInstrumentation {
    /** Names the webview in every line and report, e.g. `tomAi.chatPanel`. */
    source: string;
    /** Message types not logged (high-frequency polling); still delivered. */
    skipTypes?: readonly string[];
    /** Writes one log line (`<source> payload=<json>`). */
    log(line: string): void;
    /** Reports a listener's exception; `where` is `<source>.onDidReceiveMessage`. */
    report(where: string, error: unknown, details: { messageType: unknown }): void;
}

const INSTRUMENTED = Symbol.for('tomAi.webviewMessagesInstrumented');

function messageType(message: unknown): unknown {
    return typeof message === 'object' && message !== null && 'type' in message
        ? (message as Record<string, unknown>).type
        : undefined;
}

/**
 * Instrument `webview` in place: log each message once, and report an
 * exception thrown by any listener subscribed from now on. A second call on the
 * same webview does nothing.
 */
export function instrumentWebviewMessages(webview: MessageSource, opts: WebviewMessageInstrumentation): void {
    const target = webview as MessageSource & { [INSTRUMENTED]?: boolean };
    if (target[INSTRUMENTED]) { return; }
    target[INSTRUMENTED] = true;

    const subscribe = webview.onDidReceiveMessage.bind(webview);
    const skip = new Set(opts.skipTypes ?? []);
    const where = `${opts.source}.onDidReceiveMessage`;

    // Subscribed first, so the line is written before any handler runs.
    subscribe((message: unknown) => {
        const type = messageType(message);
        if (typeof type === 'string' && skip.has(type)) { return; }
        opts.log(`${opts.source} payload=${JSON.stringify(message, (_k, v) => typeof v === 'function' ? '[Function]' : v)}`);
    });

    target.onDidReceiveMessage = (listener, thisArgs, disposables) => {
        const wrapped = async (message: unknown): Promise<unknown> => {
            try {
                return await Promise.resolve(listener.call(thisArgs, message));
            } catch (error) {
                opts.report(where, error, { messageType: messageType(message) });
                throw error;
            }
        };
        return subscribe(wrapped, thisArgs, disposables);
    };
}
