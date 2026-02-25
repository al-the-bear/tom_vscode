/**
 * Automated test runner for the Dart Bridge.
 * 
 * This class runs D4rt test scripts from tom_vscode_bridge/test/ directory
 * one by one, verifies the results, and reports the outcomes.
 * 
 * Usage:
 *   const runner = new BridgeTestRunner(context);
 *   await runner.runAllTests();
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DartBridgeClient } from './vscode-bridge';

interface TestResult {
    testFile: string;
    testName: string;
    passed: boolean;
    duration: number;
    result?: any;
    error?: string;
    logs?: string[];
}

export class BridgeTestRunner {
    private context: vscode.ExtensionContext;
    private bridgeClient: DartBridgeClient | null = null;
    private outputChannel: vscode.OutputChannel;
    private testResults: TestResult[] = [];
    private testResultsDir: string = '';

    // Static output channel to reuse across instances
    private static sharedOutputChannel: vscode.OutputChannel | null = null;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        // Reuse existing output channel if available, otherwise create new one
        if (!BridgeTestRunner.sharedOutputChannel) {
            BridgeTestRunner.sharedOutputChannel = vscode.window.createOutputChannel('Tom Tests');
        }
        this.outputChannel = BridgeTestRunner.sharedOutputChannel;
    }

    /**
     * Clear the test_results directory before running tests
     */
    private clearTestResultsDir(workspaceRoot: string): void {
        this.testResultsDir = path.join(workspaceRoot, 'vscode', 'tom_vscode_bridge', 'test_results');
        
        // Remove existing directory and all contents
        if (fs.existsSync(this.testResultsDir)) {
            fs.rmSync(this.testResultsDir, { recursive: true, force: true });
        }
        
        // Create fresh directory
        fs.mkdirSync(this.testResultsDir, { recursive: true });
        this.log(`Cleared test results directory: ${this.testResultsDir}`);
    }

    /**
     * Save individual test result to file
     */
    private saveTestResult(result: TestResult): void {
        const resultFileName = result.testName + '_results.json';
        const resultPath = path.join(this.testResultsDir, resultFileName);
        
        const resultData = {
            ...result,
            timestamp: new Date().toISOString()
        };
        
        fs.writeFileSync(resultPath, JSON.stringify(resultData, null, 2), 'utf8');
    }

    /**
     * Run all test scripts from tom_vscode_bridge/test/ directory
     */
    async runAllTests(): Promise<TestResult[]> {
        this.outputChannel.show(true);  // true = preserve focus, but show the channel
        this.outputChannel.clear();
        this.testResults = [];
        
        const timestamp = new Date().toISOString();
        this.log('========================================');
        this.log('VS Code Bridge Test Suite');
        this.log(`Run: ${timestamp}`);
        this.log('========================================\n');

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            this.log('ERROR: No workspace folder found');
            return [];
        }

        // Clear test results directory before running tests
        this.clearTestResultsDir(workspaceRoot);

        const testDir = path.join(workspaceRoot, 'vscode', 'tom_vscode_bridge', 'test');
        if (!fs.existsSync(testDir)) {
            this.log(`ERROR: Test directory not found: ${testDir}`);
            return [];
        }

        // Get all .dart files in test directory that start with a number (test files)
        // This excludes helper files like test_helper.dart
        const testFiles = fs.readdirSync(testDir)
            .filter(f => f.endsWith('.dart') && /^\d/.test(f))
            .sort();

        if (testFiles.length === 0) {
            this.log('No test files found');
            return [];
        }

        this.log(`Found ${testFiles.length} test file(s)\n`);

        // Initialize bridge client
        if (!this.bridgeClient) {
            this.bridgeClient = new DartBridgeClient(this.context);
        }

        // Start bridge if not running
        if (!this.bridgeClient.isRunning()) {
            this.log('Starting Dart bridge...');
            const bridgePath = path.join(workspaceRoot, 'vscode', 'tom_vscode_bridge');
            await this.bridgeClient.startWithAutoRestart(bridgePath);
            this.log('Bridge started\n');
        }

        // Run each test
        for (const testFile of testFiles) {
            await this.runTest(testDir, testFile);
        }

        // Print summary
        this.printSummary();

        return this.testResults;
    }

    /**
     * Run a single test script
     */
    private async runTest(testDir: string, testFile: string): Promise<void> {
        const testPath = path.join(testDir, testFile);
        const testName = testFile.replace('.dart', '');
        
        this.log(`Running: ${testName}`);

        const startTime = Date.now();

        try {
            // Read test script
            const script = fs.readFileSync(testPath, 'utf8');

            // Execute via bridge
            const result = await this.bridgeClient!.sendRequest('executeScriptVcb', {
                script: script,
                basePath: testDir,
                params: {
                    testName: testName,
                    executedBy: 'BridgeTestRunner',
                    workspaceRoot: path.dirname(testDir)  // Pass workspace root for tests that need it
                }
            });

            const duration = Date.now() - startTime;

            if (result.success) {
                this.log(`  ✓ PASSED (${duration}ms)`);
                if (result.result) {
                    this.log(`    Result: ${JSON.stringify(result.result, null, 2)}`);
                }
                
                const testResult: TestResult = {
                    testFile,
                    testName,
                    passed: true,
                    duration,
                    result: result.result,
                    logs: result.logs
                };
                this.testResults.push(testResult);
                this.saveTestResult(testResult);
            } else {
                this.log(`  ✗ FAILED (${duration}ms)`);
                this.log(`    Error: ${result.error}`);
                if (result.stackTrace) {
                    this.log(`    Stack: ${result.stackTrace}`);
                }
                
                const testResult: TestResult = {
                    testFile,
                    testName,
                    passed: false,
                    duration,
                    error: result.error,
                    logs: result.logs
                };
                this.testResults.push(testResult);
                this.saveTestResult(testResult);
            }

            // Show logs if any
            if (result.logs && result.logs.length > 0) {
                this.log(`    Logs: ${result.logs.length} message(s)`);
            }

        } catch (error) {
            const duration = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            this.log(`  ✗ ERROR (${duration}ms)`);
            this.log(`    ${errorMessage}`);
            
            const testResult: TestResult = {
                testFile,
                testName,
                passed: false,
                duration,
                error: errorMessage
            };
            this.testResults.push(testResult);
            this.saveTestResult(testResult);
        }

        this.log('');
    }

    /**
     * Print test summary
     */
    private printSummary(): void {
        const total = this.testResults.length;
        const passed = this.testResults.filter(r => r.passed).length;
        const failed = total - passed;
        const totalDuration = this.testResults.reduce((sum, r) => sum + r.duration, 0);
        const timestamp = new Date().toISOString();

        this.log('========================================');
        this.log('Test Summary');
        this.log('========================================');
        this.log(`Completed: ${timestamp}`);
        this.log(`Total:     ${total}`);
        this.log(`Passed:    ${passed} ✓`);
        this.log(`Failed:    ${failed} ${failed > 0 ? '✗' : ''}`);
        this.log(`Duration:  ${totalDuration}ms`);
        this.log(`Results:   ${this.testResultsDir}`);
        this.log('========================================\n');

        if (failed > 0) {
            this.log('Failed tests:');
            this.testResults
                .filter(r => !r.passed)
                .forEach(r => {
                    this.log(`  - ${r.testName}: ${r.error}`);
                });
        }
    }

    /**
     * Log message to output channel
     */
    private log(message: string): void {
        this.outputChannel.appendLine(message);
    }
}
