# 配套迁移

使用同一次构建的 Runtime、SDK 和 Host 所需的 Adapter / Driver。重新构建 App 后生成 `aoapp.json`。在普通 TypeScript 中使用 `createApp` 和 `publish`，在 Preact 中使用 `createTUIApp` 和 `AppTools`。声明、绑定、Ref 和 View 示例见 [App 作者指南](app-authoring.md) 与 [ViewType Tools](view-type-tools.md)。

- Core 注册使用 `compileOrdinarySchema` 和现行 ViewType JSON Schema。`ExecutionBinding` 提供身份、校验、存活检查和执行函数。校验可以拒绝输入，成功必须返回等值参数。
- View 正文使用 `markdown-v1` 字符串。Ref 使用 `snapshot-value` JSON payload。业务 ID 和版本由 App 放入 payload 并校验。
- Host 用 `toolsEnabled: false` 开启只读观察。省略或传入 `true` 启用 Tool，旧安装键 `interactionModes` 会被拒绝。用 `beginDesktopShutdown(id).wait(...)` 取得关闭结果。
- Worker 继续协商 `app-snapshot/v3` 和 `view-tool-parameters-invoke/v5`。手写 SPI 工厂用 `ordinary-invoker/v4` 声明其注册实现。

[匹配包与本地验收](runtime-compatibility.md) · [Ref 参数](readonly-ref-v2.md) · [View 元数据](views.md)
