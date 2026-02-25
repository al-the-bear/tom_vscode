/**
 * Tests for WebviewManager — webview HTML generation and message passing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WebviewManager } from '../src/webview-manager.js';
import { MockWebviewPanel } from 'vscode';
import type { GraphType } from 'yaml-graph-core';
import type { ExtensionMessage, WebviewMessage } from '../src/types.js';

// ─── Helpers ────────────────────────────────────────────────

function makeGraphType(id: string = 'flowchart', styleSheet?: string): GraphType {
    return {
        id,
        version: 1,
        filePatterns: ['*.flow.yaml'],
        schema: {},
        mapping: {
            map: { id, version: 1, mermaidType: 'flowchart' },
            nodeShapes: {
                sourcePath: 'nodes', idField: '_key', labelField: 'label',
                shapeField: 'type', shapes: {},
            },
            edgeLinks: {
                sourcePath: 'edges', fromField: 'from', toField: 'to',
                linkStyles: { default: '-->' },
            },
        },
        styleSheet,
    };
}

// ─── Tests ──────────────────────────────────────────────────

describe('WebviewManager', () => {
    let panel: MockWebviewPanel;
    let graphType: GraphType;

    beforeEach(() => {
        panel = new MockWebviewPanel();
        graphType = makeGraphType();
    });

    describe('constructor', () => {
        it('sets initial HTML on the webview', () => {
            new WebviewManager(panel as any, graphType);
            expect(panel.webview.html).toBeTruthy();
            expect(panel.webview.html.length).toBeGreaterThan(100);
        });

        it('sets up message listener on webview', () => {
            const received: WebviewMessage[] = [];
            const manager = new WebviewManager(panel as any, graphType);
            manager.onMessage(msg => received.push(msg));

            panel.webview._simulateMessage({ type: 'nodeClicked', nodeId: 'test' });

            expect(received).toHaveLength(1);
            expect(received[0]!.type).toBe('nodeClicked');
        });
    });

    describe('generateHtml', () => {
        it('contains required DOM elements', () => {
            const manager = new WebviewManager(panel as any, graphType);
            const html = manager.generateHtml();

            expect(html).toContain('id="tree-container"');
            expect(html).toContain('id="preview-container"');
            expect(html).toContain('id="node-editor"');
            expect(html).toContain('id="status-bar"');
            expect(html).toContain('id="mermaid-output"');
        });

        it('includes Content Security Policy', () => {
            const manager = new WebviewManager(panel as any, graphType);
            const html = manager.generateHtml();
            expect(html).toContain('Content-Security-Policy');
            expect(html).toContain('nonce-');
        });

        it('includes graph type ID in title', () => {
            const manager = new WebviewManager(panel as any, graphType);
            const html = manager.generateHtml();
            expect(html).toContain('flowchart Editor');
        });

        it('includes graph type stylesheet when provided', () => {
            const cssGraphType = makeGraphType('styled', '.node { fill: red; }');
            const manager = new WebviewManager(panel as any, cssGraphType);
            const html = manager.generateHtml();
            expect(html).toContain('.node { fill: red; }');
        });

        it('includes base CSS when provided', () => {
            const manager = new WebviewManager(panel as any, graphType, {
                baseCss: '.custom { display: block; }',
            });
            const html = manager.generateHtml();
            expect(html).toContain('.custom { display: block; }');
        });

        it('includes script with acquireVsCodeApi', () => {
            const manager = new WebviewManager(panel as any, graphType);
            const html = manager.generateHtml();
            expect(html).toContain('acquireVsCodeApi');
        });

        it('escapes HTML special characters in title', () => {
            const xssGraphType = makeGraphType('<script>alert("xss")</script>');
            const manager = new WebviewManager(panel as any, xssGraphType);
            const html = manager.generateHtml();
            expect(html).not.toContain('<script>alert("xss")</script> Editor');
            expect(html).toContain('&lt;script&gt;');
        });
    });

    describe('postMessage', () => {
        it('sends message to webview', () => {
            const manager = new WebviewManager(panel as any, graphType);
            const msg: ExtensionMessage = { type: 'selectNode', nodeId: 'test' };
            manager.postMessage(msg);

            const posted = panel.webview._getPostedMessages();
            expect(posted).toHaveLength(1);
            expect(posted[0]).toEqual(msg);
        });

        it('sends multiple messages', () => {
            const manager = new WebviewManager(panel as any, graphType);
            manager.postMessage({ type: 'selectNode', nodeId: 'a' });
            manager.postMessage({ type: 'highlightMermaidNode', nodeId: 'b' });
            manager.postMessage({ type: 'clearNodeEditor' });

            const posted = panel.webview._getPostedMessages();
            expect(posted).toHaveLength(3);
        });
    });

    describe('update', () => {
        it('sends updateAll message with all data', () => {
            const manager = new WebviewManager(panel as any, graphType);
            manager.update(
                'yaml: content',
                'flowchart TD\n  A --> B',
                [{ id: 'a', label: 'A', type: 'process', icon: 'symbol-method' }],
                [{ message: 'Missing field', path: '/nodes/a' }]
            );

            const posted = panel.webview._getPostedMessages();
            const updateMsg = posted.find((m: any) => m.type === 'updateAll');
            expect(updateMsg).toBeDefined();
            expect(updateMsg.yamlText).toBe('yaml: content');
            expect(updateMsg.mermaidSource).toContain('flowchart TD');
            expect(updateMsg.treeData).toHaveLength(1);
            expect(updateMsg.errors).toHaveLength(1);
        });
    });

    describe('selectTreeNode', () => {
        it('posts selectNode message', () => {
            const manager = new WebviewManager(panel as any, graphType);
            manager.selectTreeNode('myNode');

            const posted = panel.webview._getPostedMessages();
            expect(posted).toContainEqual({ type: 'selectNode', nodeId: 'myNode' });
        });
    });

    describe('highlightMermaidNode', () => {
        it('posts highlightMermaidNode message', () => {
            const manager = new WebviewManager(panel as any, graphType);
            manager.highlightMermaidNode('myNode');

            const posted = panel.webview._getPostedMessages();
            expect(posted).toContainEqual({ type: 'highlightMermaidNode', nodeId: 'myNode' });
        });
    });

    describe('onMessage', () => {
        it('receives webcview messages via handler', () => {
            const received: WebviewMessage[] = [];
            const manager = new WebviewManager(panel as any, graphType);
            manager.onMessage(msg => received.push(msg));

            panel.webview._simulateMessage({ type: 'treeNodeSelected', nodeId: 'x' });
            panel.webview._simulateMessage({ type: 'requestExportSvg' });

            expect(received).toHaveLength(2);
        });

        it('replaces previous handler', () => {
            const first: WebviewMessage[] = [];
            const second: WebviewMessage[] = [];
            const manager = new WebviewManager(panel as any, graphType);

            manager.onMessage(msg => first.push(msg));
            manager.onMessage(msg => second.push(msg));

            panel.webview._simulateMessage({ type: 'nodeClicked', nodeId: 'a' });

            // Only second handler should receive (handler is replaced)
            expect(second).toHaveLength(1);
            expect(first).toHaveLength(0);
        });
    });

    describe('getPanel', () => {
        it('returns the underlying panel', () => {
            const manager = new WebviewManager(panel as any, graphType);
            expect(manager.getPanel()).toBe(panel);
        });
    });
});
