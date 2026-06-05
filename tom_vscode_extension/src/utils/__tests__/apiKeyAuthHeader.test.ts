/**
 * Tests for `apiKeyAuthHeader.ts` — the pure builder for the optional
 * `Authorization` header used by the Local LLM transports (Ollama + OpenAI).
 *
 * The feature: a per-configuration `apiKeyEnv` names an environment variable
 * (never the key itself). When set and the variable is non-empty, the request
 * carries `Authorization: Bearer <value>`. Unset → no header (unchanged
 * behaviour). Set-but-empty → no header, with the `onMissing` callback fired.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { apiKeyAuthHeader } from '../apiKeyAuthHeader.js';

describe('apiKeyAuthHeader', () => {
    test('returns no header when apiKeyEnv is undefined', () => {
        assert.deepEqual(apiKeyAuthHeader(undefined, {}), {});
    });

    test('returns no header when apiKeyEnv is empty / whitespace', () => {
        assert.deepEqual(apiKeyAuthHeader('', {}), {});
        assert.deepEqual(apiKeyAuthHeader('   ', {}), {});
    });

    test('returns Bearer header when the named env var holds a value', () => {
        const header = apiKeyAuthHeader('OPENAI_API_KEY', { OPENAI_API_KEY: 'sk-test-123' });
        assert.deepEqual(header, { Authorization: 'Bearer sk-test-123' });
    });

    test('trims the env var name before lookup', () => {
        const header = apiKeyAuthHeader('  OPENAI_API_KEY  ', { OPENAI_API_KEY: 'sk-test-123' });
        assert.deepEqual(header, { Authorization: 'Bearer sk-test-123' });
    });

    test('returns no header and reports when the env var is missing', () => {
        const missing: string[] = [];
        const header = apiKeyAuthHeader('OPENAI_API_KEY', {}, (name) => missing.push(name));
        assert.deepEqual(header, {});
        assert.deepEqual(missing, ['OPENAI_API_KEY']);
    });

    test('returns no header and reports when the env var is empty', () => {
        const missing: string[] = [];
        const header = apiKeyAuthHeader('OPENAI_API_KEY', { OPENAI_API_KEY: '' }, (name) => missing.push(name));
        assert.deepEqual(header, {});
        assert.deepEqual(missing, ['OPENAI_API_KEY']);
    });

    test('does not fire onMissing when the env var resolves', () => {
        let fired = false;
        apiKeyAuthHeader('OPENAI_API_KEY', { OPENAI_API_KEY: 'sk-x' }, () => { fired = true; });
        assert.equal(fired, false);
    });
});
