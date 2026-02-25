/**
 * NodeEditorController — prepares field schemas and node data
 * for the webview node editor panel.
 *
 * Uses SchemaResolver to convert JSON Schemas into FieldSchema[] trees,
 * and caches resolved schemas per graph type. Produces the data that
 * the webview needs to render the schema-driven form.
 */

import type { GraphType } from 'yaml-graph-core';
import type { FieldSchema, ExtensionMessage } from './types.js';
import { SchemaResolver, type JsonSchemaNode } from './schema-resolver.js';

/** Cached resolution result for a graph type. */
interface CachedSchema {
    graphTypeId: string;
    version: number;
    nodeFieldSchemas: FieldSchema[];
}

export class NodeEditorController {
    private readonly cache = new Map<string, CachedSchema>();

    /**
     * Build the showNode message for the webview.
     *
     * @param nodeId The selected node's ID
     * @param nodeData The raw YAML data for this node
     * @param graphType The active graph type (provides JSON Schema)
     * @param nodeSection The schema section containing node definitions (default: "nodes")
     */
    buildShowNodeMessage(
        nodeId: string,
        nodeData: unknown,
        graphType: GraphType,
        nodeSection: string = 'nodes'
    ): ExtensionMessage {
        const schemas = this.getNodeFieldSchemas(graphType, nodeSection);
        return {
            type: 'showNode',
            nodeId,
            nodeData,
            schema: schemas,
        };
    }

    /**
     * Build a clearNodeEditor message.
     */
    buildClearMessage(): ExtensionMessage {
        return { type: 'clearNodeEditor' };
    }

    /**
     * Get (or compute and cache) the FieldSchema[] for nodes in the given graph type.
     */
    getNodeFieldSchemas(graphType: GraphType, nodeSection: string = 'nodes'): FieldSchema[] {
        const cacheKey = `${graphType.id}@${graphType.version}`;

        const cached = this.cache.get(cacheKey);
        if (cached) {
            return cached.nodeFieldSchemas;
        }

        const schemas = this.resolveNodeSchemas(graphType, nodeSection);
        this.cache.set(cacheKey, {
            graphTypeId: graphType.id,
            version: graphType.version,
            nodeFieldSchemas: schemas,
        });

        return schemas;
    }

    /**
     * Clear the cache (e.g., when graph types are reloaded).
     */
    clearCache(): void {
        this.cache.clear();
    }

    /**
     * Resolve the node field schemas from a graph type's JSON Schema.
     */
    private resolveNodeSchemas(graphType: GraphType, nodeSection: string): FieldSchema[] {
        // The graph type's schema is the full JSON Schema for the YAML file
        const rootSchema = graphType.schema as JsonSchemaNode;
        if (!rootSchema) return [];

        const resolver = new SchemaResolver(rootSchema);

        // Extract the sub-schema for nodes (e.g., "nodes" → additionalProperties)
        const nodeSubSchema = resolver.extractNodeSubSchema(nodeSection);
        if (!nodeSubSchema) return [];

        return resolver.buildFieldSchemas(nodeSubSchema);
    }

    /**
     * Convert a JSON pointer path from the webview edit message into
     * a YAML-compatible path array for AST operations.
     *
     * Example: "attributes[1].name" → ['attributes', 1, 'name']
     */
    static jsonPointerToPath(basePath: string, pointer: string): (string | number)[] {
        const parts: (string | number)[] = basePath.split('.');
        for (const segment of pointer.split('.')) {
            const arrayMatch = segment.match(/^(.+)\[(\d+)\]$/);
            if (arrayMatch) {
                parts.push(arrayMatch[1]!, Number(arrayMatch[2]));
            } else {
                parts.push(segment);
            }
        }
        return parts;
    }
}
