import { describe, it, expect } from 'vitest';
import { SchemaValidator } from '../src/schema-validator.js';

describe('SchemaValidator', () => {
    const validator = new SchemaValidator();

    // ================================================================
    // Flowchart schema validation
    // ================================================================
    describe('flowchart schema', () => {
        const flowchartSchema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "required": ["meta", "nodes", "edges"],
            "properties": {
                "meta": {
                    "type": "object",
                    "required": ["id", "title", "graph-version"],
                    "properties": {
                        "id": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
                        "title": { "type": "string" },
                        "graph-version": { "type": "integer", "minimum": 1 },
                        "direction": { "type": "string", "enum": ["TD", "LR", "BT", "RL"] }
                    }
                },
                "nodes": {
                    "type": "object",
                    "additionalProperties": {
                        "type": "object",
                        "required": ["type", "label"],
                        "properties": {
                            "type": {
                                "type": "string",
                                "enum": ["start", "end", "process", "decision", "subprocess"]
                            },
                            "label": { "type": "string" },
                            "status": { "type": "string", "enum": ["planned", "implemented", "deprecated"] }
                        }
                    }
                },
                "edges": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["from", "to"],
                        "properties": {
                            "from": { "type": "string" },
                            "to": { "type": "string" },
                            "label": { "type": "string" },
                            "style": { "type": "string", "enum": ["default", "dotted", "thick"] }
                        }
                    }
                }
            }
        };

        it('should validate a correct flowchart document', () => {
            const data = {
                meta: { id: 'test-flow', title: 'Test', 'graph-version': 1 },
                nodes: {
                    start: { type: 'start', label: 'Begin' },
                    end: { type: 'end', label: 'Done' }
                },
                edges: [{ from: 'start', to: 'end' }]
            };

            const errors = validator.validate(data, flowchartSchema);
            expect(errors).toEqual([]);
        });

        it('should detect missing meta section', () => {
            const data = {
                nodes: { a: { type: 'process', label: 'A' } },
                edges: []
            };

            const errors = validator.validate(data, flowchartSchema);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.message.includes('meta') || e.path === '')).toBeTruthy();
        });

        it('should detect missing required fields in meta', () => {
            const data = {
                meta: { id: 'test' }, // missing title and graph-version
                nodes: { a: { type: 'process', label: 'A' } },
                edges: []
            };

            const errors = validator.validate(data, flowchartSchema);
            expect(errors.length).toBeGreaterThan(0);
        });

        it('should detect invalid node type enum', () => {
            const data = {
                meta: { id: 'test', title: 'Test', 'graph-version': 1 },
                nodes: {
                    bad: { type: 'invalid-type', label: 'Bad' }
                },
                edges: []
            };

            const errors = validator.validate(data, flowchartSchema);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e =>
                e.path.includes('bad') || e.message.includes('enum')
            )).toBeTruthy();
        });

        it('should detect invalid edge style', () => {
            const data = {
                meta: { id: 'test', title: 'Test', 'graph-version': 1 },
                nodes: { a: { type: 'process', label: 'A' }, b: { type: 'process', label: 'B' } },
                edges: [{ from: 'a', to: 'b', style: 'invalid' }]
            };

            const errors = validator.validate(data, flowchartSchema);
            expect(errors.length).toBeGreaterThan(0);
        });

        it('should detect invalid meta.id pattern', () => {
            const data = {
                meta: { id: '123-Invalid', title: 'Test', 'graph-version': 1 },
                nodes: { a: { type: 'process', label: 'A' } },
                edges: []
            };

            const errors = validator.validate(data, flowchartSchema);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.message.includes('pattern'))).toBeTruthy();
        });

        it('should detect graph-version less than minimum', () => {
            const data = {
                meta: { id: 'test', title: 'Test', 'graph-version': 0 },
                nodes: { a: { type: 'process', label: 'A' } },
                edges: []
            };

            const errors = validator.validate(data, flowchartSchema);
            expect(errors.length).toBeGreaterThan(0);
        });

        it('should detect wrong type for edges (not array)', () => {
            const data = {
                meta: { id: 'test', title: 'Test', 'graph-version': 1 },
                nodes: { a: { type: 'process', label: 'A' } },
                edges: 'not-an-array'
            };

            const errors = validator.validate(data, flowchartSchema);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e =>
                e.path.includes('edges') || e.message.includes('array')
            )).toBeTruthy();
        });

        it('should allow optional fields to be omitted', () => {
            const data = {
                meta: { id: 'test', title: 'Test', 'graph-version': 1 },
                nodes: {
                    a: { type: 'process', label: 'A' } // no status, owner, tags
                },
                edges: [{ from: 'a', to: 'a' }] // no label, no style
            };

            const errors = validator.validate(data, flowchartSchema);
            expect(errors).toEqual([]);
        });

        it('should collect multiple errors at once', () => {
            const data = {
                // missing meta entirely
                nodes: {
                    bad1: { type: 'nope', label: 42 }, // wrong type enum, label not string
                    bad2: {} // missing both required fields
                },
                edges: 'string'
            };

            const errors = validator.validate(data, flowchartSchema);
            expect(errors.length).toBeGreaterThan(2);
        });
    });

    // ================================================================
    // State machine schema validation
    // ================================================================
    describe('state machine schema', () => {
        const stateMachineSchema = {
            "type": "object",
            "required": ["meta", "states", "transitions"],
            "properties": {
                "meta": {
                    "type": "object",
                    "required": ["id", "title", "graph-version"],
                    "properties": {
                        "id": { "type": "string" },
                        "title": { "type": "string" },
                        "graph-version": { "type": "integer", "minimum": 1 }
                    }
                },
                "states": {
                    "type": "object",
                    "additionalProperties": {
                        "type": "object",
                        "required": ["type", "label"],
                        "properties": {
                            "type": { "type": "string", "enum": ["initial", "state", "final", "composite"] },
                            "label": { "type": "string" }
                        }
                    }
                },
                "transitions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["from", "to", "event"],
                        "properties": {
                            "from": { "type": "string" },
                            "to": { "type": "string" },
                            "event": { "type": "string" },
                            "guard": { "type": "string" }
                        }
                    }
                }
            }
        };

        it('should validate a correct state machine', () => {
            const data = {
                meta: { id: 'sm', title: 'SM', 'graph-version': 1 },
                states: {
                    idle: { type: 'initial', label: 'Idle' },
                    active: { type: 'state', label: 'Active' }
                },
                transitions: [
                    { from: 'idle', to: 'active', event: 'start' }
                ]
            };

            expect(validator.validate(data, stateMachineSchema)).toEqual([]);
        });

        it('should detect missing event in transition', () => {
            const data = {
                meta: { id: 'sm', title: 'SM', 'graph-version': 1 },
                states: { idle: { type: 'initial', label: 'Idle' } },
                transitions: [{ from: 'idle', to: 'idle' }] // missing event
            };

            const errors = validator.validate(data, stateMachineSchema);
            expect(errors.length).toBeGreaterThan(0);
        });

        it('should detect invalid state type', () => {
            const data = {
                meta: { id: 'sm', title: 'SM', 'graph-version': 1 },
                states: { bad: { type: 'invalid', label: 'Bad' } },
                transitions: []
            };

            const errors = validator.validate(data, stateMachineSchema);
            expect(errors.length).toBeGreaterThan(0);
        });
    });

    // ================================================================
    // ER diagram schema validation
    // ================================================================
    describe('ER diagram schema', () => {
        const erSchema = {
            "type": "object",
            "required": ["meta", "entities"],
            "properties": {
                "meta": {
                    "type": "object",
                    "required": ["id", "title", "graph-version"],
                    "properties": {
                        "id": { "type": "string" },
                        "title": { "type": "string" },
                        "graph-version": { "type": "integer", "minimum": 1 }
                    }
                },
                "entities": {
                    "type": "object",
                    "additionalProperties": {
                        "type": "object",
                        "required": ["attributes"],
                        "properties": {
                            "attributes": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "required": ["name", "type"],
                                    "properties": {
                                        "name": { "type": "string" },
                                        "type": { "type": "string" },
                                        "key": { "type": "string", "enum": ["PK", "FK", "UK"] }
                                    }
                                }
                            }
                        }
                    }
                },
                "relationships": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["from", "to", "type"],
                        "properties": {
                            "from": { "type": "string" },
                            "to": { "type": "string" },
                            "type": {
                                "type": "string",
                                "enum": ["one-to-one", "one-to-many", "many-to-one", "many-to-many"]
                            },
                            "label": { "type": "string" }
                        }
                    }
                }
            }
        };

        it('should validate a correct ER diagram', () => {
            const data = {
                meta: { id: 'er', title: 'ER', 'graph-version': 1 },
                entities: {
                    User: {
                        attributes: [
                            { name: 'id', type: 'int', key: 'PK' },
                            { name: 'email', type: 'string' }
                        ]
                    }
                },
                relationships: [
                    { from: 'User', to: 'Role', type: 'many-to-one', label: 'has' }
                ]
            };

            expect(validator.validate(data, erSchema)).toEqual([]);
        });

        it('should detect missing attributes in entity', () => {
            const data = {
                meta: { id: 'er', title: 'ER', 'graph-version': 1 },
                entities: { User: {} } // missing attributes
            };

            const errors = validator.validate(data, erSchema);
            expect(errors.length).toBeGreaterThan(0);
        });

        it('should detect invalid relationship type', () => {
            const data = {
                meta: { id: 'er', title: 'ER', 'graph-version': 1 },
                entities: {
                    User: { attributes: [{ name: 'id', type: 'int' }] }
                },
                relationships: [
                    { from: 'User', to: 'Role', type: 'invalid-rel' }
                ]
            };

            const errors = validator.validate(data, erSchema);
            expect(errors.length).toBeGreaterThan(0);
        });

        it('should detect invalid attribute key', () => {
            const data = {
                meta: { id: 'er', title: 'ER', 'graph-version': 1 },
                entities: {
                    User: {
                        attributes: [{ name: 'id', type: 'int', key: 'INVALID' }]
                    }
                }
            };

            const errors = validator.validate(data, erSchema);
            expect(errors.length).toBeGreaterThan(0);
        });
    });

    // ================================================================
    // isValid() convenience method
    // ================================================================
    describe('isValid()', () => {
        const simpleSchema = {
            "type": "object",
            "required": ["name"],
            "properties": {
                "name": { "type": "string" }
            }
        };

        it('should return true for valid data', () => {
            expect(validator.isValid({ name: 'hello' }, simpleSchema)).toBe(true);
        });

        it('should return false for invalid data', () => {
            expect(validator.isValid({}, simpleSchema)).toBe(false);
        });

        it('should return false for wrong type', () => {
            expect(validator.isValid({ name: 123 }, simpleSchema)).toBe(false);
        });

        it('should return true for data with extra properties', () => {
            expect(validator.isValid({ name: 'hello', extra: true }, simpleSchema)).toBe(true);
        });
    });

    // ================================================================
    // Error structure
    // ================================================================
    describe('error structure', () => {
        it('should include path, message, and severity in errors', () => {
            const schema = {
                "type": "object",
                "required": ["name"],
                "properties": { "name": { "type": "string" } }
            };

            const errors = validator.validate({}, schema);
            expect(errors.length).toBe(1);
            expect(errors[0]).toHaveProperty('path');
            expect(errors[0]).toHaveProperty('message');
            expect(errors[0]).toHaveProperty('severity');
            expect(errors[0].severity).toBe('error');
        });

        it('should give useful path for nested errors', () => {
            const schema = {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": { "type": "string" }
                    }
                }
            };

            const errors = validator.validate({ items: ['ok', 42] }, schema);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors[0].path).toContain('items');
        });
    });
});
