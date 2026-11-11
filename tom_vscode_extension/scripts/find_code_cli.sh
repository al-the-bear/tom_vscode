# Shared by install_extension.sh and reinstall_for_testing.sh (sourced, bash):
# the VS Code CLI that installs the VSIX.
#
#   tom_find_code_cli   prints the CLI's path (or `code` from PATH); nothing,
#                       and status 1, when none is found
#
# An agent's shell (Claude Code's Bash, the queue's Agent SDK) often has no
# /usr/local/bin on PATH, where VS Code's "Install 'code' command in PATH"
# puts its link; the CLI is still in the application. Looked for, in order:
#   1. $TOM_CODE_CLI, when it names an executable (an explicit choice)
#   2. `code` on PATH
#   3. the bundled CLI: macOS /Applications and ~/Applications (Stable, then
#      Insiders' code-insiders); Linux /usr/share/code/bin/code,
#      /snap/bin/code, Insiders' /usr/share/code-insiders/bin/code-insiders;
#      Windows (Git Bash) %LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code
#      and %ProgramFiles%\Microsoft VS Code\bin\code
# TOM_CODE_CLI_CANDIDATES (one path per line) replaces the list of step 3
# (the tests use it).

tom_code_cli_candidates() {
    if [ -n "${TOM_CODE_CLI_CANDIDATES:-}" ]; then
        printf '%s\n' "$TOM_CODE_CLI_CANDIDATES"
        return 0
    fi
    local app="Contents/Resources/app/bin"
    case "$(uname -s)" in
        Darwin)
            printf '%s\n' \
                "/Applications/Visual Studio Code.app/$app/code" \
                "$HOME/Applications/Visual Studio Code.app/$app/code" \
                "/Applications/Visual Studio Code - Insiders.app/$app/code-insiders" \
                "$HOME/Applications/Visual Studio Code - Insiders.app/$app/code-insiders"
            ;;
        Linux)
            printf '%s\n' \
                "/usr/share/code/bin/code" \
                "/snap/bin/code" \
                "/usr/share/code-insiders/bin/code-insiders"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            [ -n "${LOCALAPPDATA:-}" ] && printf '%s\n' "$LOCALAPPDATA/Programs/Microsoft VS Code/bin/code"
            [ -n "${PROGRAMFILES:-}" ] && printf '%s\n' "$PROGRAMFILES/Microsoft VS Code/bin/code"
            ;;
    esac
    return 0
}

tom_find_code_cli() {
    if [ -n "${TOM_CODE_CLI:-}" ] && [ -x "$TOM_CODE_CLI" ]; then
        echo "$TOM_CODE_CLI"
        return 0
    fi
    if command -v code &> /dev/null; then
        echo "code"
        return 0
    fi
    local candidate
    while IFS= read -r candidate; do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then
            echo "$candidate"
            return 0
        fi
    done < <(tom_code_cli_candidates)
    return 1
}
