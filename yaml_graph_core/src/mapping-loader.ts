import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { GraphType, GraphMapping, MappingParser } from './types.js';

// ============================================================
// Error classes
// ============================================================

export class UnsupportedMappingVersionError extends Error {
    constructor(
        public readonly version: number,
        public readonly supportedVersions: number[]
    ) {
        super(
            `Mapping format version ${version} is not supported. ` +
            `Supported: ${supportedVersions.join(', ')}`
        );
        this.name = 'UnsupportedMappingVersionError';
    }
}

// ============================================================
// Version 1 Mapping Parser
// ============================================================

export class MappingParserV1 implements MappingParser {
    readonly version = 1;

    parse(rawYaml: unknown): GraphMapping {
        const raw = rawYaml as any;
        return {
            map: {
                id: raw.map.id,
                version: raw.map.version ?? 1,
                mermaidType: raw.map['mermaid-type'],
                directionField: raw.map['direction-field'],
                defaultDirection: raw.map['default-direction'],
            },
            nodeShapes: {
                sourcePath: raw['node-shapes']['source-path'],
                idField: raw['node-shapes']['id-field'],
                labelField: raw['node-shapes']['label-field'],
                // Support both legacy 'type-field' and new 'shape-field'
                shapeField: raw['node-shapes']['shape-field'] ?? raw['node-shapes']['type-field'],
                defaultShapes: raw['node-shapes']['default-shapes'],
                shapes: raw['node-shapes'].shapes ?? {},
                initialConnector: raw['node-shapes']['initial-connector'],
                finalConnector: raw['node-shapes']['final-connector'],
            },
            edgeLinks: {
                sourcePath: raw['edge-links']['source-path'],
                fromField: raw['edge-links']['from-field'],
                fromImplicit: raw['edge-links']['from-implicit'],
                toField: raw['edge-links']['to-field'],
                labelField: raw['edge-links']['label-field'],
                linkStyles: raw['edge-links']['link-styles'] ?? {},
                labelTemplate: raw['edge-links']['label-template'],
            },
            styleRules: raw['style-rules'] ? {
                field: raw['style-rules'].field,
                rules: raw['style-rules'].rules ?? {},
            } : undefined,
            annotations: raw.annotations ? {
                sourceField: raw.annotations['source-field'],
                template: raw.annotations.template,
            } : undefined,
            transforms: raw.transforms?.map((t: any) => ({
                scope: t.scope,
                match: t.match,
                js: t.js,
            })),
            customRenderer: raw['custom-renderer'],
        };
    }
}

// ============================================================
// MappingLoader
// ============================================================

export class MappingLoader {
    private warnings: string[] = [];
    private parsers = new Map<number, MappingParser>([
        [1, new MappingParserV1()],
    ]);

    /**
     * Return and clear accumulated warnings from the last load operation.
     */
    consumeWarnings(): string[] {
        const result = this.warnings;
        this.warnings = [];
        return result;
    }

    /**
     * Load all versions of a graph type from a folder containing
     * version subfolders (v1/, v2/, etc.). Each subfolder must contain:
     *   - *.schema.json (exactly one)
     *   - *.graph-map.yaml (exactly one)
     *   - style.css (optional)
     *
     * Returns an array of GraphType — one per version subfolder found.
     */
    async loadFromFolder(folderPath: string): Promise<GraphType[]> {
        const versionDirs = await this.findVersionSubfolders(folderPath);
        const results: GraphType[] = [];

        for (const { version, path: versionPath } of versionDirs) {
            const schemaFile = await this.findFile(versionPath, '.schema.json');
            const mappingFile = await this.findFile(versionPath, '.graph-map.yaml');

            const schemaText = await readFile(schemaFile, 'utf-8');
            const schema = JSON.parse(schemaText);

            const mappingText = await readFile(mappingFile, 'utf-8');
            const mappingRaw = parseYaml(mappingText);

            // Select version-specific parser
            const parser = this.parsers.get(version);
            if (!parser) {
                throw new UnsupportedMappingVersionError(
                    version,
                    Array.from(this.parsers.keys())
                );
            }
            const mapping = parser.parse(mappingRaw);

            // Validate version field matches subfolder
            if (mappingRaw.map?.version !== version) {
                throw new Error(
                    `Version mismatch in ${mappingFile}: ` +
                    `file says ${mappingRaw.map?.version}, ` +
                    `subfolder is v${version}`
                );
            }

            const filePatterns = this.deriveFilePatterns(mapping);

            // Load optional style.css
            let styleSheet: string | undefined;
            try {
                styleSheet = await readFile(
                    join(versionPath, 'style.css'), 'utf-8'
                );
            } catch { /* no style.css — that's fine */ }

            results.push({
                id: mapping.map.id,
                version,
                filePatterns,
                schema,
                mapping,
                styleSheet,
            });
        }

        return results;
    }

    /**
     * Load mapping from a YAML string (for testing or embedded use).
     * Uses the v1 parser by default.
     */
    loadMappingFromString(yamlText: string, version: number = 1): GraphMapping {
        const raw = parseYaml(yamlText);
        const parser = this.parsers.get(version);
        if (!parser) {
            throw new UnsupportedMappingVersionError(
                version,
                Array.from(this.parsers.keys())
            );
        }
        return parser.parse(raw);
    }

    /**
     * Find version subfolders (v1/, v2/, etc.) and return them sorted
     * by version number ascending. Entries that don't match the v{number}
     * pattern or that are missing required files are skipped with a
     * warning — processing continues with whatever is valid.
     */
    private async findVersionSubfolders(
        folderPath: string
    ): Promise<Array<{ version: number; path: string }>> {
        const entries = await readdir(folderPath, { withFileTypes: true });
        const versionPattern = /^v(\d+)$/;
        const results: Array<{ version: number; path: string }> = [];

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const match = entry.name.match(versionPattern);
            if (!match) {
                // Not a version folder — skip silently (could be docs, etc.)
                continue;
            }

            const version = parseInt(match[1], 10);
            const versionPath = join(folderPath, entry.name);

            // Verify required files exist
            try {
                await this.findFile(versionPath, '.graph-map.yaml');
                await this.findFile(versionPath, '.schema.json');
            } catch (err) {
                // Missing required files — report prominent warning, skip
                this.warnings.push(
                    `Skipping ${versionPath}: ${(err as Error).message}`
                );
                continue;
            }

            results.push({ version, path: versionPath });
        }

        // Sort ascending by version number
        results.sort((a, b) => a.version - b.version);
        return results;
    }

    private deriveFilePatterns(mapping: GraphMapping): string[] {
        // Convention: mapping id → file extension
        const patternMap: Record<string, string[]> = {
            'flowchart': ['*.flow.yaml'],
            'state-machine': ['*.state.yaml'],
            'er-diagram': ['*.er.yaml'],
            'class-diagram': ['*.class.yaml'],
        };
        return patternMap[mapping.map.id] ?? [`*.${mapping.map.id}.yaml`];
    }

    private async findFile(dir: string, suffix: string): Promise<string> {
        const files = await readdir(dir);
        const matches = (files as string[]).filter(f => f.endsWith(suffix));
        if (matches.length !== 1) {
            throw new Error(
                `Expected exactly one ${suffix} file in ${dir}, found ${matches.length}`
            );
        }
        return join(dir, matches[0]);
    }
}
