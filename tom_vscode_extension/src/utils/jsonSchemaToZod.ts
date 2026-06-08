/**
 * JSON Schema → Zod raw-shape converter (plan §7).
 *
 * The MCP `tool()` factory takes a Zod raw shape (an object-properties map),
 * not JSON Schema, but our shared tools store `inputSchema` as JSON Schema.
 * This converts the subset we actually use (string, number, integer, boolean,
 * array, object, enum) — good enough for every tool in `tool-executors.ts`.
 *
 * Extracted from `agent-sdk-transport.ts` so the Agent SDK path and the
 * standalone MCP server (`mcpServer-handler.ts`) share ONE converter and cannot
 * drift apart.
 */

import { z } from 'zod';

/** Convert a single JSON-Schema property node into a Zod type. */
export function jsonSchemaPropertyToZod(prop: unknown): z.ZodTypeAny {
    if (!prop || typeof prop !== 'object') {
        return z.unknown();
    }
    const p = prop as Record<string, unknown>;
    const enumVals = Array.isArray(p.enum)
        ? (p.enum as unknown[]).filter((v): v is string => typeof v === 'string')
        : undefined;
    if (enumVals && enumVals.length > 0) {
        return z.enum(enumVals as [string, ...string[]]);
    }
    switch (p.type) {
        case 'string':
            return z.string();
        case 'number':
            return z.number();
        case 'integer':
            return z.number().int();
        case 'boolean':
            return z.boolean();
        case 'array': {
            const item = p.items ? jsonSchemaPropertyToZod(p.items) : z.unknown();
            return z.array(item);
        }
        case 'object':
            return z.record(z.string(), z.unknown());
        default:
            return z.unknown();
    }
}

/**
 * Convert a JSON-Schema object node into a Zod raw shape: each property becomes
 * a Zod type, carrying its `description`, and is `.optional()` unless listed in
 * `required`.
 */
export function toRawShape(schema: Record<string, unknown> | undefined): Record<string, z.ZodTypeAny> {
    const shape: Record<string, z.ZodTypeAny> = {};
    const props = (schema?.properties ?? {}) as Record<string, unknown>;
    const required = new Set<string>(Array.isArray(schema?.required) ? (schema!.required as string[]) : []);
    for (const [name, prop] of Object.entries(props)) {
        let zt = jsonSchemaPropertyToZod(prop);
        const desc = (prop as { description?: unknown } | undefined)?.description;
        if (typeof desc === 'string' && desc) {
            zt = zt.describe(desc);
        }
        if (!required.has(name)) {
            zt = zt.optional();
        }
        shape[name] = zt;
    }
    return shape;
}
