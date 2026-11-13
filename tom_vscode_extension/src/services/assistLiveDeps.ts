/**
 * The live collaborators the assist runs share (Grill me / Explain in detail
 * on a question, the decision helpers): the config's Assist prompts, the
 * quest's sessions, the base session the work runs in, and the ANTHROPIC
 * panel's send. Loaded lazily: the stores and the router pull in the manager
 * layer.
 */

import * as vscode from 'vscode';
import type { AssistPromptsSection } from '../utils/assistPrompts';
import { discardSessionCompletely } from './temporarySessions';

export interface AssistLiveDeps {
    workspaceRoot: string;
    assistPrompts(): AssistPromptsSection | undefined;
    /** The session the process runs its current position in, else the queue's default. */
    baseSession(): string;
    sessionsFolder(): string;
    hasSession(folder: string, name: string): boolean;
    createSession(folder: string, name: string, opts: { basedOn?: string }): { ok: boolean; error?: string };
    deleteSession(folder: string, name: string): void;
    send(prompt: string, session: string, source: string): Promise<{ ok: boolean; error?: string; rejected?: boolean }>;
}

/* eslint-disable @typescript-eslint/no-require-imports */
export function liveAssistDeps(context: vscode.ExtensionContext): AssistLiveDeps {
    const sessions = require('./agentSdkSessionStore.js') as typeof import('./agentSdkSessionStore');
    const memory = require('./memory-service.js') as typeof import('./memory-service');
    const paths = require('../utils/workspacePaths.js') as typeof import('../utils/workspacePaths');
    const { loadSendToChatConfig } = require('../utils/sendToChatConfig.js') as typeof import('../utils/sendToChatConfig');
    return {
        workspaceRoot: paths.WsPaths.wsRoot ?? '',
        assistPrompts: () => loadSendToChatConfig()?.assistPrompts,
        baseSession: () => {
            try {
                const store = require('../managers/processStateStore.js').ProcessStateStore.instance as import('../managers/processStateStore').ProcessStateStore | undefined;
                const def = store?.currentDefinition();
                const { actionSession } = require('../utils/processActionPrompt.js') as typeof import('../utils/processActionPrompt');
                const name = store && def && store.state.process ? actionSession(def, store.state, undefined, store.inheritedSession(), store.currentRun).name : '';
                return name || 'default';
            } catch {
                return 'default';
            }
        },
        sessionsFolder: () => memory.TwoTierMemoryService.instance.agentSdkSessionsFolder(),
        hasSession: (folder, name) => sessions.readSession(folder, name) !== undefined,
        createSession: (folder, name, opts) => sessions.createSession(folder, name, opts),
        // A temporary session leaves nothing: file, in-memory conversation, storage (temporarySessions.ts).
        deleteSession: (folder, name) => { discardSessionCompletely(folder, paths.WsPaths.getWorkspaceQuestId(), name); },
        send: async (prompt, session, source) => {
            const { runAnthropicSend } = require('../handlers/sendToChatRouter.js') as typeof import('../handlers/sendToChatRouter');
            const outcome = await runAnthropicSend(context, prompt, { session, source });
            return { ok: outcome.ok, error: outcome.error, rejected: outcome.rejected, ...(outcome.chatItemId ? { chatItemId: outcome.chatItemId } : {}) };
        },
    };
}
/* eslint-enable @typescript-eslint/no-require-imports */
