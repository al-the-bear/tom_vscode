/**
 * The expression language of `${{ … }}` template placeholders.
 *
 * A template decides what to write with a small expression language, parsed and
 * evaluated here — no JavaScript is run. What the templates in use need, and
 * nothing more:
 *
 *   name                     a variable, as `${name}` would read it ('' when unset)
 *   "text"  'text'           a string; escapes \n \t \r \" \' \\
 *   42  1.5                  a number
 *   true  false
 *   a + b                    string concatenation
 *   a == b   a != b          equality of the two as text
 *   a < b  a <= b  a > b  a >= b
 *                            numeric when both are numbers, else text order
 *   a && b   a || b   !a     JavaScript-style: `a || b` is a when a is set, else b
 *   a ? b : c                the conditional
 *   ( a )
 *   empty(a) notEmpty(a) lower(a) upper(a) default(a, b)
 *
 * A value is "set" (true) when it is a non-empty string, true, or a non-zero
 * number. Variable names are letters, digits, `_`, `.` and `-`, starting with a
 * letter or `_` (`process-context`, `git.dirty`, `file.name`); `-` is part of
 * a name, there is no subtraction. The first segment of a name may not be one
 * of the objects the former JavaScript placeholders offered (`vars`, `editor`,
 * `vscode`, `os`, `path`, `Number`, …): such an expression is a template still
 * written in JavaScript, and is refused with a pointer to the migration.
 *
 * {@link convertJsExpression} turns the JavaScript the templates used into this
 * language (the `_ai` format migration, aiFormatMigration.ts). vscode-free.
 */

export type ExpressionValue = string | number | boolean;

/** Looks a variable up; undefined when it has no value. */
export type ExpressionLookup = (name: string) => string | undefined;

export class ExpressionError extends Error {
    constructor(message: string, readonly position: number) {
        super(message);
        this.name = 'ExpressionError';
    }
}

/** The helpers an expression may call, with their arity. */
export const EXPRESSION_HELPERS: Readonly<Record<string, number>> = Object.freeze({
    empty: 1, notEmpty: 1, lower: 1, upper: 1, default: 2,
});

/** The objects of the former JavaScript placeholders; a name starting with one is old JavaScript. */
export const JS_RESERVED_NAMES: readonly string[] = [
    'vars', 'editor', 'vscode', 'os', 'path', 'process', 'Number', 'String', 'Math', 'Date', 'JSON', 'Object', 'Array',
];

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type Token =
    | { kind: 'string'; value: string; pos: number }
    | { kind: 'number'; value: number; pos: number }
    | { kind: 'name'; value: string; pos: number }
    | { kind: 'op'; value: string; pos: number }
    | { kind: 'end'; pos: number };

const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '+', '?', ':', '(', ')', ','];

function readString(src: string, start: number): { value: string; end: number } {
    const quote = src[start];
    let value = '';
    let i = start + 1;
    while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
            const c = src[i + 1];
            value += c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c;
            i += 2;
        } else {
            value += src[i++];
        }
    }
    if (i >= src.length) { throw new ExpressionError('unterminated string', start); }
    return { value, end: i + 1 };
}

function tokenize(src: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === '"' || c === "'") {
            const { value, end } = readString(src, i);
            tokens.push({ kind: 'string', value, pos: i });
            i = end;
            continue;
        }
        const num = /^\d+(\.\d+)?/.exec(src.slice(i));
        if (num) {
            tokens.push({ kind: 'number', value: Number(num[0]), pos: i });
            i += num[0].length;
            continue;
        }
        const name = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(src.slice(i));
        if (name) {
            // A trailing `.` or `-` belongs to no name (`a.` is a typo, not a name).
            const text = name[0].replace(/[.-]+$/, '');
            if (JS_RESERVED_NAMES.includes(text.split('.')[0])) {
                throw new ExpressionError(
                    `"${text}" is JavaScript, which templates no longer run: write the variable's name (e.g. process-context, not vars["process-context"]); npm run migrate:ai-formats converts saved templates`,
                    i,
                );
            }
            tokens.push({ kind: 'name', value: text, pos: i });
            i += text.length;
            continue;
        }
        const op = OPERATORS.find((o) => src.startsWith(o, i));
        if (!op) { throw new ExpressionError(`unexpected "${c}"`, i); }
        tokens.push({ kind: 'op', value: op, pos: i });
        i += op.length;
    }
    tokens.push({ kind: 'end', pos: src.length });
    return tokens;
}

// ---------------------------------------------------------------------------
// Syntax tree
// ---------------------------------------------------------------------------

export type ExpressionNode =
    | { type: 'literal'; value: ExpressionValue }
    | { type: 'variable'; name: string }
    | { type: 'not'; operand: ExpressionNode }
    | { type: 'binary'; op: string; left: ExpressionNode; right: ExpressionNode }
    | { type: 'conditional'; test: ExpressionNode; then: ExpressionNode; else: ExpressionNode }
    | { type: 'call'; helper: string; args: ExpressionNode[] };

class Parser {
    private i = 0;
    constructor(private readonly tokens: Token[]) {}

    parse(): ExpressionNode {
        const node = this.conditional();
        const t = this.peek();
        if (t.kind !== 'end') { throw new ExpressionError(`unexpected ${describe(t)}`, t.pos); }
        return node;
    }

    private peek(): Token { return this.tokens[this.i]; }
    private next(): Token { return this.tokens[this.i++]; }
    private isOp(value: string): boolean {
        const t = this.peek();
        return t.kind === 'op' && t.value === value;
    }
    private expect(value: string): void {
        const t = this.next();
        if (t.kind !== 'op' || t.value !== value) { throw new ExpressionError(`expected "${value}", found ${describe(t)}`, t.pos); }
    }

    private conditional(): ExpressionNode {
        const test = this.or();
        if (!this.isOp('?')) { return test; }
        this.next();
        const then = this.conditional();
        this.expect(':');
        return { type: 'conditional', test, then, else: this.conditional() };
    }

    private or(): ExpressionNode {
        let left = this.and();
        while (this.isOp('||')) { this.next(); left = { type: 'binary', op: '||', left, right: this.and() }; }
        return left;
    }

    private and(): ExpressionNode {
        let left = this.comparison();
        while (this.isOp('&&')) { this.next(); left = { type: 'binary', op: '&&', left, right: this.comparison() }; }
        return left;
    }

    private comparison(): ExpressionNode {
        const left = this.concat();
        const t = this.peek();
        if (t.kind === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.value)) {
            this.next();
            return { type: 'binary', op: t.value, left, right: this.concat() };
        }
        return left;
    }

    private concat(): ExpressionNode {
        let left = this.unary();
        while (this.isOp('+')) { this.next(); left = { type: 'binary', op: '+', left, right: this.unary() }; }
        return left;
    }

    private unary(): ExpressionNode {
        if (this.isOp('!')) { this.next(); return { type: 'not', operand: this.unary() }; }
        return this.primary();
    }

    private primary(): ExpressionNode {
        const t = this.next();
        if (t.kind === 'string' || t.kind === 'number') { return { type: 'literal', value: t.value }; }
        if (t.kind === 'op' && t.value === '(') {
            const inner = this.conditional();
            this.expect(')');
            return inner;
        }
        if (t.kind === 'name') {
            if (t.value === 'true' || t.value === 'false') { return { type: 'literal', value: t.value === 'true' }; }
            if (this.isOp('(')) { return this.call(t); }
            return { type: 'variable', name: t.value };
        }
        throw new ExpressionError(`unexpected ${describe(t)}`, t.pos);
    }

    private call(name: Token & { kind: 'name' }): ExpressionNode {
        const arity = EXPRESSION_HELPERS[name.value];
        if (arity === undefined) {
            throw new ExpressionError(`unknown helper ${name.value}() (helpers: ${Object.keys(EXPRESSION_HELPERS).join(', ')})`, name.pos);
        }
        this.expect('(');
        const args: ExpressionNode[] = [];
        if (!this.isOp(')')) {
            args.push(this.conditional());
            while (this.isOp(',')) { this.next(); args.push(this.conditional()); }
        }
        this.expect(')');
        if (args.length !== arity) { throw new ExpressionError(`${name.value}() takes ${arity} argument(s), got ${args.length}`, name.pos); }
        return { type: 'call', helper: name.value, args };
    }
}

function describe(t: Token): string {
    if (t.kind === 'end') { return 'the end of the expression'; }
    if (t.kind === 'string') { return 'a string'; }
    return `"${String(t.value)}"`;
}

/** The syntax tree of an expression; throws {@link ExpressionError} on a syntax error. */
export function parseExpression(source: string): ExpressionNode {
    return new Parser(tokenize(source)).parse();
}

/** The variables an expression reads, in order of first use; throws {@link ExpressionError} on a syntax error. */
export function expressionVariableNames(source: string): string[] {
    const names: string[] = [];
    const walk = (n: ExpressionNode): void => {
        switch (n.type) {
            case 'variable': if (!names.includes(n.name)) { names.push(n.name); } return;
            case 'not': walk(n.operand); return;
            case 'binary': walk(n.left); walk(n.right); return;
            case 'conditional': walk(n.test); walk(n.then); walk(n.else); return;
            case 'call': n.args.forEach(walk); return;
            default: return;
        }
    };
    walk(parseExpression(source));
    return names;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export function isSet(value: ExpressionValue): boolean {
    if (typeof value === 'boolean') { return value; }
    if (typeof value === 'number') { return value !== 0 && !Number.isNaN(value); }
    return value.length > 0;
}

export function expressionText(value: ExpressionValue): string {
    return typeof value === 'string' ? value : String(value);
}

function asNumber(value: ExpressionValue): number | undefined {
    if (typeof value === 'number') { return value; }
    if (typeof value !== 'string' || value.trim() === '') { return undefined; }
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : undefined;
}

function compare(op: string, a: ExpressionValue, b: ExpressionValue): boolean {
    if (op === '==') { return expressionText(a) === expressionText(b); }
    if (op === '!=') { return expressionText(a) !== expressionText(b); }
    const na = asNumber(a);
    const nb = asNumber(b);
    const [x, y]: [number | string, number | string] = na !== undefined && nb !== undefined ? [na, nb] : [expressionText(a), expressionText(b)];
    switch (op) {
        case '<': return x < y;
        case '<=': return x <= y;
        case '>': return x > y;
        default: return x >= y;
    }
}

function evaluateNode(node: ExpressionNode, lookup: ExpressionLookup): ExpressionValue {
    switch (node.type) {
        case 'literal': return node.value;
        case 'variable': return lookup(node.name) ?? '';
        case 'not': return !isSet(evaluateNode(node.operand, lookup));
        case 'conditional':
            return isSet(evaluateNode(node.test, lookup)) ? evaluateNode(node.then, lookup) : evaluateNode(node.else, lookup);
        case 'call': {
            const args = node.args.map((a) => evaluateNode(a, lookup));
            switch (node.helper) {
                case 'empty': return !isSet(args[0]);
                case 'notEmpty': return isSet(args[0]);
                case 'lower': return expressionText(args[0]).toLowerCase();
                case 'upper': return expressionText(args[0]).toUpperCase();
                default: return isSet(args[0]) ? args[0] : args[1];
            }
        }
        case 'binary': {
            if (node.op === '&&') {
                const left = evaluateNode(node.left, lookup);
                return isSet(left) ? evaluateNode(node.right, lookup) : left;
            }
            if (node.op === '||') {
                const left = evaluateNode(node.left, lookup);
                return isSet(left) ? left : evaluateNode(node.right, lookup);
            }
            const left = evaluateNode(node.left, lookup);
            const right = evaluateNode(node.right, lookup);
            if (node.op === '+') { return expressionText(left) + expressionText(right); }
            return compare(node.op, left, right);
        }
    }
}

/** Evaluate an expression to the text a template gets; throws {@link ExpressionError} on a syntax error. */
export function evaluateExpression(source: string | ExpressionNode, lookup: ExpressionLookup): string {
    const node = typeof source === 'string' ? parseExpression(source) : source;
    return expressionText(evaluateNode(node, lookup));
}

// ---------------------------------------------------------------------------
// Converting the former JavaScript placeholders
// ---------------------------------------------------------------------------

type JsToken = { kind: 'string'; value: string } | { kind: 'number'; text: string } | { kind: 'ident'; value: string } | { kind: 'punct'; value: string };

const JS_PUNCT = ['===', '!==', '?.', '==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '+', '?', ':', '(', ')', '[', ']', '.', ','];

function tokenizeJs(src: string): JsToken[] {
    const tokens: JsToken[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === '"' || c === "'") {
            const { value, end } = readString(src, i);
            tokens.push({ kind: 'string', value });
            i = end;
            continue;
        }
        const num = /^\d+(\.\d+)?/.exec(src.slice(i));
        if (num) { tokens.push({ kind: 'number', text: num[0] }); i += num[0].length; continue; }
        const ident = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
        if (ident) { tokens.push({ kind: 'ident', value: ident[0] }); i += ident[0].length; continue; }
        const p = JS_PUNCT.find((o) => src.startsWith(o, i));
        if (!p) { throw new Error(`"${c}" has no counterpart in the expression language`); }
        tokens.push({ kind: 'punct', value: p });
        i += p.length;
    }
    return tokens;
}

function quote(text: string): string {
    return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r') + '"';
}

function isPunct(t: JsToken | undefined, value: string): boolean {
    return t?.kind === 'punct' && t.value === value;
}

/**
 * The JavaScript of a former `${{ … }}` placeholder in the expression language,
 * or why it cannot be converted. Converted: `vars["x"]` / `vars.x` → `x`;
 * `Number(x)` → `x` (comparisons are numeric when both sides are numbers);
 * `editor?.document.getText(editor.selection)` → `selection`; `===` / `!==` →
 * `==` / `!=`; strings, numbers, `true` / `false`, the operators the language
 * has. Anything else — another object, a method call, arithmetic, `??` — is
 * refused, so a template is never converted into something that means less.
 */
export function convertJsExpression(js: string): { ok: true; expression: string } | { ok: false; reason: string } {
    let tokens: JsToken[];
    try { tokens = tokenizeJs(js); } catch (e) { return { ok: false, reason: (e as Error).message }; }
    // `Number(x) + 1` is arithmetic in JavaScript; the language's `+` joins text.
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].kind !== 'ident' || (tokens[i] as { value: string }).value !== 'Number' || !isPunct(tokens[i + 1], '(')) { continue; }
        let depth = 0;
        let close = i + 1;
        for (; close < tokens.length; close++) {
            if (isPunct(tokens[close], '(')) { depth++; }
            if (isPunct(tokens[close], ')') && --depth === 0) { break; }
        }
        if (isPunct(tokens[i - 1], '+') || isPunct(tokens[close + 1], '+')) {
            return { ok: false, reason: 'Number(…) + … is arithmetic, which the expression language does not have' };
        }
    }
    const out: string[] = [];
    const name = (n: string): string | undefined => (NAME_RE.test(n) && !JS_RESERVED_NAMES.includes(n.split('.')[0]) ? n : undefined);
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.kind === 'string') { out.push(quote(t.value)); continue; }
        if (t.kind === 'number') { out.push(t.text); continue; }
        if (t.kind === 'punct') {
            // eslint-disable-next-line @typescript-eslint/naming-convention -- operators as keys
            const map: Record<string, string> = { '===': '==', '!==': '!=' };
            if (['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '+', '?', ':', '(', ')', '===', '!=='].includes(t.value)) {
                out.push(map[t.value] ?? t.value);
                continue;
            }
            return { ok: false, reason: `"${t.value}" has no counterpart in the expression language` };
        }
        // An identifier.
        if (t.value === 'true' || t.value === 'false') { out.push(t.value); continue; }
        if (t.value === 'vars') {
            const a = tokens[i + 1];
            const b = tokens[i + 2];
            if (isPunct(a, '[') && b?.kind === 'string' && isPunct(tokens[i + 3], ']')) {
                const n = name(b.value);
                if (!n) { return { ok: false, reason: `the variable name "${b.value}" cannot be written in the expression language` }; }
                out.push(n);
                i += 3;
                continue;
            }
            if (isPunct(a, '.') && b?.kind === 'ident' && !isPunct(tokens[i + 3], '.') && !isPunct(tokens[i + 3], '(')) {
                const n = name(b.value);
                if (!n) { return { ok: false, reason: `the variable name "${b.value}" cannot be written in the expression language` }; }
                out.push(n);
                i += 2;
                continue;
            }
            return { ok: false, reason: 'vars is used other than as vars["name"] or vars.name' };
        }
        if (t.value === 'Number' && isPunct(tokens[i + 1], '(')) {
            // Number(<one variable>) — the comparison is numeric anyway; the parentheses stay harmless.
            out.push('(');
            i += 1;
            continue;
        }
        // editor?.document.getText(editor.selection) (or with `.`) is the `selection` variable.
        const run = tokens.slice(i, i + 10).map((x) => (x.kind === 'ident' || x.kind === 'punct' ? x.value : '\u0000'));
        if (['?.', '.'].includes(run[1]) && run.slice(2).join(' ') === 'document . getText ( editor . selection )' && run[0] === 'editor') {
            out.push('selection');
            i += 9;
            continue;
        }
        return { ok: false, reason: `"${t.value}" (JavaScript object or function) has no counterpart in the expression language` };
    }
    const expression = out.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')');
    try { parseExpression(expression); } catch (e) { return { ok: false, reason: `the converted form does not parse: ${(e as Error).message}` }; }
    return { ok: true, expression };
}

/** The `${{ … }}` placeholders of a text; `$${{ … }}` is an escaped literal and is skipped. */
const EXPRESSION_PLACEHOLDER = /(?<!\$)\$\{\{([\s\S]*?)\}\}/g;

/**
 * A template text with every JavaScript `${{ … }}` placeholder converted.
 * A placeholder already in the expression language is left as it is. When one
 * cannot be converted, the text is returned unchanged (never half-converted)
 * with the reasons.
 */
export function convertTemplateText(text: string): { text: string; converted: number; problems: string[] } {
    const problems: string[] = [];
    let converted = 0;
    const result = text.replace(EXPRESSION_PLACEHOLDER, (match, inner: string) => {
        try {
            parseExpression(inner);
            return match; // already the expression language
        } catch { /* JavaScript, or broken: convert below */ }
        const c = convertJsExpression(inner.trim());
        if (!c.ok) {
            problems.push(`\${{${inner.trim().slice(0, 80)}${inner.trim().length > 80 ? '…' : ''}}}: ${c.reason}`);
            return match;
        }
        converted++;
        return `\${{ ${c.expression} }}`;
    });
    return problems.length > 0 ? { text, converted: 0, problems } : { text: result, converted, problems };
}

/** Every `${{ … }}` placeholder of a text, for the resolver. */
export function forEachExpressionPlaceholder(text: string, replace: (expression: string) => string): string {
    return text.replace(EXPRESSION_PLACEHOLDER, (_m, inner: string) => replace(inner.trim()));
}
