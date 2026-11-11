#!/usr/bin/env node
/**
 * The packaged VSIX as a download: the GitHub Release `vscode-extension-latest`
 * of al-the-bear/tom_binaries, and `vscode_extension/vsix/README.md` there.
 *
 *   node scripts/vsix-release.cjs precheck
 *   node scripts/vsix-release.cjs publish --vsix <file> --script <name> --precheck "<line>" [--no-release]
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
 *   VSIX as the asset `tom-ai-extension.vsix` of the release (`gh release
 *   create` the first time, `gh release upload --clobber` after), sets the
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

const EXT_ROOT = path.resolve(__dirname, '..');
const REPO = 'al-the-bear/tom_binaries';
const TAG = 'vscode-extension-latest';
const ASSET = 'tom-ai-extension.vsix';
const LINK = `https://github.com/${REPO}/releases/download/${TAG}/${ASSET}`;
const README_PATH = 'vscode_extension/vsix/README.md';
const TITLE = 'Tom AI VS Code extension — latest build';
const DART_BINARIES = ['tom_bs', 'validate_codespecs', 'spec_checks'];

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
function vsixPlatforms(vsix, { extBin = path.join(EXT_ROOT, 'bin'), layer } = {}) {
    const names = new Set(vsixContents.readCentralDirectory(fs.readFileSync(vsix)).map((e) => (typeof e === 'string' ? e : e.name)));
    const layerDir = layer ?? path.resolve(EXT_ROOT, '..', '..', '..', 'tom_binaries', 'tom');
    return vsixContents.dartBinaryReport(names).map(({ platform, binaries }) => {
        const carried = DART_BINARIES.filter((b) => binaries[b]);
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
        return { platform, carried, stamps };
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
    lines.push('', 'Provider SDKs (Anthropic, Agent SDK) are not in the VSIX: the extension installs them on request (Provider SDKs page).', '');
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
    const notUpdated = (why, hint) => {
        log(`⚠️  The release was not updated: ${why}.`);
        if (hint) { log(`   ${hint}`); }
        log(`   The VSIX stays local: ${opts.vsix || '(none)'}`);
        return { updated: false, reason: why };
    };
    if (opts.noRelease) { return notUpdated('--no-release given'); }
    if (!opts.vsix || !fs.existsSync(opts.vsix)) { return notUpdated('no VSIX was packed'); }
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

    const stat = fs.statSync(opts.vsix);
    const info = {
        commit: pre.commit,
        // When the VSIX was packed (its file time), not when it is uploaded.
        date: (deps.now || stat.mtime).toISOString(),
        size: stat.size,
        script: opts.script || 'a create_*_vsix script',
        platforms: deps.platforms || vsixPlatforms(opts.vsix),
    };
    const text = readmeText(info);
    const workDir = deps.workDir || path.join(EXT_ROOT, 'out', 'vsix-release');
    fs.mkdirSync(workDir, { recursive: true });
    const asset = path.join(workDir, ASSET);
    fs.copyFileSync(opts.vsix, asset);
    const notes = path.join(workDir, 'notes.md');
    fs.writeFileSync(notes, text, 'utf8');

    const exists = run(gh, ['release', 'view', TAG, '-R', REPO, '--json', 'tagName']).status === 0;
    const steps = exists
        ? [['release', 'upload', TAG, asset, '--clobber', '-R', REPO], ['release', 'edit', TAG, '--title', TITLE, '--notes-file', notes, '-R', REPO]]
        : [['release', 'create', TAG, asset, '--title', TITLE, '--notes-file', notes, '-R', REPO]];
    for (const args of steps) {
        const r = run(gh, args);
        if (r.status !== 0) { return notUpdated(`gh ${args.slice(0, 2).join(' ')} failed${r.stderr ? `: ${r.stderr.split('\n')[0]}` : ''}`); }
    }
    log(`🚀 Release ${exists ? 'updated' : 'created'}: ${LINK}`);
    writeReadme(text, info, { run, gh, log, binariesRepo: deps.binariesRepo });
    return { updated: true, created: !exists, link: LINK, text };
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

module.exports = { REPO, TAG, ASSET, LINK, README_PATH, precheck, precheckLine, parsePrecheck, vsixPlatforms, readmeText, publish, writeReadme, ghCommand };

if (require.main === module) {
    const [cmd, ...argv] = process.argv.slice(2);
    if (cmd === 'precheck') {
        console.log(precheckLine(precheck()));
        process.exitCode = 0;
    } else if (cmd === 'publish') {
        try {
            publish({
                vsix: argValue(argv, '--vsix'),
                script: argValue(argv, '--script'),
                precheck: argValue(argv, '--precheck'),
                noRelease: argv.includes('--no-release'),
            });
        } catch (e) {
            console.log(`⚠️  The release was not updated: ${e && e.message ? e.message : e}.`);
        }
        process.exitCode = 0;
    } else {
        console.error('usage: vsix-release.cjs precheck | publish --vsix <file> --script <name> --precheck "<line>" [--no-release]');
        process.exitCode = 2;
    }
}
