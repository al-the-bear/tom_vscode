/**
 * Schema resolver for composing base graph type schemas with domain overlays.
 * Uses JSON Schema 2020-12 `allOf` for composition.
 */

export interface DomainRegistration {
    /** Domain ID, e.g., 'ci-pipeline/v1' */
    id: string;
    
    /** Domain schema to compose with base schema via allOf */
    schema: object;
    
    /** Additional default shapes for this domain */
    defaultShapes?: Record<string, string>;
}

export class SchemaResolver {
    /**
     * Compose a base graph type schema with a domain overlay schema.
     * Uses JSON Schema 2020-12 `allOf` to combine constraints.
     * 
     * @param baseSchema - The base graph type schema (e.g., flowchart.schema.json)
     * @param domainSchema - The domain extension schema
     * @returns A new schema object with both schemas composed via allOf
     */
    composeSchemas(baseSchema: object, domainSchema: object): object {
        // Deep clone the base schema to avoid mutation
        const composed = JSON.parse(JSON.stringify(baseSchema));
        
        // If the domain schema has node $defs overrides, we need to merge them
        const domain = domainSchema as Record<string, unknown>;
        const base = composed as Record<string, unknown>;
        
        // If domain specifies $defs with node overrides, use allOf composition
        if (domain['$defs'] && (domain['$defs'] as Record<string, unknown>)['node']) {
            const baseDefs = base['$defs'] as Record<string, unknown> ?? {};
            const domainDefs = domain['$defs'] as Record<string, unknown>;
            
            // For node definition, use allOf to combine base + domain constraints
            if (baseDefs['node'] && domainDefs['node']) {
                baseDefs['node'] = {
                    allOf: [
                        baseDefs['node'],
                        domainDefs['node']
                    ]
                };
            }
        }
        
        // If domain specifies additional root-level constraints
        if (domain['properties']) {
            const baseProps = base['properties'] as Record<string, unknown> ?? {};
            const domainProps = domain['properties'] as Record<string, unknown>;
            
            // Merge domain properties into base
            for (const [key, value] of Object.entries(domainProps)) {
                if (!baseProps[key]) {
                    baseProps[key] = value;
                }
            }
        }
        
        return composed;
    }
    
    /**
     * Merge default shapes from domain into base graph type mapping.
     * Domain defaults take priority over base defaults.
     * 
     * @param baseDefaults - Default shapes from base graph type mapping
     * @param domainDefaults - Default shapes from domain registration
     * @returns Merged default shapes
     */
    mergeDefaultShapes(
        baseDefaults: Record<string, string> | undefined,
        domainDefaults: Record<string, string> | undefined
    ): Record<string, string> {
        return {
            ...baseDefaults,
            ...domainDefaults
        };
    }
}
