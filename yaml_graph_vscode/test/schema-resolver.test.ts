/**
 * Tests for SchemaResolver — JSON Schema $ref resolution and FieldSchema building.
 */

import { describe, it, expect } from 'vitest';
import { SchemaResolver, type JsonSchemaNode } from '../src/schema-resolver.js';

// ─── Test schemas ───────────────────────────────────────────

const flowchartSchema: JsonSchemaNode = {
    type: 'object',
    required: ['meta', 'nodes', 'edges'],
    properties: {
        meta: {
            type: 'object',
            required: ['id', 'title', 'graph-version'],
            properties: {
                id: { type: 'string', description: 'Unique diagram identifier' },
                title: { type: 'string' },
                'graph-version': { type: 'integer', minimum: 1 },
                direction: { type: 'string', enum: ['TD', 'LR', 'BT', 'RL'] },
                description: { type: 'string', format: 'multiline' },
            },
        },
        nodes: {
            type: 'object',
            additionalProperties: { $ref: '#/$defs/node' },
        },
        edges: {
            type: 'array',
            items: { $ref: '#/$defs/edge' },
        },
    },
    $defs: {
        node: {
            type: 'object',
            required: ['type', 'label'],
            properties: {
                type: { type: 'string', enum: ['start', 'end', 'process', 'decision', 'subprocess'] },
                label: { type: 'string' },
                status: { type: 'string', enum: ['planned', 'implemented', 'deprecated'] },
                owner: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                description: { type: 'string' },
            },
        },
        edge: {
            type: 'object',
            required: ['from', 'to'],
            properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                label: { type: 'string' },
                style: { type: 'string', enum: ['default', 'dotted', 'thick'] },
            },
        },
    },
};

const erSchema: JsonSchemaNode = {
    type: 'object',
    required: ['meta', 'entities'],
    properties: {
        meta: {
            type: 'object',
            properties: {
                id: { type: 'string' },
                title: { type: 'string' },
            },
        },
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
                    items: { $ref: '#/$defs/attribute' },
                    minItems: 1,
                },
                description: { type: 'string' },
            },
        },
        attribute: {
            type: 'object',
            required: ['name', 'type'],
            properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                key: { type: 'string', enum: ['PK', 'FK', 'UK'] },
                nullable: { type: 'boolean' },
            },
        },
    },
};

const schemaWithWidgets: JsonSchemaNode = {
    type: 'object',
    properties: {
        nodes: {
            type: 'object',
            additionalProperties: {
                type: 'object',
                properties: {
                    color: { type: 'string', 'x-widget': 'color-picker', description: 'Node color' },
                    code: { type: 'string', 'x-widget': 'code', format: 'multiline' },
                    priority: { type: 'integer', minimum: 1, maximum: 5, title: 'Priority Level' },
                },
            },
        },
    },
};

// ─── Tests ──────────────────────────────────────────────────

describe('SchemaResolver', () => {
    describe('resolveRef', () => {
        it('resolves $defs reference', () => {
            const resolver = new SchemaResolver(flowchartSchema);
            const schema: JsonSchemaNode = { $ref: '#/$defs/node' };
            const resolved = resolver.resolveRef(schema);
            expect(resolved.type).toBe('object');
            expect(resolved.required).toContain('type');
            expect(resolved.required).toContain('label');
        });

        it('returns same schema when no $ref', () => {
            const resolver = new SchemaResolver(flowchartSchema);
            const schema: JsonSchemaNode = { type: 'string' };
            const resolved = resolver.resolveRef(schema);
            expect(resolved).toBe(schema);
        });

        it('throws for unresolved $ref', () => {
            const resolver = new SchemaResolver(flowchartSchema);
            const schema: JsonSchemaNode = { $ref: '#/$defs/nonExistent' };
            expect(() => resolver.resolveRef(schema)).toThrow('Unresolved $ref');
        });

        it('throws for unsupported $ref format', () => {
            const resolver = new SchemaResolver(flowchartSchema);
            const schema: JsonSchemaNode = { $ref: 'http://external.com/schema' };
            expect(() => resolver.resolveRef(schema)).toThrow('Unsupported $ref format');
        });

        it('merges sibling properties with resolved ref', () => {
            const resolver = new SchemaResolver(flowchartSchema);
            const schema: JsonSchemaNode = {
                $ref: '#/$defs/node',
                description: 'Extended description',
            };
            const resolved = resolver.resolveRef(schema);
            expect(resolved.description).toBe('Extended description');
            expect(resolved.properties?.type).toBeDefined();
        });

        it('resolves nested $defs correctly', () => {
            const resolver = new SchemaResolver(erSchema);
            const schema: JsonSchemaNode = { $ref: '#/$defs/attribute' };
            const resolved = resolver.resolveRef(schema);
            expect(resolved.required).toContain('name');
            expect(resolved.required).toContain('type');
        });
    });

    describe('extractNodeSubSchema', () => {
        it('extracts node sub-schema from nodes section (additionalProperties)', () => {
            const resolver = new SchemaResolver(flowchartSchema);
            const subSchema = resolver.extractNodeSubSchema('nodes');
            expect(subSchema).toBeDefined();
            expect(subSchema!.required).toContain('type');
            expect(subSchema!.required).toContain('label');
        });

        it('extracts entity sub-schema from entities section', () => {
            const resolver = new SchemaResolver(erSchema);
            const subSchema = resolver.extractNodeSubSchema('entities');
            expect(subSchema).toBeDefined();
            expect(subSchema!.properties?.attributes).toBeDefined();
        });

        it('extracts edge sub-schema from edges (array items)', () => {
            const resolver = new SchemaResolver(flowchartSchema);
            const subSchema = resolver.extractNodeSubSchema('edges');
            expect(subSchema).toBeDefined();
            expect(subSchema!.required).toContain('from');
            expect(subSchema!.required).toContain('to');
        });

        it('returns undefined for non-existent path', () => {
            const resolver = new SchemaResolver(flowchartSchema);
            expect(resolver.extractNodeSubSchema('nonExistent')).toBeUndefined();
        });

        it('returns undefined for deeply non-existent path', () => {
            const resolver = new SchemaResolver(flowchartSchema);
            expect(resolver.extractNodeSubSchema('meta.nonExistent.deep')).toBeUndefined();
        });

        it('extracts meta sub-schema', () => {
            const resolver = new SchemaResolver(flowchartSchema);
            const subSchema = resolver.extractNodeSubSchema('meta');
            expect(subSchema).toBeDefined();
            expect(subSchema!.properties?.id).toBeDefined();
            expect(subSchema!.properties?.title).toBeDefined();
        });
    });

    describe('buildFieldSchemas — flowchart node', () => {
        const resolver = new SchemaResolver(flowchartSchema);
        const nodeSchema = resolver.extractNodeSubSchema('nodes')!;
        const fields = resolver.buildFieldSchemas(nodeSchema);

        it('produces fields for all node properties', () => {
            expect(fields.length).toBeGreaterThanOrEqual(4);
        });

        it('type field is an enum', () => {
            const shapeField = fields.find(f => f.path === 'type');
            expect(shapeField).toBeDefined();
            expect(shapeField!.fieldType).toBe('enum');
            if (shapeField!.fieldType === 'enum') {
                expect(shapeField!.options).toContain('process');
                expect(shapeField!.options).toContain('decision');
            }
        });

        it('label field is a string', () => {
            const labelField = fields.find(f => f.path === 'label');
            expect(labelField).toBeDefined();
            expect(labelField!.fieldType).toBe('string');
        });

        it('status field is an enum', () => {
            const statusField = fields.find(f => f.path === 'status');
            expect(statusField).toBeDefined();
            expect(statusField!.fieldType).toBe('enum');
        });

        it('tags field is an array', () => {
            const tagsField = fields.find(f => f.path === 'tags');
            expect(tagsField).toBeDefined();
            expect(tagsField!.fieldType).toBe('array');
            if (tagsField!.fieldType === 'array') {
                expect(tagsField!.itemSchema.fieldType).toBe('string');
            }
        });

        it('required fields are marked correctly', () => {
            const shapeField = fields.find(f => f.path === 'type');
            const labelField = fields.find(f => f.path === 'label');
            const ownerField = fields.find(f => f.path === 'owner');
            expect(shapeField!.required).toBe(true);
            expect(labelField!.required).toBe(true);
            expect(ownerField!.required).toBe(false);
        });
    });

    describe('buildFieldSchemas — ER entity (nested)', () => {
        const resolver = new SchemaResolver(erSchema);
        const entitySchema = resolver.extractNodeSubSchema('entities')!;
        const fields = resolver.buildFieldSchemas(entitySchema);

        it('attributes field is an array', () => {
            const attrsField = fields.find(f => f.path === 'attributes');
            expect(attrsField).toBeDefined();
            expect(attrsField!.fieldType).toBe('array');
        });

        it('attribute items are objects with correct properties', () => {
            const attrsField = fields.find(f => f.path === 'attributes');
            if (attrsField?.fieldType === 'array') {
                expect(attrsField.itemSchema.fieldType).toBe('object');
                if (attrsField.itemSchema.fieldType === 'object') {
                    const propPaths = attrsField.itemSchema.properties.map(p => p.path);
                    expect(propPaths).toContain('attributes[].name');
                    expect(propPaths).toContain('attributes[].type');
                    expect(propPaths).toContain('attributes[].key');
                    expect(propPaths).toContain('attributes[].nullable');
                }
            }
        });

        it('attribute key field is an enum', () => {
            const attrsField = fields.find(f => f.path === 'attributes');
            if (attrsField?.fieldType === 'array' && attrsField.itemSchema.fieldType === 'object') {
                const keyField = attrsField.itemSchema.properties.find(p => p.path === 'attributes[].key');
                expect(keyField?.fieldType).toBe('enum');
            }
        });

        it('attribute nullable field is a boolean', () => {
            const attrsField = fields.find(f => f.path === 'attributes');
            if (attrsField?.fieldType === 'array' && attrsField.itemSchema.fieldType === 'object') {
                const nullableField = attrsField.itemSchema.properties.find(p => p.path === 'attributes[].nullable');
                expect(nullableField?.fieldType).toBe('boolean');
            }
        });

        it('array has minItems from schema', () => {
            const attrsField = fields.find(f => f.path === 'attributes');
            if (attrsField?.fieldType === 'array') {
                expect(attrsField.minItems).toBe(1);
            }
        });
    });

    describe('buildFieldSchemas — meta section', () => {
        const resolver = new SchemaResolver(flowchartSchema);
        const metaSchema = resolver.extractNodeSubSchema('meta')!;
        const fields = resolver.buildFieldSchemas(metaSchema);

        it('direction field is an enum', () => {
            const dirField = fields.find(f => f.path === 'direction');
            expect(dirField).toBeDefined();
            expect(dirField!.fieldType).toBe('enum');
            if (dirField!.fieldType === 'enum') {
                expect(dirField!.options).toEqual(['TD', 'LR', 'BT', 'RL']);
            }
        });

        it('graph-version field is a number', () => {
            const versionField = fields.find(f => f.path === 'graph-version');
            expect(versionField).toBeDefined();
            expect(versionField!.fieldType).toBe('number');
            if (versionField!.fieldType === 'number') {
                expect(versionField!.minimum).toBe(1);
            }
        });

        it('description field has multiline format', () => {
            const descField = fields.find(f => f.path === 'description');
            expect(descField).toBeDefined();
            expect(descField!.fieldType).toBe('string');
            if (descField!.fieldType === 'string') {
                expect(descField!.multiline).toBe(true);
            }
        });

        it('required fields from meta are marked', () => {
            const idField = fields.find(f => f.path === 'id');
            const titleField = fields.find(f => f.path === 'title');
            const descField = fields.find(f => f.path === 'description');
            expect(idField!.required).toBe(true);
            expect(titleField!.required).toBe(true);
            expect(descField!.required).toBe(false);
        });
    });

    describe('buildFieldSchemas — x-widget support', () => {
        const resolver = new SchemaResolver(schemaWithWidgets);
        const nodeSchema = resolver.extractNodeSubSchema('nodes')!;
        const fields = resolver.buildFieldSchemas(nodeSchema);

        it('color field has color-picker widget', () => {
            const colorField = fields.find(f => f.path === 'color');
            expect(colorField?.xWidget).toBe('color-picker');
        });

        it('code field has code widget and multiline', () => {
            const codeField = fields.find(f => f.path === 'code');
            expect(codeField?.xWidget).toBe('code');
            if (codeField?.fieldType === 'string') {
                expect(codeField.multiline).toBe(true);
            }
        });

        it('priority field has min/max constraints', () => {
            const priorityField = fields.find(f => f.path === 'priority');
            expect(priorityField?.fieldType).toBe('number');
            if (priorityField?.fieldType === 'number') {
                expect(priorityField.minimum).toBe(1);
                expect(priorityField.maximum).toBe(5);
            }
        });

        it('priority field uses title as label', () => {
            const priorityField = fields.find(f => f.path === 'priority');
            expect(priorityField?.label).toBe('Priority Level');
        });
    });

    describe('buildFieldSchemas with basePath', () => {
        it('prefixes field paths with basePath', () => {
            const resolver = new SchemaResolver(flowchartSchema);
            const nodeSchema = resolver.extractNodeSubSchema('nodes')!;
            const fields = resolver.buildFieldSchemas(nodeSchema, 'nodes.myNode');
            const shapeField = fields.find(f => f.path === 'nodes.myNode.type');
            expect(shapeField).toBeDefined();
        });
    });

    describe('humanizeLabel', () => {
        const resolver = new SchemaResolver({ type: 'object' });

        it('converts kebab-case to title case', () => {
            expect(resolver.humanizeLabel('graph-version')).toBe('Graph version');
        });

        it('converts camelCase to spaced words', () => {
            expect(resolver.humanizeLabel('mermaidType')).toBe('Mermaid Type');
        });

        it('capitalizes first letter', () => {
            expect(resolver.humanizeLabel('name')).toBe('Name');
        });

        it('handles underscores', () => {
            expect(resolver.humanizeLabel('source_path')).toBe('Source path');
        });
    });

    describe('edge cases', () => {
        it('handles empty schema', () => {
            const resolver = new SchemaResolver({ type: 'object' });
            const fields = resolver.buildFieldSchemas({ type: 'object' });
            expect(fields).toEqual([]);
        });

        it('handles schema with no $defs', () => {
            const schema: JsonSchemaNode = {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                },
            };
            const resolver = new SchemaResolver(schema);
            const fields = resolver.buildFieldSchemas(schema);
            expect(fields).toHaveLength(1);
            expect(fields[0]!.path).toBe('name');
        });

        it('handles unknown type gracefully', () => {
            const schema: JsonSchemaNode = {
                type: 'object',
                properties: {
                    unknown: { type: 'null' as any },
                    valid: { type: 'string' },
                },
            };
            const resolver = new SchemaResolver(schema);
            const fields = resolver.buildFieldSchemas(schema);
            // Unknown type skipped, valid string included
            expect(fields).toHaveLength(1);
            expect(fields[0]!.path).toBe('valid');
        });

        it('object field tracks allowAdditional', () => {
            const schema: JsonSchemaNode = {
                type: 'object',
                properties: {
                    metadata: {
                        type: 'object',
                        additionalProperties: true,
                        properties: {
                            tag: { type: 'string' },
                        },
                    },
                },
            };
            const resolver = new SchemaResolver(schema);
            const fields = resolver.buildFieldSchemas(schema);
            const metaField = fields.find(f => f.path === 'metadata');
            expect(metaField?.fieldType).toBe('object');
            if (metaField?.fieldType === 'object') {
                expect(metaField.allowAdditional).toBe(true);
            }
        });
    });
});
