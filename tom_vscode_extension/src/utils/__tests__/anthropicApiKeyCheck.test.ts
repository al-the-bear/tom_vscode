/**
 * The missing-API-key check (vscimpa21): does an Anthropic target resolve to a
 * direct-API configuration whose key variable is not in the environment?
 *
 *   AK-1 the key variable is `apiKeyEnvVar`, else ANTHROPIC_API_KEY
 *   AK-2 the profile is picked by id, else the default, else the first; an explicit configuration id wins,
 *        a blank one falls back to the profile's
 *   AK-3 missing only for a direct configuration (a configuration without `transport` is direct) whose
 *        variable is unset: an Agent SDK configuration, a Local LLM one, an unresolved one or a set variable
 *        is not missing
 *   AK-4 the message names the profile, the configuration and the variable, and says that a window reload
 *        is not enough
 *   AK-5 the profile pickers' list: every profile with an id, in order, marked when it lacks its key
 */

/* eslint-disable @typescript-eslint/naming-convention -- environments are keyed by variable names */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    directApiKeyEnvVar,
    effectiveConfigurationId,
    missingApiKeyMessage,
    missingDirectApiKey,
    pickAnthropicProfile,
    profileKeyStates,
    type AnthropicKeySection,
} from '../anthropicApiKeyCheck.js';

const SECTION: AnthropicKeySection = {
    apiKeyEnvVar: 'TEST_VSCODE_KEY',
    profiles: [
        { id: 'direct-p', configurationId: 'direct-c' },
        { id: 'sdk-p', configurationId: 'sdk-c', isDefault: true },
        { id: 'implicit-p', configurationId: 'implicit-c' },
        { id: 'local-p', configurationId: 'local-llm-c' },
    ],
    configurations: [
        { id: 'direct-c', transport: 'direct' },
        { id: 'sdk-c', transport: 'agentSdk' },
        { id: 'implicit-c' },
    ],
};

describe('anthropicApiKeyCheck', () => {
    test('AK-1: the key variable', () => {
        assert.equal(directApiKeyEnvVar(SECTION), 'TEST_VSCODE_KEY');
        assert.equal(directApiKeyEnvVar({}), 'ANTHROPIC_API_KEY');
        assert.equal(directApiKeyEnvVar(undefined), 'ANTHROPIC_API_KEY');
    });

    test('AK-2: which profile and configuration', () => {
        const profiles = SECTION.profiles!;
        assert.equal(pickAnthropicProfile(profiles, 'direct-p')?.id, 'direct-p');
        assert.equal(pickAnthropicProfile(profiles, undefined)?.id, 'sdk-p', 'the default');
        assert.equal(pickAnthropicProfile(profiles, 'gone')?.id, 'sdk-p', 'an unknown id: the default');
        assert.equal(pickAnthropicProfile([{ id: 'a' }, null, { id: 'b' }], undefined)?.id, 'a', 'no default: the first');
        assert.equal(pickAnthropicProfile([], 'x'), undefined);
        assert.equal(effectiveConfigurationId({ configurationId: 'own' }, 'other'), 'other');
        assert.equal(effectiveConfigurationId({ configurationId: 'own' }, '  '), 'own', 'the chat panel sends a blank id');
        assert.equal(effectiveConfigurationId({ configurationId: 'own' }, undefined), 'own');
    });

    test('AK-3: when the key is missing', () => {
        const none = {};
        assert.deepEqual(missingDirectApiKey(SECTION, { profileId: 'direct-p' }, none),
            { envVar: 'TEST_VSCODE_KEY', profileId: 'direct-p', configurationId: 'direct-c' });
        assert.equal(missingDirectApiKey(SECTION, { profileId: 'implicit-p' }, none)?.configurationId, 'implicit-c',
            'no transport means direct');
        assert.equal(missingDirectApiKey(SECTION, { profileId: 'sdk-p' }, none), undefined, 'Agent SDK');
        assert.equal(missingDirectApiKey(SECTION, {}, none), undefined, 'the default profile is the Agent SDK one');
        assert.equal(missingDirectApiKey(SECTION, { profileId: 'local-p' }, none), undefined, 'a Local LLM configuration');
        assert.equal(missingDirectApiKey(SECTION, { profileId: 'sdk-p', configId: 'direct-c' }, none)?.configurationId, 'direct-c',
            'an explicit configuration wins over the profile\'s');
        assert.equal(missingDirectApiKey(SECTION, { profileId: 'direct-p' }, { TEST_VSCODE_KEY: 'sk-x' }), undefined, 'the key is set');
        assert.equal(missingDirectApiKey(SECTION, { profileId: 'direct-p' }, { TEST_VSCODE_KEY: '' }) !== undefined, true,
            'an empty variable is no key');
        assert.equal(missingDirectApiKey(undefined, { profileId: 'direct-p' }, none), undefined, 'no Anthropic section');
    });

    test('AK-4: the message', () => {
        const text = missingApiKeyMessage({ envVar: 'TEST_VSCODE_KEY', profileId: 'direct-p', configurationId: 'direct-c' });
        assert.match(text, /"direct-p"/);
        assert.match(text, /"direct-c"/);
        assert.match(text, /TEST_VSCODE_KEY is not set/);
        assert.match(text, /quit and started again/);
        assert.match(text, /Reload Window" does not refresh/);
    });

    test('AK-5: what the profile pickers list', () => {
        const states = profileKeyStates({ ...SECTION, profiles: [...SECTION.profiles!, null, { name: 'no id' }, { id: 'named', name: 'Named', configurationId: 'direct-c' }] }, {});
        assert.deepEqual(states.map((p) => [p.id, p.name, p.isDefault, p.noApiKey]), [
            ['direct-p', 'direct-p', false, true],
            ['sdk-p', 'sdk-p', true, false],
            ['implicit-p', 'implicit-p', false, true],
            ['local-p', 'local-p', false, false],
            ['named', 'Named', false, true],
        ]);
        assert.ok(profileKeyStates(SECTION, { TEST_VSCODE_KEY: 'sk' }).every((p) => !p.noApiKey), 'with the key nothing is marked');
        assert.deepEqual(profileKeyStates(undefined, {}), []);
    });
});
