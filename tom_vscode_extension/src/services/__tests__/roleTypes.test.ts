/**
 * Roles and role types (vscimpb87): src/utils/roleTypes.ts, src/services/roleStore.ts,
 * src/handlers/rolesEditor-handler.ts and media/rolesEditor/.
 *
 *   RL-1 the schemas: the extension's copies (src/config) equal the workspace's (.tom/json-schema/roles); the role
 *        types in _ai/role-types validate; every always-on tool is a registered tool and in the editors' list
 *   RL-2 the store: a new role gets a role.md and no role-config.yaml; saving it with a type writes
 *        role-config.yaml (its `$schema` line pointing at the workspace's schema); without a type an existing file
 *        keeps no type; an unknown type is refused; a role type is written valid, without the always-on tools,
 *        sorted; an invalid one (a bad tool name, an unknown mode) is refused and nothing is written; a type a role
 *        names cannot be deleted
 *   RL-3 the resolution: the role's type's tools with the always-on ones; the profile's tools without a role, as
 *        `default`, without role-config.yaml, without a type, with a type in profileDefault, a type that does not
 *        exist or a file that does not validate
 *   RL-4 a profile with a tool selection of its own gets the always-on tools; all tools stay all; none stays none;
 *        the Prompt Template Editor shows them greyed and on and never saves them in the list
 *   RL-5 the editors' host: the data of each mode, Save / Add / Delete through the store, a refusal shown, the two
 *        commands in package.json, the catalogue and the template's sources
 *   RL-6 the editors' webview: the list, the role form (role.md, the type picker), the role-type form (the mode,
 *        the tools by group, the always-on ones greyed and on); Save posts the item without the always-on tools
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { ALWAYS_ON_TOOLS, parseRoleType, resolveRoleTools, roleSchemaPath, validateRoleFile, withAlwaysOnTools } from '../../utils/roleTypes.js';
import { RoleStore } from '../roleStore.js';
import { handleRolesEditorMessage, rolesEditorData } from '../../handlers/rolesEditor-handler.js';
import { ALL_SHARED_TOOLS, resolveProfileTools } from '../../tools/tool-executors.js';
import { AVAILABLE_LLM_TOOLS } from '../../utils/constants.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const WS = path.resolve(EXT, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(EXT, ...p), 'utf8');

function sandbox(): { ws: string; ai: string; store: RoleStore } {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'role-types-')));
    const ai = path.join(ws, '_ai');
    fs.mkdirSync(path.join(ai, 'roles'), { recursive: true });
    return { ws, ai, store: new RoleStore(ws, ai) };
}

describe('roles and role types', () => {
    test('RL-1: the schemas, the seeded role types, the always-on tools', () => {
        for (const name of ['role-type.schema.json', 'role-config.schema.json']) {
            assert.equal(fs.readFileSync(path.join(WS, '.tom', 'json-schema', 'roles', name), 'utf8'), read('src', 'config', name), `${name}: the workspace's copy is the extension's`);
        }
        assert.equal(roleSchemaPath('roleType'), path.join(EXT, 'out', 'config', 'role-type.schema.json'));
        const typesDir = path.join(WS, '_ai', 'role-types');
        const seeded = fs.existsSync(typesDir) ? fs.readdirSync(typesDir) : [];
        assert.ok(seeded.includes('document-author') && seeded.includes('coder'), 'the example role types');
        for (const t of seeded) {
            const parsed = parseRoleType(fs.readFileSync(path.join(typesDir, t, 'role-type.yaml'), 'utf8'));
            assert.ok(parsed.ok, `${t}: ${parsed.ok ? '' : parsed.errors.join('; ')}`);
            for (const tool of parsed.ok ? parsed.value.tools.enabled ?? [] : []) {
                assert.ok((AVAILABLE_LLM_TOOLS as readonly string[]).includes(tool), `${t}: ${tool} is a known tool`);
            }
        }
        for (const tool of ALWAYS_ON_TOOLS) {
            assert.ok(ALL_SHARED_TOOLS.some((t) => t.name === tool), `${tool} registered`);
            assert.ok((AVAILABLE_LLM_TOOLS as readonly string[]).includes(tool), `${tool} in the editors' list`);
        }
    });

    test('RL-2: the store writes valid files and refuses invalid ones', () => {
        const { ws, ai, store } = sandbox();
        store.createRole('doc_writer');
        assert.match(fs.readFileSync(path.join(ai, 'roles', 'doc_writer', 'role.md'), 'utf8'), /^# Doc Writer\n/);
        assert.ok(!fs.existsSync(path.join(ai, 'roles', 'doc_writer', 'role-config.yaml')), 'no type: no config file');
        assert.throws(() => store.saveRole('doc_writer', '# Doc', 'missing'), /role type "missing" does not exist/);
        store.saveRoleType('writer', { name: 'Writer', tools: { mode: 'selected', enabled: ['tomAi_readFile', 'tomAi_askUser', 'tomAi_editFile'] } });
        const typeText = fs.readFileSync(path.join(ai, 'role-types', 'writer', 'role-type.yaml'), 'utf8');
        assert.match(typeText, /^# yaml-language-server: \$schema=\.\.\/\.\.\/\.\.\/\.tom\/json-schema\/roles\/role-type\.schema\.json\n/);
        const parsed = parseRoleType(typeText);
        assert.ok(parsed.ok);
        assert.deepEqual(parsed.ok && parsed.value.tools, { mode: 'selected', enabled: ['tomAi_editFile', 'tomAi_readFile'] }, 'sorted, the always-on tool left out');
        store.saveRole('doc_writer', '# Doc', 'writer');
        const configText = fs.readFileSync(path.join(ai, 'roles', 'doc_writer', 'role-config.yaml'), 'utf8');
        assert.equal(configText, '# yaml-language-server: $schema=../../../.tom/json-schema/roles/role-config.schema.json\nroleType: writer\n');
        assert.deepEqual(store.role('doc_writer'), { id: 'doc_writer', roleMd: '# Doc\n', roleType: 'writer' });
        assert.deepEqual(store.roleTypes().map((t) => [t.id, t.usedBy]), [['writer', ['doc_writer']]]);
        assert.throws(() => store.deleteRoleType('writer'), /named by doc_writer/);
        store.saveRole('doc_writer', '# Doc', '');
        assert.match(fs.readFileSync(path.join(ai, 'roles', 'doc_writer', 'role-config.yaml'), 'utf8'), /\n\{\}\n$/, 'an existing file keeps no type');
        store.deleteRoleType('writer');
        assert.ok(!fs.existsSync(path.join(ai, 'role-types', 'writer')));
        assert.throws(() => store.saveRoleType('bad', { tools: { mode: 'selected', enabled: ['not a tool!'] } }), /does not match its schema/);
        assert.throws(() => store.saveRoleType('bad2', { tools: { mode: 'everything' as never } }), /does not match its schema/);
        assert.ok(!fs.existsSync(path.join(ai, 'role-types', 'bad')) && !fs.existsSync(path.join(ai, 'role-types', 'bad2')), 'nothing written');
        assert.throws(() => store.createRole('../x'), /not a role name/);
        assert.deepEqual(validateRoleFile('roleConfig', { roleType: 'x', more: 1 }).length > 0, true, 'no other keys yet');
        fs.rmSync(ws, { recursive: true, force: true });
    });

    test('RL-3: the resolution', () => {
        const { ws, ai, store } = sandbox();
        store.saveRoleType('narrow', { tools: { mode: 'selected', enabled: ['tomAi_readFile'] } });
        store.saveRoleType('wide', { tools: { mode: 'profileDefault' } });
        store.createRole('a'); store.saveRole('a', '# A', 'narrow');
        store.createRole('b'); store.saveRole('b', '# B', 'wide');
        store.createRole('c');
        const r = resolveRoleTools(ai, 'a');
        assert.equal(r.roleType, 'narrow');
        assert.deepEqual([...r.tools!].sort(), [...ALWAYS_ON_TOOLS, 'tomAi_readFile'].sort());
        for (const [role, note] of [[undefined, /no role/], ['default', /no role/], ['c', /has no role-config\.yaml/], ['b', /keeps the profile's tools/]] as const) {
            const res = resolveRoleTools(ai, role);
            assert.equal(res.tools, undefined, String(role));
            assert.match(res.note ?? '', note);
        }
        fs.writeFileSync(path.join(ai, 'roles', 'c', 'role-config.yaml'), 'roleType: gone\n');
        assert.match(resolveRoleTools(ai, 'c').note ?? '', /role type gone does not exist/);
        fs.writeFileSync(path.join(ai, 'roles', 'c', 'role-config.yaml'), 'roleType: [x]\n');
        assert.match(resolveRoleTools(ai, 'c').note ?? '', /is not valid/);
        fs.writeFileSync(path.join(ai, 'roles', 'c', 'role-config.yaml'), '{}\n');
        assert.match(resolveRoleTools(ai, 'c').note ?? '', /names no role type/);
        fs.rmSync(ws, { recursive: true, force: true });
    });

    test('RL-4: profiles and the always-on tools', () => {
        const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name).sort();
        assert.equal(resolveProfileTools(undefined).length, ALL_SHARED_TOOLS.length, 'all stays all');
        assert.deepEqual(resolveProfileTools({ toolsEnabled: false, enabledTools: [] }), [], 'none stays none');
        assert.deepEqual(names(resolveProfileTools({ toolsEnabled: false, enabledTools: ['tomAi_readFile'] }, true)), [...ALWAYS_ON_TOOLS, 'tomAi_readFile'].sort());
        assert.deepEqual(names(resolveProfileTools({ toolsEnabled: false, enabledTools: ['tomAi_readFile'] })), ['tomAi_readFile'], 'the MCP server\'s custom list: as listed');
        assert.deepEqual(resolveProfileTools({ toolsEnabled: false, enabledTools: [] }, true), [], 'none stays none, also for a profile');
        for (const file of ['chatPanel-handler.ts', 'sendToChatRouter.ts']) {
            assert.match(read('src', 'handlers', file), /resolveProfileTools\(\s*profile as unknown as \{ enabledTools\?: string\[\]; toolsEnabled\?: boolean \},\s*true,\s*\)/, file);
        }
        assert.deepEqual(withAlwaysOnTools([]), []);
        const handler = read('src', 'handlers', 'globalTemplateEditor-handler.ts');
        assert.match(handler, /name: 'enabledTools', label: 'Tools', type: 'multi-checkbox', [^\n]*lockedOptions: \[\.\.\.ALWAYS_ON_TOOLS\]/);
        const main = read('media', 'globalTemplateEditor', 'main.js');
        assert.match(main, /var lockAttr = isLocked \? ' data-locked="true" disabled' : '';/);
        assert.match(main, /if \(cb\.getAttribute\('data-locked'\) === 'true'\) \{ return; \}/, 'stays disabled');
        assert.match(main, /if \(cb\.checked && cb\.getAttribute\('data-locked'\) !== 'true'\) \{ picked\.push\(cb\.value\); \}/, 'never saved');
    });

    test('RL-5: the editors\' host', async () => {
        const { ws, store } = sandbox();
        const shown: string[] = [];
        let answer: string | undefined = 'reviewer';
        const ui = { ask: async () => answer, confirm: async () => true, error: (m: string) => { shown.push(`error: ${m}`); }, info: (m: string) => { shown.push(m); } };
        const added = await handleRolesEditorMessage('roleTypes', { type: 'add' }, store, ui);
        assert.equal(added?.selected, 'reviewer');
        assert.deepEqual((added?.items as Array<{ id: string }>).map((i) => i.id), ['reviewer']);
        assert.deepEqual(added?.alwaysOn, [...ALWAYS_ON_TOOLS]);
        assert.ok((added?.toolGroups as Array<{ category: string; tools: string[] }>).some((g) => g.tools.includes('tomAi_readFile')));
        await handleRolesEditorMessage('roleTypes', { type: 'save', id: 'reviewer', value: { tools: { mode: 'selected', enabled: ['tomAi_readFile'] } } }, store, ui);
        assert.deepEqual(store.roleTypes()[0].value?.tools, { mode: 'selected', enabled: ['tomAi_readFile'] });
        await handleRolesEditorMessage('roleTypes', { type: 'save', id: 'reviewer', value: { tools: { mode: 'bogus' } } }, store, ui);
        assert.match(shown.at(-1) ?? '', /^error: The role type does not match its schema/);
        answer = 'checker';
        await handleRolesEditorMessage('roles', { type: 'add' }, store, ui);
        const saved = await handleRolesEditorMessage('roles', { type: 'save', id: 'checker', roleMd: '# Checker\n', roleType: 'reviewer' }, store, ui);
        assert.deepEqual((saved?.items as unknown[]), [{ id: 'checker', roleMd: '# Checker\n', roleType: 'reviewer' }]);
        assert.deepEqual(saved?.roleTypes, [{ id: 'reviewer', name: 'reviewer' }]);
        await handleRolesEditorMessage('roleTypes', { type: 'delete', id: 'reviewer' }, store, ui);
        assert.match(shown.at(-1) ?? '', /named by checker/);
        answer = 'Bad Name';
        assert.equal(await handleRolesEditorMessage('roles', { type: 'add' }, store, ui), undefined);
        assert.match(shown.at(-1) ?? '', /is not a valid name/);
        assert.equal(rolesEditorData('roles', undefined).error, 'No workspace is open.');
        const pkg = JSON.parse(read('package.json')) as { contributes: { commands: Array<{ command: string; title: string }> } };
        assert.deepEqual(pkg.contributes.commands.filter((c) => c.command.startsWith('tomAi.editor.role')).map((c) => [c.command, c.title]),
            [['tomAi.editor.roles', '@T: Open Role Editor'], ['tomAi.editor.roleTypes', '@T: Open Role Type Editor']]);
        assert.match(read('src', 'utils', 'extensionToolsCatalog.ts'), /id: 'roles', label: 'Role Editor', group: 'quest'[\s\S]*id: 'roleTypes', label: 'Role Type Editor', group: 'quest'/);
        const template = read('scripts', 'build-workspace-template.cjs');
        assert.match(template, /\{ path: '_ai\/role-types', kind: 'dir', optional: true \}/);
        assert.match(template, /\{ path: '\.tom\/json-schema\/roles', kind: 'dir' \}/);
        fs.rmSync(ws, { recursive: true, force: true });
    });

    test('RL-6: the editors\' webview', (t) => {
        const boot = (kind: 'roles' | 'roleTypes') => {
            const html = read('media', 'rolesEditor', 'index.html').replace(/<link[^>]*>/g, '');
            const dom = new JSDOM(html, { runScripts: 'outside-only' });
            const w = dom.window as never as Record<string, unknown> & { document: Document; eval(s: string): void; dispatchEvent(e: Event): void; MessageEvent: typeof MessageEvent; close(): void };
            t.after(() => w.close());
            const posted: Array<Record<string, unknown>> = [];
            let state: Record<string, unknown> = {};
            w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), setState: (s: Record<string, unknown>) => { state = s; }, getState: () => state });
            w.__INIT__ = { kind, title: kind === 'roles' ? 'Role Editor' : 'Role Type Editor' };
            w.eval(read('media', 'rolesEditor', 'main.js'));
            const data = (msg: Record<string, unknown>) => w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'data', kind, ...msg } }));
            return { w, posted, data, doc: w.document };
        };
        // Roles.
        const r = boot('roles');
        assert.deepEqual(r.posted, [{ type: 'ready' }]);
        r.data({ items: [{ id: 'author', roleMd: '# Author\n', roleType: 'writer' }, { id: 'coder', roleMd: '# Coder\n' }], roleTypes: [{ id: 'writer', name: 'Writer' }] });
        assert.equal(r.doc.getElementById('headline')!.textContent, 'Role Editor');
        assert.deepEqual([...r.doc.querySelectorAll('#itemList li')].map((li) => li.textContent), ['authorwriter', 'coder']);
        assert.equal((r.doc.getElementById('roleType') as HTMLSelectElement).value, 'writer');
        assert.equal((r.doc.getElementById('roleMd') as HTMLTextAreaElement).value, '# Author\n');
        assert.equal((r.doc.getElementById('btnDelete') as HTMLElement).style.display, 'none', 'roles are not deleted here');
        (r.doc.getElementById('roleType') as HTMLSelectElement).value = '';
        (r.doc.getElementById('btnSave') as HTMLButtonElement).click();
        assert.deepEqual(r.posted.at(-1), { type: 'save', id: 'author', roleType: '', roleMd: '# Author\n' });
        // Role types.
        const rt = boot('roleTypes');
        rt.data({
            items: [{ id: 'writer', value: { name: 'Writer', tools: { mode: 'selected', enabled: ['tomAi_readFile'] } }, usedBy: ['author'] }],
            toolGroups: [{ category: 'Files (read)', tools: ['tomAi_readFile', 'tomAi_findFiles'] }, { category: 'User Interaction', tools: ['tomAi_askUser'] }],
            alwaysOn: ['tomAi_askUser'],
        });
        const cb = (name: string) => rt.doc.querySelector(`.tool-cb[value="${name}"]`) as HTMLInputElement;
        assert.equal(cb('tomAi_readFile').checked, true);
        assert.equal(cb('tomAi_findFiles').checked, false);
        assert.deepEqual([cb('tomAi_askUser').checked, cb('tomAi_askUser').disabled], [true, true], 'always on: greyed and on');
        assert.match(rt.doc.getElementById('form')!.textContent ?? '', /Used by: author/);
        cb('tomAi_findFiles').checked = true;
        (rt.doc.getElementById('btnSave') as HTMLButtonElement).click();
        assert.deepEqual(rt.posted.at(-1), { type: 'save', id: 'writer', value: { name: 'Writer', description: '', tools: { mode: 'selected', enabled: ['tomAi_readFile', 'tomAi_findFiles'] } } });
        (rt.doc.querySelector('input[name="toolsMode"][value="profileDefault"]') as HTMLInputElement).click();
        assert.equal(cb('tomAi_readFile').disabled, true, 'profile default: the selection is off');
        assert.equal(cb('tomAi_askUser').disabled, true);
        (rt.doc.getElementById('btnSave') as HTMLButtonElement).click();
        assert.deepEqual((rt.posted.at(-1)!.value as { tools: unknown }).tools, { mode: 'profileDefault' });
        (rt.doc.getElementById('btnDelete') as HTMLButtonElement).click();
        assert.deepEqual(rt.posted.at(-1), { type: 'delete', id: 'writer' });
    });
});
