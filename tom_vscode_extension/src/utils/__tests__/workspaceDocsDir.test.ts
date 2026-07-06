/**
 * The "Workspace" documentation group must resolve to the directory that
 * actually holds the workspace-level markdown docs. By convention those live in
 * `doc/` (project style) or `_doc/` (workspace style, see CLAUDE.md). A `doc/`
 * folder that exists only to hold non-markdown artifacts (e.g. `testlog_*`
 * subfolders) must NOT shadow a real `_doc/` — otherwise the panel offers a
 * Workspace group with zero files. These tests pin that precedence.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import { resolveWorkspaceDocsDir } from '../workspaceDocsDir.js';

const WS = '/ws';
const DOC = path.join(WS, 'doc');
const ALT = path.join(WS, '_doc');

/** Build a probe from explicit sets of dirs that exist / contain markdown. */
function probe(existing: string[], withMarkdown: string[]) {
    const exists = new Set(existing);
    const md = new Set(withMarkdown);
    return {
        exists: (dir: string) => exists.has(dir),
        hasMarkdown: (dir: string) => md.has(dir),
    };
}

describe('resolveWorkspaceDocsDir', () => {
    it('prefers doc/ when it contains markdown', () => {
        const dir = resolveWorkspaceDocsDir(WS, probe([DOC, ALT], [DOC, ALT]));
        assert.equal(dir, DOC);
    });

    it('falls back to _doc/ when doc/ exists but has no markdown', () => {
        // The reported bug: doc/ exists (only testlog subfolders) while _doc/
        // holds the real docs. Must resolve to _doc/, not the empty doc/.
        const dir = resolveWorkspaceDocsDir(WS, probe([DOC, ALT], [ALT]));
        assert.equal(dir, ALT);
    });

    it('uses doc/ when only doc/ has markdown', () => {
        const dir = resolveWorkspaceDocsDir(WS, probe([DOC, ALT], [DOC]));
        assert.equal(dir, DOC);
    });

    it('returns _doc/ when only _doc/ exists', () => {
        const dir = resolveWorkspaceDocsDir(WS, probe([ALT], []));
        assert.equal(dir, ALT);
    });

    it('returns doc/ when it exists but neither has markdown', () => {
        const dir = resolveWorkspaceDocsDir(WS, probe([DOC], []));
        assert.equal(dir, DOC);
    });

    it('returns null when neither directory exists', () => {
        const dir = resolveWorkspaceDocsDir(WS, probe([], []));
        assert.equal(dir, null);
    });
});
