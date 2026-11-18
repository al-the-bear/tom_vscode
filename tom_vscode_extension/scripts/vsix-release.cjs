#!/usr/bin/env node
/**
 * The packaged VSIX as a download: the GitHub Release `vscode-extension-latest`
 * of al-the-bear/tom_binaries, and `vscode_extension/vsix/README.md` there.
 *
 *   node scripts/vsix-release.cjs precheck
 *   node scripts/vsix-release.cjs publish --vsix <file> [--vsix <file> ...] --script <name> --precheck "<line>" [--no-release]
 *
 * Every create_*_vsix script (sh and ps1) runs both: `precheck` at its start —
 * the release must name a tom_vscode commit anyone can check out, so the
 * checkout the VSIX is built from may hold no local change and no unpushed
 * commit — and `publish` at its end, after the VSIX is packed (and, where the
 * script publishes binaries, after they are pushed). The VSIX stays where it
 * was packed for a local install.
 *
 * precheck — one line on stdout: `ok <commit>`, or `skip <why>` naming what is
 *   uncommitted or unpushed.
 * publish — without --no-release and with a precheck `ok` whose commit is still
 *   HEAD: with `gh` and a login that may push to the repository, uploads the
 *   VSIX as an asset of the release (`gh release create` the first time,
 *   `gh release upload --clobber` after): the per-platform VSIX of the
 *   multi-platform create scripts (`--vsix` once per file,
 *   tom-ai-extension-<platform>.vsix; scripts/vsix-split.cjs) each as its own
 *   asset of that name, the single VSIX of create_vsix.* as
 *   `tom-ai-extension.vsix`. The other kind's assets stay in the release (the
 *   single asset keeps the links to it working) and the README lists them. It sets the
 *   release notes (commit, date, size, script, the platforms whose Dart
 *   binaries it carries with their build stamps), and writes the README with
 *   the same, committed and pushed in the tom_binaries checkout (else through
 *   the GitHub API). Anything missing: a warning naming what to run, the VSIX
 *   stays local. It always exits 0 (the script that packed it still
 *   succeeds); its last line says whether the release was updated.
 *
 * No other check: fleet hosts may be on other tom_vscode commits, and the
 * layer's state is reported by the scripts themselves.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const vsixContents = require('./check-vsix-contents.cjs');
const vsixSplit = require('./vsix-split.cjs');

const EXT_ROOT = path.resolve(__dirname, '..');
const REPO = 'al-the-bear/tom_binaries';
const TAG = 'vscode-extension-latest';
const ASSET = 'tom-ai-extension.vsix';
const LINK = `https://github.com/${REPO}/releases/download/${TAG}/${ASSET}`;
const README_PATH = 'vscode_extension/vsix/README.md';
const TITLE = 'Tom AI VS Code extension — latest build';
const DART_BINARIES = ['tom_bs', 'tomspecs', 'validate_codespecs', 'spec_checks', 'irspecs'];
const BUILD_TOOLS = vsixContents.BUILD_TOOLS;
/** The download link of a release asset. */
function assetLink(asset) { return `https://github.com/${REPO}/releases/download/${TAG}/${asset}`; }

/** Run a command: `{status, stdout, stderr}`; status null when it could not be started. */
function defaultRun(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
    if (r.error) { return { status: null, stdout: '', stderr: String(r.error.message || r.error) }; }
    // Only the line end goes: `git status --porcelain` starts lines with a space.
    return { status: r.status, stdout: (r.stdout || '').replace(/\s+$/, ''), stderr: (r.stderr || '').trim() };
}

/** `gh`: on PATH, else where Homebrew puts it (a launcher's PATH may lack it). */
function ghCommand(exists = fs.existsSync) {
    if (process.env.TOM_GH) { return process.env.TOM_GH; }
    for (const candidate of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
        if (exists(candidate)) { return candidate; }
    }
    return 'gh';
}

/** The tom_vscode checkout the VSIX is built from: no local change and no unpushed commit. */
function precheck({ repoDir = EXT_ROOT, run = defaultRun } = {}) {
    const git = (args) => run('git', args, { cwd: repoDir });
    const status = git(['status', '--porcelain']);
    if (status.status !== 0) { return { ok: false, reason: `tom_vscode is not a git checkout here (${status.stderr || 'git status failed'})` }; }
    const changed = status.stdout ? status.stdout.split('\n').map((l) => l.replace(/^.. /, '').trim()).filter(Boolean) : [];
    git(['fetch', '--quiet']);
    const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    const reasons = [];
    if (changed.length) {
        reasons.push(`${changed.length} uncommitted change(s) in tom_vscode: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? `, … (${changed.length - 5} more)` : ''}`);
    }
    if (upstream.status !== 0) {
        reasons.push('the tom_vscode branch has no upstream: push it first');
    } else {
        const ahead = Number(git(['rev-list', '--count', `${upstream.stdout}..HEAD`]).stdout || '0');
        if (ahead > 0) { reasons.push(`${ahead} unpushed commit(s) in tom_vscode (not on ${upstream.stdout}): push them first`); }
    }
    if (reasons.length) { return { ok: false, reason: reasons.join('; ') }; }
    return { ok: true, commit: git(['rev-parse', 'HEAD']).stdout };
}

function precheckLine(result) {
    return result.ok ? `ok ${result.commit}` : `skip ${result.reason}`;
}

function parsePrecheck(line) {
    const text = String(line || '').trim();
    if (text.startsWith('ok ')) { return { ok: true, commit: text.slice(3).trim() }; }
    if (text.startsWith('skip ')) { return { ok: false, reason: text.slice(5).trim() }; }
    return { ok: false, reason: 'the start of the script did not check the tom_vscode checkout' };
}

/** Each platform's Dart binaries in the VSIX, with the build stamps found beside them. */
function vsixPlatforms(vsix, { extBin = path.join(EXT_ROOT, 'bin'), layer, target } = {}) {
    const names = new Set(vsixContents.readCentralDirectory(fs.readFileSync(vsix)).map((e) => (typeof e === 'string' ? e : e.name)));
    const layerDir = layer ?? path.resolve(EXT_ROOT, '..', '..', '..', 'tom_binaries', 'tom');
    // A per-platform VSIX reports its own platform; another one also this host's.
    const report = target ? vsixContents.dartBinaryReport(names, target) : vsixContents.dartBinaryReport(names);
    return report.map(({ platform, binaries, buildTools }) => {
        const carried = DART_BINARIES.filter((b) => binaries[b]);
        const tools = BUILD_TOOLS.filter((t) => buildTools && buildTools[t]);
        const stamps = {};
        for (const name of carried) {
            for (const dir of [path.join(extBin, platform), path.join(layerDir, platform)]) {
                const file = path.join(dir, `${name}.build.json`);
                if (!fs.existsSync(file)) { continue; }
                try {
                    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
                    const from = s.commit || (s.clitool && s.clitool.head) || s.head || '';
                    stamps[name] = `${s.builtAt || s.buildTime || '?'}${from ? ` from ${String(from).slice(0, 12)}` : ''}`;
                } catch { /* an unreadable stamp: none */ }
                break;
            }
        }
        return { platform, carried, stamps, tools };
    });
}

/** The README (and the release notes) for a published VSIX. */
function readmeText(info) {
    const mib = (info.size / (1024 * 1024)).toFixed(1);
    const withBinaries = info.platforms.filter((p) => p.carried.length);
    const lines = [
        '# Tom AI VS Code extension — the latest VSIX',
        '',
        `Download: <${LINK}>`,
        '',
        'Install it with VS Code\'s command line (or *Extensions: Install from VSIX…*):',
        '',
        '```sh',
        `code --install-extension ${ASSET}`,
        '```',
        '',
        '| | |',
        '|---|---|',
        `| Built from | tom_vscode \`${info.commit}\` |`,
        `| Built at | ${info.date} |`,
        `| Size | ${mib} MiB |`,
        `| Packed by | \`${info.script}\` |`,
        '',
        '## Dart binaries carried',
        '',
    ];
    if (withBinaries.length === 0) {
        lines.push('None: DartScript and CodeSpecs validation are not available on any platform; everything else works.');
    } else {
        lines.push('| Platform | Binaries | Build stamps |', '|---|---|---|');
        for (const p of withBinaries) {
            const stamps = p.carried.map((b) => `${b}: ${p.stamps[b] || 'no stamp'}`).join('; ');
            lines.push(`| ${p.platform} | ${p.carried.join(', ')} | ${stamps} |`);
        }
        const without = info.platforms.filter((p) => !p.carried.length).map((p) => p.platform);
        const others = ['darwin-arm64', 'linux-x64', 'win32-x64'].filter((p) => !withBinaries.some((w) => w.platform === p));
        const missing = [...new Set([...without, ...others])];
        if (missing.length) {
            lines.push('', `On ${missing.join(', ')} the extension runs without DartScript and CodeSpecs validation (@T: Missing Dart Binaries says how to add them).`);
        }
    }
    const others = (info.others || []).filter((a) => a.name !== ASSET);
    if (others.length) {
        lines.push('', '## Also in the release', '', 'The per-platform VSIX of the last multi-platform build (each installs only on its platform):', '');
        for (const a of others) { lines.push(otherAssetLine(a)); }
    }
    lines.push('', 'Provider SDKs (Anthropic, Agent SDK) are not in the VSIX: the extension installs them on request (Provider SDKs page).', '');
    return lines.join('\n');
}

/** One row of the release's other assets, for the README. */
function otherAssetLine(a) {
    const mib = typeof a.size === 'number' ? ` (${(a.size / (1024 * 1024)).toFixed(1)} MiB` : ' (';
    return `- [\`${a.name}\`](${assetLink(a.name)})${mib}${a.updatedAt ? `${typeof a.size === 'number' ? ', ' : ''}updated ${a.updatedAt}` : ''})`;
}

/**
 * The README (and the release notes) for the per-platform VSIX of one run
 * (scripts/vsix-split.cjs): one download per platform with the Dart binaries
 * and build tools it carries; the release's other assets (the single-platform
 * `tom-ai-extension.vsix` of create_vsix.*) listed after them.
 */
function readmeTextPlatforms(info) {
    const lines = [
        '# Tom AI VS Code extension — the latest VSIX',
        '',
        'One VSIX per platform: take the one for the machine it is installed on. VS Code installs a VSIX only on the platform it was packed for (`vsce package --target`), and each carries only that platform\'s Dart binaries and build tools.',
        '',
        '| Platform | Download | Size | Dart binaries | Build tools |',
        '|---|---|---|---|---|',
    ];
    for (const v of info.vsixes) {
        const bins = v.carried.length ? v.carried.map((b) => `${b}${v.stamps[b] ? ` (${v.stamps[b]})` : ''}`).join(', ') : 'none (no DartScript, no CodeSpecs validation)';
        const tools = v.tools && v.tools.length ? v.tools.join(', ') : 'none';
        lines.push(`| ${v.platform} | [\`${v.asset}\`](${assetLink(v.asset)}) | ${(v.size / (1024 * 1024)).toFixed(1)} MiB | ${bins} | ${tools} |`);
    }
    lines.push(
        '',
        'Install it with VS Code\'s command line (or *Extensions: Install from VSIX…*):',
        '',
        '```sh',
        'code --install-extension tom-ai-extension-<platform>.vsix',
        '```',
        '',
        '| | |',
        '|---|---|',
        `| Built from | tom_vscode \`${info.commit}\` |`,
        `| Built at | ${info.date} |`,
        `| Packed by | \`${info.script}\` |`,
        '',
    );
    const others = (info.others || []).filter((a) => !info.vsixes.some((v) => v.asset === a.name));
    if (others.length) {
        lines.push('## Also in the release', '');
        for (const a of others) {
            lines.push(otherAssetLine(a) + (a.name === ASSET ? ': the single-platform build of `create_vsix` (one VSIX for every platform, Dart binaries only for the platform it was built on)' : ''));
        }
        lines.push('');
    }
    lines.push('Provider SDKs (Anthropic, Agent SDK) are not in the VSIX: the extension installs them on request (Provider SDKs page).', '');
    return lines.join('\n');
}

/**
 * Upload the VSIX and write the README. `deps`: run (commands), gh (the gh
 * command), binariesRepo (the tom_binaries checkout), workDir (scratch for the
 * asset copy and the notes), now, log.
 */
function publish(opts, deps = {}) {
    const run = deps.run || defaultRun;
    const log = deps.log || ((line) => console.log(line));
    const gh = deps.gh || ghCommand();
    // One VSIX, or the per-platform VSIX of a multi-platform run (tom-ai-extension-<platform>.vsix).
    const files = (Array.isArray(opts.vsix) ? opts.vsix : [opts.vsix]).filter(Boolean);
    const notUpdated = (why, hint) => {
        log(`⚠️  The release was not updated: ${why}.`);
        if (hint) { log(`   ${hint}`); }
        log(`   The VSIX stays local: ${files.length ? files.join(', ') : '(none)'}`);
        return { updated: false, reason: why };
    };
    if (opts.noRelease) { return notUpdated('--no-release given'); }
    if (!files.length || files.some((f) => !fs.existsSync(f))) { return notUpdated('no VSIX was packed'); }
    const perPlatform = files.map((f) => vsixSplit.platformOfVsix(f));
    const split = perPlatform.some(Boolean);
    if (split && (perPlatform.some((p) => !p) || new Set(perPlatform).size !== perPlatform.length)) {
        return notUpdated(`the files are not one VSIX per platform (${files.map((f) => path.basename(f)).join(', ')})`);
    }
    if (!split && files.length > 1) { return notUpdated(`several VSIX files that name no platform (${files.map((f) => path.basename(f)).join(', ')})`); }
    const pre = parsePrecheck(opts.precheck);
    if (!pre.ok) { return notUpdated(pre.reason, 'Commit and push tom_vscode, then run the script again, so the release names a commit anyone can check out.'); }
    const head = run('git', ['rev-parse', 'HEAD'], { cwd: deps.repoDir || EXT_ROOT });
    if (head.status === 0 && head.stdout && head.stdout !== pre.commit) {
        return notUpdated(`tom_vscode moved from ${pre.commit.slice(0, 12)} to ${head.stdout.slice(0, 12)} while the VSIX was built`, 'Run the script again.');
    }
    const version = run(gh, ['--version']);
    if (version.status !== 0) {
        return notUpdated('the GitHub CLI (gh) is not installed', 'Install it (https://cli.github.com, e.g. `brew install gh` / `winget install GitHub.cli`), run `gh auth login`, then the script again.');
    }
    const access = run(gh, ['api', `repos/${REPO}`, '--jq', '.permissions.push']);
    if (access.status !== 0 || access.stdout !== 'true') {
        return notUpdated(`gh has no login that may push to ${REPO}${access.stderr ? ` (${access.stderr.split('\n')[0]})` : ''}`, 'Run `gh auth login` with an account that may write to the repository, then the script again.');
    }

    // The release as it is: whether it exists, and the assets it holds (listed in the README).
    const view = run(gh, ['release', 'view', TAG, '-R', REPO, '--json', 'assets']);
    const exists = view.status === 0;
    let others = [];
    if (exists) {
        try { others = (JSON.parse(view.stdout || '{}').assets || []).map((a) => ({ name: a.name, size: a.size, updatedAt: a.updatedAt })); } catch { others = []; }
    }
    const script = opts.script || 'a create_*_vsix script';
    const workDir = deps.workDir || path.join(EXT_ROOT, 'out', 'vsix-release');
    fs.mkdirSync(workDir, { recursive: true });
    const assets = [];
    let info;
    let text;
    if (split) {
        const vsixes = files.map((file, i) => {
            const platform = perPlatform[i];
            const stat = fs.statSync(file);
            const found = (typeof deps.platforms === 'function' ? deps.platforms(file, platform) : vsixPlatforms(file, { target: platform }))
                .find((p) => p.platform === platform) || { carried: [], stamps: {}, tools: [] };
            return { asset: vsixSplit.vsixName(platform), platform, size: stat.size, date: stat.mtime.toISOString(), carried: found.carried, stamps: found.stamps, tools: found.tools || [], file };
        });
        const newest = Math.max(...files.map((f) => fs.statSync(f).mtimeMs));
        info = { commit: pre.commit, date: (deps.now || new Date(newest)).toISOString(), script, vsixes, others: others.filter((a) => !vsixes.some((v) => v.asset === a.name)) };
        text = readmeTextPlatforms(info);
        for (const v of vsixes) { assets.push({ src: v.file, name: v.asset }); }
    } else {
        const stat = fs.statSync(files[0]);
        info = {
            commit: pre.commit,
            // When the VSIX was packed (its file time), not when it is uploaded.
            date: (deps.now || stat.mtime).toISOString(),
            size: stat.size,
            script,
            platforms: (typeof deps.platforms === 'function' ? deps.platforms(files[0], null) : deps.platforms) || vsixPlatforms(files[0]),
            others: others.filter((a) => a.name !== ASSET),
        };
        text = readmeText(info);
        assets.push({ src: files[0], name: ASSET });
    }
    const uploads = assets.map((a) => {
        const copy = path.join(workDir, a.name);
        fs.copyFileSync(a.src, copy);
        return copy;
    });
    const notes = path.join(workDir, 'notes.md');
    fs.writeFileSync(notes, text, 'utf8');

    const steps = exists
        ? [['release', 'upload', TAG, ...uploads, '--clobber', '-R', REPO], ['release', 'edit', TAG, '--title', TITLE, '--notes-file', notes, '-R', REPO]]
        : [['release', 'create', TAG, ...uploads, '--title', TITLE, '--notes-file', notes, '-R', REPO]];
    for (const args of steps) {
        const r = run(gh, args);
        if (r.status !== 0) { return notUpdated(`gh ${args.slice(0, 2).join(' ')} failed${r.stderr ? `: ${r.stderr.split('\n')[0]}` : ''}`); }
    }
    const links = assets.map((a) => assetLink(a.name));
    log(`🚀 Release ${exists ? 'updated' : 'created'}: ${links.join(', ')}`);
    writeReadme(text, info, { run, gh, log, binariesRepo: deps.binariesRepo });
    return { updated: true, created: !exists, link: links[0], links, assets: assets.map((a) => a.name), text };
}

/** The README in tom_binaries: committed and pushed in the checkout, else through the GitHub API. */
function writeReadme(text, info, { run, gh, log, binariesRepo }) {
    const repo = binariesRepo === undefined ? path.resolve(EXT_ROOT, '..', '..', '..', 'tom_binaries') : binariesRepo;
    const message = `vscode_extension/vsix: README for the VSIX of tom_vscode ${info.commit.slice(0, 12)} (${info.script})`;
    if (repo && fs.existsSync(path.join(repo, '.git'))) {
        const git = (args) => run('git', args, { cwd: repo });
        git(['pull', '--ff-only', '--quiet']);
        fs.mkdirSync(path.dirname(path.join(repo, README_PATH)), { recursive: true });
        fs.writeFileSync(path.join(repo, README_PATH), text, 'utf8');
        git(['add', '--', README_PATH]);
        const commit = git(['commit', '--quiet', '--only', '-m', message, '--', README_PATH]);
        if (commit.status !== 0 && !/nothing to commit|no changes added/.test(`${commit.stdout} ${commit.stderr}`)) {
            log(`⚠️  ${README_PATH} was written but not committed in ${repo}: ${commit.stderr.split('\n')[0]}`);
            return false;
        }
        const push = git(['push', '--quiet']);
        if (push.status !== 0) {
            log(`⚠️  ${README_PATH} is committed in ${repo} but not pushed (${push.stderr.split('\n')[0]}): push it with /tom_push_binaries.`);
            return false;
        }
        log(`📝 ${README_PATH} committed and pushed in tom_binaries`);
        return true;
    }
    // No checkout here: through the API (a commit on the remote's default branch).
    const current = run(gh, ['api', `repos/${REPO}/contents/${README_PATH}`, '--jq', '.sha']);
    const args = ['api', '-X', 'PUT', `repos/${REPO}/contents/${README_PATH}`, '-f', `message=${message}`, '-f', `content=${Buffer.from(text, 'utf8').toString('base64')}`];
    if (current.status === 0 && current.stdout) { args.push('-f', `sha=${current.stdout}`); }
    const put = run(gh, args);
    if (put.status !== 0) {
        log(`⚠️  ${README_PATH} could not be written through the GitHub API: ${put.stderr.split('\n')[0]}`);
        return false;
    }
    log(`📝 ${README_PATH} written in tom_binaries (GitHub API; no checkout here)`);
    return true;
}

function argValue(argv, name) {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
}

/** Every value of a repeated option (`--vsix a --vsix b`). */
function argValues(argv, name) {
    const out = [];
    argv.forEach((a, i) => { if (a === name && argv[i + 1] !== undefined) { out.push(argv[i + 1]); } });
    return out;
}

module.exports = { REPO, TAG, ASSET, LINK, README_PATH, assetLink, precheck, precheckLine, parsePrecheck, vsixPlatforms, readmeText, readmeTextPlatforms, publish, writeReadme, ghCommand };

if (require.main === module) {
    const [cmd, ...argv] = process.argv.slice(2);
    if (cmd === 'precheck') {
        console.log(precheckLine(precheck()));
        process.exitCode = 0;
    } else if (cmd === 'publish') {
        try {
            publish({
                vsix: argValues(argv, '--vsix'),
                script: argValue(argv, '--script'),
                precheck: argValue(argv, '--precheck'),
                noRelease: argv.includes('--no-release'),
            });
        } catch (e) {
            console.log(`⚠️  The release was not updated: ${e && e.message ? e.message : e}.`);
        }
        process.exitCode = 0;
    } else {
        console.error('usage: vsix-release.cjs precheck | publish --vsix <file> [--vsix <file> ...] --script <name> --precheck "<line>" [--no-release]');
        process.exitCode = 2;
    }
}
