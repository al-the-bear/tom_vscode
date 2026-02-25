/**
 * TOM Tracker VS Code Extension
 *
 * Main extension entry point. Handles activation, deactivation,
 * and top-level registration of commands, editors, and views.
 *
 * This extension provides TODO tracking panels and reusable YAML graph
 * visualization, reusing yaml-graph-core and yaml-graph-vscode
 * for graph rendering and editing.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import {
    initLogger,
    disposeLogger,
    log,
    debug,
    showLog,
    showDebugLog,
    installGlobalErrorHandlers,
    wrapCommand,
} from './infrastructure';
import { registerTodoPanel, registerTodoMindmap } from './handlers';

// ============================================================================
// Extension Lifecycle
// ============================================================================

/**
 * Main extension activation function.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // 1. Initialize infrastructure
    initLogger({ filePath: getDefaultDebugLogFilePath() });
    installGlobalErrorHandlers();
    log('TOM Tracker extension is now active');

    // 2. Register infrastructure commands
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'tomTracker.showLog',
            wrapCommand('tomTracker.showLog', () => showLog()),
        ),
        vscode.commands.registerCommand(
            'tomTracker.showDebugLog',
            wrapCommand('tomTracker.showDebugLog', () => showDebugLog()),
        ),
    );

    // 3. Register @TODO bottom panel
    registerTodoPanel(context);

    // 4. Register TODO Mindmap command
    registerTodoMindmap(context);

    // 5. Register YAML Graph Editor (reuse from existing packages)
    await registerYamlGraphEditor(context);

    debug('Activation complete');
}

/**
 * Extension deactivation.
 */
export function deactivate(): void {
    log('TOM Tracker extension deactivating');
    disposeLogger();
}

// ============================================================================
// YAML Graph Editor Registration
// ============================================================================

/**
 * Register the YAML Graph Editor custom editor provider.
 * Uses dynamic imports so a missing dependency won't crash the extension.
 */
async function registerYamlGraphEditor(
    context: vscode.ExtensionContext,
): Promise<void> {
    try {
        const path = await import('path');
        const { ConversionEngine, GraphTypeRegistry } = await import('yaml-graph-core');
        const {
            YamlGraphEditorProvider,
            VsCodeCallbacks,
            TreeDataBuilder,
            NodeEditorController,
        } = await import('yaml-graph-vscode');

        // Core engine setup
        const engine = new ConversionEngine();
        const registry = new GraphTypeRegistry();

        // Locate graph-types folder relative to the yaml-graph-core package
        const corePackagePath = path.dirname(
            require.resolve('yaml-graph-core/package.json'),
        );
        const graphTypesPath = path.join(corePackagePath, 'graph-types');

        // Auto-scan and register all graph types
        const loadErrors = await registry.registerAllFromDirectory(graphTypesPath);
        for (const err of loadErrors) {
            debug(`YAML Graph type load: ${err}`);
        }

        const registeredTypes = registry.getAll();
        log(`YAML Graph Editor: registered ${registeredTypes.length} graph type(s)`);

        if (registeredTypes.length === 0) {
            debug('YAML Graph Editor: no graph types found, skipping registration');
            return;
        }

        for (const gt of registeredTypes) {
            debug(`  -> ${gt.id}@${gt.version} patterns=[${gt.filePatterns.join(', ')}]`);
        }

        // VS Code integration
        const callbacks = new VsCodeCallbacks();
        const treeBuilder = new TreeDataBuilder();
        const nodeEditor = new NodeEditorController();

        const provider = new YamlGraphEditorProvider(
            engine, registry, callbacks, {
                treeBuilder,
                nodeEditor,
            },
        );

        // Register custom editor for all matching file patterns
        const allPatterns = registeredTypes.flatMap(gt => gt.filePatterns);
        const selector = allPatterns.map(pattern => ({
            filenamePattern: pattern,
        }));

        context.subscriptions.push(
            vscode.window.registerCustomEditorProvider(
                'tomTracker.yamlGraphEditor',
                provider,
                {
                    webviewOptions: { retainContextWhenHidden: true },
                    supportsMultipleEditorsPerDocument: false,
                },
            ),
        );

        log(`YAML Graph Editor registered for patterns: ${allPatterns.join(', ')}`);
    } catch (err) {
        // Non-fatal — extension continues without graph editor
        debug(`YAML Graph Editor not available: ${err}`);
    }
}

function getDefaultDebugLogFilePath(): string | null {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return null;
    }
    return path.join(workspaceFolder.uri.fsPath, 'ztmp', 'tom_tracker_debug.log');
}
