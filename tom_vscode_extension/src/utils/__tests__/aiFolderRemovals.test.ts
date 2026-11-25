/**
 * `_ai/notes/`, the `_ai/clarifications…` folders and the shared memory `_ai/memory/shared/` are no longer part of
 * the `_ai` format (al_the_bear ai_format_migration AC-17, AC-18): nothing in the extension reads or offers them.
 * The panels and the bridge import vscode, so their sources are read; the placeholder runs live.
 *
 *   AR-1 notes: the @WS Documentation panel and the MD Browser offer no Notes group and open no `_ai/notes`
 *        (no "open notes folder" action either); `WsPaths` has no `notes` key; the document picker has no NOTES
 *        group; tomAi_listDocuments' live source has no `notes` category
 *   AR-2 the scripting bridge refuses the notes calls (doc.listNotesVce / readNoteVce / writeNoteVce) and the
 *        `notes` and `clarifications…` folders with where the content lives now; nothing reads `_ai/clarifications`
 *   AR-3 shared memory: no Shared tab in the memory panel, no shared-memory button in the chat panel, no
 *        memory-extraction template scope (schema, config type, template editor), the remember keyword writes the
 *        quest memory, the format migration of memory files skips `_ai/memory/shared/`
 *   AR-4 `${memory-shared}` resolves to nothing (an old template does not show the raw placeholder)
 *   AR-5 nothing in src/ or media/ names `_ai/notes`, `_ai/clarifications` or `_ai/memory/shared` except to say
 *        they are gone
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-folder-removals-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (...parts: string[]): string => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

function files(dir: string, ext: RegExp): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') { out.push(...files(p, ext)); } } else if (ext.test(e.name)) { out.push(p); }
    }
    return out;
}

describe('the removed _ai folders', () => {
    test('AR-1: no notes group, key or category', () => {
        const ws = read('src', 'handlers', 'wsPanel-handler.ts');
        assert.doesNotMatch(ws, /'notes'|openNotesFolder/, '@WS Documentation: no Notes group, no open-notes-folder action');
        const mdb = read('src', 'handlers', 'markdownBrowser-handler.ts');
        assert.doesNotMatch(mdb, /id: 'notes'|group === 'notes'/, 'MD Browser: no Notes group');
        assert.doesNotMatch(read('src', 'utils', 'workspacePaths.ts'), /^\s*notes:/m, 'WsPaths has no notes key');
        assert.doesNotMatch(read('src', 'handlers', 'documentPicker.ts'), /NOTES:/);
        assert.doesNotMatch(read('src', 'tools', 'chat-enhancement-tools.ts'), /case 'notes'|'_ai\/notes'/);
        assert.match(read('src', 'tools', 'quest-introspection-tools.ts'), /export type DocumentCategory = 'prompts' \| 'answers' \| 'roles' \| 'guidelines';/);
    });

    test('AR-2: the scripting bridge refuses notes and clarifications', () => {
        const bridge = read('src', 'handlers', 'tomScriptingBridge-handler.ts');
        assert.match(bridge, /case 'doc\.listNotesVce':\s*case 'doc\.readNoteVce':\s*case 'doc\.writeNoteVce':\s*throw new Error\(REMOVED_AI_FOLDER_MESSAGE\('notes'\)\);/);
        assert.match(bridge, /if \(folder === 'notes' \|\| folder\.startsWith\('clarifications'\)\) \{ throw new Error\(REMOVED_AI_FOLDER_MESSAGE\(folder\)\); \}/);
        assert.doesNotMatch(bridge, /WsPaths\.ai\('notes'\)|WsPaths\.ai\('clarifications'\)/);
        assert.match(bridge, /notes are the quest's \(quest-notes\.<quest>\.md, QUEST NOTES\)/);
        assert.doesNotMatch(read('src', 'tools', 'spec-checks-tools.ts'), /clarifications/, 'the example index is no clarifications file');
    });

    test('AR-3: no shared memory in the panels, templates and migration', () => {
        const panel = read('media', 'memoryPanel', 'index.html');
        assert.doesNotMatch(panel, /data-scope="shared"|Shared memory/);
        assert.doesNotMatch(read('media', 'memoryPanel', 'main.js'), /'shared'|snapshot\.shared/);
        assert.doesNotMatch(read('src', 'handlers', 'memoryPanel-handler.ts'), /'shared'/);
        assert.doesNotMatch(read('media', 'chatPanel', 'main.js'), /openSharedMemoryInMdBrowser/);
        assert.doesNotMatch(read('src', 'handlers', 'chatPanel-handler.ts'), /openSharedMemoryInMdBrowser|'shared'/);
        const schema = JSON.parse(read('src', 'config', 'tom_vscode_extension.schema.json'));
        const tpl = schema.definitions.memoryExtractionTemplate;
        assert.equal('scope' in tpl.properties, false, 'no template scope');
        assert.equal(tpl.required.includes('scope'), false);
        assert.doesNotMatch(read('src', 'utils', 'sendToChatConfig.ts'), /'quest' \| 'shared'/);
        assert.doesNotMatch(read('src', 'handlers', 'globalTemplateEditor-handler.ts'), /name: 'scope'|'both'/);
        assert.doesNotMatch(read('src', 'services', 'history-compaction.ts'), /'shared'|tpl\.scope/);
        const handler = read('src', 'handlers', 'anthropic-handler.ts');
        assert.match(handler, /TwoTierMemoryService\.instance\.append\('quest', 'facts\.md', rem\[1\]\.trim\(\), questId\);/, 'remember: writes the quest memory');
        assert.doesNotMatch(handler, /\('shared'/);
        assert.match(read('src', 'services', 'compaction-migration.ts'), /listSubdirectories\(memoryRoot\)\.filter\(\(name\) => name !== 'shared'\)/);
    });

    test('AR-4: ${memory-shared} resolves to nothing', async () => {
        const { resolveVariables } = await import('../variableResolver.js');
        assert.equal(resolveVariables('[${memory-shared}]', { includeEditor: false }), '[]');
    });

    test('AR-5: no reader of the removed folders is left', () => {
        const sources = [...files(path.join(ROOT, 'src'), /\.ts$/), ...files(path.join(ROOT, 'media'), /\.(js|html|css)$/)];
        for (const file of sources) {
            const text = fs.readFileSync(file, 'utf8');
            for (const m of text.matchAll(/_ai\/(notes|clarifications|memory\/shared)\b/g)) {
                const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
                assert.match(line, /no longer part of|gone|not read/, `${path.relative(ROOT, file)} names _ai/${m[1]} only to say it is gone: ${line.trim()}`);
            }
        }
    });
});
