# 配套迁移

使用同一次构建的 Runtime、SDK 和 Host 所需的 Adapter / Driver。重新构建 App 后生成 `aoapp.json`。在普通 TypeScript 中使用 `createApp` 和 `publish`，在 Preact 中使用 `createTUIApp` 和 `AppTools`。声明、绑定、Ref 和 View 示例见 [App 作者指南](app-authoring.md) 与 [ViewType Tools](view-type-tools.md)。

- Core 注册使用 `compileOrdinarySchema` 和现行 ViewType JSON Schema。`ExecutionBinding` 提供身份、校验、存活检查和执行函数。校验可以拒绝输入，成功必须返回等值参数。
- View 正文使用 `markdown-v1` 字符串。Ref 使用 `snapshot-value` JSON payload。业务 ID 和版本由 App 放入 payload 并校验。
- Host 用 `toolsEnabled: false` 开启只读观察。省略或传入 `true` 启用 Tool。安装入口会在创建资源前拒绝未知字段，并使用 Runtime 随包的 Worker。用 `beginDesktopShutdown(id).wait(...)` 取得关闭结果。
- Preact App 用 `useLLMUsage` 获取模型用量。每条事件包含时间、Provider、模型 ID 和三个 Token 计数，历史由 App 决定如何保存。JSON 类型使用 `@aotui/sdk/app` 的 `JsonValue`。
- Host 从 `runtime.getDesktop(id).getInstalledApps()` 读取 `AppDiscoveryInfo` 目录。替换 `serialize()` 并在宿主选择要保存的字段。冷重启可传入 `reason`。
- Worker 继续协商 `app-snapshot/v3` 和 `view-tool-parameters-invoke/v5`。手写 SPI 工厂用 `ordinary-invoker/v4` 声明其注册实现。
- App 工厂的规范名称使用 `kernelConfig.appName`，由 SDK 的 `app_name` 生成。删掉对工厂 `displayName` 和 `kernelConfig.name` 的读取。Host 通过 `installDynamicWorkerApp` 的 `options.config` 或 `AppRegistry.installAll` 的 `options.dynamicConfig` 提供启动配置。App 从 `context.launchConfig` 读取。
- `ToolCatalog` 用于 JSX。目录数据的类型用 `readonly ToolCatalogEntry[]` 或 `ReturnType<typeof getToolCatalog>`，组件参数用 `ToolCatalogProps`。

[匹配包与本地验收](runtime-compatibility.md) · [Ref 参数](readonly-ref-v2.md) · [View 元数据](views.md)
