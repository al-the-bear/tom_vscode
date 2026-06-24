/**
 * jsdom harness for the MCP Server card's client-side gather (plan §D, todo #10).
 *
 * The companion `mcpServerClientGather.test.ts` is a *static* parity guard: it
 * proves the gather *mentions* every field, but never executes it. This harness
 * goes one step further — it renders the real card (`renderMcpServerCard`),
 * loads the real `media/statusPage/listeners.js` into a jsdom DOM, fills the
 * controls, clicks the real "Save MCP Settings" button, and asserts the exact
 * payload `saveMcpServer` posts back. It exercises the gather end-to-end, so a
 * field that is rendered but not collected (or collected with the wrong
 * coercion) fails here even if the static guard still passes.
 *
 * This is the first webview-execution harness in the repo. Per the todo, it is
 * deliberately scoped to the MCP card only; if DOM-execution coverage grows
 * beyond this card it should move into the webview-restructuring initiative.
 *
 * `runScripts: 'outside-only'` lets us `window.eval` the listeners script in the
 * window's global scope (it declares plain functions, no module boundary) while
 * still injecting the ambient `vscode` host object the gather posts through.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { buildMcpServerCardModel, renderMcpServerCard } from '../mcpServerCard.js';

/** The tool option set the card renders checkboxes for. */
const TOOL_NAMES = ['tomAi_readFile', 'tomAi_applyEdit', 'tomAi_runCommand'];

/** Read the runtime webview listeners script (the source IS the runtime file). */
function readListenersJs(): string {
    // out/utils/__tests__ -> project root is three levels up, then media/...
    return readFileSync(
        join(__dirname, '..', '..', '..', 'media', 'statusPage', 'listeners.js'),
        'utf-8',
    );
}

/** The subset of TOOL_NAMES the card should treat as read-only. */
const READ_ONLY_NAMES = new Set(['tomAi_readFile']);

/** Render the card from a representative (all-default) model. */
function renderCardHtml(): string {
    const model = buildMcpServerCardModel(
        {
            enabled: false,
            host: '0.0.0.0',
            basePort: 19920,
            apiKeyEnv: '',
            allowWriteWithoutAuth: false,
            toolsEnabled: true,
            enabledTools: [],
        },
        { running: false },
        false,
    );
    return renderMcpServerCard(model, TOOL_NAMES, READ_ONLY_NAMES);
}

/** The shape `saveMcpServer` posts. Loosely typed — it's a webview message. */
interface GatherMessage {
    type?: string;
    action?: string;
    enabled?: unknown;
    autoStart?: unknown;
    host?: unknown;
    basePort?: unknown;
    apiKeyEnv?: unknown;
    allowWriteWithoutAuth?: unknown;
    toolsEnabled?: unknown;
    enabledTools?: unknown;
}

/**
 * Build a jsdom panel containing the real card, load `listeners.js`, bind the
 * listeners, and return the window + the array that captures posted messages.
 */
function setupGatherHarness(): { window: any; captured: GatherMessage[] } {
    const dom = new JSDOM(
        `<!DOCTYPE html><body><div class="sp-panel">${renderCardHtml()}</div></body>`,
        { runScripts: 'outside-only' },
    );
    const window = dom.window as any;
    const captured: GatherMessage[] = [];
    window.vscode = { postMessage: (m: GatherMessage) => { captured.push(m); } };
    window.eval(readListenersJs());
    // `true` = skip the per-section sub-editor init (not relevant to this card).
    window.eval('attachStatusPanelListeners(true)');
    return { window, captured };
}

/** Look up a `data-mcp-field` control in the harness DOM. */
function field(window: any, name: string): any {
    return window.document.querySelector(`[data-mcp-field="${name}"]`);
}

/** Look up a tool checkbox by its tool name. */
function toolBox(window: any, name: string): any {
    return window.document.querySelector(`[data-mcp-tool="${name}"]`);
}

/** Fire a native change event so the bound preset listeners run. */
function fireChange(window: any, el: any): void {
    el.dispatchEvent(new window.Event('change'));
}

/** Click the card's Save button (triggers the real gather). */
function clickSave(window: any): void {
    window.document.querySelector('[data-status-action="saveMcpServer"]').click();
}

describe('saveMcpServer gather — executed against a jsdom DOM (todo #10)', () => {
    test('clicking Save posts a single statusAction/saveMcpServer message', () => {
        const { window, captured } = setupGatherHarness();

        clickSave(window);

        assert.equal(captured.length, 1);
        assert.equal(captured[0].type, 'statusAction');
        assert.equal(captured[0].action, 'saveMcpServer');
    });

    test('the gather collects every editable field from the live DOM', () => {
        const { window, captured } = setupGatherHarness();

        field(window, 'enabled').checked = true;
        field(window, 'autoStart').checked = true;
        field(window, 'host').value = '127.0.0.1';
        field(window, 'basePort').value = '20005';
        field(window, 'apiKeyEnv').value = 'MY_MCP_KEY';
        field(window, 'allowWriteWithoutAuth').checked = true;
        field(window, 'toolsEnabled').value = 'custom';

        clickSave(window);

        const msg = captured[0];
        assert.equal(msg.enabled, true);
        assert.equal(msg.autoStart, true);
        assert.equal(msg.host, '127.0.0.1');
        // Raw value is sent; the server-side gather map does the coercion.
        assert.equal(msg.basePort, '20005');
        assert.equal(msg.apiKeyEnv, 'MY_MCP_KEY');
        assert.equal(msg.allowWriteWithoutAuth, true);
        // `toolsEnabled` mode 'custom' -> boolean false (use subset).
        assert.equal(msg.toolsEnabled, false);
    });

    test('custom mode collects only the checked tool checkboxes into enabledTools', () => {
        const { window, captured } = setupGatherHarness();

        field(window, 'toolsEnabled').value = 'custom';
        toolBox(window, 'tomAi_readFile').checked = true;
        toolBox(window, 'tomAi_runCommand').checked = true;

        clickSave(window);

        // `enabledTools` is built inside the jsdom realm, so copy it into this
        // realm before comparing (cross-realm arrays differ by prototype).
        // Grouped layout reorders the DOM, so compare order-independently.
        assert.deepEqual(
            Array.from(captured[0].enabledTools as unknown[]).sort(),
            ['tomAi_readFile', 'tomAi_runCommand'],
        );
    });

    test('readonly mode collects exactly the read-only tools, ignoring checkbox state', () => {
        const { window, captured } = setupGatherHarness();

        // Tick a NON-read-only tool to prove readonly mode ignores live ticks.
        toolBox(window, 'tomAi_applyEdit').checked = true;
        field(window, 'toolsEnabled').value = 'readonly';

        clickSave(window);

        const msg = captured[0];
        assert.equal(msg.toolsEnabled, false);
        assert.deepEqual(Array.from(msg.enabledTools as unknown[]), ['tomAi_readFile']);
    });

    test('selecting the Read-Only dropdown preset ticks exactly the read-only boxes', () => {
        const { window } = setupGatherHarness();

        const sel = field(window, 'toolsEnabled');
        sel.value = 'readonly';
        fireChange(window, sel);

        assert.equal(toolBox(window, 'tomAi_readFile').checked, true);
        assert.equal(toolBox(window, 'tomAi_applyEdit').checked, false);
        assert.equal(toolBox(window, 'tomAi_runCommand').checked, false);
    });

    test('the Read-Only bulk button ticks exactly the read-only boxes', () => {
        const { window } = setupGatherHarness();

        window.document.querySelector('[data-mcp-tools-readonly]').click();

        assert.equal(toolBox(window, 'tomAi_readFile').checked, true);
        assert.equal(toolBox(window, 'tomAi_applyEdit').checked, false);
    });

    test('per-group all/none buttons toggle only that group', () => {
        const { window } = setupGatherHarness();

        // tomAi_applyEdit lives in the "Workspace Edit" group.
        const group = window.document
            .querySelector('[data-mcp-tool="tomAi_applyEdit"]')
            .closest('[data-mcp-group]');
        const groupName = group.getAttribute('data-mcp-group');
        window.document.querySelector(`[data-mcp-group-all="${groupName}"]`).click();

        assert.equal(toolBox(window, 'tomAi_applyEdit').checked, true);
        // A tool in a different group is untouched.
        assert.equal(toolBox(window, 'tomAi_readFile').checked, false);
    });

    test('clicking Save collapses the configuration accordion (closes on save)', () => {
        const { window } = setupGatherHarness();

        // Open the configuration accordion first (it renders collapsed).
        const content = window.document.getElementById('sp-mcpConfig-content');
        content.classList.remove('sp-collapsed');
        assert.equal(content.classList.contains('sp-collapsed'), false);

        clickSave(window);

        assert.equal(content.classList.contains('sp-collapsed'), true);
        const icon = content.previousElementSibling.querySelector('.sp-collapse-icon');
        assert.equal(icon.textContent, '▶');
    });

    test('an all-default card posts the defaults (enabled off, toolsEnabled on, no tools)', () => {
        const { window, captured } = setupGatherHarness();

        clickSave(window);

        const msg = captured[0];
        assert.equal(msg.enabled, false);
        assert.equal(msg.autoStart, false);
        assert.equal(msg.host, '0.0.0.0');
        assert.equal(msg.allowWriteWithoutAuth, false);
        assert.equal(msg.toolsEnabled, true);
        assert.deepEqual(Array.from(msg.enabledTools as unknown[]), []);
    });
});
