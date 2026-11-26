/**
 * The wiring of per-session storage. The handler, the trail service, the memory service and the live trail import
 * vscode, so their sources are read (as in directSessionHistory.test.ts DH-5).
 *
 *   SW-1 every trail write of the handler and the Agent SDK transport carries the session: the handler builds its
 *        subsystem from the current session, no bare ANTHROPIC_SUBSYSTEM is written, and the trail service resolves
 *        a session-carrying subsystem under the session's storage (raw trail, categories, summary pair)
 *   SW-2 a send selects its session's everything: history scope,
 *        tool trail (one per session, keys past the stored results, results in the session's folder); the live trail goes
 *        to the session; compaction and memory extraction run for the session
 *   SW-3 the compacted history is the quest's (read at every send; the session's old one in history/sessions/<s>/ until the quest has
 *        one); the session keeps its rolling tail and accumulator in its folder; Rebuild history and memory takes no
 *        session; nothing writes a session's compacted history
 *   SW-4 a based per-prompt session never clears its base's accumulator: only a session that writes its history
 *        builds, and its accumulator is cleared only after a successful build
 *   SW-5 the quest memory has no session level (`_ai/quests/<quest>/memory/`) and there is no shared memory: the
 *        memory service keeps no active session, the injection takes no session, a send hands its session to the
 *        extraction; the migration to per-session storage runs on first use of a quest's history
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
        assert.match(body(trail, 'private resolveSummaryFile('), /if \(subsystem\.type === 'anthropic' && subsystem\.session\) \{ return undefined; \}/, 'a session\'s turns go to the host trail only');
    });

    test('SW-2: a send selects its session', () => {
        const select = body(handler, 'private async selectHistoryScope(');
        assert.equal((select.match(/this\.activateSession\(name\)/g) ?? []).length, 2, 'the same scope again, or another one');
        const activate = body(handler, 'private activateSession(');
        assert.doesNotMatch(activate, /TwoTierMemoryService/, 'the memory service keeps no session');
        assert.match(activate, /this\.toolTrail = this\.toolTrailFor\(name\)/);
        assert.match(activate, /setActiveToolTrail\(this\.toolTrail\)/);
        const trails = body(handler, 'private toolTrailFor(');
        assert.match(trails, /firstFreeKeyIndex: \(\) => nextFreeToolResultIndex\(store\.toolResultFolder\('anthropic', WsPaths\.getWorkspaceQuestId\(\), name\)\)/);
        assert.match(trails, /store\.writeToolResult\('anthropic', entry, WsPaths\.getWorkspaceQuestId\(\), name\)/);
        assert.match(handler, /new LiveTrailWriter\(quest, undefined, this\.currentSessionName\(\)\)/);
        assert.ok((handler.match(/session: this\.currentSessionName\(\),/g) ?? []).length >= 2, 'the quest history build\'s compaction calls, the host trail\'s turn');
    });

    test('SW-3: the history is the quest\'s; the session keeps its tail', () => {
        const seed = body(handler, 'private seedHistoryFromSnapshot(');
        assert.match(seed, /this\.loadQuestHistory\(questId\)/, 'the quest\'s history');
        assert.match(seed, /loadLatestHistorySnapshotIn<unknown>\(this\.oldSessionHistoryFolder\(questId\)\)/, 'the session\'s old history.json, read only');
        assert.match(seed, /loadCompactionRoundsIn\(historyFolder\)/, 'the session\'s own accumulator');
        assert.match(seed, /this\.runQuestHistoryBuild\(questId, \{ extract: false \}\)/, 'no history yet: the first build');
        assert.doesNotMatch(seed, /shared/, 'no session is excluded');
        assert.match(body(handler, 'private loadQuestHistory('), /loadQuestHistoryBlocks\(questFolder, this\.oldSessionHistoryFolder\(questId\)\)/);
        assert.match(body(handler, 'async rebuildQuestHistoryAndMemory('), /this\.runQuestHistoryBuild\(quest, \{ extract: true \}\)/);
        assert.doesNotMatch(handler, /recreateHistoryFromTrail|recreateMemoryFromTrail|rebuildHistoryFromTrail|saveBlocksToDisk|persistSessionHistory/, 'nothing writes a session\'s compacted history');
        const panel = source('src', 'handlers', 'chatPanel-handler.ts');
        assert.match(panel, /case 'rebuildHistoryAndMemory':[\s\S]{0,800}handler\.rebuildQuestHistoryAndMemory\(\)/);
        assert.doesNotMatch(panel, /recreateHistoryFromTrail|recreateMemoryFromTrail/);
        const compaction = source('src', 'services', 'history-compaction.ts');
        assert.doesNotMatch(compaction, /loadLastNTrailExchanges|getSummaryFilePath/, 'no summary-pair reader');
    });

    test('SW-4: a based session never clears its base\'s accumulator', () => {
        const schedule = body(handler, 'private scheduleBackgroundCompactionAndExtraction(');
        assert.match(schedule, /if \(!this\.persistsHistory\) \{ return; \}/, 'a per-prompt session (its base\'s folder) never builds or clears');
        assert.match(schedule, /const folder = this\.scopeFolder\(questId\);/);
        assert.match(schedule, /if \(!report \|\| report\.failed\) \{ return; \}\s*\/\/[^\n]*\n\s*this\.compactionRounds = \[\];\s*saveCompactionRoundsIn\(\[\], folder\);/, 'cleared only after a successful build');
    });

    test('SW-5: the quest memory has no session level', () => {
        const folder = body(memory, 'scopeFolder(_scope: MemoryScope');
        assert.doesNotMatch(folder, /'shared'/, 'no shared memory');
        assert.match(memory, /export type MemoryScope = 'quest';/);
        assert.doesNotMatch(body(memory, 'injectForSystemPrompt('), /'shared'/, 'the injection reads the quest memory only');
        assert.match(folder, /WsPaths\.ai\('quests', quest, 'memory'\)/, 'the quest folder\'s memory/');
        assert.doesNotMatch(folder, /session/i, 'no session in the folder');
        assert.doesNotMatch(memory, /setActiveSession|withSession|_activeSession/, 'no active session in the memory service');
        for (const file of ['src/handlers/anthropic-handler.ts', 'src/handlers/memoryPanel-handler.ts', 'src/tools/tool-executors.ts', 'src/tools/memory-tools.ts']) {
            assert.doesNotMatch(source(...file.split('/')), /setActiveSession|withSession\(|\.activeSession\b/, `${file} names no memory session`);
        }
        // The injection takes no session: the quest memory has no session level.
        assert.doesNotMatch(handler, /memorySession/);
        assert.match(source('src', 'utils', 'variableResolver.ts'), /svc\.injectForSystemPrompt\(budgetTokens, quest \|\| undefined, memorySuffix\)/);
        assert.doesNotMatch(memory, /ensureSessionStorage|migrateQuestToSessionStorage/, 'no runtime storage migration: the format migration ran before');
        // Both extraction call sites write candidates, never a curated file.
        const compaction = source('src', 'services', 'history-compaction.ts');
        assert.equal((compaction.match(/memorySvc\.addCandidates\(extracted, \{ session: (options|params)\.session, targetFile: tpl\.targetFile \}, (options|params)\.questId\)/g) ?? []).length, 2);
        assert.equal((compaction.match(/memorySvc\.existingMemoryForExtraction\(tpl\.targetFile, (options|params)\.questId\)/g) ?? []).length, 2);
        assert.doesNotMatch(compaction, /memorySvc\.(prepend|append|write)\(/, 'no curated file is written by the extraction');
    });

    test('SW-6: removal and clearing', () => {
        const queue = source('src', 'managers', 'promptQueueManager.ts');
        assert.match(body(queue, 'private _deleteTemporarySession('), /removeSessionStorage\(folder, name\)/);
        assert.match(body(handler, 'clearSession(sessionKey'), /this\.toolTrailFor\(sessionKey\)\.clear\(\)/);
    });
});
