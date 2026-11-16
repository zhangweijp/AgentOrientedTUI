# 配套迁移

用 Runtime 8、SDK 0.9 及配套 Adapter、Driver 重新构建应用并生成 `aoapp.json`。作者和 Host 的完整示例见 [App 作者指南](app-authoring.md)。

- 把 `defineToolSet` 和 `defineViewTypeTool` 改成按页面类型的 `defineViewType<Context>()({ name, tools })`，在同一项中声明 `execute({ input, context })`、业务 Schema 和可选的 `enabled(context)`。无业务参数时可省略 `inputSchema`。在工厂登记 `viewTypes`。
- Preact 在 `View.context` 提供页面实例上下文。普通 TypeScript 为打开页面使用稳定的 `createView` handle，在 `render` 返回 `context`，并提交 `publish({ views })`。已有 `defineViewType({ name, tools })` 的 App 可以继续通过显式 `bindings` 提供各页的 `execute(input)`。
- Host 调用 `observe({ all: true })`，采用后用 Observation ID、Tool ID 和 `input.view_id` 调用。把本来只用来选当前页面的业务 ID 从 Schema 和调用说明中移除。显式 Ref 继续用 `view_id.ref_id`。

- Core 注册使用 `compileOrdinarySchema` 和现行 ViewType JSON Schema。`ExecutionBinding` 提供身份、校验、存活检查和执行函数。校验可以拒绝输入，成功必须返回等值参数。
- View 正文使用 `markdown-v1` 字符串。Ref 使用 `snapshot-value` JSON payload。业务 ID 和版本由 App 放入 payload 并校验。
- Host 用 `toolsEnabled: false` 开启只读观察。省略或传入 `true` 启用 Tool。安装入口会在创建资源前拒绝未知字段，并使用 Runtime 随包的 Worker。用 `beginDesktopShutdown(id).wait(...)` 取得关闭结果。
- Preact App 用 `useLLMUsage` 获取模型用量。每条事件包含时间、Provider、模型 ID 和三个 Token 计数，历史由 App 决定如何保存。JSON 类型使用 `@aotui/sdk/app` 的 `JsonValue`。
- Host 从 `runtime.getDesktop(id).getInstalledApps()` 读取 `AppDiscoveryInfo` 目录。替换 `serialize()` 并在宿主选择要保存的字段。冷重启可传入 `reason`。
- Worker 协商 `app-snapshot/v4` 和 `view-tool-parameters-invoke/v6`。手写 factory 使用 `view-type-tools-v5`，并通过 `RuntimeContext.defineTools` 注册静态定义。
- App 工厂的规范名称使用 `kernelConfig.appName`，由 SDK 的 `app_name` 生成。删掉对工厂 `displayName` 和 `kernelConfig.name` 的读取。Host 通过 `installDynamicWorkerApp` 的 `options.config` 或 `AppRegistry.installAll` 的 `options.dynamicConfig` 提供启动配置。App 从 `context.launchConfig` 读取。
- 托管 Preact App 内用 `<ToolCatalog />` 读取已注册类型。需要显式指定目录时传 `viewTypes`。目录数据的类型用 `readonly ToolCatalogEntry[]` 或 `ReturnType<typeof getToolCatalog>`，组件参数用 `ToolCatalogProps`。

[匹配包与本地验收](runtime-compatibility.md) · [Ref 参数](readonly-ref-v2.md) · [View 元数据](views.md)
