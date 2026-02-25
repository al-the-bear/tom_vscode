import { describe, it, expect, vi } from 'vitest';
import { AstNodeTransformerRuntime } from '../src/ast-node-transformer.js';
import type { NodeData, EdgeData, TransformContext, GraphMapping } from '../src/types.js';

describe('AstNodeTransformerRuntime', () => {
    const runtime = new AstNodeTransformerRuntime();

    function makeMapping(): GraphMapping {
        return {
            map: { id: 'test', version: 1, mermaidType: 'flowchart' },
            nodeShapes: {
                sourcePath: 'nodes', idField: '_key', labelField: 'label',
                typeField: 'type', shapes: {}
            },
            edgeLinks: {
                sourcePath: 'edges', fromField: 'from', toField: 'to',
                linkStyles: {}
            }
        };
    }

    function makeNodeContext(
        node: NodeData,
        output: string[] = []
    ): TransformContext {
        return {
            allNodes: new Map([[node.id, node]]),
            allEdges: [],
            mapping: makeMapping(),
            output
        };
    }

    function makeEdgeContext(
        edge: EdgeData,
        output: string[] = []
    ): TransformContext {
        return {
            allNodes: new Map(),
            allEdges: [edge],
            mapping: makeMapping(),
            output
        };
    }

    // ================================================================
    // Basic execution
    // ================================================================
    describe('basic execution', () => {
        it('should execute a simple JS fragment returning string[]', () => {
            const node: NodeData = { id: 'a', type: 'process', fields: { label: 'A' } };
            const ctx = makeNodeContext(node, ['default line']);

            const result = runtime.execute(
                'return [`${node.id}["Custom: ${node.fields.label}"]`]',
                node,
                ctx
            );

            expect(result).toEqual(['a["Custom: A"]']);
        });

        it('should provide node parameter for node elements', () => {
            const node: NodeData = { id: 'test', type: 'process', fields: { label: 'Test' } };
            const ctx = makeNodeContext(node);

            const result = runtime.execute(
                'return [node.id + " is " + node.type]',
                node,
                ctx
            );

            expect(result).toEqual(['test is process']);
        });

        it('should provide edge parameter for edge elements', () => {
            const edge: EdgeData = { from: 'A', to: 'B', fields: { label: 'link' } };
            const ctx = makeEdgeContext(edge);

            const result = runtime.execute(
                'return [`${edge.from} --> ${edge.to}`]',
                edge,
                ctx
            );

            expect(result).toEqual(['A --> B']);
        });

        it('should provide ctx (context) parameter', () => {
            const node: NodeData = { id: 'a', type: 'process', fields: {} };
            const ctx = makeNodeContext(node, ['existing line']);

            const result = runtime.execute(
                'return [...ctx.output, "new line"]',
                node,
                ctx
            );

            expect(result).toEqual(['existing line', 'new line']);
        });
    });

    // ================================================================
    // Context access
    // ================================================================
    describe('context access', () => {
        it('should access allNodes from context', () => {
            const node: NodeData = { id: 'a', type: 'process', fields: { label: 'A' } };
            const ctx: TransformContext = {
                allNodes: new Map([
                    ['a', node],
                    ['b', { id: 'b', type: 'end', fields: { label: 'B' } }]
                ]),
                allEdges: [],
                mapping: makeMapping(),
                output: []
            };

            const result = runtime.execute(
                'return [`nodes: ${ctx.allNodes.size}`]',
                node,
                ctx
            );

            expect(result).toEqual(['nodes: 2']);
        });

        it('should access allEdges from context', () => {
            const edge: EdgeData = { from: 'A', to: 'B', fields: {} };
            const ctx: TransformContext = {
                allNodes: new Map(),
                allEdges: [edge, { from: 'B', to: 'C', fields: {} }],
                mapping: makeMapping(),
                output: []
            };

            const result = runtime.execute(
                'return [`edges: ${ctx.allEdges.length}`]',
                edge,
                ctx
            );

            expect(result).toEqual(['edges: 2']);
        });

        it('should access mapping from context', () => {
            const node: NodeData = { id: 'a', type: 'process', fields: {} };
            const ctx = makeNodeContext(node);

            const result = runtime.execute(
                'return [`type: ${ctx.mapping.map.mermaidType}`]',
                node,
                ctx
            );

            expect(result).toEqual(['type: flowchart']);
        });
    });

    // ================================================================
    // Error handling
    // ================================================================
    describe('error handling', () => {
        it('should return context.output on runtime error', () => {
            const node: NodeData = { id: 'a', type: 'process', fields: {} };
            const ctx = makeNodeContext(node, ['fallback']);

            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const result = runtime.execute(
                'throw new Error("intentional error")',
                node,
                ctx
            );
            consoleSpy.mockRestore();

            expect(result).toEqual(['fallback']);
        });

        it('should return context.output when result is not an array', () => {
            const node: NodeData = { id: 'a', type: 'process', fields: {} };
            const ctx = makeNodeContext(node, ['default']);

            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const result = runtime.execute(
                'return "not an array"',
                node,
                ctx
            );
            consoleSpy.mockRestore();

            expect(result).toEqual(['default']);
        });

        it('should return context.output when result is undefined', () => {
            const node: NodeData = { id: 'a', type: 'process', fields: {} };
            const ctx = makeNodeContext(node, ['default']);

            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const result = runtime.execute(
                '// no return statement',
                node,
                ctx
            );
            consoleSpy.mockRestore();

            expect(result).toEqual(['default']);
        });

        it('should handle syntax errors gracefully', () => {
            const node: NodeData = { id: 'a', type: 'process', fields: {} };
            const ctx = makeNodeContext(node, ['fallback']);

            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const result = runtime.execute(
                'return [invalid syntax %%%',
                node,
                ctx
            );
            consoleSpy.mockRestore();

            expect(result).toEqual(['fallback']);
        });

        it('should handle null return gracefully', () => {
            const node: NodeData = { id: 'a', type: 'process', fields: {} };
            const ctx = makeNodeContext(node, ['fallback']);

            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const result = runtime.execute(
                'return null',
                node,
                ctx
            );
            consoleSpy.mockRestore();

            expect(result).toEqual(['fallback']);
        });
    });

    // ================================================================
    // Complex transforms
    // ================================================================
    describe('complex transforms', () => {
        it('should handle multi-line JS fragments', () => {
            const node: NodeData = {
                id: 'a', type: 'decision',
                fields: { label: 'Check?', status: 'implemented' }
            };
            const ctx = makeNodeContext(node, []);

            const js = `
                const lines = [];
                lines.push(node.id + '{"' + node.fields.label + '"}');
                if (node.fields.status === 'implemented') {
                    lines.push('style ' + node.id + ' fill:#green');
                }
                return lines;
            `;

            const result = runtime.execute(js, node, ctx);
            expect(result).toEqual([
                'a{"Check?"}',
                'style a fill:#green'
            ]);
        });

        it('should allow transforms to modify output based on context', () => {
            const node: NodeData = { id: 'a', type: 'process', fields: {} };
            const ctx: TransformContext = {
                allNodes: new Map([
                    ['a', node],
                    ['b', { id: 'b', type: 'end', fields: {} }]
                ]),
                allEdges: [{ from: 'a', to: 'b', fields: {} }],
                mapping: makeMapping(),
                output: ['a["Process"]']
            };

            const js = `
                const result = [...ctx.output];
                for (const e of ctx.allEdges) {
                    if (e.from === node.id) {
                        result.push('click ' + node.id + ' callback');
                    }
                }
                return result;
            `;

            const result = runtime.execute(js, node, ctx);
            expect(result).toEqual(['a["Process"]', 'click a callback']);
        });

        it('should return empty array when fragment returns empty', () => {
            const node: NodeData = { id: 'a', type: 'process', fields: {} };
            const ctx = makeNodeContext(node, ['default']);

            const result = runtime.execute('return []', node, ctx);
            expect(result).toEqual([]);
        });
    });
});
