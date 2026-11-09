# SDK 当前公共 API

当前工具作者入口是静态 `defineViewTypeTool` / `defineToolSet`、App 级 `AppTools` 或普通 TS `createToolBindings`。参数统一使用 TypeBox；`refParam(refType, valueSchema)` 让同一工具接收原观察中的对象或对象列表。`useViewSnapshotTool`、其返回的实例 ToolUI 和专属参数类型已退出，没有兼容包装。

| 能力 | 当前合同 |
| --- | --- |
| `createTUIApp`, `View` | 唯一托管 default 工厂；自动声明 `view-type-tools-v4`，View 显式要求id/type/kind，挂载与卸载维护实例身份 |
| `defineViewTypeTool`, `defineToolSet`, `getToolCatalog` | 静态定义只写一次 ViewType/name/description/Schema；不含 execute 或业务 owner |
| `AppTools`, `createToolBindings` | 每个 App 绑定完整 handler/enabled 映射；共同 controller、owner、提交与失败清理合同 |
| `ToolRef`, `ToolCatalog` | 引用能力或展示目录；不注册第二份 Tool，不授予执行权限 |
| `useDataRef`, `useArrayRef` | 在 View 中发布数据、类型提示和 View 内局部 Ref 名，保留发布者 handle 与旧 cleanup 隔离 |
| `refParam` | 当前实现支持多个顶层对象或对象列表 Ref、Type.Optional 可选字段和 Type.Array(refParam(...)) Ref 名数组，可带普通参数；由 Runtime 解析、检查类型/来源并提供深冻结值 |
| `useAppLifecycle`, `usePersistentState` | App 自有资源与实例状态；Tool binding 不接管业务生命周期 |

`refParam` 同时从根入口与 `@aotui/sdk/tools` 导出。主要工具类型包括 `DefinedViewTypeTool`、`ViewTypeToolDeclaration`、`SchemaOf`、`ArgsOf`、`DeepReadonly`、`ToolSet`、`ToolSetMap`、`ToolBinding`、`ToolBindings`、`ToolBindingController` 及有界诊断类型。完整导出以当前匹配产物的 `sdk/src/index.ts` 和 `sdk/src/tools.ts` 为准，旧 `SnapshotValueTool*`、`UseViewSnapshotToolResult`、`ParamSchema` / `InferArgs` 不再是工具作者入口。

Root 与 `/tools` 使用同一品牌和 controller。`/tools` 的运行图不加载 Preact/DOM/Worker；安装 SDK 仍有 Preact peer，声明仍需 DOM ambient 类型。不要把运行图边界扩大为全平台或任意版本兼容承诺。

## 执行与业务边界

Tool 属于 App + ViewType。同类型多个 View 共享一次注册；最后一个匹配 View 关闭、禁用、重开或 App 重启仍按现有 activation/实例合同撤销旧资格。ToolRef 所处位置不隐式选择文件。普通参数由 App 解释；Ref 参数显式选择已观察对象，App 再检查其当前业务有效性。某个 Ref owner View 关闭，不等于为整个共享 Tool 增加一个实例调用闸。

当前作者标记为 `view-type-tools-v4`，Host/Worker 执行 mode 为 `view-type-parameters-v1`；SDK 工厂自动提供标记，不由 App 手写。旧标记、旧参数方言和退役 mode 明确拒绝，不做旧路径 fallback。SDK/Runtime/Host 仍需使用匹配的实际产物。

Tool 返回完成/失败/恢复所需的短收据，当前业务数据进入 View；unknown 不自动重试写入。数据 Ref 深只读不限制 App 执行业务变更，业务权限、父子归属、文件冲突和外部资源由 App/Host 负责。

当前实现完整支持顶层对象／对象列表、数组元素、多个／可选 Ref 及 Ref 名数组，保持总参数预算和解析失败语义；不支持嵌套 Ref 查询。Host 必须显式采用准备好的 Observation，新采用撤销旧资格。输入为 view_id.local_ref，不带展示类型前缀；整个列表、元素与多选均按所属 View 定位。对象和对象列表的示例见 [Ref 参数](readonly-ref-v2.md)，其他 Schema 规则见 [普通参数合同](ordinary-v2.md)。



当前 View 必须显式声明 `type` 和 `kind="instruction" | "state"`，实例 `id` 只标识页面实例。正文不携带框架外壳，XML 文本仅在最终呈现时转义一次；[View 声明与正文合同](views.md)说明两种 Producer、原样内容和迁移方式。
