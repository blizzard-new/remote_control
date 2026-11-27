#!/usr/bin/env bash
# Run the already-built app and test APKs on the selected emulator. Optionally select one instrumentation test class.
set -euo pipefail
cd "$(dirname "$0")/.."
adb install -r -t app/build/outputs/apk/debug/app-debug.apk
adb install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk

result=$(mktemp)
trap 'rm -f "$result"' EXIT
args=()
if [[ -n ${1:-} ]]; then args=(-e class "$1"); fi
adb shell am instrument -w "${args[@]}" org.remotecontrol.share.test/androidx.test.runner.AndroidJUnitRunner | tee "$result"
# adb can return success even when an instrumentation assertion fails.
if ! grep -Eq '^OK \([1-9][0-9]* tests?\)' "$result"; then
    adb logcat -d -s RemoteScreenTLS:W AndroidRuntime:E
    exit 1
fi
