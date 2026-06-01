/**
 * End-to-end test for the compaction-format migration command.
 *
 * Coverage:
 *   - A fixture quest folder containing a legacy `history.json` +
 *     `history.md` migrates to `compacted_history.md` + `rawTurns.json`,
 *     and the legacy files are removed.
 *   - A fixture memory folder containing legacy bullet lines (no
 *     timestamp prefix) is rewritten with each bullet stamped at the
 *     file's mtime + `[legacy]` host.
 *   - A second invocation on the post-migration state is a no-op
 *     (idempotent).
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

function setupFixture(): { wsRoot: string; questHistoryFolder: string; questMemoryFile: string } {
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-migrate-ws-'));
    const aiRoot = path.join(wsRoot, '_ai');
    const quest = 'demo_quest';
    const questHistoryFolder = path.join(aiRoot, 'quests', quest, 'history');
    fs.mkdirSync(questHistoryFolder, { recursive: true });
    // Legacy history.json — one compacted summary + 4 rawTurns (2 rounds).
    const legacyPayload = {
        messages: {
            compactedSummary: 'Distilled state from session — preserved by migration as a single block.',
            rawTurns: [
                { role: 'user', content: 'u1' },
                { role: 'assistant', content: 'a1' },
                { role: 'user', content: 'u2' },
                { role: 'assistant', content: 'a2' },
            ],
        },
        savedAt: '2026-05-30T12:00:00.000Z',
    };
    fs.writeFileSync(
        path.join(questHistoryFolder, 'history.json'),
        JSON.stringify(legacyPayload, null, 2),
        'utf-8',
    );
    fs.writeFileSync(
        path.join(questHistoryFolder, 'history.md'),
        '# legacy markdown render — should be deleted by migration\n',
        'utf-8',
    );

    // Legacy memory file — bullets without timestamps + a heading.
    const memoryFolder = path.join(aiRoot, 'memory', quest);
    fs.mkdirSync(memoryFolder, { recursive: true });
    const questMemoryFile = path.join(memoryFolder, 'facts.md');
    fs.writeFileSync(
        questMemoryFile,
        '## Old heading\n\n- User prefers terse commits.\n- Workspace uses tom_build_base for CLI tools.\n',
        'utf-8',
    );
    // Force a specific mtime so the [legacy] entries are deterministic.
    const legacyMtime = new Date('2026-04-15T00:00:00.000Z');
    fs.utimesSync(questMemoryFile, legacyMtime, legacyMtime);

    return { wsRoot, questHistoryFolder, questMemoryFile };
}

describe('migrateCompactionFormat — end-to-end', () => {
    test('migrates legacy history + legacy memory files', async () => {
        const { wsRoot, questHistoryFolder, questMemoryFile } = setupFixture();
        try {
            // Install a vscode stub that exposes the fixture as the
            // single workspace folder. The migration command reads
            // `vscode.workspace.workspaceFolders[0].uri.fsPath`.
            installVscodeStub({ workspaceFolders: [wsRoot] });

            const { migrateCompactionFormat } = await import('../compaction-migration.js');
            const report = migrateCompactionFormat();

            assert.equal(report.questsMigrated, 1);
            assert.equal(report.memoryFilesMigrated, 1);
            assert.equal(report.questsFailed, 0);
            assert.equal(report.memoryFilesFailed, 0);

            // history.json + history.md gone; compacted_history.md +
            // rawTurns.json present.
            assert.equal(fs.existsSync(path.join(questHistoryFolder, 'history.json')), false);
            assert.equal(fs.existsSync(path.join(questHistoryFolder, 'history.md')), false);
            assert.equal(fs.existsSync(path.join(questHistoryFolder, 'compacted_history.md')), true);
            assert.equal(fs.existsSync(path.join(questHistoryFolder, 'rawTurns.json')), true);

            // The block file should contain a single block matching the legacy summary.
            const blockText = fs.readFileSync(path.join(questHistoryFolder, 'compacted_history.md'), 'utf-8');
            assert.match(blockText, /<!-- tom:block created="2026-05-30T12:00:00\.000Z" modified="2026-05-30T12:00:00\.000Z" -->/);
            assert.match(blockText, /Distilled state from session/);

            // Memory file rewritten with stamped entries.
            const memBody = fs.readFileSync(questMemoryFile, 'utf-8');
            assert.match(memBody, /^- 2026-04-15T00:00:00\.000Z \[legacy\] User prefers terse commits\.$/m);
            assert.match(memBody, /^- 2026-04-15T00:00:00\.000Z \[legacy\] Workspace uses tom_build_base for CLI tools\.$/m);
            assert.equal(memBody.includes('## Old heading'), false);
        } finally {
            fs.rmSync(wsRoot, { recursive: true, force: true });
        }
    });

    test('idempotent — second pass is a no-op', async () => {
        const { wsRoot, questHistoryFolder, questMemoryFile } = setupFixture();
        try {
            installVscodeStub({ workspaceFolders: [wsRoot] });

            const { migrateCompactionFormat } = await import('../compaction-migration.js');
            migrateCompactionFormat();

            const blockBefore = fs.readFileSync(path.join(questHistoryFolder, 'compacted_history.md'), 'utf-8');
            const memBefore = fs.readFileSync(questMemoryFile, 'utf-8');

            const report = migrateCompactionFormat();
            assert.equal(report.questsMigrated, 0);
            assert.equal(report.questsAlreadyCurrent, 1);
            assert.equal(report.memoryFilesMigrated, 0);
            assert.equal(report.memoryFilesAlreadyCurrent, 1);

            const blockAfter = fs.readFileSync(path.join(questHistoryFolder, 'compacted_history.md'), 'utf-8');
            const memAfter = fs.readFileSync(questMemoryFile, 'utf-8');
            assert.equal(blockAfter, blockBefore);
            assert.equal(memAfter, memBefore);
        } finally {
            fs.rmSync(wsRoot, { recursive: true, force: true });
        }
    });
});
