/**
 * Tests for the shared JSON-Schema → Zod converter (plan §7, todo #15).
 *
 * `toRawShape` / `jsonSchemaPropertyToZod` were inline in `agent-sdk-transport.ts`
 * (untested, behind a handler with no test glob). Extracting them into
 * `src/utils/jsonSchemaToZod.ts` lets both the Agent SDK path and the standalone
 * MCP server (#16) share ONE converter, and gives it real coverage. These tests
 * pin the supported subset (string, number, integer, boolean, array, object,
 * enum, fallback) and the object-shape rules (required vs optional, description).
 *
 * Behaviour is asserted through `safeParse` so the tests don't depend on Zod's
 * internal type tags.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { jsonSchemaPropertyToZod, toRawShape } from '../jsonSchemaToZod.js';

describe('jsonSchemaPropertyToZod — scalar types', () => {
    test('string accepts strings, rejects numbers', () => {
        const zt = jsonSchemaPropertyToZod({ type: 'string' });
        assert.equal(zt.safeParse('hello').success, true);
        assert.equal(zt.safeParse(42).success, false);
    });

    test('number accepts floats', () => {
        const zt = jsonSchemaPropertyToZod({ type: 'number' });
        assert.equal(zt.safeParse(3.5).success, true);
        assert.equal(zt.safeParse('x').success, false);
    });

    test('integer rejects non-integers', () => {
        const zt = jsonSchemaPropertyToZod({ type: 'integer' });
        assert.equal(zt.safeParse(3).success, true);
        assert.equal(zt.safeParse(3.5).success, false);
    });

    test('boolean accepts only booleans', () => {
        const zt = jsonSchemaPropertyToZod({ type: 'boolean' });
        assert.equal(zt.safeParse(true).success, true);
        assert.equal(zt.safeParse('true').success, false);
    });
});

describe('jsonSchemaPropertyToZod — composite types', () => {
    test('array of strings validates element type', () => {
        const zt = jsonSchemaPropertyToZod({ type: 'array', items: { type: 'string' } });
        assert.equal(zt.safeParse(['a', 'b']).success, true);
        assert.equal(zt.safeParse(['a', 1]).success, false);
    });

    test('array without items accepts any element', () => {
        const zt = jsonSchemaPropertyToZod({ type: 'array' });
        assert.equal(zt.safeParse(['a', 1, true]).success, true);
    });

    test('object becomes a string-keyed record', () => {
        const zt = jsonSchemaPropertyToZod({ type: 'object' });
        assert.equal(zt.safeParse({ k: 'v', n: 1 }).success, true);
        assert.equal(zt.safeParse('not-an-object').success, false);
    });

    test('enum restricts to the listed string values', () => {
        const zt = jsonSchemaPropertyToZod({ type: 'string', enum: ['a', 'b'] });
        assert.equal(zt.safeParse('a').success, true);
        assert.equal(zt.safeParse('c').success, false);
    });
});

describe('jsonSchemaPropertyToZod — fallback', () => {
    test('unknown/missing type accepts anything', () => {
        assert.equal(jsonSchemaPropertyToZod({ type: 'weird' }).safeParse(123).success, true);
        assert.equal(jsonSchemaPropertyToZod(undefined).safeParse(123).success, true);
        assert.equal(jsonSchemaPropertyToZod('not-an-object').safeParse(123).success, true);
    });
});

describe('toRawShape', () => {
    const schema = {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'the name' },
            count: { type: 'integer' },
        },
        required: ['name'],
    };

    test('required field is required, optional field may be omitted', () => {
        const obj = z.object(toRawShape(schema));
        assert.equal(obj.safeParse({ name: 'x' }).success, true);
        assert.equal(obj.safeParse({ count: 1 }).success, false); // name missing
    });

    test('carries the JSON-Schema description onto the Zod field', () => {
        const shape = toRawShape(schema);
        assert.equal(shape.name.description, 'the name');
    });

    test('empty/undefined schema yields an empty shape', () => {
        assert.deepEqual(Object.keys(toRawShape(undefined)), []);
        assert.deepEqual(Object.keys(toRawShape({})), []);
    });
});
