/**
 * The session picker's plans (src/utils/sessionPickerPlan.ts) and the ANTHROPIC panel's session.
 *
 *   PP-1 the lifetime step: three lifetimes, worded with and without a base
 *   PP-2 the profile step: "No profile", "As the base (<profile>)" only when the base has one, then
 *        every profile with its model and its (no API key) mark
 *   PP-3 every path writes the expected session file: new / based on; each lifetime; no profile, a
 *        profile (stored with its model), the base's profile inherited, "No profile" on a based session
 *   PP-4 the panel label: name, base, lifetime, model
 *   PP-5 the panel: its button shows the label, a picked session's profile is preselected, Save to
 *        Queue carries the panel's session, Send refuses a profile that cannot continue the session
 *   PP-6 the picker uses these plans
 *   PP-7 the process editor's picker returns the spec a definition stores, in its smallest form, and
 *        creates no file
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { definitionSpecFromChoices, lifetimeChoices, newSessionOptions, profileChoices, sessionLabel } from '../sessionPickerPlan.js';
import type { ProfileSection } from '../sessionSpecs.js';
import { createSession, readSession } from '../../services/agentSdkSessionStore.js';

const SECTION: ProfileSection = {
    profiles: [{ id: 'opus', configurationId: 'opus-cfg' }, { id: 'haiku', configurationId: 'haiku-cfg' }],
    configurations: [{ id: 'opus-cfg', model: 'claude-opus-5-5' }, { id: 'haiku-cfg', model: 'claude-haiku-5-5' }],
};
const LISTED = [{ id: 'opus', name: 'Opus 5.5', noApiKey: false }, { id: 'haiku', name: 'Haiku 5.5', noApiKey: true }];

function source(...parts: string[]): string {
    return fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf-8');
}

describe('session picker plans', () => {
    test('PP-1: lifetimes', () => {
        assert.deepEqual(lifetimeChoices(undefined).map((c) => c.mode), ['continue', 'per-prompt', 'per-iteration']);
        assert.match(lifetimeChoices(undefined)[1].description, /every prompt starts fresh/);
        assert.match(lifetimeChoices('prep')[0].description, /first prompt starts from "prep"/);
        assert.match(lifetimeChoices('prep')[2].description, /prefix todo starts from "prep"/);
    });

    test('PP-2: profiles', () => {
        const plain = profileChoices(LISTED, SECTION, undefined);
        assert.deepEqual(plain.map((i) => i.label), ['No profile', 'Opus 5.5', 'Haiku 5.5 (no API key)']);
        assert.equal(plain[1].description, 'opus · claude-opus-5-5');
        const based = profileChoices(LISTED, SECTION, { name: 'prep', mode: 'continue', profileId: 'opus', model: 'claude-opus-5-5' });
        assert.deepEqual(based.slice(0, 2).map((i) => [i.label, i.choice.kind]), [['No profile', 'none'], ['As the base (opus)', 'base']]);
        assert.equal(profileChoices(LISTED, SECTION, { name: 'prep', mode: 'continue' }).some((i) => i.choice.kind === 'base'), false,
            'no "as the base" when the base has no profile');
    });

    test('PP-3: what each path writes', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-'));
        const make = (name: string, basedOn: string | undefined, mode: 'continue' | 'per-prompt' | 'per-iteration', choice: Parameters<typeof newSessionOptions>[2]) => {
            const r = createSession(dir, name, newSessionOptions(basedOn, mode, choice, SECTION));
            assert.equal(r.ok, true, JSON.stringify(r));
            const { createdAt: _c, updatedAt: _u, ...rest } = readSession(dir, name)!;
            return rest;
        };
        assert.deepEqual(make('plain', undefined, 'continue', { kind: 'none' }), { name: 'plain', mode: 'continue' });
        assert.deepEqual(make('opus', undefined, 'per-prompt', { kind: 'profile', id: 'opus' }),
            { name: 'opus', mode: 'per-prompt', profileId: 'opus', model: 'claude-opus-5-5' });
        assert.deepEqual(make('walk', 'opus', 'per-iteration', { kind: 'base' }),
            { name: 'walk', mode: 'per-iteration', basedOn: 'opus', profileId: 'opus', model: 'claude-opus-5-5' }, 'the base\'s profile inherited');
        assert.deepEqual(make('cheap', 'opus', 'continue', { kind: 'profile', id: 'haiku' }),
            { name: 'cheap', mode: 'continue', basedOn: 'opus', profileId: 'haiku', model: 'claude-haiku-5-5' });
        assert.deepEqual(make('bare', 'opus', 'per-prompt', { kind: 'none' }), { name: 'bare', mode: 'per-prompt', basedOn: 'opus' },
            '"No profile" on a based session: none, even though the base has one');
    });

    test('PP-4: the label', () => {
        assert.deepEqual(sessionLabel('chat', undefined), { label: 'chat', tooltip: 'Session chat' });
        assert.equal(sessionLabel('walk', { name: 'walk', mode: 'per-iteration', basedOn: 'prep', profileId: 'opus', model: 'claude-opus-5-5' }).label,
            'walk based on prep (per iteration) · claude-opus-5-5');
        assert.equal(sessionLabel('solo', { name: 'solo', mode: 'per-prompt' }).label, 'solo (per prompt)');
        assert.equal(sessionLabel('p', { name: 'p', mode: 'continue', profileId: 'opus' }).label, 'p · opus', 'the profile when no model is known');
        assert.match(sessionLabel('walk', { name: 'walk', mode: 'per-prompt', basedOn: 'prep', profileId: 'opus', model: 'm' }).tooltip,
            /^Session walk, based on prep, started again for every prompt, profile opus \(m\)$/);
    });

    test('PP-5: the ANTHROPIC panel', () => {
        const handler = source('src', 'handlers', 'chatPanel-handler.ts');
        const queue = handler.slice(handler.indexOf('private async _handleAddToQueue('));
        assert.match(queue.slice(0, queue.indexOf('\n    }\n')), /\.\.\.\(transport === 'anthropic' \? \{ session: this\._chatSessionKey\(\) \} : \{\}\)/,
            'Save to Queue carries the panel\'s session');
        assert.match(handler, /const \{ label, tooltip \} = sessionLabel\(name, record\);/);
        assert.match(handler, /this\._sendChatSession\(picked !== undefined\);/, 'a pick preselects the session\'s profile');
        const send = handler.indexOf('const mismatch = sessionTransportMismatch(');
        assert.ok(send > 0 && send < handler.indexOf('sessionKey: this._chatSessionKey(),'), 'Send checks the session before it sends');
        const main = source('media', 'chatPanel', 'main.js');
        assert.match(main, /sessionLabel\.textContent = msg\.label \|\| msg\.name \|\| 'chat';/);
        assert.match(main, /if \(msg\.profileId\) \{[\s\S]*sessionProfileSel\.value = msg\.profileId;/);
    });

    test('PP-6: the picker uses the plans', () => {
        const picker = source('src', 'handlers', 'sessionPicker.ts');
        assert.match(picker, /showQuickPick\(lifetimeChoices\(basedOn\)/);
        assert.match(picker, /profileChoices\(profileKeyStates\(section, process\.env\)/);
        assert.match(picker, /createSession\(folder, name, newSessionOptions\(basedOn, how\.mode, profilePick\.choice/);
    });

    test('PP-7: the spec for a process definition', () => {
        assert.equal(definitionSpecFromChoices('work', undefined, 'continue', { kind: 'none' }), 'work', 'a bare name');
        assert.deepEqual(definitionSpecFromChoices('tomspecs', undefined, 'per-prompt', { kind: 'profile', id: 'opus' }),
            { name: 'tomspecs', mode: 'per-prompt', profile: 'opus' });
        assert.deepEqual(definitionSpecFromChoices('todo-r${step-iteration}', 'prep', 'per-iteration', { kind: 'base' }),
            { name: 'todo-r${step-iteration}', basedOn: 'prep', mode: 'per-iteration' }, '"as the base": no profile written');
        const picker = source('src', 'handlers', 'sessionPicker.ts');
        const body = picker.slice(picker.indexOf('export async function pickDefinitionSession('), picker.indexOf('async function createSessionInteractively('));
        assert.doesNotMatch(body, /createSession\(|ensureSession\(/, 'the editor\'s picker creates no file');
        assert.match(body, /return definitionSpecFromChoices\(name, basedOn, how\.mode, profilePick\.choice\);/);
    });
});
