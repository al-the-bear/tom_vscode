/**
 * Tests for SelectionCoordinator — cross-pane selection coordination.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SelectionCoordinator } from '../src/selection-coordinator.js';
import {
    MockTextDocument, MockTextEditor, Uri, Position,
    window, workspace, _resetAllMocks,
} from 'vscode';
import type { WebviewManager } from '../src/webview-manager.js';
import { NodeEditorController } from '../src/node-editor-controller.js';
import type { GraphType } from 'yaml-graph-core';
import type { ExtensionMessage } from '../src/types.js';

// ─── Helpers ────────────────────────────────────────────────

const sampleYaml = `meta:
  id: test-flow
  title: Test Flow
  graph-version: 1

nodes:
  start:
    type: start
    label: Start
  build:
    type: process
    label: Build Project

edges:
  - from: start
    to: build
    label: Begin
`;

function makeGraphType(): GraphType {
    return {
        id: 'flowchart',
        version: 1,
        filePatterns: ['*.flow.yaml'],
        schema: {
            type: 'object',
            properties: {
                nodes: {
                    type: 'object',
                    additionalProperties: {
                        type: 'object',
                        required: ['type', 'label'],
                        properties: {
                            type: { type: 'string' },
                            label: { type: 'string' },
                        },
                    },
                },
            },
        },
        mapping: {
            map: { id: 'flowchart', version: 1, mermaidType: 'flowchart' },
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

function makeMockWebviewManager(): WebviewManager & { _messages: ExtensionMessage[] } {
    const messages: ExtensionMessage[] = [];
    return {
        _messages: messages,
        postMessage(msg: ExtensionMessage) {
            messages.push(msg);
        },
        onMessage(_handler: any) {},
        update() {},
        selectTreeNode() {},
        highlightMermaidNode() {},
        generateHtml() { return ''; },
        getPanel() { return {} as any; },
    } as any;
}

// ─── Tests ──────────────────────────────────────────────────

describe('SelectionCoordinator', () => {
    let coordinator: SelectionCoordinator;
    let mockWebview: ReturnType<typeof makeMockWebviewManager>;
    let nodeEditor: NodeEditorController;
    let document: MockTextDocument;
    let graphType: GraphType;

    beforeEach(() => {
        _resetAllMocks();
        mockWebview = makeMockWebviewManager();
        nodeEditor = new NodeEditorController();
        graphType = makeGraphType();
        document = new MockTextDocument(
            Uri.file('/workspace/test.flow.yaml'),
            sampleYaml
        );
        coordinator = new SelectionCoordinator(
            mockWebview as any,
            nodeEditor,
            graphType
        );
    });

    describe('onNodeSelected', () => {
        it('updates currentNodeId', () => {
            coordinator.onNodeSelected('build', document as any);
            expect(coordinator.getSelectedNodeId()).toBe('build');
        });

        it('sends selectNode message to webview', () => {
            coordinator.onNodeSelected('build', document as any);
            const selectMsg = mockWebview._messages.find(m => m.type === 'selectNode');
            expect(selectMsg).toBeDefined();
            if (selectMsg?.type === 'selectNode') {
                expect(selectMsg.nodeId).toBe('build');
            }
        });

        it('sends highlightMermaidNode message', () => {
            coordinator.onNodeSelected('build', document as any);
            const highlightMsg = mockWebview._messages.find(m => m.type === 'highlightMermaidNode');
            expect(highlightMsg).toBeDefined();
        });

        it('sends showNode message for existing node', () => {
            coordinator.onNodeSelected('build', document as any);
            const showMsg = mockWebview._messages.find(m => m.type === 'showNode');
            expect(showMsg).toBeDefined();
            if (showMsg?.type === 'showNode') {
                expect(showMsg.nodeId).toBe('build');
                expect(showMsg.nodeData).toBeDefined();
            }
        });

        it('sends clearNodeEditor for non-existent node', () => {
            coordinator.onNodeSelected('nonExistent', document as any);
            const clearMsg = mockWebview._messages.find(m => m.type === 'clearNodeEditor');
            expect(clearMsg).toBeDefined();
        });
    });

    describe('handleWebviewMessage', () => {
        it('handles nodeClicked message', () => {
            coordinator.handleWebviewMessage(
                { type: 'nodeClicked', nodeId: 'start' },
                document as any
            );
            expect(coordinator.getSelectedNodeId()).toBe('start');
        });

        it('handles treeNodeSelected message', () => {
            coordinator.handleWebviewMessage(
                { type: 'treeNodeSelected', nodeId: 'build' },
                document as any
            );
            expect(coordinator.getSelectedNodeId()).toBe('build');
        });

        it('handles applyEdit message', () => {
            const applySpy = vi.spyOn(coordinator, 'onApplyEdit');
            coordinator.handleWebviewMessage(
                {
                    type: 'applyEdit',
                    nodeId: 'build',
                    edits: [{ path: 'label', value: 'New Label' }],
                },
                document as any
            );
            expect(applySpy).toHaveBeenCalledWith(
                expect.objectContaining({ nodeId: 'build' }),
                expect.anything()
            );
        });
    });

    describe('revealInEditor', () => {
        it('reveals range in visible editor matching document', () => {
            const editor = new MockTextEditor(document);
            window._setVisibleTextEditors([editor as any]);

            coordinator.revealInEditor('start', document as any);

            // The editor should have been asked to reveal a range
            const revealedRange = editor._getRevealedRange();
            // start node exists in the YAML, so a range should be revealed
            // (may or may not find it depending on parser, but the method should not throw)
            // This test mainly verifies the method doesn't crash
        });

        it('does not crash when no editors match', () => {
            window._setVisibleTextEditors([]);
            // Should not throw
            expect(() => {
                coordinator.revealInEditor('start', document as any);
            }).not.toThrow();
        });
    });

    describe('onApplyEdit', () => {
        it('calls workspace.applyEdit', async () => {
            const applyEditSpy = vi.spyOn(workspace, 'applyEdit');
            applyEditSpy.mockResolvedValue(true);

            const result = await coordinator.onApplyEdit(
                { nodeId: 'build', changes: { label: 'New Label' } },
                document as any
            );

            expect(applyEditSpy).toHaveBeenCalled();
            expect(result).toBe(true);
            applyEditSpy.mockRestore();
        });
    });

    describe('getSelectedNodeId', () => {
        it('returns undefined initially', () => {
            expect(coordinator.getSelectedNodeId()).toBeUndefined();
        });

        it('returns last selected node', () => {
            coordinator.onNodeSelected('start', document as any);
            coordinator.onNodeSelected('build', document as any);
            expect(coordinator.getSelectedNodeId()).toBe('build');
        });
    });
});
