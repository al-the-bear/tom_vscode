/**
 * The `.claude/<kind>` folders visible from a workspace: its own and every
 * parent folder's, nearest first — where Claude Code's skills
 * (`.claude/skills`), subagent definitions (`.claude/agents`) and commands
 * are looked up. A definition in a nearer folder masks one of the same name
 * further up.
 *
 * Also the frontmatter helpers their definition files share. Pure (no I/O):
 * the callers list and read the folders themselves.
 */

import * as path from 'path';
import { parse as parseYaml } from 'yaml';

export interface ClaudeDir {
    /** Absolute `<dir>/.claude/<kind>` path. */
    dir: string;
    /** True for the workspace's own `.claude/<kind>`. */
    direct: boolean;
}

/** `<root>/.claude/<kind>`, then each parent's, up to the filesystem root. */
export function claudeDirsUpward(wsRoot: string, kind: string): ClaudeDir[] {
    const out: ClaudeDir[] = [];
    let dir = path.resolve(wsRoot);
    const root = dir;
    for (;;) {
        out.push({ dir: path.join(dir, '.claude', kind), direct: dir === root });
        const parent = path.dirname(dir);
        if (parent === dir) { return out; }
        dir = parent;
    }
}

/** A Claude Code definition file split into its YAML frontmatter and body; a file without frontmatter is all body. */
export function splitFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!match) { return { meta: {}, body: text }; }
    try {
        const parsed: unknown = parseYaml(match[1]);
        return { meta: parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}, body: match[2] };
    } catch {
        // Unreadable frontmatter: the body still stands.
        return { meta: {}, body: match[2] };
    }
}

/** A frontmatter value as a list: a YAML list, or a comma-separated string; undefined when absent. */
export function frontmatterList(value: unknown): string[] | undefined {
    if (Array.isArray(value)) { return value.map((v) => String(v).trim()).filter((v) => v); }
    if (typeof value === 'string') { return value.split(',').map((v) => v.trim()).filter((v) => v); }
    return undefined;
}

/** A non-empty trimmed frontmatter string, or undefined. */
export function frontmatterString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** The first line of prose in a body (headings skipped): a description where none is stated. */
export function firstProseLine(body: string): string {
    return body.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#')) ?? '';
}
