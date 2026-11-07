/**
 * Claude Code's slash commands (`.claude/commands/*.md`) as `/name`
 * completions (ccparity_d_claudecode-3, CC-13 (a)): services/slashCommands.ts.
 *
 *   SC-1 discovery over a fixture workspace: a file is `/name`, a sub-folder makes `/folder:name`; the
 *        description and argument hint from the frontmatter (or the first line); the workspace's own first; a
 *        nearer command masks an ancestor's of the same name; non-.md files are none; a query filters by prefix
 *   SC-2 expansion: `$ARGUMENTS` takes the whole argument text, `$1` … `$9` the words (quotes keep words
 *        together, a missing one is empty); a template with neither gets the arguments appended as
 *        `ARGUMENTS: …`; without arguments the template stands; the frontmatter is not part of the prompt
 *   SC-3 whether a command takes arguments: a placeholder or an argument hint
 *   SC-4 the wiring: the `/` picker lists commands beside skills and asks for a command's arguments; the queue
 *        editor's add form has the completion (textareas, script, the handler, the shared API handle)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { commandTakesArguments, expandSlashCommand, listSlashCommands, splitCommandArguments } from '../slashCommands';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-commands-'));
const ws = path.join(base, 'parent', 'workspace');
const write = (rel: string, text: string): void => {
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
};

write('parent/workspace/.claude/commands/review-pr.md', [
    '---',
    'description: Review a pull request.',
    'argument-hint: <pr-number> [focus]',
    '---',
    'Review PR #$1 with a focus on $2.',
    '',
    'Everything: $ARGUMENTS',
].join('\n'));
write('parent/workspace/.claude/commands/frontend/component.md', '---\ndescription: Make a component.\n---\nCreate the component $ARGUMENTS.\n');
write('parent/workspace/.claude/commands/plain.md', 'Summarise the open todos.\n');
write('parent/workspace/.claude/commands/readme.txt', 'not a command');
write('parent/.claude/commands/plain.md', '---\ndescription: The ancestor one, masked.\n---\nOld.\n');
write('parent/.claude/commands/fleet-sync.md', '---\ndescription: Sync the fleet.\n---\nRun the fleet sync.\n');

describe('slash commands', () => {
    test('SC-1: discovery', () => {
        const all = listSlashCommands(ws, '');
        assert.deepEqual(all.map((c) => c.name), ['frontend:component', 'plain', 'review-pr', 'fleet-sync']);
        const byName = new Map(all.map((c) => [c.name, c]));
        assert.equal(byName.get('review-pr')!.description, 'Review a pull request.');
        assert.equal(byName.get('review-pr')!.argumentHint, '<pr-number> [focus]');
        assert.equal(byName.get('plain')!.description, 'Summarise the open todos.', 'the nearer one masks the ancestor\'s');
        assert.equal(byName.get('plain')!.direct, true);
        assert.equal(byName.get('fleet-sync')!.direct, false);
        assert.deepEqual(listSlashCommands(ws, 'RE').map((c) => c.name), ['review-pr'], 'prefix, any case');
        assert.deepEqual(listSlashCommands(ws, 'frontend:').map((c) => c.name), ['frontend:component']);
    });

    test('SC-2: expansion', () => {
        const review = listSlashCommands(ws, 'review-pr')[0];
        assert.equal(expandSlashCommand(review, '42 "error handling"'),
            'Review PR #42 with a focus on error handling.\n\nEverything: 42 "error handling"');
        assert.equal(expandSlashCommand(review, '42'), 'Review PR #42 with a focus on .\n\nEverything: 42');
        const plain = listSlashCommands(ws, 'plain')[0];
        assert.equal(expandSlashCommand(plain, ''), 'Summarise the open todos.');
        assert.equal(expandSlashCommand(plain, 'only mine'), 'Summarise the open todos.\n\nARGUMENTS: only mine');
        const component = listSlashCommands(ws, 'frontend:component')[0];
        assert.equal(expandSlashCommand(component, 'Button'), 'Create the component Button.');
        assert.doesNotMatch(expandSlashCommand(review, '1'), /argument-hint|---/);
        assert.deepEqual(splitCommandArguments(`a "b c" 'd e' f`), ['a', 'b c', 'd e', 'f']);
        assert.equal(expandSlashCommand(component, '$1 literal'), 'Create the component $1 literal.', 'argument text is not expanded again');
    });

    test('SC-3: which commands take arguments', () => {
        const byName = new Map(listSlashCommands(ws, '').map((c) => [c.name, c]));
        assert.equal(commandTakesArguments(byName.get('review-pr')!), true);
        assert.equal(commandTakesArguments(byName.get('frontend:component')!), true);
        assert.equal(commandTakesArguments(byName.get('plain')!), false);
    });

    test('SC-4: the wiring', () => {
        const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');
        const picker = src('src/handlers/completion-picker.ts');
        assert.match(picker, /listSlashCommands\(/);
        assert.match(picker, /commandTakesArguments\(command\)/);
        assert.match(picker, /expandSlashCommand\(command, args\)/);
        const html = src('media/queueEditor/index.html');
        for (const id of ['addText', 'addRepeatPrefix', 'addRepeatSuffix']) {
            assert.match(html, new RegExp(`<textarea id="${id}"[^>]*data-completion="on"`), id);
        }
        assert.match(html, /<script src="\{\{sharedUri\}\}\/completion\.js"><\/script>/);
        assert.match(src('media/queueEditor/main.js'), /window\.__tomVscodeApi = vscode;/);
        assert.match(src('src/handlers/queueEditor-handler.ts'), /wireCompletionMessages\(_panel\.webview\)/);
        assert.match(src('src/handlers/chatPanel-handler.ts'), /wireCompletionMessages\(webviewView\.webview\)/, 'the @CHAT panels use the same picker');
    });
});
