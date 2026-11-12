# 作者指南：声明一次，按 App 绑定

App 拥有业务状态和资源，View 呈现 Agent 的当前工作页面，Tool 执行操作并返回收据。普通 TypeScript 与 Preact 的完整工作项 App 见 [App 作者指南](app-authoring.md)。

## 一份声明，两种绑定入口

| 责任 | 入口 |
| --- | --- |
| 静态能力 | defineViewTypeTool + defineToolSet：viewType、name、description、TypeBox inputSchema |
| 本实例行为 | `createApp` 的 `publish({ views, bindings })` 或 Preact 的 `AppTools`，绑定 `execute` 和可选 `enabled` |
| 页面 | 显式 `id`、`type`、`kind` 的 View。Preact Root 的 `ToolCatalog` 只列类型与名称 |

定义通常放在模块作用域。execute 不属于 definition；bindings 必须完整，每个成员即使 disabled 也有 handler。ArgsOf/SchemaOf 从同一 Schema 推导参数，参数递归只读。没有 isMutating 字段或另一类 Snapshot Tool。

Preact 在共同祖先放一个 AppTools，View 作为独立兄弟页面。用状态决定页面的打开/关闭；不要在每个同类型 View 重复注册 Tool。enabled 控制当前可用性，授权与业务前置条件另行判断。完整 description 和 Schema 只进入 Context Tools；Root 可用 ToolCatalog 按类型列名，页面不复制输入输出结构。

普通 TS App 从 `@aotui/sdk/app` 导入 `createApp`，每次 `publish` 提交完整的 View、Ref 和 Tool 绑定。完整示例见 [App 作者指南](app-authoring.md)。

## 动态可用性与业务目标

至少一个匹配 ViewType 的 View 存在时，该类型的绑定才可激活。同类型多个实例共享一组 Tool；最后一个关闭后，旧 activation 失效。文件使用明确路径参数，已显示的业务对象使用其 View 内 Ref。

静态 ToolSet 在实例生命周期内固定。已提交的 handler 更新保留注册身份，成功禁用再启用产生新资格。普通 TS 失败帧保留上次成功的 View 和 Tool 身份，App 在有效帧恢复前暂停新调用。Preact 以实际组件提交为准。见 [生命周期](tool-lifecycle.md)。

## Ref：展示与调用地址分开

在 View `detail` 中显示 `[Example](Note:notes[0])`，模型输入 `detail.notes[0]`。`Note[]:notes` 表示整个对象列表，输入 `detail.notes`。输入不带展示类型前缀；Runtime 用原观察的 Ref 元数据和 Schema 检查类型，App 收到解析后的值，继续检查当前业务有效性。

同一 Tool 可接收标量、null、对象、完整列表、元素、多个或可选 Ref 字段，以及 `Type.Array(refParam(...))` 多选。缺席、空选择和无效值不同；顺序和重复保留。嵌套字段查询与额外作用域仍属后续协议。见 [完整 Ref 示例](readonly-ref-v2.md)。

## 结果与更新

ToolResult 以 success 判别：成功只返回 `{ success: true, data?: JsonObject }`；失败必须提供普通 JSON error 记录 `{ code, message, context? }`，可以附短的恢复 data。成功不能带 error 或 effects，失败不能省略 error。不要把 Error 实例、stack、cause、函数或 undefined 放入收据；本地诊断和跨进程错误记录分开。

已知失败副作用用 effects:'none' 或 'partial'；不声明表示无法确定，不会被当成安全重试。非法结果或传输不能证明最终结果时仍为 unknown；未知结果不自动重放。正文、集合和编辑结果放入 View，data 只承载简短收据与必要恢复事实。

App 通过现有提交/发布边界更新页面。宿主观察等待已提交投影，准备 Context 后采用，再开始模型消费和工具调用；采用新观察会撤销旧资格。App 不实现观察采纳或拼接 observationId/bindingId。

文件 App 验证打开后 edit_file 出现、两个同类型 View 共享一组工具、编辑后只读最新页面、关闭后的业务拒绝与旧资格失效。公开导入、匹配包和复跑入口见 [包使用说明](runtime-compatibility.md)。

## App 元数据与安装

在 `createApp` 或 `createTUIApp` 的配置里填写一次 `app_name`、`whatItIs`、`whenToUse`。仓库现有 `scripts/generate-aoapp.mjs` 从构建后的工厂和 package.json 的版本与入口生成 aoapp.json。标准 Registry 读取这份静态文件发现应用。

构建并生成 manifest 后安装 App 目录。Worker 在初始化 App 前核对注册键、manifest 的 `app_name` 与工厂的逻辑名称。Runtime 发出 App ID、执行 instanceId、View instance 和 Binding。Host 的 `AOTUI_APP_KEY` 仅选择持久化 namespace。详情见 [身份边界](../../runtime/docs/runtime-app-interaction.md#身份与元数据来源)。
