import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import type { ValidationError } from './types.js';

export class SchemaValidator {
    private ajv: Ajv2020;
    private cache = new Map<object, ValidateFunction>();

    constructor() {
        // Use Ajv 2020-12 for unevaluatedProperties support
        this.ajv = new Ajv2020({ allErrors: true, verbose: true });
    }

    /**
     * Validate data against a JSON Schema.
     * Returns an array of validation errors (empty if valid).
     */
    validate(data: unknown, schema: object): ValidationError[] {
        let validate = this.cache.get(schema);
        if (!validate) {
            // Strip $schema and $id meta-keywords to avoid ajv issues
            // ($schema references unsupported drafts, $id causes duplicates)
            const { $schema, $id, ...schemaWithout } = schema as Record<string, unknown>;
            validate = this.ajv.compile(schemaWithout);
            this.cache.set(schema, validate);
        }

        const valid = validate(data);

        if (valid) return [];

        return (validate.errors ?? []).map(err => ({
            path: err.instancePath || '/',
            message: err.message ?? 'Unknown validation error',
            severity: 'error' as const,
        }));
    }

    /**
     * Validate data and return a boolean (convenience method).
     */
    isValid(data: unknown, schema: object): boolean {
        return this.validate(data, schema).length === 0;
    }
}
