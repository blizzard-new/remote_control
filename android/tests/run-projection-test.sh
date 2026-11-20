#!/usr/bin/env bash
# Run the already-built app and test APKs on the selected API 33 emulator.
set -euo pipefail
cd "$(dirname "$0")/.."
adb install -r -t app/build/outputs/apk/debug/app-debug.apk
adb install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk

result=$(mktemp)
trap 'rm -f "$result"' EXIT
adb shell am instrument -w org.remotecontrol.share.test/androidx.test.runner.AndroidJUnitRunner | tee "$result"
# adb can return success even when an instrumentation assertion fails.
grep -Eq '^OK \([1-9][0-9]* tests?\)' "$result"
