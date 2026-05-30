/**
 * Temp-workspace builders for tool tests. Each builder returns a
 * `Fixture` handle with the absolute root path plus a synchronous
 * `cleanup()` function. Use the `after()` hook from `node:test` to
 * call `cleanup()` once the suite is done:
 *
 *   import { after, before } from 'node:test';
 *   import { mkSmallWorkspace, type Fixture } from './_fixtures.js';
 *
 *   let ws: Fixture;
 *   before(() => { ws = mkSmallWorkspace(); });
 *   after(() => ws.cleanup());
 *
 * Why three sizes:
 *
 *   - **Small** (≈ 100 files) — default for tests that just need a
 *     realistic shape. Cheap to build, cheap to throw away. Use for
 *     correctness checks and simple timing.
 *   - **Medium** (≈ 1 000 files) — exercises pagination / sort
 *     stability without taking forever. Use for tools that page
 *     through results.
 *   - **Large** (≈ 10 000 files across nested dirs, mixed extensions)
 *     — the `findFiles` / `findTextInFiles` walkers must stay under
 *     the 5-second ceiling on this. Tools that allocate per-file
 *     (e.g. loading every file into memory) will fall over here, by
 *     design — that's the regression we want to catch early.
 *
 * `mkQuestFolder(questId, subsystems)` is the prompt-history fixture —
 * the per-quest summary-trail layout under `_ai/quests/<quest>/`.
 *
 * All builders write into `os.tmpdir()`. Cleanup is best-effort; a
 * leftover temp dir on a failed test run is harmless and is collected
 * by the OS eventually.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Fixture {
    /** Absolute path to the workspace root. */
    root: string;
    /** Best-effort recursive delete. Safe to call multiple times. */
    cleanup(): void;
}

export interface WorkspaceOptions {
    /**
     * Optional prefix for the mkdtemp directory. Useful when you want
     * to grep test logs by which fixture leaked. Default `'fixture-'`.
     */
    prefix?: string;
}

// ---------------------------------------------------------------------------
// Implementation helpers
// ---------------------------------------------------------------------------

function mkdtemp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkFixture(root: string): Fixture {
    let cleaned = false;
    return {
        root,
        cleanup(): void {
            if (cleaned) { return; }
            cleaned = true;
            try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
        },
    };
}

/** Write `contents` to `<root>/<rel>`, creating parent dirs as needed. */
export function writeFile(root: string, rel: string, contents: string): string {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
    return abs;
}

/** Convenience for tests: build many `<dir>/<n>.<ext>` files cheaply. */
export function writeManyFiles(
    root: string,
    dir: string,
    count: number,
    options: { ext?: string; bodyFor?: (i: number) => string } = {},
): void {
    const ext = options.ext ?? 'md';
    const bodyFor = options.bodyFor ?? ((i) => `# file ${i}\n\nbody line A\nbody line B (id=${i})\n`);
    const absDir = path.join(root, dir);
    fs.mkdirSync(absDir, { recursive: true });
    for (let i = 0; i < count; i++) {
        fs.writeFileSync(path.join(absDir, `file_${i.toString().padStart(5, '0')}.${ext}`), bodyFor(i), 'utf-8');
    }
}

// ---------------------------------------------------------------------------
// Small workspace (~100 files)
// ---------------------------------------------------------------------------

/**
 * Small workspace with realistic shape: a handful of source files, a
 * config file, a `_copilot_guidelines/` folder, and a `doc/` folder.
 * Total: roughly 100 markdown + source files.
 */
export function mkSmallWorkspace(options: WorkspaceOptions = {}): Fixture {
    const root = mkdtemp(options.prefix ?? 'fixture-small-');
    // Source files
    writeFile(root, 'src/index.ts', "export const main = () => 'small';\n");
    writeFile(root, 'src/utils/format.ts', "export const fmt = (s: string) => s.trim();\n");
    writeFile(root, 'src/utils/parse.ts', "export const parse = (s: string) => JSON.parse(s);\n");
    writeManyFiles(root, 'src/components', 20, { ext: 'ts', bodyFor: (i) => `export const C${i} = () => 'c${i}';\n` });

    // Docs
    writeFile(root, 'doc/README.md', '# Small workspace\n\nReadme content.\n');
    writeManyFiles(root, 'doc', 10, { ext: 'md' });

    // Guidelines
    writeFile(root, '_copilot_guidelines/index.md', '# Guidelines index\n');
    writeFile(root, '_copilot_guidelines/documentation_guidelines.md', '# Docs\n\nDOC_KEY content.\n');
    writeFile(root, '_copilot_guidelines/dart/coding_guidelines.md', '# Dart\n\nDART_KEY content.\n');
    writeFile(root, '_copilot_guidelines/cloud/aws.md', '# AWS\n\nCLOUD_KEY content.\n');

    // Config / metadata
    writeFile(root, 'package.json', JSON.stringify({ name: 'small-fixture', version: '0.0.0' }, null, 2));
    writeFile(root, '.gitignore', 'node_modules/\nout/\n');

    return mkFixture(root);
}

// ---------------------------------------------------------------------------
// Medium workspace (~1 000 files)
// ---------------------------------------------------------------------------

/**
 * Medium workspace: the small layout + a thousand additional source
 * files spread across nested directories. Exercises sort-stability,
 * pagination, and depth-first walk fairness.
 */
export function mkMediumWorkspace(options: WorkspaceOptions = {}): Fixture {
    const small = mkSmallWorkspace({ prefix: options.prefix ?? 'fixture-medium-' });
    const root = small.root;
    // 10 directories × 100 files = 1 000
    for (let d = 0; d < 10; d++) {
        writeManyFiles(root, `src/generated/group_${d}`, 100, {
            ext: 'ts',
            bodyFor: (i) => `// group ${d} item ${i}\nexport const G${d}_${i} = ${i};\n`,
        });
    }
    // Sprinkle a few markdown notes through the same tree so substring
    // searches that scan `.md` only have to skip past the `.ts` files.
    writeManyFiles(root, 'doc/medium_notes', 30, { ext: 'md' });
    return small;
}

// ---------------------------------------------------------------------------
// Large workspace (~10 000 files)
// ---------------------------------------------------------------------------

/**
 * Large workspace: the medium layout + 9 000 extra files arranged in
 * a wider, deeper tree. Total ≈ 10 000 across mixed extensions.
 *
 * Build time is the dominant cost. We use synchronous I/O in tight
 * loops because Node's async fs is *slower* for this scale of small
 * files — every write goes through the libuv thread pool and the
 * scheduler overhead dwarfs the syscall. Empirically: ~2-3 seconds
 * on an M1 / SSD; a fresh build per test run is acceptable when
 * shared across an entire family suite via `before()`.
 *
 * Layout:
 *   src/generated/group_<d>/file_<n>.ts        — 1 000 (from medium)
 *   doc/<various>.md                            — small + medium md
 *   src/wide/<a>/<b>/file_<n>.ts                — 30 × 30 × 10 = 9 000
 *
 * The wide tree mixes a token unique to each file (`UNIQ_<a>_<b>_<n>`)
 * so substring searches against the large fixture can assert a
 * deterministic count rather than a vague "≥ 1".
 */
export function mkLargeWorkspace(options: WorkspaceOptions = {}): Fixture {
    const medium = mkMediumWorkspace({ prefix: options.prefix ?? 'fixture-large-' });
    const root = medium.root;
    // 30 × 30 × 10 = 9 000 files
    for (let a = 0; a < 30; a++) {
        for (let b = 0; b < 30; b++) {
            const dir = path.join(root, 'src/wide', `dir_${a}`, `dir_${b}`);
            fs.mkdirSync(dir, { recursive: true });
            for (let n = 0; n < 10; n++) {
                const body = `// large-fixture token: UNIQ_${a}_${b}_${n}\nexport const W${a}_${b}_${n} = ${n};\n`;
                fs.writeFileSync(path.join(dir, `file_${n}.ts`), body, 'utf-8');
            }
        }
    }
    return medium;
}

// ---------------------------------------------------------------------------
// Quest folder (prompt-history fixture)
// ---------------------------------------------------------------------------

export interface QuestFolderOptions {
    /** Workspace root to build inside. Defaults to a fresh temp dir. */
    root?: string;
    /** Which subsystems to populate. Default: `['anthropic']`. */
    subsystems?: string[];
    /**
     * Number of paired prompt+answer exchanges per subsystem.
     * Default 5. Pass 0 to build only the empty folder.
     */
    exchangesPerSubsystem?: number;
    /**
     * Override the body generators. Default produces deterministic
     * "<subsystem> prompt #<n>" / "<subsystem> answer #<n>" bodies.
     */
    promptBody?: (subsystem: string, n: number) => string;
    answerBody?: (subsystem: string, n: number) => string;
}

export interface QuestFixture extends Fixture {
    /** Workspace root (same as `root` for compatibility with `Fixture`). */
    wsRoot: string;
    /** Quest folder path: `<root>/_ai/quests/<questId>/`. */
    questFolder: string;
    /** The quest id used to lay out the folder. */
    questId: string;
}

/**
 * Build a quest folder with summary-trail files for one or more
 * subsystems. Mirrors what `TrailService.writeSummaryPrompt/Answer`
 * would have written over a session.
 *
 * Entries are prepended newest-first (the production format) so a
 * test that parses the file gets the same ordering it would in
 * production.
 */
export function mkQuestFolder(questId: string, options: QuestFolderOptions = {}): QuestFixture {
    const created = !options.root;
    const root = options.root ?? mkdtemp('fixture-quest-');
    const questFolder = path.join(root, '_ai', 'quests', questId);
    fs.mkdirSync(questFolder, { recursive: true });

    const subsystems = options.subsystems ?? ['anthropic'];
    const n = options.exchangesPerSubsystem ?? 5;
    const promptBody = options.promptBody ?? ((sub, i) => `${sub} prompt #${i} — body line A\n\nbody line B (i=${i})`);
    const answerBody = options.answerBody ?? ((sub, i) => `${sub} answer #${i} — first line\n\nsecond line (i=${i})`);

    for (const sub of subsystems) {
        const promptsFile = path.join(questFolder, `${questId}.${sub}.prompts.md`);
        const answersFile = path.join(questFolder, `${questId}.${sub}.answers.md`);
        const promptBlocks: string[] = [];
        const answerBlocks: string[] = [];
        for (let i = 0; i < n; i++) {
            // Sequence + timestamp ascend with i; we then reverse so
            // the newest is at the top of the file (prepend order).
            const ts = new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString();
            const seq = i + 1;
            const id = `req-${sub}-${i + 1}`;
            promptBlocks.push(
                `=== PROMPT ${id} ${ts} ${seq} ===\n\n${promptBody(sub, i)}\n\nTEMPLATE: (none)\nANSWER-WRAPPER: no\n\n`,
            );
            answerBlocks.push(
                `=== ANSWER ${id} ${ts} ${seq} ===\n\n${answerBody(sub, i)}\n\n`,
            );
        }
        fs.writeFileSync(promptsFile, promptBlocks.reverse().join(''), 'utf-8');
        fs.writeFileSync(answersFile, answerBlocks.reverse().join(''), 'utf-8');
    }

    const fixture: QuestFixture = {
        root,
        wsRoot: root,
        questFolder,
        questId,
        cleanup(): void {
            // Only clean up if we created the root — caller-supplied
            // roots are the caller's responsibility.
            if (!created) { return; }
            try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
        },
    };
    return fixture;
}
