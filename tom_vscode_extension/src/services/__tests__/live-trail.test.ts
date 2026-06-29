/**
 * Tests for the LiveTrailWriter `appendRetry` entry — the observability
 * feature that surfaces transient-failure retries in the quest live-trail so
 * the user can see an error occurred and is being ridden out without opening
 * the Tom Tool Log.
 *
 * Coverage:
 *   - appendRetry writes a `### 🔁 retry` heading with the status line.
 *   - The triggering cause is rendered in a fenced block when supplied.
 *   - A retry is written INSIDE the current prompt block and does NOT close it
 *     (no DONE / ERROR marker), so subsequent thinking/text reopen a heading.
 *   - The matching `{ kind: 'retry', message, cause }` event is emitted.
 *   - An empty message is a no-op.
 *
 * `LiveTrailWriter` requires `vscode` + a workspace folder to resolve the
 * `_ai/quests/<quest>/live-trail.md` path, so the shared vscode stub is
 * installed against a temp workspace root before importing the module.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-trail-'));

installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import { LiveTrailWriter, type LiveTrailEvent } from '../live-trail.js';

function newWriter(quest: string): LiveTrailWriter {
    const w = new LiveTrailWriter(quest);
    // Start a clean block so the retry has a prompt to attach to.
    w.beginPrompt({ transport: 'agentSdk', config: 'default', userText: 'do a thing' });
    return w;
}

describe('LiveTrailWriter.appendRetry', () => {
    let quest: string;
    beforeEach(() => {
        // Unique quest per test so the 5-block trimming / leftover files of
        // one test never bleed into the next.
        quest = `q_${Math.random().toString(36).slice(2)}`;
    });

    it('writes a 🔁 retry heading with the status line', () => {
        const w = newWriter(quest);
        w.appendRetry('Anthropic API busy — retrying in 4s (attempt 2)');
        const body = fs.readFileSync(w.getFilePath(), 'utf-8');
        assert.match(body, /### 🔁 retry/);
        assert.match(body, /Anthropic API busy — retrying in 4s \(attempt 2\)/);
    });

    it('renders the triggering cause in a fenced block when supplied', () => {
        const w = newWriter(quest);
        w.appendRetry('Backend busy — retrying in 8s', 'API Error: 529 overloaded');
        const body = fs.readFileSync(w.getFilePath(), 'utf-8');
        assert.match(body, /```text\nAPI Error: 529 overloaded\n```/);
    });

    it('does not close the prompt block (no DONE / ERROR marker)', () => {
        const w = newWriter(quest);
        w.appendRetry('retrying', 'boom');
        const body = fs.readFileSync(w.getFilePath(), 'utf-8');
        assert.doesNotMatch(body, /### ✅ DONE/);
        assert.doesNotMatch(body, /### ⚠️ ERROR/);
        // A turn that continues after the retry reopens a fresh heading.
        w.appendAssistantText('continuing after the retry');
        const after = fs.readFileSync(w.getFilePath(), 'utf-8');
        assert.match(after, /### 💬 assistant\n\ncontinuing after the retry/);
    });

    it('emits a retry event carrying message + cause', () => {
        const events: LiveTrailEvent[] = [];
        const sub = LiveTrailWriter.addObserver((e) => events.push(e));
        try {
            const w = newWriter(quest);
            w.appendRetry('retrying soon', 'HTTP 500 Internal server error');
            const retry = events.find((e) => e.kind === 'retry');
            assert.ok(retry, 'expected a retry event');
            assert.equal(retry.kind === 'retry' && retry.message, 'retrying soon');
            assert.equal(retry.kind === 'retry' && retry.cause, 'HTTP 500 Internal server error');
            assert.equal(retry.questId, quest);
            // beginPrompt stamps source 'chat' by default.
            assert.equal(retry.source, 'chat');
        } finally {
            sub.dispose();
        }
    });

    it('is a no-op for an empty message', () => {
        const w = newWriter(quest);
        const before = fs.readFileSync(w.getFilePath(), 'utf-8');
        w.appendRetry('');
        const after = fs.readFileSync(w.getFilePath(), 'utf-8');
        assert.equal(after, before);
    });
});
