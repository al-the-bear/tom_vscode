/**
 * YAML Graph Editor Handler
 *
 * Registers the YAML Graph custom editor with VS Code. Wires together:
 * - ConversionEngine + GraphTypeRegistry from yaml-graph-core
 * - YamlGraphEditorProvider + VsCodeCallbacks from yaml-graph-vscode
 * - Graph type definitions from yaml_graph_core/graph-types/
 *
 * This is the Phase 3 glue code — minimal orchestration only.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { bridgeLog } from './handler_shared';

/**
 * Register the YAML Graph Editor custom editor provider.
 *
 * Uses dynamic imports for yaml-graph-core and yaml-graph-vscode so that
 * a missing dependency (e.g. ajv) won't crash the entire extension load.
 *
 * Graph type registration is lazy — happens on first file open, not during
 * activation. The actual I/O is <20ms but awaiting during the activation
 * rush inflates to 10–15s due to event loop contention with other extensions.
 *
 * Call this during extension activation to enable the custom editor
 * for *.flow.yaml, *.state.yaml, and *.er.yaml files.
 */
export async function registerYamlGraphEditor(
    context: vscode.ExtensionContext
): Promise<void> {
    try {
        const { debugLog } = await import('../utils/debugLogger.js');
        let sub = performance.now();

        // Dynamic imports — keeps the extension functional even if these fail
        const { ConversionEngine, GraphTypeRegistry } = await import('yaml-graph-core');
        debugLog(`yamlGraphEditor.import(yaml-graph-core): ${Math.round((performance.now() - sub) * 100) / 100}ms`, 'INFO', 'extension.activate');
        sub = performance.now();
        const {
            YamlGraphEditorProvider,
            VsCodeCallbacks,
            TreeDataBuilder,
            NodeEditorController,
        } = await import('yaml-graph-vscode');
        debugLog(`yamlGraphEditor.import(yaml-graph-vscode): ${Math.round((performance.now() - sub) * 100) / 100}ms`, 'INFO', 'extension.activate');

        // 1. Core engine (no VS Code dependency)
        sub = performance.now();
        const engine = new ConversionEngine();
        const registry = new GraphTypeRegistry();
        debugLog(`yamlGraphEditor.engineInit: ${Math.round((performance.now() - sub) * 100) / 100}ms`, 'INFO', 'extension.activate');

        // 2. Locate graph-types folder relative to the yaml-graph-core package.
        const corePackagePath = path.dirname(
            require.resolve('yaml-graph-core/package.json')
        );
        const graphTypesPath = path.join(corePackagePath, 'graph-types');

        // 3. Graph type registration — lazy, on first resolveCustomTextEditor call.
        let graphTypesLoaded = false;

        async function ensureGraphTypesLoaded(): Promise<void> {
            if (graphTypesLoaded) return;
            const regStart = performance.now();
            const loadErrors = await registry.registerAllFromDirectory(graphTypesPath);
            graphTypesLoaded = true;
            debugLog(`yamlGraphEditor.registerAllFromDirectory (first-use): ${Math.round((performance.now() - regStart) * 100) / 100}ms`, 'INFO', 'yamlGraph');
            for (const err of loadErrors) {
                bridgeLog(`YAML Graph: ${err}`, 'INFO');
            }
            const registeredTypes = registry.getAll();
            bridgeLog(`YAML Graph Editor: registered ${registeredTypes.length} graph type(s)`);
            for (const gt of registeredTypes) {
                bridgeLog(`  -> ${gt.id}@${gt.version} patterns=[${gt.filePatterns.join(', ')}]`);
            }
        }

        // 4. VS Code integration with callbacks
        const callbacks = new VsCodeCallbacks();
        const treeBuilder = new TreeDataBuilder();
        const nodeEditor = new NodeEditorController();

        const provider = new YamlGraphEditorProvider(
            engine, registry, callbacks, {
                treeBuilder,
                nodeEditor,
            }
        );

        // 5. Wrap provider with debug logging + lazy graph type loading
        const debugProvider: vscode.CustomTextEditorProvider = {
            async resolveCustomTextEditor(
                document: vscode.TextDocument,
                webviewPanel: vscode.WebviewPanel,
                token: vscode.CancellationToken
            ): Promise<void> {
                bridgeLog(`YAML Graph: resolveCustomTextEditor called for ${document.fileName}`);
                try {
                    // Load graph types on first use (fast — <20ms actual I/O)
                    await ensureGraphTypesLoaded();

                    // Check graph type resolution
                    const registeredTypes = registry.getAll();
                    const graphType = (provider as any).resolveGraphType(document);
                    bridgeLog(`YAML Graph: resolveGraphType -> ${graphType ? graphType.id + '@' + graphType.version : 'undefined'}`);

                    if (!graphType) {
                        bridgeLog('YAML Graph: graph type not found — webview will not update', 'ERROR');
                        webviewPanel.webview.html = `<html><body style="padding:20px;color:#d4d4d4;font-family:sans-serif;">
                            <h2>YAML Graph Editor — Error</h2>
                            <p>Could not resolve graph type for <strong>${document.fileName}</strong></p>
                            <p>Registered types:</p>
                            <ul>${registeredTypes.map(gt => `<li>${gt.id}@${gt.version} — patterns: ${gt.filePatterns.join(', ')}</li>`).join('')}</ul>
                            <p>Make sure the file has a <code>meta.graph-version: 1</code> field.</p>
                        </body></html>`;
                        return;
                    }

                    // Delegate to real provider
                    await provider.resolveCustomTextEditor(document, webviewPanel, token);
                    bridgeLog(`YAML Graph: resolveCustomTextEditor completed successfully`);
                } catch (err) {
                    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
                    bridgeLog(`YAML Graph: resolveCustomTextEditor FAILED — ${msg}`, 'ERROR');
                    webviewPanel.webview.html = `<html><body style="padding:20px;color:#d4d4d4;font-family:sans-serif;">
                        <h2>YAML Graph Editor — Error</h2>
                        <pre>${msg}</pre>
                    </body></html>`;
                }
            }
        };

        // 6. Register custom editor for YAML graph files
        context.subscriptions.push(
            vscode.window.registerCustomEditorProvider(
                'yamlGraph.editor',
                debugProvider,
                { webviewOptions: { retainContextWhenHidden: true } }
            )
        );

        bridgeLog('YAML Graph Editor: custom editor registered (graph types load on first use)');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bridgeLog(`YAML Graph Editor: failed to register — ${message}`, 'ERROR');
        // Non-fatal — extension continues without YAML Graph Editor
    }
}
