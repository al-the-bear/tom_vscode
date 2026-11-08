# Shared by install_extension.sh and compile_and_install.sh (sourced, bash):
# the closing lines of an install — where the VSIX is, and, when it was built
# without a Dart SDK, the warning about what it lacks.
#
#   tom_print_vsix_path <extension dir>
#   tom_print_no_dart_warning <reason> <from-source 0|1>
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
