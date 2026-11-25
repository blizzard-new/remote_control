#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
version=$(python -c 'from native.updates import VERSION; print(VERSION)')
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

install -D -m755 dist/RemoteControlHost "$stage/usr/bin/uniway-remote"
install -D -m644 packaging/linux/uniway-remote.desktop "$stage/usr/share/applications/uniway-remote.desktop"
install -D -m644 README.md "$stage/usr/share/doc/uniway-remote/README.md"
mkdir "$stage/DEBIAN"
cat > "$stage/DEBIAN/control" <<EOF
Package: uniway-remote
Version: $version
Section: net
Priority: optional
Architecture: amd64
Maintainer: Uniway Remote <https://github.com/blizzard-new/remote_control>
Depends: libc6 (>= 2.35), libx11-6, libxcb1, libxtst6, libxrandr2, x11-xkb-utils, xdg-utils
Description: Uniway Remote cross-network desktop client
 Share and control an X11 desktop or connect to paired desktops and Android devices.
EOF
chmod 0644 "$stage/DEBIAN/control"
find "$stage" -type d -exec chmod 0755 {} +
dpkg-deb --root-owner-group --build "$stage" dist/RemoteControl-Linux-amd64.deb
