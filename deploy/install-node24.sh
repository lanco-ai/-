#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID} -ne 0 ]]; then echo 'Run with sudo bash deploy/install-node24.sh' >&2; exit 1; fi
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo 'Supported architectures: x86_64 and arm64' >&2; exit 1 ;;
esac
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
base=https://nodejs.org/dist/latest-v24.x
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$base/SHASUMS256.txt" -o "$stage/SHASUMS256.txt"
mapfile -t archives < <(awk '{print $2}' "$stage/SHASUMS256.txt" | grep -E "^node-v24\.[0-9]+\.[0-9]+-linux-${arch}\.tar\.xz$")
if [[ ${#archives[@]} -ne 1 ]]; then echo 'Could not resolve a unique Node 24 release' >&2; exit 1; fi
archive=${archives[0]}
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$base/$archive" -o "$stage/$archive"
awk -v file="$archive" '$2==file' "$stage/SHASUMS256.txt" > "$stage/checksums.txt"
(cd "$stage" && sha256sum -c checksums.txt)
directory="/opt/${archive%.tar.xz}"
if [[ ! -d "$directory" ]]; then
  mkdir -p "$directory"
  tar -xJf "$stage/$archive" --strip-components=1 -C "$directory"
fi
if [[ -e /opt/node24 && ! -L /opt/node24 ]]; then echo '/opt/node24 already exists as a directory; choose its migration manually' >&2; exit 1; fi
ln -sfn "$directory" /opt/node24
/opt/node24/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a!==24||b<14)process.exit(1);console.log(process.version)'
echo 'Node.js installed at /opt/node24/bin/node'
