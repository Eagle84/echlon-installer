#!/bin/sh
# Echlon customer pack, Linux and macOS. Checks Node, then hands over to the installer.
here=$(cd "$(dirname "$0")" && pwd)
need=20

major=0
if command -v node >/dev/null 2>&1; then
  major=$(node --version | sed 's/^v\([0-9]*\)\..*/\1/')
fi

if [ "$major" -lt "$need" ]; then
  echo "Echlon needs Node $need or newer, and it was not found on this computer."
  echo "Install it from https://nodejs.org (the LTS version), or on Debian/Ubuntu:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs"
  echo "Then run this script again."
  exit 1
fi

exec node "$here/installer/install.mjs" "$@"
