/**
 * The quest tomai_introduction (vsc_setup-7): the starting quest a workspace
 * set up from the template brings. Read from the workspace around this checkout
 * (skipped without one).
 *
 *   IQ-1 the quest files of the scaffold (utils/questScaffold.ts) are there, the workspace file opens the root,
 *        the overview is Active and the setup command finds its workspace file
 *   IQ-2 the overview describes the features in order (AI and workspace first, DartScript last), each with a link
 *        to its page; every relative link of the quest's Markdown files resolves
 *   IQ-3 the todos: valid against the todo schema; intro1-3 are user actions; the walk `intro*` takes the tour
 *        in number order and passes the user actions; the practice todos the tour creates are outside it
 *   IQ-4 the README names it as the starting quest; the template build carries it
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/naming-convention
import Ajv from 'ajv';
import { parse as parseYaml } from 'yaml';
import { questScaffoldFiles } from '../questScaffold';
import { collectPrefixTodos, pickNextTodoForIteration } from '../queueStep3Utils';

const EXT = path.resolve(__dirname, '..', '..', '..');
const WS = path.resolve(EXT, '..', '..', '..');
const QUEST = path.join(WS, '_ai', 'quests', 'tomai_introduction');
const present = fs.existsSync(QUEST);
const skip = present ? false : 'no tomai_introduction quest around this checkout';
const read = (f: string): string => fs.readFileSync(path.join(QUEST, f), 'utf8');

/** The feature pages the overview links, in its order. */
const PAGES = [
    'chat_and_transports.md', 'sessions_and_history.md', 'prompt-queue.md', 'timed_requests.md', 'todos_and_user-actions.md',
    'quest_specific_configuration.md', 'processes.md', 'mdbrowser.md', 'templates_and_placeholders.md', 'notes_and_views.md',
    'tools_and_mcp.md', 'telegram.md', 'status_page.md', 'tomspecs_and_codespecs.md', 'installation_and_platforms.md', 'dartscript.md',
];

describe('the quest tomai_introduction', () => {
    test('IQ-1: the quest files', { skip }, () => {
        for (const f of questScaffoldFiles('tomai_introduction', 'Tom AI Introduction', new Date())) {
            assert.ok(fs.existsSync(path.join(QUEST, f.name)), f.name);
        }
        assert.deepEqual(JSON.parse(read('tomai_introduction.code-workspace')).folders, [{ path: '../../..' }]);
        assert.match(read('overview.tomai_introduction.md'), /\*\*Status:\*\* Active/);
        const handler = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'setupWorkspaceFolder-handler.ts'), 'utf8');
        assert.ok(handler.includes("path.join('_ai', 'quests', 'tomai_introduction', 'tomai_introduction.code-workspace')"), 'the setup offers this workspace file');
    });

    test('IQ-2: the overview and its links', { skip }, () => {
        const overview = read('overview.tomai_introduction.md');
        const features = overview.slice(overview.indexOf('## Features'), overview.indexOf('## Related Projects'));
        const headings = features.split('\n').filter((l) => l.startsWith('### ')).map((l) => l.slice(4));
        assert.equal(headings[0], 'Chat panels and transports', 'AI features first');
        assert.equal(headings.at(-1), 'DartScript', 'DartScript last');
        const sections = features.split('\n### ').slice(1);
        for (const s of sections) { assert.match(s, /\]\([a-z_-]+\.md\)/, `a link in "${s.split('\n')[0]}"`); }
        const linked = [...features.matchAll(/\]\(([a-z_-]+\.md)\)/g)].map((m) => m[1]);
        assert.deepEqual([...new Set(linked)], PAGES);
        // Every relative link of the quest's Markdown resolves.
        for (const f of fs.readdirSync(QUEST).filter((n) => n.endsWith('.md'))) {
            const text = read(f).replace(/```[\s\S]*?```/g, '');
            for (const m of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
                if (/^[a-z]+:/.test(m[1])) { continue; }
                assert.ok(fs.existsSync(path.join(QUEST, m[1])), `${f}: ${m[1]}`);
            }
        }
    });

    test('IQ-3: the todos', { skip }, () => {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo file's key
        type Todo = { id: string; title: string; status: string; user_action?: boolean; description: string };
        const doc = parseYaml(read('todos.tomai_introduction.todo.yaml')) as { todos: Todo[] };
        const schemaPath = path.join(WS, '_ai', 'schemas', 'yaml', 'todo.schema.json');
        const validate = new Ajv({ strict: false, validateFormats: false }).compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
        assert.ok(validate(doc), JSON.stringify(validate.errors));
        const todos = doc.todos;
        const source = todos.map((t) => ({ id: t.id, title: t.title, status: t.status, userAction: t.user_action === true }));
        const walk = collectPrefixTodos('intro', source);
        assert.deepEqual(walk.map((e) => e.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'every todo, in number order');
        assert.deepEqual(walk.filter((e) => e.userAction).map((e) => e.index), [1, 2, 3], 'the user actions');
        assert.equal(pickNextTodoForIteration('intro*', source)?.index, 4, 'the walk passes the user actions');
        const practice = todos.find((t) => t.id.startsWith('intro6'))!.description;
        assert.match(practice, /`practice1` and `practice2`/);
        assert.equal(collectPrefixTodos('intro', [{ id: 'practice1_aaaa-x', title: 'x', status: 'not-started' }]).length, 0);
    });

    test('IQ-4: the README and the template', { skip }, () => {
        const readme = fs.readFileSync(path.join(EXT, 'README.md'), 'utf8');
        assert.match(readme, /the quest \*\*tomai_introduction\*\*, the workspace's\nstarting quest/);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const tpl = require(path.join(EXT, 'scripts', 'build-workspace-template.cjs')) as { collectTemplateFiles(ws: string): { files: string[]; skipped: string[] } };
        const collected = tpl.collectTemplateFiles(WS);
        assert.deepEqual(collected.skipped, []);
        assert.ok(collected.files.includes('_ai/quests/tomai_introduction/overview.tomai_introduction.md'));
        for (const p of PAGES) { assert.ok(collected.files.includes(`_ai/quests/tomai_introduction/${p}`), p); }
    });
});
