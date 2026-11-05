/**
 * The `_ai` format migration's step for the Telegram settings nothing reads
 * (src/utils/aiFormatMigration.ts, format version 7).
 *
 *   TN-1 notifyOnStart / notifyOnTurn / notifyOnEnd / includeResponseText / maxResponseChars leave the
 *        `telegram` section of every quest's extension_config.<quest>.yaml; the other Telegram keys, the other
 *        sections, the comments and the order stay; the host file is not touched
 *   TN-2 a dry run writes nothing; a second run lists nothing; a quest without the keys, or without the file,
 *        lists nothing
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { migrateAiFormats, REMOVED_TELEGRAM_KEYS } from '../aiFormatMigration.js';

const QUEST_FILE = `# quest settings
mcpServer:
  enabled: true
telegram:
  allowedUserIds:
  - 279417862
  defaultChatId: 279417862 # my chat
  notifyOnTurn: true
  notifyOnStart: true
  notifyOnEnd: true
  includeResponseText: false
  maxResponseChars: 500
  pollIntervalMs: 3000
`;

const MIGRATED = `# quest settings
mcpServer:
  enabled: true
telegram:
  allowedUserIds:
  - 279417862
  defaultChatId: 279417862 # my chat
  pollIntervalMs: 3000
`;

function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-settings-migration-'));
    const ai = path.join(root, '_ai');
    const questFile = (quest: string) => path.join(ai, 'quests', quest, `extension_config.${quest}.yaml`);
    for (const quest of ['qa', 'qb', 'qc']) { fs.mkdirSync(path.join(ai, 'quests', quest), { recursive: true }); }
    fs.writeFileSync(questFile('qa'), QUEST_FILE);
    fs.writeFileSync(questFile('qb'), 'telegram:\n  defaultChatId: 1\n');
    const hostFile = path.join(ai, 'quests', 'qa', 'extension_config.mbp.qa.yaml');
    fs.writeFileSync(hostFile, 'telegram:\n  enabled: true\n  notifyOnTurn: true\n');
    const run = (apply: boolean) => migrateAiFormats({ aiRoot: ai, hostSlug: 'mbp', apply, merge: () => undefined, today: '2026-11-06' });
    return { questFile, hostFile, run };
}

describe('removed Telegram settings', () => {
    test('TN-1: the five keys leave the quest file, the rest stays', () => {
        assert.deepEqual([...REMOVED_TELEGRAM_KEYS].sort(), ['includeResponseText', 'maxResponseChars', 'notifyOnEnd', 'notifyOnStart', 'notifyOnTurn']);
        const s = sandbox();
        s.run(true);
        assert.equal(fs.readFileSync(s.questFile('qa'), 'utf8'), MIGRATED);
        assert.equal(fs.readFileSync(s.hostFile, 'utf8'), 'telegram:\n  enabled: true\n  notifyOnTurn: true\n', 'the host file is not the step\'s');
        assert.equal(fs.readFileSync(s.questFile('qb'), 'utf8'), 'telegram:\n  defaultChatId: 1\n');
    });

    test('TN-2: dry run, second run, quests without the keys', () => {
        const s = sandbox();
        const listed = s.run(false).changes.filter((c) => c.step === 'telegram-settings');
        assert.deepEqual(listed.map((c) => c.quest), ['qa'], 'only the quest that has them');
        assert.match(listed[0].detail, /notifyOnTurn, notifyOnStart, notifyOnEnd, includeResponseText, maxResponseChars/);
        assert.equal(fs.readFileSync(s.questFile('qa'), 'utf8'), QUEST_FILE, 'a dry run writes nothing');
        s.run(true);
        assert.deepEqual(s.run(false).changes.filter((c) => c.step === 'telegram-settings'), []);
    });
});
