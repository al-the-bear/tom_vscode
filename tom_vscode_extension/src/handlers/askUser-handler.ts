/**
 * Live bridge for `tomAi_askUser` — wires the vscode-free tool impl
 * (`ask-user-tool.ts`) and registry (`askUserRegistry.ts`) into the editor: a
 * webview panel for answering in VS Code, plus a Telegram notification so the
 * user can answer from their phone. Either channel resolves the one pending ask.
 *
 * The panel is a singleton (the registry allows only one ask in flight); a new
 * ask disposes any stale panel first. When the ask resolves by *any* source
 * (vscode submit, Telegram reply, timeout, cancel) the registry calls
 * {@link onResolve}, which dismisses the panel.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getExtensionPath, bridgeLog } from './handler_shared';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { AskUserRegistry, PendingAsk, AskAnswerSource } from '../services/askUserRegistry';
import { readChatQuestionsConfig } from './chatQuestions-config';
import { readEffectiveTelegramConfig } from './telegram-config';
import {
    ASK_USER_TOOL as ASK_USER_DEF,
    AskUserInput,
    AskUserDeps,
    askUserImpl,
} from '../tools/ask-user-tool';
import { SharedToolDefinition } from '../tools/shared-tool-registry';

// ===========================================================================
// Singleton webview panel
// ===========================================================================

let activePanel: vscode.WebviewPanel | undefined;
let activeRequestId: string | undefined;

/** Tear down the current panel (if any) without touching the registry. */
function disposeActivePanel(): void {
    const panel = activePanel;
    activePanel = undefined;
    activeRequestId = undefined;
    if (panel) {
        try { panel.dispose(); } catch { /* already gone */ }
    }
}

/** Open (or replace) the ask panel for a pending ask. */
function openAskPanel(pending: PendingAsk): void {
    disposeActivePanel();

    const extPath = getExtensionPath();
    const localRoots = extPath ? [vscode.Uri.file(path.join(extPath, 'media'))] : undefined;

    const panel = vscode.window.createWebviewPanel(
        'tomAiAskUser',
        'Tom AI — Questions',
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: localRoots,
        },
    );

    panel.webview.onDidReceiveMessage((msg: { type?: string; requestId?: string; text?: string }) => {
        if (msg?.type === 'submit' && msg.requestId === pending.requestId) {
            const text = typeof msg.text === 'string' ? msg.text : '';
            AskUserRegistry.instance.submit(pending.requestId, text, 'vscode');
        }
    });

    panel.onDidDispose(() => {
        // Manual close: forget the panel but leave the ask pending so the user
        // can still answer from Telegram / let the timeout fire.
        if (activeRequestId === pending.requestId) {
            activePanel = undefined;
            activeRequestId = undefined;
        }
    });

    try {
        panel.webview.html = loadWebviewHtml(panel.webview, 'askUser', {
            init: {
                requestId: pending.requestId,
                questions: pending.questions,
                title: pending.title,
                timeoutAt: pending.timeoutAt,
            },
        });
    } catch (err) {
        bridgeLog(`[askUser] Failed to render panel: ${(err as Error).message}`, 'ERROR');
    }

    activePanel = panel;
    activeRequestId = pending.requestId;
}

/** Dismiss the panel once the ask resolves by any source. */
function closeAskPanel(pending: PendingAsk, source: AskAnswerSource): void {
    if (activeRequestId === pending.requestId && activePanel) {
        // Let the webview reflect a non-vscode resolution before it goes away.
        if (source !== 'vscode') {
            try {
                activePanel.webview.postMessage({ type: 'resolved', note: resolvedNote(source) });
            } catch { /* panel may already be disposing */ }
        }
    }
    if (activeRequestId === pending.requestId) {
        disposeActivePanel();
    }
}

function resolvedNote(source: AskAnswerSource): string {
    switch (source) {
        case 'telegram': return 'Answered from Telegram.';
        case 'timeout': return 'Timed out — the assistant will continue on its own.';
        case 'cancel': return 'The question was cancelled.';
        default: return 'Answered.';
    }
}

// ===========================================================================
// Telegram notification
// ===========================================================================

/** Send the questions to the configured Telegram chat (best-effort, no-op when unconfigured). */
function sendAskTelegram(pending: PendingAsk): void {
    const tg = readEffectiveTelegramConfig();
    if (!tg.enabled || !tg.botToken || !tg.defaultChatId) { return; }

    const lines: string[] = [];
    lines.push('🙋 The assistant has some questions:');
    if (pending.title) { lines.push('', pending.title); }
    lines.push('');
    pending.questions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
    lines.push('', 'Reply with your answer (you can address the questions by number).');
    const text = lines.join('\n');

    void (async () => {
        try {
            const url = `https://api.telegram.org/bot${tg.botToken}/sendMessage`;
            const resp = await fetch(url, {
                method: 'POST',
                // eslint-disable-next-line @typescript-eslint/naming-convention
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: tg.defaultChatId, text }),
            });
            if (!resp.ok) {
                bridgeLog(`[askUser] Telegram notify failed: HTTP ${resp.status}`, 'ERROR');
            }
        } catch (err) {
            bridgeLog(`[askUser] Telegram notify error: ${(err as Error).message}`, 'ERROR');
        }
    })();
}

// ===========================================================================
// Live deps + tool
// ===========================================================================

const liveAskUserDeps: AskUserDeps = {
    registry: AskUserRegistry.instance,
    loadConfig: () => readChatQuestionsConfig(),
    onOpen: (pending) => {
        openAskPanel(pending);
        sendAskTelegram(pending);
    },
    onResolve: (pending, source) => {
        closeAskPanel(pending, source);
    },
};

/** The live `tomAi_askUser` tool with its blocking executor wired in. */
export const ASK_USER_LIVE_TOOL: SharedToolDefinition<AskUserInput> = {
    ...ASK_USER_DEF,
    execute: (input) => askUserImpl(liveAskUserDeps, input),
};

/**
 * Cancel any pending ask (e.g. on queue Stop / window dispose) so the awaiting
 * round does not leak. Safe to call when nothing is pending.
 */
export function cancelPendingAskUser(note?: string): void {
    AskUserRegistry.instance.cancel(note);
}
