DEMO_APP_DIRS=(
    demo-apps/aotui-ide
    demo-apps/planning-app
    demo-apps/terminal-app
    demo-apps/lite-browser-app
)
DEV_PACKAGE_DIRS=(core sdk runtime agent-driver-v2 agent-driver-adapter "${DEMO_APP_DIRS[@]}" host)

build_dev_packages() {
    local target
    for target in "${DEV_PACKAGE_DIRS[@]}"; do
        pnpm -C "$target" build
    done
}
