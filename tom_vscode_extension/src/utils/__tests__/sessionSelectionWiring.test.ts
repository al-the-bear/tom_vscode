/**
 * Every entry point that works on a quest's per-session storage asks for the sessions and passes them on
 * (the handlers import vscode, so their source is read, as in queueSessionWiring.test.ts).
 *
 *   SW-1 the ANTHROPIC panel: clear (confirmed), open history, live trail, summary trail and raw trail — each per
 *        chosen session; the cleared sessions are reported back; Rebuild history and memory takes no session (the
 *        history is the quest's)
 *   SW-2 the status page: the compaction dry run per chosen session (its own rolling history) and the raw trail
 *   SW-4 the memory panel works in its chosen session
 *   SW-5 the SESSIONS view: Delete removes the session's whole storage; Reset clears its conversation
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function source(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', ...parts), 'utf-8');
}

/** The text of a `case '<name>'` up to the next case. */
function caseBody(src: string, name: string): string {
    const start = src.indexOf(`case '${name}'`);
    assert.ok(start >= 0, `case '${name}' not found`);
    const next = src.indexOf("\n                    case '", start + 10);
    return src.slice(start, next < 0 ? undefined : next);
}

describe('session selection wiring', () => {
    test('SW-1: the ANTHROPIC panel', () => {
        const panel = source('src', 'handlers', 'chatPanel-handler.ts');
        // The per-session actions run from the @CHAT Logs panel for its selected session (runSessionAction).
        const actions = panel.slice(panel.indexOf('async runSessionAction('), panel.indexOf('private async _pickPanelSessions('));
        assert.match(actions, /case 'clearHistory':[\s\S]{0,400}\{ modal: true \}[\s\S]{0,200}this\._clearSessions\(names\)/, 'destructive: confirmed');
        assert.match(actions, /for \(const name of names\) \{ AnthropicHandler\.instance\.clearSession\(name\); \}/);
        assert.match(actions, /type: 'anthropicHistoryCleared'/);
        // The history is the quest's: Rebuild history and memory picks no session.
        const rebuild = caseBody(panel, 'rebuildHistoryAndMemory');
        assert.doesNotMatch(rebuild, /_pickPanelSessions/);
        assert.match(rebuild, /handler\.rebuildQuestHistoryAndMemory\(\)/);
        assert.match(actions, /case 'history':[\s\S]{0,120}_openSessionHistoryMarkdown\(name\)/);
        assert.match(actions, /case 'liveTrail':[\s\S]{0,120}_openLiveTrailMarkdown\('anthropic', name\)/);
        assert.match(actions, /case 'rawTrail':[\s\S]{0,400}sessionTrailFolder\(root, n\)/);
        assert.match(panel, /private async _openAnthropicSummaryTrail[\s\S]*?_pickPanelSessions\('Open the summary trail'\)/);
        const pick = panel.slice(panel.indexOf('private async _pickPanelSessions('));
        assert.match(pick, /current: this\._(chatSessionKey|panelSession)\(\)/, "the panel's session preselected (in the panel's run)");
        const webview = source('media', 'chatPanel', 'main.js');
        assert.match(webview, /msg\.type === 'anthropicHistoryCleared'/);
        assert.doesNotMatch(webview, /case 'clearAnthropicHistory':[^\n]*setAnthropicStatus/, 'no "cleared" before the choice');
    });

    test('SW-2: the status page', () => {
        const page = source('src', 'handlers', 'statusPage-handler.ts');
        const dry = page.slice(page.indexOf('async function runCompactionDryRun('), page.indexOf('async function runCompactionDryRunFor('));
        assert.match(dry, /pickSessions\(quest, \{/);
        assert.match(dry, /runCompactionDryRunFor\(session, mode, settings, \(loadRawTurns\(sessionRoot\(historyRoot, session\)\)/);
        const viewer = page.slice(page.indexOf("case 'openTrailViewer'"), page.indexOf("case 'openTimedRequestsEditor'"));
        assert.match(viewer, /pickSessions\(/);
        assert.match(viewer, /sessionTrailFolder\(historyRoot, n\)/);
    });

    test('SW-4: the memory panel has no session choice', () => {
        // The quest memory has no session level: the panel works on the quest's memory folder.
        const panel = source('src', 'handlers', 'memoryPanel-handler.ts');
        assert.doesNotMatch(panel, /pickSession|inPanelSession|_session\b/);
        for (const op of ['svc.listWithMeta(\'quest\')', 'TwoTierMemoryService.instance.read(scope, file)', 'TwoTierMemoryService.instance.write(scope, file, content)',
            'TwoTierMemoryService.instance.delete(scope, file)', 'TwoTierMemoryService.instance.filePath(scope, file)']) {
            assert.ok(panel.includes(op), `${op} on the quest's memory folder`);
        }
        assert.doesNotMatch(source('media', 'memoryPanel', 'main.js'), /pickSession|btn-session/);
        assert.doesNotMatch(source('media', 'memoryPanel', 'index.html'), /btn-session/);
    });

    test('SW-5: the SESSIONS view', () => {
        const view = source('src', 'handlers', 'sessionsView-handler.ts');
        const del = view.slice(view.indexOf("case 'delete'"), view.indexOf("case 'delete'") + 1200);
        assert.match(del, /deleteSessionDetail\(quest, msg\.name, open\)/, 'the confirmation names what goes, the open session todos included');
        assert.ok(del.indexOf('deleteSession(folder, msg.name)') < del.indexOf('removeSessionStorage('), 'the file first: a based-on session refuses');
        assert.match(del, /removeSessionStorage\(folder, msg\.name\)/);
        const reset = view.slice(view.indexOf("case 'reset'"), view.indexOf("case 'delete'"));
        assert.match(reset, /AnthropicHandler\.instance\.clearSession\(msg\.name\)/);
        assert.doesNotMatch(reset, /removeSessionStorage/, 'Reset keeps trails and memory');
        assert.match(source('media', 'sessionsView', 'main.js'), /\(r\.hasFile && r\.hasConversation\) \|\| r\.usedBy/, 'default and chat can be reset');
    });
});
