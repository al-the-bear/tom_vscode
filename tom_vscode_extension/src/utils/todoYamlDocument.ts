/**
 * The single door through which todo YAML files are parsed.
 *
 * **Why this exists.** A duplicate map key is illegal YAML, but the `yaml`
 * package does not throw on it: it records the problem in `doc.errors` and
 * hands back a usable Document, so every reader carries on with the last value
 * silently winning. The cost is deferred to the next *write*, where
 * `doc.toString()` refuses with `Document with errors cannot be stringified` —
 * a message that names neither the file, nor the line, nor the key. A todo
 * archive corrupted on Monday therefore surfaces as an unexplained archive
 * failure on Friday, in a different quest, with nothing to go on.
 *
 * Reading through {@link parseTodoYaml} moves the failure to the moment of
 * contact and gives it the three facts needed to fix it: which file, which
 * line, and what the parser objected to.
 *
 * **Why parsing and not writing.** Every todo write in the extension goes
 * through the yaml Document API (`map.set`, `doc.createNode`), which replaces
 * a key rather than repeating it and collapses duplicates on rebuild — so a
 * duplicate key cannot originate here. It arrives from outside: a hand edit, a
 * text merge of two divergent archives, or another tool. That is exactly why
 * the guard belongs at the read.
 *
 * Pure fs + yaml — no vscode import — so it is unit-testable under plain
 * `node --test`.
 */

import * as fs from 'fs';
import { Document, parseDocument } from 'yaml';

/** One thing the YAML parser objected to, located in the source. */
export interface TodoYamlProblem {
    /** Parser error code, e.g. `DUPLICATE_KEY`. */
    code: string;
    /** 1-based line, when the parser could place it. */
    line?: number;
    /** 1-based column, when the parser could place it. */
    column?: number;
    /** The parser's own wording, without its source excerpt. */
    message: string;
}

/**
 * A todo YAML file that cannot be trusted — and, critically, cannot be
 * rewritten. Carries the path and every problem the parser found.
 */
export class TodoYamlError extends Error {
    constructor(
        readonly filePath: string,
        readonly problems: TodoYamlProblem[],
    ) {
        super(renderMessage(filePath, problems));
        this.name = 'TodoYamlError';
    }
}

/**
 * The parser appends ` at line N, column M:` plus a source excerpt to its
 * message. The location is reported separately here, so keep only the wording.
 */
function bareMessage(message: string): string {
    return message.split(' at line ')[0].trim();
}

function renderMessage(filePath: string, problems: TodoYamlProblem[]): string {
    const lines = problems.map(p => {
        const at = p.line === undefined
            ? ''
            : ` line ${p.line}${p.column === undefined ? '' : `, column ${p.column}`}:`;
        return `  [${p.code}]${at} ${p.message}`;
    });
    return [`Malformed todo YAML: ${filePath}`, ...lines].join('\n');
}

/**
 * Parse todo YAML, refusing a document the parser found problems in.
 *
 * @throws {TodoYamlError} when `doc.errors` is non-empty.
 */
export function parseTodoYaml(filePath: string, raw: string): Document {
    const doc = parseDocument(raw);
    if (doc.errors.length === 0) { return doc; }
    throw new TodoYamlError(filePath, doc.errors.map(e => ({
        code: String(e.code),
        line: e.linePos?.[0]?.line,
        column: e.linePos?.[0]?.col,
        message: bareMessage(e.message),
    })));
}

/**
 * Read a todo YAML file from disk and parse it under the same guard.
 *
 * @throws {TodoYamlError} when the file is malformed.
 */
export function loadTodoYaml(filePath: string): Document {
    return parseTodoYaml(filePath, fs.readFileSync(filePath, 'utf8'));
}
