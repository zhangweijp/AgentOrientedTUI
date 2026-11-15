# SDK 当前公共 API

普通 TypeScript App 使用 `@aotui/sdk/app` 的 `createApp`，Preact App 使用 `@aotui/sdk` 的 `createTUIApp`。两者共享静态 `defineViewType`、TypeBox 参数合同和托管 Worker 装载。参见 [App 作者指南](app-authoring.md)。

| 能力 | 当前合同 |
| --- | --- |
| `createApp`, `createView`, `ref`, `arrayRef`, `formatRef` | `@aotui/sdk/app` 提供托管 default 工厂和 Ref 辅助函数。`publish` 提交完整 View、Ref 与绑定，校验通过后生效 |
| `createTUIApp`, `View` | Preact 托管 default 工厂、页面组件和实例级绑定。实际提交维护 View 和 Tool 的实例身份 |
| `defineViewType`, `getToolCatalog` | 静态定义只写一次 ViewType/name/description/Schema；不含 execute 或业务 owner |
| `ToolCatalog` | Root 按 ViewType 展示工具名；当前可调用的工具由上下文 Tools 提供 |
| `useDataRef`, `useArrayRef` | Preact 在 View 内发布 JSON 值，支持可选 TypeBox 源 schema，并保留 owner 与旧 cleanup 隔离 |
| `useLLMUsage` | Preact 订阅 Desktop 投递的时间、Provider、模型 ID 与用量。App 自己维护业务历史 |
| `refParam` | 支持顶层 JSON 值 Ref、可选字段和 `Type.Array(refParam(...))` 多选。Runtime 从原观察解析、检查来源和目标 schema，向 handler 提供深只读值 |
| `registerCleanup` / `useAppLifecycle`, `persistence` / `usePersistentState` | 普通 TS / Preact 的应用资源登记和实例持久化入口 |

`refParam` 由根入口和 `@aotui/sdk/app` 导出。主要工具类型包括 `ViewType`、`ArgsOf`、`DeepReadonly` 和 `ViewBindings`。完整导出以匹配产物的 `sdk/src/index.ts` 和 `sdk/src/app.ts` 为准。旧 `useViewSnapshotTool`、实例 ToolUI、`SnapshotValueTool*`、`ParamSchema` / `InferArgs` 已退出。

两个入口共享静态 Tool 声明格式。`/app` 的作者侧运行图可独立于 Preact、DOM 和 Worker 加载，类型可用 ES2022 lib 编译。Preact 是可选 peer，使用根入口的 Preact App 需要安装它。

## 执行与业务边界

Tool 定义属于 App + ViewType。同类型页面共享定义，并用各自的 `bindings` 提供执行闭包。模型用 `view_id` 选择接收页，并用显式 Ref 参数选择原观察的数据。Runtime 分别验证接收页和 Ref 来源。App 负责当前业务有效性。

当前作者标记为 `view-type-tools-v5`，Host/Worker 执行 mode 为 `view-type-parameters-v1`；SDK 工厂自动提供标记，不由 App 手写。旧标记、旧参数方言和退役 mode 明确拒绝，不做旧路径 fallback。SDK/Runtime/Host 仍需使用匹配的实际产物。

Tool 返回完成/失败/恢复所需的短收据，当前业务数据进入 View；unknown 不自动重试写入。数据 Ref 深只读不限制 App 执行业务变更，业务权限、父子归属、文件冲突和外部资源由 App/Host 负责。

Ref 值和普通字段使用有限 JSON 数据域。显式 Ref 地址使用 `view_id.local_ref`，整个列表、元素与多选均按所属 View 定位并共享总参数预算。Host 必须显式采用准备好的 Observation，新采用撤销旧资格。示例和支持清单见 [Ref 参数](readonly-ref-v2.md) 与 [参数合同](tool-parameters.md)。



当前 View 必须显式声明 `type` 和 `kind="instruction" | "state"`，实例 `id` 只标识页面实例。正文不携带框架外壳，XML 文本仅在最终呈现时转义一次；[View 声明与正文合同](views.md)说明两种 Producer、原样内容和迁移方式。
