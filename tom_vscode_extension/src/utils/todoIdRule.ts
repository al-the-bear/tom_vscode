/**
 * The todo id rule, read from the todo schema itself
 * (`_ai/schemas/yaml/todo.schema.json`, `$defs.todo.properties.id`): its
 * `pattern` decides, its `description` names the rule in words. Every path that
 * creates or renames a todo id checks the new id here, so an id the schema
 * refuses never reaches a todo file (the `_ai` commit guard would refuse every
 * later commit of that file). Nothing of the rule is copied: a change of the
 * schema's pattern is followed at the next check (the file is re-read when it
 * changed). Without the schema (a workspace without `_ai/schemas`) nothing is
 * checked here.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The schema file, relative to the `_ai` root. */
export const TODO_SCHEMA_AI_PATH = path.join('schemas', 'yaml', 'todo.schema.json');

/** How refusals name the schema file. */
const TODO_SCHEMA_SHOWN = '_ai/schemas/yaml/todo.schema.json';

export interface TodoIdRule {
    /** The schema's id pattern, as written. */
    pattern: string;
    /** The rule in words: the parenthesis of the description's first sentence, else the pattern. */
    words: string;
    regex: RegExp;
}

let cache: { file: string; mtimeMs: number; rule: TodoIdRule | undefined } | undefined;

/** The id rule of the todo schema under the `_ai` root `aiRoot`, or undefined when there is no schema (or it names no id pattern). */
export function todoIdRule(aiRoot: string): TodoIdRule | undefined {
    if (!aiRoot) { return undefined; }
    const file = path.join(aiRoot, TODO_SCHEMA_AI_PATH);
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return undefined; }
    if (cache && cache.file === file && cache.mtimeMs === mtimeMs) { return cache.rule; }
    let rule: TodoIdRule | undefined;
    try {
        const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
        const id = schema?.$defs?.todo?.properties?.id;
        if (typeof id?.pattern === 'string') {
            const description = typeof id.description === 'string' ? id.description : '';
            const words = /^[^.]*?\(([^)]*)\)/.exec(description)?.[1]?.trim();
            // JSON Schema patterns are ECMA-262 regular expressions, read with Unicode semantics.
            rule = { pattern: id.pattern, words: words || id.pattern, regex: new RegExp(id.pattern, 'u') };
        }
    } catch {
        rule = undefined;
    }
    cache = { file, mtimeMs, rule };
    return rule;
}

/** Why `id` is no todo id by the schema under the `_ai` root `aiRoot`, naming the rule; undefined when it is (or no schema is there). */
export function todoIdRuleError(id: string, aiRoot: string): string | undefined {
    const rule = todoIdRule(aiRoot);
    if (!rule || rule.regex.test(id)) { return undefined; }
    return `"${id}" is no todo id: the todo schema (${TODO_SCHEMA_SHOWN}) requires ${rule.words} — pattern ${rule.pattern}.`;
}

/** The first refusal among `ids` (each named), or undefined when the schema accepts them all. */
export function todoIdsRuleError(ids: Iterable<string>, aiRoot: string): string | undefined {
    const bad = [...ids].filter((id) => todoIdRuleError(id, aiRoot));
    if (!bad.length) { return undefined; }
    const first = todoIdRuleError(bad[0], aiRoot)!;
    return bad.length === 1 ? first : `${first} Also refused: ${bad.slice(1).join(', ')}.`;
}
