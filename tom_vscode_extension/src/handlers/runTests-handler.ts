/**
 * Handler for tomAi.runTests command.
 * 
 * Runs all bridge tests from tom_vscode_bridge/test/ directory.
 */

import * as vscode from 'vscode';
import { BridgeTestRunner } from '../tests';
import { guardDartScript } from './dartScriptGuard';

/**
 * Run all bridge tests
 */
export async function runTestsHandler(context: vscode.ExtensionContext): Promise<any> {
    const blocked = guardDartScript('Run Tests');
    if (blocked) { return blocked; }
    const runner = new BridgeTestRunner(context);
    return await runner.runAllTests();
}
