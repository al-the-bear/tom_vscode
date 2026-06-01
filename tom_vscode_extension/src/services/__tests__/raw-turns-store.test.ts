/**
 * Tests for the rolling-tail rawTurns store.
 *
 * Coverage:
 *   - save + load round-trip
 *   - load returns `undefined` for a missing file
 *   - pushAndCap honours the ring-buffer cap (oldest rounds dropped)
 *   - rawTurnsKept = 0 means "keep nothing"
 *   - clear deletes the file
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// raw-turns-store.ts only depends on `fs` + `path`, but its
// `ConversationMessage` type import pulls the history-compaction
// module into the require graph (which imports vscode). Install the
// shared stub first.
import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import {
    clear,
    load,
    pushAndCap,
    rawTurnsPath,
    save,
    rawTurnsToRounds,
    roundsToRawTurns,
} from '../raw-turns-store.js';

const makeRound = (n: number) => [
    { role: 'user' as const, content: `user ${n}` },
    { role: 'assistant' as const, content: `assistant ${n}` },
];

describe('raw-turns-store.save / load', () => {
    test('round-trips rounds via disk', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-rt-'));
        try {
            const rounds = [makeRound(1), makeRound(2)];
            save(tmp, rounds);
            const loaded = load(tmp);
            assert.ok(loaded);
            assert.deepEqual(loaded!.rounds, rounds);
            assert.ok(typeof loaded!.savedAt === 'string' && loaded!.savedAt.length > 0);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('load returns undefined when the file is missing', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-rt-'));
        try {
            assert.equal(load(tmp), undefined);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

describe('raw-turns-store.pushAndCap (ring buffer)', () => {
    test('pushes and caps at rawTurnsKept', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-rt-'));
        try {
            // 5 pushes, cap = 3 → keep rounds 3, 4, 5 (in that order).
            for (let i = 1; i <= 5; i++) {
                pushAndCap(tmp, makeRound(i), 3);
            }
            const loaded = load(tmp);
            assert.ok(loaded);
            assert.equal(loaded!.rounds.length, 3);
            assert.equal(loaded!.rounds[0][0].content, 'user 3');
            assert.equal(loaded!.rounds[2][0].content, 'user 5');
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('rawTurnsKept = 0 keeps nothing', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-rt-'));
        try {
            pushAndCap(tmp, makeRound(1), 0);
            const loaded = load(tmp);
            assert.ok(loaded);
            assert.equal(loaded!.rounds.length, 0);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('clear deletes the file', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-rt-'));
        try {
            save(tmp, [makeRound(1)]);
            const file = rawTurnsPath(tmp);
            assert.equal(fs.existsSync(file), true);
            clear(tmp);
            assert.equal(fs.existsSync(file), false);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

describe('raw-turns-store flat ↔ rounds conversions', () => {
    test('rawTurnsToRounds drops a half-finished tail', () => {
        const flat = [
            { role: 'user' as const, content: 'u1' },
            { role: 'assistant' as const, content: 'a1' },
            { role: 'user' as const, content: 'u2 (no assistant yet)' },
        ];
        const rounds = rawTurnsToRounds(flat);
        assert.equal(rounds.length, 1);
        assert.equal(rounds[0][0].content, 'u1');
        assert.equal(rounds[0][1].content, 'a1');
    });

    test('roundsToRawTurns flattens preserving order', () => {
        const rounds = [makeRound(1), makeRound(2)];
        const flat = roundsToRawTurns(rounds);
        assert.equal(flat.length, 4);
        assert.equal(flat[0].content, 'user 1');
        assert.equal(flat[3].content, 'assistant 2');
    });
});
