#!/usr/bin/env node
/**
 * One VSIX per platform (vscimpb103): the multi-platform create scripts
 * (create_currentbinaries_vsix, create_fleetcompiled_vsix,
 * create_layerbinaries_vsix — sh and ps1) bundle every platform's binaries
 * into bin/<platform>/, then install_extension packs, for each platform there,
 *
 *   vsce package --target <platform> --ignoreFile <.vscodeignore + the other platforms' bin/> \
 *       -o tom-ai-extension-<platform>.vsix
 *
 * so each VSIX carries only its own platform's Dart binaries and build tools
 * (TOM_SPLIT_PLATFORMS=1). Nothing is moved: the other platforms' folders are
 * left out by a per-platform ignore file written under out/vsix-split/. VS Code
 * installs a VSIX only on the platform it targets.
 *
 *   node scripts/vsix-split.cjs platforms            the platforms bin/ holds, one per line
 *   node scripts/vsix-split.cjs package --vsce "<vsce command>"
 *                                                    pack and check one VSIX per platform
 *   node scripts/vsix-split.cjs list                 the per-platform VSIX files here, newest first
 *
 * `package` checks each VSIX with scripts/check-vsix-contents.cjs --target and
 * exits 1 when packing or a check fails, 2 when bin/ holds no platform.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
/** The platforms VS Code takes as `vsce package --target`, in the order the VSIX are packed. */
const VSCODE_TARGETS = ['darwin-arm64', 'linux-x64', 'win32-x64', 'darwin-x64', 'linux-arm64', 'linux-armhf', 'win32-arm64', 'alpine-x64', 'alpine-arm64'];
const PREFIX = 'tom-ai-extension-';

/** `tom-ai-extension-<platform>.vsix`. */
function vsixName(platform) { return `${PREFIX}${platform}.vsix`; }

/** The platform a per-platform VSIX is for (by its name), or null. */
function platformOfVsix(file) {
    const m = /^tom-ai-extension-([a-z0-9]+-[a-z0-9]+)\.vsix$/.exec(path.basename(String(file || '')));
    return m && VSCODE_TARGETS.includes(m[1]) ? m[1] : null;
}

/** The platforms bin/ holds a folder for, in VSCODE_TARGETS order; anything else is not packed. */
function platformsInBin(binDir = path.join(EXT_ROOT, 'bin')) {
    if (!fs.existsSync(binDir)) { return []; }
    const dirs = new Set(fs.readdirSync(binDir).filter((d) => fs.statSync(path.join(binDir, d)).isDirectory()));
    return VSCODE_TARGETS.filter((p) => dirs.has(p));
}

/** The ignore file for one platform's VSIX: the package's own .vscodeignore and the others' bin folders. */
function ignoreText(baseText, platform, all) {
    const others = all.filter((p) => p !== platform);
    return [
        baseText.replace(/\s+$/, ''),
        '',
        `# One VSIX per platform (scripts/vsix-split.cjs): this one is for ${platform}.`,
        ...others.map((p) => `bin/${p}/**`),
        'out/vsix-split/**',
        '*.vsix',
        '',
    ].join('\n');
}

/** The per-platform VSIX files in `dir`, newest first. */
function listVsix(dir = EXT_ROOT) {
    return fs.readdirSync(dir)
        .filter((f) => platformOfVsix(f))
        .map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function defaultRun(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
    return r.error ? 1 : (r.status ?? 1);
}

/**
 * Pack and check one VSIX per platform of bin/. `vsce`: the command words
 * (`['vsce']`, `['npx', '--yes', '@vscode/vsce']`). Answers each platform's
 * `{platform, vsix, ok, error?}`.
 */
function packageAll({ vsce, extRoot = EXT_ROOT, platforms = platformsInBin(path.join(extRoot, 'bin')), run = defaultRun, log = console.log } = {}) {
    const { vsixBaseUrls } = require('./vsix-base-url.cjs');
    const manifest = JSON.parse(fs.readFileSync(path.join(extRoot, 'package.json'), 'utf8'));
    const urls = vsixBaseUrls(manifest);
    const base = fs.existsSync(path.join(extRoot, '.vscodeignore')) ? fs.readFileSync(path.join(extRoot, '.vscodeignore'), 'utf8') : '';
    const work = path.join(extRoot, 'out', 'vsix-split');
    fs.mkdirSync(work, { recursive: true });
    const results = [];
    for (const platform of platforms) {
        const ignore = path.join(work, `vscodeignore-${platform}`);
        fs.writeFileSync(ignore, ignoreText(base, platform, platforms), 'utf8');
        const out = path.join(extRoot, vsixName(platform));
        log(`\n📦 Packaging ${path.basename(out)} (only bin/${platform}/)...`);
        const packed = run(vsce[0], [...vsce.slice(1), 'package', '--skip-license', '--target', platform, '--ignoreFile', ignore, '-o', out,
            '--baseContentUrl', urls.content, '--baseImagesUrl', urls.images], { cwd: extRoot });
        if (packed !== 0 || !fs.existsSync(out)) {
            results.push({ platform, vsix: out, ok: false, error: 'vsce package failed' });
            continue;
        }
        const checked = run(process.execPath, [path.join(__dirname, 'check-vsix-contents.cjs'), out, '--target', platform], { cwd: extRoot, shell: false });
        results.push({ platform, vsix: out, ok: checked === 0, ...(checked === 0 ? {} : { error: 'check-vsix-contents failed' }) });
    }
    return results;
}

module.exports = { VSCODE_TARGETS, vsixName, platformOfVsix, platformsInBin, ignoreText, listVsix, packageAll };

if (require.main === module) {
    const [cmd, ...argv] = process.argv.slice(2);
    if (cmd === 'platforms') {
        process.stdout.write(platformsInBin().join('\n') + '\n');
    } else if (cmd === 'list') {
        process.stdout.write(listVsix().map((f) => `${f}\n`).join(''));
    } else if (cmd === 'package') {
        const i = argv.indexOf('--vsce');
        const vsce = (i >= 0 && argv[i + 1] ? argv[i + 1] : 'vsce').split(/\s+/).filter(Boolean);
        const platforms = platformsInBin();
        if (platforms.length === 0) {
            console.error('❌ bin/ holds no platform folder: nothing to pack per platform.');
            process.exit(2);
        }
        const results = packageAll({ vsce, platforms });
        console.log('');
        for (const r of results) { console.log(`${r.ok ? '✅' : '❌'} ${path.basename(r.vsix)}${r.ok ? '' : `: ${r.error}`}`); }
        process.exitCode = results.every((r) => r.ok) ? 0 : 1;
    } else {
        console.error('usage: vsix-split.cjs platforms | list | package --vsce "<vsce command>"');
        process.exitCode = 2;
    }
}
