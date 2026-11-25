import type { TrailSubsystem } from './trailService';

/**
 * Pre-built `TrailSubsystem` literals for the subsystems that don't
 * need per-call parameters. Kept in `services/` rather than alongside
 * the handler that first used it so service-layer modules (e.g.
 * `history-compaction.ts`) don't have to reach up into `handlers/` —
 * which reversed the handler→service dependency direction.
 *
 * Subsystems that require per-call fields (`localLlm` needs a
 * `configName`; `lmApi` needs a `model`) do not get a constant here
 * — their literals are built at the call site.
 */

/** `TrailSubsystem` literal for Anthropic-routed trails. */
export const ANTHROPIC_SUBSYSTEM = { type: 'anthropic' as const } satisfies TrailSubsystem;

/** `TrailSubsystem` literal for MCP-server-routed trails. */
export const MCP_SUBSYSTEM = { type: 'mcp' as const } satisfies TrailSubsystem;
