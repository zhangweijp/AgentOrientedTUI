#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"
source scripts/dev-packages.sh

if ! command -v pnpm >/dev/null 2>&1; then
    npm install -g pnpm
fi

pnpm install --ignore-workspace
for target in "${DEV_PACKAGE_DIRS[@]}"; do
    pnpm -C "$target" install --ignore-workspace
done

# A local pnpm install may skip Electron's binary download.
electron_installer=host/node_modules/electron/install.js
if [ -f "$electron_installer" ] && [ ! -f host/node_modules/electron/path.txt ]; then
    if ! node "$electron_installer"; then
        if [ -n "${ELECTRON_MIRROR:-}" ]; then
            exit 1
        fi
        ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node "$electron_installer"
    fi
fi

build_dev_packages
(cd host && npm link)
for app in "${DEMO_APP_DIRS[@]}"; do
    (cd "$app" && node "$REPO_ROOT/host/dist/app-distribution/cli.js" install . --force)
done

printf '\nSetup complete. Start Agentina with ./run.sh.\n'
