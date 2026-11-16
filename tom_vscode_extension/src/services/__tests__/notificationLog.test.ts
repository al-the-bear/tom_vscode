/**
 * The machine's notification log (vscimpb124, src/services/notificationLog.ts).
 *
 *   NL-1 appended events read back in order; a line cut by a crash is left out
 *   NL-2 the cap: over cap + slack the log is cut to the last `cap`
 *   NL-3 concurrent writers: four processes appending at once lose no event and break no line
 *   NL-4 a lock left by a writer that died is taken over
 *   NL-5 emitNotifications fills in id, time, window, quest, run and who from the context (an event's own who and
 *        run win); without a configured log nothing is written
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

import {
    appendNotificationEvents, configureNotificationLog, emitNotifications, readNotificationEvents,
} from '../notificationLog.js';
import type { NotificationEvent } from '../../utils/notificationEvents.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const dir = fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261116_vscimpb124_log-'));
after(() => { configureNotificationLog(undefined, undefined); fs.rmSync(dir, { recursive: true, force: true }); });

const event = (id: string): NotificationEvent => ({
    id, type: 'itemQueued', at: new Date().toISOString(), windowId: 'w', quest: 'q', run: 'default', who: { kind: 'user' },
    item: { id, run: 'default', kind: 'normal', preview: id },
});

describe('the notification log', () => {
    test('NL-1: append and read', () => {
        const file = path.join(dir, 'nl1', 'events.jsonl');
        appendNotificationEvents(file, [event('a'), event('b')]);
        fs.appendFileSync(file, '{"cut by a cra');
        fs.appendFileSync(file, '\n');
        appendNotificationEvents(file, [event('c')]);
        assert.deepEqual(readNotificationEvents(file).map((e) => e.id), ['a', 'b', 'c']);
        assert.deepEqual(readNotificationEvents(path.join(dir, 'missing.jsonl')), []);
    });

    test('NL-2: the cap', () => {
        const file = path.join(dir, 'nl2.jsonl');
        for (let i = 0; i < 12; i++) { appendNotificationEvents(file, [event(`e${i}`)], { cap: 10, slack: 2 }); }
        assert.equal(readNotificationEvents(file).length, 12, 'cap + slack: not cut yet');
        appendNotificationEvents(file, [event('e12')], { cap: 10, slack: 2 });
        assert.deepEqual(readNotificationEvents(file).map((e) => e.id), ['e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10', 'e11', 'e12']);
        assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock is released');
    });

    test('NL-3: concurrent writers', async () => {
        const file = path.join(dir, 'nl3.jsonl');
        const mod = path.join(EXT_ROOT, 'out', 'services', 'notificationLog.js');
        const script = (w: number): string => `
            const l = require(${JSON.stringify(mod)});
            for (let i = 0; i < 40; i++) {
                l.appendNotificationEvents(${JSON.stringify(file)}, [{ id: 'w${w}-' + i, type: 'todoCreated', at: new Date().toISOString(),
                    windowId: 'w${w}', quest: 'q', run: 'default', who: { kind: 'user' }, todo: { id: 't' + i, quest: 'q', fields: [] } }], { cap: 100000 });
            }`;
        await Promise.all([1, 2, 3, 4].map((w) => new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', script(w)], { stdio: 'inherit' });
            child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${w} exited ${code}`))));
        })));
        const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
        assert.equal(lines.length, 160, 'no event lost');
        assert.equal(readNotificationEvents(file).length, 160, 'no line broken');
        for (const w of [1, 2, 3, 4]) {
            const ids = readNotificationEvents(file).filter((e) => e.windowId === `w${w}`).map((e) => e.id);
            assert.deepEqual(ids, Array.from({ length: 40 }, (_, i) => `w${w}-${i}`), `writer ${w} in order`);
        }
    });

    test('NL-4: a stale lock is taken over', () => {
        const file = path.join(dir, 'nl4.jsonl');
        fs.mkdirSync(`${file}.lock`);
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(`${file}.lock`, old, old);
        appendNotificationEvents(file, [event('x')]);
        assert.deepEqual(readNotificationEvents(file).map((e) => e.id), ['x']);
    });

    test('NL-5: emit fills in the context', () => {
        const file = path.join(dir, 'nl5.jsonl');
        emitNotifications([{ type: 'todoCreated', todo: { id: 't', quest: 'q', fields: [] } }]);
        assert.equal(fs.existsSync(file), false, 'no log configured: nothing written');
        configureNotificationLog(file, { windowId: 'win1', quest: () => 'vscode_extension', run: () => 'another', who: () => ({ kind: 'agent', session: 'default@another' }) });
        emitNotifications([
            { type: 'todoCreated', todo: { id: 't', quest: 'q', fields: [] } },
            { type: 'itemDeleted', run: 'collab', who: { kind: 'extension', label: 'x' }, item: { id: 'i', run: 'collab', kind: 'normal', preview: 'p' } },
        ]);
        const [a, b] = readNotificationEvents(file);
        assert.equal(a.windowId, 'win1');
        assert.equal(a.quest, 'vscode_extension');
        assert.equal(a.run, 'another');
        assert.deepEqual(a.who, { kind: 'agent', session: 'default@another' });
        assert.ok(a.id && a.id !== b.id && !Number.isNaN(Date.parse(a.at)));
        assert.equal(b.run, 'collab');
        assert.deepEqual(b.who, { kind: 'extension', label: 'x' });
    });
});
