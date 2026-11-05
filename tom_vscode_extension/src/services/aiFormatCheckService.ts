/**
 * At start, warn when this machine's `_ai` files are in another format version
 * than this build understands (src/utils/aiFormatVersion.ts): newer — another
 * machine migrated them with a newer build; older or unstamped — the format
 * migration has not run for them. The warning names what to do and offers to
 * copy the migration command. Nothing is migrated by itself.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';

import { AI_FORMAT_MIGRATE_COMMAND, checkAiFormatVersion, type AiFormatCheck } from '../utils/aiFormatVersion';
import { WsPaths } from '../utils/workspacePaths';

const COPY = 'Copy migration command';

/** Check the workspace's `_ai` and warn when its format version is not this build's. Answers the check. */
export function warnAboutAiFormatVersion(): AiFormatCheck | undefined {
    const aiRoot = WsPaths.aiRoot;
    if (!aiRoot || !fs.existsSync(aiRoot)) { return undefined; }
    const check = checkAiFormatVersion(aiRoot);
    if (check.kind === 'current') { return check; }
    const actions = check.kind === 'newer' ? [] : [COPY];
    void vscode.window.showWarningMessage(`Tom AI: ${check.message}`, ...actions).then((picked) => {
        if (picked === COPY) { void vscode.env.clipboard.writeText(AI_FORMAT_MIGRATE_COMMAND.replace(/ \(.*\)$/, '')); }
    });
    return check;
}
