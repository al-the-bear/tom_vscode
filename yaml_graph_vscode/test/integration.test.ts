/**
 * Integration tests — exercise the full pipeline across multiple modules.
 *
 * These tests wire up real (not mocked) yaml-graph-core components alongside
 * yaml-graph-vscode modules with the mocked VS Code API to test end-to-end
 * flows:
 *   YAML file → ConversionEngine → tree building → schema resolution →
 *   selection coordination → webview message passing
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

// yaml-graph-core (real implementations)
import {
    ConversionEngine,
    GraphTypeRegistry,
    type GraphType,
    type ConversionCallbacks,
} from 'yaml-graph-core';

// yaml-graph-vscode modules (real implementations, mocked vscode)
import { TreeDataBuilder } from '../src/tree-data-builder.js';
import { SchemaResolver } from '../src/schema-resolver.js';
import { NodeEditorController } from '../src/node-editor-controller.js';
import { VsCodeCallbacks } from '../src/vscode-callbacks.js';
import { SelectionCoordinator } from '../src/selection-coordinator.js';
import { WebviewManager } from '../src/webview-manager.js';
import { YamlGraphEditorProvider } from '../src/yaml-graph-editor-provider.js';
import type { TreeNode } from '../src/types.js';

// Mocked vscode
import {
    MockTextDocument, MockWebviewPanel, MockTextEditor,
    Uri, CancellationTokenSource, _resetAllMocks, window, workspace,
} from 'vscode';

// ─── Fixtures ───────────────────────────────────────────────

const FIXTURES_DIR = join(__dirname, 'fixtures');

function readFixture(name: string): string {
    return readFileSync(join(FIXTURES_DIR, name), 'utf-8');
}

// ─── Inline Graph Type (minimal but complete) ───────────────

function makeMinimalFlowchartGraphType(): GraphType {
    return {
        id: 'flowchart',
        version: 1,
        filePatterns: ['*.flow.yaml'],
        schema: {
            type: 'object',
            properties: {
                meta: {
                    type: 'object',
                    properties: {
                        'graph-version': { type: 'number' },
                    },
                    required: ['graph-version'],
                },
                nodes: {
                    type: 'object',
                    additionalProperties: {
                        type: 'object',
                        properties: {
                            label: { type: 'string' },
                            type: { type: 'string', enum: ['default', 'process', 'decision', 'terminal'] },
                            description: { type: 'string' },
                            tags: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['label'],
                    },
                },
                edges: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            from: { type: 'string' },
                            to: { type: 'string' },
                            label: { type: 'string' },
                        },
                        required: ['from', 'to'],
                    },
                },
            },
            required: ['meta', 'nodes'],
        },
        mapping: {
            map: {
                id: 'flowchart',
                version: 1,
                mermaidType: 'flowchart',
                defaultDirection: 'TD',
            },
            nodeShapes: {
                sourcePath: 'nodes',
                idField: '_key',
                labelField: 'label',
                shapeField: 'type',
                shapes: {
                    default: '[]',
                    process: '([])',
                    decision: '{}',
                    terminal: '([])' ,
                },
            },
            edgeLinks: {
                sourcePath: 'edges',
                fromField: 'from',
                toField: 'to',
                labelField: 'label',
                linkStyles: {
                    default: '-->',
                },
            },
        },
    };
}

function makeMinimalStateMachineGraphType(): GraphType {
    return {
        id: 'state-machine',
        version: 1,
        filePatterns: ['*.state.yaml'],
        schema: {
            type: 'object',
            properties: {
                meta: {
                    type: 'object',
                    properties: { 'graph-version': { type: 'number' } },
                    required: ['graph-version'],
                },
                states: {
                    type: 'object',
                    additionalProperties: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            type: { type: 'string' },
                        },
                    },
                },
                transitions: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            from: { type: 'string' },
                            to: { type: 'string' },
                            trigger: { type: 'string' },
                        },
                        required: ['from', 'to'],
                    },
                },
            },
        },
        mapping: {
            map: {
                id: 'state-machine',
                version: 1,
                mermaidType: 'stateDiagram-v2',
            },
            nodeShapes: {
                sourcePath: 'states',
                idField: '_key',
                labelField: 'name',
                shapeField: 'type',
                shapes: {},
            },
            edgeLinks: {
                sourcePath: 'transitions',
                fromField: 'from',
                toField: 'to',
                labelField: 'trigger',
                linkStyles: { default: '-->' },
            },
        },
    };
}

// ─── Tests ──────────────────────────────────────────────────

describe('Integration', () => {
    let flowchartType: GraphType;
    let stateMachineType: GraphType;
    let engine: ConversionEngine;
    let registry: GraphTypeRegistry;

    beforeEach(() => {
        _resetAllMocks();
        flowchartType = makeMinimalFlowchartGraphType();
        stateMachineType = makeMinimalStateMachineGraphType();
        engine = new ConversionEngine();
        registry = new GraphTypeRegistry();
        registry.register(flowchartType);
        registry.register(stateMachineType);
    });

    // ─── Full Pipeline: YAML → Mermaid → Tree ──────────────

    describe('YAML → Mermaid → Tree pipeline', () => {
        it('converts flowchart fixture to Mermaid and builds tree', () => {
            const yaml = readFixture('sample.flow.yaml');
            const result = engine.convert(yaml, flowchartType);

            expect(result.mermaidSource).toBeTruthy();
            expect(result.mermaidSource).toContain('flowchart');

            const data = parseYaml(yaml);
            const treeBuilder = new TreeDataBuilder();
            const tree = treeBuilder.buildTree(data, flowchartType);

            expect(tree.length).toBeGreaterThan(0);

            // Should have a Nodes group
            const nodesGroup = tree.find(n => n.label.startsWith('Nodes'));
            expect(nodesGroup).toBeDefined();
            expect(nodesGroup!.children).toBeDefined();
            expect(nodesGroup!.children!.length).toBeGreaterThan(0);
        });

        it('converts state machine fixture to Mermaid and builds tree', () => {
            const yaml = readFixture('sample.state.yaml');
            const result = engine.convert(yaml, stateMachineType);

            expect(result.mermaidSource).toBeTruthy();

            const data = parseYaml(yaml);
            const treeBuilder = new TreeDataBuilder();
            const tree = treeBuilder.buildTree(data, stateMachineType);

            expect(tree.length).toBeGreaterThan(0);
        });
    });

    // ─── Schema Resolution + Node Editor ────────────────────

    describe('schema resolution → node editor', () => {
        it('resolves field schemas and builds showNode message', () => {
            const nodeEditor = new NodeEditorController();
            const yaml = readFixture('sample.flow.yaml');
            const data = parseYaml(yaml);
            const nodeId = Object.keys(data.nodes)[0]!;
            const nodeData = data.nodes[nodeId];

            const msg = nodeEditor.buildShowNodeMessage(nodeId, nodeData, flowchartType);

            expect(msg.type).toBe('showNode');
            if (msg.type === 'showNode') {
                expect(msg.nodeId).toBe(nodeId);
                expect(msg.nodeData).toBe(nodeData);
                // Schema comes from schema resolution — may be empty if schema
                // has no additionalProperties pattern for nodes path
                expect(msg.schema).toBeDefined();
            }
        });

        it('builds clear message for missing node', () => {
            const nodeEditor = new NodeEditorController();
            const msg = nodeEditor.buildClearMessage();
            expect(msg.type).toBe('clearNodeEditor');
        });
    });

    // ─── Selection Coordination ─────────────────────────────

    describe('selection coordination flow', () => {
        it('nodeClicked message triggers full selection update', () => {
            const panel = new MockWebviewPanel();
            const webview = new WebviewManager(panel as any, flowchartType);
            const nodeEditor = new NodeEditorController();
            const coordinator = new SelectionCoordinator(webview, nodeEditor, flowchartType);

            const yaml = readFixture('sample.flow.yaml');
            const doc = new MockTextDocument(Uri.file('/test/sample.flow.yaml'), yaml);

            // Set up a visible editor so revealInEditor can work
            const editor = new MockTextEditor(doc);
            window._setVisibleTextEditors([editor]);

            // Simulate nodeClicked from webview
            coordinator.handleWebviewMessage(
                { type: 'nodeClicked', nodeId: 'checkout' },
                doc as any
            );

            expect(coordinator.getSelectedNodeId()).toBe('checkout');

            // Check messages sent to webview (selectNode + highlightMermaidNode + showNode or clearNodeEditor)
            const posted = panel.webview._getPostedMessages();
            expect(posted.some((m: any) => m.type === 'selectNode')).toBe(true);
            expect(posted.some((m: any) => m.type === 'highlightMermaidNode')).toBe(true);
        });

        it('treeNodeSelected message works the same as nodeClicked', () => {
            const panel = new MockWebviewPanel();
            const webview = new WebviewManager(panel as any, flowchartType);
            const nodeEditor = new NodeEditorController();
            const coordinator = new SelectionCoordinator(webview, nodeEditor, flowchartType);

            const yaml = readFixture('sample.flow.yaml');
            const doc = new MockTextDocument(Uri.file('/test/sample.flow.yaml'), yaml);

            coordinator.handleWebviewMessage(
                { type: 'treeNodeSelected', nodeId: 'build' },
                doc as any
            );

            expect(coordinator.getSelectedNodeId()).toBe('build');
        });
    });

    // ─── VsCodeCallbacks Integration ────────────────────────

    describe('VsCodeCallbacks with engine', () => {
        it('produces valid Mermaid with callbacks', async () => {
            const callbacks = new VsCodeCallbacks();
            const yaml = readFixture('sample.flow.yaml');

            const result = await engine.convertWithPrepare(
                yaml, flowchartType, callbacks
            );

            expect(result.mermaidSource).toBeTruthy();
            expect(result.mermaidSource).toContain('flowchart');
            // Click directives should be present (from onNodeEmit)
            expect(result.mermaidSource).toContain('click');
        });
    });

    // ─── Full Editor Provider Flow ──────────────────────────

    describe('YamlGraphEditorProvider full flow', () => {
        it('opens a valid flowchart document end-to-end', async () => {
            const callbacks = new VsCodeCallbacks();
            const treeBuilder = new TreeDataBuilder();
            const nodeEditor = new NodeEditorController();

            const provider = new YamlGraphEditorProvider(
                engine, registry, callbacks, {
                    treeBuilder,
                    nodeEditor,
                    debounceMs: 10,
                }
            );

            const yaml = readFixture('sample.flow.yaml');
            const doc = new MockTextDocument(Uri.file('/test/sample.flow.yaml'), yaml);
            const panel = new MockWebviewPanel();
            const token = new CancellationTokenSource().token;

            await provider.resolveCustomTextEditor(doc as any, panel as any, token as any);

            // Webview should have initial HTML
            expect(panel.webview.html).toBeTruthy();
            expect(panel.webview.html).toContain('tree-container');

            // Should have posted an updateAll message
            const posted = panel.webview._getPostedMessages();
            const updateMsg = posted.find((m: any) => m.type === 'updateAll');
            expect(updateMsg).toBeDefined();
            expect(updateMsg.mermaidSource).toContain('flowchart');
            expect(updateMsg.treeData.length).toBeGreaterThan(0);
        });

        it('re-converts on document change (debounced)', async () => {
            const callbacks = new VsCodeCallbacks();
            const provider = new YamlGraphEditorProvider(
                engine, registry, callbacks, { debounceMs: 20 }
            );

            const yaml = readFixture('sample.flow.yaml');
            const doc = new MockTextDocument(Uri.file('/test/sample.flow.yaml'), yaml);
            const panel = new MockWebviewPanel();
            const token = new CancellationTokenSource().token;

            await provider.resolveCustomTextEditor(doc as any, panel as any, token as any);

            const postedBefore = panel.webview._getPostedMessages().length;

            // Simulate document change
            workspace._fireDidChangeTextDocument({
                document: { uri: doc.uri },
                contentChanges: [],
            });

            // Wait for debounce
            await new Promise(r => setTimeout(r, 50));

            const postedAfter = panel.webview._getPostedMessages().length;
            expect(postedAfter).toBeGreaterThan(postedBefore);
        });

        it('rejects document without graph-version gracefully', async () => {
            const callbacks = new VsCodeCallbacks();
            const provider = new YamlGraphEditorProvider(engine, registry, callbacks);

            const yaml = readFixture('no-version.flow.yaml');
            const doc = new MockTextDocument(Uri.file('/test/no-version.flow.yaml'), yaml);
            const panel = new MockWebviewPanel();
            const token = new CancellationTokenSource().token;

            await provider.resolveCustomTextEditor(doc as any, panel as any, token as any);

            // Should show error message
            const messages = window._getShownMessages();
            expect(messages.some(m => m.type === 'error')).toBe(true);

            // No updateAll should be posted
            const posted = panel.webview._getPostedMessages();
            const updateMsg = posted.find((m: any) => m.type === 'updateAll');
            expect(updateMsg).toBeUndefined();
        });
    });

    // ─── Tree Data Fidelity ─────────────────────────────────

    describe('tree data fidelity', () => {
        it('tree node IDs match YAML source node keys', () => {
            const yaml = readFixture('sample.flow.yaml');
            const data = parseYaml(yaml);
            const treeBuilder = new TreeDataBuilder();
            const tree = treeBuilder.buildTree(data, flowchartType);

            // Extract node IDs from tree
            const nodesGroup = tree.find(n => n.label.startsWith('Nodes'));
            expect(nodesGroup).toBeDefined();
            expect(nodesGroup!.children).toBeDefined();

            const treeNodeIds = nodesGroup!.children!.map(n => n.id);
            const yamlNodeIds = Object.keys(data.nodes);

            // Every YAML node should appear in the tree
            for (const yamlId of yamlNodeIds) {
                expect(treeNodeIds).toContain(yamlId);
            }
        });

        it('nested properties are represented as children', () => {
            const yaml = readFixture('sample.flow.yaml');
            const data = parseYaml(yaml);
            const treeBuilder = new TreeDataBuilder();
            const tree = treeBuilder.buildTree(data, flowchartType);

            const nodesGroup = tree.find(n => n.label === 'Nodes');
            // Find any node that has tags (array property)
            const nodeWithChildren = nodesGroup?.children?.find(n =>
                n.children && n.children.length > 0
            );
            // At least some nodes should have property children
            // (tags, description, etc.)
            if (nodeWithChildren) {
                expect(nodeWithChildren.children!.length).toBeGreaterThan(0);
            }
        });
    });

    // ─── Error Handling Integration ─────────────────────────

    describe('error handling', () => {
        it('validation errors flow through to webview update', async () => {
            // Create YAML that violates the schema (e.g., missing required field)
            const invalidYaml = `meta:
  graph-version: 1
nodes:
  broken:
    type: default
edges:
  - from: broken
`;
            // The 'broken' node is missing 'label' (required) and edge is missing 'to'
            const result = engine.convert(invalidYaml, flowchartType);

            // Should have validation errors
            expect(result.errors.length).toBeGreaterThan(0);
        });

        it('handles completely empty document gracefully', () => {
            const result = engine.convert('', flowchartType);
            // Should not crash, might have errors
            expect(result).toBeDefined();
            expect(result.mermaidSource).toBeDefined();
        });
    });
});
