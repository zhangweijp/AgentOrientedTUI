# 页面类型、工具与当前状态

用 `defineViewType({ name, tools })` 定义页面类型。工具键就是公开工具名，值包含说明和 TypeBox 业务参数 Schema。App 工厂在 `viewTypes` 中登记类型。

每个打开的 View 声明该类型全部操作的 `execute`，可以用 `enabled: false` 暂停其中一个操作。Preact 绑定放在 `View.bindings`，普通 TS 在 `createView(type, { id, kind, render })` 的 `render` 返回绑定。一次有效发布同时提交正文、Ref 和绑定。

模型每次 Tool Call 提供 `view_id` 选择执行页面。共享工具只有一份 Schema。部分同类型页面能接收操作时，模型 Schema 会列出当前候选页。显式 Ref 使用 `view_id.ref_id` 作为地址，可以指向同一观察中的另一页。应用检查业务对象和状态是否仍然有效。

View 持续打开且操作持续启用时，可以换成读取最新状态的闭包。关闭、替换页面或成功禁用操作后，原观察中的资格失效。应用只返回操作收据，当前业务值通过页面更新。Host 管理观察采用、调用授权与回执读取。

[作者指南](app-authoring.md) · [Preact 示例](app-tools.md) · [Ref 参数](readonly-ref-v2.md)
