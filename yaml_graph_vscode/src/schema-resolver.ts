/**
 * SchemaResolver — resolves $ref pointers in JSON Schema and builds
 * FieldSchema[] trees for the node editor form renderer.
 *
 * Pure logic, no VS Code dependency. Takes a JSON Schema object and
 * produces the recursive FieldSchema tree that the webview consumes.
 */

import type { FieldSchema, ScalarFieldSchema, EnumFieldSchema, ArrayFieldSchema, ObjectFieldSchema } from './types.js';

/** A raw JSON Schema object (subset of JSON Schema Draft 2020-12). */
export interface JsonSchemaNode {
    type?: string;
    properties?: Record<string, JsonSchemaNode>;
    items?: JsonSchemaNode;
    required?: string[];
    enum?: string[];
    $ref?: string;
    $defs?: Record<string, JsonSchemaNode>;
    description?: string;
    minimum?: number;
    maximum?: number;
    minItems?: number;
    maxItems?: number;
    format?: string;
    additionalProperties?: boolean | JsonSchemaNode;
    'x-widget'?: string;
    title?: string;
    default?: unknown;
}

/**
 * Resolves $ref references within a JSON Schema and produces
 * self-contained FieldSchema[] trees for the node editor.
 */
export class SchemaResolver {
    private readonly defs: Record<string, JsonSchemaNode>;

    /**
     * @param rootSchema The root JSON Schema containing `$defs` for reference resolution.
     */
    constructor(private readonly rootSchema: JsonSchemaNode) {
        this.defs = rootSchema.$defs ?? {};
    }

    /**
     * Resolve a $ref string (e.g. "#/$defs/node") against the root schema.
     * Returns the resolved schema node, or the original if no $ref.
     */
    resolveRef(schema: JsonSchemaNode): JsonSchemaNode {
        if (!schema.$ref) return schema;

        const ref = schema.$ref;
        // Support "#/$defs/xxx" and "#/definitions/xxx" patterns
        const match = ref.match(/^#\/(\$defs|definitions)\/(.+)$/);
        if (!match) {
            throw new Error(`Unsupported $ref format: ${ref}`);
        }

        const defName = match[2]!;
        const resolved = this.defs[defName];
        if (!resolved) {
            throw new Error(`Unresolved $ref: ${ref} (definition '${defName}' not found)`);
        }

        // Merge any sibling properties from the referencing schema
        const { $ref: _, ...rest } = schema;
        return { ...resolved, ...rest };
    }

    /**
     * Extract the sub-schema for a specific node type.
     * Navigates into the root schema's properties to find the relevant section.
     *
     * @param sectionPath Dot-separated path like "nodes" or "entities"
     * @returns The resolved schema for items in that section, or undefined
     */
    extractNodeSubSchema(sectionPath: string): JsonSchemaNode | undefined {
        const segments = sectionPath.split('.');
        let current: JsonSchemaNode | undefined = this.rootSchema;

        for (const segment of segments) {
            if (!current) return undefined;
            current = this.resolveRef(current);

            if (current.properties?.[segment]) {
                current = current.properties[segment];
            } else {
                return undefined;
            }
        }

        if (!current) return undefined;
        current = this.resolveRef(current);

        // If this is an object with additionalProperties (like a keyed node map),
        // return the additionalProperties schema
        if (current.additionalProperties && typeof current.additionalProperties === 'object') {
            return this.resolveRef(current.additionalProperties);
        }

        // If this is an array, return the items schema
        if (current.type === 'array' && current.items) {
            return this.resolveRef(current.items);
        }

        return current;
    }

    /**
     * Build a FieldSchema[] tree from a JSON Schema node.
     * This is the main entry point for producing node editor form definitions.
     *
     * @param schema The JSON Schema to convert
     * @param basePath Path prefix for field paths (default: "")
     * @param requiredFields Set of required field names at this level
     */
    buildFieldSchemas(
        schema: JsonSchemaNode,
        basePath: string = '',
        requiredFields?: string[]
    ): FieldSchema[] {
        const resolved = this.resolveRef(schema);
        if (!resolved.properties) return [];

        const required = new Set(requiredFields ?? resolved.required ?? []);
        const fields: FieldSchema[] = [];

        for (const [propName, propSchema] of Object.entries(resolved.properties)) {
            const resolvedProp = this.resolveRef(propSchema);
            const path = basePath ? `${basePath}.${propName}` : propName;
            const label = resolvedProp.title ?? this.humanizeLabel(propName);
            const isRequired = required.has(propName);
            const description = resolvedProp.description;
            const xWidget = resolvedProp['x-widget'];

            const field = this.buildSingleField(
                resolvedProp, path, label, isRequired, description, xWidget
            );
            if (field) {
                fields.push(field);
            }
        }

        return fields;
    }

    /**
     * Build a single FieldSchema from a resolved JSON Schema property.
     */
    buildSingleField(
        schema: JsonSchemaNode,
        path: string,
        label: string,
        required: boolean,
        description?: string,
        xWidget?: string
    ): FieldSchema | undefined {
        // Enum takes priority over type
        if (schema.enum && schema.enum.length > 0) {
            return {
                fieldType: 'enum',
                path,
                label,
                required,
                description,
                xWidget,
                options: schema.enum,
            } satisfies EnumFieldSchema;
        }

        switch (schema.type) {
            case 'string':
                return {
                    fieldType: 'string',
                    path,
                    label,
                    required,
                    description,
                    xWidget,
                    multiline: schema.format === 'multiline',
                } satisfies ScalarFieldSchema;

            case 'number':
            case 'integer':
                return {
                    fieldType: 'number',
                    path,
                    label,
                    required,
                    description,
                    xWidget,
                    minimum: schema.minimum,
                    maximum: schema.maximum,
                } satisfies ScalarFieldSchema;

            case 'boolean':
                return {
                    fieldType: 'boolean',
                    path,
                    label,
                    required,
                    description,
                    xWidget,
                } satisfies ScalarFieldSchema;

            case 'array':
                return this.buildArrayField(schema, path, label, required, description, xWidget);

            case 'object':
                return this.buildObjectField(schema, path, label, required, description, xWidget);

            default:
                return undefined;
        }
    }

    /**
     * Build an ArrayFieldSchema with recursive item schema.
     */
    private buildArrayField(
        schema: JsonSchemaNode,
        path: string,
        label: string,
        required: boolean,
        description?: string,
        xWidget?: string
    ): ArrayFieldSchema | undefined {
        if (!schema.items) return undefined;

        const itemSchema = this.resolveRef(schema.items);
        const itemField = this.buildItemSchema(itemSchema, `${path}[]`);
        if (!itemField) return undefined;

        return {
            fieldType: 'array',
            path,
            label,
            required,
            description,
            xWidget,
            itemSchema: itemField,
            minItems: schema.minItems,
            maxItems: schema.maxItems,
        };
    }

    /**
     * Build a FieldSchema for an array item.
     * For objects, we recurse into buildObjectField.
     * For scalars, we build a simple scalar field.
     */
    private buildItemSchema(schema: JsonSchemaNode, path: string): FieldSchema | undefined {
        return this.buildSingleField(
            schema, path, 'Item', false, schema.description, schema['x-widget']
        );
    }

    /**
     * Build an ObjectFieldSchema with recursive child properties.
     */
    private buildObjectField(
        schema: JsonSchemaNode,
        path: string,
        label: string,
        required: boolean,
        description?: string,
        xWidget?: string
    ): ObjectFieldSchema {
        const properties = this.buildFieldSchemas(schema, path);
        const allowAdditional = schema.additionalProperties === true ||
            (typeof schema.additionalProperties === 'object');

        return {
            fieldType: 'object',
            path,
            label,
            required,
            description,
            xWidget,
            properties,
            allowAdditional,
        };
    }

    /**
     * Convert a camelCase or kebab-case name to a human-readable label.
     */
    humanizeLabel(name: string): string {
        return name
            .replace(/[-_]/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/^./, c => c.toUpperCase());
    }
}
