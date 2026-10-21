/**
 * The MCP server's tool-selection modes, free of `vscode` so the Status Page
 * card (`mcpServerCard.ts`) can parse them without the extension host.
 *
 *   - `all`      every tool;
 *   - `readonly` the read-only tools of the registry as it is at each start;
 *   - `custom`   the saved `enabledTools` list.
 */
export type McpToolsMode = 'all' | 'readonly' | 'custom';

/** `value` when it names a tool-selection mode, else undefined. */
export function asMcpToolsMode(value: unknown): McpToolsMode | undefined {
    return value === 'all' || value === 'readonly' || value === 'custom' ? value : undefined;
}
