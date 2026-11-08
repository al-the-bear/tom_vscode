#!/usr/bin/env node
/**
 * Build the workspace template: the files a new workspace folder is set up
 * from (@T: Setup New Workspace Folder), packed into one zip.
 *
 *   node scripts/build-workspace-template.cjs [--workspace <dir>] [--out <zip>] [--copy-to <dir>]
 *   (npm run template:build)
 *
 * Taken from the workspace (default: three levels above this extension, as the
 * install scripts take it), at build time, and nothing else:
 *   - .tom/tom_vscode_extension.json      the workspace's config, its repositories
 *                                          and command lines emptied (genericConfig)
 *   - _copilot_guidelines/                 all but EXCLUDED_PATHS
 *   - CLAUDE.md, .github/copilot-instructions.md
 *   - _ai/roles/, _ai/processes/, _ai/schemas/, _ai/prompt/,
 *     _ai/format-version.yaml              all but EXCLUDED_PATHS and Python byte code
 * Markdown is packed without its `<!-- workspace-specific -->` blocks (the
 * workspace's own part of CLAUDE.md and its mirror, guideline passages about
 * this workspace) and without list items / table rows linking to a left-out
 * file; the Active Quests table keeps only the quests the template carries
 * (templateFileData).
 *   - _ai/quests/tomai_introduction/      the starting quest, without the files its
 *                                          use on this machine writes
 * plus `.tom/workspace_template.json`, which names the template's type (a
 * "dart" workspace; other types come later).
 *
 * Before writing, every file is checked: nothing personal or machine-bound
 * (`extension_config.<host>.<quest>.yaml`, `session-todo.*`, a `history/`
 * folder; in the introduction quest these are left out instead) and no
 * literal secret in any text file (an Anthropic key
 * `sk-ant-…`, a GitHub token `ghp_…` / `github_pat_…`, a Telegram bot token
 * `<digits>:<35 chars>`). Secrets belong in environment variables, named in
 * the config. A finding stops the build and writes nothing.
 *
 * The zip goes to resources/workspace_template.zip (packed into the VSIX, so
 * the setup works from any installed extension); `--copy-to` also writes it
 * there (the install scripts put a copy beside the VSIX). It is deterministic:
 * entries sorted, fixed times, so an unchanged workspace gives the same bytes.
 *
 * Node only (zlib for deflate, an own CRC-32): the same on every platform. The
 * extension reads the zip with src/utils/zipArchive.ts.
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

/** What the template carries. `optional`: packed when present, named when not. */
const SOURCES = [
    { path: '.tom/tom_vscode_extension.json', kind: 'file' },
    { path: '_copilot_guidelines', kind: 'dir' },
    { path: 'CLAUDE.md', kind: 'file' },
    { path: '.github/copilot-instructions.md', kind: 'file' },
    { path: '_ai/roles', kind: 'dir' },
    { path: '_ai/processes', kind: 'dir' },
    { path: '_ai/schemas', kind: 'dir' },
    { path: '_ai/prompt', kind: 'dir' },
    { path: '_ai/format-version.yaml', kind: 'file' },
    // A quest that is used on this machine collects files of its use (history,
    // session todos, the host's config, its process position): left out, not refused.
    { path: '_ai/quests/tomai_introduction', kind: 'dir', optional: true, leaveOutUse: true },
];

/** The files a quest's use writes into its folder, relative to the quest folder. */
const QUEST_USE_RULES = [
    /^history\//,
    /^session-todo[^/]*$/,
    /^extension_config\.[^/]+\.[^/]+\.yaml$/,
    /^process-state\.[^/]+\.yaml$/,
];

/** The workspace config inside the template. */
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

/** The Active Quests table cut to its header and the rows of the quests the template carries. */
function activeQuestsFor(text, carried) {
    const lines = text.split('\n');
    const heading = lines.findIndex((l) => l.trim() === '## Active Quests');
    if (heading < 0) { return text; }
    let i = heading + 1;
    while (i < lines.length && !lines[i].startsWith('|') && !lines[i].startsWith('#')) { i++; }
    if (i >= lines.length || !lines[i].startsWith('|')) { return text; }
    const header = i;
    const out = [];
    for (let k = 0; k < lines.length; k++) {
        const isRow = k > header + 1 && lines[k].startsWith('|') && lines.slice(header, k).every((l) => l.startsWith('|'));
        if (isRow && !carried.some((q) => lines[k].includes(`_ai/quests/${q}/`))) { continue; }
        out.push(lines[k]);
    }
    return out.join('\n');
}

/** The quests the template carries (from SOURCES). */
const CARRIED_QUESTS = SOURCES.filter((s) => s.path.startsWith('_ai/quests/')).map((s) => s.path.split('/')[2]);

/**
 * A source file as the template packs it: the config through genericConfig;
 * Markdown without its workspace-specific blocks and its links to left-out
 * files, the Active Quests table cut to the carried quests; everything else as
 * it is.
 * @param {string} file workspace-relative posix path
 * @param {Buffer} data
 */
function templateFileData(file, data) {
    if (file === CONFIG_PATH) { return genericConfig(data); }
    if (!file.endsWith('.md')) { return data; }
    let text = stripWorkspaceSpecific(data.toString('utf8'), file);
    text = dropLinksTo(text, file, EXCLUDED_PATHS);
    if (file === QUEST_REGISTRY_PATH) { text = activeQuestsFor(text, CARRIED_QUESTS); }
    return Buffer.from(text, 'utf8');
}

/** The template's own description, written into the zip. */
const TEMPLATE_INFO_PATH = '.tom/workspace_template.json';
const TEMPLATE_TYPE = 'dart';

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
const EXCLUDED_PATHS = new Set([
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
]);

/** Markdown between these marker lines is this workspace's own: the template leaves it out (CLAUDE.md, its mirror, guidelines). */
const SPECIFIC_OPEN = /^\s*<!--\s*workspace-specific\s*-->\s*$/;
const SPECIFIC_CLOSE = /^\s*<!--\s*\/workspace-specific\s*-->\s*$/;

/** The guideline holding the Active Quests table. */
const QUEST_REGISTRY_PATH = '_copilot_guidelines/quests_and_processes.md';

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

/**
 * The files the template takes from `workspace`.
 * @returns {{ files: string[], missing: string[], skipped: string[], leftOut: string[] }}
 *   `missing`: required sources not there; `skipped`: optional ones not there;
 *   `leftOut`: files of a quest's use (QUEST_USE_RULES) in a `leaveOutUse` source.
 */
function collectTemplateFiles(workspace) {
    const files = [];
    const missing = [];
    const skipped = [];
    const leftOut = [];
    for (const src of SOURCES) {
        const abs = path.join(workspace, src.path);
        if (!fs.existsSync(abs)) { (src.optional ? skipped : missing).push(src.path); continue; }
        if (src.kind !== 'dir') { files.push(src.path); continue; }
        for (const f of walk(workspace, src.path)) {
            if (EXCLUDED_PATHS.has(f)) { continue; }
            const inQuest = f.slice(src.path.length + 1);
            if (src.leaveOutUse && QUEST_USE_RULES.some((re) => re.test(inQuest))) { leftOut.push(f); } else { files.push(f); }
        }
    }
    return { files: [...new Set(files)].sort(), missing, skipped, leftOut };
}

/** Whether `rel` is inside what SOURCES allows. */
function isAllowed(rel) {
    if (rel === TEMPLATE_INFO_PATH) { return true; }
    return SOURCES.some((s) => (s.kind === 'dir' ? rel.startsWith(`${s.path}/`) : rel === s.path));
}

/**
 * The findings over the files to pack: outside the list, personal paths,
 * literal secrets in text files. Empty when the template may be written.
 * @param {Array<{ path: string, data: Buffer }>} entries
 */
function checkTemplate(entries) {
    const findings = [];
    for (const e of entries) {
        if (!isAllowed(e.path)) { findings.push(`${e.path}: outside the template's list`); continue; }
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
 * Collect, check and zip the template of `workspace`.
 * @returns {{ ok: true, zip: Buffer, files: string[], skipped: string[], leftOut: string[] } | { ok: false, errors: string[] }}
 */
function buildTemplate(workspace) {
    const { files, missing, skipped, leftOut } = collectTemplateFiles(workspace);
    if (missing.length > 0) {
        return { ok: false, errors: missing.map((m) => `${m}: missing in ${workspace}`) };
    }
    const info = { type: TEMPLATE_TYPE, sources: SOURCES.map((s) => s.path) };
    const packed = [];
    const markerErrors = [];
    for (const f of files) {
        try { packed.push({ path: f, data: templateFileData(f, fs.readFileSync(path.join(workspace, f))) }); } catch (e) { markerErrors.push(e.message); }
    }
    if (markerErrors.length > 0) { return { ok: false, errors: markerErrors }; }
    const entries = [
        ...packed,
        { path: TEMPLATE_INFO_PATH, data: Buffer.from(`${JSON.stringify(info, null, 2)}\n`, 'utf8') },
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const findings = checkTemplate(entries);
    if (findings.length > 0) { return { ok: false, errors: findings }; }
    return { ok: true, zip: writeZip(entries), files: entries.map((e) => e.path), skipped, leftOut };
}

function parseArgs(argv) {
    const args = { workspace: DEFAULT_WORKSPACE, out: DEFAULT_OUT, copyTo: undefined };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--workspace') { args.workspace = path.resolve(argv[++i]); } else if (a === '--out') { args.out = path.resolve(argv[++i]); } else if (a === '--copy-to') {
            args.copyTo = path.resolve(argv[++i]);
        } else { throw new Error(`unknown argument ${a} (usage: build-workspace-template.cjs [--workspace <dir>] [--out <zip>] [--copy-to <dir>])`); }
    }
    return args;
}

function main() {
    let args;
    try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`❌ ${e.message}`); return 1; }
    const result = buildTemplate(args.workspace);
    if (!result.ok) {
        console.error('❌ The workspace template was not written:');
        for (const e of result.errors) { console.error(`   ${e}`); }
        return 1;
    }
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, result.zip);
    console.log(`✅ Workspace template (${TEMPLATE_TYPE}): ${result.files.length} files, ${(result.zip.length / 1024).toFixed(0)} KB → ${args.out}`);
    for (const s of result.skipped) { console.log(`   ℹ not in the workspace yet, left out: ${s}`); }
    if (result.leftOut.length > 0) { console.log(`   ℹ left out ${result.leftOut.length} file(s) of the introduction quest's use on this machine (history, session todos, host config, process state)`); }
    if (args.copyTo) {
        const copy = path.join(args.copyTo, path.basename(args.out));
        fs.copyFileSync(args.out, copy);
        console.log(`   copy: ${copy}`);
    }
    return 0;
}

module.exports = { SOURCES, QUEST_USE_RULES, CONFIG_PATH, EXCLUDED_PATHS, genericConfig, stripWorkspaceSpecific, dropLinksTo, activeQuestsFor, templateFileData, TEMPLATE_INFO_PATH, TEMPLATE_TYPE, collectTemplateFiles, checkTemplate, isAllowed, writeZip, buildTemplate, crc32 };

if (require.main === module) {
    process.exitCode = main();
}
