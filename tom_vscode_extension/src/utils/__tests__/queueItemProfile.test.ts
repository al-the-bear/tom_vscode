/**
 * The profile a queue item's header shows, and the picker a click opens (src/utils/queueItemProfile.ts).
 *
 *   QP-1 an item with its own profile: `own`, the profile's name and its model and kind; a profile id the
 *        configuration no longer has is shown by its id
 *   QP-2 an item without one: not `own`; it names what it runs with — the profile resolved for it (session,
 *        queue default), else the default profile; on Copilot no profile at all
 *   QP-3 `canPick` until the item has finished (sent, a chat send)
 *   QP-4 the picker lists every profile, whatever its transport — Agent SDK, direct API, VS Code LM, Local LLM —
 *        with id, model and kind; the item's own is marked; "No profile of its own" is offered only while
 *        it has one
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { itemProfileView, profileDetail, profilePickEntries, QUEUE_DEFAULT_PICK, transportKindLabel } from '../queueItemProfile.js';

const profiles = [
    { id: 'sdk', name: 'Opus SDK', configurationId: 'c-sdk' },
    { id: 'api', name: 'Sonnet API', configurationId: 'c-api', isDefault: true },
    { id: 'lm', name: 'Copilot LM', configurationId: 'c-lm' },
    { id: 'local', name: 'local', configurationId: 'c-local' },
    { id: 'bare' },
];
const configurations = [
    { id: 'c-sdk', name: 'SDK', model: 'claude-opus', transport: 'agentSdk' },
    { id: 'c-api', name: 'API', model: 'claude-sonnet', transport: 'direct' },
    { id: 'c-lm', name: 'LM', model: 'gpt', transport: 'vscodeLm' },
    { id: 'c-local', name: 'Gemma', transport: 'localLlm' },
];
const view = (over: Record<string, unknown>) => itemProfileView({ status: 'pending', resolved: { transport: 'anthropic', anthropicProfileId: 'api' }, profiles, configurations, ...over } as never);

describe('queue item header: the profile', () => {
    test('QP-1: its own profile', () => {
        assert.deepEqual(view({ ownTransport: 'anthropic', ownProfileId: 'sdk', resolved: { transport: 'anthropic', anthropicProfileId: 'sdk' } }),
            { own: true, transport: 'anthropic', id: 'sdk', name: 'Opus SDK', detail: 'claude-opus · Agent SDK', canPick: true });
        assert.deepEqual(view({ ownTransport: 'anthropic', ownProfileId: 'gone', resolved: { transport: 'anthropic', anthropicProfileId: 'gone' } }),
            { own: true, transport: 'anthropic', id: 'gone', name: 'gone', canPick: true });
        assert.equal(profileDetail(profiles[3], configurations), 'Gemma · Local LLM');
        assert.equal(profileDetail(profiles[4], configurations), '');
        assert.equal(transportKindLabel(undefined), 'direct API');
    });

    test('QP-2: no profile of its own', () => {
        assert.deepEqual(view({ resolved: { transport: 'anthropic', anthropicProfileId: 'sdk' } }),
            { own: false, transport: 'anthropic', id: 'sdk', name: 'Opus SDK', detail: 'claude-opus · Agent SDK', canPick: true });
        assert.deepEqual(view({ resolved: { transport: 'anthropic' } }),
            { own: false, transport: 'anthropic', id: 'api', name: 'Sonnet API', detail: 'claude-sonnet · direct API', canPick: true }, 'the default profile');
        assert.deepEqual(view({ resolved: { transport: 'copilot' } }), { own: false, transport: 'copilot', canPick: true });
        // A profile id without the Anthropic transport of its own is not "own".
        assert.equal(view({ ownProfileId: 'sdk', resolved: { transport: 'copilot' } }).own, false);
    });

    test('QP-3: canPick', () => {
        for (const status of ['staged', 'pending', 'sending', 'error', 'waiting', 'retry', 'interrupted', 'decision-needed', 'todo-blocked']) {
            assert.equal(view({ status }).canPick, true, status);
        }
        for (const status of ['sent', 'chat', 'chat-sent']) { assert.equal(view({ status }).canPick, false, status); }
    });

    test('QP-4: the picker', () => {
        const own = view({ ownTransport: 'anthropic', ownProfileId: 'sdk', resolved: { transport: 'anthropic', anthropicProfileId: 'sdk' } });
        const entries = profilePickEntries(profiles, configurations, own);
        assert.deepEqual(entries.map((e) => e.value), ['sdk', 'api', 'lm', 'local', 'bare', QUEUE_DEFAULT_PICK]);
        assert.deepEqual(entries[0], { label: 'Opus SDK', description: 'sdk (current)', detail: 'claude-opus · Agent SDK', value: 'sdk' });
        assert.deepEqual(entries[1], { label: 'Sonnet API', description: 'api (default profile)', detail: 'claude-sonnet · direct API', value: 'api' });
        assert.equal(entries[2].detail, 'gpt · VS Code LM');
        assert.deepEqual(entries[4], { label: 'bare', description: '', value: 'bare' });
        assert.equal(entries[5].label, 'No profile of its own');
        const none = profilePickEntries(profiles, configurations, view({}));
        assert.deepEqual(none.map((e) => e.value), ['sdk', 'api', 'lm', 'local', 'bare']);
        assert.ok(none.every((e) => !e.description.includes('(current)')), 'nothing is the item\'s own');
    });
});
