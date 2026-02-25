/**
 * TreeDataBuilder — builds TreeNode[] from parsed YAML data and a GraphType mapping.
 *
 * This is pure logic: YAML data in, TreeNode[] out. No VS Code dependency.
 * The resulting tree is sent to the webview for rendering.
 */

import type { GraphType, GraphMapping } from 'yaml-graph-core';
import type { TreeNode } from './types.js';

/** Icon name lookup by node type. Falls back to 'symbol-misc'. */
const DEFAULT_ICON_MAP: Record<string, string> = {
    // flowchart
    start: 'debug-start',
    end: 'debug-stop',
    process: 'symbol-method',
    decision: 'question',
    subprocess: 'symbol-class',
    // state machine
    initial: 'debug-start',
    state: 'circle-outline',
    final: 'debug-stop',
    composite: 'layers',
    // ER diagram
    entity: 'database',
    relationship: 'link',
    // generic
    default: 'symbol-misc',
};

/** Options for customizing tree construction. */
export interface TreeDataBuilderOptions {
    /** Custom icon map (merged with defaults). */
    iconMap?: Record<string, string>;
    /** Maximum depth for auto-expansion (default: 2). */
    autoExpandDepth?: number;
}

export class TreeDataBuilder {
    private readonly iconMap: Record<string, string>;
    private readonly autoExpandDepth: number;

    constructor(options?: TreeDataBuilderOptions) {
        this.iconMap = { ...DEFAULT_ICON_MAP, ...options?.iconMap };
        this.autoExpandDepth = options?.autoExpandDepth ?? 2;
    }

    /**
     * Build a full tree from parsed YAML data and a graph type.
     * Returns a top-level array of TreeNode groups (nodes, edges, meta).
     */
    buildTree(data: unknown, graphType: GraphType): TreeNode[] {
        if (!data || typeof data !== 'object') {
            return [];
        }

        const record = data as Record<string, unknown>;
        const mapping = graphType.mapping;
        const tree: TreeNode[] = [];

        // 1. Meta section (if present)
        if (record['meta'] && typeof record['meta'] === 'object') {
            tree.push(this.buildMetaNode(record['meta'] as Record<string, unknown>));
        }

        // 2. Nodes section
        const nodesPath = mapping.nodeShapes?.sourcePath?.split('.')[0] ?? 'nodes';
        const nodesData = this.getNestedValue(record, nodesPath);
        if (nodesData && typeof nodesData === 'object') {
            tree.push(this.buildNodesGroup(nodesData, mapping));
        }

        // 3. Edges section
        const edgesPath = mapping.edgeLinks?.sourcePath?.split('.')[0] ?? 'edges';
        const edgesData = this.getNestedValue(record, edgesPath);
        if (Array.isArray(edgesData)) {
            tree.push(this.buildEdgesGroup(edgesData, mapping));
        }

        return tree;
    }

    /**
     * Build tree nodes for a single node section (typically "nodes").
     */
    buildNodesGroup(nodesData: unknown, mapping: GraphMapping): TreeNode {
        const children: TreeNode[] = [];

        if (typeof nodesData === 'object' && nodesData !== null && !Array.isArray(nodesData)) {
            // Object-keyed nodes (flowchart, ER diagram)
            for (const [nodeId, nodeValue] of Object.entries(nodesData as Record<string, unknown>)) {
                children.push(this.buildNodeEntry(nodeId, nodeValue, mapping));
            }
        } else if (Array.isArray(nodesData)) {
            // Array-based nodes (some diagram types)
            for (let i = 0; i < nodesData.length; i++) {
                const nodeValue = nodesData[i];
                const nodeId = (nodeValue as any)?.id ?? `node-${i}`;
                children.push(this.buildNodeEntry(String(nodeId), nodeValue, mapping));
            }
        }

        return {
            id: '__nodes__',
            label: `Nodes (${children.length})`,
            type: 'group',
            icon: 'symbol-class',
            children,
            expanded: true,
        };
    }

    /**
     * Build a tree entry for a single node.
     */
    buildNodeEntry(nodeId: string, nodeValue: unknown, _mapping: GraphMapping): TreeNode {
        const data = (typeof nodeValue === 'object' && nodeValue !== null)
            ? nodeValue as Record<string, unknown>
            : {};
        const label = String(data['label'] ?? data['name'] ?? nodeId);
        const type = String(data['type'] ?? 'default');
        const icon = this.iconMap[type] ?? this.iconMap['default'] ?? 'symbol-misc';

        const node: TreeNode = {
            id: nodeId,
            label: `${nodeId}: ${label}`,
            type,
            icon,
        };

        // Add children for complex sub-properties (e.g., ER attributes)
        const childNodes = this.buildPropertyChildren(data, nodeId);
        if (childNodes.length > 0) {
            node.children = childNodes;
            node.expanded = false;
        }

        return node;
    }

    /**
     * Build tree children for notable sub-properties of a node.
     * E.g., ER attributes, state machine transitions, tags arrays.
     */
    buildPropertyChildren(data: Record<string, unknown>, parentId: string): TreeNode[] {
        const children: TreeNode[] = [];

        for (const [key, value] of Object.entries(data)) {
            // Skip simple scalar properties
            if (typeof value !== 'object' || value === null) continue;
            // Skip known identity fields
            if (['type', 'label', 'name', 'id'].includes(key)) continue;

            if (Array.isArray(value) && value.length > 0) {
                const arrayChildren: TreeNode[] = value.map((item, i) => {
                    const itemLabel = typeof item === 'object' && item !== null
                        ? String((item as any).name ?? (item as any).label ?? `[${i}]`)
                        : String(item);
                    return {
                        id: `${parentId}.${key}[${i}]`,
                        label: itemLabel,
                        type: 'array-item',
                        icon: 'symbol-field',
                    };
                });
                children.push({
                    id: `${parentId}.${key}`,
                    label: `${key} (${value.length})`,
                    type: 'array',
                    icon: 'symbol-array',
                    children: arrayChildren,
                    expanded: false,
                });
            } else if (!Array.isArray(value)) {
                // Nested object
                children.push({
                    id: `${parentId}.${key}`,
                    label: key,
                    type: 'object',
                    icon: 'symbol-object',
                    expanded: false,
                });
            }
        }

        return children;
    }

    /**
     * Build the edges group node.
     */
    buildEdgesGroup(edgesData: unknown[], mapping: GraphMapping): TreeNode {
        const fromField = mapping.edgeLinks?.fromField ?? 'from';
        const toField = mapping.edgeLinks?.toField ?? 'to';
        const labelField = mapping.edgeLinks?.labelField ?? 'label';

        const children: TreeNode[] = edgesData.map((edge, i) => {
            const edgeObj = (typeof edge === 'object' && edge !== null)
                ? edge as Record<string, unknown>
                : {};
            const from = String(edgeObj[fromField] ?? '?');
            const to = String(edgeObj[toField] ?? '?');
            const label = edgeObj[labelField] ? ` (${edgeObj[labelField]})` : '';
            return {
                id: `__edge_${i}`,
                label: `${from} → ${to}${label}`,
                type: 'edge',
                icon: 'arrow-right',
            };
        });

        return {
            id: '__edges__',
            label: `Edges (${children.length})`,
            type: 'group',
            icon: 'link',
            children,
            expanded: true,
        };
    }

    /**
     * Build tree node for the meta section.
     */
    buildMetaNode(meta: Record<string, unknown>): TreeNode {
        const title = String(meta['title'] ?? meta['id'] ?? 'Diagram');
        const children: TreeNode[] = Object.entries(meta).map(([key, value]) => ({
            id: `__meta__.${key}`,
            label: `${key}: ${String(value)}`,
            type: 'meta-field',
            icon: 'info',
        }));

        return {
            id: '__meta__',
            label: title,
            type: 'meta',
            icon: 'book',
            children,
            expanded: false,
        };
    }

    /**
     * Navigate a dot-path into a data object.
     */
    private getNestedValue(data: Record<string, unknown>, path: string): unknown {
        const segments = path.split('.');
        let current: unknown = data;
        for (const segment of segments) {
            if (current === null || current === undefined || typeof current !== 'object') {
                return undefined;
            }
            current = (current as Record<string, unknown>)[segment];
        }
        return current;
    }
}
