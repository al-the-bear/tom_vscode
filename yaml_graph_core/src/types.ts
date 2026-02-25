// ============================================================
// Graph Type — represents a registered diagram type
// ============================================================

export interface GraphType {
    /** Unique type id, e.g. 'flowchart', 'stateMachine' */
    id: string;

    /** Mapping format version (matches the v{n}/ subfolder) */
    version: number;

    /** File extension patterns, e.g. ['*.flow.yaml'] */
    filePatterns: string[];

    /** JSON Schema object for validating YAML source files */
    schema: object;

    /** Parsed mapping configuration from *.graph-map.yaml */
    mapping: GraphMapping;

    /** Optional per-type CSS stylesheet content */
    styleSheet?: string;
}

// ============================================================
// Graph Mapping — parsed *.graph-map.yaml structure
// ============================================================

export interface GraphMapping {
    map: {
        id: string;
        version: number;
        mermaidType: string;
        directionField?: string;
        defaultDirection?: string;
    };

    nodeShapes: {
        sourcePath: string;
        idField: string;
        labelField: string;
        /** Field that determines visual shape (e.g. 'shape') */
        shapeField: string;
        /** Fallback shape per semantic type when shape field is omitted */
        defaultShapes?: Record<string, string>;
        /** Shape templates keyed by shape value */
        shapes: Record<string, string>;
        initialConnector?: string;
        finalConnector?: string;
    };

    edgeLinks: {
        /** Path to edges array or 'nodes.*.connections' for co-located */
        sourcePath: string;
        fromField: string;
        /** Implicit source for co-located connections (e.g. '_parent_key') */
        fromImplicit?: string;
        toField: string;
        labelField?: string;
        linkStyles: Record<string, string>;
        labelTemplate?: string;
    };

    styleRules?: {
        field: string;
        rules: Record<string, {
            fill: string;
            stroke: string;
            color: string;
        }>;
    };

    annotations?: {
        sourceField: string;
        template: string;
    };

    transforms?: TransformRule[];

    customRenderer?: string;
}

// ============================================================
// Transform Rules — inline JS transforms in mapping files
// ============================================================

export interface TransformRule {
    /** 'node' (default) or 'edge' */
    scope?: 'node' | 'edge';

    /** Condition to match */
    match: {
        field: string;
        exists?: boolean;
        equals?: string | number | boolean;
        pattern?: string;  // regex pattern
    };

    /** JavaScript fragment — AstNodeTransformer body */
    js: string;
}

// ============================================================
// AstNodeTransformer — function signature for inline transforms
// ============================================================

export interface NodeData {
    id: string;
    /** Mermaid visual shape (from shape field or defaultShapes[type]) */
    shape: string;
    /** Semantic type — constrained by domain schema */
    type: string;
    /** Optional subtype specialization */
    subtype?: string;
    fields: Record<string, unknown>;
}

export interface EdgeData {
    from: string;
    to: string;
    fields: Record<string, unknown>;
}

export interface TransformContext {
    allNodes: Map<string, NodeData>;
    allEdges: EdgeData[];
    mapping: GraphMapping;
    output: string[];
}

export type AstNodeTransformer = (
    element: NodeData | EdgeData,
    context: TransformContext
) => string[];

// ============================================================
// Conversion Callbacks — host-provided hooks
// ============================================================

export interface ConversionCallbacks {
    /**
     * Called once before conversion starts. Use to pre-compute async
     * data (file lookups, workspace queries) that synchronous emit
     * callbacks will reference via captured state on `this`.
     */
    prepare?: () => Promise<void>;

    /**
     * Called once at the start of Mermaid generation with the mermaid
     * diagram type (e.g., 'flowchart', 'stateDiagram-v2', 'erDiagram').
     * Use to configure type-specific behavior in other callbacks.
     */
    setMermaidType?: (mermaidType: string) => void;

    /**
     * Called for each emitted node. Returns additional Mermaid lines
     * to append (e.g., click directives for navigation).
     */
    onNodeEmit?: (
        nodeId: string,
        nodeData: NodeData,
        emittedLines: string[]
    ) => string[];

    /**
     * Called for each emitted edge. Returns additional Mermaid lines.
     */
    onEdgeEmit?: (
        edgeData: EdgeData,
        emittedLines: string[]
    ) => string[];

    /**
     * Called once after all elements are emitted. Returns additional
     * Mermaid lines to append at the end.
     */
    onComplete?: (
        allNodeIds: string[],
        output: string[]
    ) => string[];
}

// ============================================================
// Conversion Result
// ============================================================

export interface SourceRange {
    startOffset: number;
    endOffset: number;
}

export interface ValidationError {
    path: string;
    message: string;
    severity: 'error' | 'warning';
}

export interface ConversionResult {
    /** Generated Mermaid source text */
    mermaidSource: string;

    /** Schema validation errors/warnings */
    errors: ValidationError[];

    /** Map of node ID → YAML source byte range */
    nodeMap: Map<string, SourceRange>;

    /** Map of edge index → YAML source byte range */
    edgeMap: Map<number, SourceRange>;
}

// ============================================================
// MappingParser — version-specific mapping file parser
// ============================================================

export interface MappingParser {
    readonly version: number;
    parse(rawYaml: unknown): GraphMapping;
}
