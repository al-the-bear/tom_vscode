import type { NodeData, EdgeData, TransformContext } from './types.js';

export class AstNodeTransformerRuntime {
    /**
     * Execute a JavaScript fragment with the given element and context.
     * The fragment is wrapped in a function with `node`/`edge` and `ctx`
     * as parameters, depending on the element type.
     *
     * Returns the Mermaid lines produced by the fragment.
     */
    execute(
        jsFragment: string,
        element: NodeData | EdgeData,
        context: TransformContext
    ): string[] {
        try {
            const isNode = 'id' in element && 'type' in element;
            const paramName = isNode ? 'node' : 'edge';

            // Wrap the JS fragment in a function
            // Provides: node/edge, ctx
            const fn = new Function(
                paramName, 'ctx',
                jsFragment
            ) as (
                element: NodeData | EdgeData,
                ctx: TransformContext
            ) => string[];

            const result = fn(element, context);

            // Validate return type
            if (!Array.isArray(result)) {
                console.warn(
                    `Transform for ${isNode ? (element as NodeData).id : 'edge'} ` +
                    `did not return string[]. Got: ${typeof result}`
                );
                return context.output;
            }

            return result;
        } catch (error) {
            console.error('Transform execution error:', error);
            return context.output; // fall back to default output
        }
    }
}
