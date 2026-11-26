#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"
source scripts/dev-packages.sh

if [ ! -d node_modules ] || [ ! -d agent-driver-adapter/node_modules ] ||
    [ ! -d core/node_modules ] || [ ! -d sdk/node_modules ]; then
    ./setup.sh
else
    build_dev_packages
fi

if [ "$(uname -s)" = Darwin ] && [ -z "${AOTUI_CONSOLE_NODE:-}" ]; then
    AOTUI_CONSOLE_NODE="$(node -p 'process.execPath')"
    export AOTUI_CONSOLE_NODE
fi

cd host
pnpm electron:dev
