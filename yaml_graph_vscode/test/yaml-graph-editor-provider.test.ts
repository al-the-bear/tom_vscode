/**
 * Tests for YamlGraphEditorProvider — the main VS Code custom editor entry point.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { YamlGraphEditorProvider } from '../src/yaml-graph-editor-provider.js';
import {
    MockTextDocument, MockWebviewPanel, MockTextEditor,
    Uri, CancellationTokenSource, _resetAllMocks, window, workspace,
} from 'vscode';
import type { ConversionEngine, GraphTypeRegistry, ConversionCallbacks, GraphType } from 'yaml-graph-core';

// ─── Test Graph Type ────────────────────────────────────────

function makeGraphType(id: string = 'flowchart', version: number = 1): GraphType {
    return {
        id,
        version,
        filePatterns: [`*.${id}.yaml`],
        schema: {},
        mapping: {
            map: { id, version, mermaidType: 'flowchart' },
            nodeShapes: {
                sourcePath: 'nodes', idField: '_key', labelField: 'label',
                shapeField: 'type', shapes: {},
            },
            edgeLinks: {
                sourcePath: 'edges', fromField: 'from', toField: 'to',
                linkStyles: { default: '-->' },
            },
        },
    };
}

function makeFlowchartYaml(): string {
    return `meta:
  graph-version: 1
nodes:
  start:
    label: Start
    type: default
  end:
    label: End
    type: default
edges:
  - from: start
    to: end
`;
}

function makeNumericVersionYaml(version: number): string {
    return `meta:\n  graph-version: ${version}\nnodes:\n  a:\n    label: A\n`;
}

// ─── Mock Engine & Registry ─────────────────────────────────

function makeMockEngine(): ConversionEngine {
    return {
        convert: vi.fn().mockReturnValue({
            mermaidSource: 'flowchart TD\n  A --> B',
            errors: [],
            nodeMap: new Map(),
            edgeMap: new Map(),
        }),
        convertWithPrepare: vi.fn().mockResolvedValue({
            mermaidSource: 'flowchart TD\n  A --> B',
            errors: [],
            nodeMap: new Map(),
            edgeMap: new Map(),
        }),
    } as unknown as ConversionEngine;
}

function makeMockRegistry(graphType?: GraphType): GraphTypeRegistry {
    const gt = graphType ?? makeGraphType();
    return {
        getForFileVersion: vi.fn().mockImplementation(
            (filename: string, version: number) => {
                if (filename.endsWith('.flow.yaml') && version === gt.version) return gt;
                if (filename.endsWith(`.${gt.id}.yaml`) && version === gt.version) return gt;
                return undefined;
            }
        ),
        getForFile: vi.fn().mockReturnValue(gt),
        getAll: vi.fn().mockReturnValue([gt]),
    } as unknown as GraphTypeRegistry;
}

function makeMockCallbacks(): ConversionCallbacks {
    return {
        prepare: vi.fn().mockResolvedValue(undefined),
        onNodeEmit: vi.fn().mockReturnValue([]),
        onEdgeEmit: vi.fn().mockReturnValue([]),
        onComplete: vi.fn().mockReturnValue([]),
    };
}

// ─── Tests ──────────────────────────────────────────────────

describe('YamlGraphEditorProvider', () => {
    let engine: ConversionEngine;
    let registry: GraphTypeRegistry;
    let callbacks: ConversionCallbacks;

    beforeEach(() => {
        _resetAllMocks();
        engine = makeMockEngine();
        registry = makeMockRegistry();
        callbacks = makeMockCallbacks();
    });

    // ─── resolveGraphType ───────────────────────────────────

    describe('resolveGraphType', () => {
        it('returns graph type for valid YAML with graph-version', () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                makeFlowchartYaml()
            );

            const result = provider.resolveGraphType(doc as any);

            expect(result).toBeDefined();
            expect(result!.id).toBe('flowchart');
            expect(registry.getForFileVersion).toHaveBeenCalledWith(
                '/project/test.flow.yaml', 1
            );
        });

        it('returns undefined and shows error when graph-version is missing', () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                'meta:\n  title: No version\nnodes:\n  a:\n    label: A\n'
            );

            const result = provider.resolveGraphType(doc as any);

            expect(result).toBeUndefined();
            const messages = window._getShownMessages();
            expect(messages).toContainEqual(
                expect.objectContaining({
                    type: 'error',
                    message: expect.stringContaining('graph-version'),
                })
            );
        });

        it('returns undefined and shows error when graph-version is not a number', () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                'meta:\n  graph-version: "latest"\nnodes:\n  a:\n    label: A\n'
            );

            const result = provider.resolveGraphType(doc as any);

            expect(result).toBeUndefined();
            const messages = window._getShownMessages();
            expect(messages.some(m => m.type === 'error' && m.message.includes('graph-version'))).toBe(true);
        });

        it('returns undefined and shows error for invalid YAML', () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                'just plain text'
            );

            const result = provider.resolveGraphType(doc as any);

            expect(result).toBeUndefined();
            const messages = window._getShownMessages();
            expect(messages.length).toBeGreaterThan(0);
            expect(messages[0]!.type).toBe('error');
        });

        it('returns undefined when no graph type is registered for version', () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                makeNumericVersionYaml(999)
            );

            const result = provider.resolveGraphType(doc as any);

            expect(result).toBeUndefined();
            const messages = window._getShownMessages();
            expect(messages.some(m => m.type === 'error' && m.message.includes('999'))).toBe(true);
        });

        it('returns undefined and shows error for YAML that parses to non-object', () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                '42'
            );

            const result = provider.resolveGraphType(doc as any);

            expect(result).toBeUndefined();
        });

        it('returns undefined when meta section is missing entirely', () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                'nodes:\n  a:\n    label: A\n'
            );

            const result = provider.resolveGraphType(doc as any);

            expect(result).toBeUndefined();
            const messages = window._getShownMessages();
            expect(messages.some(m => m.type === 'error')).toBe(true);
        });

        it('handles unparseable YAML gracefully', () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                ':\n  :\n invalid: [unclosed'
            );

            const result = provider.resolveGraphType(doc as any);

            expect(result).toBeUndefined();
            const messages = window._getShownMessages();
            expect(messages.some(m => m.type === 'error')).toBe(true);
        });
    });

    // ─── resolveCustomTextEditor ────────────────────────────

    describe('resolveCustomTextEditor', () => {
        it('calls updateWebview with initial document content', async () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                makeFlowchartYaml()
            );
            const panel = new MockWebviewPanel();
            const token = new CancellationTokenSource().token;

            await provider.resolveCustomTextEditor(doc as any, panel as any, token as any);

            // Engine should have been called with the initial content
            expect(engine.convertWithPrepare).toHaveBeenCalled();
            const call = (engine.convertWithPrepare as Mock).mock.calls[0]!;
            expect(call[0]).toContain('graph-version: 1');
        });

        it('sends updateAll message to webview after initial render', async () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                makeFlowchartYaml()
            );
            const panel = new MockWebviewPanel();
            const token = new CancellationTokenSource().token;

            await provider.resolveCustomTextEditor(doc as any, panel as any, token as any);

            const posted = panel.webview._getPostedMessages();
            const updateMsg = posted.find((m: any) => m.type === 'updateAll');
            expect(updateMsg).toBeDefined();
            expect(updateMsg.mermaidSource).toContain('flowchart TD');
        });

        it('does not call engine when resolveGraphType fails', async () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                'plain text not yaml'
            );
            const panel = new MockWebviewPanel();
            const token = new CancellationTokenSource().token;

            await provider.resolveCustomTextEditor(doc as any, panel as any, token as any);

            expect(engine.convertWithPrepare).not.toHaveBeenCalled();
        });

        it('cleans up change listener on panel dispose', async () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                makeFlowchartYaml()
            );
            const panel = new MockWebviewPanel();
            const token = new CancellationTokenSource().token;

            await provider.resolveCustomTextEditor(doc as any, panel as any, token as any);

            // Dispose the panel
            panel.dispose();

            // After dispose, document changes should NOT trigger additional engine calls
            const callCountBefore = (engine.convertWithPrepare as Mock).mock.calls.length;

            // Simulate a document change
            workspace._fireDidChangeTextDocument({
                document: doc,
                contentChanges: [],
            });

            // Wait for any potential debounce
            await new Promise(r => setTimeout(r, 100));

            // Should not have additional calls
            expect((engine.convertWithPrepare as Mock).mock.calls.length).toBe(callCountBefore);
        });
    });

    // ─── updateWebview ──────────────────────────────────────

    describe('updateWebview', () => {
        it('calls convertWithPrepare on engine', async () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                makeFlowchartYaml()
            );
            const panel = new MockWebviewPanel();
            const graphType = makeGraphType();

            // Create the webview manager by importing it
            const { WebviewManager } = await import('../src/webview-manager.js');
            const webview = new WebviewManager(panel as any, graphType);

            await provider.updateWebview(doc as any, graphType, webview);

            expect(engine.convertWithPrepare).toHaveBeenCalledWith(
                expect.stringContaining('graph-version: 1'),
                graphType,
                callbacks
            );
        });

        it('posts tree data even if YAML parse fails for tree builder', async () => {
            // Engine still works (it has its own parser), but tree building might fail
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                'not: valid: [yaml'
            );
            const panel = new MockWebviewPanel();
            const graphType = makeGraphType();

            const { WebviewManager } = await import('../src/webview-manager.js');
            const webview = new WebviewManager(panel as any, graphType);

            // Should not throw
            await provider.updateWebview(doc as any, graphType, webview);

            const posted = panel.webview._getPostedMessages();
            const updateMsg = posted.find((m: any) => m.type === 'updateAll');
            expect(updateMsg).toBeDefined();
            // treeData should be empty array when parse fails
            expect(updateMsg.treeData).toEqual([]);
        });
    });

    // ─── debounce behavior ──────────────────────────────────

    describe('debounce', () => {
        it('uses custom debounce when provided', async () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks, {
                debounceMs: 50,
            });
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                makeFlowchartYaml()
            );
            const panel = new MockWebviewPanel();
            const token = new CancellationTokenSource().token;

            await provider.resolveCustomTextEditor(doc as any, panel as any, token as any);

            const callsBefore = (engine.convertWithPrepare as Mock).mock.calls.length;

            // Fire a document change
            workspace._fireDidChangeTextDocument({
                document: { uri: doc.uri },
                contentChanges: [],
            });

            // Before debounce timeout, engine should not be called again
            expect((engine.convertWithPrepare as Mock).mock.calls.length).toBe(callsBefore);

            // Wait for debounce
            await new Promise(r => setTimeout(r, 100));

            // Now it should have been called
            expect((engine.convertWithPrepare as Mock).mock.calls.length).toBe(callsBefore + 1);
        });

        it('collapses rapid changes into single update', async () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks, {
                debounceMs: 50,
            });
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                makeFlowchartYaml()
            );
            const panel = new MockWebviewPanel();
            const token = new CancellationTokenSource().token;

            await provider.resolveCustomTextEditor(doc as any, panel as any, token as any);

            const callsBefore = (engine.convertWithPrepare as Mock).mock.calls.length;

            // Fire 5 rapid changes
            for (let i = 0; i < 5; i++) {
                workspace._fireDidChangeTextDocument({
                    document: { uri: doc.uri },
                    contentChanges: [],
                });
            }

            // Wait for debounce
            await new Promise(r => setTimeout(r, 100));

            // Should have collapsed into a single call
            expect((engine.convertWithPrepare as Mock).mock.calls.length).toBe(callsBefore + 1);
        });

        it('ignores changes to unrelated documents', async () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks, {
                debounceMs: 10,
            });
            const doc = new MockTextDocument(
                Uri.file('/project/test.flow.yaml'),
                makeFlowchartYaml()
            );
            const panel = new MockWebviewPanel();
            const token = new CancellationTokenSource().token;

            await provider.resolveCustomTextEditor(doc as any, panel as any, token as any);

            const callsBefore = (engine.convertWithPrepare as Mock).mock.calls.length;

            // Fire change for a DIFFERENT document
            const otherDoc = new MockTextDocument(
                Uri.file('/project/other.flow.yaml'),
                'different content'
            );
            workspace._fireDidChangeTextDocument({
                document: { uri: otherDoc.uri },
                contentChanges: [],
            });

            await new Promise(r => setTimeout(r, 50));

            // Should NOT have triggered another update
            expect((engine.convertWithPrepare as Mock).mock.calls.length).toBe(callsBefore);
        });
    });

    // ─── constructor options ────────────────────────────────

    describe('constructor options', () => {
        it('uses default tree builder when not provided', () => {
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);
            // Should not throw — defaults are used
            expect(provider).toBeDefined();
        });

        it('accepts custom tree builder and node editor', async () => {
            const { TreeDataBuilder } = await import('../src/tree-data-builder.js');
            const { NodeEditorController } = await import('../src/node-editor-controller.js');

            const treeBuilder = new TreeDataBuilder();
            const nodeEditor = new NodeEditorController();

            const provider = new YamlGraphEditorProvider(engine, registry, callbacks, {
                treeBuilder,
                nodeEditor,
            });
            expect(provider).toBeDefined();
        });
    });
});
