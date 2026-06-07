/**
 * Unit test for the `mcp` ChangeSource (todo #2).
 *
 * Proves that an MCP-originated store mutation is attributable: a
 * `ChatVariablesStore.set(..., 'mcp')` records `source: 'mcp'` in the
 * change log. `'mcp'` must be a valid `ChangeSource` for this file to
 * even compile — which is the type-level half of the acceptance.
 *
 * Location note: this exercises a `managers/` class but lives under
 * `services/__tests__` because only the `tools` / `services` / `utils`
 * `__tests__` globs are wired into `npm test` — the `managers/__tests__`
 * directory is not part of the gate (recorded in completion_steps).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatvars-mcp-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

describe('ChatVariablesStore — mcp change source', () => {
    it('records source "mcp" for an MCP-originated mutation', async () => {
        const { ChatVariablesStore } = await import('../../managers/chatVariablesStore.js');
        const store = ChatVariablesStore.init({ subscriptions: [] } as never);

        store.set('mcpDemo', 'value-from-mcp', 'mcp');

        const last = store.changeLog[store.changeLog.length - 1];
        assert.equal(last.key, 'mcpDemo');
        assert.equal(last.newValue, 'value-from-mcp');
        assert.equal(last.source, 'mcp');
    });
});
