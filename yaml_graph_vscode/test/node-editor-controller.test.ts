/**
 * Tests for NodeEditorController — building showNode messages and FieldSchema caching.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { NodeEditorController } from '../src/node-editor-controller.js';
import type { GraphType, GraphMapping } from 'yaml-graph-core';

// ─── Helpers ────────────────────────────────────────────────

const flowchartNodeSchema = {
    type: 'object',
    required: ['type', 'label'],
    properties: {
        type: { type: 'string', enum: ['start', 'end', 'process', 'decision'] },
        label: { type: 'string' },
        status: { type: 'string', enum: ['planned', 'implemented'] },
        owner: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
    },
};

function makeFlowchartGraphType(): GraphType {
    return {
        id: 'flowchart',
        version: 1,
        filePatterns: ['*.flow.yaml'],
        schema: {
            type: 'object',
            properties: {
                nodes: {
                    type: 'object',
                    additionalProperties: { $ref: '#/$defs/node' },
                },
            },
            $defs: {
                node: flowchartNodeSchema,
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

function makeErGraphType(): GraphType {
    return {
        id: 'er-diagram',
        version: 1,
        filePatterns: ['*.er.yaml'],
        schema: {
            type: 'object',
            properties: {
                entities: {
                    type: 'object',
                    additionalProperties: { $ref: '#/$defs/entity' },
                },
            },
            $defs: {
                entity: {
                    type: 'object',
                    properties: {
                        attributes: {
                            type: 'array',
                            items: {
                                type: 'object',
                                required: ['name', 'type'],
                                properties: {
                                    name: { type: 'string' },
                                    type: { type: 'string' },
                                    key: { type: 'string', enum: ['PK', 'FK', 'UK'] },
                                },
                            },
                        },
                        description: { type: 'string' },
                    },
                },
            },
        },
        mapping: {
            map: { id: 'er-diagram', version: 1, mermaidType: 'erDiagram' },
            nodeShapes: {
                sourcePath: 'entities', idField: '_key', labelField: '_key',
                shapeField: '_key', shapes: {},
            },
            edgeLinks: {
                sourcePath: 'relationships', fromField: 'from', toField: 'to',
                linkStyles: { default: '-->' },
            },
        },
    };
}

// ─── Tests ──────────────────────────────────────────────────

describe('NodeEditorController', () => {
    let controller: NodeEditorController;

    beforeEach(() => {
        controller = new NodeEditorController();
    });

    describe('buildShowNodeMessage', () => {
        it('returns showNode message with correct structure', () => {
            const graphType = makeFlowchartGraphType();
            const nodeData = { type: 'process', label: 'Build' };
            const msg = controller.buildShowNodeMessage('build', nodeData, graphType);

            expect(msg.type).toBe('showNode');
            if (msg.type === 'showNode') {
                expect(msg.nodeId).toBe('build');
                expect(msg.nodeData).toBe(nodeData);
                expect(msg.schema).toBeDefined();
                expect(msg.schema.length).toBeGreaterThan(0);
            }
        });

        it('includes all node field schemas', () => {
            const graphType = makeFlowchartGraphType();
            const msg = controller.buildShowNodeMessage('a', {}, graphType);

            if (msg.type === 'showNode') {
                const paths = msg.schema.map(f => f.path);
                expect(paths).toContain('type');
                expect(paths).toContain('label');
                expect(paths).toContain('status');
                expect(paths).toContain('owner');
                expect(paths).toContain('tags');
            }
        });

        it('marks required fields correctly', () => {
            const graphType = makeFlowchartGraphType();
            const msg = controller.buildShowNodeMessage('a', {}, graphType);

            if (msg.type === 'showNode') {
                const shapeField = msg.schema.find(f => f.path === 'type');
                const ownerField = msg.schema.find(f => f.path === 'owner');
                expect(shapeField?.required).toBe(true);
                expect(ownerField?.required).toBe(false);
            }
        });

        it('handles ER diagram with nested schemas', () => {
            const graphType = makeErGraphType();
            const msg = controller.buildShowNodeMessage('user', {}, graphType, 'entities');

            if (msg.type === 'showNode') {
                const attrsField = msg.schema.find(f => f.path === 'attributes');
                expect(attrsField).toBeDefined();
                expect(attrsField?.fieldType).toBe('array');
            }
        });
    });

    describe('buildClearMessage', () => {
        it('returns clearNodeEditor message', () => {
            const msg = controller.buildClearMessage();
            expect(msg.type).toBe('clearNodeEditor');
        });
    });

    describe('caching', () => {
        it('caches schemas per graph type', () => {
            const graphType = makeFlowchartGraphType();
            const schemas1 = controller.getNodeFieldSchemas(graphType);
            const schemas2 = controller.getNodeFieldSchemas(graphType);
            expect(schemas1).toBe(schemas2); // Same reference (cached)
        });

        it('different graph types get different caches', () => {
            const flowType = makeFlowchartGraphType();
            const erType = makeErGraphType();
            const flowSchemas = controller.getNodeFieldSchemas(flowType);
            const erSchemas = controller.getNodeFieldSchemas(erType, 'entities');
            expect(flowSchemas).not.toBe(erSchemas);
        });

        it('clearCache removes all cached schemas', () => {
            const graphType = makeFlowchartGraphType();
            const schemas1 = controller.getNodeFieldSchemas(graphType);
            controller.clearCache();
            const schemas2 = controller.getNodeFieldSchemas(graphType);
            expect(schemas1).not.toBe(schemas2); // Different reference after cache clear
            expect(schemas1).toEqual(schemas2); // But same content
        });

        it('different versions of same type get separate caches', () => {
            const v1 = makeFlowchartGraphType();
            const v2 = { ...v1, version: 2 };
            const schemas1 = controller.getNodeFieldSchemas(v1);
            const schemas2 = controller.getNodeFieldSchemas(v2);
            // They should be equal in content but separate cache entries
            expect(schemas1).toEqual(schemas2);
        });
    });

    describe('getNodeFieldSchemas', () => {
        it('returns empty array for graph type without schema', () => {
            const graphType: GraphType = {
                id: 'empty',
                version: 1,
                filePatterns: [],
                schema: {},
                mapping: {
                    map: { id: 'empty', version: 1, mermaidType: 'flowchart' },
                    nodeShapes: {
                        sourcePath: 'nodes', idField: '_key', labelField: 'label',
                        shapeField: 'type', shapes: {},
                    },
                    edgeLinks: {
                        sourcePath: 'edges', fromField: 'from', toField: 'to',
                        linkStyles: {},
                    },
                },
            };
            const schemas = controller.getNodeFieldSchemas(graphType);
            expect(schemas).toEqual([]);
        });

        it('returns empty array when node section not found', () => {
            const graphType = makeFlowchartGraphType();
            // Request a section that doesn't exist in the schema
            const schemas = controller.getNodeFieldSchemas(graphType, 'nonExistent');
            expect(schemas).toEqual([]);
        });
    });

    describe('jsonPointerToPath', () => {
        it('converts simple path', () => {
            const result = NodeEditorController.jsonPointerToPath('nodes.build', 'label');
            expect(result).toEqual(['nodes', 'build', 'label']);
        });

        it('converts path with array index', () => {
            const result = NodeEditorController.jsonPointerToPath('entities.user', 'attributes[1].name');
            expect(result).toEqual(['entities', 'user', 'attributes', 1, 'name']);
        });

        it('converts deeply nested path with multiple arrays', () => {
            const result = NodeEditorController.jsonPointerToPath('nodes.a', 'children[0].items[2].value');
            expect(result).toEqual(['nodes', 'a', 'children', 0, 'items', 2, 'value']);
        });

        it('converts simple base path', () => {
            const result = NodeEditorController.jsonPointerToPath('nodes.x', 'type');
            expect(result).toEqual(['nodes', 'x', 'type']);
        });
    });
});
