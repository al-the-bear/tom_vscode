/**
 * Ambient context for tool execution.
 *
 * Tools are invoked via a plain `(input) => Promise<string>` signature, so
 * they cannot accept context parameters directly. This module exposes a
 * module-level request/source context that the invoking handler sets
 * around each tool call, letting tools (e.g. `tomAi_chatvar_write`) log
 * entries with the correct `source` and `requestId`.
 *
 * Usage (from a handler):
 *
 *   runWithToolContext({ source: 'anthropic', requestId }, async () => {
 *       const result = await executeToolCall(tools, call);
 *       // ...
 *   });
 *
 * Tools read the current context via `getCurrentToolContext()`. The
 * implementation is a simple synchronous stack rather than
 * `AsyncLocalStorage` because tools are awaited one at a time in the
 * handler loops.
 */

import type { ChangeSource } from '../managers/chatVariablesStore';

export interface ToolExecutionContext {
    /** Who initiated the tool call — threaded through to change-log entries. */
    source: ChangeSource;
    /** Optional request/exchange identifier for audit trails. */
    requestId?: string;
}

const _stack: ToolExecutionContext[] = [];

/** Push a context, run `fn`, and pop the context — even if `fn` throws. */
export async function runWithToolContext<T>(ctx: ToolExecutionContext, fn: () => Promise<T>): Promise<T> {
    _stack.push(ctx);
    try {
        return await fn();
    } finally {
        _stack.pop();
    }
}

/** Return the innermost active context, or `undefined` if none is set. */
export function getCurrentToolContext(): ToolExecutionContext | undefined {
    return _stack.length > 0 ? _stack[_stack.length - 1] : undefined;
}
