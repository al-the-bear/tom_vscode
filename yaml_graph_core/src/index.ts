// Core classes
export { ConversionEngine } from './conversion-engine.js';
export { GraphTypeRegistry, GraphTypeConflictError, DomainNotFoundError } from './graph-type-registry.js';
export { MappingLoader, MappingParserV1, UnsupportedMappingVersionError } from './mapping-loader.js';
export { SchemaValidator } from './schema-validator.js';
export { SchemaResolver } from './schema-resolver.js';
export { YamlParserWrapper } from './yaml-parser-wrapper.js';
export { AstNodeTransformerRuntime } from './ast-node-transformer.js';

// Types
export type {
    GraphType,
    GraphMapping,
    ConversionCallbacks,
    ConversionResult,
    NodeData,
    EdgeData,
    TransformContext,
    TransformRule,
    SourceRange,
    ValidationError,
    AstNodeTransformer,
    MappingParser,
} from './types.js';

export type { ParsedYaml } from './yaml-parser-wrapper.js';
export type { DomainRegistration } from './schema-resolver.js';
