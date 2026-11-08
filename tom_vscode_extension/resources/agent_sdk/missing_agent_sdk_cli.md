# Missing Agent SDK CLI

The **Agent SDK** transport of the ANTHROPIC/LLM panel and the prompt queue
runs the Claude CLI, a program the Claude Agent SDK ships per platform in the
npm package `@anthropic-ai/claude-agent-sdk-<platform>`. npm installs only the
package of the machine it runs on, and a VSIX carries what was installed when
it was built.

## This machine

Platform: **{{platform}}**. This extension does not carry `{{package}}`, so the
Agent SDK transport cannot run here: every prompt it gets fails with a message
pointing to this page.

## What keeps working

Everything except the Agent SDK transport: the direct Anthropic API transport,
VS Code LM (Copilot models), Copilot Chat, local models, the prompt queue,
the tools, quests, todos and processes. A profile on another transport works
as before: pick one in the ANTHROPIC/LLM panel, or give the queue items one.

## Get the CLI into the extension

Build the VSIX with the Claude CLI of every fleet platform (darwin-arm64,
linux-x64, win32-x64), then install that VSIX here. From
`tom_ai/vscode/tom_vscode_extension/`:

- macOS / Linux: `./compile_and_install.sh --all-platforms`
- Windows: `.\compile_and_install.ps1 -AllPlatforms` (or `--all-platforms`)

The VSIX grows by about 110 MB per added platform: one with all three is about
380 MB instead of 160 MB. Without the option, a build carries only the CLI of
the machine it is built on.

Or build and install the extension on this machine: its own build carries its
own CLI.

For another platform (linux-arm64, musl Linux, darwin-x64, win32-arm64), build
on a machine of that platform: `--all-platforms` adds the fleet's three only.
