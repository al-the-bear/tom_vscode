/**
 * The Up / Down buttons of the editors with a list on the left, on the host side, through the vscode stub in a
 * sandbox root of its own (its `.tom/tom_vscode_extension.json` is the configuration read and written).
 *
 *   EO-1 a list kept in the configuration (profiles, templates) is reordered in its array, so every picker
 *        follows: moveTemplateItemInConfig moves the entry, refuses at the ends, for an unknown id and for a
 *        category that is one fixed entry
 *   EO-2 a file-based list gets a stored order: moveInStoredOrder writes `editorListOrder[<key>]` into the
 *        configuration, inStoredOrder shows the list in it, an entry created later follows the placed ones, a
 *        move that cannot be made stores nothing; the other configuration keys stay
 *   EO-3 the Role Editor and the Role Type Editor: `move` answers `order` (the ids as shown now) and not `data`,
 *        so the form being edited stays; the data read afterwards is in that order; each kind has its own list
 *        key; the role folders are not renamed
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261119_listorder-')));
const WS = path.join(SANDBOX, 'ws');
const CONFIG = path.join(SANDBOX, '.tom', 'tom_vscode_extension.json');
fs.mkdirSync(path.join(SANDBOX, '.tom'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, '.tom', 'tom_root.yaml'), 'root: true\n');
fs.writeFileSync(CONFIG, JSON.stringify({ userName: 'kept' }, null, 2));
fs.mkdirSync(path.join(WS, '_ai'), { recursive: true });
process.env.HOME = path.join(SANDBOX, 'home');
process.env.USERPROFILE = process.env.HOME;
fs.mkdirSync(process.env.HOME, { recursive: true });

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const vs = installVscodeStub({ workspaceFolders: [WS] });
after(() => { vs.restore(); fs.rmSync(SANDBOX, { recursive: true, force: true }); });

import { inStoredOrder, moveInStoredOrder, storedListOrder } from '../../services/editorListOrder.js';
import { RoleStore } from '../../services/roleStore.js';
import type { SendToChatConfig } from '../../utils/sendToChatConfig.js';
import { moveTemplateItemInConfig } from '../globalTemplateEditor-handler.js';
import { handleRolesEditorMessage, rolesEditorData } from '../rolesEditor-handler.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const onDisk = (): Json => JSON.parse(fs.readFileSync(CONFIG, 'utf-8'));
const item = (id: string) => ({ id });
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);

describe('editor lists: Up / Down on the host', () => {
    test('EO-1: a configuration list is reordered in its array', () => {
        const config = {
            anthropic: { profiles: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }], userMessageTemplates: [{ id: 'u1' }, { id: 'u2' }] },
            reminders: { templates: [{ id: 'r1' }, { id: 'r2' }] },
        } as unknown as SendToChatConfig;
        assert.equal(moveTemplateItemInConfig(config, 'anthropicProfiles', 'p3', 'up'), true);
        assert.deepEqual(ids(config.anthropic!.profiles as Json), ['p1', 'p3', 'p2']);
        assert.equal(moveTemplateItemInConfig(config, 'anthropicProfiles', 'p1', 'up'), false);
        assert.equal(moveTemplateItemInConfig(config, 'anthropicProfiles', 'p2', 'down'), false);
        assert.equal(moveTemplateItemInConfig(config, 'anthropicProfiles', 'nope', 'down'), false);
        assert.deepEqual(ids(config.anthropic!.profiles as Json), ['p1', 'p3', 'p2']);
        assert.equal(moveTemplateItemInConfig(config, 'reminder', 'r1', 'down'), true);
        assert.deepEqual(ids((config as Json).reminders.templates), ['r2', 'r1']);
        assert.deepEqual(ids(config.anthropic!.userMessageTemplates as Json), ['u1', 'u2'], 'the other lists stay');
        assert.equal(moveTemplateItemInConfig(config, 'compaction', 'c1', 'down'), false, 'a list the configuration does not have');
        assert.equal(moveTemplateItemInConfig(config, 'copilotQueueWrapper' as never, 'x', 'down'), false, 'one fixed entry: nothing to order');
    });

    test('EO-2: a file-based list gets a stored order', () => {
        const files = [item('alpha'), item('beta'), item('gamma')];
        assert.equal(storedListOrder('queueTemplates'), undefined);
        assert.deepEqual(ids(inStoredOrder('queueTemplates', files, (i) => i.id)), ['alpha', 'beta', 'gamma']);
        assert.equal(moveInStoredOrder('queueTemplates', ids(files), 'gamma', 'up'), true);
        assert.deepEqual(onDisk().editorListOrder, { queueTemplates: ['alpha', 'gamma', 'beta'] });
        assert.equal(onDisk().userName, 'kept');
        assert.deepEqual(ids(inStoredOrder('queueTemplates', [...files, item('aaa')], (i) => i.id)), ['alpha', 'gamma', 'beta', 'aaa'], 'a new entry follows');
        assert.equal(moveInStoredOrder('queueTemplates', ['alpha', 'gamma', 'beta'], 'alpha', 'up'), false);
        assert.deepEqual(onDisk().editorListOrder, { queueTemplates: ['alpha', 'gamma', 'beta'] });
        assert.equal(moveInStoredOrder('reusablePrompts:global', ['x', 'y'], 'x', 'down'), true);
        assert.deepEqual(onDisk().editorListOrder, { queueTemplates: ['alpha', 'gamma', 'beta'], 'reusablePrompts:global': ['y', 'x'] });
    });

    test('EO-3: the Role Editor and the Role Type Editor', async () => {
        const ai = path.join(WS, '_ai');
        for (const role of ['architect', 'builder', 'critic']) {
            fs.mkdirSync(path.join(ai, 'roles', role), { recursive: true });
            fs.writeFileSync(path.join(ai, 'roles', role, 'role.md'), `# ${role}\n`);
        }
        for (const type of ['reader', 'writer']) {
            fs.mkdirSync(path.join(ai, 'role-types', type), { recursive: true });
            fs.writeFileSync(path.join(ai, 'role-types', type, 'role-type.yaml'), `name: ${type}\ntools:\n  mode: profile\n`);
        }
        const store = new RoleStore(path.join(SANDBOX, '.tom'), ai);
        const ui = { ask: async () => undefined, confirm: async () => true, error: (m: string) => { throw new Error(m); }, info: () => undefined };
        const shown = (kind: 'roles' | 'roleTypes') => ids(rolesEditorData(kind, store).items as Json);
        assert.deepEqual(shown('roles'), ['architect', 'builder', 'critic']);

        const answer = await handleRolesEditorMessage('roles', { type: 'move', id: 'critic', direction: 'up' }, store, ui);
        assert.deepEqual(answer, { type: 'order', ids: ['architect', 'critic', 'builder'] });
        assert.deepEqual(shown('roles'), ['architect', 'critic', 'builder']);
        assert.deepEqual(onDisk().editorListOrder.roles, ['architect', 'critic', 'builder']);
        assert.equal(await handleRolesEditorMessage('roles', { type: 'move', id: 'architect', direction: 'up' }, store, ui), undefined);
        assert.equal(await handleRolesEditorMessage('roles', { type: 'move', id: 'critic', direction: 'sideways' }, store, ui), undefined);
        assert.deepEqual(fs.readdirSync(path.join(ai, 'roles')).sort(), ['architect', 'builder', 'critic'], 'the folders stay');

        assert.deepEqual(shown('roleTypes'), ['reader', 'writer']);
        assert.deepEqual(await handleRolesEditorMessage('roleTypes', { type: 'move', id: 'reader', direction: 'down' }, store, ui), { type: 'order', ids: ['writer', 'reader'] });
        assert.deepEqual(onDisk().editorListOrder.roleTypes, ['writer', 'reader']);
        assert.deepEqual(shown('roles'), ['architect', 'critic', 'builder'], 'the roles keep their own order');
        // The role type picker of the Role Editor lists the types in their order too.
        assert.deepEqual(ids(rolesEditorData('roles', store).roleTypes as Json), ['writer', 'reader']);
    });
});
