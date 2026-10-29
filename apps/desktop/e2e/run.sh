#!/usr/bin/env bash
# Runs the real-app smoke test headless on Linux, against an already built debug binary
# (target/debug/armada; `npm run tauri build -- --debug --no-bundle` in apps/desktop).
#
# Needs: tauri-driver (cargo install tauri-driver --locked), WebKitWebDriver
# (apt: webkit2gtk-driver), xvfb (apt: xvfb), dbus-run-session (apt: dbus-daemon/dbus-x11).
# The app runs with a throwaway HOME and XDG dirs, so it starts on first-run (onboarding)
# with no data and never touches your real settings, agents or keychain.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

home="$(mktemp -d)"
trap 'rm -rf "$home"' EXIT
mkdir -p "$home"/{.config,.local/share,.cache,.local/state,run}
chmod 700 "$home/run"

export HOME="$home"
export XDG_CONFIG_HOME="$home/.config" XDG_DATA_HOME="$home/.local/share"
export XDG_CACHE_HOME="$home/.cache" XDG_STATE_HOME="$home/.local/state"
export XDG_RUNTIME_DIR="$home/run"
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
export ARMADA_BIN="${ARMADA_BIN:-$here/../../../target/debug/armada}"

cd "$here"
# Fresh X server and session bus per run; -a picks a free display number.
exec xvfb-run -a -s "-screen 0 1600x1000x24" dbus-run-session -- node smoke.mjs
