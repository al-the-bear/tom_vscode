/**
 * Example demonstrating nested execution from TypeScript side
 * 
 * This example shows how to call Dart methods that in turn call back to TypeScript
 */

import * as vscode from 'vscode';
import { DartBridgeClient } from '../src/vscode-bridge';

/**
 * Example: Complex nested execution flow
 * 
 * Execution flow:
 * 1. TypeScript calls Dart: processWorkspace
 * 2. Dart → TypeScript: readFile (gets project files)
 * 3. Dart → TypeScript: askCopilot (analyzes code)
 * 4. Dart → TypeScript: writeFile (saves results)
 * 5. Dart → TypeScript: executeScript (runs TypeScript code)
 * 6. Dart returns final result with all nested results as subtree
 */
export async function exampleNestedExecution(
    context: vscode.ExtensionContext,
    workspaceRoot: string
): Promise<void> {
    const bridge = new DartBridgeClient(context);

    try {
        // Start the bridge
        await bridge.start(workspaceRoot);

        // Call Dart method - this will trigger nested calls back to TypeScript
        const result = await bridge.sendRequest<any>('analyzeAndDocumentProject', {
            projectPath: workspaceRoot
        });

        // Result structure includes all nested call results
        console.log('Final result:', JSON.stringify(result, null, 2));
        
        /*
        Expected result structure:
        {
            "projectPath": "/path/to/workspace",
            "steps": [
                { "step": "showInfo", "completed": true },
                { "step": "readFile", "completed": true, "contentLength": 1234 },
                { "step": "askCopilot", "completed": true, "analysisLength": 5678 },
                { "step": "writeFile", "completed": true, "outputPath": "..." },
                { "step": "executeScript", "completed": true, "scriptResult": {...} },
                { "step": "openFile", "completed": true },
                { "step": "showInfo", "completed": true }
            ],
            "totalSteps": 7,
            "success": true,
            "completedAt": "2026-01-04T..."
        }
        */

        // Display the results
        const doc = await vscode.workspace.openTextDocument({
            content: formatResults(result),
            language: 'markdown'
        });
        await vscode.window.showTextDocument(doc);

        // Stop the bridge
        bridge.stop();
    } catch (error) {
        console.error('Error in nested execution:', error);
        bridge.stop();
        throw error;
    }
}

/**
 * Example: Execute a Dart file and get structured results
 */
export async function executeExternalDartFile(
    bridge: DartBridgeClient,
    filePath: string
): Promise<any> {
    // This sends the file path to Dart, which executes it and returns results
    const result = await bridge.sendRequest<any>('executeFile', {
        filePath: filePath,
        args: ['--verbose', '--output=json']
    });

    /*
    Result structure:
    {
        "filePath": "/path/to/script.dart",
        "exitCode": 0,
        "stdout": "{\"key\":\"value\"}",
        "stderr": "",
        "success": true,
        "data": { "key": "value" }  // Parsed JSON if stdout is valid JSON
    }
    */

    return result;
}

/**
 * Example: Execute a Dart script inline
 */
export async function executeDartScript(
    bridge: DartBridgeClient
): Promise<any> {
    const dartScript = `
import 'dart:convert';

void main() {
  // This Dart script can make calls back to TypeScript
  final result = {
    'analyzed': true,
    'fileCount': 42,
    'timestamp': DateTime.now().toIso8601String(),
  };
  
  print(jsonEncode(result));
}
`;

    const result = await bridge.sendRequest<any>('executeScript', {
        script: dartScript
    });

    /*
    Result structure:
    {
        "exitCode": 0,
        "stdout": "{\"analyzed\":true,...}",
        "stderr": "",
        "success": true,
        "data": { "analyzed": true, "fileCount": 42, ... }
    }
    */

    return result;
}

/**
 * Example: Call TypeScript from Dart
 * 
 * From Dart side:
 * ```dart
 * // Execute TypeScript code from Dart
 * final result = await server.sendRequest('executeScript', {
 *   'script': '''
 *     // This TypeScript runs in VS Code context
 *     const files = await vscode.workspace.findFiles('**\/*.dart');
 *     return { fileCount: files.length };
 *   ''',
 *   'language': 'javascript'
 * });
 * ```
 */
export async function handleExecuteScriptFromDart(
    script: string,
    context: vscode.ExtensionContext
): Promise<any> {
    // The executeScript handler in vscode-bridge.ts handles this
    // It executes the script with access to vscode and context
    // This is already implemented in the DartBridgeClient class
}

/**
 * Format results for display
 */
function formatResults(result: any): string {
    return `# Nested Execution Results

## Summary
- **Project**: ${result.projectPath}
- **Total Steps**: ${result.totalSteps}
- **Success**: ${result.success ? '✅' : '❌'}
- **Completed**: ${result.completedAt}

## Execution Steps

${result.steps.map((step: any, index: number) => `
### ${index + 1}. ${step.step}
- Status: ${step.completed ? '✅ Completed' : '⏳ Pending'}
${Object.entries(step)
    .filter(([key]) => key !== 'step' && key !== 'completed')
    .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
    .join('\n')}
`).join('\n')}

## Full Result (JSON)

\`\`\`json
${JSON.stringify(result, null, 2)}
\`\`\`
`;
}
