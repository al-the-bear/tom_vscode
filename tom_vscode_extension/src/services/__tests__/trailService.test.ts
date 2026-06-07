/**
 * Unit tests for the `mcp` trail subsystem (todo #1).
 *
 * Proves that `MCP_SUBSYSTEM` resolves to a `…/trail/mcp/<quest>` folder:
 *   - default config → `getSubsystemPath` yields `…/trail/mcp/<quest>`
 *   - a config whose mcp pattern contains `${subsystem}` resolves that
 *     token to `mcp` (i.e. the subsystem *name* is `mcp`)
 *   - the exported `MCP_SUBSYSTEM` literal has `type === 'mcp'`
 *
 * `vscode` and `TomAiConfiguration` are kept behind injected doubles so
 * the path logic is unit-testable without a live extension host. The
 * real `WsPaths` / `resolveVariables` run against the stubbed workspace
 * so `${ai}` resolves to `<workspaceRoot>/_ai`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

// Mutable trail config the injected `TomAiConfiguration` double returns.
// Tests reset it before each assertion that depends on a specific shape.
let trailConfig: unknown = {};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trailsvc-mcp-'));

installVscodeStub({
    workspaceFolders: [tmpRoot],
    moduleOverrides: {
        '../utils/tomAiConfiguration': {
            TomAiConfiguration: { instance: { getTrail: (): unknown => trailConfig } },
        },
    },
});

describe('TrailService — mcp subsystem', () => {
    it('exports an MCP_SUBSYSTEM literal of type "mcp"', async () => {
        const { MCP_SUBSYSTEM } = await import('../trailSubsystems.js');
        assert.equal((MCP_SUBSYSTEM as { type: string }).type, 'mcp');
    });

    it('resolves the default mcp path to …/trail/mcp/<quest>', async () => {
        trailConfig = {};
        const { TrailService } = await import('../trailService.js');
        const { MCP_SUBSYSTEM } = await import('../trailSubsystems.js');
        TrailService.init({} as never);

        const resolved = TrailService.instance.getSubsystemPath(MCP_SUBSYSTEM, 'demo_quest');

        assert.ok(
            resolved.includes(`${path.sep}trail${path.sep}mcp${path.sep}`),
            `expected a .../trail/mcp/... path, got: ${resolved}`,
        );
        assert.ok(resolved.endsWith(`${path.sep}demo_quest`), `expected to end with the quest id, got: ${resolved}`);
    });

    it('fills the ${subsystem} token with the subsystem name "mcp"', async () => {
        // A custom pattern whose subsystem segment is driven by the
        // resolved subsystem *name* — proves getSubsystemName(MCP) === 'mcp'.
        trailConfig = { raw: { paths: { mcp: '${ai}/trail/${subsystem}/${quest}' } } };
        const { TrailService } = await import('../trailService.js');
        const { MCP_SUBSYSTEM } = await import('../trailSubsystems.js');
        TrailService.init({} as never);

        const resolved = TrailService.instance.getSubsystemPath(MCP_SUBSYSTEM, 'demo_quest');

        assert.ok(
            resolved.includes(`${path.sep}trail${path.sep}mcp${path.sep}`),
            `expected the subsystem token to resolve to "mcp", got: ${resolved}`,
        );
    });
});
