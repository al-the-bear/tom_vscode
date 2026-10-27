/**
 * The wiring of per-session storage. The handler, the trail service, the memory service and the live trail import
 * vscode, so their sources are read (as in directSessionHistory.test.ts DH-5).
 *
 *   SW-1 every trail write of the handler and the Agent SDK transport carries the session: the handler builds its
 *        subsystem from the current session, no bare ANTHROPIC_SUBSYSTEM is written, and the trail service resolves
 *        a session-carrying subsystem under the session's storage (raw trail, categories, summary pair)
 *   SW-2 a send selects its session's everything: history scope, quest memory (the memory service's active session),
 *        tool trail (one per session, keys past the stored results, results in the session's folder); the live trail
 *        and the current-prompt copy go to the session; compaction and memory extraction run for the session
 *   SW-3 snapshots are read back per session (from the scope's folder), and every session may rebuild from its own
 *        trail; recreate history / memory take the session (the panel passes its own)
 *   SW-4 a based per-prompt session never clears its base's accumulator: the compaction clears the file only when the
 *        session writes its history (before the fix it cleared the scope folder — the base's — unconditionally)
 *   SW-5 quest memory is per session (`_ai/memory/<quest>/<session>/`), shared stays one; the migration runs on first
 *        use of a quest; a Local LLM memory bucket reads the `default` session's
 *   SW-6 a temporary session's whole storage is removed with it; clearing a session clears that session's tool trail
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** out/services/__tests__ -> project root is three levels up. */
function source(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', ...parts), 'utf-8');
}

function body(src: string, signature: string): string {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found`);
    return src.slice(start, src.indexOf('\n    }\n', start));
}

describe('per-session storage wiring', () => {
    const handler = source('src', 'handlers', 'anthropic-handler.ts');
    const transport = source('src', 'handlers', 'agent-sdk-transport.ts');
    const trail = source('src', 'services', 'trailService.ts');
    const memory = source('src', 'services', 'memory-service.ts');

    test('SW-1: trails per session', () => {
        assert.match(body(handler, 'private trailSubsystem('), /session: this\.currentSessionName\(\)/);
        const bare = handler.split('\n').filter((l) => /ANTHROPIC_SUBSYSTEM/.test(l) && !/^import|\.\.\.ANTHROPIC_SUBSYSTEM/.test(l.trim()));
        assert.deepEqual(bare, [], 'no trail write without the session');
        assert.match(handler, /trailSubsystem: this\.trailSubsystem\(\),/, 'the Agent SDK transport gets the session\'s subsystem');
        const transportWrites = transport.split('\n').filter((l) => l.trim().startsWith('ANTHROPIC_SUBSYSTEM') || l.trim().endsWith('trailSubsystem ?? ANTHROPIC_SUBSYSTEM,'));
        assert.ok(transportWrites.length >= 6 && transportWrites.every((l) => l.includes('trailSubsystem ??')), 'every transport write');
        assert.match(body(trail, 'getSubsystemPath('), /sessionTrailFolder\(questHistoryRoot\(quest\), subsystem\.session, subsystem\.category\)/);
        assert.match(body(trail, 'private resolveSummaryFile('), /sessionSummaryFile\(questHistoryRoot\(quest\), subsystem\.session, quest, 'anthropic', kind\)/);
    });

    test('SW-2: a send selects its session', () => {
        const select = body(handler, 'private async selectHistoryScope(');
        assert.equal((select.match(/this\.activateSession\(name\)/g) ?? []).length, 2, 'the same scope again, or another one');
        const activate = body(handler, 'private activateSession(');
        assert.match(activate, /TwoTierMemoryService\.instance\.setActiveSession\(name\)/);
        assert.match(activate, /this\.toolTrail = this\.toolTrailFor\(name\)/);
        assert.match(activate, /setActiveToolTrail\(this\.toolTrail\)/);
        const trails = body(handler, 'private toolTrailFor(');
        assert.match(trails, /firstFreeKeyIndex: \(\) => nextFreeToolResultIndex\(store\.toolResultFolder\('anthropic', WsPaths\.getWorkspaceQuestId\(\), name\)\)/);
        assert.match(trails, /store\.writeToolResult\('anthropic', entry, WsPaths\.getWorkspaceQuestId\(\), name\)/);
        assert.match(handler, /new LiveTrailWriter\(quest, undefined, this\.currentSessionName\(\)\)/);
        assert.match(handler, /session: options\.isolated \? undefined : this\.currentSessionName\(\),/, 'the current-prompt copy');
        assert.ok((handler.match(/session: this\.currentSessionName\(\),/g) ?? []).length >= 4, 'compaction, memory extraction, rebuild, current prompt');
    });

    test('SW-3: snapshots and rebuilds per session', () => {
        const seed = body(handler, 'private seedHistoryFromSnapshot(');
        assert.match(seed, /loadLatestHistorySnapshotIn<unknown>\(historyFolder\)/);
        assert.doesNotMatch(seed, /shared/, 'no session is excluded from its own snapshot or rebuild');
        assert.match(body(handler, 'private async rebuildHistoryFromTrail('), /loadLastNTrailExchanges\(questId, limit, this\.currentSessionName\(\)\)/);
        assert.match(body(handler, 'async recreateHistoryFromTrail('), /resolveHistoryScope\(quest, TwoTierMemoryService\.instance\.historyFolder\(quest\), sessionKey\)/);
        assert.match(body(handler, 'async recreateMemoryFromTrail('), /loadLastNTrailExchanges\(quest, limit, sessionKey\)/);
        const panel = source('src', 'handlers', 'chatPanel-handler.ts');
        assert.match(panel, /recreateHistoryFromTrail\(undefined, this\._chatSessionKey\(\)\)/);
        assert.match(panel, /recreateMemoryFromTrail\(undefined, this\._chatSessionKey\(\)\)/);
        const compaction = source('src', 'services', 'history-compaction.ts');
        assert.match(body(compaction, 'export function loadLastNTrailExchanges('), /\.\.\.\(session \? \{ session \} : \{\}\)/);
    });

    test('SW-4: a based session never clears its base\'s accumulator', () => {
        const at = handler.indexOf('// Compaction succeeded');
        const block = handler.slice(at, handler.indexOf('this.persistSessionHistory(questId);', at));
        assert.match(block, /if \(this\.persistsHistory\) \{\s*saveCompactionRoundsIn\(\[\], this\.scopeFolder\(questId\)\);\s*\}/);
    });

    test('SW-5: memory per session', () => {
        const folder = body(memory, 'scopeFolder(scope: MemoryScope');
        assert.match(folder, /path\.join\(this\.memoryRoot\(\), 'shared'\)/, 'shared stays one');
        assert.match(folder, /sessionMemoryFolder\(this\.memoryRoot\(\), quest, session \|\| this\._activeSession\)/);
        assert.match(folder, /this\.ensureSessionStorage\(quest\)/);
        assert.match(body(memory, 'historyFolder(questId?: string): string {'), /this\.ensureSessionStorage\(quest\)/);
        assert.match(body(memory, 'ensureSessionStorage(questId?: string): void {'), /migrateQuestToSessionStorage\(/);
        assert.match(body(memory, 'injectForSystemPrompt('), /if \(suffix && this\._activeSession !== MIGRATION_TARGET_SESSION\)/);
    });

    test('SW-6: removal and clearing', () => {
        const queue = source('src', 'managers', 'promptQueueManager.ts');
        assert.match(body(queue, 'private _deleteTemporarySession('), /removeSessionStorage\(folder, TwoTierMemoryService\.instance\.memoryRoot\(\)/);
        assert.match(body(handler, 'clearSession(sessionKey'), /this\.toolTrailFor\(sessionKey\)\.clear\(\)/);
    });
});
