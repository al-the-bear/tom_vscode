/**
 * A container window without the container's own `.tom` (02_wslayout-13 step 3): the shape the old tree has
 * once al_the_bear/03_wslayout drops the container's and c2dart's `.tom` copies and symlinks. In a throwaway
 * fixture — the root with `.tom` (tom_root.yaml, the configuration, a DocSpecs schema) and `_agent_guidelines`,
 * the container below it with `_ai` linked to the root's and `_copilot_guidelines`, and no `.tom` of its own —
 * everything resolves to the root:
 *
 *   CW-1 the layout: root = the root, workspace folder = the container, one existing configuration layer (the
 *        root's), `_ai` through the container's link, nothing reported missing
 *   CW-2 the configuration: TomAiConfiguration's file is the root's, and it is what loadSendToChatConfig reads
 *        and saveSendToChatConfig writes; no file appears in the container
 *   CW-3 the DocSpecs lookup: a document in the container finds the root's schema
 *   CW-4 the guidelines: both levels, the root's `_agent_guidelines` and the container's `_copilot_guidelines`
 */

import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261119_02_wslayout-13_fixture-')));
const ROOT = path.join(SANDBOX, 'al_the_bear');
const CONTAINER = path.join(ROOT, 'inhouse', 'second_wind', 'enterprise_flutter', 'tom_agent_container');
const HOME = path.join(SANDBOX, 'home');
const put = (file: string, text: string): void => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
put(path.join(ROOT, '.tom', 'tom_root.yaml'), 'version: 1\n');
put(path.join(ROOT, '.tom', 'tom_vscode_extension.json'), JSON.stringify({ userName: 'root', todoPanel: {} }, null, 2));
put(path.join(ROOT, '.tom', 'docspecs-schema', 'shared', 'shared.1.0.docspecs-schema.yaml'), [
    'section-types:', '  content:', '    prefix: ""', '    subsection-types:', '      content:', '        max-count: infinite',
    'document:', '  sections:', '    content:', '      section-type: content', '      optional: true', '',
].join('\n'));
put(path.join(ROOT, '_agent_guidelines', 'workspace_agents.md'), '# root\n');
put(path.join(ROOT, '_ai', 'quests', 'q', 'overview.q.md'), '# q\n');
put(path.join(CONTAINER, '_copilot_guidelines', 'index.md'), '# container\n');
fs.symlinkSync('../../../../_ai', path.join(CONTAINER, '_ai'), 'dir');
fs.mkdirSync(path.join(HOME, '.tom', 'vscode'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vs = installVscodeStub({ workspaceFolders: [CONTAINER] });
after(() => { vs.restore(); fs.rmSync(SANDBOX, { recursive: true, force: true }); });

import { computeLayout, describeAiMissing } from '../workspaceLayout.js';
import { guidelineLevels } from '../guidelineFolders.js';
import { TomAiConfiguration } from '../tomAiConfiguration.js';
import { loadSendToChatConfig, saveSendToChatConfig } from '../sendToChatConfig.js';
import { resolveDocSpecsSchema } from '../../services/docspecs-markdown.js';

const layout = computeLayout({ workspaceFolders: [CONTAINER], workspaceFile: path.join(CONTAINER, '_ai', 'quests', 'q', 'q.code-workspace') })!;

describe('a container window without the container\'s own .tom', () => {
    test('CW-1: the layout', () => {
        assert.ok(!fs.existsSync(path.join(CONTAINER, '.tom')), 'the fixture has no container .tom');
        assert.equal(layout.root, ROOT);
        assert.equal(layout.workspaceFolder, CONTAINER);
        assert.equal(layout.standalone, false);
        assert.deepEqual(layout.existingConfigLayers, [path.join(ROOT, '.tom')]);
        assert.equal(layout.aiRoot, path.join(CONTAINER, '_ai'));
        assert.equal(fs.realpathSync(layout.aiRoot!), path.join(ROOT, '_ai'));
        assert.equal(describeAiMissing(layout), undefined);
    });

    test('CW-2: the configuration is the root\'s', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        TomAiConfiguration.init({} as any);
        const c = TomAiConfiguration.instance;
        c.reload();
        assert.equal(fs.realpathSync(c.configPath), path.join(ROOT, '.tom', 'tom_vscode_extension.json'));
        const config = loadSendToChatConfig()!;
        assert.equal((config as { userName?: string }).userName, 'root');
        (config as { userName?: string }).userName = 'changed';
        assert.equal(saveSendToChatConfig(config), true);
        assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, '.tom', 'tom_vscode_extension.json'), 'utf8')).userName, 'changed');
        assert.ok(!fs.existsSync(path.join(CONTAINER, '.tom')), 'nothing written into the container');
    });

    test('CW-3: the DocSpecs lookup finds the root\'s schema', () => {
        const doc = path.join(CONTAINER, 'tom_ai', 'pkg', 'doc', 'a.md');
        put(doc, '<!-- docspec: shared/1.0 -->\n\n# <!--[t]--> T\n');
        const service = { schemaIds: [] as string[], schema: () => { throw new Error('not a SOM schema'); } } as never;
        const found = resolveDocSpecsSchema(service, doc, 'shared/1.0', CONTAINER, undefined, { workspaceFolder: CONTAINER, configLayers: layout.configLayers });
        assert.equal(found.resolved?.file, path.join(ROOT, '.tom', 'docspecs-schema', 'shared', 'shared.1.0.docspecs-schema.yaml'));
    });

    test('CW-4: the guidelines of both levels', () => {
        assert.deepEqual(guidelineLevels(layout.guidelineDirs).map((l) => [l.level, l.dirs]), [
            ['root', [path.join(ROOT, '_agent_guidelines')]],
            ['workspace', [path.join(CONTAINER, '_copilot_guidelines')]],
        ]);
    });
});
