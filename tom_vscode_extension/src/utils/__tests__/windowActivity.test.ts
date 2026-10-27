/**
 * The queue summary a window writes for tomAi_getQuestWindowStatus (src/utils/windowActivity.ts).
 *
 *   WA-1 counts per status, auto-send and the defaults; nothing sending: no `sending`, not paused
 *   WA-2 the item being sent: its stage, transport, profile and session as the last dispatch ran it, else as the
 *        item and the queue defaults say; an 80-character one-line preview; paused while auto-send is off
 *   WA-3 a Copilot item names no profile or session
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { promptPreviewLine, summarizeQueue, type SummaryItem } from '../windowActivity.js';

const item = (id: string, status: string, extra: Partial<SummaryItem> = {}): SummaryItem => ({ id, status, originalText: `prompt ${id}`, ...extra });

describe('window activity — the queue summary', () => {
    test('WA-1: counts and defaults', () => {
        assert.deepEqual(summarizeQueue({
            items: [item('a', 'sent'), item('b', 'sent'), item('c', 'pending'), item('d', 'staged')],
            autoSend: true, defaultTransport: 'anthropic', defaultProfileId: 'opus-sdk', defaultSession: 'prep',
        }), {
            autoSend: true, paused: false, counts: { sent: 2, pending: 1, staged: 1 },
            defaultTransport: 'anthropic', defaultProfileId: 'opus-sdk', defaultSession: 'prep',
        });
    });

    test('WA-2: the item being sent', () => {
        const long = 'Do this\n  and that '.repeat(10);
        const s = summarizeQueue({
            items: [item('x', 'sending', {
                originalText: long, transport: 'anthropic', session: 'walk', sentAt: '2026-10-27T11:00:00.000Z',
                lastDispatched: { kind: 'followUp', transport: 'anthropic', anthropicProfileId: 'opus-direct', dispatchedAt: '2026-10-27T11:30:00.000Z' },
            })],
            autoSend: false, defaultTransport: 'anthropic', defaultProfileId: 'opus-sdk',
        });
        assert.equal(s.paused, true, 'sending with auto-send off');
        assert.deepEqual(s.sending, {
            id: 'x', preview: promptPreviewLine(long), stage: 'follow-up', transport: 'anthropic',
            profileId: 'opus-direct', session: 'walk', since: '2026-10-27T11:30:00.000Z',
        });
        assert.equal(s.sending?.preview.length, 80);
        assert.doesNotMatch(s.sending!.preview, /\n/);
        const fresh = summarizeQueue({ items: [item('y', 'sending', { sentAt: '2026-10-27T11:00:00.000Z' })], autoSend: true, defaultTransport: 'anthropic', defaultProfileId: 'opus-sdk' });
        assert.deepEqual(fresh.sending, {
            id: 'y', preview: 'prompt y', transport: 'anthropic', profileId: 'opus-sdk', session: 'default', since: '2026-10-27T11:00:00.000Z',
        }, 'no dispatch recorded yet: the item and the queue defaults');
    });

    test('WA-3: a Copilot item', () => {
        const s = summarizeQueue({ items: [item('z', 'sending', { transport: 'copilot', anthropicProfileId: 'opus-direct' })], autoSend: true, defaultProfileId: 'opus-sdk' });
        assert.deepEqual(s.sending, { id: 'z', preview: 'prompt z', transport: 'copilot' });
    });
});
