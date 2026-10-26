/**
 * The VS Code picker for named Agent SDK sessions, shared by the Anthropic chat
 * panel, the prompt queue (queue default and per item) and the process action
 * page: pick an existing session of the quest, create a new one, or create one
 * based on an existing session, with a lifetime (continue, per prompt, per
 * queue iteration) and optionally the Anthropic profile it runs with. The sessions are the
 * `<name>.session.json` files in the quest's history folder
 * (src/services/agentSdkSessionStore.ts); the rules are in
 * src/utils/agentSdkSessions.ts.
 */

import * as vscode from 'vscode';

import { TwoTierMemoryService } from '../services/memory-service';
import { createSession, listSessions } from '../services/agentSdkSessionStore';
import { describeSession, isValidSessionName } from '../utils/agentSdkSessions';
import type { ProfileSection } from '../utils/sessionSpecs';
import { lifetimeChoices, newSessionOptions, profileChoices } from '../utils/sessionPickerPlan';
import { profileKeyStates } from '../utils/anthropicApiKeyCheck';
import { loadSendToChatConfig } from '../utils/sendToChatConfig';

type SessionItem = vscode.QuickPickItem & { action: 'pick' | 'new' | 'based' | 'clear'; name?: string };

/** The quest's session folder. */
export function sessionsFolder(questId: string): string {
    return TwoTierMemoryService.instance.agentSdkSessionsFolder(questId || undefined);
}

/**
 * Let the user choose a session. `current` is marked; `defaultLabel`, when
 * given, adds an entry that clears the choice (returns `''`). Returns
 * undefined when the picker was dismissed.
 */
export async function pickAgentSdkSession(opts: {
    questId: string;
    current?: string;
    title?: string;
    defaultLabel?: string;
}): Promise<string | undefined> {
    const folder = sessionsFolder(opts.questId);
    const sessions = listSessions(folder);
    const items: SessionItem[] = [];
    if (opts.defaultLabel !== undefined) {
        items.push({ label: `$(circle-slash) ${opts.defaultLabel}`, action: 'clear', description: !opts.current ? '(current)' : '' });
    }
    for (const s of sessions) {
        items.push({
            label: `${s.name === opts.current ? '$(check) ' : '$(comment-discussion) '}${s.name}`,
            description: describeSession(s),
            action: 'pick',
            name: s.name,
        });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: 'pick' });
    items.push({ label: '$(add) New session…', action: 'new', description: 'starts with an empty conversation' });
    if (sessions.length > 0) {
        items.push({ label: '$(git-branch) New session based on…', action: 'based', description: 'starts from another session\'s conversation' });
    }
    const chosen = await vscode.window.showQuickPick(items, {
        title: opts.title ?? 'Agent SDK session',
        placeHolder: `Sessions of quest ${opts.questId || '(none)'} — pick one or create a new one`,
        matchOnDescription: true,
    });
    if (!chosen) { return undefined; }
    if (chosen.action === 'clear') { return ''; }
    if (chosen.action === 'pick') { return chosen.name; }

    let basedOn: string | undefined;
    if (chosen.action === 'based') {
        const base = await vscode.window.showQuickPick(
            sessions.map((s) => ({ label: s.name, description: describeSession(s) })),
            { title: 'Base the new session on', placeHolder: 'The session whose conversation the new one starts from' },
        );
        if (!base) { return undefined; }
        basedOn = base.label;
    }
    const how = await vscode.window.showQuickPick(lifetimeChoices(basedOn),
        { title: basedOn ? `New session based on "${basedOn}"` : 'New session', placeHolder: 'Its lifetime' });
    if (!how) { return undefined; }
    const section = loadSendToChatConfig()?.anthropic;
    const profilePick = await vscode.window.showQuickPick(
        profileChoices(profileKeyStates(section, process.env), section as ProfileSection | undefined,
            basedOn ? sessions.find((x) => x.name === basedOn) : undefined),
        { title: 'The Anthropic profile the session runs with', placeHolder: 'A queue item naming its own profile still overrides it', matchOnDescription: true },
    );
    if (!profilePick) { return undefined; }
    const name = await vscode.window.showInputBox({
        title: basedOn ? `New session based on "${basedOn}"` : 'New session',
        prompt: 'Session name: letters, digits, "_" and "-"',
        validateInput: (v) => {
            if (!isValidSessionName(v)) { return 'Letters, digits, "_" and "-" only, starting with a letter or digit.'; }
            return sessions.some((s) => s.name === v) ? `The session "${v}" already exists.` : undefined;
        },
    });
    if (!name) { return undefined; }
    // The file is written now, so the session shows everywhere at once; its conversation starts on first use.
    const created = createSession(folder, name, newSessionOptions(basedOn, how.mode, profilePick.choice, section as ProfileSection | undefined));
    if (!created.ok) {
        void vscode.window.showErrorMessage(created.error);
        return undefined;
    }
    return name;
}

// ---------------------------------------------------------------------------
// The chat panel's session, per quest
// ---------------------------------------------------------------------------

const CHAT_SESSION_STATE_KEY = 'tomAi.anthropicChatSession';

/** The session the Anthropic chat panel (and Send to Chat) sends in for `questId`; `fallback` (`chat`) when none was chosen. */
export function chatSessionFor(state: vscode.Memento, questId: string, fallback: string): string {
    const map = state.get<Record<string, string>>(CHAT_SESSION_STATE_KEY, {});
    return map[questId || 'default'] || fallback;
}

export async function setChatSessionFor(state: vscode.Memento, questId: string, name: string): Promise<void> {
    const map = { ...state.get<Record<string, string>>(CHAT_SESSION_STATE_KEY, {}) };
    if (name) { map[questId || 'default'] = name; } else { delete map[questId || 'default']; }
    await state.update(CHAT_SESSION_STATE_KEY, map);
}
