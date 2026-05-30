/**
 * Pure path-resolution helpers for guideline tools.
 *
 * Kept free of any `vscode` dependency so they can be unit-tested
 * against a real on-disk fixture without spinning up an extension
 * host. The thin wrappers in `guideline-tools.ts` look up the
 * workspace root via `vscode.workspace.workspaceFolders` and then
 * delegate everything else here.
 *
 * Two guideline scopes live in the workspace:
 *
 *   - **Global** — `<wsRoot>/_copilot_guidelines/` (recursively).
 *   - **Project** — `<wsRoot>/<projectPath>/_copilot_guidelines/`
 *     (recursively), for any project folder that has one.
 *
 * The previous implementation accepted only a bare basename (or a
 * subfolder/basename path resolved relative to the scope's root). When
 * the LLM passed the full workspace-relative path it had just seen
 * from `tomAi_findFiles` (e.g. `tom_ai/vscode/.../local_llm.md`), the
 * lookup missed and the model spiralled into a retry loop. These
 * helpers fix that by:
 *
 *   1. Stripping the global-root prefix when present
 *      (`_copilot_guidelines/foo.md` → `foo.md`).
 *   2. Detecting embedded `_copilot_guidelines/` segments and
 *      classifying the request as "project guideline" so the caller
 *      can either delegate to the project handler or surface a clear
 *      error message that names the project.
 *   3. Always returning enough context (`kind`, `projectPath`,
 *      `relPath`) so callers don't have to re-parse the input.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Canonical folder name for guideline collections at any scope. */
export const GUIDELINE_FOLDER = '_copilot_guidelines';

/** Outcome of classifying a user-supplied path. */
export type GuidelineClassification =
    | {
        /** Looks like a global-scope request: under the workspace's own
         *  `_copilot_guidelines/` folder. `relPath` is relative to
         *  that folder (e.g. `dart/coding_guidelines.md`). */
        kind: 'global';
        relPath: string;
    }
    | {
        /** Looks like a project-scope request: the path mentions a
         *  `_copilot_guidelines/` segment that is NOT the workspace
         *  one. `projectPath` is workspace-relative (e.g. `tom_ai/
         *  vscode/tom_vscode_extension`), `relPath` is relative to
         *  that project's `_copilot_guidelines/` folder. */
        kind: 'project';
        projectPath: string;
        relPath: string;
    };

/** Normalise a user-supplied path: strip leading `./`, collapse to forward
 *  slashes, strip a trailing slash. Never returns a leading slash. */
export function normaliseGuidelineInput(raw: string): string {
    let s = (raw ?? '').trim();
    if (!s) { return ''; }
    s = s.replace(/\\/g, '/');
    s = s.replace(/^\.\//, '');
    s = s.replace(/^\/+/, '');
    s = s.replace(/\/+$/, '');
    return s;
}

/**
 * Strip the `.md` requirement: input can be `foo`, `foo.md`, `dir/foo`,
 * `dir/foo.md`. Output always ends in `.md` (unless input was empty).
 */
export function ensureMdSuffix(name: string): string {
    if (!name) { return name; }
    return name.endsWith('.md') ? name : `${name}.md`;
}

/**
 * Classify a user-supplied guideline path.
 *
 * Rules (first match wins):
 *
 *   1. Empty → returns global with empty relPath (caller treats as
 *      "list the index").
 *   2. Contains a `_copilot_guidelines/` segment:
 *        - If the part before it is empty → **global**, with the
 *          remainder as relPath.
 *        - Otherwise → **project**, with the part before as
 *          projectPath and the remainder as relPath.
 *      (We pick the LAST `_copilot_guidelines/` segment so nested
 *      copies don't trip the parser.)
 *   3. Otherwise → **global**, with the whole path as relPath.
 *
 * Absolute paths are treated as workspace-relative when they start
 * with the wsRoot prefix; otherwise classified by the rules above
 * (the caller decides whether to honour an out-of-workspace request).
 */
export function classifyGuidelinePath(
    input: string,
    wsRoot: string | undefined = undefined,
): GuidelineClassification {
    let s = normaliseGuidelineInput(input);
    // Strip wsRoot prefix if present so an absolute path inside the
    // workspace is treated the same as the workspace-relative form.
    if (wsRoot && s.startsWith(normaliseGuidelineInput(wsRoot) + '/')) {
        s = s.slice(normaliseGuidelineInput(wsRoot).length + 1);
    }
    if (!s) {
        return { kind: 'global', relPath: '' };
    }
    // Find the LAST `_copilot_guidelines/` segment. Using a regex with
    // anchored slashes avoids false-positives like `..._copilot_guidelinesX/`.
    const marker = `/${GUIDELINE_FOLDER}/`;
    const leadingMarker = `${GUIDELINE_FOLDER}/`;
    let cutIdx = -1;
    if (s.startsWith(leadingMarker)) {
        // Whole path lives directly under the global folder.
        return { kind: 'global', relPath: s.slice(leadingMarker.length) };
    }
    cutIdx = s.lastIndexOf(marker);
    if (cutIdx >= 0) {
        const projectPath = s.slice(0, cutIdx);
        const relPath = s.slice(cutIdx + marker.length);
        if (!projectPath) {
            return { kind: 'global', relPath };
        }
        return { kind: 'project', projectPath, relPath };
    }
    // Bare path with no marker — assume global scope.
    return { kind: 'global', relPath: s };
}

/**
 * Recursively walk `dir`, returning all `.md` files (excluding hidden
 * entries) as `{ path, size }` where `path` is relative to `baseDir`.
 * Errors are swallowed — a single unreadable subdirectory shouldn't
 * abort the whole walk.
 */
export function walkMarkdown(dir: string, baseDir: string): Array<{ path: string; size: number }> {
    const out: Array<{ path: string; size: number }> = [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.name.startsWith('.')) { continue; }
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...walkMarkdown(abs, baseDir));
        } else if (e.name.endsWith('.md')) {
            try {
                const stat = fs.statSync(abs);
                out.push({ path: path.relative(baseDir, abs), size: stat.size });
            } catch { /* ignore */ }
        }
    }
    return out;
}

/**
 * Resolve a guideline file inside `baseDir`. Tries (in order):
 *
 *   1. The exact relative path (with `.md` auto-appended if missing).
 *   2. A recursive walk that matches the **basename** of the target.
 *
 * Returns the absolute path on disk, or undefined when not found.
 * The basename fallback is what lets the model say
 * `tomAi_readGlobalGuideline({ fileName: "coding_guidelines" })`
 * even when the file actually lives in `dart/coding_guidelines.md`.
 */
export function resolveGuidelineFile(baseDir: string, relPath: string): string | undefined {
    if (!relPath) { return undefined; }
    const target = ensureMdSuffix(relPath);
    const direct = path.join(baseDir, target);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) { return direct; }
    const basename = path.basename(target);
    const found = walkMarkdown(baseDir, baseDir).find((f) => path.basename(f.path) === basename);
    return found ? path.join(baseDir, found.path) : undefined;
}

/**
 * Compute the absolute paths to:
 *   - the workspace's global `_copilot_guidelines/` folder
 *   - the workspace-relative project path's `_copilot_guidelines/` folder
 *
 * Returns undefined for either when the folder doesn't exist on disk.
 */
export function globalGuidelinesRoot(wsRoot: string | undefined): string | undefined {
    if (!wsRoot) { return undefined; }
    const p = path.join(wsRoot, GUIDELINE_FOLDER);
    return fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : undefined;
}

export function projectGuidelinesRoot(wsRoot: string | undefined, projectPath: string): string | undefined {
    if (!projectPath) { return undefined; }
    const abs = path.isAbsolute(projectPath)
        ? projectPath
        : (wsRoot ? path.join(wsRoot, projectPath) : projectPath);
    const candidate = path.join(abs, GUIDELINE_FOLDER);
    return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() ? candidate : undefined;
}

/**
 * Escape regex metachars in `s` so it can be used as a literal substring
 * pattern. Kept as a tiny helper so the search functions stay readable.
 */
export function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Substring search across every `.md` file under `baseDir`. Returns
 * up to `maxMatches` matches as `{ file (relative), line (1-based),
 * text (line content, clipped to 200 chars) }`. `caseSensitive`
 * defaults false in callers.
 */
export function searchMarkdown(
    baseDir: string,
    query: string,
    caseSensitive: boolean,
    maxMatches: number,
): Array<{ file: string; line: number; text: string }> {
    const flags = caseSensitive ? 'g' : 'gi';
    const pattern = new RegExp(escapeRegex(query), flags);
    const files = walkMarkdown(baseDir, baseDir);
    const matches: Array<{ file: string; line: number; text: string }> = [];
    for (const f of files) {
        if (matches.length >= maxMatches) { break; }
        let content: string;
        try { content = fs.readFileSync(path.join(baseDir, f.path), 'utf8'); } catch { continue; }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            // `pattern` is global; reset between line tests so the
            // RegExp.test() state doesn't carry stale lastIndex.
            pattern.lastIndex = 0;
            if (pattern.test(lines[i])) {
                matches.push({ file: f.path, line: i + 1, text: lines[i].slice(0, 200) });
                if (matches.length >= maxMatches) { break; }
            }
        }
    }
    return matches;
}
