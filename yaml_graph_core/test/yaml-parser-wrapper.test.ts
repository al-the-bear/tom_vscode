import { describe, it, expect } from 'vitest';
import { YamlParserWrapper } from '../src/yaml-parser-wrapper.js';

describe('YamlParserWrapper', () => {
    const wrapper = new YamlParserWrapper();

    // ================================================================
    // parse()
    // ================================================================
    describe('parse()', () => {
        it('should parse simple YAML into data and document', () => {
            const yaml = `name: hello\nvalue: 42\n`;
            const result = wrapper.parse(yaml);

            expect(result.data).toEqual({ name: 'hello', value: 42 });
            expect(result.document).toBeDefined();
            expect(result.text).toBe(yaml);
        });

        it('should parse nested YAML objects', () => {
            const yaml = `
meta:
  id: test
  title: Test
nodes:
  start:
    type: start
    label: Begin
`.trimStart();
            const result = wrapper.parse(yaml);

            expect(result.data.meta).toEqual({ id: 'test', title: 'Test' });
            expect((result.data.nodes as any).start.type).toBe('start');
            expect((result.data.nodes as any).start.label).toBe('Begin');
        });

        it('should parse arrays', () => {
            const yaml = `items:\n  - one\n  - two\n  - three\n`;
            const result = wrapper.parse(yaml);

            expect(result.data.items).toEqual(['one', 'two', 'three']);
        });

        it('should parse YAML with inline comments (comments preserved in AST)', () => {
            const yaml = `# A comment\nname: hello  # inline comment\n`;
            const result = wrapper.parse(yaml);

            expect(result.data.name).toBe('hello');
            // The AST document preserves comments
            const output = result.document.toString();
            expect(output).toContain('# A comment');
            expect(output).toContain('# inline comment');
        });

        it('should parse empty YAML', () => {
            const result = wrapper.parse('');
            expect(result.data).toBeNull();
        });

        it('should parse YAML with mixed types', () => {
            const yaml = `
str: hello
num: 42
float: 3.14
bool: true
null_val: null
`.trimStart();
            const result = wrapper.parse(yaml);
            expect(result.data.str).toBe('hello');
            expect(result.data.num).toBe(42);
            expect(result.data.float).toBe(3.14);
            expect(result.data.bool).toBe(true);
            expect(result.data.null_val).toBeNull();
        });

        it('should handle multi-line strings', () => {
            const yaml = `description: |\n  Line one\n  Line two\n`;
            const result = wrapper.parse(yaml);
            expect(result.data.description).toBe('Line one\nLine two\n');
        });
    });

    // ================================================================
    // getSourceRange()
    // ================================================================
    describe('getSourceRange()', () => {
        it('should return source range for a top-level scalar', () => {
            const yaml = `name: hello\nvalue: 42\n`;
            const parsed = wrapper.parse(yaml);

            const range = wrapper.getSourceRange(parsed, 'name');
            expect(range).toBeDefined();
            expect(range!.startOffset).toBeGreaterThanOrEqual(0);
            expect(range!.endOffset).toBeGreaterThan(range!.startOffset);

            // The value "hello" should be within the range
            const slice = yaml.slice(range!.startOffset, range!.endOffset);
            expect(slice).toBe('hello');
        });

        it('should return source range for nested value', () => {
            const yaml = `meta:\n  id: test\n  title: My Title\n`;
            const parsed = wrapper.parse(yaml);

            const range = wrapper.getSourceRange(parsed, 'meta.title');
            expect(range).toBeDefined();
            const slice = yaml.slice(range!.startOffset, range!.endOffset);
            expect(slice).toBe('My Title');
        });

        it('should return source range for array item', () => {
            const yaml = `edges:\n  - from: A\n    to: B\n  - from: C\n    to: D\n`;
            const parsed = wrapper.parse(yaml);

            // Array items are accessed by numeric index
            const range = wrapper.getSourceRange(parsed, 'edges.1');
            expect(range).toBeDefined();
        });

        it('should return undefined for non-existent path', () => {
            const yaml = `name: hello\n`;
            const parsed = wrapper.parse(yaml);

            const range = wrapper.getSourceRange(parsed, 'nonexistent.path');
            expect(range).toBeUndefined();
        });

        it('should handle deeply nested paths', () => {
            const yaml = `a:\n  b:\n    c:\n      d: deep\n`;
            const parsed = wrapper.parse(yaml);

            const range = wrapper.getSourceRange(parsed, 'a.b.c.d');
            expect(range).toBeDefined();
            const slice = yaml.slice(range!.startOffset, range!.endOffset);
            expect(slice).toBe('deep');
        });
    });

    // ================================================================
    // getMapEntryRange()
    // ================================================================
    describe('getMapEntryRange()', () => {
        it('should return range covering key + value for a map entry', () => {
            const yaml = `nodes:\n  start:\n    type: start\n    label: Begin\n  end:\n    type: end\n    label: Finish\n`;
            const parsed = wrapper.parse(yaml);

            const range = wrapper.getMapEntryRange(parsed, 'nodes.start');
            expect(range).toBeDefined();
            const slice = yaml.slice(range!.startOffset, range!.endOffset);
            expect(slice).toContain('start');
            expect(slice).toContain('type: start');
            expect(slice).toContain('label: Begin');
        });

        it('should return undefined for empty path', () => {
            const yaml = `name: hello\n`;
            const parsed = wrapper.parse(yaml);
            expect(wrapper.getMapEntryRange(parsed, '')).toBeUndefined();
        });

        it('should return undefined for non-existent key', () => {
            const yaml = `name: hello\n`;
            const parsed = wrapper.parse(yaml);
            expect(wrapper.getMapEntryRange(parsed, 'nonexistent')).toBeUndefined();
        });

        it('should return range for top-level entry', () => {
            const yaml = `name: hello\nvalue: 42\n`;
            const parsed = wrapper.parse(yaml);

            const range = wrapper.getMapEntryRange(parsed, 'name');
            expect(range).toBeDefined();
            // Should cover "name" key and "hello" value
        });

        it('should return range spanning multi-line block value', () => {
            const yaml = `nodes:\n  checkout:\n    type: process\n    label: Checkout\n    status: implemented\n`;
            const parsed = wrapper.parse(yaml);

            const range = wrapper.getMapEntryRange(parsed, 'nodes.checkout');
            expect(range).toBeDefined();
            const slice = yaml.slice(range!.startOffset, range!.endOffset);
            expect(slice).toContain('checkout');
            expect(slice).toContain('status: implemented');
        });
    });

    // ================================================================
    // editValue()
    // ================================================================
    describe('editValue()', () => {
        it('should edit a scalar value', () => {
            const yaml = `name: hello\nvalue: 42\n`;
            const parsed = wrapper.parse(yaml);

            const result = wrapper.editValue(parsed, 'name', 'world');
            expect(result).toContain('name: world');
            expect(result).toContain('value: 42');
        });

        it('should edit a nested value', () => {
            const yaml = `meta:\n  id: test\n  title: Old Title\n`;
            const parsed = wrapper.parse(yaml);

            const result = wrapper.editValue(parsed, 'meta.title', 'New Title');
            expect(result).toContain('title: New Title');
            expect(result).toContain('id: test');
        });

        it('should preserve comments when editing', () => {
            const yaml = `# Top comment\nname: hello  # inline\nvalue: 42\n`;
            const parsed = wrapper.parse(yaml);

            const result = wrapper.editValue(parsed, 'name', 'world');
            expect(result).toContain('# Top comment');
            expect(result).toContain('# inline');
            expect(result).toContain('name: world');
        });

        it('should edit a number value', () => {
            const yaml = `count: 10\n`;
            const parsed = wrapper.parse(yaml);

            const result = wrapper.editValue(parsed, 'count', 20);
            expect(result).toContain('count: 20');
        });

        it('should edit a boolean value', () => {
            const yaml = `enabled: true\n`;
            const parsed = wrapper.parse(yaml);

            const result = wrapper.editValue(parsed, 'enabled', false);
            expect(result).toContain('enabled: false');
        });

        it('should set value to null', () => {
            const yaml = `name: hello\n`;
            const parsed = wrapper.parse(yaml);

            const result = wrapper.editValue(parsed, 'name', null);
            expect(result).toContain('name: null');
        });
    });

    // ================================================================
    // addMapEntry()
    // ================================================================
    describe('addMapEntry()', () => {
        it('should add a new entry to a map', () => {
            const yaml = `nodes:\n  start:\n    type: start\n    label: Begin\n`;
            const parsed = wrapper.parse(yaml);

            const result = wrapper.addMapEntry(parsed, 'nodes', 'end', {
                type: 'end',
                label: 'Finish'
            });

            expect(result).toContain('start:');
            expect(result).toContain('end:');
            expect(result).toContain('type: end');
            expect(result).toContain('label: Finish');
        });

        it('should add entry to top-level map', () => {
            const yaml = `name: hello\n`;
            const parsed = wrapper.parse(yaml);

            const result = wrapper.addMapEntry(parsed, '', 'meta', {
                id: 'test'
            });

            expect(result).toContain('name: hello');
            expect(result).toContain('meta:');
            expect(result).toContain('id: test');
        });

        it('should preserve existing entries and comments', () => {
            const yaml = `# Nodes section\nnodes:\n  start:\n    type: start\n    label: Begin  # begin label\n`;
            const parsed = wrapper.parse(yaml);

            const result = wrapper.addMapEntry(parsed, 'nodes', 'end', {
                type: 'end',
                label: 'Finish'
            });

            expect(result).toContain('# Nodes section');
            expect(result).toContain('# begin label');
            expect(result).toContain('end:');
        });
    });

    // ================================================================
    // appendToSequence()
    // ================================================================
    describe('appendToSequence()', () => {
        it('should append an item to a sequence', () => {
            const yaml = `edges:\n  - from: A\n    to: B\n`;
            const parsed = wrapper.parse(yaml);

            const result = wrapper.appendToSequence(parsed, 'edges', {
                from: 'B',
                to: 'C'
            });

            expect(result).toContain('from: A');
            expect(result).toContain('to: B');
            expect(result).toContain('from: B');
            expect(result).toContain('to: C');
        });

        it('should append to empty sequence', () => {
            const yaml = `edges: []\n`;
            const parsed = wrapper.parse(yaml);

            const result = wrapper.appendToSequence(parsed, 'edges', {
                from: 'X',
                to: 'Y'
            });

            expect(result).toContain('from: X');
            expect(result).toContain('to: Y');
        });

        it('should not modify document if path is not a sequence', () => {
            const yaml = `nodes:\n  start:\n    type: start\n`;
            const parsed = wrapper.parse(yaml);

            // 'nodes' is a map, not a sequence
            const result = wrapper.appendToSequence(parsed, 'nodes', {
                from: 'X'
            });

            // Should return the original
            const reparsed = wrapper.parse(result);
            expect(reparsed.data.nodes).toBeDefined();
        });
    });

    // ================================================================
    // deleteEntry()
    // ================================================================
    describe('deleteEntry()', () => {
        it('should delete a map entry', () => {
            const yaml = `nodes:\n  start:\n    type: start\n  end:\n    type: end\n`;
            const parsed = wrapper.parse(yaml);

            const result = wrapper.deleteEntry(parsed, 'nodes.start');
            expect(result).not.toContain('type: start');
            expect(result).toContain('end:');
            expect(result).toContain('type: end');
        });

        it('should delete a top-level entry', () => {
            const yaml = `name: hello\nvalue: 42\n`;
            const parsed = wrapper.parse(yaml);

            const result = wrapper.deleteEntry(parsed, 'name');
            expect(result).not.toContain('name');
            expect(result).toContain('value: 42');
        });

        it('should delete an array item by index', () => {
            const yaml = `edges:\n  - from: A\n    to: B\n  - from: C\n    to: D\n`;
            const parsed = wrapper.parse(yaml);

            const result = wrapper.deleteEntry(parsed, 'edges.0');
            expect(result).not.toContain('from: A');
            expect(result).toContain('from: C');
        });
    });

    // ================================================================
    // Round-trip: edit + re-parse
    // ================================================================
    describe('round-trip editing', () => {
        it('should produce valid YAML after edits', () => {
            const yaml = `meta:\n  id: test\n  title: Original\nnodes:\n  a:\n    type: process\n    label: Step A\nedges:\n  - from: a\n    to: b\n`;
            let parsed = wrapper.parse(yaml);

            // Edit title
            let result = wrapper.editValue(parsed, 'meta.title', 'Modified');
            parsed = wrapper.parse(result);
            expect(parsed.data.meta).toEqual(expect.objectContaining({ title: 'Modified' }));

            // Add a node
            result = wrapper.addMapEntry(parsed, 'nodes', 'b', {
                type: 'process',
                label: 'Step B'
            });
            parsed = wrapper.parse(result);
            expect((parsed.data.nodes as any).b.label).toBe('Step B');

            // Append an edge
            result = wrapper.appendToSequence(parsed, 'edges', {
                from: 'b',
                to: 'c'
            });
            parsed = wrapper.parse(result);
            expect((parsed.data.edges as any[]).length).toBe(2);
        });

        it('should preserve comments through multiple edits', () => {
            const yaml = `# Header comment\nmeta:\n  id: test  # id comment\n  title: Original\n`;
            let parsed = wrapper.parse(yaml);

            let result = wrapper.editValue(parsed, 'meta.title', 'First Edit');
            parsed = wrapper.parse(result);

            result = wrapper.editValue(parsed, 'meta.id', 'modified');
            expect(result).toContain('# Header comment');
            expect(result).toContain('# id comment');
        });
    });
});
