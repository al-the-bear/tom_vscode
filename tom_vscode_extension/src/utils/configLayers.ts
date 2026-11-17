/**
 * The configuration in layers (workspace layout convention § 5, BP-19 / BP-20).
 *
 * `tom_vscode_extension.json` is read from several layers — the compiled
 * defaults, the user-global file, the root's `.tom`, the workspace folder's
 * `.tom` — and merged key by key: **objects are deep-merged, arrays and
 * scalars replace**. Writes go to one file (the root's, BP-18) and carry
 * only what changed: the difference between the merged view a caller read
 * and the value it saves, as a JSON merge patch (RFC 7386) applied to the
 * target file as it is on disk. Keys that come only from other layers are
 * never written into it.
 *
 * Pure apart from `readConfigLayers` (which reads files); every rule is
 * tested in `__tests__/configLayers.test.ts`.
 */

import * as fs from 'fs';

type Json = unknown;
type JsonObject = Record<string, unknown>;

/** A plain object (not an array, not null). */
export function isPlainObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
    return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

/** `over` on top of `base`: objects merged key by key, everything else replaces. */
export function deepMergeTwo(base: Json, over: Json): Json {
    if (over === undefined) { return clone(base); }
    if (isPlainObject(base) && isPlainObject(over)) {
        const out: JsonObject = clone(base) as JsonObject;
        for (const [key, value] of Object.entries(over)) {
            if (value === undefined) { continue; }
            out[key] = key in out ? deepMergeTwo(out[key], value) : clone(value);
        }
        return out;
    }
    return clone(over);
}

/** The layers merged, lowest first. */
export function deepMerge(...layers: Json[]): JsonObject {
    let out: Json = {};
    for (const layer of layers) {
        if (isPlainObject(layer)) { out = deepMergeTwo(out, layer); }
    }
    return out as JsonObject;
}

function same(a: Json, b: Json): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The merge patch that turns `base` into `next`: changed and added keys with
 * their new value (objects recursively), removed keys as `null`. `undefined`
 * when nothing changed.
 */
export function mergePatch(base: Json, next: Json): Json | undefined {
    if (same(base, next)) { return undefined; }
    if (isPlainObject(base) && isPlainObject(next)) {
        const patch: JsonObject = {};
        for (const [key, value] of Object.entries(next)) {
            if (value === undefined) { continue; }
            const sub = key in base ? mergePatch(base[key], value) : clone(value);
            if (sub !== undefined) { patch[key] = sub; }
        }
        for (const key of Object.keys(base)) {
            if (base[key] !== undefined && (!(key in next) || next[key] === undefined)) { patch[key] = null; }
        }
        return Object.keys(patch).length > 0 ? patch : undefined;
    }
    return next === undefined ? null : clone(next);
}

/** `target` with `patch` applied: objects recursively, `null` deletes, the rest replaces. */
export function applyMergePatch(target: Json, patch: Json): Json {
    if (!isPlainObject(patch)) { return clone(patch); }
    const out: JsonObject = isPlainObject(target) ? clone(target) as JsonObject : {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) { delete out[key]; continue; }
        out[key] = isPlainObject(value) ? applyMergePatch(out[key], value) : clone(value);
    }
    return out;
}

/** A layer file as read: its path, whether it exists, its content or why it is unreadable. */
export interface ConfigLayerFile {
    path: string;
    exists: boolean;
    /** The parsed content; undefined when missing, empty or unreadable. */
    content?: JsonObject;
    /** The file exists but does not parse (or is no object). */
    unreadable?: boolean;
}

/** The real path of a file, or the path itself when it cannot be resolved. */
function realOrSelf(p: string): string {
    try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * Read the layer files, lowest first. A file that is the same file as an
 * earlier one (a symlink to it) is read once: it is left out.
 */
export function readConfigLayers(
    paths: readonly string[],
    parse: (raw: string, filePath: string) => JsonObject | undefined,
    caseInsensitive: boolean = process.platform === 'win32',
    readText: (filePath: string) => string | undefined = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } },
): ConfigLayerFile[] {
    const seen = new Set<string>();
    const out: ConfigLayerFile[] = [];
    for (const p of paths) {
        const key = caseInsensitive ? realOrSelf(p).toLowerCase() : realOrSelf(p);
        if (seen.has(key)) { continue; }
        seen.add(key);
        const raw = readText(p);
        if (raw === undefined) { out.push({ path: p, exists: fs.existsSync(p) }); continue; }
        if (!raw.trim()) { out.push({ path: p, exists: true }); continue; }
        const content = parse(raw, p);
        out.push(content ? { path: p, exists: true, content } : { path: p, exists: true, unreadable: true });
    }
    return out;
}
