/**
 * Parity guard for the MCP Server card's client-side gather (plan §6, todo #12).
 *
 * The webview gather lives in `media/statusPage/listeners.js` as plain browser
 * JS (no TS module boundary, no DOM-test harness in this repo), so it can't be
 * imported and exercised against a fake DOM the way the pure helpers are. What
 * *can* be pinned — and what the "localLlm lesson" is actually about — is field
 * parity: every editable control the card renders (`data-mcp-field`) and the
 * tool checkboxes (`data-mcp-tool`) must be read by the `saveMcpServer` gather,
 * so a field added to the card can never silently fail to persist.
 *
 * This test derives the expected field set from the card render itself
 * (`renderMcpServerCard`) and asserts the gather branch in listeners.js reads
 * each one. It fails the moment the card and the gather drift apart.
 *
 * `renderMcpServerCard` is pure (type-only deps) so no `vscode` stub is needed.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildMcpServerCardModel, renderMcpServerCard } from '../mcpServerCard.js';

/** Read the runtime webview listeners script (the source IS the runtime file). */
function readListenersJs(): string {
    // out/utils/__tests__ -> project root is three levels up, then media/...
    return readFileSync(
        join(__dirname, '..', '..', '..', 'media', 'statusPage', 'listeners.js'),
        'utf-8',
    );
}

/** The card HTML, rendered from a representative model. */
function renderCard(): string {
    const model = buildMcpServerCardModel(
        {
            enabled: true,
            host: '0.0.0.0',
            basePort: 19920,
            apiKeyEnv: 'MCP_KEY',
            allowWriteWithoutAuth: false,
            toolsEnabled: true,
            enabledTools: ['tomAi_readFile'],
        },
        { running: false },
        false,
    );
    return renderMcpServerCard(model, ['tomAi_readFile', 'tomAi_applyEdit']);
}

/** All distinct `data-mcp-field` names the card renders. */
function cardFieldNames(html: string): string[] {
    const names = new Set<string>();
    for (const m of html.matchAll(/data-mcp-field="([^"]+)"/g)) {
        names.add(m[1]);
    }
    return [...names];
}

/** Extract the `saveMcpServer` gather branch body from listeners.js. */
function saveMcpServerBranch(js: string): string {
    const start = js.indexOf("action === 'saveMcpServer'");
    if (start < 0) { return ''; }
    // Grab a generous window — the branch is short and ends before the next
    // `else if` / the final `vscode.postMessage`.
    const rest = js.slice(start);
    const end = rest.indexOf("} else if");
    return end > 0 ? rest.slice(0, end) : rest.slice(0, 1200);
}

describe('saveMcpServer client gather — exists and is wired', () => {
    test('listeners.js has a saveMcpServer gather branch', () => {
        const branch = saveMcpServerBranch(readListenersJs());
        assert.notEqual(branch, '', 'expected a `saveMcpServer` branch in listeners.js');
    });
});

describe('saveMcpServer client gather — field parity with the card', () => {
    const fields = cardFieldNames(renderCard());
    const branch = saveMcpServerBranch(readListenersJs());

    test('the card actually renders the expected editable fields', () => {
        // Guard the guard: if the card stops rendering these, the parity check
        // below would pass vacuously, so pin the known set explicitly.
        assert.deepEqual(
            fields.sort(),
            ['allowWriteWithoutAuth', 'apiKeyEnv', 'autoStart', 'basePort', 'enabled', 'host', 'toolsEnabled'],
        );
    });

    for (const field of ['enabled', 'autoStart', 'host', 'basePort', 'apiKeyEnv', 'allowWriteWithoutAuth', 'toolsEnabled']) {
        test(`gather reads the "${field}" field`, () => {
            assert.ok(
                branch.includes(`'${field}'`) || branch.includes(`"${field}"`),
                `saveMcpServer gather must read the "${field}" field`,
            );
        });
    }

    test('gather collects the data-mcp-tool checkboxes into enabledTools', () => {
        assert.match(branch, /data-mcp-tool/);
        assert.match(branch, /enabledTools/);
    });
});
