/**
 * Which build of the extension a window runs, and which is installed.
 *
 * A window loads the extension once, when its extension host starts; a VSIX
 * installed later is on disk but not in that window until it is reloaded.
 * Nothing said so, so agents reported features as installed that the window
 * they ran in did not have, and live checks tested old code.
 *
 * The stamp is `out/build-info.json`, written by every compile
 * (scripts/write-build-info.cjs): the commit, whether the sources were dirty,
 * and the build time. A build from before the stamp is dated by the time its
 * `out/extension.js` was written. The running build is read once at
 * activation; the installed one again whenever asked.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

/** A build: when it was made and, from a stamp, its commit. */
export interface BuildStamp {
    commit?: string;
    /** The sources had uncommitted changes. */
    dirty?: boolean;
    /** ISO time of the build. */
    builtAt: string;
    /** `build-info`: out/build-info.json; `mtime`: the time out/extension.js was written. */
    source: 'build-info' | 'mtime';
}

/** The running and the installed build, and whether the window has to be reloaded to run the installed one. */
export interface BuildStatus {
    running?: BuildStamp;
    installed?: BuildStamp;
    reloadNeeded: boolean;
}

/** The stamp of the extension in `extensionRoot`, or undefined when there is none. */
export function readBuildStamp(extensionRoot: string): BuildStamp | undefined {
    try {
        const info = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'out', 'build-info.json'), 'utf-8')) as Record<string, unknown>;
        if (typeof info.builtAt === 'string' && Number.isFinite(Date.parse(info.builtAt))) {
            return {
                ...(typeof info.commit === 'string' && info.commit ? { commit: info.commit } : {}),
                ...(info.dirty === true ? { dirty: true } : {}),
                builtAt: info.builtAt,
                source: 'build-info',
            };
        }
    } catch { /* no stamp: fall back to the file time */ }
    try {
        return { builtAt: fs.statSync(path.join(extensionRoot, 'out', 'extension.js')).mtime.toISOString(), source: 'mtime' };
    } catch {
        return undefined;
    }
}

/**
 * The comparison. Only a newer installed build asks for a reload; when either
 * side is unknown nothing is claimed.
 */
export function compareBuilds(running: BuildStamp | undefined, installed: BuildStamp | undefined): BuildStatus {
    const reloadNeeded = !!running && !!installed && Date.parse(installed.builtAt) > Date.parse(running.builtAt);
    return { running, installed, reloadNeeded };
}

/**
 * The folder the installed copy is in: among `<extensionsDir>/<id>-<version>`
 * folders not listed in `.obsolete` (VS Code removes those), the one with the
 * newest stamp; `runningRoot` when there is none. The id compares in any case
 * (VS Code lower-cases folder names).
 */
export function findInstalledExtensionRoot(extensionsDir: string, extensionId: string, runningRoot: string): string {
    let obsolete: Record<string, unknown> = {};
    try { obsolete = JSON.parse(fs.readFileSync(path.join(extensionsDir, '.obsolete'), 'utf-8')) as Record<string, unknown>; } catch { /* none */ }
    let entries: string[];
    try { entries = fs.readdirSync(extensionsDir); } catch { return runningRoot; }
    const prefix = extensionId.toLowerCase() + '-';
    let best: { root: string; at: number } | undefined;
    for (const name of entries) {
        if (!name.toLowerCase().startsWith(prefix) || obsolete[name]) { continue; }
        const root = path.join(extensionsDir, name);
        const stamp = readBuildStamp(root);
        const at = stamp ? Date.parse(stamp.builtAt) : NaN;
        if (Number.isFinite(at) && (!best || at > best.at)) { best = { root, at }; }
    }
    return best?.root ?? runningRoot;
}

/** `abc1234 (2026-10-27 10:05 UTC)`, `(dirty)` after the commit of a build of uncommitted sources; `built …` without a commit. */
export function buildLabel(stamp: BuildStamp | undefined): string {
    if (!stamp) { return 'unknown'; }
    const at = `${stamp.builtAt.slice(0, 10)} ${stamp.builtAt.slice(11, 16)} UTC`;
    if (!stamp.commit) { return `built ${at}`; }
    return `${stamp.commit}${stamp.dirty ? ' (dirty)' : ''} (${at})`;
}
