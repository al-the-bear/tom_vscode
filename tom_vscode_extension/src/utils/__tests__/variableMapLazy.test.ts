/**
 * The composite blocks of the variable map are built when a template reads
 * them (src/utils/variableResolver.ts): building `${contextInfo}` runs git
 * synchronously, and every placeholder resolution — a folder path, the bridge
 * profile's cwd at activation — builds the map.
 *
 *   VM-1 resolving a placeholder that is not a block runs no git command, with
 *        either resolver, also through the any-case lookup and a dynamic key
 *   VM-2 `${contextInfo}` and `${contextAndVariables}` still hold the blocks
 *        (git read for them), `${chatVariables}` alike
 *   VM-3 defineLazyValue: computed on the first read only; an assignment
 *        replaces it with a plain value; it is enumerable
 *   DL-1 the debug log is one file per quest window
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({ workspaceFolders: [path.resolve(__dirname, '..', '..', '..')] });

import { defineLazyValue, resolveVariables } from '../variableResolver.js';
import { resolveTemplate } from '../../handlers/promptTemplate.js';
import { debugLogFilePath } from '../debugLogger.js';

/** Count the synchronous child processes `run` starts (git for the blocks). */
function countExecSync(run: () => void): number {
    // The module object itself: a namespace import only has getters.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp: typeof import('child_process') = require('child_process');
    const original = cp.execSync;
    let calls = 0;
    cp.execSync = ((...args: Parameters<typeof cp.execSync>) => {
        calls++;
        return original(...args);
    }) as typeof cp.execSync;
    try {
        run();
    } finally {
        cp.execSync = original;
    }
    return calls;
}

describe('lazy composite blocks', () => {
    test('VM-1: no git for placeholders that are not blocks', () => {
        const calls = countExecSync(() => {
            const resolved = resolveVariables('${workspaceFolder}/x ${WORKSPACEFOLDER} ${env.HOME} ${unknown}', {
                includeEditor: false, unresolvedBehavior: 'empty',
            });
            assert.ok(resolved.startsWith(path.resolve(__dirname, '..', '..', '..')), resolved);
            resolveTemplate('${workspaceFolder} {{Workspace}}', {});
        });
        assert.equal(calls, 0);
    });

    test('VM-2: the blocks are still there when read', () => {
        let resolved = '';
        const calls = countExecSync(() => {
            resolved = resolveVariables('${contextAndVariables}', { includeEditor: false, unresolvedBehavior: 'empty' });
        });
        assert.ok(calls > 0, 'git ran for contextInfo');
        assert.match(resolved, /^Current Context:/);
        assert.match(resolved, /Current Chat Variables:/);
        assert.match(resolveVariables('${chatVariables}', { includeEditor: false }), /^Current Chat Variables:/);
    });

    test('VM-3: defineLazyValue', () => {
        const values: Record<string, string> = {};
        let computed = 0;
        defineLazyValue(values, 'block', () => `v${++computed}`);
        assert.equal(computed, 0);
        assert.deepEqual(Object.keys(values), ['block']);
        assert.equal(values.block, 'v1');
        assert.equal(values.block, 'v1');
        assert.equal(computed, 1);
        values.block = 'override';
        assert.equal(values.block, 'override');
        assert.equal(computed, 1);
    });

    test('DL-1: one debug log per quest window', () => {
        assert.equal(debugLogFilePath('/ws', 'vscode_extension'), path.join('/ws', 'ztmp', 'tom_extension_debug.vscode_extension.log'));
        assert.notEqual(debugLogFilePath('/ws', 'a'), debugLogFilePath('/ws', 'b'));
    });
});
