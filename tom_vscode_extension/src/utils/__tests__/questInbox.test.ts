/**
 * The queue inbox (src/utils/questInbox.ts): how tomAi_sendItemToQuest reaches another quest's window.
 *
 *   QB-1 the file name: `<host>_<workspace>_<yymmdd_hhmmss>-<token>.inbox.queue.yaml`, under the prefix the
 *        target window's watcher matches; a temporary session's name `tmp-<yymmdd-hhmmss>-<token>`
 *   QB-2 the content round-trips: only what the sender said; a file without text, sender, or with a malformed
 *        session is refused
 *   QB-3 written atomically (no temporary file is left, none matches the inbox listing); listed per workspace
 *   QB-4 two windows claim the same file: exactly one gets it; the other finds it gone
 *   QB-5 a claim left by a stopped window is taken again once stale; a fresh one is not; an unreadable claim is
 *        set aside as `.rejected`
 *   QB-6 conversion: the target's defaults for what the sender left unset; a given profile means transport
 *        anthropic; ${senderQuest} filled in; an unknown profile or a missing session makes the item an error
 *   QB-7 a new session: refused without its base, or when the name is taken; named or temporary; its profile is
 *        the one given, else the base's (inherited), else the item's
 *   QB-8 a file written while no window ran is found by the listing a starting window makes
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    claimInboxFile,
    inboxFileName,
    inboxFilePrefix,
    listInboxFiles,
    listStaleClaims,
    parseInboxItem,
    planInboxConversion,
    rejectClaimedFile,
    serializeInboxItem,
    temporarySessionName,
    unclaimedName,
    writeInboxFile,
    type InboxItem,
} from '../questInbox.js';
import type { SessionRecord } from '../agentSdkSessions.js';

const FROM = { quest: 'tom_uam', windowId: 'abcd1234_ef567890', host: 'mbp', sentAt: '2026-10-27T12:00:00.000Z' };
const NOW = new Date(2026, 9, 27, 12, 34, 56);

function tempFolder(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'quest-inbox-'));
}

function sessions(...records: SessionRecord[]): (name: string) => SessionRecord | undefined {
    return (name) => records.find((r) => r.name === name);
}

describe('queue inbox', () => {
    test('QB-1: file names', () => {
        const name = inboxFileName('Alexiss-MacBook-Pro.local', 'vscode_extension', NOW, 'a1b2c3d4');
        assert.equal(name, 'alexiss-macbook-pro_local_vscode_extension_261027_123456-a1b2c3d4.inbox.queue.yaml');
        assert.ok(name.startsWith(inboxFilePrefix('Alexiss-MacBook-Pro.local', 'vscode_extension')), 'the watcher prefix');
        assert.equal(temporarySessionName(NOW, 'a1b2c3d4'), 'tmp-261027-123456-a1b2c3d4');
    });

    test('QB-2: content', () => {
        const full: InboxItem = {
            text: 'Do X for ${senderQuest}',
            template: 'execute-todo',
            anthropicProfileId: 'opus-5-5-direct',
            doneNotificationPrompt: 'Tell ${senderQuest}: ${itemOutcome}',
            pauseAfter: true,
            newSession: { basedOn: 'prep', name: 'walk', lifetime: 'per-prompt', profile: 'opus-5-5-agent-sdk-mm' },
            from: FROM,
        };
        assert.deepEqual(parseInboxItem(serializeInboxItem(full)), { ok: true, item: full });
        const minimal: InboxItem = { text: 'Hello', from: FROM };
        const yaml = serializeInboxItem(minimal);
        assert.deepEqual(parseInboxItem(yaml), { ok: true, item: minimal });
        assert.doesNotMatch(yaml, /template|profile|session|pause|notification/, 'nothing the sender did not say');
        assert.deepEqual(parseInboxItem(serializeInboxItem({ text: 'x', session: 'walk', from: FROM })),
            { ok: true, item: { text: 'x', session: 'walk', from: FROM } });
        for (const [content, why] of [
            ['inbox: 1\nfrom: {quest: a}\n', /no text/],
            ['text: x\n', /no sender quest/],
            ['text: x\nfrom: {quest: a}\nsession: "bad name"\n', /not a session name/],
            ['text: x\nfrom: {quest: a}\nsession: a\nnew-session: {based-on: b}\n', /both/],
            ['text: x\nfrom: {quest: a}\nnew-session: {name: n}\n', /based on/],
            ['text: x\nfrom: {quest: a}\nnew-session: {based-on: b, lifetime: sometimes}\n', /lifetime/],
            ['- a list\n', /not an inbox item/],
            [': : :\n', /not YAML|not an inbox item/],
        ] as Array<[string, RegExp]>) {
            const r = parseInboxItem(content);
            assert.equal(r.ok, false, content);
            assert.match((r as { error: string }).error, why);
        }
    });

    test('QB-3: written atomically, listed per workspace', () => {
        const folder = tempFolder();
        const mine = inboxFileName('mbp', 'vscode_extension', NOW, 't1');
        const other = inboxFileName('mbp', 'tom_uam', NOW, 't2');
        writeInboxFile(folder, mine, { text: 'a', from: FROM });
        writeInboxFile(folder, other, { text: 'b', from: FROM });
        fs.writeFileSync(path.join(folder, 'mbp_vscode_extension_261027_120000_vscode_extension.normal.entry.queue.yaml'), 'meta: {}\n');
        assert.deepEqual(fs.readdirSync(folder).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left');
        assert.deepEqual(listInboxFiles(folder, 'mbp', 'vscode_extension'), [mine]);
        assert.deepEqual(listInboxFiles(folder, 'mbp', 'tom_uam'), [other]);
        assert.deepEqual(listInboxFiles(folder, 'bomber', 'tom_uam'), [], 'another host');
        assert.deepEqual(listInboxFiles(path.join(folder, 'missing'), 'mbp', 'tom_uam'), [], 'no folder');
    });

    test('QB-4: two windows, one claim', () => {
        const folder = tempFolder();
        const file = inboxFileName('mbp', 'tom_uam', NOW, 't1');
        writeInboxFile(folder, file, { text: 'once', from: FROM });
        const first = claimInboxFile(folder, file, 'window-A');
        const second = claimInboxFile(folder, file, 'window-B');
        assert.ok(first && fs.existsSync(first), 'the first window has it');
        assert.equal(second, undefined, 'the second finds it gone');
        assert.equal(path.basename(first!), `${file}.claimed-window-a`);
        assert.equal(unclaimedName(path.basename(first!)), file);
        assert.deepEqual(listInboxFiles(folder, 'mbp', 'tom_uam'), [], 'a claimed file is no longer listed');
        assert.equal(parseInboxItem(fs.readFileSync(first!, 'utf-8')).ok, true);
    });

    test('QB-5: stale claims and rejected files', () => {
        const folder = tempFolder();
        const file = inboxFileName('mbp', 'tom_uam', NOW, 't1');
        writeInboxFile(folder, file, { text: 'x', from: FROM });
        const claimed = claimInboxFile(folder, file, 'stopped-window')!;
        const now = Date.now();
        assert.deepEqual(listStaleClaims(folder, 'mbp', 'tom_uam', now), [], 'a fresh claim is left alone');
        const old = new Date(now - 10 * 60_000);
        fs.utimesSync(claimed, old, old);
        const stale = listStaleClaims(folder, 'mbp', 'tom_uam', now);
        assert.deepEqual(stale, [path.basename(claimed)]);
        const retaken = claimInboxFile(folder, stale[0], 'new-window')!;
        assert.equal(path.basename(retaken), `${file}.claimed-new-window`, 'one claim mark, not two');
        assert.deepEqual(listStaleClaims(folder, 'mbp', 'tom_uam', Date.now()), [], 'fresh again after the re-claim');
        fs.writeFileSync(retaken, 'text: [unclosed\n');
        const aside = rejectClaimedFile(retaken);
        assert.equal(path.basename(aside), `${file}.rejected`);
        assert.deepEqual(listInboxFiles(folder, 'mbp', 'tom_uam'), [], 'a rejected file is not taken again');
        assert.deepEqual(listStaleClaims(folder, 'mbp', 'tom_uam', Date.now() + 3_600_000), []);
    });

    test('QB-6: conversion with the target defaults', () => {
        const ctx = { profileExists: (id: string) => id === 'opus-direct', readSession: sessions(), now: NOW, token: 't1' };
        assert.deepEqual(planInboxConversion({ text: 'Hi ${senderQuest}', from: FROM }, ctx), {
            enqueue: { originalText: 'Hi tom_uam', from: FROM },
        }, 'no transport, profile, session or template: the queue defaults apply');
        assert.deepEqual(planInboxConversion({
            text: 'x', template: 't', anthropicProfileId: 'opus-direct', pauseAfter: true,
            doneNotificationPrompt: 'back to ${senderQuest}: ${itemOutcome}', from: FROM,
        }, ctx).enqueue, {
            originalText: 'x', template: 't', transport: 'anthropic', anthropicProfileId: 'opus-direct', pauseAfter: true,
            doneNotificationPrompt: 'back to tom_uam: ${itemOutcome}', from: FROM,
        }, 'the sender fills in now; the outcome when the item is done');
        const noProfile = planInboxConversion({ text: 'x', anthropicProfileId: 'gone', from: FROM }, ctx);
        assert.match(noProfile.error ?? '', /no Anthropic profile "gone"/);
        const noSession = planInboxConversion({ text: 'x', session: 'walk', from: FROM }, ctx);
        assert.match(noSession.error ?? '', /no session "walk"/);
        assert.equal(noSession.enqueue.session, undefined);
        const withSession = planInboxConversion({ text: 'x', session: 'walk', from: FROM },
            { ...ctx, readSession: sessions({ name: 'walk', mode: 'continue' }) });
        assert.equal(withSession.enqueue.session, 'walk');
        assert.equal(withSession.createSession, undefined, 'an existing session is not created');
    });

    test('QB-7: a new session', () => {
        const base = (profileId?: string): SessionRecord => ({ name: 'prep', mode: 'continue', ...(profileId ? { profileId } : {}) });
        const ctx = (b: SessionRecord | undefined, ...more: SessionRecord[]) => ({
            profileExists: (id: string) => ['p-given', 'p-item'].includes(id),
            readSession: sessions(...[b, ...more].filter((r): r is SessionRecord => !!r)),
            now: NOW,
            token: 't1',
        });
        assert.match(planInboxConversion({ text: 'x', newSession: { basedOn: 'prep' }, from: FROM }, ctx(undefined)).error ?? '', /no session "prep" to base/);
        assert.match(planInboxConversion({ text: 'x', newSession: { basedOn: 'prep', name: 'walk' }, from: FROM },
            ctx(base(), { name: 'walk', mode: 'continue' })).error ?? '', /already exists/);
        assert.match(planInboxConversion({ text: 'x', newSession: { basedOn: 'prep', profile: 'nope' }, from: FROM }, ctx(base())).error ?? '', /no Anthropic profile/);

        const named = planInboxConversion({ text: 'x', newSession: { basedOn: 'prep', name: 'walk', lifetime: 'per-iteration', profile: 'p-given' }, from: FROM }, ctx(base('p-base')));
        assert.deepEqual(named.createSession, { name: 'walk', basedOn: 'prep', mode: 'per-iteration', profile: 'p-given', temporary: false }, 'the profile given');
        assert.equal(named.enqueue.session, 'walk');
        assert.equal(named.enqueue.temporarySession, undefined);

        const inherited = planInboxConversion({ text: 'x', anthropicProfileId: 'p-item', newSession: { basedOn: 'prep', name: 'walk' }, from: FROM }, ctx(base('p-base')));
        assert.equal(inherited.createSession?.profile, undefined, "the base's (createSession inherits it)");
        assert.equal(inherited.createSession?.mode, 'continue', 'the default lifetime');

        const fromItem = planInboxConversion({ text: 'x', anthropicProfileId: 'p-item', newSession: { basedOn: 'prep', name: 'walk' }, from: FROM }, ctx(base()));
        assert.equal(fromItem.createSession?.profile, 'p-item', "a base without one: the item's");

        const temporary = planInboxConversion({ text: 'x', newSession: { basedOn: 'prep' }, from: FROM }, ctx(base()));
        assert.equal(temporary.createSession?.name, 'tmp-261027-123456-t1');
        assert.equal(temporary.createSession?.temporary, true);
        assert.deepEqual([temporary.enqueue.session, temporary.enqueue.temporarySession], ['tmp-261027-123456-t1', true]);
    });

    test('QB-8: a file written while no window ran', () => {
        const folder = tempFolder();
        const file = inboxFileName('mbp', 'tom_uam', NOW, 't1');
        writeInboxFile(folder, file, { text: 'waiting', from: FROM });
        // A window of tom_uam starts later: its first take-up lists and claims it.
        const listed = listInboxFiles(folder, 'mbp', 'tom_uam');
        assert.deepEqual(listed, [file]);
        const claimed = claimInboxFile(folder, listed[0], 'starting-window');
        assert.ok(claimed);
        assert.deepEqual(parseInboxItem(fs.readFileSync(claimed!, 'utf-8')), { ok: true, item: { text: 'waiting', from: FROM } });
    });
});
