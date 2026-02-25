/**
 * Handler for showing extension help/documentation.
 * 
 * Opens the extension's README.md or user_guide.md in a markdown preview.
 */

import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Show the extension help/reference documentation
 */
export async function showHelpHandler(): Promise<void> {
    // Get the extension's installation path
    const extension = vscode.extensions.getExtension('tom.dartscript-vscode');
    if (!extension) {
        vscode.window.showErrorMessage('Could not find DartScript extension');
        return;
    }

    const extensionPath = extension.extensionPath;
    
    // Try user_guide.md first, fall back to README.md
    const userGuidePath = path.join(extensionPath, 'doc', 'user_guide.md');
    const readmePath = path.join(extensionPath, 'README.md');
    
    // Check which file exists
    let docPath: string;
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(userGuidePath));
        docPath = userGuidePath;
    } catch {
        docPath = readmePath;
    }

    const docUri = vscode.Uri.file(docPath);
    
    // Open the markdown file in preview mode
    await vscode.commands.executeCommand('markdown.showPreview', docUri);
}
