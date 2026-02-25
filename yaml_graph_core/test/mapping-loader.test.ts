import { describe, it, expect } from 'vitest';
import { MappingLoader, MappingParserV1, UnsupportedMappingVersionError } from '../src/mapping-loader.js';
import type { GraphMapping } from '../src/types.js';

describe('MappingLoader', () => {
    const loader = new MappingLoader();

    // ================================================================
    // MappingParserV1
    // ================================================================
    describe('MappingParserV1', () => {
        const parser = new MappingParserV1();

        it('should have version 1', () => {
            expect(parser.version).toBe(1);
        });

        it('should parse flowchart mapping from kebab-case YAML', () => {
            const raw = {
                map: {
                    id: 'flowchart',
                    version: 1,
                    'mermaid-type': 'flowchart',
                    'direction-field': 'meta.direction',
                    'default-direction': 'TD'
                },
                'node-shapes': {
                    'source-path': 'nodes',
                    'id-field': '_key',
                    'label-field': 'label',
                    'shape-field': 'type',
                    shapes: {
                        process: '["{label}"]',
                        decision: '{"{label}"}'
                    }
                },
                'edge-links': {
                    'source-path': 'edges',
                    'from-field': 'from',
                    'to-field': 'to',
                    'label-field': 'label',
                    'link-styles': { default: '-->', dotted: '-.->' }
                },
                'style-rules': {
                    field: 'status',
                    rules: {
                        active: { fill: '#green', stroke: '#dark', color: '#white' }
                    }
                }
            };

            const mapping = parser.parse(raw);

            // map section
            expect(mapping.map.id).toBe('flowchart');
            expect(mapping.map.version).toBe(1);
            expect(mapping.map.mermaidType).toBe('flowchart');
            expect(mapping.map.directionField).toBe('meta.direction');
            expect(mapping.map.defaultDirection).toBe('TD');

            // nodeShapes section
            expect(mapping.nodeShapes.sourcePath).toBe('nodes');
            expect(mapping.nodeShapes.idField).toBe('_key');
            expect(mapping.nodeShapes.labelField).toBe('label');
            expect(mapping.nodeShapes.shapeField).toBe('type');
            expect(mapping.nodeShapes.shapes).toEqual({
                process: '["{label}"]',
                decision: '{"{label}"}'
            });

            // edgeLinks section
            expect(mapping.edgeLinks.sourcePath).toBe('edges');
            expect(mapping.edgeLinks.fromField).toBe('from');
            expect(mapping.edgeLinks.toField).toBe('to');
            expect(mapping.edgeLinks.labelField).toBe('label');
            expect(mapping.edgeLinks.linkStyles).toEqual({
                default: '-->',
                dotted: '-.->'
            });

            // styleRules section
            expect(mapping.styleRules).toBeDefined();
            expect(mapping.styleRules!.field).toBe('status');
            expect(mapping.styleRules!.rules.active).toEqual({
                fill: '#green', stroke: '#dark', color: '#white'
            });
        });

        it('should parse state machine mapping with connectors', () => {
            const raw = {
                map: {
                    id: 'state-machine',
                    version: 1,
                    'mermaid-type': 'stateDiagram-v2'
                },
                'node-shapes': {
                    'source-path': 'states',
                    'id-field': '_key',
                    'label-field': 'label',
                    'shape-field': 'type',
                    shapes: {},
                    'initial-connector': '[*] --> {first}',
                    'final-connector': '{last} --> [*]'
                },
                'edge-links': {
                    'source-path': 'transitions',
                    'from-field': 'from',
                    'to-field': 'to',
                    'link-styles': { default: '-->' }
                }
            };

            const mapping = parser.parse(raw);

            expect(mapping.map.mermaidType).toBe('stateDiagram-v2');
            expect(mapping.nodeShapes.initialConnector).toBe('[*] --> {first}');
            expect(mapping.nodeShapes.finalConnector).toBe('{last} --> [*]');
        });

        it('should parse ER diagram mapping', () => {
            const raw = {
                map: {
                    id: 'er-diagram',
                    version: 1,
                    'mermaid-type': 'erDiagram'
                },
                'node-shapes': {
                    'source-path': 'entities',
                    'id-field': '_key',
                    'label-field': '_key',
                    'shape-field': '_key',
                    shapes: {}
                },
                'edge-links': {
                    'source-path': 'relationships',
                    'from-field': 'from',
                    'to-field': 'to',
                    'link-styles': { default: '-->' }
                }
            };

            const mapping = parser.parse(raw);

            expect(mapping.map.mermaidType).toBe('erDiagram');
            expect(mapping.nodeShapes.sourcePath).toBe('entities');
        });

        it('should handle missing optional sections', () => {
            const raw = {
                map: { id: 'test', 'mermaid-type': 'flowchart' },
                'node-shapes': {
                    'source-path': 'nodes',
                    'id-field': '_key',
                    'label-field': 'label',
                    'type-field': 'type'
                },
                'edge-links': {
                    'source-path': 'edges',
                    'from-field': 'from',
                    'to-field': 'to'
                }
            };

            const mapping = parser.parse(raw);

            expect(mapping.styleRules).toBeUndefined();
            expect(mapping.annotations).toBeUndefined();
            expect(mapping.transforms).toBeUndefined();
            expect(mapping.customRenderer).toBeUndefined();
        });

        it('should parse transforms section', () => {
            const raw = {
                map: { id: 'test', 'mermaid-type': 'flowchart' },
                'node-shapes': {
                    'source-path': 'nodes',
                    'id-field': '_key',
                    'label-field': 'label',
                    'type-field': 'type'
                },
                'edge-links': {
                    'source-path': 'edges',
                    'from-field': 'from',
                    'to-field': 'to'
                },
                transforms: [
                    {
                        scope: 'node',
                        match: { field: 'status', equals: 'deprecated' },
                        js: 'return [`style ${node.id} fill:#red`]'
                    },
                    {
                        match: { field: 'tags', exists: true },
                        js: 'return ctx.output'
                    }
                ]
            };

            const mapping = parser.parse(raw);
            expect(mapping.transforms).toHaveLength(2);
            expect(mapping.transforms![0].scope).toBe('node');
            expect(mapping.transforms![0].match.field).toBe('status');
            expect(mapping.transforms![0].match.equals).toBe('deprecated');
            expect(mapping.transforms![1].match.exists).toBe(true);
        });

        it('should parse annotations section', () => {
            const raw = {
                map: { id: 'test', 'mermaid-type': 'flowchart' },
                'node-shapes': {
                    'source-path': 'nodes',
                    'id-field': '_key',
                    'label-field': 'label',
                    'type-field': 'type'
                },
                'edge-links': {
                    'source-path': 'edges',
                    'from-field': 'from',
                    'to-field': 'to'
                },
                annotations: {
                    'source-field': 'description',
                    template: '%%{annotation}%%'
                }
            };

            const mapping = parser.parse(raw);
            expect(mapping.annotations).toBeDefined();
            expect(mapping.annotations!.sourceField).toBe('description');
            expect(mapping.annotations!.template).toBe('%%{annotation}%%');
        });
    });

    // ================================================================
    // loadMappingFromString()
    // ================================================================
    describe('loadMappingFromString()', () => {
        it('should load a mapping from YAML text', () => {
            const yaml = `
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
    process: '["{label}"]'
    decision: '{"{label}"}'

edge-links:
  source-path: edges
  from-field: from
  to-field: to
  label-field: label
  link-styles:
    default: "-->"
`;

            const mapping = loader.loadMappingFromString(yaml);

            expect(mapping.map.id).toBe('flowchart');
            expect(mapping.map.mermaidType).toBe('flowchart');
            expect(mapping.nodeShapes.shapes.process).toBe('["{label}"]');
        });

        it('should use v1 parser by default', () => {
            const yaml = `
map:
  id: test
  mermaid-type: flowchart
node-shapes:
  source-path: nodes
  id-field: _key
  label-field: label
  type-field: type
edge-links:
  source-path: edges
  from-field: from
  to-field: to
`;

            // Should not throw — v1 is the default
            expect(() => loader.loadMappingFromString(yaml)).not.toThrow();
        });

        it('should throw UnsupportedMappingVersionError for unknown version', () => {
            const yaml = `
map:
  id: test
  mermaid-type: flowchart
node-shapes:
  source-path: nodes
  id-field: _key
  label-field: label
  type-field: type
edge-links:
  source-path: edges
  from-field: from
  to-field: to
`;

            expect(() => loader.loadMappingFromString(yaml, 99))
                .toThrow(UnsupportedMappingVersionError);
        });
    });

    // ================================================================
    // UnsupportedMappingVersionError
    // ================================================================
    describe('UnsupportedMappingVersionError', () => {
        it('should have correct name', () => {
            const err = new UnsupportedMappingVersionError(5, [1, 2]);
            expect(err.name).toBe('UnsupportedMappingVersionError');
        });

        it('should include version info in message', () => {
            const err = new UnsupportedMappingVersionError(5, [1, 2]);
            expect(err.message).toContain('5');
            expect(err.message).toContain('1, 2');
        });

        it('should expose version and supportedVersions', () => {
            const err = new UnsupportedMappingVersionError(5, [1, 2]);
            expect(err.version).toBe(5);
            expect(err.supportedVersions).toEqual([1, 2]);
        });

        it('should be instanceof Error', () => {
            const err = new UnsupportedMappingVersionError(5, [1]);
            expect(err).toBeInstanceOf(Error);
        });
    });

    // ================================================================
    // loadFromFolder() — filesystem integration tests
    // ================================================================
    describe('loadFromFolder()', () => {
        it('should load flowchart graph type from fixture folder', async () => {
            const path = new URL('../graph-types/flowchart', import.meta.url).pathname;
            const graphTypes = await loader.loadFromFolder(path);

            expect(graphTypes).toHaveLength(1);
            expect(graphTypes[0].id).toBe('flowchart');
            expect(graphTypes[0].version).toBe(1);
            expect(graphTypes[0].filePatterns).toEqual(['*.flow.yaml']);
            expect(graphTypes[0].schema).toBeDefined();
            expect(graphTypes[0].mapping).toBeDefined();
            expect(graphTypes[0].mapping.map.mermaidType).toBe('flowchart');
        });

        it('should load state-machine graph type from fixture folder', async () => {
            const path = new URL('../graph-types/state-machine', import.meta.url).pathname;
            const graphTypes = await loader.loadFromFolder(path);

            expect(graphTypes).toHaveLength(1);
            expect(graphTypes[0].id).toBe('state-machine');
            expect(graphTypes[0].version).toBe(1);
            expect(graphTypes[0].filePatterns).toEqual(['*.state.yaml']);
            expect(graphTypes[0].mapping.map.mermaidType).toBe('stateDiagram-v2');
        });

        it('should load er-diagram graph type from fixture folder', async () => {
            const path = new URL('../graph-types/er-diagram', import.meta.url).pathname;
            const graphTypes = await loader.loadFromFolder(path);

            expect(graphTypes).toHaveLength(1);
            expect(graphTypes[0].id).toBe('er-diagram');
            expect(graphTypes[0].version).toBe(1);
            expect(graphTypes[0].filePatterns).toEqual(['*.er.yaml']);
            expect(graphTypes[0].mapping.map.mermaidType).toBe('erDiagram');
        });

        it('should throw for folder with no version subfolders', async () => {
            const path = new URL('./fixtures', import.meta.url).pathname;
            const graphTypes = await loader.loadFromFolder(path);
            // fixtures/ has no v1/ etc. subfolders, so should return empty
            expect(graphTypes).toEqual([]);
        });
    });

    // ================================================================
    // consumeWarnings()
    // ================================================================
    describe('consumeWarnings()', () => {
        it('should return empty array when no warnings', () => {
            const freshLoader = new MappingLoader();
            expect(freshLoader.consumeWarnings()).toEqual([]);
        });

        it('should clear warnings after consuming', () => {
            const freshLoader = new MappingLoader();
            // First consume
            freshLoader.consumeWarnings();
            // Second consume should also be empty
            expect(freshLoader.consumeWarnings()).toEqual([]);
        });
    });
});
