/**
 * Where this checkout's real configuration and guidelines are, for the tests that read them (not a test file
 * itself: the test scripts run `*.test.js` only). The layout's own rules decide, never a fixed path:
 *
 * - **the root** is the nearest folder at or above the workspace folder holding `.tom/tom_root.yaml`
 *   (utils/workspaceLayout.ts `findRoot`); its `.tom` holds the one configuration (`tom_vscode_extension.json`)
 *   and the generated schemas (`json-schema/`, `docspecs-schema/`);
 * - **a guideline** is read on two levels, the workspace folder's guidelines first, then the root's, each under
 *   `_agent_guidelines/` before the older `_copilot_guidelines/` (utils/guidelineFolders.ts).
 */

import * as fs from 'fs';
import * as path from 'path';

import { findRoot, realLayoutFs } from '../workspaceLayout.js';

/** The extension's folder (`tom_ai/vscode/tom_vscode_extension`), from `out/utils/__tests__`. */
export const EXTENSION_DIR = path.resolve(__dirname, '..', '..', '..');
/** The workspace folder the extension is checked out in (the agent container). */
export const WORKSPACE_FOLDER = path.resolve(EXTENSION_DIR, '..', '..', '..');

/** The root of the layout: the nearest folder at or above the workspace folder with `.tom/tom_root.yaml`. */
export function tomRoot(): string {
    const root = findRoot(WORKSPACE_FOLDER, realLayoutFs, process.platform);
    if (!root) { throw new Error(`no .tom/tom_root.yaml at or above ${WORKSPACE_FOLDER}`); }
    return root;
}

/** A path in the root's `.tom`, e.g. `rootTomPath('tom_vscode_extension.json')`. */
export function rootTomPath(...parts: string[]): string {
    return path.join(tomRoot(), '.tom', ...parts);
}

/** A guideline by its path in a guidelines folder: the workspace folder's first, then the root's. */
export function guidelinePath(relative: string): string {
    for (const level of [WORKSPACE_FOLDER, tomRoot()]) {
        for (const folder of ['_agent_guidelines', '_copilot_guidelines']) {
            const file = path.join(level, folder, relative);
            if (fs.existsSync(file)) { return file; }
        }
    }
    throw new Error(`no guideline ${relative} in the workspace folder's or the root's guidelines`);
}
