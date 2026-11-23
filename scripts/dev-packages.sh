DEMO_APP_DIRS=(
    demo-apps/aotui-ide
    demo-apps/planning-app
    demo-apps/terminal-app
    demo-apps/lite-browser-app
)
DEV_PACKAGE_DIRS=(core sdk runtime agent-driver-v2 agent-driver-adapter "${DEMO_APP_DIRS[@]}" host)

build_dev_packages() {
    # Linked JSX Apps and the SDK must use the same physical Preact instance.
    local app target
    for app in "${DEMO_APP_DIRS[@]}"; do
        node "$REPO_ROOT/scripts/link-local-preact.mjs" "$REPO_ROOT/$app"
    done
    for target in "${DEV_PACKAGE_DIRS[@]}"; do
        pnpm -C "$target" build
    done
}
