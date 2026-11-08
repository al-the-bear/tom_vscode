/**
 * Help pages the extension carries in `resources/`, filled for this window
 * (its platform, what is missing) and shown with `markdown.showPreview`, which
 * renders a file outside the workspace too. Used by the Dart binaries page and
 * the Agent SDK CLI page.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export const HELP_BUTTON_LABEL = 'What does this mean?';

/**
 * Write `templateRel` (inside the extension) filled by `fill` into the
 * extension's global storage under the same relative path; answers the file.
 * Before activation there is no storage folder: the extension's own page is
 * answered as it is, and nothing is written.
 */
export function writeFilledPage(extensionRoot: string, storageDir: string, templateRel: string, fill: (template: string) => string): string {
    const source = path.join(extensionRoot, templateRel);
    if (!storageDir) { return source; }
    const target = path.join(storageDir, path.relative('resources', templateRel));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fill(fs.readFileSync(source, 'utf8')), 'utf8');
    return target;
}

export async function previewPage(file: string): Promise<void> {
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file));
}

/** Show `message` (error or warning) with "What does this mean?"; the click runs `open`. */
export async function showWithHelpButton(kind: 'error' | 'warning', message: string, open: () => Promise<void>): Promise<void> {
    const show = kind === 'error' ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
    const picked = await show(message, HELP_BUTTON_LABEL);
    if (picked === HELP_BUTTON_LABEL) { await open(); }
}
