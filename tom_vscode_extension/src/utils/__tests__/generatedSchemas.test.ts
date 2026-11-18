/**
 * The extension's schemas as generated copies in the top `.tom`, the `$schema` references to them, and
 * `userConfigPath` (02_wslayout-8; utils/generatedSchemas.ts, utils/tomAiConfiguration.ts).
 *
 *   GS-1 the top `.tom`: the root's in a root (also from a workspace folder below it), a standalone folder's own;
 *        the four sets written there with their `.generated-by` stamps; a second run changes nothing
 *   GS-2 a hand-made schema is never overwritten: an unstamped folder that differs is reported and left as it is;
 *        one whose files are identical is adopted (stamped)
 *   GS-3 a stamped folder is brought up to date (a changed file, a newer build), its other files kept; an older
 *        build never writes over a newer one's copy
 *   GS-4 stale copies: a stamped folder in a workspace folder's `.tom` below a root is reported (not one reached
 *        through a link onto the root's); removal takes only stamped folders
 *   GS-5 the `$schema` references: from the file's real folder to the top `.tom`, from several depths and through
 *        the workspace folder's `_ai` link; the role files and the panel files written so
 *   GS-6 `userConfigPath`: the default, each placeholder (`${home}`, `~`, `${tomRoot}`, `${workspaceFolder}`), the
 *        workspace layer over the root's, the overlay read from there; in the schema and SendToChatConfig
 *   GS-7 every source the sets name is shipped (out/config, resources/schemas)
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261118_02_wslayout-8_gs-')));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));
const HOME = path.join(SANDBOX, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({ workspaceFolders: [path.join(SANDBOX, 'none')] });

import {
    GENERATED_BY_FILE, GENERATED_SCHEMA_SETS, findStaleGeneratedCopies, readGeneratedBy, removeStaleGeneratedCopies,
    schemaRefFromFile, syncGeneratedSchemas,
} from '../generatedSchemas.js';
import { getLayout, resetLayoutForTests } from '../workspaceLayout.js';
import { WsPaths } from '../workspacePaths.js';
import { schemaLine } from '../roleTypes.js';
import { TomAiConfiguration, DEFAULT_USER_CONFIG_PATH } from '../tomAiConfiguration.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
function mk(...p: string[]): string { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; }
function put(file: string, text: string): string { mk(path.dirname(file)); fs.writeFileSync(file, text); return file; }
function window(folder: string): void { installVscodeStub({ workspaceFolders: [folder] }); resetLayoutForTests(); }

// A root (own tom_root.yaml, so the tree the sandbox lies in is never the root) with `_ai`, a container below it
// with an `_ai` link, and a standalone folder (its own root).
const ROOT = mk(SANDBOX, 'root');
put(path.join(ROOT, '.tom', 'tom_root.yaml'), 'version: 1\n');
mk(ROOT, '_ai', 'local');
const CONTAINER = mk(ROOT, 'inhouse', 'container');
mk(CONTAINER, '.tom');
fs.symlinkSync(path.join(ROOT, '_ai'), path.join(CONTAINER, '_ai'));
const ALONE = mk(SANDBOX, 'alone');
put(path.join(ALONE, '.tom', 'tom_root.yaml'), 'version: 1\n');

const STAMP = { generatedBy: 'test.tom-ai', version: '0.1.0', build: { commit: 'abc', builtAt: '2026-11-18T10:00:00.000Z' } };
const shipped = (folder: string, name: string): string => {
    const set = GENERATED_SCHEMA_SETS.find((s) => s.folder === folder)!;
    return fs.readFileSync(path.join(EXT, ...set.files.find((f) => f.name === name)!.source.split('/')), 'utf8');
};

describe('the generated schemas in the top .tom', () => {
    test('GS-1: written into the top .tom with their stamps', () => {
        window(CONTAINER);
        assert.equal(WsPaths.topTom, path.join(ROOT, '.tom'), 'a workspace folder below a root: the root\'s');
        window(ALONE);
        assert.equal(WsPaths.topTom, path.join(ALONE, '.tom'), 'standalone: its own');
        for (const top of [path.join(ROOT, '.tom'), path.join(ALONE, '.tom')]) {
            const results = syncGeneratedSchemas(top, EXT, STAMP);
            assert.deepEqual(results.map((r) => [r.folder, r.outcome]), [
                ['json-schema/panels', 'written'], ['json-schema/roles', 'written'], ['json-schema/processes', 'written'], ['json-schema/extension', 'written'],
            ]);
            for (const set of GENERATED_SCHEMA_SETS) {
                const dir = path.join(top, ...set.folder.split('/'));
                for (const f of set.files) { assert.equal(fs.readFileSync(path.join(dir, f.name), 'utf8'), shipped(set.folder, f.name)); }
                assert.deepEqual(readGeneratedBy(dir), { ...STAMP, files: set.files.map((f) => f.name) });
            }
            assert.ok(fs.existsSync(path.join(top, 'json-schema', 'processes', 'process.schema.json')));
            assert.ok(fs.existsSync(path.join(top, 'json-schema', 'extension', 'tom_vscode_extension.schema.json')));
            assert.deepEqual(syncGeneratedSchemas(top, EXT, STAMP).map((r) => r.outcome), ['current', 'current', 'current', 'current'], 'nothing to do');
        }
    });

    test('GS-2: a hand-made schema is never overwritten', () => {
        const top = mk(SANDBOX, 'hand', '.tom');
        const roles = put(path.join(top, 'json-schema', 'roles', 'role-type.schema.json'), '{"title":"mine"}\n');
        const panels = mk(top, 'json-schema', 'panels');
        for (const name of ['chatvars', 'panels', 'prompt', 'queue', 'timed']) {
            fs.writeFileSync(path.join(panels, `${name}.schema.json`), shipped('json-schema/panels', `${name}.schema.json`));
        }
        const results = syncGeneratedSchemas(top, EXT, STAMP);
        const roleResult = results.find((r) => r.folder === 'json-schema/roles')!;
        assert.equal(roleResult.outcome, 'differs');
        assert.deepEqual(roleResult.differing, ['role-config.schema.json', 'role-type.schema.json']);
        assert.equal(fs.readFileSync(roles, 'utf8'), '{"title":"mine"}\n', 'left as it is');
        assert.equal(fs.existsSync(path.join(top, 'json-schema', 'roles', GENERATED_BY_FILE)), false);
        assert.equal(results.find((r) => r.folder === 'json-schema/panels')!.outcome, 'adopted', 'identical files: adopted');
        assert.ok(readGeneratedBy(panels));
    });

    test('GS-3: a stamped folder kept current; an older build never writes over a newer one', () => {
        const top = mk(SANDBOX, 'upd', '.tom');
        syncGeneratedSchemas(top, EXT, STAMP);
        const dir = path.join(top, 'json-schema', 'roles');
        fs.writeFileSync(path.join(dir, 'role-type.schema.json'), '{}');
        fs.writeFileSync(path.join(dir, 'notes.md'), 'mine');
        assert.equal(syncGeneratedSchemas(top, EXT, STAMP).find((r) => r.folder === 'json-schema/roles')!.outcome, 'updated');
        assert.equal(fs.readFileSync(path.join(dir, 'role-type.schema.json'), 'utf8'), shipped('json-schema/roles', 'role-type.schema.json'));
        assert.equal(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), 'mine', 'other files kept');
        const newer = { ...STAMP, build: { commit: 'def', builtAt: '2026-11-19T10:00:00.000Z' } };
        assert.deepEqual(syncGeneratedSchemas(top, EXT, newer).map((r) => r.outcome), ['updated', 'updated', 'updated', 'updated'], 'a newer build restamps');
        assert.equal(readGeneratedBy(dir)?.build?.commit, 'def');
        fs.writeFileSync(path.join(dir, 'role-type.schema.json'), '{"newer":true}');
        assert.equal(syncGeneratedSchemas(top, EXT, STAMP).find((r) => r.folder === 'json-schema/roles')!.outcome, 'current', 'the older build leaves it');
        assert.equal(fs.readFileSync(path.join(dir, 'role-type.schema.json'), 'utf8'), '{"newer":true}');
        assert.equal(readGeneratedBy(dir)?.build?.commit, 'def');
    });

    test('GS-4: stale copies below a root', () => {
        window(CONTAINER);
        const layout = getLayout()!;
        assert.deepEqual(findStaleGeneratedCopies(layout), [], 'none yet');
        const own = mk(CONTAINER, '.tom', 'json-schema', 'roles');
        syncGeneratedSchemas(path.join(CONTAINER, '.tom'), EXT, STAMP, GENERATED_SCHEMA_SETS.filter((s) => s.folder === 'json-schema/roles'));
        mk(CONTAINER, '.tom', 'json-schema', 'panels'); // unstamped: not a copy
        assert.deepEqual(findStaleGeneratedCopies(layout), [own]);
        // Through a link onto the root's copy: the same folder, not stale.
        const web = mk(ROOT, 'web');
        mk(web, '.tom');
        fs.symlinkSync(path.join(ROOT, '.tom', 'json-schema'), path.join(web, '.tom', 'json-schema'));
        window(web);
        assert.deepEqual(findStaleGeneratedCopies(getLayout()!), [], 'a link onto the root\'s');
        window(ALONE);
        assert.deepEqual(findStaleGeneratedCopies(getLayout()!), [], 'standalone: none');
        assert.deepEqual(removeStaleGeneratedCopies([own, path.join(CONTAINER, '.tom', 'json-schema', 'panels')]), [own], 'only the stamped one');
        assert.equal(fs.existsSync(own), false);
        assert.equal(fs.existsSync(path.join(CONTAINER, '.tom', 'json-schema', 'panels')), true);
    });

    test('GS-5: $schema references from the real folder', () => {
        const top = path.join(ROOT, '.tom');
        const viaLink = path.join(CONTAINER, '_ai', 'local', 'q.queue.yaml');
        const viaRoot = path.join(ROOT, '_ai', 'local', 'q.queue.yaml');
        for (const file of [viaLink, viaRoot]) {
            assert.equal(schemaRefFromFile(file, top, 'json-schema/panels/queue.schema.json'), '../../.tom/json-schema/panels/queue.schema.json', file);
        }
        assert.equal(schemaRefFromFile(path.join(ROOT, '_ai', 'roles', 'writer', 'role-config.yaml'), top, 'json-schema/roles/role-config.schema.json'),
            '../../../.tom/json-schema/roles/role-config.schema.json');
        assert.equal(schemaRefFromFile(path.join(CONTAINER, 'state', 'x.yaml'), top, 'json-schema/panels/timed.schema.json'),
            '../../../.tom/json-schema/panels/timed.schema.json', 'a folder below the workspace folder');
        assert.equal(schemaRefFromFile(path.join(CONTAINER, '.tom', 'linked', 'x.yaml'), path.join(CONTAINER, '_ai', '..', '..', '..', '.tom'), 'json-schema/a.json'),
            '../../../../.tom/json-schema/a.json', 'the top .tom given through another spelling');
        assert.equal(schemaLine(path.join(CONTAINER, '_ai', 'role-types', 'w', 'role-type.yaml'), top, 'roleType'),
            '# yaml-language-server: $schema=../../../.tom/json-schema/roles/role-type.schema.json', 'a role file through the link');
        const src = (rel: string) => fs.readFileSync(path.join(EXT, 'src', rel), 'utf8');
        assert.match(src('utils/panelYamlStore.ts'), /schemaRefFromFile\(filePath, topTom, schemaRel\)/);
        assert.doesNotMatch(src('managers/timerEngine.ts') + src('handlers/chatVariablesEditor-handler.ts'), /'\.tom\/json-schema/);
    });

    test('GS-6: userConfigPath', () => {
        const cfgFile = path.join(ROOT, '.tom', 'tom_vscode_extension.json');
        const wsFile = path.join(CONTAINER, '.tom', 'tom_vscode_extension.json');
        const read = (): TomAiConfiguration => {
            window(CONTAINER);
            (TomAiConfiguration as Json)._instance = undefined;
            TomAiConfiguration.init({} as Json);
            return TomAiConfiguration.instance;
        };
        assert.equal(DEFAULT_USER_CONFIG_PATH, '${home}/.tom/vscode/tom_vscode_extension.user.yaml');
        fs.writeFileSync(cfgFile, '{}');
        assert.equal(read().userGlobalConfigPath, path.join(HOME, '.tom', 'vscode', 'tom_vscode_extension.user.yaml'), 'the default');
        for (const [value, expected] of [
            ['${home}/a/u.yaml', path.join(HOME, 'a', 'u.yaml')],
            ['~/b/u.yaml', path.join(HOME, 'b', 'u.yaml')],
            ['${tomRoot}/c/u.yaml', path.join(ROOT, 'c', 'u.yaml')],
            ['${workspaceFolder}/d/u.yaml', path.join(CONTAINER, 'd', 'u.yaml')],
        ]) {
            fs.writeFileSync(cfgFile, JSON.stringify({ userConfigPath: value }));
            assert.equal(read().userGlobalConfigPath, expected, value);
        }
        put(path.join(ROOT, 'c', 'u.yaml'), 'todo:\n  defaultColumns: [from-root-named]\n');
        put(path.join(CONTAINER, 'd', 'u.yaml'), 'todo:\n  defaultColumns: [from-ws-named]\n');
        fs.writeFileSync(cfgFile, JSON.stringify({ userConfigPath: '${tomRoot}/c/u.yaml' }));
        assert.deepEqual(read().getTodo().defaultColumns, ['from-root-named'], 'the overlay read from the named place');
        fs.writeFileSync(wsFile, JSON.stringify({ userConfigPath: '${workspaceFolder}/d/u.yaml' }));
        const c = read();
        assert.equal(c.userGlobalConfigPath, path.join(CONTAINER, 'd', 'u.yaml'), 'the workspace layer over the root\'s');
        assert.deepEqual(c.getTodo().defaultColumns, ['from-ws-named']);
        fs.writeFileSync(path.join(CONTAINER, 'd', 'u.yaml'), 'todo:\n  defaultColumns: [edited]\n');
        assert.deepEqual(c.getTodo().defaultColumns, ['edited'], 'a hand edit of the named overlay is seen');
        fs.rmSync(wsFile);
        fs.writeFileSync(cfgFile, '{}');
        const schema = JSON.parse(fs.readFileSync(path.join(EXT, 'src', 'config', 'tom_vscode_extension.schema.json'), 'utf8'));
        assert.equal(schema.properties.userConfigPath.default, DEFAULT_USER_CONFIG_PATH);
        assert.match(fs.readFileSync(path.join(EXT, 'src', 'utils', 'sendToChatConfig.ts'), 'utf8'), /userConfigPath\?: string;/);
        assert.doesNotMatch(fs.readFileSync(path.join(EXT, 'src', 'utils', 'tomAiConfiguration.ts'), 'utf8'), /USER_GLOBAL_CONFIG_REL/);
    });

    test('GS-7: every source is shipped', () => {
        for (const set of GENERATED_SCHEMA_SETS) {
            for (const f of set.files) { assert.ok(fs.existsSync(path.join(EXT, ...f.source.split('/'))), `${set.folder}/${f.name} from ${f.source}`); }
        }
        assert.equal(os.homedir(), HOME);
    });
});
