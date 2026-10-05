/**
 * Every write to a todo document is followed by a check that it landed.
 *
 * "Do all the mutators verify their writes?" was answered by reading
 * `questTodoManager.ts`, and it was answered wrong twice: one count said three
 * of four mutators verified; measured, it was two of nine write sites. Nothing
 * enumerated the sites, so each reader counted afresh. This guard is the
 * enumeration.
 *
 * WHAT IT DOES (WS-*), over `questTodoManager.ts` and `todoArchive.ts`, by
 * walking the TypeScript AST (so comments and strings cannot fake a site):
 *
 *   WS-1  Finds the WRITER FUNCTIONS: functions that write a file passed in as
 *         a parameter and leave the check to their caller (`saveDocument`,
 *         `saveDocumentWithSchema`, `writeTodosIntoTarget`). They are derived,
 *         not listed, so a new wrapper around `fs.writeFileSync` is picked up
 *         by itself. A function that writes a parameter path AND verifies it
 *         (`moveTodosOrThrow`) is not a writer: its own write is a site.
 *   WS-2  Lists every WRITE SITE: a call to a writer function, or a raw file
 *         write outside one. The list must equal the CENSUS below exactly. A
 *         new write therefore fails here until somebody names it and decides
 *         whether it is verified or exempt; the census cannot drift silently.
 *   WS-3  Every write site that is not exempt is followed, later in the same
 *         function, by a verifier call (`assertTodoPersisted`,
 *         `assertTodoFieldsPersisted`, `assertMovePersisted`) whose arguments
 *         include the written file's expression. Matching on the file matters:
 *         `moveToWorkspaceTodo` writes two files, and a check of the second
 *         must not count for the first.
 *   WS-4  Every exemption names a real site and gives a reason, so the list
 *         cannot outlive what it excuses.
 *   WS-5  Not vacuous: the walk must find the known site
 *         `updateTodo → saveDocument(filePath)` and at least as many sites as
 *         the census holds. A scanner that finds nothing would otherwise
 *         report everything verified.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

// out/managers/__tests__ -> project root is three levels up.
const ROOT = join(__dirname, '..', '..', '..');
const FILES = ['src/managers/questTodoManager.ts', 'src/utils/todoArchive.ts'];

/** Calls that confirm a write by re-reading the file. */
const VERIFIERS = new Set(['assertTodoPersisted', 'assertTodoFieldsPersisted', 'assertMovePersisted']);

/** Raw file writes (the callee's last name). */
const RAW_WRITES = /^(writeFileSync|appendFileSync|writeFile|appendFile)$/;

/**
 * The census: every write site, as `<file>: <function> → <callee>(<path>)`.
 * Adding a write means adding it here, and so deciding what verifies it.
 */
const CENSUS = [
    'questTodoManager.ts: createTodo → saveDocument(filePath)',
    'questTodoManager.ts: createTodo → saveDocumentWithSchema(filePath)',
    'questTodoManager.ts: createTodoInFile → saveDocument(filePath)',
    'questTodoManager.ts: deleteTodo → saveDocument(filePath)',
    'questTodoManager.ts: ensureTodoFile → saveDocumentWithSchema(filePath)',
    'questTodoManager.ts: moveToWorkspaceTodo → saveDocument(filePath)',
    'questTodoManager.ts: moveToWorkspaceTodo → saveDocument(wsFile)',
    'questTodoManager.ts: moveToWorkspaceTodo → saveDocumentWithSchema(wsFile)',
    'questTodoManager.ts: moveTodo → saveDocument(filePath)',
    'questTodoManager.ts: updateTodo → saveDocument(filePath)',
    'questTodoManager.ts: updateTodoInFile → saveDocument(filePath)',
    'todoArchive.ts: journalDecisions → fs.appendFileSync(file)',
    'todoArchive.ts: moveTodosOrThrow → fs.writeFileSync(sourceFilePath)',
    'todoArchive.ts: moveTodosOrThrow → writeTodosIntoTarget(targetFile)',
];

/** Write sites with nothing to verify, and why. */
const EXEMPT = new Map<string, string>([
    [
        'questTodoManager.ts: ensureTodoFile → saveDocumentWithSchema(filePath)',
        'creates an empty todo file when none exists; there is no todo whose presence could be asserted, '
        + 'and the first todo written into it is verified by its own create',
    ],
    [
        'todoArchive.ts: journalDecisions → fs.appendFileSync(file)',
        'appends archived decisions to the decisions.<quest>.md journal, a markdown log rather than a todo '
        + 'document; the todos themselves are verified by assertMovePersisted in the same move',
    ],
]);

const EXPECTED_WRITERS = [
    'questTodoManager.ts: saveDocument',
    'questTodoManager.ts: saveDocumentWithSchema',
    'todoArchive.ts: writeTodosIntoTarget',
];

interface Site {
    key: string;
    fn: ts.FunctionLikeDeclaration;
    call: ts.CallExpression;
    pathText: string;
}

interface Scan {
    writers: string[];
    sites: Site[];
    source: Map<string, ts.SourceFile>;
}

function calleeName(call: ts.CallExpression): string {
    const e = call.expression;
    if (ts.isIdentifier(e)) { return e.text; }
    if (ts.isPropertyAccessExpression(e)) { return e.name.text; }
    return '';
}

function calleeText(call: ts.CallExpression, sf: ts.SourceFile): string {
    return call.expression.getText(sf);
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
        if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) { return n; }
    }
    return undefined;
}

function functionName(fn: ts.FunctionLikeDeclaration): string {
    return fn.name && ts.isIdentifier(fn.name) ? fn.name.text : '<anonymous>';
}

function eachCall(node: ts.Node, visit: (c: ts.CallExpression) => void): void {
    if (ts.isCallExpression(node)) { visit(node); }
    ts.forEachChild(node, (child) => eachCall(child, visit));
}

function scan(sources: Map<string, string>): Scan {
    const parsed = new Map<string, ts.SourceFile>();
    for (const [name, text] of sources) {
        parsed.set(name, ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true));
    }

    // WS-1: writer functions — a raw write whose path argument is a parameter,
    // with no verification of that path inside the function itself.
    const writerNames = new Set<string>();
    const writers: string[] = [];
    for (const [name, sf] of parsed) {
        eachCall(sf, (call) => {
            if (!RAW_WRITES.test(calleeName(call))) { return; }
            const fn = enclosingFunction(call);
            const arg = call.arguments[0];
            if (!fn || !arg || !ts.isIdentifier(arg)) { return; }
            const params = fn.parameters.map((p) => p.name.getText(sf));
            const selfVerified = isVerified({ key: '', fn, call, pathText: arg.text }, sf);
            if (params.includes(arg.text) && !selfVerified && !writerNames.has(functionName(fn))) {
                writerNames.add(functionName(fn));
                writers.push(`${name}: ${functionName(fn)}`);
            }
        });
    }

    // WS-2: write sites — calls to writer functions, raw writes outside them.
    const sites: Site[] = [];
    for (const [name, sf] of parsed) {
        eachCall(sf, (call) => {
            const callee = calleeName(call);
            const isRaw = RAW_WRITES.test(callee);
            if (!isRaw && !writerNames.has(callee)) { return; }
            const fn = enclosingFunction(call);
            if (!fn) { return; }
            if (isRaw && writerNames.has(functionName(fn))) { return; } // the writer's own write
            const pathText = call.arguments[0]?.getText(sf) ?? '';
            sites.push({
                key: `${name}: ${functionName(fn)} → ${calleeText(call, sf)}(${pathText})`,
                fn,
                call,
                pathText,
            });
        });
    }
    return { writers: writers.sort(), sites, source: parsed };
}

/** WS-3: is the site followed in its function by a verifier naming its file? */
function isVerified(site: Site, sf: ts.SourceFile): boolean {
    let verified = false;
    eachCall(site.fn, (call) => {
        if (verified || !VERIFIERS.has(calleeName(call))) { return; }
        if (call.getStart(sf) <= site.call.getEnd()) { return; }
        verified = call.arguments.some((a) => a.getText(sf) === site.pathText);
    });
    return verified;
}

function readSources(): Map<string, string> {
    const out = new Map<string, string>();
    for (const rel of FILES) {
        out.set(rel.split('/').pop()!, readFileSync(join(ROOT, rel), 'utf-8'));
    }
    return out;
}

function unverified(result: Scan): string[] {
    return result.sites
        .filter((s) => !EXEMPT.has(s.key))
        .filter((s) => !isVerified(s, result.source.get(s.key.split(':')[0])!))
        .map((s) => s.key);
}

describe('todo write sites are enumerated and verified (WS-*)', () => {
    const result = scan(readSources());
    const keys = result.sites.map((s) => s.key).sort();

    test('WS-5: the walk is not vacuous', () => {
        assert.ok(
            keys.includes('questTodoManager.ts: updateTodo → saveDocument(filePath)'),
            'the known site updateTodo → saveDocument(filePath) was not found; the scanner is broken',
        );
        assert.ok(keys.length >= CENSUS.length, `found only ${keys.length} write sites`);
    });

    test('WS-1: the writer functions are derived from the code', () => {
        assert.deepEqual(result.writers, EXPECTED_WRITERS);
    });

    test('WS-2: the write sites match the census exactly', () => {
        assert.deepEqual(
            keys,
            [...CENSUS].sort(),
            'a todo-document write was added, removed or renamed. Update CENSUS in this file, '
            + 'and follow the new write with assertTodoPersisted / assertTodoFieldsPersisted / '
            + 'assertMovePersisted on the same file (or add an EXEMPT entry with the reason).',
        );
    });

    test('WS-3: every non-exempt write is followed by a verifier on the same file', () => {
        assert.deepEqual(
            unverified(result),
            [],
            'these writes are never re-read to confirm they landed. Add an assert…Persisted call '
            + 'on the same file after the write, in the same function.',
        );
    });

    test('WS-4: every exemption names a census site and gives a reason', () => {
        for (const [key, reason] of EXEMPT) {
            assert.ok(CENSUS.includes(key), `exemption for a site that does not exist: ${key}`);
            assert.ok(reason.trim().length > 20, `exemption without a real reason: ${key}`);
        }
    });

    test('WS-6: the guard fails when a verification is removed', () => {
        // Proof that WS-3 can fail: delete the first assertTodoPersisted after
        // updateTodo's write and scan the edited source.
        const sources = readSources();
        const text = sources.get('questTodoManager.ts')!;
        const marker = "assertTodoPersisted(filePath, todoId, 'present', 'updateTodo');";
        const markerFields = "assertTodoFieldsPersisted(filePath, todoId, applied, 'updateTodo');";
        assert.ok(text.includes(marker) && text.includes(markerFields), 'updateTodo verification calls not found');
        sources.set('questTodoManager.ts', text.replace(marker, '').replace(markerFields, ''));
        assert.deepEqual(unverified(scan(sources)), ['questTodoManager.ts: updateTodo → saveDocument(filePath)']);
    });

    test('WS-7: a check of one file does not count for another', () => {
        // moveToWorkspaceTodo writes filePath and then wsFile; removing the
        // filePath check must be caught although wsFile is still checked.
        const sources = readSources();
        const text = sources.get('questTodoManager.ts')!;
        const marker = "assertTodoPersisted(filePath, todoId, 'absent', 'moveToWorkspaceTodo');";
        assert.ok(text.includes(marker), 'moveToWorkspaceTodo source verification not found');
        sources.set('questTodoManager.ts', text.replace(marker, ''));
        assert.deepEqual(unverified(scan(sources)), ['questTodoManager.ts: moveToWorkspaceTodo → saveDocument(filePath)']);
    });
});
