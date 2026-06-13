/**
 * Tests for extensionConfigStore — the owner of the two consolidated per-quest
 * config files (`extension_config.{quest}.yaml` and
 * `extension_config.{host}.{quest}.yaml`).
 *
 * Covers: path resolution, section-scoped read/write that preserves unknown
 * sections, the CLI/MCP autostart helpers, the telegram machine/quest field
 * split + merge, and the one-time migration from the legacy per-subsystem files.
 *
 * `vscode` is stubbed before importing the store (which requires it via
 * WsPaths); a throwaway workspace root lets the store resolve files into a temp
 * dir we inspect on disk.
 */

import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const stubHandle = installVscodeStub({});

import { WsPaths } from '../workspacePaths.js';
import {
    questConfigPath,
    machineConfigPath,
    readQuestSection,
    readMachineSection,
    writeQuestSection,
    writeMachineSection,
    getCliServerAutostart,
    setCliServerAutostart,
    getMcpServerAutostart,
    setMcpServerAutostart,
    getMcpServerConfig,
    readMergedTelegramRaw,
    writeSplitTelegramRaw,
    migrateQuestExtensionConfig,
} from '../../managers/extensionConfigStore.js';

const QUEST = 'cfgstore_test_quest';

function freshWorkspace(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-cfgstore-'));
    stubHandle.setWorkspaceFolders([root]);
    return root;
}

function questDir(root: string): string {
    return path.join(root, '_ai', 'quests', QUEST);
}

function readYaml(filePath: string): any {
    return parseYaml(fs.readFileSync(filePath, 'utf-8'));
}

describe('extensionConfigStore — path resolution', () => {
    let root: string;
    beforeEach(() => { root = freshWorkspace(); });

    test('questConfigPath is host-independent', () => {
        assert.equal(
            questConfigPath(QUEST),
            path.join(questDir(root), `extension_config.${QUEST}.yaml`),
        );
    });

    test('machineConfigPath carries the host slug', () => {
        assert.equal(
            machineConfigPath(QUEST),
            path.join(questDir(root), `extension_config.${WsPaths.hostSlug()}.${QUEST}.yaml`),
        );
    });
});

describe('extensionConfigStore — section read/write', () => {
    let root: string;
    beforeEach(() => { root = freshWorkspace(); });

    test('absent file → section is undefined', () => {
        assert.equal(readQuestSection('telegram', QUEST), undefined);
        assert.equal(readMachineSection('cliServer', QUEST), undefined);
    });

    test('write then read round-trips a section', () => {
        writeQuestSection('telegram', { defaultChatId: 42 }, QUEST);
        assert.deepEqual(readQuestSection('telegram', QUEST), { defaultChatId: 42 });
    });

    test('writing one section preserves unknown sections in the same file', () => {
        writeMachineSection('cliServer', { autostart: true }, QUEST);
        writeMachineSection('mcpServer', { autostart: false }, QUEST);
        // A foreign section written out-of-band must survive a later write.
        const doc = readYaml(machineConfigPath(QUEST));
        doc.someOtherSubsystem = { keep: 'me' };
        fs.writeFileSync(machineConfigPath(QUEST), stringifyYaml(doc), 'utf-8');

        writeMachineSection('cliServer', { autostart: false }, QUEST);

        const after = readYaml(machineConfigPath(QUEST));
        assert.deepEqual(after.someOtherSubsystem, { keep: 'me' });
        assert.deepEqual(after.cliServer, { autostart: false });
        assert.deepEqual(after.mcpServer, { autostart: false });
    });

    test('writing undefined removes the section', () => {
        writeQuestSection('telegram', { a: 1 }, QUEST);
        writeQuestSection('telegram', undefined, QUEST);
        assert.equal(readQuestSection('telegram', QUEST), undefined);
    });
});

describe('extensionConfigStore — CLI/MCP autostart helpers (machine file)', () => {
    let root: string;
    beforeEach(() => { root = freshWorkspace(); });

    test('default is false when unset', () => {
        assert.equal(getCliServerAutostart(QUEST), false);
        assert.equal(getMcpServerAutostart(QUEST), false);
    });

    test('set/get round-trip and land in the machine file', () => {
        setCliServerAutostart(true, QUEST);
        setMcpServerAutostart(true, QUEST);
        assert.equal(getCliServerAutostart(QUEST), true);
        assert.equal(getMcpServerAutostart(QUEST), true);

        const doc = readYaml(machineConfigPath(QUEST));
        assert.deepEqual(doc.cliServer, { autostart: true });
        assert.deepEqual(doc.mcpServer, { autostart: true });
    });
});

describe('extensionConfigStore — telegram split / merge', () => {
    let root: string;
    beforeEach(() => { root = freshWorkspace(); });

    test('split routes machine fields to the machine file and the rest to the quest file', () => {
        writeSplitTelegramRaw({
            enabled: true,
            autostart: true,
            botTokenEnv: 'TG_TOKEN',
            defaultChatId: 99,
            notifyOnTurn: false,
            botToken: 'SECRET',
        }, QUEST);

        const machine = readYaml(machineConfigPath(QUEST)).telegram;
        const quest = readYaml(questConfigPath(QUEST)).telegram;

        // The exact-equality assertions below also prove botToken is never
        // persisted to either file (it is absent from both objects).
        assert.deepEqual(machine, { enabled: true, autostart: true, botTokenEnv: 'TG_TOKEN' });
        assert.deepEqual(quest, { defaultChatId: 99, notifyOnTurn: false });
    });

    test('merge overlays machine fields over the quest fields', () => {
        writeSplitTelegramRaw({
            enabled: true,
            botTokenEnv: 'TG_TOKEN',
            defaultChatId: 99,
            notifyOnTurn: false,
        }, QUEST);

        assert.deepEqual(readMergedTelegramRaw(QUEST), {
            defaultChatId: 99,
            notifyOnTurn: false,
            enabled: true,
            botTokenEnv: 'TG_TOKEN',
        });
    });

    test('merge returns undefined when neither file has a telegram section', () => {
        assert.equal(readMergedTelegramRaw(QUEST), undefined);
    });
});

describe('extensionConfigStore — migration from legacy files', () => {
    let root: string;
    beforeEach(() => { root = freshWorkspace(); });

    function writeLegacyQuestRefresh(): void {
        const p = path.join(questDir(root), `quest-refresh.${WsPaths.hostSlug()}.${QUEST}.yaml`);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, stringifyYaml({
            panels: {
                anthropic: { active: true, count: 3 },
                localLlm: { active: false, count: 0 },
                copilot: { active: false, count: 0 },
            },
        }), 'utf-8');
    }

    function writeLegacyTelegram(): void {
        const p = path.join(questDir(root), `telegram.${WsPaths.hostSlug()}.${QUEST}.yaml`);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, stringifyYaml({
            enabled: true,
            botTokenEnv: 'TG_TOKEN',
            defaultChatId: 7,
        }), 'utf-8');
    }

    function writeLegacyJsonAutostart(): void {
        const p = path.join(root, '.tom', WsPaths.configFileName);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify({
            bridge: { cliServerAutostart: true, profiles: {} },
            mcpServer: { enabled: true, autoStart: true, basePort: 20001, host: '127.0.0.1' },
        }), 'utf-8');
    }

    test('migrates quest-refresh, telegram, and autostart into the two files', () => {
        writeLegacyQuestRefresh();
        writeLegacyTelegram();
        writeLegacyJsonAutostart();

        migrateQuestExtensionConfig(QUEST);

        assert.deepEqual(readMachineSection('questRefresh', QUEST), {
            panels: {
                anthropic: { active: true, count: 3 },
                localLlm: { active: false, count: 0 },
                copilot: { active: false, count: 0 },
            },
        });
        assert.deepEqual(readMergedTelegramRaw(QUEST), {
            defaultChatId: 7,
            enabled: true,
            botTokenEnv: 'TG_TOKEN',
        });
        assert.equal(getCliServerAutostart(QUEST), true);
        assert.equal(getMcpServerAutostart(QUEST), true);
        // The non-autostart MCP settings migrate into the machine-independent
        // quest `mcpServer` section; the autostart-only keys are dropped.
        assert.deepEqual(getMcpServerConfig(QUEST), {
            enabled: true,
            basePort: 20001,
            host: '127.0.0.1',
        });
    });

    test('is idempotent and does not overwrite already-migrated sections', () => {
        writeLegacyQuestRefresh();
        migrateQuestExtensionConfig(QUEST);
        // Mutate the migrated section, then re-run: it must be left alone.
        writeMachineSection('questRefresh', { panels: { sentinel: true } }, QUEST);
        migrateQuestExtensionConfig(QUEST);
        assert.deepEqual(readMachineSection('questRefresh', QUEST), { panels: { sentinel: true } });
    });

    test('no-op when no legacy files exist', () => {
        migrateQuestExtensionConfig(QUEST);
        assert.equal(readMachineSection('questRefresh', QUEST), undefined);
        assert.equal(readMergedTelegramRaw(QUEST), undefined);
        assert.equal(getCliServerAutostart(QUEST), false);
    });
});
