/**
 * Example JavaScript file that can be executed via executeFile
 * 
 * This file exports a function that receives:
 * - params: Parameters passed from the caller
 * - context: Execution context with { vscode, bridge, require, console }
 */

// Export the main execute function
module.exports = async function execute(params, context) {
    const { vscode, bridge, console } = context;
    
    console.log('Executing example script with params:', params);
    
    // Access vscode API
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const folderPaths = workspaceFolders ? workspaceFolders.map(f => f.uri.fsPath) : [];
    
    // Make a nested call back to Dart
    const dartInfo = await bridge.sendRequest('getWorkspaceInfo', {
        workspaceRoot: folderPaths[0]
    });
    
    // Show a notification
    vscode.window.showInformationMessage(`Hello from JavaScript! Workspace has ${dartInfo.projects?.length || 0} projects`);
    
    // Return result
    return {
        params: params,
        workspaceFolders: folderPaths,
        dartInfo: dartInfo,
        message: 'Successfully executed JavaScript file with vscode context!'
    };
};

// Alternative: export as 'execute' property
// module.exports.execute = async function(params, context) { ... };

// Alternative: export as default
// export default async function(params, context) { ... };
