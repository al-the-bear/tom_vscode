import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { GraphTypeRegistry, GraphTypeConflictError } from '../src/graph-type-registry.js';
import { MappingLoader } from '../src/mapping-loader.js';
import type { GraphType, GraphMapping } from '../src/types.js';

// ================================================================
// Test helpers
// ================================================================

function makeMapping(id: string, mermaidType: string = 'flowchart'): GraphMapping {
    return {
        map: { id, version: 1, mermaidType },
        nodeShapes: {
            sourcePath: 'nodes', idField: '_key', labelField: 'label',
            typeField: 'type', shapes: {}
        },
        edgeLinks: {
            sourcePath: 'edges', fromField: 'from', toField: 'to',
            linkStyles: { default: '-->' }
        }
    };
}

function makeGraphType(
    id: string,
    version: number,
    patterns: string[],
    mermaidType: string = 'flowchart'
): GraphType {
    return {
        id,
        version,
        filePatterns: patterns,
        schema: { type: 'object' },
        mapping: makeMapping(id, mermaidType),
    };
}

describe('GraphTypeRegistry', () => {
    let registry: GraphTypeRegistry;

    beforeEach(() => {
        registry = new GraphTypeRegistry();
    });

    // ================================================================
    // register()
    // ================================================================
    describe('register()', () => {
        it('should register a graph type', () => {
            const gt = makeGraphType('flowchart', 1, ['*.flow.yaml']);
            registry.register(gt);

            expect(registry.getAll()).toHaveLength(1);
            expect(registry.getAll()[0].id).toBe('flowchart');
        });

        it('should register multiple different graph types', () => {
            registry.register(makeGraphType('flowchart', 1, ['*.flow.yaml']));
            registry.register(makeGraphType('state-machine', 1, ['*.state.yaml']));
            registry.register(makeGraphType('er-diagram', 1, ['*.er.yaml']));

            expect(registry.getAll()).toHaveLength(3);
        });

        it('should allow multiple versions of the same type', () => {
            registry.register(makeGraphType('flowchart', 1, ['*.flow.yaml']));
            registry.register(makeGraphType('flowchart', 2, ['*.flow.yaml']));

            expect(registry.getAll()).toHaveLength(2);
            expect(registry.listVersionKeys()).toContain('flowchart@1');
            expect(registry.listVersionKeys()).toContain('flowchart@2');
        });

        it('should throw GraphTypeConflictError for different types sharing a pattern', () => {
            registry.register(makeGraphType('flowchart', 1, ['*.flow.yaml']));

            expect(() => {
                registry.register(makeGraphType('different-type', 1, ['*.flow.yaml']));
            }).toThrow(GraphTypeConflictError);
        });

        it('should expose conflict details in GraphTypeConflictError', () => {
            registry.register(makeGraphType('flowchart', 1, ['*.flow.yaml']));

            try {
                registry.register(makeGraphType('new-type', 1, ['*.flow.yaml']));
                expect.fail('Should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(GraphTypeConflictError);
                const conflict = err as GraphTypeConflictError;
                expect(conflict.newTypeId).toBe('new-type');
                expect(conflict.existingTypeId).toBe('flowchart');
                expect(conflict.pattern).toBe('*.flow.yaml');
            }
        });

        it('should update default pattern map to highest version', () => {
            registry.register(makeGraphType('flowchart', 1, ['*.flow.yaml']));
            registry.register(makeGraphType('flowchart', 3, ['*.flow.yaml']));
            registry.register(makeGraphType('flowchart', 2, ['*.flow.yaml']));

            // Default lookup should return highest version (3)
            const found = registry.getForFile('test.flow.yaml');
            expect(found).toBeDefined();
            expect(found!.version).toBe(3);
        });
    });

    // ================================================================
    // getForFile()
    // ================================================================
    describe('getForFile()', () => {
        it('should find graph type by matching file extension', () => {
            registry.register(makeGraphType('flowchart', 1, ['*.flow.yaml']));

            const found = registry.getForFile('my-diagram.flow.yaml');
            expect(found).toBeDefined();
            expect(found!.id).toBe('flowchart');
        });

        it('should return undefined for non-matching file', () => {
            registry.register(makeGraphType('flowchart', 1, ['*.flow.yaml']));

            const found = registry.getForFile('something.state.yaml');
            expect(found).toBeUndefined();
        });

        it('should match with path prefix', () => {
            registry.register(makeGraphType('er-diagram', 1, ['*.er.yaml']));

            const found = registry.getForFile('path/to/schema.er.yaml');
            expect(found).toBeDefined();
            expect(found!.id).toBe('er-diagram');
        });

        it('should return undefined when registry is empty', () => {
            expect(registry.getForFile('test.flow.yaml')).toBeUndefined();
        });

        it('should match the correct type when multiple are registered', () => {
            registry.register(makeGraphType('flowchart', 1, ['*.flow.yaml']));
            registry.register(makeGraphType('state-machine', 1, ['*.state.yaml']));
            registry.register(makeGraphType('er-diagram', 1, ['*.er.yaml']));

            expect(registry.getForFile('x.flow.yaml')?.id).toBe('flowchart');
            expect(registry.getForFile('x.state.yaml')?.id).toBe('state-machine');
            expect(registry.getForFile('x.er.yaml')?.id).toBe('er-diagram');
        });
    });

    // ================================================================
    // getForFileVersion()
    // ================================================================
    describe('getForFileVersion()', () => {
        it('should find a specific version', () => {
            registry.register(makeGraphType('flowchart', 1, ['*.flow.yaml']));
            registry.register(makeGraphType('flowchart', 2, ['*.flow.yaml']));

            const v1 = registry.getForFileVersion('test.flow.yaml', 1);
            expect(v1).toBeDefined();
            expect(v1!.version).toBe(1);

            const v2 = registry.getForFileVersion('test.flow.yaml', 2);
            expect(v2).toBeDefined();
            expect(v2!.version).toBe(2);
        });

        it('should return undefined for non-existent version', () => {
            registry.register(makeGraphType('flowchart', 1, ['*.flow.yaml']));

            expect(registry.getForFileVersion('test.flow.yaml', 99)).toBeUndefined();
        });

        it('should return undefined for non-matching file', () => {
            registry.register(makeGraphType('flowchart', 1, ['*.flow.yaml']));

            expect(registry.getForFileVersion('test.state.yaml', 1)).toBeUndefined();
        });
    });

    // ================================================================
    // getByVersionKey() and listVersionKeys()
    // ================================================================
    describe('getByVersionKey() and listVersionKeys()', () => {
        it('should retrieve by version key', () => {
            registry.register(makeGraphType('flowchart', 1, ['*.flow.yaml']));
            registry.register(makeGraphType('flowchart', 2, ['*.flow.yaml']));

            const v1 = registry.getByVersionKey('flowchart@1');
            expect(v1).toBeDefined();
            expect(v1!.version).toBe(1);
        });

        it('should return undefined for non-existent key', () => {
            expect(registry.getByVersionKey('nope@1')).toBeUndefined();
        });

        it('should list all version keys', () => {
            registry.register(makeGraphType('flowchart', 1, ['*.flow.yaml']));
            registry.register(makeGraphType('state-machine', 1, ['*.state.yaml']));

            const keys = registry.listVersionKeys();
            expect(keys).toContain('flowchart@1');
            expect(keys).toContain('state-machine@1');
        });

        it('should return empty list when registry is empty', () => {
            expect(registry.listVersionKeys()).toEqual([]);
        });
    });

    // ================================================================
    // getAll()
    // ================================================================
    describe('getAll()', () => {
        it('should return all registered types', () => {
            registry.register(makeGraphType('a', 1, ['*.a.yaml']));
            registry.register(makeGraphType('b', 1, ['*.b.yaml']));

            const all = registry.getAll();
            expect(all).toHaveLength(2);
            expect(all.map(gt => gt.id).sort()).toEqual(['a', 'b']);
        });

        it('should include all versions', () => {
            registry.register(makeGraphType('flowchart', 1, ['*.flow.yaml']));
            registry.register(makeGraphType('flowchart', 2, ['*.flow.yaml']));

            const all = registry.getAll();
            expect(all).toHaveLength(2);
            expect(all.map(gt => gt.version).sort()).toEqual([1, 2]);
        });
    });

    // ================================================================
    // GraphTypeConflictError
    // ================================================================
    describe('GraphTypeConflictError', () => {
        it('should have correct name', () => {
            const err = new GraphTypeConflictError('new', 'old', '*.flow.yaml');
            expect(err.name).toBe('GraphTypeConflictError');
        });

        it('should include type ids and pattern in message', () => {
            const err = new GraphTypeConflictError('new-type', 'existing', '*.flow.yaml');
            expect(err.message).toContain('new-type');
            expect(err.message).toContain('existing');
            expect(err.message).toContain('*.flow.yaml');
        });

        it('should be instanceof Error', () => {
            const err = new GraphTypeConflictError('a', 'b', '*.x.yaml');
            expect(err).toBeInstanceOf(Error);
        });
    });

    // ================================================================
    // registerFromFolder() — filesystem integration
    // ================================================================
    describe('registerFromFolder()', () => {
        it('should register flowchart from folder', async () => {
            const path = new URL('../graph-types/flowchart', import.meta.url).pathname;
            await registry.registerFromFolder(path);

            const found = registry.getForFile('test.flow.yaml');
            expect(found).toBeDefined();
            expect(found!.id).toBe('flowchart');
        });

        it('should register state-machine from folder', async () => {
            const path = new URL('../graph-types/state-machine', import.meta.url).pathname;
            await registry.registerFromFolder(path);

            const found = registry.getForFile('test.state.yaml');
            expect(found).toBeDefined();
            expect(found!.id).toBe('state-machine');
        });
    });

    // ================================================================
    // registerAllFromDirectory() — filesystem integration
    // ================================================================
    describe('registerAllFromDirectory()', () => {
        it('should register all graph types from the graph-types directory', async () => {
            const dirPath = new URL('../graph-types', import.meta.url).pathname;
            const errors = await registry.registerAllFromDirectory(dirPath);

            // All three types should be registered
            expect(registry.getForFile('test.flow.yaml')).toBeDefined();
            expect(registry.getForFile('test.state.yaml')).toBeDefined();
            expect(registry.getForFile('test.er.yaml')).toBeDefined();

            // Should get all three
            expect(registry.getAll()).toHaveLength(3);
        });

        it('should return errors for invalid graph-type folders', async () => {
            const dirPath = new URL('../graph-types', import.meta.url).pathname;
            const errors = await registry.registerAllFromDirectory(dirPath);

            // Our test graph-types should all be valid
            const realErrors = errors.filter(e => !e.startsWith('Warning:'));
            expect(realErrors).toEqual([]);
        });

        it('should list correct version keys after bulk registration', async () => {
            const dirPath = new URL('../graph-types', import.meta.url).pathname;
            await registry.registerAllFromDirectory(dirPath);

            const keys = registry.listVersionKeys();
            expect(keys).toContain('flowchart@1');
            expect(keys).toContain('state-machine@1');
            expect(keys).toContain('er-diagram@1');
        });
    });
});
