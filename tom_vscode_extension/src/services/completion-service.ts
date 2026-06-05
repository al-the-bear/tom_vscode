/**
 * Completion service — pure discovery + ranking logic for the chat-panel
 * `/skill` and `@file` completions (triggered by Ctrl+Shift+S).
 *
 * This module is deliberately **free of `vscode` and `fs`**: all I/O is
 * injected through narrow stores so the orchestration can be unit-tested
 * against in-memory fixtures. The live bridges that wire the stores to
 * `vscode` / `fs` live in `../handlers/completion-picker.ts`.
 *
 * ## Two completion kinds
 *
 *   - **Skills** (`/` trigger): discovered by walking from the workspace
 *     root upward to the filesystem root, collecting every
 *     `<dir>/.claude/skills/<name>/SKILL.md`. A skill living in the
 *     workspace's OWN `.claude/skills/` is **direct** (no note); one found
 *     in a parent folder carries a `(in <relative-skills-dir>)` note so the
 *     user knows it is not directly addressable by the Agent SDK.
 *   - **Files** (`@` trigger): the current workspace only, ranked
 *     open-editors → current-quest-folder → everything else.
 *
 * The text after the trigger filters both kinds (case-insensitive):
 * skills by **name prefix**, files by **basename substring**.
 */

import * as path from 'path';

// ===========================================================================
// Skills
// ===========================================================================

/** A discovered skill, ready for the picker / insertion. */
export interface SkillCompletion {
    /** Skill folder name (the `<name>` in `.claude/skills/<name>/`). */
    name: string;
    /** Absolute path of the `.claude/skills` directory it was found in. */
    skillsDir: string;
    /**
     * True when the skill lives in the workspace's own `.claude/skills/`
     * (directly accessible by the Agent SDK — no note needed).
     */
    direct: boolean;
    /**
     * For non-direct skills, the workspace-relative path of the
     * `.claude/skills` directory (e.g. `../../.claude/skills`). `null`
     * for direct skills.
     */
    noteDir: string | null;
}

/**
 * Injected I/O for skill discovery. The implementation walks the parent
 * chain itself; the store only has to list skill folders for a given
 * `.claude/skills` directory.
 */
export interface SkillStore {
    /** Absolute workspace-root path, or `null` when no workspace is open. */
    wsRoot(): string | null;
    /**
     * Names of the skill folders (each containing a `SKILL.md`) directly
     * inside `claudeSkillsDir`. Returns `[]` when the directory is absent.
     */
    listSkillFolders(claudeSkillsDir: string): string[];
}

/**
 * Discover skills visible from the workspace, filtered by `query`
 * (name prefix, case-insensitive; empty = all). Closer skills win on
 * name collisions: a workspace-own skill masks a same-named ancestor one.
 * Result is sorted by name, direct skills first.
 */
export function discoverSkills(store: SkillStore, query: string): SkillCompletion[] {
    const root = store.wsRoot();
    if (!root) { return []; }

    const prefix = query.trim().toLowerCase();
    const byName = new Map<string, SkillCompletion>();

    let dir = path.resolve(root);
    // Walk from the workspace root upward to the filesystem root.
    for (;;) {
        const skillsDir = path.join(dir, '.claude', 'skills');
        const folders = store.listSkillFolders(skillsDir);
        const isWorkspaceOwn = dir === path.resolve(root);
        for (const name of folders) {
            // First (closest) match wins.
            if (byName.has(name)) { continue; }
            byName.set(name, {
                name,
                skillsDir,
                direct: isWorkspaceOwn,
                noteDir: isWorkspaceOwn ? null : path.relative(root, skillsDir),
            });
        }
        const parent = path.dirname(dir);
        if (parent === dir) { break; } // reached the filesystem root
        dir = parent;
    }

    const matched = Array.from(byName.values()).filter(
        (s) => prefix === '' || s.name.toLowerCase().startsWith(prefix),
    );
    matched.sort((a, b) => {
        // Direct skills first, then alphabetical.
        if (a.direct !== b.direct) { return a.direct ? -1 : 1; }
        return a.name.localeCompare(b.name);
    });
    return matched;
}

/**
 * Inline text to splice into the textarea for a chosen skill. Keeps the
 * `/` trigger so the reference reads as a skill invocation; appends the
 * `(in <dir>)` note for non-direct skills.
 *
 *   direct      → `/tom_reconcile`
 *   non-direct  → `/tom_reconcile (in ../../.claude/skills)`
 */
export function formatSkillInsertion(skill: SkillCompletion): string {
    return skill.direct ? `/${skill.name}` : `/${skill.name} (in ${skill.noteDir})`;
}

// ===========================================================================
// Files
// ===========================================================================

/** A ranked file candidate, ready for the picker / insertion. */
export interface FileCompletion {
    /** Absolute path on disk. */
    absolutePath: string;
    /** File name (basename). */
    name: string;
    /** Workspace-relative path (POSIX separators). */
    relativePath: string;
    /** 1 = open editor, 2 = current quest folder, 3 = other. */
    tier: number;
}

/** Inputs for {@link rankFiles}. All paths are absolute. */
export interface RankFilesInput {
    /** Absolute workspace-root path. */
    wsRoot: string;
    /** Absolute path of the current quest folder, or `null` if none. */
    questFolder: string | null;
    /** Absolute paths of files currently open in editor tabs. */
    openEditors: string[];
    /** Absolute paths of every candidate workspace file. */
    allFiles: string[];
    /** Text typed after `@` (may be empty). */
    query: string;
}

function toRelPosix(wsRoot: string, abs: string): string {
    return path.relative(wsRoot, abs).split(path.sep).join('/');
}

function isUnder(folder: string, file: string): boolean {
    const rel = path.relative(folder, file);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Rank workspace files for the `@` completion: open editors first, then
 * files inside the current quest folder, then everything else. Filtering
 * is a case-insensitive **basename substring** match (empty = all). Files
 * are de-duplicated across tiers (first/highest tier wins) and sorted by
 * basename within each tier.
 */
export function rankFiles(input: RankFilesInput): FileCompletion[] {
    const needle = input.query.trim().toLowerCase();
    const matches = (abs: string): boolean =>
        needle === '' || path.basename(abs).toLowerCase().includes(needle);

    const openSet = new Set(input.openEditors.map((p) => path.resolve(p)));
    const questFolder = input.questFolder ? path.resolve(input.questFolder) : null;

    const tierOf = (abs: string): number => {
        if (openSet.has(path.resolve(abs))) { return 1; }
        if (questFolder && isUnder(questFolder, abs)) { return 2; }
        return 3;
    };

    // Union of all sources, de-duplicated by absolute path.
    const seen = new Set<string>();
    const candidates: FileCompletion[] = [];
    for (const abs of [...input.openEditors, ...input.allFiles]) {
        const resolved = path.resolve(abs);
        if (seen.has(resolved)) { continue; }
        seen.add(resolved);
        if (!matches(abs)) { continue; }
        candidates.push({
            absolutePath: abs,
            name: path.basename(abs),
            relativePath: toRelPosix(input.wsRoot, abs),
            tier: tierOf(abs),
        });
    }

    candidates.sort((a, b) => {
        if (a.tier !== b.tier) { return a.tier - b.tier; }
        const byName = a.name.localeCompare(b.name);
        if (byName !== 0) { return byName; }
        return a.relativePath.localeCompare(b.relativePath);
    });
    return candidates;
}

/**
 * Inline text to splice into the textarea for a chosen file. Keeps the
 * `@` trigger and adds the workspace-relative path in brackets:
 *
 *   `@live-trail.md (_ai/quests/vscode_extension/live-trail.md)`
 */
export function formatFileInsertion(file: FileCompletion): string {
    return `@${file.name} (${file.relativePath})`;
}

// ===========================================================================
// Trigger-token parsing (shared by the webview keydown handler's mirror)
// ===========================================================================

/** The trigger kinds the picker understands. */
export type CompletionKind = 'skill' | 'file';

/** A token detected immediately before the cursor. */
export interface CompletionToken {
    kind: CompletionKind;
    /** Text after the trigger char (the filter query). */
    query: string;
    /** Index in the source string where the trigger char starts. */
    start: number;
    /** Index one past the end of the token (the cursor position). */
    end: number;
}

/**
 * Scan backwards from `cursor` in `text` to find a `/` (skill) or `@`
 * (file) trigger token. A token runs from the trigger char up to the
 * cursor and must not contain whitespace. The trigger must sit at the
 * start of the text or be preceded by whitespace, so `a/b` and an email
 * `x@y` do not trigger. Returns `null` when no token is found.
 *
 * Mirrors the lightweight scan done in the webview; kept here so it is
 * unit-tested against the same edge cases.
 */
export function detectToken(text: string, cursor: number): CompletionToken | null {
    let i = cursor - 1;
    while (i >= 0) {
        const ch = text[i];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { return null; }
        if (ch === '/' || ch === '@') {
            const beforeOk = i === 0 || /\s/.test(text[i - 1]);
            if (!beforeOk) { return null; }
            return {
                kind: ch === '/' ? 'skill' : 'file',
                query: text.slice(i + 1, cursor),
                start: i,
                end: cursor,
            };
        }
        i--;
    }
    return null;
}
