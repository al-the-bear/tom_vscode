import { parseDocument, Document, Scalar, YAMLMap, Pair, YAMLSeq, isMap, isSeq } from 'yaml';
import type { SourceRange } from './types.js';

export interface ParsedYaml {
    /** Parsed data as plain JavaScript object */
    data: Record<string, unknown>;

    /** The yaml AST Document (preserves comments and source ranges) */
    document: Document;

    /** Raw YAML text */
    text: string;
}

export class YamlParserWrapper {
    /**
     * Parse YAML text into data + AST (comment-preserving).
     */
    parse(yamlText: string): ParsedYaml {
        const document = parseDocument(yamlText);
        const data = document.toJSON() as Record<string, unknown>;
        return { data, document, text: yamlText };
    }

    /**
     * Get the source range of a node at the given YAML path.
     * Path segments are dot-separated: 'nodes.validate.label'
     * Array indices use numeric segments: 'edges.0.from'
     */
    getSourceRange(parsed: ParsedYaml, path: string): SourceRange | undefined {
        const segments = this.parsePathSegments(path);
        const node = parsed.document.getIn(segments, true);
        if (node && typeof node === 'object' && 'range' in node) {
            const range = (node as any).range;
            if (Array.isArray(range) && range.length >= 2) {
                return { startOffset: range[0], endOffset: range[1] };
            }
        }
        return undefined;
    }

    /**
     * Get the source range of a map entry (key + value) at the given path.
     * For a path like 'nodes.validate', returns the range covering the
     * entire 'validate: ...' block in the YAML map.
     */
    getMapEntryRange(parsed: ParsedYaml, path: string): SourceRange | undefined {
        const segments = this.parsePathSegments(path);
        if (segments.length === 0) return undefined;

        const parentSegments = segments.slice(0, -1);
        const key = segments[segments.length - 1];

        const parentNode = parentSegments.length === 0
            ? parsed.document.contents
            : parsed.document.getIn(parentSegments, true);

        if (parentNode && isMap(parentNode)) {
            for (const pair of parentNode.items) {
                if (pair.key && (pair.key as Scalar).value === key) {
                    const keyRange = (pair.key as any).range;
                    const valueNode = pair.value;
                    const valueRange = valueNode && typeof valueNode === 'object' && 'range' in valueNode
                        ? (valueNode as any).range
                        : undefined;

                    if (keyRange && valueRange) {
                        return {
                            startOffset: keyRange[0],
                            endOffset: valueRange[1],
                        };
                    }
                }
            }
        }
        return undefined;
    }

    /**
     * Edit a scalar value at the given path, preserving comments.
     * Returns the modified YAML text.
     */
    editValue(parsed: ParsedYaml, path: string, newValue: unknown): string {
        const segments = this.parsePathSegments(path);
        parsed.document.setIn(segments, newValue);
        return parsed.document.toString();
    }

    /**
     * Add a new map entry at the given path.
     * Returns the modified YAML text.
     */
    addMapEntry(
        parsed: ParsedYaml,
        parentPath: string,
        key: string,
        value: Record<string, unknown>
    ): string {
        const segments = this.parsePathSegments(parentPath);
        const parent = segments.length === 0
            ? parsed.document.contents
            : parsed.document.getIn(segments, true);

        if (parent && isMap(parent)) {
            parent.add(new Pair(new Scalar(key), parsed.document.createNode(value)));
        }
        return parsed.document.toString();
    }

    /**
     * Append an item to a sequence at the given path.
     * Returns the modified YAML text.
     */
    appendToSequence(
        parsed: ParsedYaml,
        path: string,
        value: Record<string, unknown>
    ): string {
        const segments = this.parsePathSegments(path);
        const seq = segments.length === 0
            ? parsed.document.contents
            : parsed.document.getIn(segments, true);

        if (seq && isSeq(seq)) {
            seq.add(parsed.document.createNode(value));
        }
        return parsed.document.toString();
    }

    /**
     * Delete a map entry or sequence item at the given path.
     * Returns the modified YAML text.
     */
    deleteEntry(parsed: ParsedYaml, path: string): string {
        const segments = this.parsePathSegments(path);
        parsed.document.deleteIn(segments);
        return parsed.document.toString();
    }

    /**
     * Find the node ID whose YAML source range contains the given character offset.
     *
     * Walks the nodes map (at `nodesPath`, default "nodes") and checks each
     * entry's key→value range. Returns the matching node ID, or undefined.
     */
    findNodeAtOffset(parsed: ParsedYaml, offset: number, nodesPath: string = 'nodes'): string | undefined {
        const segments = this.parsePathSegments(nodesPath);
        const nodesNode = segments.length === 0
            ? parsed.document.contents
            : parsed.document.getIn(segments, true);

        if (!nodesNode || !isMap(nodesNode)) return undefined;

        for (const pair of nodesNode.items) {
            const key = pair.key as Scalar;
            const keyRange = (key as any).range;
            const valueNode = pair.value;
            const valueRange = valueNode && typeof valueNode === 'object' && 'range' in valueNode
                ? (valueNode as any).range
                : undefined;

            if (keyRange && valueRange) {
                const start = keyRange[0] as number;
                const end = valueRange[1] as number;
                if (offset >= start && offset <= end) {
                    return String(key.value);
                }
            }
        }

        return undefined;
    }

    /**
     * Parse a dot-separated path into segments.
     * Numeric segments are converted to numbers for array indexing.
     */
    private parsePathSegments(path: string): (string | number)[] {
        if (!path) return [];
        return path.split('.').map(s => {
            const num = parseInt(s, 10);
            return !isNaN(num) && String(num) === s ? num : s;
        });
    }
}
