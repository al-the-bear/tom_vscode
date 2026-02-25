import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { GraphTypeRegistry } from '../src/graph-type-registry.js';
import { ConversionEngine } from '../src/conversion-engine.js';

/**
 * Integration test: loads all graph types from the graph-types/ directory,
 * then converts all fixture YAML files end-to-end and verifies output.
 */
describe('Integration: full pipeline', () => {
    let registry: GraphTypeRegistry;
    let engine: ConversionEngine;

    beforeAll(async () => {
        registry = new GraphTypeRegistry();
        engine = new ConversionEngine();

        const graphTypesDir = new URL('../graph-types', import.meta.url).pathname;
        const errors = await registry.registerAllFromDirectory(graphTypesDir);
        // Log any registration issues
        if (errors.length > 0) {
            console.warn('Registration warnings:', errors);
        }
    });

    function readFixture(name: string): string {
        const path = new URL(`./fixtures/${name}`, import.meta.url).pathname;
        return readFileSync(path, 'utf-8');
    }

    // ================================================================
    // Flowchart pipeline
    // ================================================================
    describe('flowchart pipeline', () => {
        it('should resolve graph type for .flow.yaml file', () => {
            const gt = registry.getForFile('build-pipeline.flow.yaml');
            expect(gt).toBeDefined();
            expect(gt!.id).toBe('flowchart');
        });

        it('should resolve specific version for .flow.yaml file', () => {
            const gt = registry.getForFileVersion('build-pipeline.flow.yaml', 1);
            expect(gt).toBeDefined();
            expect(gt!.version).toBe(1);
        });

        it('should convert sample flowchart end-to-end', () => {
            const yaml = readFixture('sample.flow.yaml');
            const gt = registry.getForFile('build-pipeline.flow.yaml')!;
            const result = engine.convert(yaml, gt);

            // Verify complete output
            expect(result.mermaidSource).toContain('flowchart TD');
            expect(result.errors).toEqual([]);
            expect(result.nodeMap.size).toBe(6); // start, checkout, build, test, deploy, done
            expect(result.edgeMap.size).toBe(6); // 6 edges

            // Verify shapes
            expect(result.mermaidSource).toContain('start(["Begin"])');
            expect(result.mermaidSource).toContain('checkout["Checkout Code"]');
            expect(result.mermaidSource).toContain('test{"Tests Pass?"}');
            expect(result.mermaidSource).toContain('deploy[["Deploy to Staging"]]');

            // Verify styles
            expect(result.mermaidSource).toContain('style checkout fill:#d4edda');
            expect(result.mermaidSource).toContain('style test fill:#fff3cd');
        });

        it('should report validation errors for invalid flowchart', () => {
            const yaml = readFixture('invalid-flow.yaml');
            const gt = registry.getForFile('test.flow.yaml')!;
            const result = engine.convert(yaml, gt);

            expect(result.errors.length).toBeGreaterThan(0);
            // Should still produce some output (best-effort)
            expect(result.mermaidSource).toBeDefined();
        });

        it('should handle minimal flowchart', () => {
            const yaml = readFixture('minimal.flow.yaml');
            const gt = registry.getForFile('test.flow.yaml')!;
            const result = engine.convert(yaml, gt);

            expect(result.errors).toEqual([]);
            expect(result.nodeMap.size).toBe(1);
            expect(result.edgeMap.size).toBe(0);
        });
    });

    // ================================================================
    // State machine pipeline
    // ================================================================
    describe('state machine pipeline', () => {
        it('should resolve graph type for .state.yaml file', () => {
            const gt = registry.getForFile('order.state.yaml');
            expect(gt).toBeDefined();
            expect(gt!.id).toBe('state-machine');
        });

        it('should convert sample state machine end-to-end', () => {
            const yaml = readFixture('sample.state.yaml');
            const gt = registry.getForFile('order.state.yaml')!;
            const result = engine.convert(yaml, gt);

            expect(result.mermaidSource).toContain('stateDiagram-v2');
            expect(result.errors).toEqual([]);

            // Initial connector
            expect(result.mermaidSource).toContain('[*] --> init');

            // State labels
            expect(result.mermaidSource).toContain('pending : Pending Review');
            expect(result.mermaidSource).toContain('approved : Approved');
            expect(result.mermaidSource).toContain('shipped : Shipped');

            // Final connector
            expect(result.mermaidSource).toContain('completed --> [*]');

            // Transitions
            expect(result.mermaidSource).toContain('init --> pending : submit');
            expect(result.mermaidSource).toContain('pending --> approved : approve [isValid]');
            expect(result.mermaidSource).toContain('pending --> rejected : reject');
        });
    });

    // ================================================================
    // ER diagram pipeline
    // ================================================================
    describe('ER diagram pipeline', () => {
        it('should resolve graph type for .er.yaml file', () => {
            const gt = registry.getForFile('schema.er.yaml');
            expect(gt).toBeDefined();
            expect(gt!.id).toBe('er-diagram');
        });

        it('should convert sample ER diagram end-to-end', () => {
            const yaml = readFixture('sample.er.yaml');
            const gt = registry.getForFile('schema.er.yaml')!;
            const result = engine.convert(yaml, gt);

            expect(result.mermaidSource).toContain('erDiagram');
            expect(result.errors).toEqual([]);

            // Entities with attributes
            expect(result.mermaidSource).toContain('User {');
            expect(result.mermaidSource).toContain('int id PK');
            expect(result.mermaidSource).toContain('Role {');
            expect(result.mermaidSource).toContain('Permission {');

            // Relationships
            expect(result.mermaidSource).toContain('User }o--|| Role : "has"');
            expect(result.mermaidSource).toContain('Role ||--o{ Permission : "grants"');
            expect(result.mermaidSource).toContain('User }o--o{ Permission : "assigned"');
        });
    });

    // ================================================================
    // Cross-cutting: callbacks with registry-loaded types
    // ================================================================
    describe('callbacks with real types', () => {
        it('should support click callbacks for navigation', () => {
            const yaml = readFixture('sample.flow.yaml');
            const gt = registry.getForFile('test.flow.yaml')!;

            const clickTargets: string[] = [];
            const result = engine.convert(yaml, gt, {
                onNodeEmit: (nodeId, _nodeData, _lines) => {
                    clickTargets.push(nodeId);
                    return [`click ${nodeId} "https://docs/${nodeId}"`];
                }
            });

            expect(clickTargets.length).toBe(6);
            expect(result.mermaidSource).toContain('click start "https://docs/start"');
            expect(result.mermaidSource).toContain('click checkout "https://docs/checkout"');
        });

        it('should support adding footer comment via onComplete', () => {
            const yaml = readFixture('minimal.flow.yaml');
            const gt = registry.getForFile('test.flow.yaml')!;

            const result = engine.convert(yaml, gt, {
                onComplete: (nodeIds, _output) => {
                    return [`%% ${nodeIds.length} nodes rendered`];
                }
            });

            expect(result.mermaidSource).toContain('%% 1 nodes rendered');
        });
    });

    // ================================================================
    // Source map verification
    // ================================================================
    describe('source map accuracy', () => {
        it('node ranges should point to valid YAML content', () => {
            const yaml = readFixture('sample.flow.yaml');
            const gt = registry.getForFile('test.flow.yaml')!;
            const result = engine.convert(yaml, gt);

            for (const [nodeId, range] of result.nodeMap) {
                const slice = yaml.slice(range.startOffset, range.endOffset);
                // The slice should contain the node key somewhere
                expect(slice).toContain(nodeId);
            }
        });

        it('edge ranges should point to valid YAML content', () => {
            const yaml = readFixture('sample.flow.yaml');
            const gt = registry.getForFile('test.flow.yaml')!;
            const result = engine.convert(yaml, gt);

            for (const [index, range] of result.edgeMap) {
                const slice = yaml.slice(range.startOffset, range.endOffset);
                // Each edge should contain 'to' field (from is implicit from parent node)
                expect(slice).toContain('to');
            }
        });
    });
});
