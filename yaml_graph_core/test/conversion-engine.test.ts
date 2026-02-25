import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { ConversionEngine } from '../src/conversion-engine.js';
import { MappingLoader } from '../src/mapping-loader.js';
import type {
    GraphType, GraphMapping, ConversionCallbacks,
    NodeData, EdgeData
} from '../src/types.js';

// ================================================================
// Test helpers
// ================================================================

function readFixture(name: string): string {
    const path = new URL(`./fixtures/${name}`, import.meta.url).pathname;
    return readFileSync(path, 'utf-8');
}

function buildGraphType(mapping: GraphMapping, schema: object): GraphType {
    return {
        id: mapping.map.id,
        version: mapping.map.version ?? 1,
        filePatterns: [`*.${mapping.map.id}.yaml`],
        schema,
        mapping,
    };
}

function lines(mermaid: string): string[] {
    return mermaid.split('\n').map(l => l.trimEnd());
}

describe('ConversionEngine', () => {
    const engine = new ConversionEngine();
    const loader = new MappingLoader();

    // ================================================================
    // Flowchart conversion
    // ================================================================
    describe('flowchart conversion', () => {
        let flowchartType: GraphType;

        beforeAll(async () => {
            const path = new URL('../graph-types/flowchart', import.meta.url).pathname;
            const types = await loader.loadFromFolder(path);
            flowchartType = types[0];
        });

        it('should produce mermaid output starting with "flowchart TD"', () => {
            const yaml = readFixture('sample.flow.yaml');
            const result = engine.convert(yaml, flowchartType);

            const firstLine = lines(result.mermaidSource)[0];
            expect(firstLine).toBe('flowchart TD');
        });

        it('should render all nodes from the YAML', () => {
            const yaml = readFixture('sample.flow.yaml');
            const result = engine.convert(yaml, flowchartType);
            const mermaid = result.mermaidSource;

            expect(mermaid).toContain('start');
            expect(mermaid).toContain('checkout');
            expect(mermaid).toContain('build');
            expect(mermaid).toContain('test');
            expect(mermaid).toContain('deploy');
            expect(mermaid).toContain('done');
        });

        it('should render nodes with correct shape templates', () => {
            const yaml = readFixture('sample.flow.yaml');
            const result = engine.convert(yaml, flowchartType);
            const mermaid = result.mermaidSource;

            // start type → stadium shape (["..."])
            expect(mermaid).toContain('start(["Begin"])');
            // process type → rect shape ["..."]
            expect(mermaid).toContain('checkout["Checkout Code"]');
            // decision type → rhombus shape {"..."}
            expect(mermaid).toContain('test{"Tests Pass?"}');
            // subprocess type → double-rect [["..."]]
            expect(mermaid).toContain('deploy[["Deploy to Staging"]]');
            // end type → stadium shape
            expect(mermaid).toContain('done(["Finished"])');
        });

        it('should render edges between nodes', () => {
            const yaml = readFixture('sample.flow.yaml');
            const result = engine.convert(yaml, flowchartType);
            const mermaid = result.mermaidSource;

            // Edge without label: start --> checkout
            expect(mermaid).toContain('start --> checkout');
            // Edge without label: checkout --> build
            expect(mermaid).toContain('checkout --> build');
        });

        it('should render labeled edges using label template', () => {
            const yaml = readFixture('sample.flow.yaml');
            const result = engine.convert(yaml, flowchartType);
            const mermaid = result.mermaidSource;

            // When a label template exists, it should use it
            // Template: {from} -->|"{label}"| {to}
            expect(mermaid).toContain('test -->|"yes"| deploy');
        });

        it('should apply style rules for node status', () => {
            const yaml = readFixture('sample.flow.yaml');
            const result = engine.convert(yaml, flowchartType);
            const mermaid = result.mermaidSource;

            // checkout and build have status: implemented
            expect(mermaid).toContain('style checkout fill:#d4edda,stroke:#28a745,color:#155724');
            expect(mermaid).toContain('style build fill:#d4edda,stroke:#28a745,color:#155724');

            // test and deploy have status: planned
            expect(mermaid).toContain('style test fill:#fff3cd,stroke:#ffc107,color:#856404');
            expect(mermaid).toContain('style deploy fill:#fff3cd,stroke:#ffc107,color:#856404');
        });

        it('should return empty errors for valid YAML', () => {
            const yaml = readFixture('sample.flow.yaml');
            const result = engine.convert(yaml, flowchartType);

            expect(result.errors).toEqual([]);
        });

        it('should return validation errors for invalid YAML', () => {
            const yaml = readFixture('invalid-flow.yaml');
            const result = engine.convert(yaml, flowchartType);

            expect(result.errors.length).toBeGreaterThan(0);
        });

        it('should populate nodeMap with source ranges', () => {
            const yaml = readFixture('sample.flow.yaml');
            const result = engine.convert(yaml, flowchartType);

            expect(result.nodeMap.size).toBeGreaterThan(0);
            // Check that 'start' node has a valid range
            const startRange = result.nodeMap.get('start');
            expect(startRange).toBeDefined();
            expect(startRange!.startOffset).toBeGreaterThanOrEqual(0);
            expect(startRange!.endOffset).toBeGreaterThan(startRange!.startOffset);
        });

        it('should populate edgeMap with source ranges', () => {
            const yaml = readFixture('sample.flow.yaml');
            const result = engine.convert(yaml, flowchartType);

            expect(result.edgeMap.size).toBeGreaterThan(0);
            const firstEdge = result.edgeMap.get(0);
            expect(firstEdge).toBeDefined();
        });

        it('should convert minimal flowchart', () => {
            const yaml = readFixture('minimal.flow.yaml');
            const result = engine.convert(yaml, flowchartType);

            expect(result.mermaidSource).toContain('flowchart TD');
            expect(result.mermaidSource).toContain('a["Step A"]');
            expect(result.errors).toEqual([]);
        });
    });

    // ================================================================
    // State machine conversion
    // ================================================================
    describe('state machine conversion', () => {
        let stateMachineType: GraphType;

        beforeAll(async () => {
            const path = new URL('../graph-types/state-machine', import.meta.url).pathname;
            const types = await loader.loadFromFolder(path);
            stateMachineType = types[0];
        });

        it('should produce mermaid output starting with "stateDiagram-v2"', () => {
            const yaml = readFixture('sample.state.yaml');
            const result = engine.convert(yaml, stateMachineType);

            expect(lines(result.mermaidSource)[0]).toBe('stateDiagram-v2');
        });

        it('should render initial connector', () => {
            const yaml = readFixture('sample.state.yaml');
            const result = engine.convert(yaml, stateMachineType);

            // [*] --> init (first node)
            expect(result.mermaidSource).toContain('[*] --> init');
        });

        it('should render final connector for final-type states', () => {
            const yaml = readFixture('sample.state.yaml');
            const result = engine.convert(yaml, stateMachineType);

            // completed has type: final → completed --> [*]
            expect(result.mermaidSource).toContain('completed --> [*]');
        });

        it('should render state labels', () => {
            const yaml = readFixture('sample.state.yaml');
            const result = engine.convert(yaml, stateMachineType);
            const mermaid = result.mermaidSource;

            expect(mermaid).toContain('pending : Pending Review');
            expect(mermaid).toContain('approved : Approved');
            expect(mermaid).toContain('rejected : Rejected');
            expect(mermaid).toContain('shipped : Shipped');
        });

        it('should not render initial or final states as standalone state declarations', () => {
            const yaml = readFixture('sample.state.yaml');
            const result = engine.convert(yaml, stateMachineType);
            const mermaid = result.mermaidSource;

            // Initial and final types return empty from renderState()
            // so they shouldn't appear as "init : Start" or "completed : Completed"
            expect(mermaid).not.toMatch(/^\s+init : /m);
            expect(mermaid).not.toMatch(/^\s+completed : Completed/m);
        });

        it('should render transitions with events', () => {
            const yaml = readFixture('sample.state.yaml');
            const result = engine.convert(yaml, stateMachineType);
            const mermaid = result.mermaidSource;

            expect(mermaid).toContain('init --> pending : submit');
            expect(mermaid).toContain('approved --> shipped : ship');
            expect(mermaid).toContain('shipped --> completed : deliver');
        });

        it('should render transitions with guards', () => {
            const yaml = readFixture('sample.state.yaml');
            const result = engine.convert(yaml, stateMachineType);

            expect(result.mermaidSource).toContain('pending --> approved : approve [isValid]');
        });

        it('should validate against state machine schema', () => {
            const yaml = readFixture('sample.state.yaml');
            const result = engine.convert(yaml, stateMachineType);

            expect(result.errors).toEqual([]);
        });

        it('should populate nodeMap for states', () => {
            const yaml = readFixture('sample.state.yaml');
            const result = engine.convert(yaml, stateMachineType);

            expect(result.nodeMap.size).toBeGreaterThan(0);
            expect(result.nodeMap.has('pending')).toBe(true);
        });
    });

    // ================================================================
    // ER diagram conversion
    // ================================================================
    describe('ER diagram conversion', () => {
        let erType: GraphType;

        beforeAll(async () => {
            const path = new URL('../graph-types/er-diagram', import.meta.url).pathname;
            const types = await loader.loadFromFolder(path);
            erType = types[0];
        });

        it('should produce mermaid output starting with "erDiagram"', () => {
            const yaml = readFixture('sample.er.yaml');
            const result = engine.convert(yaml, erType);

            expect(lines(result.mermaidSource)[0]).toBe('erDiagram');
        });

        it('should render entities with attributes', () => {
            const yaml = readFixture('sample.er.yaml');
            const result = engine.convert(yaml, erType);
            const mermaid = result.mermaidSource;

            // User entity
            expect(mermaid).toContain('User {');
            expect(mermaid).toContain('int id PK');
            expect(mermaid).toContain('string email UK');
            expect(mermaid).toContain('string name');
            expect(mermaid).toContain('int role_id FK');

            // Role entity
            expect(mermaid).toContain('Role {');
            expect(mermaid).toContain('string name');

            // Permission entity
            expect(mermaid).toContain('Permission {');
        });

        it('should render relationships with correct cardinality', () => {
            const yaml = readFixture('sample.er.yaml');
            const result = engine.convert(yaml, erType);
            const mermaid = result.mermaidSource;

            // many-to-one: }o--||
            expect(mermaid).toContain('User }o--|| Role : "has"');
            // one-to-many: ||--o{
            expect(mermaid).toContain('Role ||--o{ Permission : "grants"');
            // many-to-many: }o--o{
            expect(mermaid).toContain('User }o--o{ Permission : "assigned"');
        });

        it('should validate against ER schema', () => {
            const yaml = readFixture('sample.er.yaml');
            const result = engine.convert(yaml, erType);

            expect(result.errors).toEqual([]);
        });

        it('should have entity node ranges in nodeMap', () => {
            const yaml = readFixture('sample.er.yaml');
            const result = engine.convert(yaml, erType);

            expect(result.nodeMap.has('User')).toBe(true);
            expect(result.nodeMap.has('Role')).toBe(true);
            expect(result.nodeMap.has('Permission')).toBe(true);
        });
    });

    // ================================================================
    // Callbacks
    // ================================================================
    describe('callbacks', () => {
        let flowchartType: GraphType;

        beforeAll(async () => {
            const path = new URL('../graph-types/flowchart', import.meta.url).pathname;
            const types = await loader.loadFromFolder(path);
            flowchartType = types[0];
        });

        it('should call onNodeEmit for each node', () => {
            const yaml = readFixture('minimal.flow.yaml');
            const emittedNodeIds: string[] = [];

            const callbacks: ConversionCallbacks = {
                onNodeEmit: (nodeId, _nodeData, _lines) => {
                    emittedNodeIds.push(nodeId);
                    return [];
                }
            };

            engine.convert(yaml, flowchartType, callbacks);
            expect(emittedNodeIds).toContain('a');
        });

        it('should include extra lines from onNodeEmit in output', () => {
            const yaml = readFixture('minimal.flow.yaml');
            const callbacks: ConversionCallbacks = {
                onNodeEmit: (nodeId, _nodeData, _lines) => {
                    return [`click ${nodeId} callback`];
                }
            };

            const result = engine.convert(yaml, flowchartType, callbacks);
            expect(result.mermaidSource).toContain('click a callback');
        });

        it('should call onEdgeEmit for each edge', () => {
            const yaml = readFixture('sample.flow.yaml');
            const emittedEdges: Array<{ from: string; to: string }> = [];

            const callbacks: ConversionCallbacks = {
                onEdgeEmit: (edgeData, _lines) => {
                    emittedEdges.push({ from: edgeData.from, to: edgeData.to });
                    return [];
                }
            };

            engine.convert(yaml, flowchartType, callbacks);
            expect(emittedEdges.length).toBeGreaterThan(0);
            expect(emittedEdges.some(e => e.from === 'start' && e.to === 'checkout')).toBe(true);
        });

        it('should call onComplete after all elements', () => {
            const yaml = readFixture('minimal.flow.yaml');
            let completeNodeIds: string[] = [];

            const callbacks: ConversionCallbacks = {
                onComplete: (allNodeIds, _output) => {
                    completeNodeIds = allNodeIds;
                    return ['%% Generated by yaml-graph-core'];
                }
            };

            const result = engine.convert(yaml, flowchartType, callbacks);
            expect(completeNodeIds).toContain('a');
            expect(result.mermaidSource).toContain('%% Generated by yaml-graph-core');
        });

        it('should include extra lines from onEdgeEmit in output', () => {
            const yaml = readFixture('sample.flow.yaml');
            const callbacks: ConversionCallbacks = {
                onEdgeEmit: (_edgeData, emittedLines) => {
                    return ['%% edge rendered'];
                }
            };

            const result = engine.convert(yaml, flowchartType, callbacks);
            expect(result.mermaidSource).toContain('%% edge rendered');
        });
    });

    // ================================================================
    // convertWithPrepare (async)
    // ================================================================
    describe('convertWithPrepare()', () => {
        let flowchartType: GraphType;

        beforeAll(async () => {
            const path = new URL('../graph-types/flowchart', import.meta.url).pathname;
            const types = await loader.loadFromFolder(path);
            flowchartType = types[0];
        });

        it('should call prepare() before conversion', async () => {
            const yaml = readFixture('minimal.flow.yaml');
            let prepared = false;

            const callbacks: ConversionCallbacks = {
                prepare: async () => {
                    prepared = true;
                },
                onNodeEmit: (_id, _data, _lines) => {
                    // Prepare should have been called by now
                    expect(prepared).toBe(true);
                    return [];
                }
            };

            await engine.convertWithPrepare(yaml, flowchartType, callbacks);
            expect(prepared).toBe(true);
        });

        it('should work without prepare callback', async () => {
            const yaml = readFixture('minimal.flow.yaml');
            const result = await engine.convertWithPrepare(yaml, flowchartType);

            expect(result.mermaidSource).toContain('flowchart TD');
        });

        it('should produce same result as synchronous convert', async () => {
            const yaml = readFixture('sample.flow.yaml');
            const syncResult = engine.convert(yaml, flowchartType);
            const asyncResult = await engine.convertWithPrepare(yaml, flowchartType);

            expect(asyncResult.mermaidSource).toBe(syncResult.mermaidSource);
            expect(asyncResult.errors).toEqual(syncResult.errors);
        });
    });

    // ================================================================
    // Transforms
    // ================================================================
    describe('transforms', () => {
        it('should apply a matching node transform', () => {
            const mapping: GraphMapping = {
                map: { id: 'test', version: 1, mermaidType: 'flowchart', defaultDirection: 'TD' },
                nodeShapes: {
                    sourcePath: 'nodes',
                    idField: '_key',
                    labelField: 'label',
                    shapeField: 'type',
                    shapes: { process: '["{label}"]' }
                },
                edgeLinks: {
                    sourcePath: 'edges',
                    fromField: 'from',
                    toField: 'to',
                    linkStyles: { default: '-->' }
                },
                transforms: [
                    {
                        scope: 'node',
                        match: { field: 'special', exists: true },
                        js: 'return [`${node.id}(("${node.fields.label}"))`]'
                    }
                ]
            };

            const graphType = buildGraphType(mapping, { type: 'object' });

            const yaml = `
nodes:
  normal:
    type: process
    label: Normal
  special_node:
    type: process
    label: Special
    special: true
edges: []
`;
            const result = engine.convert(yaml, graphType);

            // normal should use default rendering
            expect(result.mermaidSource).toContain('normal["Normal"]');
            // special_node should use the transform
            expect(result.mermaidSource).toContain('special_node(("Special"))');
        });

        it('should apply equals condition', () => {
            const mapping: GraphMapping = {
                map: { id: 'test', version: 1, mermaidType: 'flowchart', defaultDirection: 'TD' },
                nodeShapes: {
                    sourcePath: 'nodes',
                    idField: '_key',
                    labelField: 'label',
                    shapeField: 'type',
                    shapes: { process: '["{label}"]' }
                },
                edgeLinks: {
                    sourcePath: 'edges',
                    fromField: 'from',
                    toField: 'to',
                    linkStyles: { default: '-->' }
                },
                transforms: [
                    {
                        scope: 'node',
                        match: { field: 'status', equals: 'critical' },
                        js: 'return [`${node.id}[["⚠️ ${node.fields.label}"]]`]'
                    }
                ]
            };

            const graphType = buildGraphType(mapping, { type: 'object' });

            const yaml = `
nodes:
  a:
    type: process
    label: Normal Step
  b:
    type: process
    label: Critical Step
    status: critical
edges: []
`;
            const result = engine.convert(yaml, graphType);
            expect(result.mermaidSource).toContain('a["Normal Step"]');
            expect(result.mermaidSource).toContain('b[["⚠️ Critical Step"]]');
        });

        it('should apply pattern condition', () => {
            const mapping: GraphMapping = {
                map: { id: 'test', version: 1, mermaidType: 'flowchart', defaultDirection: 'TD' },
                nodeShapes: {
                    sourcePath: 'nodes',
                    idField: '_key',
                    labelField: 'label',
                    shapeField: 'type',
                    shapes: { process: '["{label}"]' }
                },
                edgeLinks: {
                    sourcePath: 'edges',
                    fromField: 'from',
                    toField: 'to',
                    linkStyles: { default: '-->' }
                },
                transforms: [
                    {
                        scope: 'node',
                        match: { field: 'owner', pattern: '^team-' },
                        js: 'return [`${node.id}["🏢 ${node.fields.label}"]`]'
                    }
                ]
            };

            const graphType = buildGraphType(mapping, { type: 'object' });

            const yaml = `
nodes:
  a:
    type: process
    label: Solo
    owner: john
  b:
    type: process
    label: Team Task
    owner: team-alpha
edges: []
`;
            const result = engine.convert(yaml, graphType);
            expect(result.mermaidSource).toContain('a["Solo"]');
            expect(result.mermaidSource).toContain('b["🏢 Team Task"]');
        });

        it('should use first-match-wins for transforms', () => {
            const mapping: GraphMapping = {
                map: { id: 'test', version: 1, mermaidType: 'flowchart', defaultDirection: 'TD' },
                nodeShapes: {
                    sourcePath: 'nodes',
                    idField: '_key',
                    labelField: 'label',
                    shapeField: 'type',
                    shapes: { process: '["{label}"]' }
                },
                edgeLinks: {
                    sourcePath: 'edges',
                    fromField: 'from',
                    toField: 'to',
                    linkStyles: { default: '-->' }
                },
                transforms: [
                    {
                        scope: 'node',
                        match: { field: 'priority', equals: 'high' },
                        js: 'return [`${node.id}(("FIRST MATCH"))`]'
                    },
                    {
                        scope: 'node',
                        match: { field: 'priority', exists: true },
                        js: 'return [`${node.id}(("SECOND MATCH"))`]'
                    }
                ]
            };

            const graphType = buildGraphType(mapping, { type: 'object' });

            const yaml = `
nodes:
  a:
    type: process
    label: High
    priority: high
edges: []
`;
            const result = engine.convert(yaml, graphType);
            // First rule should win even though second also matches
            expect(result.mermaidSource).toContain('a(("FIRST MATCH"))');
            expect(result.mermaidSource).not.toContain('SECOND MATCH');
        });

        it('should apply edge transforms', () => {
            const mapping: GraphMapping = {
                map: { id: 'test', version: 1, mermaidType: 'flowchart', defaultDirection: 'TD' },
                nodeShapes: {
                    sourcePath: 'nodes',
                    idField: '_key',
                    labelField: 'label',
                    shapeField: 'type',
                    shapes: { process: '["{label}"]' }
                },
                edgeLinks: {
                    sourcePath: 'nodes.*.connections',
                    fromField: 'from',
                    toField: 'to',
                    fromImplicit: '_parent_key',
                    linkStyles: { default: '-->' }
                },
                transforms: [
                    {
                        scope: 'edge',
                        match: { field: 'critical', equals: true },
                        js: 'return [`${edge.from} ==>|"CRITICAL"| ${edge.to}`]'
                    }
                ]
            };

            const graphType = buildGraphType(mapping, { type: 'object' });

            const yaml = `
nodes:
  a:
    type: process
    label: A
    connections:
      - to: b
        critical: true
  b:
    type: process
    label: B
`;
            const result = engine.convert(yaml, graphType);
            expect(result.mermaidSource).toContain('a ==>|"CRITICAL"| b');
        });
    });

    // ================================================================
    // Edge rendering
    // ================================================================
    describe('edge rendering', () => {
        let flowchartType: GraphType;

        beforeAll(async () => {
            const path = new URL('../graph-types/flowchart', import.meta.url).pathname;
            const types = await loader.loadFromFolder(path);
            flowchartType = types[0];
        });

        it('should render edges without labels as simple arrows', () => {
            const yaml = `
meta:
  id: test
  title: Test
  graph-version: 1
nodes:
  a:
    type: process
    label: A
    connections:
      - to: b
  b:
    type: process
    label: B
`;
            const result = engine.convert(yaml, flowchartType);
            expect(result.mermaidSource).toContain('a --> b');
        });

        it('should render dotted edges', () => {
            const yaml = `
meta:
  id: test
  title: Test
  graph-version: 1
nodes:
  a:
    type: process
    label: A
    connections:
      - to: b
        style: dotted
  b:
    type: process
    label: B
`;
            const result = engine.convert(yaml, flowchartType);
            expect(result.mermaidSource).toContain('a -.-> b');
        });

        it('should render thick edges', () => {
            const yaml = `
meta:
  id: test
  title: Test
  graph-version: 1
nodes:
  a:
    type: process
    label: A
    connections:
      - to: b
        style: thick
  b:
    type: process
    label: B
`;
            const result = engine.convert(yaml, flowchartType);
            expect(result.mermaidSource).toContain('a ==> b');
        });

        it('should render labeled edges with label template', () => {
            const yaml = `
meta:
  id: test
  title: Test
  graph-version: 1
nodes:
  a:
    type: process
    label: A
    connections:
      - to: b
        label: "next"
  b:
    type: process
    label: B
`;
            const result = engine.convert(yaml, flowchartType);
            // The flowchart mapping has label-template: {from} -->|"{label}"| {to}
            expect(result.mermaidSource).toContain('a -->|"next"| b');
        });
    });

    // ================================================================
    // Inline mapping (programmatic)
    // ================================================================
    describe('programmatic mapping', () => {
        it('should work with a minimal inline mapping', () => {
            const mapping: GraphMapping = {
                map: { id: 'inline', version: 1, mermaidType: 'flowchart', defaultDirection: 'LR' },
                nodeShapes: {
                    sourcePath: 'nodes',
                    idField: '_key',
                    labelField: 'name',
                    shapeField: 'kind',
                    shapes: {
                        box: '["{label}"]',
                        circle: '(("{label}"))'
                    }
                },
                edgeLinks: {
                    sourcePath: 'nodes.*.links',
                    fromField: 'from',
                    toField: 'dst',
                    fromImplicit: '_parent_key',
                    linkStyles: { default: '-->' }
                }
            };

            const graphType = buildGraphType(mapping, { type: 'object' });

            const yaml = `
nodes:
  a:
    kind: box
    name: Alpha
    links:
      - dst: b
  b:
    kind: circle
    name: Beta
`;

            const result = engine.convert(yaml, graphType);
            expect(result.mermaidSource).toContain('flowchart LR');
            expect(result.mermaidSource).toContain('a["Alpha"]');
            expect(result.mermaidSource).toContain('b(("Beta"))');
            expect(result.mermaidSource).toContain('a --> b');
        });

        it('should use default shape for unknown node types', () => {
            const mapping: GraphMapping = {
                map: { id: 'inline', version: 1, mermaidType: 'flowchart', defaultDirection: 'TD' },
                nodeShapes: {
                    sourcePath: 'nodes',
                    idField: '_key',
                    labelField: 'label',
                    shapeField: 'type',
                    shapes: { known: '["{label}"]' }
                },
                edgeLinks: {
                    sourcePath: 'edges',
                    fromField: 'from',
                    toField: 'to',
                    linkStyles: { default: '-->' }
                }
            };

            const graphType = buildGraphType(mapping, { type: 'object' });
            const yaml = `
nodes:
  a:
    type: unknown_type
    label: Fallback
edges: []
`;

            const result = engine.convert(yaml, graphType);
            // Should use default fallback: id["label"]
            expect(result.mermaidSource).toContain('a["Fallback"]');
        });

        it('should handle nodes without explicit label using id as fallback', () => {
            const mapping: GraphMapping = {
                map: { id: 'inline', version: 1, mermaidType: 'flowchart', defaultDirection: 'TD' },
                nodeShapes: {
                    sourcePath: 'nodes',
                    idField: '_key',
                    labelField: 'label',
                    shapeField: 'type',
                    shapes: { process: '["{label}"]' }
                },
                edgeLinks: {
                    sourcePath: 'edges',
                    fromField: 'from',
                    toField: 'to',
                    linkStyles: { default: '-->' }
                }
            };

            const graphType = buildGraphType(mapping, { type: 'object' });

            const yaml = `
nodes:
  myNode:
    type: process
edges: []
`;

            const result = engine.convert(yaml, graphType);
            // No "label" field → fallback to id
            expect(result.mermaidSource).toContain('myNode["myNode"]');
        });
    });

    // ================================================================
    // Empty and edge cases
    // ================================================================
    describe('edge cases', () => {
        it('should handle YAML with no edges', () => {
            const mapping: GraphMapping = {
                map: { id: 'test', version: 1, mermaidType: 'flowchart', defaultDirection: 'TD' },
                nodeShapes: {
                    sourcePath: 'nodes',
                    idField: '_key',
                    labelField: 'label',
                    shapeField: 'type',
                    shapes: {}
                },
                edgeLinks: {
                    sourcePath: 'edges',
                    fromField: 'from',
                    toField: 'to',
                    linkStyles: { default: '-->' }
                }
            };

            const graphType = buildGraphType(mapping, { type: 'object' });

            const yaml = `
nodes:
  a:
    type: process
    label: Only Node
`;
            const result = engine.convert(yaml, graphType);
            expect(result.mermaidSource).toContain('flowchart TD');
            expect(result.mermaidSource).toContain('Only Node');
            expect(result.edgeMap.size).toBe(0);
        });

        it('should handle YAML with no nodes', () => {
            const mapping: GraphMapping = {
                map: { id: 'test', version: 1, mermaidType: 'flowchart', defaultDirection: 'TD' },
                nodeShapes: {
                    sourcePath: 'nodes',
                    idField: '_key',
                    labelField: 'label',
                    shapeField: 'type',
                    shapes: {}
                },
                edgeLinks: {
                    sourcePath: 'edges',
                    fromField: 'from',
                    toField: 'to',
                    linkStyles: { default: '-->' }
                }
            };

            const graphType = buildGraphType(mapping, { type: 'object' });

            const yaml = `edges: []`;
            const result = engine.convert(yaml, graphType);
            expect(result.mermaidSource).toContain('flowchart TD');
            expect(result.nodeMap.size).toBe(0);
        });

        it('should handle YAML with comments', () => {
            const yaml = readFixture('comments.flow.yaml');

            const path = new URL('../graph-types/flowchart', import.meta.url).pathname;
            // Reuse existing flowchart type loading
            const types = loader.loadMappingFromString(`
map:
  id: flowchart
  version: 1
  mermaid-type: flowchart
  default-direction: TD
node-shapes:
  source-path: nodes
  id-field: _key
  label-field: label
  type-field: type
  shapes:
    start: '(["{label}"])'
    process: '["{label}"]'
edge-links:
  source-path: edges
  from-field: from
  to-field: to
  link-styles:
    default: "-->"
`);

            const graphType: GraphType = {
                id: 'flowchart',
                version: 1,
                filePatterns: ['*.flow.yaml'],
                schema: { type: 'object' },
                mapping: types,
            };

            const result = engine.convert(yaml, graphType);
            // Should still parse and convert correctly despite comments
            expect(result.mermaidSource).toContain('flowchart TD');
            expect(result.mermaidSource).toContain('Begin');
            expect(result.mermaidSource).toContain('Do Work');
        });
    });
});
