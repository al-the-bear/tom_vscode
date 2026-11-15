# VS Code Bridge Examples

The example scripts for the bridge are in the [User Guide](USER_GUIDE.md#examples):
complete scripts, each run through `tom_bs` as written. Run one with
`@T: Execute File` (or `@T: Execute as Script`) on its file.

| Example | Shows |
| --- | --- |
| [The smallest script](USER_GUIDE.md#the-smallest-script) | `main()`, its result and `print` output |
| [Messages and input](USER_GUIDE.md#messages-and-input) | notifications with buttons, an input box, a quick pick |
| [Files in the workspace](USER_GUIDE.md#files-in-the-workspace) | finding, reading and writing files, opening one |
| [Commands and settings](USER_GUIDE.md#commands-and-settings) | running a command, reading a setting, the status bar |
| [VsCodeHelper](USER_GUIDE.md#vscodehelper) | the convenience layer of the scripting API |
| [Progress and batches of files](USER_GUIDE.md#progress-and-batches-of-files) | `VsProgress`, `FileBatch` |
| [Running a program](USER_GUIDE.md#running-a-program) | `dart:io` in the bridge process |
| [Errors](USER_GUIDE.md#errors) | ending with a message, an uncaught exception |
| [A document as the result](USER_GUIDE.md#a-document-as-the-result) | `action: showDocument` |
| [Copilot](USER_GUIDE.md#copilot) | `VsCodeHelper.askCopilot` |

Programs that drive a window from outside VS Code (over the CLI integration
server) are shown by `tom_vscode_scripting_api`'s
[examples](../../tom_vscode_scripting_api/example/) and checked end to end by
[`test_scripts/scripting_api_suite.dart`](../test_scripts/).
