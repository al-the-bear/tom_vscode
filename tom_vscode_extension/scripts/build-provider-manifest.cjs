#!/usr/bin/env node
/**
 * The provider SDK manifest: which npm packages, at which versions, the
 * extension installs for a provider (resources/providers/providers.json).
 *
 *   node scripts/build-provider-manifest.cjs [--check]   (npm run providers:manifest)
 *
 * The provider SDKs are not in the VSIX (their licences do not let the
 * extension redistribute them; most users need one or two providers). The
 * extension installs them on request into its global storage
 * (src/services/providerInstaller.ts), pinned to the versions this build is
 * tested with: the ones in package-lock.json. This script writes that set —
 * for every provider its root packages and their whole dependency closure,
 * each with version, tarball URL and integrity, and the per-platform packages
 * (os / cpu / libc) of which an install takes the host's only.
 *
 * The SDKs are devDependencies of the extension (for the types and the
 * tests): vsce packages dependencies only, so they stay out of the VSIX.
 *
 * Peer dependencies are installed only where a provider lists them under
 * `alsoInstall`: the Agent SDK's sdk.mjs bundles zod and the MCP SDK and
 * imports nothing but Node built-ins, the direct SDK requires `zod/v4` in its
 * zod helpers.
 *
 * --check exits 1 when the written manifest differs from what the lock gives
 * (the PS-1 test runs the same comparison).
 */
'use strict';
/* eslint-disable @typescript-eslint/naming-convention -- exported constants keep their names */

const fs = require('fs');
const path = require('path');

const EXT_ROOT = path.resolve(__dirname, '..');
const LOCK = path.join(EXT_ROOT, 'package-lock.json');
const OUT = path.join(EXT_ROOT, 'resources', 'providers', 'providers.json');

/** The providers and what each installs. Platform packages are a root's optionalDependencies with os / cpu. */
const PROVIDERS = [
    {
        id: 'anthropic',
        name: 'Anthropic',
        description: 'The direct Anthropic API (@anthropic-ai/sdk) and the Claude Agent SDK with its Claude CLI for this platform.',
        roots: ['@anthropic-ai/sdk', '@anthropic-ai/claude-agent-sdk'],
        alsoInstall: ['zod'],
    },
];

function readLock(file = LOCK) {
    return JSON.parse(fs.readFileSync(file, 'utf8')).packages;
}

/** One manifest entry from a lock entry. */
function entryFor(name, lockKey, v) {
    const e = { name, version: v.version, path: lockKey, resolved: v.resolved, integrity: v.integrity };
    if (v.os) { e.os = v.os; }
    if (v.cpu) { e.cpu = v.cpu; }
    if (/-musl$/.test(name)) { e.libc = ['musl']; } else if (v.os && v.os.includes('linux') && v.cpu) { e.libc = ['glibc']; }
    return e;
}

/**
 * The package set of a provider: its roots, `alsoInstall`, every dependency
 * reached from them (dependencies, and optionalDependencies — the platform
 * packages), resolved as npm resolves them (a nested node_modules first).
 */
function providerPackages(provider, lock) {
    const out = new Map();
    const visit = (name, fromKey) => {
        // npm's resolution: the nearest node_modules/<name> above the requiring package.
        let key = null;
        for (let base = fromKey; ; ) {
            const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
            if (lock[candidate]) { key = candidate; break; }
            if (!base) { break; }
            const at = base.lastIndexOf('/node_modules/');
            base = at < 0 ? '' : base.slice(0, at);
        }
        if (!key) { throw new Error(`${provider.id}: ${name} (needed by ${fromKey || 'the provider'}) is not in package-lock.json`); }
        if (out.has(key)) { return; }
        const v = lock[key];
        out.set(key, entryFor(name, key, v));
        for (const dep of Object.keys({ ...(v.dependencies || {}), ...(v.optionalDependencies || {}) })) { visit(dep, key); }
    };
    for (const name of [...provider.roots, ...(provider.alsoInstall || [])]) { visit(name, ''); }
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function buildManifest(lock = readLock()) {
    return {
        $comment: 'Written by scripts/build-provider-manifest.cjs from package-lock.json (npm run providers:manifest). Do not edit.',
        formatVersion: 1,
        registry: 'https://registry.npmjs.org',
        providers: PROVIDERS.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            roots: p.roots,
            alsoInstall: p.alsoInstall || [],
            packages: providerPackages(p, lock),
        })),
    };
}

function render(manifest) {
    return `${JSON.stringify(manifest, null, 2)}\n`;
}

module.exports = { PROVIDERS, buildManifest, providerPackages, render, OUT };

if (require.main === module) {
    const text = render(buildManifest());
    if (process.argv.includes('--check')) {
        const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
        if (now !== text) {
            console.error(`✖ ${path.relative(EXT_ROOT, OUT)} is not what package-lock.json gives: run npm run providers:manifest`);
            process.exitCode = 1;
        } else {
            console.log(`✔ ${path.relative(EXT_ROOT, OUT)} matches package-lock.json`);
        }
    } else {
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, text);
        const m = JSON.parse(text);
        for (const p of m.providers) { console.log(`✔ ${p.id}: ${p.packages.length} packages`); }
    }
}
