#!/bin/sh
# Echlon customer pack, Linux and macOS. Makes sure there is a Node to run the installer on, then hands over to it.
# If this computer has no Node 20 or newer, it downloads the one pinned in runtime.txt into your home folder
# (nothing system-wide changes), checks it against the published checksum, and runs the installer on that.
here=$(cd "$(dirname "$0")" && pwd)
need=20

major=0
if command -v node >/dev/null 2>&1; then
  major=$(node --version | sed 's/^v\([0-9]*\)\..*/\1/')
fi

node=node
if [ "$major" -lt "$need" ]; then
  echo "Echlon needs Node $need or newer, and this computer does not have it."
  pin="${ECHLON_RUNTIME_FILE:-$here/runtime.txt}"
  version=$(sed -n 's/^version=//p' "$pin" 2>/dev/null | tr -d '\r' | head -n 1)
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) os= ;; esac
  case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) arch= ;; esac
  plat="$os-$arch"
  expected=$(sed -n "s/^$plat\.tar\.gz=//p" "$pin" 2>/dev/null | tr -d '\r' | head -n 1)
  if [ -z "$os" ] || [ -z "$arch" ] || [ -z "$version" ] || [ -z "$expected" ]; then
    echo "Echlon has no Node to offer for this computer ($plat). Install Node from https://nodejs.org (the LTS version), then run this script again."
    exit 1
  fi
  root="${ECHLON_RUNTIME_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/echlon/runtime}"
  folder="node-v$version-$plat"
  bin="$root/$folder/bin"
  if [ ! -x "$bin/node" ]; then
    echo "Echlon will download its own copy of Node $version (about 30 MB) into $root. Nothing on your system is changed."
    case " $* " in
      *" --yes "*) ;;
      *)
        printf 'Download it now? (Y/n) '
        # No one to answer (a pipe, a script) is not a yes: say how to allow it.
        read -r answer || { echo; echo "Nobody answered, so nothing was downloaded. Run this script again with --yes to allow it."; exit 1; }
        case "$answer" in
          [Nn]*) echo "Install Node from https://nodejs.org (the LTS version), then run this script again."; exit 1 ;;
        esac
        ;;
    esac
    if ! command -v tar >/dev/null 2>&1; then echo "This needs the tar command to unpack Node, and it was not found."; exit 1; fi
    mkdir -p "$root" || exit 1
    work=$(mktemp -d "$root/.download-XXXXXX") || exit 1
    fail() { echo "$1"; rm -rf "$work"; exit 1; }
    dist="${ECHLON_NODE_DIST:-https://nodejs.org/dist}"
    dist="${dist%/}"
    archive="$work/$folder.tar.gz"
    echo "Downloading Node $version ..."
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$dist/v$version/$folder.tar.gz" -o "$archive" || fail "Could not download Node $version. Check the internet connection and try again."
    elif command -v wget >/dev/null 2>&1; then
      wget -q -O "$archive" "$dist/v$version/$folder.tar.gz" || fail "Could not download Node $version. Check the internet connection and try again."
    else
      fail "This needs curl or wget to download Node, and neither was found. Install Node from https://nodejs.org and run this script again."
    fi
    if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$archive" | cut -d ' ' -f 1)
    elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$archive" | cut -d ' ' -f 1)
    else actual=$(openssl dgst -sha256 "$archive" | sed 's/^.*= //'); fi
    [ "$actual" = "$expected" ] || fail "The Node download did not match its published checksum, so it was thrown away and nothing was installed. Try again; if it keeps happening, install Node from https://nodejs.org."
    echo "Unpacking Node $version ..."
    mkdir "$work/x" && tar -xzf "$archive" -C "$work/x" || fail "Could not unpack the Node download, so nothing was installed."
    [ -x "$work/x/$folder/bin/node" ] || fail "The Node download did not hold the program it should, so nothing was installed."
    # The whole folder arrives in one step, so a half-unpacked Node is never mistaken for a finished one.
    rm -rf "$root/$folder"
    mv "$work/x/$folder" "$root/$folder" || fail "Could not put Node in $root."
    rm -rf "$work"
    echo "Node $version is ready."
  fi
  node="$bin/node"
fi

exec "$node" "$here/installer/install.mjs" "$@"
