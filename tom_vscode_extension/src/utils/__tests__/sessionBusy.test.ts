/**
 * Who holds a session (src/utils/sessionBusy.ts).
 *
 *   SY-1 a sending queue item holds the session it runs in (Anthropic only: queueSession answers undefined
 *        otherwise); a `chat` item holds its session only while its send is alive; exceptId is skipped
 *   SY-2 the label: the first non-empty line, cut at 60 characters; the choices in their order
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { busySessionChoices, promptLabel, sessionHolderOf } from '../sessionBusy.js';

describe('busy sessions (rules)', () => {
    test('SY-1: the holder', () => {
        const items = [
            { id: 'q1', status: 'sending', originalText: 'queue work', session: 'walk' },
            { id: 'q2', status: 'sending', originalText: 'copilot work' },
            { id: 'c1', status: 'chat', originalText: 'live chat', session: 'other' },
            { id: 'c2', status: 'chat', originalText: 'hung chat', session: 'stale' },
            { id: 'p1', status: 'pending', originalText: 'waits', session: 'walk' },
        ];
        const opts = {
            queueSession: (i: { id: string; session?: string }) => (i.id === 'q2' ? undefined : i.session ?? 'default'),
            chatAlive: (i: { id: string }) => i.id === 'c1',
        };
        assert.deepEqual(sessionHolderOf(items, 'walk', opts), { kind: 'queue', id: 'q1', label: 'queue work' });
        assert.deepEqual(sessionHolderOf(items, 'other', opts), { kind: 'chat', id: 'c1', label: 'live chat' });
        assert.equal(sessionHolderOf(items, 'stale', opts), undefined, 'a send that no longer runs holds nothing');
        assert.equal(sessionHolderOf(items, 'default', opts), undefined, 'a Copilot item holds no session');
        assert.equal(sessionHolderOf(items, 'walk', { ...opts, exceptId: 'q1' }), undefined);
    });

    test('SY-2: labels and choices', () => {
        assert.equal(promptLabel('\n  first line\nsecond'), 'first line');
        assert.equal(promptLabel('x'.repeat(80)), `${'x'.repeat(59)}…`);
        const choices = busySessionChoices('walk', { kind: 'queue', id: 'q1', label: 'queue work' }, ['chat', 'default']);
        assert.deepEqual(choices.map((c) => [c.kind, c.session]), [['next', undefined], ['after', undefined], ['session', 'chat'], ['session', 'default']]);
        assert.match(choices[0].description, /directly under the queue item "queue work"; between its iterations when it repeats/);
        assert.match(choices[1].description, /when it has finished all its iterations/);
    });
});
