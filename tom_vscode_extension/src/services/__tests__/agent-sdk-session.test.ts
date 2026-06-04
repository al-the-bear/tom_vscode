/**
 * Tests for per-key Agent SDK session-id persistence.
 *
 * The prompt queue keeps its SDK continuity in `default.session.json`;
 * the Anthropic chat panel keeps its own in `chat.session.json`. Both
 * live in the quest's history folder. These tests pin the file naming
 * and, crucially, that the two keys are isolated so a chat send never
 * resumes (or clears) the queue's session and vice-versa.
 */

import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// memory-service.ts requires `vscode` at import time. Install the stub
// with a throwaway workspace root so historyFolder() resolves into a
// temp dir we can inspect on disk.
import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const stubHandle = installVscodeStub({});

import { TwoTierMemoryService } from '../memory-service.js';

const QUEST = 'session_test_quest';

function freshWorkspace(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-session-'));
    stubHandle.setWorkspaceFolders([root]);
    return root;
}

function sessionFile(root: string, key: string): string {
    return path.join(root, '_ai', 'quests', QUEST, 'history', `${key}.session.json`);
}

describe('TwoTierMemoryService Agent SDK session keys', () => {
    let svc: TwoTierMemoryService;
    let root: string;

    beforeEach(() => {
        svc = TwoTierMemoryService.instance;
        root = freshWorkspace();
    });

    test('default key persists to default.session.json', () => {
        svc.saveAgentSdkSessionId('sess-default', QUEST, 'claude-x');
        assert.ok(fs.existsSync(sessionFile(root, 'default')), 'default.session.json should exist');
        assert.equal(svc.loadAgentSdkSessionId(QUEST), 'sess-default');
    });

    test('chat key persists to chat.session.json', () => {
        svc.saveAgentSdkSessionId('sess-chat', QUEST, 'claude-x', 'chat');
        assert.ok(fs.existsSync(sessionFile(root, 'chat')), 'chat.session.json should exist');
        assert.equal(svc.loadAgentSdkSessionId(QUEST, 'chat'), 'sess-chat');
    });

    test('keys are isolated — chat session never bleeds into default', () => {
        svc.saveAgentSdkSessionId('sess-default', QUEST, 'claude-x');
        svc.saveAgentSdkSessionId('sess-chat', QUEST, 'claude-x', 'chat');

        assert.equal(svc.loadAgentSdkSessionId(QUEST), 'sess-default');
        assert.equal(svc.loadAgentSdkSessionId(QUEST, 'chat'), 'sess-chat');
    });

    test('clearing one key leaves the other intact', () => {
        svc.saveAgentSdkSessionId('sess-default', QUEST, 'claude-x');
        svc.saveAgentSdkSessionId('sess-chat', QUEST, 'claude-x', 'chat');

        svc.clearAgentSdkSessionId(QUEST, 'chat');

        assert.equal(svc.loadAgentSdkSessionId(QUEST, 'chat'), undefined, 'chat cleared');
        assert.equal(svc.loadAgentSdkSessionId(QUEST), 'sess-default', 'default untouched');
    });
});
