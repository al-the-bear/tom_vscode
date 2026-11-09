/**
 * The per-slot Keep flags of the @CHAT prompt pages (services/chatDraftService.ts).
 *
 *   DK-1 normalizeSlotKeep keeps slots "1"–"9" with boolean values and drops everything else
 *   DK-2 save and load carry slotKeep through the prompt-panel file: a reload restores each slot's flag
 */

/* eslint-disable @typescript-eslint/naming-convention -- prompt slots "1"-"9" are the keys the drafts store */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-draft-keep-')));
fs.mkdirSync(path.join(WS, '.tom'), { recursive: true });
fs.writeFileSync(path.join(WS, '.tom', 'tom_vscode_extension.json'), '{}\n');

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const stub = installVscodeStub({ workspaceFolders: [WS] });

import { loadChatDrafts, normalizeSlotKeep, saveChatDrafts } from '../chatDraftService.js';

after(() => {
    stub.restore();
    fs.rmSync(WS, { recursive: true, force: true });
});

describe('Keep per prompt slot', () => {
    test('DK-1: what is stored', () => {
        assert.deepEqual(normalizeSlotKeep({ '1': false, '2': true, '0': false, '10': true, x: false, '3': 'no' }), { '1': false, '2': true });
        assert.deepEqual(normalizeSlotKeep(undefined), {});
        assert.deepEqual(normalizeSlotKeep('nope'), {});
    });

    test('DK-2: saved and loaded with the drafts', async () => {
        await saveChatDrafts({ anthropic: { text: 't', activeSlot: 2, slots: { '2': 't' }, slotKeep: { '2': false, '5': true } } });
        const loaded = await loadChatDrafts();
        assert.deepEqual(loaded.anthropic?.slotKeep, { '2': false, '5': true });
        assert.equal(loaded.anthropic?.activeSlot, 2);
    });
});
