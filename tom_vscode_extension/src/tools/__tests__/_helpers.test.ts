/**
 * Sanity tests for the §0.1 test-infrastructure helpers themselves.
 *
 *   - `installVscodeStub` — `vscode` resolves to our fake, calls are
 *     recorded, overrides take effect, restore() unhooks cleanly.
 *   - `withTiming` — measures, asserts under ceiling, accumulates,
 *     supports override.
 *   - `mkSmallWorkspace` / `mkMediumWorkspace` / `mkQuestFolder` —
 *     produce the documented file counts and layouts.
 *
 * The Large workspace is exercised by the actual file-primitives test
 * (entry 1) — covering its build cost twice would just bloat the test
 * matrix.
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
import { getTimings, resetTimings, withTiming } from './_timing.js';
import { mkQuestFolder, mkSmallWorkspace, mkMediumWorkspace } from './_fixtures.js';

// ---------------------------------------------------------------------------
// _vscode-stub
// ---------------------------------------------------------------------------

describe('installVscodeStub', () => {
    test('installs the resolver and returns a handle with spies/stub', () => {
        const handle = installVscodeStub({});
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const vscode = require('vscode') as Record<string, unknown>;
            assert.ok(vscode.workspace);
            assert.ok(vscode.window);
            assert.ok(vscode.commands);
            assert.ok(vscode.lm);
            assert.ok(vscode.Uri);
            // workspaceFolders defaults to undefined when not configured
            assert.equal((vscode.workspace as Record<string, unknown>).workspaceFolders, undefined);
        } finally {
            handle.restore();
        }
    });

    test('workspaceFolders are populated when paths are provided', () => {
        const handle = installVscodeStub({ workspaceFolders: ['/tmp/example'] });
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const vscode = require('vscode') as { workspace: { workspaceFolders?: Array<{ uri: { fsPath: string } }> } };
            const folders = vscode.workspace.workspaceFolders;
            assert.ok(folders);
            assert.equal(folders.length, 1);
            assert.equal(folders[0].uri.fsPath, path.resolve('/tmp/example'));
        } finally {
            handle.restore();
        }
    });

    test('spies record calls to recorded methods', async () => {
        const handle = installVscodeStub({});
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const vscode = require('vscode') as {
                window: { showInformationMessage(msg: string): Promise<unknown> };
                commands: { executeCommand(cmd: string, ...args: unknown[]): Promise<unknown> };
            };
            await vscode.window.showInformationMessage('hello');
            await vscode.commands.executeCommand('foo.bar', 42);
            const calls = handle.spies.calls;
            assert.equal(calls[0].method, 'window.showInformationMessage');
            assert.deepEqual(calls[0].args, ['hello']);
            assert.equal(calls[1].method, 'commands.executeCommand');
            assert.deepEqual(calls[1].args, ['foo.bar', 42]);
            // byMethod filter works on prefix
            assert.equal(handle.spies.byMethod('window.').length, 1);
            // clear empties
            handle.spies.clear();
            assert.equal(handle.spies.calls.length, 0);
        } finally {
            handle.restore();
        }
    });

    test('moduleOverrides remap arbitrary `require(spec)` calls', () => {
        const handle = installVscodeStub({
            moduleOverrides: {
                '../managers/chatVariablesStore': { ChatVariablesStore: { instance: { quest: 'demo' } } },
            },
        });
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const m = require('../managers/chatVariablesStore') as { ChatVariablesStore: { instance: { quest: string } } };
            assert.equal(m.ChatVariablesStore.instance.quest, 'demo');
            // `.js`-suffixed variant resolves to the same override
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const m2 = require('../managers/chatVariablesStore.js') as { ChatVariablesStore: { instance: { quest: string } } };
            assert.equal(m2.ChatVariablesStore.instance.quest, 'demo');
        } finally {
            handle.restore();
        }
    });

    test('methodOverrides take precedence over the default no-ops', async () => {
        const handle = installVscodeStub({
            methodOverrides: {
                showInformationMessage: () => Promise.resolve('custom-result'),
            },
        });
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const vscode = require('vscode') as { window: { showInformationMessage(msg: string): Promise<unknown> } };
            const r = await vscode.window.showInformationMessage('x');
            assert.equal(r, 'custom-result');
        } finally {
            handle.restore();
        }
    });

    test('restore() leaves Module._resolveFilename intact for unrelated requests', () => {
        const handle = installVscodeStub({});
        handle.restore();
        // After restore, `require('vscode')` should fail with the real
        // "Cannot find module" error — which is the same shape the
        // pre-install state would have produced.
        assert.throws(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('vscode');
        }, /Cannot find module 'vscode'/);
    });
});

// ---------------------------------------------------------------------------
// _timing
// ---------------------------------------------------------------------------

describe('withTiming', () => {

    after(() => resetTimings());

    test('measures and records a fast call under the default ceiling', async () => {
        resetTimings();
        const out = await withTiming('helper-test:fast', () => 42);
        assert.equal(out, 42);
        const timings = getTimings();
        assert.equal(timings.length, 1);
        assert.equal(timings[0].name, 'helper-test:fast');
        assert.equal(timings[0].ceilingMs, 5000);
        assert.ok(timings[0].ms >= 0);
        assert.ok(timings[0].ms < 100, `Trivial call should be fast: ${timings[0].ms}ms`);
    });

    test('respects expectMaxMs override', async () => {
        resetTimings();
        await withTiming('helper-test:override', async () => {
            await new Promise((r) => setTimeout(r, 50));
        }, { expectMaxMs: 200, category: 'helper', note: 'sleep 50ms' });
        const t = getTimings()[0];
        assert.equal(t.ceilingMs, 200);
        assert.equal(t.category, 'helper');
        assert.equal(t.note, 'sleep 50ms');
    });

    test('throws when actual ms exceeds the ceiling', async () => {
        resetTimings();
        await assert.rejects(async () => {
            await withTiming('helper-test:overrun', async () => {
                await new Promise((r) => setTimeout(r, 60));
            }, { expectMaxMs: 1 });
        }, /Timing ceiling exceeded/);
        // Still recorded so the report shows the regression
        const t = getTimings()[0];
        assert.equal(t.name, 'helper-test:overrun');
    });

    test('re-recording the same name overwrites the prior entry', async () => {
        resetTimings();
        await withTiming('helper-test:dup', () => 1);
        await withTiming('helper-test:dup', () => 2);
        const t = getTimings().filter((x) => x.name === 'helper-test:dup');
        assert.equal(t.length, 1);
    });
});

// ---------------------------------------------------------------------------
// _fixtures
// ---------------------------------------------------------------------------

function countFilesRec(dir: string, ext?: string): number {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) { total += countFilesRec(abs, ext); }
        else if (entry.isFile() && (!ext || abs.endsWith(`.${ext}`))) { total += 1; }
    }
    return total;
}

describe('mkSmallWorkspace', () => {
    test('produces realistic shape and is in the right ballpark', () => {
        const ws = mkSmallWorkspace();
        try {
            assert.ok(fs.existsSync(path.join(ws.root, 'src/index.ts')));
            assert.ok(fs.existsSync(path.join(ws.root, '_copilot_guidelines/index.md')));
            assert.ok(fs.existsSync(path.join(ws.root, 'package.json')));
            const total = countFilesRec(ws.root);
            // 1 + 1 + 1 + 20 (components) + 1 + 10 (doc) + 4 (guidelines) + 1 + 1 = 40
            // The "≈ 100" promise in the doc is upper-bound; actual figure documented here.
            assert.ok(total >= 30 && total <= 120, `Small fixture has ${total} files (expected 30-120)`);
        } finally {
            ws.cleanup();
        }
    });

    test('cleanup() is idempotent', () => {
        const ws = mkSmallWorkspace();
        ws.cleanup();
        ws.cleanup();  // does not throw
        assert.equal(fs.existsSync(ws.root), false);
    });
});

describe('mkMediumWorkspace', () => {
    test('contains at least 1 000 source files', () => {
        const ws = mkMediumWorkspace();
        try {
            const tsCount = countFilesRec(ws.root, 'ts');
            assert.ok(tsCount >= 1000, `Expected ≥ 1000 .ts files, got ${tsCount}`);
        } finally {
            ws.cleanup();
        }
    });
});

describe('mkQuestFolder', () => {
    test('default: one anthropic subsystem with 5 paired exchanges', () => {
        const q = mkQuestFolder('demo_quest');
        try {
            const promptsFile = path.join(q.questFolder, 'demo_quest.anthropic.prompts.md');
            const answersFile = path.join(q.questFolder, 'demo_quest.anthropic.answers.md');
            assert.ok(fs.existsSync(promptsFile));
            assert.ok(fs.existsSync(answersFile));
            const promptContent = fs.readFileSync(promptsFile, 'utf-8');
            const answerContent = fs.readFileSync(answersFile, 'utf-8');
            const promptHeaders = promptContent.match(/=== PROMPT/g) ?? [];
            const answerHeaders = answerContent.match(/=== ANSWER/g) ?? [];
            assert.equal(promptHeaders.length, 5);
            assert.equal(answerHeaders.length, 5);
            // Newest-first: the FIRST header in the file is for i=4 (last loop iteration → highest seq)
            assert.match(promptContent.split('\n')[0], /=== PROMPT req-anthropic-5/);
        } finally {
            q.cleanup();
        }
    });

    test('multiple subsystems each get their own file pair', () => {
        const q = mkQuestFolder('demo_quest', { subsystems: ['anthropic', 'localllm-foo'], exchangesPerSubsystem: 2 });
        try {
            for (const sub of ['anthropic', 'localllm-foo']) {
                assert.ok(fs.existsSync(path.join(q.questFolder, `demo_quest.${sub}.prompts.md`)));
                assert.ok(fs.existsSync(path.join(q.questFolder, `demo_quest.${sub}.answers.md`)));
            }
        } finally {
            q.cleanup();
        }
    });
});
