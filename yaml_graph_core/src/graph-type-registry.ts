import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { GraphType, GraphMapping } from './types.js';
import { MappingLoader } from './mapping-loader.js';
import { SchemaResolver, type DomainRegistration } from './schema-resolver.js';

// ============================================================
// Error classes
// ============================================================

export class GraphTypeConflictError extends Error {
    constructor(
        public readonly newTypeId: string,
        public readonly existingTypeId: string,
        public readonly pattern: string
    ) {
        super(
            `Graph type '${newTypeId}' conflicts with '${existingTypeId}' ` +
            `on pattern '${pattern}'`
        );
        this.name = 'GraphTypeConflictError';
    }
}

export class DomainNotFoundError extends Error {
    constructor(public readonly domainId: string) {
        super(`Domain '${domainId}' is not registered`);
        this.name = 'DomainNotFoundError';
    }
}

// ============================================================
// Registry
// ============================================================

export class GraphTypeRegistry {
    /**
     * All registered versions keyed by "{id}@{version}".
     */
    private allVersions = new Map<string, GraphType>();

    /**
     * File pattern → highest-version GraphType (default lookup).
     */
    private filePatternMap = new Map<string, GraphType>();

    /**
     * File pattern → map of version → GraphType.
     */
    private versionedPatternMap = new Map<string, Map<number, GraphType>>();

    /**
     * Registered domain extensions keyed by domain ID.
     */
    private domains = new Map<string, DomainRegistration>();

    private loader = new MappingLoader();
    private schemaResolver = new SchemaResolver();

    /**
     * Register a graph type. Throws GraphTypeConflictError if any file
     * pattern is already claimed by a *different* graph type id.
     * Multiple versions of the *same* id are allowed.
     */
    register(graphType: GraphType): void {
        for (const pattern of graphType.filePatterns) {
            const existing = this.filePatternMap.get(pattern);
            if (existing && existing.id !== graphType.id) {
                throw new GraphTypeConflictError(
                    graphType.id, existing.id, pattern
                );
            }
        }

        const versionKey = `${graphType.id}@${graphType.version}`;
        this.allVersions.set(versionKey, graphType);

        for (const pattern of graphType.filePatterns) {
            // Update versioned map
            let versions = this.versionedPatternMap.get(pattern);
            if (!versions) {
                versions = new Map();
                this.versionedPatternMap.set(pattern, versions);
            }
            versions.set(graphType.version, graphType);

            // Default map always points to highest version
            const current = this.filePatternMap.get(pattern);
            if (!current || graphType.version > current.version) {
                this.filePatternMap.set(pattern, graphType);
            }
        }
    }

    /**
     * Register all versions of a graph type from a folder containing
     * version subfolders.
     */
    async registerFromFolder(folderPath: string): Promise<void> {
        const graphTypes = await this.loader.loadFromFolder(folderPath);
        for (const gt of graphTypes) {
            this.register(gt);
        }
    }

    /**
     * Return and clear accumulated loader warnings.
     */
    consumeWarnings(): string[] {
        return this.loader.consumeWarnings();
    }

    /**
     * Auto-scan a directory of graph-type folders and register them all.
     * On error, collects warnings and continues with the remaining folders.
     * Returns an array of error messages for the caller to display.
     */
    async registerAllFromDirectory(dirPath: string): Promise<string[]> {
        const errors: string[] = [];
        const entries = await readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const folderPath = join(dirPath, entry.name);

            try {
                await this.registerFromFolder(folderPath);

                // Collect non-fatal warnings
                for (const warning of this.loader.consumeWarnings()) {
                    errors.push(`Warning: ${warning}`);
                }
            } catch (err) {
                const message = err instanceof Error
                    ? `Graph type '${entry.name}': ${err.message}`
                    : `Graph type '${entry.name}': unknown error`;
                errors.push(message);
                // Continue with next folder
            }
        }

        return errors;
    }

    /**
     * Look up graph type by file extension/pattern.
     * Returns the highest registered version.
     */
    getForFile(filename: string): GraphType | undefined {
        for (const [pattern, type] of this.filePatternMap) {
            if (this.matchesPattern(filename, pattern)) {
                return type;
            }
        }
        return undefined;
    }

    /**
     * Look up a specific version of a graph type for a file.
     * Primary lookup method — used by resolveGraphType() since
     * meta.graph-version is required in all data files.
     */
    getForFileVersion(filename: string, version: number): GraphType | undefined {
        for (const [pattern, versions] of this.versionedPatternMap) {
            if (this.matchesPattern(filename, pattern)) {
                return versions.get(version);
            }
        }
        return undefined;
    }

    /**
     * Get all registered graph types.
     */
    getAll(): GraphType[] {
        return Array.from(this.allVersions.values());
    }

    /**
     * Get a graph type by its versioned key ("{id}@{version}").
     */
    getByVersionKey(key: string): GraphType | undefined {
        return this.allVersions.get(key);
    }

    /**
     * List all registered version keys.
     */
    listVersionKeys(): string[] {
        return Array.from(this.allVersions.keys());
    }

    private matchesPattern(filename: string, pattern: string): boolean {
        // Simple glob: *.flow.yaml → matches 'anything.flow.yaml'
        const ext = pattern.replace('*', '');
        return filename.endsWith(ext);
    }

    // ============================================================
    // Domain Extension Support
    // ============================================================

    /**
     * Register a domain extension.
     * Domains overlay additional constraints and default shapes on base graph types.
     */
    registerDomain(domain: DomainRegistration): void {
        this.domains.set(domain.id, domain);
    }

    /**
     * Load and register a domain from a folder.
     * The folder should contain:
     *   - *.domain.json (domain schema)
     *   - domain.yaml (optional - domain metadata with default-shapes)
     */
    async registerDomainFromFolder(folderPath: string): Promise<void> {
        const entries = await readdir(folderPath);
        
        // Find domain schema file
        const schemaFile = entries.find(f => f.endsWith('.domain.json'));
        if (!schemaFile) {
            throw new Error(`No *.domain.json file found in ${folderPath}`);
        }
        
        const schemaText = await readFile(join(folderPath, schemaFile), 'utf-8');
        const schema = JSON.parse(schemaText);
        
        // Extract domain ID from schema or folder name
        const domainId = (schema as Record<string, unknown>)['$id'] as string
            ?? folderPath.split('/').slice(-2).join('/');
        
        // Load optional domain.yaml for default-shapes
        let defaultShapes: Record<string, string> | undefined;
        if (entries.includes('domain.yaml')) {
            const { parse } = await import('yaml');
            const metaText = await readFile(join(folderPath, 'domain.yaml'), 'utf-8');
            const meta = parse(metaText) as Record<string, unknown>;
            defaultShapes = meta['default-shapes'] as Record<string, string>;
        }
        
        this.registerDomain({ id: domainId, schema, defaultShapes });
    }

    /**
     * Auto-scan a domains directory and register all found domains.
     * Expected structure: domains/{domain-name}/{version}/
     */
    async registerAllDomainsFromDirectory(dirPath: string): Promise<string[]> {
        const errors: string[] = [];
        
        let entries;
        try {
            entries = await readdir(dirPath, { withFileTypes: true });
        } catch {
            // domains/ directory doesn't exist — that's fine
            return errors;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const domainPath = join(dirPath, entry.name);
            
            // Scan for version subfolders
            const versionEntries = await readdir(domainPath, { withFileTypes: true });
            for (const vEntry of versionEntries) {
                if (!vEntry.isDirectory()) continue;
                if (!/^v\d+$/.test(vEntry.name)) continue;
                
                const versionPath = join(domainPath, vEntry.name);
                try {
                    await this.registerDomainFromFolder(versionPath);
                } catch (err) {
                    const message = err instanceof Error
                        ? `Domain '${entry.name}/${vEntry.name}': ${err.message}`
                        : `Domain '${entry.name}/${vEntry.name}': unknown error`;
                    errors.push(message);
                }
            }
        }

        return errors;
    }

    /**
     * Get a registered domain by ID.
     */
    getDomain(domainId: string): DomainRegistration | undefined {
        return this.domains.get(domainId);
    }

    /**
     * List all registered domain IDs.
     */
    listDomainIds(): string[] {
        return Array.from(this.domains.keys());
    }

    /**
     * Resolve a graph type with a domain extension applied.
     * Composes the base schema with the domain schema and merges default shapes.
     * 
     * @param baseType - The base graph type
     * @param domainId - The domain extension ID
     * @returns A new GraphType with composed schema and merged defaults
     * @throws DomainNotFoundError if the domain is not registered
     */
    resolveWithDomain(baseType: GraphType, domainId: string): GraphType {
        const domain = this.domains.get(domainId);
        if (!domain) {
            throw new DomainNotFoundError(domainId);
        }

        // Compose schemas
        const composedSchema = this.schemaResolver.composeSchemas(
            baseType.schema,
            domain.schema
        );

        // Merge default shapes
        const mergedDefaults = this.schemaResolver.mergeDefaultShapes(
            baseType.mapping.nodeShapes.defaultShapes,
            domain.defaultShapes
        );

        // Create new mapping with merged defaults
        const composedMapping: GraphMapping = {
            ...baseType.mapping,
            nodeShapes: {
                ...baseType.mapping.nodeShapes,
                defaultShapes: mergedDefaults
            }
        };

        return {
            ...baseType,
            schema: composedSchema,
            mapping: composedMapping
        };
    }
}
