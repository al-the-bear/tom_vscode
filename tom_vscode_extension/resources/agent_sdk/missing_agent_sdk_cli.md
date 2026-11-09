# Missing Agent SDK

The **Agent SDK** transport of the ANTHROPIC/LLM panel and the prompt queue
runs the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) and the Claude
CLI the SDK ships per platform (`@anthropic-ai/claude-agent-sdk-<platform>`).
The **direct API** transport, history compaction and memory extraction use the
Anthropic SDK (`@anthropic-ai/sdk`).

The extension does not carry these SDKs. It installs them on request, as the
**Anthropic provider**, into its own storage, where they stay across
extension updates.

## Install the Anthropic provider

Open **Provider SDKs** — the button on the Status Page, the button of the
message that brought you here, or the command `@T: Provider SDKs` — check
**Anthropic** and click **Install / Uninstall**. The extension downloads the
packages from the npm registry (no npm or Node needed) at the versions this
build is tested with, checks each download's integrity, and the next prompt
uses them. No reload is needed.

**Check for updates** on the same page looks for newer releases; an
**update to …** tag installs one. Nothing updates by itself.

## This machine

Platform: **{{platform}}**. The Agent SDK needs `{{package}}` for it. If the
Anthropic provider is installed and this message still appears, the SDK ships
no Claude CLI for this platform: the Agent SDK transport cannot run here, the
direct API transport can.

## What keeps working

Everything except the Anthropic transports: VS Code LM (Copilot models),
Copilot Chat, local models, the prompt queue, the tools, quests, todos and
processes. A profile on another transport works as before: pick one in the
ANTHROPIC/LLM panel, or give the queue items one.
