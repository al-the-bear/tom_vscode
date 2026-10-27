/**
 * Every entry point that works on a quest's per-session storage asks for the sessions and passes them on
 * (the handlers import vscode, so their source is read, as in queueSessionWiring.test.ts).
 *
 *   SW-1 the ANTHROPIC panel: clear, recreate history, recreate memory (confirmed), open history, live trail,
 *        summary trail and raw trail — each per chosen session; the cleared sessions are reported back
 *   SW-2 the status page: the compaction dry run per chosen session (its own rolling history) and the raw trail
 *   SW-3 the compaction-format migration command asks for the sessions; "All sessions" means every session
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
        const clear = caseBody(panel, 'clearAnthropicHistory');
        assert.match(clear, /_pickPanelSessions\('Clear session history', 'Clear history'\)/, 'destructive: confirmed');
        assert.match(clear, /for \(const name of names\) \{ AnthropicHandler\.instance\.clearSession\(name\); \}/);
        assert.match(clear, /type: 'anthropicHistoryCleared'/);
        const history = caseBody(panel, 'recreateHistoryFromTrail');
        assert.match(history, /_pickPanelSessions\('Recreate history from the trail', 'Recreate history'\)/);
        assert.match(history, /recreateHistoryFromTrail\(undefined, name\)/);
        const memory = caseBody(panel, 'recreateMemoryFromTrail');
        assert.match(memory, /_pickPanelSessions\('Recreate quest memory from the trail', 'Recreate memory'\)/);
        assert.match(memory, /recreateMemoryFromTrail\(undefined, name\)/);
        assert.match(caseBody(panel, 'openSessionHistory'), /_openSessionHistoryMarkdown\(name\)/);
        assert.match(caseBody(panel, 'openLiveTrail'), /_openLiveTrailMarkdown\('anthropic', name\)/);
        assert.match(caseBody(panel, 'openTrailRawFiles'), /sessionTrailFolder\(root, n\)/);
        assert.match(panel, /private async _openAnthropicSummaryTrail[\s\S]*?_pickPanelSessions\('Open the summary trail'\)/);
        const pick = panel.slice(panel.indexOf('private async _pickPanelSessions('));
        assert.match(pick, /current: this\._chatSessionKey\(\)/, "the panel's session preselected");
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

    test('SW-3: the migration command', () => {
        const ext = source('src', 'extension.ts');
        const cmd = ext.slice(ext.indexOf("'tomAi.migrate.compactionFormat'"), ext.indexOf("'tomAi.migrate.compactionFormat'") + 2000);
        assert.match(cmd, /pickSessionsOrAll\(/);
        assert.match(cmd, /sessions: picked\.all \? 'all' : picked\.sessions/);
    });

    test('SW-4: the memory panel', () => {
        const panel = source('src', 'handlers', 'memoryPanel-handler.ts');
        assert.match(panel, /case 'pickSession'/);
        for (const op of ['svc.listWithMeta(\'quest\')', 'TwoTierMemoryService.instance.read(scope, file)', 'TwoTierMemoryService.instance.write(scope, file, content)',
            'TwoTierMemoryService.instance.delete(scope, file)', 'TwoTierMemoryService.instance.filePath(scope, file)']) {
            assert.ok(panel.includes(`inPanelSession(() => ${op})`), `${op} runs in the panel's session`);
        }
        assert.match(source('media', 'memoryPanel', 'main.js'), /type: 'pickSession'/);
    });

    test('SW-5: the SESSIONS view', () => {
        const view = source('src', 'handlers', 'sessionsView-handler.ts');
        const del = view.slice(view.indexOf("case 'delete'"), view.indexOf("case 'delete'") + 1200);
        assert.match(del, /deleteSessionDetail\(quest, msg\.name\)/, 'the confirmation names what goes');
        assert.ok(del.indexOf('deleteSession(folder, msg.name)') < del.indexOf('removeSessionStorage('), 'the file first: a based-on session refuses');
        assert.match(del, /removeSessionStorage\(folder, TwoTierMemoryService\.instance\.memoryRoot\(\), quest, msg\.name\)/);
        const reset = view.slice(view.indexOf("case 'reset'"), view.indexOf("case 'delete'"));
        assert.match(reset, /AnthropicHandler\.instance\.clearSession\(msg\.name\)/);
        assert.doesNotMatch(reset, /removeSessionStorage/, 'Reset keeps trails and memory');
        assert.match(source('media', 'sessionsView', 'main.js'), /\(r\.hasFile && r\.hasConversation\) \|\| r\.usedBy/, 'default and chat can be reset');
    });
});
