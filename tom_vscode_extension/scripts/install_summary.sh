# Shared by install_extension.sh and compile_and_install.sh (sourced, bash):
# the closing lines of an install — where the VSIX is, and, when it was built
# without a Dart SDK, the warning about what it lacks.
#
#   tom_print_vsix_path <extension dir>
#   tom_print_no_dart_warning <reason> <from-source 0|1>
#   tom_print_layer_vsix_summary <extension dir> <platforms>
#   tom_print_layer_unpushed_warning <extension dir>
#   tom_platform_vsixes <extension dir>
#
# The last lines are owned by whichever script runs last (the wrapper when
# there is one, TOM_SKIP_FINISH_TS=1), so they are printed exactly once.

# The newest VSIX in the extension folder, as an absolute path ("" if none).
tom_newest_vsix() {
    local dir="$1"
    local name
    name="$(cd "$dir" && ls -t ./*.vsix 2>/dev/null | head -n 1)"
    [ -n "$name" ] && echo "$dir/${name#./}"
    return 0
}

# The per-platform VSIX files in the extension folder (tom-ai-extension-<platform>.vsix,
# scripts/vsix-split.cjs), absolute paths, one per line, newest first ("" if none).
tom_platform_vsixes() {
    ( cd "$1" && node scripts/vsix-split.cjs list ) 2>/dev/null || true
}

tom_print_vsix_path() {
    local vsix platform_vsixes
    platform_vsixes="$(tom_platform_vsixes "$1")"
    if [ -n "$platform_vsixes" ]; then
        # One VSIX per platform: each installs only on the platform in its name.
        echo ""
        echo "📦 One VSIX per platform (VS Code installs each only on its own platform):"
        while IFS= read -r vsix; do
            [ -n "$vsix" ] && echo "   $vsix"
        done <<< "$platform_vsixes"
        echo "   On another machine: copy its platform's file there and run  code --install-extension <path-to>/tom-ai-extension-<platform>.vsix"
        if [ -f "$1/workspace_template.zip" ]; then
            echo "📦 Workspace template: $1/workspace_template.zip (also inside each VSIX)"
        fi
        return 0
    fi
    vsix="$(tom_newest_vsix "$1")"
    [ -z "$vsix" ] && return 0
    echo ""
    echo "📦 VSIX: $vsix"
    echo "   On another machine: copy it there and run  code --install-extension <path-to>/$(basename "$vsix")"
    # The workspace template the setup unpacks: inside the VSIX, and this copy beside it.
    if [ -f "$1/workspace_template.zip" ]; then
        echo "📦 Workspace template: $1/workspace_template.zip (also inside the VSIX)"
    fi
}

tom_print_no_dart_warning() {
    local reason="$1"
    local from_source="$2"
    local platform
    platform="$(node -p "process.platform + '-' + process.arch" 2>/dev/null || echo "this platform")"
    local dartscript
    if [ "$from_source" = "1" ]; then
        dartscript="DartScript (tom_bs) is NOT in this VSIX for $platform."
    else
        dartscript="DartScript (tom_bs): only the prebuilt binaries bundled above."
    fi
    local red=$'\033[1;31m'
    local reset=$'\033[0m'
    local rule
    rule="$(printf '!%.0s' $(seq 1 76))"
    local line
    echo ""
    printf '%s%s%s\n' "$red" "$rule" "$reset"
    for line in \
        "" \
        "WARNING: BUILT WITHOUT A DART SDK ($reason)" \
        "" \
        "CodeSpecs validation and mapping and the TomSpecs process checks" \
        "(tomspecs) are NOT in this VSIX." \
        "$dartscript" \
        "" \
        "On its first start the extension shows a page explaining what is" \
        "missing and how to add it." \
        "" \
        "To get them: install the Dart SDK (https://dart.dev/get-dart)" \
        "and run compile_and_install again." \
        ""; do
        printf '%s!! %-70s !!%s\n' "$red" "$line" "$reset"
    done
    printf '%s%s%s\n' "$red" "$rule" "$reset"
}

# The closing block of a VSIX packaged with binaries from the binaries layer
# (create_currentbinaries_vsix.sh, create_fleetcompiled_vsix.sh): the VSIX and
# template paths, the binaries it carries per platform, and each binary's build
# stamp and freshness. <platforms>: comma-separated, "" for the default set.
#
#   tom_print_layer_vsix_summary <extension dir> <platforms>
tom_print_layer_vsix_summary() {
    local dir="$1"
    local vsix platform
    echo ""
    echo "──────── Private distribution VSIX (one per platform) ────────"
    tom_print_vsix_path "$dir"
    # Each VSIX: the binaries and build tools it carries for its platform.
    while IFS= read -r vsix; do
        [ -z "$vsix" ] && continue
        platform="$(basename "$vsix" .vsix)"
        platform="${platform#tom-ai-extension-}"
        echo "   $(basename "$vsix"):"
        ( cd "$dir" && node scripts/check-vsix-contents.cjs "$vsix" --target "$platform" | sed -n '2,$p' )
    done <<< "$(tom_platform_vsixes "$dir")"
    if [ -n "$2" ]; then
        ( cd "$dir" && node scripts/binaries-layer.cjs report --platforms "$2" )
    else
        ( cd "$dir" && node scripts/binaries-layer.cjs report )
    fi
}

# Binaries layer commits the remote does not have (each refused layer push of
# an install leaves one; the refusal itself scrolls past mid-build). Silent
# when the layer is level; counts only, never merges or pushes.
#
#   tom_print_layer_unpushed_warning <extension dir>
tom_print_layer_unpushed_warning() {
    ( cd "$1" && node scripts/binaries-layer.cjs unpushed ) || true
}

# The VSIX as the GitHub Release of tom_binaries (scripts/vsix-release.cjs).
# tom_release_precheck <script dir> <no-release 0|1>: run at the start of a
# create_*_vsix script; prints `ok <commit>` or `skip <why>`.
tom_release_precheck() {
    if [ "$2" = "1" ]; then echo "skip --no-release given"; return 0; fi
    ( cd "$1" && node scripts/vsix-release.cjs precheck ) 2>/dev/null || echo "skip the tom_vscode checkout could not be checked"
}

# tom_release_publish <script dir> <vsix> <script name> <precheck line> <no-release 0|1>:
# run at its end; uploads the VSIX and writes vscode_extension/vsix/README.md, or says why not.
# <vsix>: one file, or several, one per line (the per-platform VSIX, tom_platform_vsixes).
tom_release_publish() {
    echo ""
    echo "──────── The VSIX as a download (GitHub Release of tom_binaries) ────────"
    local args=(publish --script "$3" --precheck "$4")
    local vsix
    while IFS= read -r vsix; do
        [ -n "$vsix" ] && args+=(--vsix "$vsix")
    done <<< "$2"
    [ "$5" = "1" ] && args+=(--no-release)
    ( cd "$1" && node scripts/vsix-release.cjs "${args[@]}" ) || true
}
