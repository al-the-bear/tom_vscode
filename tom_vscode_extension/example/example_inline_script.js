/**
 * Example inline script for executeScript
 * 
 * This is the script content that would be passed to executeScript method.
 * It has access to 'params' and 'context' variables.
 * 
 * Usage from Dart:
 * await sendRequest('executeScript', {
 *   'script': '<content of this file>',
 *   'params': {'name': 'World'}
 * });
 */

// Access parameters
const name = params.name || 'Unknown';

// Access context
const { vscode, bridge, console } = context;

// Use VS Code API
const editor = vscode.window.activeTextEditor;
const fileName = editor ? editor.document.fileName : 'No file open';

// Make nested call to Dart
const files = await bridge.sendRequest('getWorkspaceInfo', {
    workspaceRoot: vscode.workspace.workspaceFolders[0].uri.fsPath
});

// Log to console
console.log(`Hello ${name}!`);

// Return result (this becomes the response)
return {
    greeting: `Hello ${name}!`,
    activeFile: fileName,
    projectCount: files.projects?.length || 0,
    timestamp: new Date().toISOString()
};
