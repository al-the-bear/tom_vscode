# shellcheck shell=bash
# Node and the Dart SDK for the install scripts (compile_and_install.sh,
# install_extension.sh), sourced by both (vscimpb157).
#
# A shell without `node` on PATH once ran the Dart lookup, `node
# scripts/find-dart.cjs`, as `node: command not found` (exit 127), which the
# script read as "no Dart SDK found": it built and installed a VSIX without
# DartScript and CodeSpecs validation although the Dart SDK was there. So:
#
#   tom_ensure_node          Node.js >= 20 on PATH, loading nvm (its default,
#                            else Node 20) when node is missing or too old;
#                            prints why and returns 1 when there is none.
#   tom_find_dart <dir>      runs the lookup in <dir>: prints the folder that
#                            holds `dart` and returns 0; returns 1 when no Dart
#                            SDK was found (find-dart.cjs's "not found");
#                            returns 2 when the lookup could not run (any other
#                            exit: no node, a crash), which is an error, never
#                            "no Dart SDK".
#   tom_refuse_degrading_install
#                            returns 1 (with the reason) when a build without
#                            Dart that nobody asked for (no --no-dart, no
#                            TOM_NO_DART=1) would replace an installed
#                            extension that carries tom_bs for this platform.
#
# TOM_EXTENSIONS_DIR overrides ~/.vscode/extensions (tests).

tom_node_major() {
    command -v node >/dev/null 2>&1 || { echo 0; return; }
    node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1 | grep -E '^[0-9]+$' || echo 0
}

tom_ensure_node() {
    local major
    major="$(tom_node_major)"
    if [ "$major" -ge 20 ]; then echo "✅ Node.js $(node --version) ($(command -v node))"; return 0; fi
    local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
    if [ -s "$nvm_dir/nvm.sh" ]; then
        export NVM_DIR="$nvm_dir"
        if [ "$major" = "0" ]; then echo "ℹ️  node is not on PATH: loading nvm ($NVM_DIR)"; else echo "⚠️  Node.js $major is below the required 20: loading nvm ($NVM_DIR)"; fi
        # shellcheck disable=SC1091
        \. "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
        nvm use default >/dev/null 2>&1 || true
        major="$(tom_node_major)"
        if [ "$major" -lt 20 ]; then
            if nvm list 2>/dev/null | grep -q "v20"; then
                echo "📦 Switching to Node.js 20..."
                nvm use 20 >/dev/null 2>&1 || true
            else
                echo "📦 Installing Node.js 20 (LTS)..."
                nvm install 20 && nvm use 20 >/dev/null 2>&1 || true
            fi
            major="$(tom_node_major)"
        fi
    fi
    if [ "$major" -ge 20 ]; then
        echo "✅ Node.js $(node --version) ($(command -v node))"
        return 0
    fi
    if [ "$major" = "0" ]; then
        echo "❌ node not found: Node.js >= 20 is needed on PATH (or nvm with a Node 20 in ${NVM_DIR:-$HOME/.nvm}). Nothing was built."
    else
        echo "❌ Node.js $major is below the required 20, and nvm could not provide Node 20. Nothing was built."
    fi
    return 1
}

tom_find_dart() {
    local dir="$1" out status
    # Not `out=$(...); status=$?`: under `set -e` a failing assignment would end the caller.
    out="$(cd "$dir" && node scripts/find-dart.cjs)" && status=0 || status=$?
    case "$status" in
        0) printf '%s\n' "$out"; return 0 ;;
        1) return 1 ;;
        *)
            echo "❌ The Dart SDK lookup could not run (node scripts/find-dart.cjs exited $status). This is not \"no Dart SDK\": fix it (is node on PATH?), or pass --no-dart to build without Dart." >&2
            return 2 ;;
    esac
}

tom_refuse_degrading_install() {
    [ "${TOM_NO_DART:-0}" = "1" ] || return 0
    [ "${TOM_NO_DART_REASON:-}" = "no Dart SDK found" ] || return 0
    local platform ext_dir hit
    platform="$(node -p "process.platform + '-' + process.arch" 2>/dev/null)" || return 0
    ext_dir="${TOM_EXTENSIONS_DIR:-$HOME/.vscode/extensions}"
    hit="$(ls -d "$ext_dir"/peter-nicolai-alexis-kyaw.tom-ai-extension-*/bin/"$platform"/tom_bs* 2>/dev/null | head -n 1)"
    [ -n "$hit" ] || return 0
    echo "❌ Not installing: no Dart SDK was found, and the installed extension carries tom_bs ($hit)."
    echo "   Installing this build would remove DartScript and CodeSpecs validation. Put the Dart SDK on PATH (or set DART_SDK / FLUTTER_ROOT),"
    echo "   or pass --no-dart to install a build without Dart on purpose."
    return 1
}
