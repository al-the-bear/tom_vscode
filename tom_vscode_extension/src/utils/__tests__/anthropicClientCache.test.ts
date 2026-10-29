/**
 * The direct-API client follows the configured key variable (src/utils/anthropicClientCache.ts).
 *
 * The client used to be created once and kept, so a hand edit of `anthropic.apiKeyEnvVar` was ignored until a
 * reload, while the "(no API key)" marks and the queue's missing-key warning read the variable afresh — the two
 * disagreed (the queue warned that every send would fail, then sent with the cached key).
 *
 *   AC-1 the same variable and value: one client, reused
 *   AC-2 another variable name, or another value of the same variable: a new client with the new key
 *   AC-3 the key is missing now: undefined, and a later key creates a fresh client
 *   AC-4 reset: the next call creates a new client even with the same key
 *   AC-5 the handler resolves its client through the cache with the variable rule AND the config read the key check uses, on
 *        every call (no client field kept beside it)
 */

/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { KeyedClientCache } from '../anthropicClientCache.js';

function cache() {
    const made: string[] = [];
    const c = new KeyedClientCache((apiKey: string) => { made.push(apiKey); return { apiKey, n: made.length }; });
    return { c, made };
}

describe('the direct-API client cache', () => {
    test('AC-1: reused while nothing changes', () => {
        const { c, made } = cache();
        const env = { ANTHROPIC_API_KEY: 'k1' };
        const first = c.get('ANTHROPIC_API_KEY', env);
        assert.equal(c.get('ANTHROPIC_API_KEY', env), first);
        assert.deepEqual(made, ['k1']);
    });

    test('AC-2: another name or value makes a new client', () => {
        const { c, made } = cache();
        const env: Record<string, string | undefined> = { A: 'ka', B: 'kb' };
        assert.equal(c.get('A', env)?.apiKey, 'ka');
        assert.equal(c.get('B', env)?.apiKey, 'kb', 'the variable name changed');
        env.B = 'kb2';
        assert.equal(c.get('B', env)?.apiKey, 'kb2', 'the value changed');
        assert.deepEqual(made, ['ka', 'kb', 'kb2']);
    });

    test('AC-3: a missing key answers undefined', () => {
        const { c, made } = cache();
        const env: Record<string, string | undefined> = { A: 'ka' };
        assert.ok(c.get('A', env));
        assert.equal(c.get('UNSET', env), undefined, 'pointed at an unset variable');
        env.A = '';
        assert.equal(c.get('A', env), undefined, 'an empty value is no key');
        env.A = 'ka';
        assert.equal(c.get('A', env)?.n, 2, 'a fresh client once the key is back');
        assert.deepEqual(made, ['ka', 'ka']);
    });

    test('AC-4: reset', () => {
        const { c, made } = cache();
        const env = { A: 'ka' };
        c.get('A', env);
        c.reset();
        c.get('A', env);
        assert.deepEqual(made, ['ka', 'ka']);
    });

    test('AC-5: the handler uses it', () => {
        const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf-8');
        const at = src.indexOf('private getClient(');
        const body = src.slice(at, src.indexOf('\n    }\n', at));
        assert.match(body, /this\.clientCache\.get\(directApiKeyEnvVar\(loadSendToChatConfig\(\)\?\.anthropic\), process\.env\)/,
            'the variable comes from the config file as it is now, the read the key check makes (finishvsd4)');
        assert.doesNotMatch(src, /private client: Anthropic/, 'no client cached outside the keyed cache');
        assert.doesNotMatch(src, /apiKeyEnvVar \|\| 'ANTHROPIC_API_KEY'/, 'one rule for the variable name');
    });
});
