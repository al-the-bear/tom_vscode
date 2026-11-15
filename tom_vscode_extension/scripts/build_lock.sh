# shellcheck shell=bash
# The checkout's build lock for the install scripts (scripts/build-lock.cjs, qrfix5).
#
# Sourced by compile_and_install.sh, install_extension.sh and
# reinstall_for_testing.sh. `tom_build_lock_acquire <name>` takes the lock for
# this shell (its pid) or, under another holder (TOM_BUILD_LOCK_HOLDER: an
# outer install script, `npm test`), passes; another live holder stops the
# script with the message naming it. `tom_build_lock_release` removes the lock
# when this shell holds it; a script that ends without it leaves a stale lock,
# which the next one takes over.

tom_build_lock_acquire() {
    local dir
    dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if ! command -v node > /dev/null 2>&1 && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
        # shellcheck disable=SC1091
        . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" > /dev/null 2>&1 || true
    fi
    if ! command -v node > /dev/null 2>&1; then
        # The script's own Node check reports it; the lock is not what stops it.
        echo "⚠ No node on PATH: running without the build lock (.build.lock)."
        TOM_BUILD_LOCK_NONE=1
        return 0
    fi
    node "$dir/build-lock.cjs" acquire --pid "$$" --command "$1" || exit 1
    if [ -z "${TOM_BUILD_LOCK_HOLDER:-}" ]; then export TOM_BUILD_LOCK_HOLDER="$$"; fi
}

tom_build_lock_release() {
    local dir
    if [ -n "${TOM_BUILD_LOCK_NONE:-}" ]; then return 0; fi
    dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    node "$dir/build-lock.cjs" release --pid "$$" || true
}
