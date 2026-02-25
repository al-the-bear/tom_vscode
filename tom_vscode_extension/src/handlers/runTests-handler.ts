/**
 * Handler for dartscript.runTests command.
 * 
 * Runs all bridge tests from tom_vscode_bridge/test/ directory.
 */

import * as vscode from 'vscode';
import { BridgeTestRunner } from '../tests';

/**
 * Run all bridge tests
 */
export async function runTestsHandler(context: vscode.ExtensionContext): Promise<any> {
    const runner = new BridgeTestRunner(context);
    return await runner.runAllTests();
}
