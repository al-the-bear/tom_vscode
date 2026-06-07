/**
 * Parity guard for the MCP Server card's lifecycle buttons (plan §6, todo #5).
 *
 * The card's Start/Stop/Restart buttons were inert: rendered with a
 * `data-status-action`, but the Status-Page handler had no case routing those
 * actions to the lifecycle commands, so only the palette commands worked. This
 * guard pins both halves of the wiring so the buttons can never silently go
 * inert again:
 *   1. the card renders a `data-status-action` button for start, stop AND restart;
 *   2. the no-payload actions ride the generic `[data-status-action]` dispatcher
 *      in `listeners.js` (the same path `restartBridge` uses — no per-action
 *      branch needed), which posts `{ type: 'statusAction', action }`;
 *   3. `statusPage-handler.ts` routes each action to its `tomAi.mcpServer.*`
 *      command (the single entry point — the handler does NOT re-implement
 *      start/stop).
 *
 * Like `mcpServerClientGather.test.ts`, this is a static-parity guard: the repo
 * has no DOM / command-dispatch harness, so the card render (pure, type-only
 * deps — no `vscode` stub) and the handler/listeners source are read as text.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildMcpServerCardModel, renderMcpServerCard } from '../mcpServerCard.js';

// out/utils/__tests__ -> project root is three levels up.
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

/** The card HTML, rendered from a representative model. */
function renderCard(): string {
    const model = buildMcpServerCardModel(
        {
            enabled: true,
            autoStart: false,
            host: '0.0.0.0',
            basePort: 19920,
            apiKeyEnv: 'MCP_KEY',
            allowWriteWithoutAuth: false,
            toolsEnabled: true,
            enabledTools: ['tomAi_readFile'],
        },
        { running: false },
    );
    return renderMcpServerCard(model, ['tomAi_readFile', 'tomAi_applyEdit']);
}

const readHandler = (): string =>
    readFileSync(join(PROJECT_ROOT, 'src', 'handlers', 'statusPage-handler.ts'), 'utf-8');

const readListenersJs = (): string =>
    readFileSync(join(PROJECT_ROOT, 'media', 'statusPage', 'listeners.js'), 'utf-8');

/** The three lifecycle actions and the commands they must route to. */
const LIFECYCLE: ReadonlyArray<{ action: string; command: string }> = [
    { action: 'startMcpServer', command: 'tomAi.mcpServer.start' },
    { action: 'stopMcpServer', command: 'tomAi.mcpServer.stop' },
    { action: 'restartMcpServer', command: 'tomAi.mcpServer.restart' },
];

describe('MCP card lifecycle buttons — render + routing parity (todo #5)', () => {
    const card = renderCard();
    const handler = readHandler();
    const listeners = readListenersJs();

    for (const { action } of LIFECYCLE) {
        test(`card renders a data-status-action button for "${action}"`, () => {
            assert.match(
                card,
                new RegExp(`data-status-action="${action}"`),
                `card must render the ${action} button`,
            );
        });
    }

    test('the generic [data-status-action] dispatcher posts a statusAction message', () => {
        // No-payload lifecycle actions ride the generic dispatcher (like
        // restartBridge), so no per-action branch is required in listeners.js.
        assert.match(listeners, /\[data-status-action\]/);
        assert.match(listeners, /type:\s*'statusAction'/);
    });

    for (const { action, command } of LIFECYCLE) {
        test(`handler routes "${action}" to the "${command}" command`, () => {
            assert.ok(
                handler.includes(`'${action}'`),
                `handler must have a statusAction case for ${action}`,
            );
            assert.ok(
                handler.includes(`'${command}'`),
                `handler must executeCommand ${command} for ${action}`,
            );
        });
    }
});
