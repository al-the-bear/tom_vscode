/**
 * Where the panels' local state files are kept (qrfix8; utils/panelYamlStore.ts): the timed requests, the chat
 * variables and the chat panels' drafts.
 *
 *   PS-1 the folder: `${aiFolder}/local` by default; the `tomAi.panelStoragePath` setting names another, absolute or
 *        workspace-relative; every file name the store builds (timed, chatvars, prompt-panel) is in that folder
 *   PS-2 the files written there name their schema relative to the folder they are in, so `$schema` resolves to the
 *        workspace's `.tom/json-schema/panels/…` from the default folder and from a configured one alike; read back
 *   PS-3 the setting is contributed (string, default empty, described), and the writers pass workspace-relative
 *        schemas — the timed requests' the panels' timed schema
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const EXT = path.join(__dirname, '..', '..', '..');
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-store-'));
const stub = installVscodeStub({ workspaceFolders: [ws], configuration: { tomAi: { panelStoragePath: '' } } });

import {
    getPanelFilePath, getPromptPanelFilePath, getStorageFolder, readPanelYamlSync, schemaRefFrom, writePanelYaml, writePromptPanelYaml,
} from '../panelYamlStore.js';

const setFolder = (value: string): void => { installVscodeStub({ configuration: { tomAi: { panelStoragePath: value } } }); };

describe('the panels\' state files', () => {
    test('PS-1: the folder', () => {
        setFolder('');
        assert.equal(getStorageFolder(), path.join(ws, '_ai', 'local'), 'the default');
        setFolder('state/panels');
        const folder = path.join(ws, 'state', 'panels');
        assert.equal(getStorageFolder(), folder, 'workspace-relative');
        for (const file of [getPanelFilePath('timed'), getPanelFilePath('chatvars'), getPromptPanelFilePath('anthropic')]) {
            assert.equal(path.dirname(file!), folder);
        }
        assert.match(path.basename(getPanelFilePath('timed')!), /_default\.timed\.yaml$/, 'the host-prefixed timed file');
        assert.equal(path.basename(getPromptPanelFilePath('anthropic')!), 'default.anthropic.prompt-panel.yaml');
        const abs = path.join(os.tmpdir(), 'panel-store-abs');
        setFolder(abs);
        assert.equal(getStorageFolder(), abs, 'absolute');
        stub.setWorkspaceFolders([]);
        assert.equal(getStorageFolder(), undefined, 'no workspace: no folder');
        stub.setWorkspaceFolders([ws]);
    });

    test('PS-2: $schema relative to the folder the file is in', async () => {
        assert.equal(schemaRefFrom(path.join(ws, '_ai', 'local'), ws, '.tom/json-schema/panels/chatvars.schema.json'), '../../.tom/json-schema/panels/chatvars.schema.json', 'from the default folder');
        for (const folder of ['', 'state/deep/panels']) {
            setFolder(folder);
            const chatvars = await writePanelYaml('chatvars', { quest: 'q1' }, '.tom/json-schema/panels/chatvars.schema.json');
            const draft = await writePromptPanelYaml('anthropic', { text: 'draft' });
            for (const [file, schema] of [[chatvars!, 'chatvars'], [draft!, 'prompt']] as const) {
                assert.equal(path.dirname(file), getStorageFolder());
                const ref = /^\$schema: (.+)$/m.exec(fs.readFileSync(file, 'utf8'))![1];
                assert.equal(path.resolve(path.dirname(file), ref), path.join(ws, '.tom', 'json-schema', 'panels', `${schema}.schema.json`), `${schema} from "${folder || 'the default'}"`);
            }
            assert.equal(readPanelYamlSync<{ quest: string }>('chatvars')?.quest, 'q1', 'read back from the same folder');
        }
        setFolder('');
        fs.rmSync(ws, { recursive: true, force: true });
    });

    test('PS-3: contributed, and the writers\' schemas', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
        const setting = pkg.contributes.configuration.properties['tomAi.panelStoragePath'];
        assert.equal(setting.type, 'string');
        assert.equal(setting.default, '');
        assert.match(setting.description, /Empty defaults to \$\{aiFolder\}\/local/);
        assert.match(setting.description, /timed\.yaml[\s\S]*chatvars\.yaml[\s\S]*prompt-panel\.yaml/);
        const src = (rel: string): string => fs.readFileSync(path.join(EXT, 'src', rel), 'utf8');
        assert.match(src('managers/timerEngine.ts'), /\}, '\.tom\/json-schema\/panels\/timed\.schema\.json'\);/);
        assert.match(src('handlers/chatVariablesEditor-handler.ts'), /writePanelYaml\('chatvars', data, '\.tom\/json-schema\/panels\/chatvars\.schema\.json'\)/);
        assert.doesNotMatch(src('utils/panelYamlStore.ts') + src('managers/timerEngine.ts') + src('handlers/chatVariablesEditor-handler.ts'), /'\.\.\/\.\.\//, 'no fixed ../../ schema path left');
    });
});
