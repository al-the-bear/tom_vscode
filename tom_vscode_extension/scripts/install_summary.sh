# Shared by install_extension.sh and compile_and_install.sh (sourced, bash):
# the closing lines of an install — where the VSIX is, and, when it was built
# without a Dart SDK, the warning about what it lacks.
#
#   tom_print_vsix_path <extension dir>
#   tom_print_no_dart_warning <reason> <from-source 0|1>
#   tom_print_layer_vsix_summary <extension dir> <platforms>
#   tom_print_layer_unpushed_warning <extension dir>
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

tom_print_vsix_path() {
    local vsix
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
        "CodeSpecs validation (validate_codespecs) is NOT in this VSIX." \
        "$dartscript" \
        "" \
        "On its first start the extension shows a page explaining what is" \
        "missing and how to add it." \
        "" \
        "To get both: install the Dart SDK (https://dart.dev/get-dart)" \
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
    local vsix
    vsix="$(tom_newest_vsix "$dir")"
    echo ""
    echo "──────── Private distribution VSIX ────────"
    tom_print_vsix_path "$dir"
    [ -n "$vsix" ] && ( cd "$dir" && node scripts/check-vsix-contents.cjs "$vsix" | sed -n '2,$p' )
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
