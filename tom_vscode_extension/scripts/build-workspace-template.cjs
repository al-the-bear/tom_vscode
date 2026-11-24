#!/usr/bin/env node
/**
 * Build the workspace template: the files a new root and its workspace folders
 * are set up from (@T: Setup New Workspace Folder), packed into one zip in two
 * parts (workspace layout BP-22 (a)).
 *
 *   node scripts/build-workspace-template.cjs [--root <dir>] [--workspace <dir>] [--out <zip>] [--copy-to <dir>]
 *   (npm run template:build)
 *
 * **`root/`**, read from the root (`--root`; default the nearest folder above
 * this extension with `.tom/tom_root.yaml`, as the layout resolver finds it):
 *   - .tom/tom_root.yaml, .tom/tom_vscode_extension.json (its repositories and
 *     command lines emptied: genericConfig), .tom/json-schema/workspaces/ (the
 *     schemas the extension does not write itself; its own are generated at
 *     start, utils/generatedSchemas.ts)
 *   - the root guidelines folder (`_agent_guidelines/`, else `_copilot_guidelines/`), its
 *     `aspects/` (aspect choices as guideline files) included, and `_ai/aspect_guidelines/`
 *     with the shared `workspace_agents.md`
 *   - CLAUDE.md, and AGENTS.md as a generic stub the build writes (ROOT_AGENTS_STUB)
 *   - _ai/roles/, role-types/, processes/, schemas/, prompt/, format-version.yaml,
 *     quests/tomai_introduction/ (without the files its use on this machine writes)
 * **`workspace/`**, read from a workspace folder (`--workspace`; default three
 * levels above this extension, the container):
 *   - an empty .tom/
 *   - AGENTS.md (the folder's own rules, packed as its generic part) and
 *     CLAUDE.md, whose import of the shared file is written with the token
 *     `{{root}}` (WORKSPACE_ROOT_TOKEN): `@{{root}}/_agent_guidelines/workspace_agents.md`;
 *     Setup replaces it with the path from the new workspace folder to its root
 *   - the workspace guidelines folder, without the transition copies of root
 *     guidelines (a file the root's guidelines folder has at the same path,
 *     except index.md): the root part carries those, and links to them point
 *     to the root's copy through the token
 * plus `root/.tom/workspace_template.json` (TEMPLATE_INFO_PATH): the template's
 * type, version, the parts with their files, and the token.
 *
 * Markdown is packed without its `<!-- workspace-specific -->` blocks and without
 * list items / table rows linking to a left-out file (templateFileData).
 * `.github/copilot-instructions.md` is not packed.
 *
 * Before writing, every file is checked: inside its part's list, nothing personal
 * or machine-bound (`extension_config.<host>.<quest>.yaml`, `session-todo.*`, a
 * `history/` folder; in the introduction quest these are left out instead) and
 * no literal secret in any text file (an Anthropic key `sk-ant-…`, a GitHub
 * token `ghp_…` / `github_pat_…`, a Telegram bot token `<digits>:<35 chars>`).
 * A finding stops the build and writes nothing.
 *
 * The zip goes to resources/workspace_template.zip (packed into the VSIX);
 * `--copy-to` also writes it there. It is deterministic: entries sorted, fixed
 * times, so unchanged sources give the same bytes. Node only (zlib, an own
 * CRC-32). The extension reads it with src/utils/zipArchive.ts.
 *
 * Exit codes: 0 written, 1 a check refused the content or a source is missing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EXT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_WORKSPACE = path.resolve(EXT_ROOT, '..', '..', '..');
const DEFAULT_OUT = path.join(EXT_ROOT, 'resources', 'workspace_template.zip');

/** The nearest folder at or above `from` with `.tom/tom_root.yaml`; `from`'s workspace default when there is none. */
function findRoot(from) {
    for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, '.tom', 'tom_root.yaml'))) { return dir; }
        if (path.dirname(dir) === dir) { return undefined; }
    }
}

/** The template's format version: 2 = the two parts. */
const TEMPLATE_VERSION = 2;
const TEMPLATE_TYPE = 'dart';
/** Where the template describes itself (inside the root part). */
const TEMPLATE_INFO_PATH = 'root/.tom/workspace_template.json';
/** The token the workspace part's CLAUDE.md names the root by. */
const WORKSPACE_ROOT_TOKEN = '{{root}}';

/** The root's AGENTS.md as the template carries it: the root's own rules are the new root's to write. */
const ROOT_AGENTS_STUB = [
    '# AGENTS.md — this root',
    '',
    'The rules for every session under this root. What every Tom workspace has in common is in',
    '`_agent_guidelines/workspace_agents.md`, which CLAUDE.md imports together with this file.',
    '',
    'Write the rules of this root below: what holds for every workspace folder under it.',
    '',
].join('\n');

/** The guidelines folder of `dir`: `_agent_guidelines` before `_copilot_guidelines`; undefined without one. */
function guidelinesFolderOf(dir) {
    return ['_agent_guidelines', '_copilot_guidelines'].find((n) => fs.existsSync(path.join(dir, n)));
}

/**
 * What each part carries, relative to its source folder. `optional`: packed
 * when present, named when not; `generated`: the build writes it (`data`).
 */
function partSources(rootDir) {
    const rootGuidelines = guidelinesFolderOf(rootDir) ?? '_agent_guidelines';
    return {
        root: [
            { path: '.tom/tom_root.yaml', kind: 'file' },
            { path: '.tom/tom_vscode_extension.json', kind: 'file' },
            // The schema of _ai/workspaces/<workspace>.yaml (vscimpb144); the extension's own schemas are generated at start.
            { path: '.tom/json-schema/workspaces', kind: 'dir', optional: true },
            { path: rootGuidelines, kind: 'dir' },
            { path: `${rootGuidelines}/workspace_agents.md`, kind: 'file' },
            // Aspect choices as guideline files (gsel17): packed with the guidelines; named so a template without them says so.
            { path: `${rootGuidelines}/aspects`, kind: 'dir', optional: true },
            { path: 'CLAUDE.md', kind: 'file' },
            { path: 'AGENTS.md', kind: 'file', generated: ROOT_AGENTS_STUB },
            { path: '_ai/roles', kind: 'dir' },
            { path: '_ai/role-types', kind: 'dir', optional: true },
            { path: '_ai/processes', kind: 'dir' },
            // The aspect definitions (aspect.yaml) and own texts the guideline files belong to.
            { path: '_ai/aspect_guidelines', kind: 'dir', optional: true },
            { path: '_ai/schemas', kind: 'dir' },
            { path: '_ai/prompt', kind: 'dir' },
            { path: '_ai/format-version.yaml', kind: 'file' },
            // A quest that is used on this machine collects files of its use: left out, not refused.
            { path: '_ai/quests/tomai_introduction', kind: 'dir', optional: true, leaveOutUse: true },
        ],
        workspace: [
            { path: '.tom', kind: 'emptyDir' },
            { path: 'AGENTS.md', kind: 'file' },
            { path: 'CLAUDE.md', kind: 'file' },
            { path: '_copilot_guidelines', kind: 'dir', alt: '_agent_guidelines' },
        ],
    };
}

/** The files a quest's use writes into its folder, relative to the quest folder. */
const QUEST_USE_RULES = [
    /^history\//,
    /^session-todo[^/]*$/,
    /^extension_config\.[^/]+\.[^/]+\.yaml$/,
    /^process-state\.[^/]+\.yaml$/,
];

/** The config inside the template (root part). */
const CONFIG_PATH = '.tom/tom_vscode_extension.json';

/**
 * The template's copy of the workspace config: the live config without what is
 * this workspace's own — the issue and test panels' repositories
 * (`issuePanels.*.additionalRepos` / `excludeRepos`) and the command lines
 * (`commandlines`) are emptied; everything else is kept as it is. The live
 * file is not changed. Same 2-space JSON and final newline as the source.
 * @param {Buffer} data
 */
function genericConfig(data) {
    const text = data.toString('utf8');
    const config = JSON.parse(text);
    for (const panel of Object.values(config.issuePanels ?? {})) {
        if (!panel || typeof panel !== 'object') { continue; }
        if (Array.isArray(panel.additionalRepos)) { panel.additionalRepos = []; }
        if (Array.isArray(panel.excludeRepos)) { panel.excludeRepos = []; }
    }
    if (Array.isArray(config.commandlines)) { config.commandlines = []; }
    return Buffer.from(JSON.stringify(config, null, 2) + (text.endsWith('\n') ? '\n' : ''), 'utf8');
}

/** Text without its `<!-- workspace-specific -->` blocks (markers included); throws on unbalanced markers. */
function stripWorkspaceSpecific(text, file) {
    const out = [];
    let open = 0;
    text.split('\n').forEach((line, i) => {
        if (SPECIFIC_OPEN.test(line)) {
            if (open) { throw new Error(`${file}:${i + 1}: <!-- workspace-specific --> inside an open one (line ${open})`); }
            open = i + 1;
            return;
        }
        if (SPECIFIC_CLOSE.test(line)) {
            if (!open) { throw new Error(`${file}:${i + 1}: <!-- /workspace-specific --> without an opening marker`); }
            open = 0;
            return;
        }
        if (!open) { out.push(line); }
    });
    if (open) { throw new Error(`${file}:${open}: <!-- workspace-specific --> never closed`); }
    return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Text without its list items and table rows that link to one of `excluded` (paths relative to the workspace). */
function dropLinksTo(text, file, excluded) {
    const dir = path.posix.dirname(file);
    const targets = (line) => [...line.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
        .map((m) => m[1])
        .filter((t) => !/^[a-z]+:/i.test(t))
        .map((t) => path.posix.normalize(path.posix.join(dir, decodeURI(t))));
    return text.split('\n')
        .filter((line) => !(/^\s*(?:[-*+] |\d+\. |\|)/.test(line) && targets(line).some((t) => excluded.has(t))))
        .join('\n');
}

/** Files never worth carrying (OS litter, VCS folders, Python byte code). */
const IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.git', 'node_modules', '__pycache__']);
const IGNORED_EXTENSIONS = new Set(['.pyc']);

/**
 * Files of the sources that are this workspace's own and stay out of the
 * template: the guidelines on this workspace's projects and its `_bin/` checks
 * (the template carries no `_bin/`), the guidelines that only point into this
 * workspace's packages, the Tom analyzer's schema, and prompts written for one
 * quest or tool. Passages of other files that point into this workspace are
 * marked `<!-- workspace-specific -->` in the files themselves. List items and table rows linking to them are
 * dropped from the packed Markdown (dropLinksTo).
 */
const EXCLUDED_PATHS = withGuidelineAliases([
    '_copilot_guidelines/projects_and_repos.md',
    '_copilot_guidelines/workspace_checks.md',
    // Written around this workspace's packages: the D4rt pointer files, and the
    // README guideline whose exemplars are this workspace's D4rt files.
    '_copilot_guidelines/component_module_readme_example.md',
    '_copilot_guidelines/d4rt/BRIDGING_GUIDE.md',
    '_copilot_guidelines/d4rt/generator_strategies.md',
    '_copilot_guidelines/d4rt/d4rt_interpreter_vs_d4rt_generator.md',
    '_ai/schemas/yaml/tom_analyzer_analysis.schema.json',
    '_ai/prompt/Create GOOD tests.prompt.md',
    '_ai/prompt/D4rt_Good_Demo_Test.prompt.md',
    '_ai/prompt/bot.chat-history.prompt.md',
    '_ai/prompt/execute-quest-todos-with-follow-up.prompt.md',
    '_ai/prompt/execute_todo_list.prompt.md',
    // This workspace's D4rt rules as an aspect choice (gsel24): they named this workspace's packages
    // (inside the workspace-specific block of AGENTS.md before), so the template leaves them out.
    '_copilot_guidelines/aspects/d4rt/rules.md',
    '_ai/aspect_guidelines/d4rt/aspect.yaml',
    // The fleet rules as an aspect choice (gsel24): this root's machines and repositories (the root's
    // AGENTS.md, which the template carries as a stub), so the template leaves the aspect out.
    '_agent_guidelines/aspects/fleet/rules.md',
    '_ai/aspect_guidelines/fleet/aspect.yaml',
    // The TypeScript rules of this workspace's VS Code extension (gsel25): its only choice, so the aspect stays out too.
    '_copilot_guidelines/aspects/js_ts/vscode_extension.md',
    '_ai/aspect_guidelines/js_ts/aspect.yaml',
    // The index group of this workspace's _bin/ checks (gsel26): all of it is workspace-specific.
    '_copilot_guidelines/index_checks_group.md',
    '_copilot_guidelines/aspects/index_checks/all.md',
    '_ai/aspect_guidelines/index_checks/aspect.yaml',
]);

/**
 * The excluded paths with each workspace guideline named under both folder
 * names: the workspace guidelines folder is `_agent_guidelines/` (the older
 * `_copilot_guidelines/` still read), and the part walks the one that exists.
 */
function withGuidelineAliases(paths) {
    const out = new Set(paths);
    for (const p of paths) { if (p.startsWith('_copilot_guidelines/')) { out.add(`_agent_guidelines/${p.slice('_copilot_guidelines/'.length)}`); } }
    return out;
}

/** Markdown between these marker lines is this workspace's own: the template leaves it out (CLAUDE.md, AGENTS.md, guidelines). */
const SPECIFIC_OPEN = /^\s*<!--\s*workspace-specific\s*-->\s*$/;
const SPECIFIC_CLOSE = /^\s*<!--\s*\/workspace-specific\s*-->\s*$/;

/** Paths that are personal or bound to one machine. */
const PERSONAL_PATH_RULES = [
    { re: /(^|\/)extension_config\.[^/]+\.[^/]+\.yaml$/, what: 'a host-specific quest config (extension_config.<host>.<quest>.yaml)' },
    { re: /(^|\/)session-todo[^/]*$/, what: 'a session todo file (session-todo.*)' },
    { re: /(^|\/)history\//, what: 'a history folder' },
];

/** Literal secrets: the config names environment variables instead. */
const SECRET_RULES = [
    { re: /sk-ant-[A-Za-z0-9_-]{20,}/, what: 'an Anthropic API key (sk-ant-…)' },
    { re: /\bghp_[A-Za-z0-9]{30,}/, what: 'a GitHub token (ghp_…)' },
    { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/, what: 'a GitHub token (github_pat_…)' },
    { re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, what: 'a Telegram bot token (<digits>:<35 chars>)' },
];

const TEXT_EXTENSIONS = new Set(['.md', '.json', '.yaml', '.yml', '.txt', '.ts', '.js', '.cjs', '.dart', '.sh', '.ps1', '.py', '.code-workspace', '']);

/** Every file under `rel` (a directory, symlinks followed), posix paths relative to the workspace, sorted. */
function walk(root, rel) {
    const out = [];
    const visit = (r) => {
        for (const name of fs.readdirSync(path.join(root, r)).sort()) {
            if (IGNORED_NAMES.has(name) || IGNORED_EXTENSIONS.has(path.extname(name))) { continue; }
            const childRel = `${r}/${name}`;
            const st = fs.statSync(path.join(root, childRel));
            if (st.isDirectory()) { visit(childRel); } else if (st.isFile()) { out.push(childRel); }
        }
    };
    visit(rel);
    return out;
}

// ── Zip writing ───────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) { c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); }
    return (c ^ 0xffffffff) >>> 0;
}

/** A fixed DOS date and time (2026-01-01 00:00), so the zip does not change with file times. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/**
 * A zip of `entries` (deflated; stored when deflate does not help), UTF-8 names,
 * Unix mode 0644. Small enough for the classic format (no zip64).
 * @param {Array<{ path: string, data: Buffer }>} entries
 */
function writeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.path, 'utf8');
        const deflated = zlib.deflateRawSync(e.data, { level: 9 });
        const stored = deflated.length >= e.data.length;
        const body = stored ? e.data : deflated;
        const crc = crc32(e.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(stored ? 0 : 8, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(e.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, body);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(stored ? 0 : 8, 10);
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(e.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}


// ── The build ─────────────────────────────────────────────────────────────────

/**
 * The workspace part's CLAUDE.md: its import of the root's shared rules
 * (`@<path>/<guidelines>/workspace_agents.md`, any path) written with the
 * root token, so Setup can point it at the new folder's root.
 */
function tokenizeRootImport(text) {
    return text.replace(/^@(?:[^\s]*\/)?(_agent_guidelines|_copilot_guidelines)\/workspace_agents\.md\s*$/gm,
        (_m, folder) => `@${WORKSPACE_ROOT_TOKEN}/${folder}/workspace_agents.md`);
}

/**
 * Links to the files of `rewrites` (paths in the part) pointed at their new
 * target (`{{root}}/<root guidelines>/<file>`, relative to the linking file).
 */
function rewriteLinks(text, file, rewrites) {
    const dir = path.posix.dirname(file);
    return text.replace(/\]\(([^)#\s]+)((?:#[^)]*)?)\)/g, (m, target, anchor) => {
        if (/^[a-z]+:/i.test(target)) { return m; }
        const resolved = path.posix.normalize(path.posix.join(dir, decodeURI(target)));
        const to = rewrites.get(resolved);
        return to ? `](${path.posix.relative(dir, to)}${anchor})` : m;
    });
}

/**
 * The workspace guidelines index with a link to the root's index (through the
 * root token), under its "Root guidelines" heading, else at its end; kept as
 * it is when it links one already.
 */
function withRootIndexLink(text) {
    if (/\]\([^)]*_agent_guidelines\/index\.md\)/.test(text)) { return text; }
    const line = `The guidelines every workspace folder shares are indexed in the root's [_agent_guidelines/index.md](../${WORKSPACE_ROOT_TOKEN}/_agent_guidelines/index.md).`;
    const heading = /^## Root guidelines[ \t]*$/m;
    if (heading.test(text)) { return text.replace(heading, (h) => `${h}\n\n${line}`); }
    return `${text.replace(/\n*$/, '')}\n\n${line}\n`;
}

/**
 * A source file as the template packs it: the config through genericConfig;
 * Markdown without its workspace-specific blocks and its links to `excluded`
 * files; the workspace CLAUDE.md with the root token; everything else as it is.
 * @param {string} file path relative to the part's source folder (posix)
 * @param {Buffer} data
 * @param {Set<string>} [excluded] files left out of the part (default EXCLUDED_PATHS)
 * @param {'root' | 'workspace'} [part]
 * @param {Map<string, string>} [rewrites] link targets (paths in the part) to point elsewhere: the transition copies, onto the root's
 */
function templateFileData(file, data, excluded = EXCLUDED_PATHS, part, rewrites) {
    if (file === CONFIG_PATH) { return genericConfig(data); }
    if (!file.endsWith('.md')) { return data; }
    let text = stripWorkspaceSpecific(data.toString('utf8'), file);
    text = dropLinksTo(text, file, excluded);
    if (rewrites && rewrites.size > 0) { text = rewriteLinks(text, file, rewrites); }
    if (part === 'workspace' && file === 'CLAUDE.md') { text = tokenizeRootImport(text); }
    if (part === 'workspace' && /^_(agent|copilot)_guidelines\/index\.md$/.test(file)) { text = withRootIndexLink(text); }
    return Buffer.from(text, 'utf8');
}

/**
 * The files of one part.
 * @returns {{ files: Array<{ path: string, generated?: string }>, dirs: string[], missing: string[], skipped: string[], leftOut: string[], excluded: Set<string>, rewrites: Map<string, string> }}
 */
function collectPart(part, dir, sources, rootDir) {
    const files = [];
    const dirs = [];
    const missing = [];
    const skipped = [];
    const leftOut = [];
    const excluded = new Set(EXCLUDED_PATHS);
    const rewrites = new Map();
    // Transition copies: a workspace guideline the root's guidelines folder has at the same path (its index aside).
    const rootGuidelines = guidelinesFolderOf(rootDir);
    for (const src of sources) {
        if (src.generated !== undefined) { files.push({ path: src.path, generated: src.generated }); continue; }
        if (src.kind === 'emptyDir') { dirs.push(src.path); continue; }
        let rel = src.path;
        if (!fs.existsSync(path.join(dir, rel)) && src.alt && fs.existsSync(path.join(dir, src.alt))) { rel = src.alt; }
        if (!fs.existsSync(path.join(dir, rel))) { (src.optional ? skipped : missing).push(`${part}/${src.path}`); continue; }
        if (src.kind !== 'dir') { files.push({ path: rel }); continue; }
        for (const f of walk(dir, rel)) {
            if (EXCLUDED_PATHS.has(f)) { continue; }
            const inSource = f.slice(rel.length + 1);
            if (part === 'workspace' && rootGuidelines && inSource !== 'index.md'
                && /^_(agent|copilot)_guidelines$/.test(rel) && fs.existsSync(path.join(rootDir, rootGuidelines, inSource))) {
                // Not packed; links to it point to the root's copy.
                rewrites.set(f, `${WORKSPACE_ROOT_TOKEN}/${rootGuidelines}/${inSource}`);
                continue;
            }
            if (src.leaveOutUse && QUEST_USE_RULES.some((re) => re.test(inSource))) { leftOut.push(f); } else { files.push({ path: f }); }
        }
    }
    const seen = new Set();
    const unique = files.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true))).sort((a, b) => (a.path < b.path ? -1 : 1));
    return { files: unique, dirs, missing, skipped, leftOut, excluded, rewrites };
}

/** Whether `rel` (a zip path, with its part) is inside what the parts allow. */
function isAllowed(rel, sources) {
    if (rel === TEMPLATE_INFO_PATH) { return true; }
    const m = /^(root|workspace)\/(.*)$/.exec(rel);
    if (!m) { return false; }
    const inPart = m[2].replace(/\/$/, '');
    return sources[m[1]].some((s) => {
        const names = [s.path, ...(s.alt ? [s.alt] : [])];
        return names.some((n) => (s.kind === 'dir' ? inPart.startsWith(`${n}/`) : inPart === n));
    });
}

/**
 * The findings over the entries to pack: outside the parts' lists, personal
 * paths, literal secrets in text files. Empty when the template may be written.
 * @param {Array<{ path: string, data: Buffer }>} entries zip paths with their part
 */
function checkTemplate(entries, sources = partSources(findRoot(EXT_ROOT) ?? DEFAULT_WORKSPACE)) {
    const findings = [];
    for (const e of entries) {
        if (!isAllowed(e.path, sources)) { findings.push(`${e.path}: outside the template's list`); continue; }
        for (const rule of PERSONAL_PATH_RULES) {
            if (rule.re.test(e.path)) { findings.push(`${e.path}: ${rule.what}`); }
        }
        if (TEXT_EXTENSIONS.has(path.extname(e.path))) {
            const text = e.data.toString('utf8');
            for (const rule of SECRET_RULES) {
                if (rule.re.test(text)) { findings.push(`${e.path}: contains ${rule.what}`); }
            }
        }
    }
    return findings;
}

/**
 * Collect, check and zip the template from the root `rootDir` and the
 * workspace folder `workspaceDir`.
 * @returns {{ ok: true, zip: Buffer, files: string[], skipped: string[], leftOut: string[], info: object } | { ok: false, errors: string[] }}
 */
function buildTemplate(rootDir, workspaceDir) {
    if (!rootDir) { return { ok: false, errors: ['no root: no folder with .tom/tom_root.yaml above the extension (pass --root)'] }; }
    const sources = partSources(rootDir);
    const parts = { root: collectPart('root', rootDir, sources.root, rootDir), workspace: collectPart('workspace', workspaceDir, sources.workspace, rootDir) };
    const missing = [...parts.root.missing.map((m) => `${m}: missing in ${rootDir}`), ...parts.workspace.missing.map((m) => `${m}: missing in ${workspaceDir}`)];
    if (missing.length > 0) { return { ok: false, errors: missing }; }
    const entries = [];
    const markerErrors = [];
    for (const [part, dir] of [['root', rootDir], ['workspace', workspaceDir]]) {
        const p = parts[part];
        for (const d of p.dirs) { entries.push({ path: `${part}/${d}/`, data: Buffer.alloc(0) }); }
        for (const f of p.files) {
            try {
                const data = f.generated !== undefined ? Buffer.from(f.generated, 'utf8') : templateFileData(f.path, fs.readFileSync(path.join(dir, f.path)), p.excluded, part, p.rewrites);
                entries.push({ path: `${part}/${f.path}`, data });
            } catch (e) { markerErrors.push(`${part}/${e.message}`); }
        }
    }
    if (markerErrors.length > 0) { return { ok: false, errors: markerErrors }; }
    const info = {
        type: TEMPLATE_TYPE,
        version: TEMPLATE_VERSION,
        parts: {
            root: parts.root.files.map((f) => f.path),
            workspace: [...parts.workspace.dirs.map((d) => `${d}/`), ...parts.workspace.files.map((f) => f.path)],
        },
        tokens: { [WORKSPACE_ROOT_TOKEN]: 'the path from the workspace folder to its root (`.` standalone): the workspace part\'s CLAUDE.md import and its guidelines index link' },
    };
    entries.push({ path: TEMPLATE_INFO_PATH, data: Buffer.from(`${JSON.stringify(info, null, 2)}\n`, 'utf8') });
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const findings = checkTemplate(entries, sources);
    if (findings.length > 0) { return { ok: false, errors: findings }; }
    return {
        ok: true, zip: writeZip(entries), files: entries.map((e) => e.path), info,
        skipped: [...parts.root.skipped, ...parts.workspace.skipped], leftOut: [...parts.root.leftOut, ...parts.workspace.leftOut],
    };
}

function parseArgs(argv) {
    const args = { root: undefined, workspace: DEFAULT_WORKSPACE, out: DEFAULT_OUT, copyTo: undefined };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--root') { args.root = path.resolve(argv[++i]); } else if (a === '--workspace') { args.workspace = path.resolve(argv[++i]); } else if (a === '--out') { args.out = path.resolve(argv[++i]); } else if (a === '--copy-to') {
            args.copyTo = path.resolve(argv[++i]);
        } else { throw new Error(`unknown argument ${a} (usage: build-workspace-template.cjs [--root <dir>] [--workspace <dir>] [--out <zip>] [--copy-to <dir>])`); }
    }
    if (!args.root) { args.root = findRoot(EXT_ROOT); }
    return args;
}

function main() {
    let args;
    try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`❌ ${e.message}`); return 1; }
    const result = buildTemplate(args.root, args.workspace);
    if (!result.ok) {
        console.error('❌ The workspace template was not written:');
        for (const e of result.errors) { console.error(`   ${e}`); }
        return 1;
    }
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, result.zip);
    console.log(`✅ Workspace template (${TEMPLATE_TYPE}, v${TEMPLATE_VERSION}): root/ ${result.info.parts.root.length} files, workspace/ ${result.info.parts.workspace.length} entries, ${(result.zip.length / 1024).toFixed(0)} KB → ${args.out}`);
    for (const s of result.skipped) { console.log(`   ℹ not there yet, left out: ${s}`); }
    if (result.leftOut.length > 0) { console.log(`   ℹ left out ${result.leftOut.length} file(s) of the introduction quest's use on this machine (history, session todos, host config, process state)`); }
    if (args.copyTo) {
        const copy = path.join(args.copyTo, path.basename(args.out));
        fs.copyFileSync(args.out, copy);
        console.log(`   copy: ${copy}`);
    }
    return 0;
}

module.exports = {
    partSources, findRoot, QUEST_USE_RULES, CONFIG_PATH, EXCLUDED_PATHS, ROOT_AGENTS_STUB, WORKSPACE_ROOT_TOKEN, TEMPLATE_VERSION,
    genericConfig, stripWorkspaceSpecific, dropLinksTo, rewriteLinks, templateFileData, tokenizeRootImport, withRootIndexLink, TEMPLATE_INFO_PATH, TEMPLATE_TYPE,
    collectPart, checkTemplate, isAllowed, writeZip, buildTemplate, crc32,
};

if (require.main === module) {
    process.exitCode = main();
}
