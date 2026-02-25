import type {
    GraphType, GraphMapping, ConversionCallbacks, ConversionResult,
    NodeData, EdgeData, TransformContext, SourceRange, ValidationError
} from './types.js';
import { YamlParserWrapper, type ParsedYaml } from './yaml-parser-wrapper.js';
import { SchemaValidator } from './schema-validator.js';
import { AstNodeTransformerRuntime } from './ast-node-transformer.js';

export class ConversionEngine {
    private parser: YamlParserWrapper;
    private validator: SchemaValidator;
    private transformRuntime: AstNodeTransformerRuntime;

    constructor() {
        this.parser = new YamlParserWrapper();
        this.validator = new SchemaValidator();
        this.transformRuntime = new AstNodeTransformerRuntime();
    }

    /**
     * Sanitize a node ID for use in Mermaid flowchart syntax.
     * Mermaid interprets hyphens as connection operators, so we replace
     * them with underscores in the generated Mermaid source.
     * ER and state diagrams don't have this issue.
     */
    private sanitizeFlowchartId(id: string): string {
        return id.replace(/-/g, '_');
    }

    /**
     * Convert a YAML source string to Mermaid using the given graph type
     * definition and optional callbacks.
     */
    convert(
        yamlText: string,
        graphType: GraphType,
        callbacks?: ConversionCallbacks
    ): ConversionResult {
        // 1. Parse YAML (comment-preserving)
        const parsed = this.parser.parse(yamlText);

        // 2. Validate against schema
        const errors = this.validator.validate(parsed.data, graphType.schema);

        // 3. Extract nodes and edges
        const { nodes, edges, nodeMap, edgeMap } = this.extractElements(
            parsed, graphType.mapping
        );

        // 4. Generate Mermaid output
        const mermaidSource = this.generateMermaid(
            nodes, edges, graphType.mapping, callbacks
        );

        return { mermaidSource, errors, nodeMap, edgeMap };
    }

    /**
     * Async wrapper: calls callbacks.prepare() first, then runs the
     * synchronous conversion pipeline.
     */
    async convertWithPrepare(
        yamlText: string,
        graphType: GraphType,
        callbacks?: ConversionCallbacks
    ): Promise<ConversionResult> {
        if (callbacks?.prepare) {
            await callbacks.prepare();
        }
        return this.convert(yamlText, graphType, callbacks);
    }

    /**
     * Extract nodes and edges from parsed YAML using mapping configuration.
     * Supports both legacy top-level edges and co-located node.connections[].
     */
    private extractElements(
        parsed: ParsedYaml,
        mapping: GraphMapping
    ): {
        nodes: Map<string, NodeData>;
        edges: EdgeData[];
        nodeMap: Map<string, SourceRange>;
        edgeMap: Map<number, SourceRange>;
    } {
        const nodes = new Map<string, NodeData>();
        const edges: EdgeData[] = [];
        const nodeMap = new Map<string, SourceRange>();
        const edgeMap = new Map<number, SourceRange>();

        // Extract nodes from the configured source path
        const nodesSourcePath = mapping.nodeShapes.sourcePath;
        const nodesData = this.getNestedValue(parsed.data, nodesSourcePath);

        if (nodesData && typeof nodesData === 'object' && !Array.isArray(nodesData)) {
            const nodesObj = nodesData as Record<string, unknown>;
            for (const [key, value] of Object.entries(nodesObj)) {
                if (value && typeof value === 'object') {
                    const fields = value as Record<string, unknown>;
                    const id = mapping.nodeShapes.idField === '_key'
                        ? key
                        : String(fields[mapping.nodeShapes.idField] ?? key);

                    // Read type (semantic) and subtype
                    const type = String(fields['type'] ?? 'default');
                    const subtype = fields['subtype'] ? String(fields['subtype']) : undefined;

                    // Resolve shape: explicit shape field → defaultShapes[type] → 'rectangle'
                    let shape: string;
                    const explicitShape = fields[mapping.nodeShapes.shapeField];
                    if (explicitShape !== undefined) {
                        shape = String(explicitShape);
                    } else if (mapping.nodeShapes.defaultShapes?.[type]) {
                        shape = mapping.nodeShapes.defaultShapes[type];
                    } else {
                        shape = 'rectangle';
                    }

                    nodes.set(id, { id, shape, type, subtype, fields });

                    // Get source range for this node
                    const range = this.parser.getMapEntryRange(
                        parsed, `${nodesSourcePath}.${key}`
                    );
                    if (range) {
                        nodeMap.set(id, range);
                    }
                }
            }
        }

        // Extract edges — support co-located pattern (*.connections, *.transitions, *.relationships, etc.)
        const edgesSourcePath = mapping.edgeLinks.sourcePath;

        // Check for co-located pattern: <nodesPath>.*.<edgeArrayName>
        const colocatedMatch = edgesSourcePath.match(/^(.+)\.\*\.(.+)$/);
        if (colocatedMatch) {
            // Co-located edges within nodes
            // fromImplicit provides the parent node key
            const [, nodesPath, edgeArrayName] = colocatedMatch;
            this.extractColocatedConnections(
                parsed, mapping, nodes, edges, edgeMap, nodesPath, edgeArrayName
            );
        }

        return { nodes, edges, nodeMap, edgeMap };
    }

    /**
     * Extract edges from co-located arrays within nodes.
     * Pattern: <nodesPath>.*.<edgeArrayName> where from is derived from parent node key.
     */
    private extractColocatedConnections(
        parsed: ParsedYaml,
        mapping: GraphMapping,
        nodes: Map<string, NodeData>,
        edges: EdgeData[],
        edgeMap: Map<number, SourceRange>,
        nodesPath: string,
        edgeArrayName: string
    ): void {
        const nodesData = this.getNestedValue(parsed.data, nodesPath);

        if (!nodesData || typeof nodesData !== 'object' || Array.isArray(nodesData)) {
            return;
        }

        const nodesObj = nodesData as Record<string, unknown>;
        let edgeIndex = 0;

        for (const [nodeKey, nodeValue] of Object.entries(nodesObj)) {
            if (!nodeValue || typeof nodeValue !== 'object') continue;

            const nodeFields = nodeValue as Record<string, unknown>;
            const edgeArray = nodeFields[edgeArrayName];

            if (!Array.isArray(edgeArray)) continue;

            for (let i = 0; i < edgeArray.length; i++) {
                const conn = edgeArray[i];
                if (!conn || typeof conn !== 'object') continue;

                const connFields = conn as Record<string, unknown>;

                // from is implicit (the parent node key) or explicit
                let from: string;
                if (mapping.edgeLinks.fromImplicit === '_parent_key') {
                    from = nodeKey;
                } else {
                    from = String(connFields[mapping.edgeLinks.fromField] ?? nodeKey);
                }

                const to = String(connFields[mapping.edgeLinks.toField] ?? '');
                edges.push({ from, to, fields: connFields });

                // Get source range for this connection
                const range = this.parser.getSourceRange(
                    parsed, `${nodesPath}.${nodeKey}.${edgeArrayName}.${i}`
                );
                if (range) {
                    edgeMap.set(edgeIndex, range);
                }
                edgeIndex++;
            }
        }
    }

    /**
     * Generate Mermaid source from extracted nodes and edges.
     */
    private generateMermaid(
        nodes: Map<string, NodeData>,
        edges: EdgeData[],
        mapping: GraphMapping,
        callbacks?: ConversionCallbacks
    ): string {
        const output: string[] = [];
        const direction = mapping.map.defaultDirection ?? 'TD';

        // Notify callbacks of mermaid type before generating
        if (callbacks?.setMermaidType) {
            callbacks.setMermaidType(mapping.map.mermaidType);
        }

        // Mermaid header
        if (mapping.map.mermaidType === 'erDiagram') {
            output.push('erDiagram');
        } else if (mapping.map.mermaidType === 'stateDiagram-v2') {
            output.push('stateDiagram-v2');
        } else {
            output.push(`${mapping.map.mermaidType} ${direction}`);
        }

        // Determine if we need ID sanitization (flowchart only)
        const isFlowchart = mapping.map.mermaidType !== 'erDiagram'
            && mapping.map.mermaidType !== 'stateDiagram-v2';
        const safeId = isFlowchart
            ? (id: string) => this.sanitizeFlowchartId(id)
            : (id: string) => id;

        // Add initial connector if configured (state machines: [*] --> firstState)
        if (mapping.nodeShapes.initialConnector) {
            const firstNodeId = nodes.keys().next().value;
            if (firstNodeId) {
                output.push(`    ${mapping.nodeShapes.initialConnector.replace('{first}', safeId(firstNodeId))}`);
            }
        }

        // Render nodes
        for (const [id, node] of nodes) {
            let lines = this.renderNode(safeId(id), node, mapping);

            // Apply matching transform (first match wins)
            lines = this.applyTransforms(
                node, 'node', lines, mapping, nodes, edges
            );

            // Invoke callback
            if (callbacks?.onNodeEmit) {
                const extra = callbacks.onNodeEmit(id, node, lines);
                lines = [...lines, ...extra];
            }

            output.push(...lines.map(l => '    ' + l));
        }

        // Render edges (with sanitized IDs for flowcharts)
        for (let i = 0; i < edges.length; i++) {
            const edge = edges[i];
            const sanitizedEdge = isFlowchart
                ? { ...edge, from: safeId(edge.from), to: safeId(edge.to) }
                : edge;
            let lines = this.renderEdge(sanitizedEdge, mapping);

            lines = this.applyTransforms(
                edges[i], 'edge', lines, mapping, nodes, edges
            );

            if (callbacks?.onEdgeEmit) {
                const extra = callbacks.onEdgeEmit(edges[i], lines);
                lines = [...lines, ...extra];
            }

            output.push(...lines.map(l => '    ' + l));
        }

        // Add final connector if configured (state machines: lastState --> [*])
        if (mapping.nodeShapes.finalConnector) {
            // Find nodes of type 'final' or use last node
            for (const [id, node] of nodes) {
                if (node.type === 'final') {
                    output.push(`    ${mapping.nodeShapes.finalConnector.replace('{last}', safeId(id))}`);
                }
            }
        }

        // Apply style rules (supports dot-separated paths like metadata.status)
        if (mapping.styleRules) {
            for (const [id, node] of nodes) {
                const value = this.getNestedValue(
                    node.fields as Record<string, unknown>,
                    mapping.styleRules.field
                );
                const rule = mapping.styleRules.rules[String(value)];
                if (rule) {
                    output.push(
                        `    style ${safeId(id)} fill:${rule.fill},stroke:${rule.stroke},color:${rule.color}`
                    );
                }
            }
        }

        // Final callback
        if (callbacks?.onComplete) {
            const extra = callbacks.onComplete(
                Array.from(nodes.keys()), output
            );
            output.push(...extra);
        }

        return output.join('\n');
    }

    /**
     * Render a single node using the mapping's shape templates.
     * Uses node.shape (not node.type) for template lookup.
     */
    private renderNode(
        id: string, node: NodeData, mapping: GraphMapping
    ): string[] {
        const label = String(node.fields[mapping.nodeShapes.labelField] ?? id);

        // For ER diagrams, nodes are entities rendered differently
        if (mapping.map.mermaidType === 'erDiagram') {
            return this.renderErEntity(id, node, mapping);
        }

        // For state diagrams, nodes are states
        if (mapping.map.mermaidType === 'stateDiagram-v2') {
            return this.renderState(id, node, mapping);
        }

        // Standard flowchart node rendering — use shape for template lookup
        const shapeTemplate = mapping.nodeShapes.shapes[node.shape];
        if (!shapeTemplate) {
            // Fallback to default rectangle if shape not in templates
            return [`${id}["${label}"]`];
        }

        const rendered = shapeTemplate
            .replace(/\{label\}/g, label)
            .replace(/\{id\}/g, id);
        return [id + rendered];
    }

    /**
     * Render an ER diagram entity with its attributes.
     */
    private renderErEntity(
        id: string, node: NodeData, _mapping: GraphMapping
    ): string[] {
        const lines: string[] = [];
        lines.push(`${id} {`);

        const attributes = node.fields['attributes'] as Array<Record<string, unknown>> | undefined;
        if (attributes && Array.isArray(attributes)) {
            for (const attr of attributes) {
                const attrType = String(attr['type'] ?? 'string');
                const attrName = String(attr['name'] ?? '');
                const key = attr['key'] ? ` ${attr['key']}` : '';
                lines.push(`    ${attrType} ${attrName}${key}`);
            }
        }

        lines.push('}');
        return lines;
    }

    /**
     * Render a state diagram state.
     */
    private renderState(
        id: string, node: NodeData, mapping: GraphMapping
    ): string[] {
        const label = String(node.fields[mapping.nodeShapes.labelField] ?? id);

        // Initial and final states are handled via connectors, not rendered as nodes
        if (node.type === 'initial' || node.type === 'final') {
            return [];
        }

        return [`${id} : ${label}`];
    }

    /**
     * Render a single edge using the mapping's link styles and templates.
     */
    private renderEdge(edge: EdgeData, mapping: GraphMapping): string[] {
        const from = edge.from;
        const to = edge.to;

        // ER diagram relationships
        if (mapping.map.mermaidType === 'erDiagram') {
            return this.renderErRelationship(edge, mapping);
        }

        // State diagram transitions
        if (mapping.map.mermaidType === 'stateDiagram-v2') {
            return this.renderTransition(edge, mapping);
        }

        // Standard flowchart edges
        const labelField = mapping.edgeLinks.labelField ?? 'label';
        const label = edge.fields[labelField];
        const style = edge.fields['style'] as string | undefined;
        const linkStyle = mapping.edgeLinks.linkStyles[style ?? 'default'] ?? '-->';

        if (label) {
            // Render edge with label using the correct link style
            if (linkStyle === '-.->') {
                return [`${from} -.->|"${label}"| ${to}`];
            }
            if (linkStyle === '==>') {
                return [`${from} ==>|"${label}"| ${to}`];
            }
            return [`${from} -->|"${label}"| ${to}`];
        }

        return [`${from} ${linkStyle} ${to}`];
    }

    /**
     * Render an ER relationship.
     */
    private renderErRelationship(edge: EdgeData, _mapping: GraphMapping): string[] {
        const from = edge.from;
        const to = edge.to;
        const relType = edge.fields['type'] as string ?? 'one-to-many';
        const label = edge.fields['label'] as string ?? '';

        // Map relationship types to Mermaid ER notation
        const relMap: Record<string, string> = {
            'one-to-one': '||--||',
            'one-to-many': '||--o{',
            'many-to-one': '}o--||',
            'many-to-many': '}o--o{',
        };

        const mermaidRel = relMap[relType] ?? '||--o{';
        return [`${from} ${mermaidRel} ${to} : "${label}"`];
    }

    /**
     * Render a state diagram transition.
     */
    private renderTransition(edge: EdgeData, _mapping: GraphMapping): string[] {
        const from = edge.from;
        const to = edge.to;
        const event = edge.fields['event'] as string | undefined;
        const guard = edge.fields['guard'] as string | undefined;

        let label = event ?? '';
        if (guard) {
            label += ` [${guard}]`;
        }

        if (label) {
            return [`${from} --> ${to} : ${label}`];
        }
        return [`${from} --> ${to}`];
    }

    /**
     * Apply transforms — first match wins.
     */
    private applyTransforms(
        element: NodeData | EdgeData,
        scope: 'node' | 'edge',
        defaultLines: string[],
        mapping: GraphMapping,
        nodes: Map<string, NodeData>,
        edges: EdgeData[]
    ): string[] {
        if (!mapping.transforms) return defaultLines;

        for (const rule of mapping.transforms) {
            const ruleScope = rule.scope ?? 'node';
            if (ruleScope !== scope) continue;

            if (this.matchesCondition(element, rule.match)) {
                const ctx: TransformContext = {
                    allNodes: nodes,
                    allEdges: edges,
                    mapping,
                    output: defaultLines
                };
                return this.transformRuntime.execute(rule.js, element, ctx);
            }
        }

        return defaultLines;
    }

    /**
     * Check if an element matches a transform condition.
     */
    private matchesCondition(
        element: NodeData | EdgeData,
        match: { field: string; exists?: boolean; equals?: unknown; pattern?: string }
    ): boolean {
        const fields = element.fields ?? {};
        const value = fields[match.field];

        if (match.exists !== undefined) {
            return (value !== undefined) === match.exists;
        }
        if (match.equals !== undefined) {
            return value === match.equals;
        }
        if (match.pattern !== undefined) {
            return new RegExp(match.pattern).test(String(value ?? ''));
        }
        return false;
    }

    /**
     * Navigate into a nested object using a dot-separated path.
     */
    private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
        const segments = path.split('.');
        let current: unknown = obj;
        for (const segment of segments) {
            if (current === null || current === undefined) return undefined;
            if (typeof current === 'object') {
                current = (current as Record<string, unknown>)[segment];
            } else {
                return undefined;
            }
        }
        return current;
    }
}
