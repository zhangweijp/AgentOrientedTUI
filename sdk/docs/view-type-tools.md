# 页面类型、工具与当前状态

用 `defineViewType<Context>()({ name, tools })` 定义页面类型。工具键就是公开工具名。说明、可选的 TypeBox 业务 Schema、`execute({ input, context })` 和可选的 `enabled(context)` 都写在同一项。App 工厂在 `viewTypes` 中登记类型。

Preact 页通过 `View.context` 提交自己的上下文。普通 TypeScript 在 `createView` 的 `render` 返回 `context`。SDK 用该上下文准备每项工具的执行绑定，`enabled` 默认允许，判定结果随正文与 Ref 一起提交。没有工具的类型直接用 `defineViewType({ name })`。

模型每次 Tool Call 提供 `view_id` 选择执行页面。共享工具只有一份 Schema。部分同类型页面能接收操作时，模型 Schema 会列出当前候选页。显式 Ref 使用 `view_id.ref_id` 作为地址，可以指向同一观察中的另一页。应用检查业务对象和状态是否仍然有效。

View 持续打开且操作持续启用时，调用使用该实例最新已提交的绑定。带上下文的工具得到该次绑定持有的页面上下文引用。关闭、替换页面或成功禁用操作后，原观察中的资格失效。应用只返回操作收据，当前业务值通过页面更新。Host 管理观察采用、调用授权与回执读取。

[作者指南](app-authoring.md) · [Preact 示例](app-tools.md) · [Ref 参数](readonly-ref-v2.md)
