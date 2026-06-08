/**
 * Contribution guard for the MCP Server lifecycle commands (plan §6, todo #13).
 *
 * `tomAi.mcpServer.start` / `.stop` / `.restart` must be declared in
 * `package.json` `contributes.commands` so they appear in the command palette
 * (the "commands appear" half of #13's done-when). The `registerCommand`
 * routing lands in extension.ts as plan todo #19 — this test pins only the
 * declaration, which is #13's scoped deliverable per the §10 file-map.
 *
 * Reading package.json is the same file-parity style as
 * `mcpServerClientGather.test.ts`; no `vscode` stub is needed.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface CommandContribution {
    command: string;
    title?: string;
    category?: string;
}

/** Parse package.json (project root is three levels up from out/utils/__tests__). */
function readContributedCommands(): CommandContribution[] {
    const pkgPath = join(__dirname, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const commands = pkg?.contributes?.commands;
    return Array.isArray(commands) ? commands : [];
}

describe('MCP Server lifecycle command contributions (#13)', () => {
    const commands = readContributedCommands();
    const byId = new Map(commands.map((c) => [c.command, c]));

    for (const id of ['tomAi.mcpServer.start', 'tomAi.mcpServer.stop', 'tomAi.mcpServer.restart']) {
        test(`declares "${id}" in contributes.commands`, () => {
            const cmd = byId.get(id);
            assert.ok(cmd, `expected "${id}" in package.json contributes.commands`);
            assert.ok(
                typeof cmd!.title === 'string' && cmd!.title.length > 0,
                `"${id}" must have a non-empty title`,
            );
            assert.equal(cmd!.category, '@Tom', `"${id}" must use the @Tom category`);
        });
    }
});
