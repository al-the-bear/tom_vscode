/**
 * Tests for VsCodeCallbacks — VS Code-specific ConversionCallbacks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VsCodeCallbacks } from '../src/vscode-callbacks.js';
import { workspace, Uri } from 'vscode';
import type { NodeData, EdgeData } from 'yaml-graph-core';

describe('VsCodeCallbacks', () => {
    let callbacks: VsCodeCallbacks;

    beforeEach(() => {
        callbacks = new VsCodeCallbacks();
    });

    describe('prepare', () => {
        it('calls workspace.findFiles with correct glob', async () => {
            const findFilesSpy = vi.spyOn(workspace, 'findFiles');
            findFilesSpy.mockResolvedValue([
                Uri.file('/workspace/diagram.flow.yaml'),
                Uri.file('/workspace/order.state.yaml'),
            ]);

            await callbacks.prepare();

            expect(findFilesSpy).toHaveBeenCalledWith('**/*.{flow,state,er}.yaml');
            findFilesSpy.mockRestore();
        });

        it('populates existingGraphFiles set', async () => {
            const findFilesSpy = vi.spyOn(workspace, 'findFiles');
            findFilesSpy.mockResolvedValue([
                Uri.file('/workspace/diagram.flow.yaml'),
                Uri.file('/workspace/schemas/order.state.yaml'),
            ]);

            await callbacks.prepare();

            const files = callbacks.getExistingGraphFiles();
            expect(files.size).toBe(2);
            findFilesSpy.mockRestore();
        });

        it('handles empty workspace gracefully', async () => {
            const findFilesSpy = vi.spyOn(workspace, 'findFiles');
            findFilesSpy.mockResolvedValue([]);

            await callbacks.prepare();

            const files = callbacks.getExistingGraphFiles();
            expect(files.size).toBe(0);
            findFilesSpy.mockRestore();
        });
    });

    describe('onNodeEmit', () => {
        beforeEach(() => {
            callbacks.setMermaidType('flowchart'); // Enable click callbacks
        });

        it('returns click callback directive', () => {
            const nodeData: NodeData = {
                id: 'build',
                shape: 'rectangle',
                type: 'process',
                fields: { label: 'Build Project' },
            };
            const result = callbacks.onNodeEmit('build', nodeData, ['build["Build Project"]']);
            expect(result).toEqual(['click build callback "build"']);
        });

        it('includes nodeId in click callback', () => {
            const nodeData: NodeData = {
                id: 'start',
                shape: 'stadium',
                type: 'start',
                fields: {},
            };
            const result = callbacks.onNodeEmit('start', nodeData, []);
            expect(result[0]).toContain('start');
            expect(result[0]).toContain('callback');
        });

        it('handles special characters in nodeId', () => {
            const nodeData: NodeData = {
                id: 'node-with-dashes',
                shape: 'rectangle',
                type: 'process',
                fields: {},
            };
            const result = callbacks.onNodeEmit('node-with-dashes', nodeData, []);
            expect(result).toEqual(['click node-with-dashes callback "node-with-dashes"']);
        });
    });

    describe('onEdgeEmit', () => {
        it('returns empty array', () => {
            const edgeData: EdgeData = {
                from: 'a',
                to: 'b',
                fields: { label: 'next' },
            };
            const result = callbacks.onEdgeEmit(edgeData, ['a --> b']);
            expect(result).toEqual([]);
        });
    });

    describe('onComplete', () => {
        it('returns empty array', () => {
            const result = callbacks.onComplete(['a', 'b', 'c'], ['flowchart TD']);
            expect(result).toEqual([]);
        });
    });
});
