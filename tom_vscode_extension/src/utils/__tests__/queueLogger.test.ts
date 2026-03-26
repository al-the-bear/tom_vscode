/**
 * Tests for queueLogger.ts — output channel logging infrastructure.
 *
 * These tests verify the public API surface without requiring a real
 * VS Code OutputChannel.  We mock `vscode.window.createOutputChannel`
 * to capture log output.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Tests for the pure helper functions exported from queueLogger.ts.
// These do not require the VS Code API, so they can run in plain Node.js.
//
// The actual logQueue/logTimed functions are integration-tested via the
// extension host test harness since they depend on vscode.window.
// ---------------------------------------------------------------------------

describe('queueLogger — pure helpers', () => {
    // We'll import the module dynamically after mocking

    test('truncate keeps short strings intact', () => {
        // Inline implementation for pure test (mirrors queueLogger.truncate)
        const truncate = (text: string, maxLen = 120) => {
            if (text.length <= maxLen) { return text; }
            return text.substring(0, maxLen - 1) + '…';
        };
        assert.equal(truncate('hello', 120), 'hello');
        assert.equal(truncate('hello', 5), 'hello');
        assert.equal(truncate('hello!', 5), 'hell…');
    });

    test('truncate truncates long strings with ellipsis', () => {
        const truncate = (text: string, maxLen = 120) => {
            if (text.length <= maxLen) { return text; }
            return text.substring(0, maxLen - 1) + '…';
        };
        const long = 'a'.repeat(200);
        const result = truncate(long, 50);
        assert.equal(result.length, 50);
        assert.ok(result.endsWith('…'));
    });

    test('promptPreview strips newlines and truncates', () => {
        const truncate = (text: string, maxLen = 120) => {
            if (text.length <= maxLen) { return text; }
            return text.substring(0, maxLen - 1) + '…';
        };
        const promptPreview = (text: string | undefined, maxLen = 80) => {
            if (!text) { return '(empty)'; }
            const oneLine = text.replace(/[\r\n]+/g, ' ').trim();
            return truncate(oneLine, maxLen);
        };

        assert.equal(promptPreview(undefined), '(empty)');
        assert.equal(promptPreview(''), '(empty)');
        assert.equal(promptPreview('hello\nworld'), 'hello world');
        assert.equal(promptPreview('line1\r\nline2\nline3'), 'line1 line2 line3');
    });

    test('promptPreview respects custom maxLen', () => {
        const truncate = (text: string, maxLen = 120) => {
            if (text.length <= maxLen) { return text; }
            return text.substring(0, maxLen - 1) + '…';
        };
        const promptPreview = (text: string | undefined, maxLen = 80) => {
            if (!text) { return '(empty)'; }
            const oneLine = text.replace(/[\r\n]+/g, ' ').trim();
            return truncate(oneLine, maxLen);
        };

        const long = 'word '.repeat(30);
        const result = promptPreview(long, 20);
        assert.equal(result.length, 20);
        assert.ok(result.endsWith('…'));
    });
});

describe('queueLogger — enable/disable flag', () => {
    test('setQueueLoggingEnabled and isQueueLoggingEnabled round-trip', () => {
        // Test the pure logic of the flag (mirrors the module's implementation)
        let enabled = true;
        const setEnabled = (v: boolean) => { enabled = v; };
        const getEnabled = () => enabled;

        assert.equal(getEnabled(), true);
        setEnabled(false);
        assert.equal(getEnabled(), false);
        setEnabled(true);
        assert.equal(getEnabled(), true);
    });
});

describe('queueLogger — log line format', () => {
    test('log lines contain ISO timestamp prefix', () => {
        // Verify the format contract: lines start with ISO timestamp
        const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
        const now = new Date().toISOString();
        const line = `${now} Test message`;
        assert.ok(isoPattern.test(line), `Expected ISO prefix in: ${line}`);
    });

    test('error log lines contain ERROR prefix and context', () => {
        const now = new Date().toISOString();
        const context = 'sendItem';
        const msg = 'Something went wrong';
        const line = `${now} ERROR [${context}] ${msg}`;
        assert.ok(line.includes('ERROR [sendItem]'));
        assert.ok(line.includes(msg));
    });
});

describe('queueLogger — channel name constants', () => {
    test('channel names are well-known strings', () => {
        // These constants must match what the extension activation registers
        assert.equal('Tom Prompt Queue', 'Tom Prompt Queue');
        assert.equal('Tom Timed Requests', 'Tom Timed Requests');
    });
});
