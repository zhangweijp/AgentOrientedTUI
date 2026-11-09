# 作者指南：声明一次，按 App 绑定

应用围绕 App、View、Tool 开发。App 拥有业务状态和资源；View 是 Agent 当前工作页面；Tool 执行操作，当前业务数据通过 View 呈现。推荐先运行 [完整文件 App](examples/file-app.tsx)，再按需要加入 [Ref 参数](readonly-ref-v2.md)。

## 一份声明，两种绑定入口

| 责任 | 入口 |
| --- | --- |
| 静态能力 | defineViewTypeTool + defineToolSet：viewType、name、description、TypeBox inputSchema |
| 本实例行为 | Preact 的 AppTools，或普通 TS 的 createToolBindings：execute、可选 enabled |
| 页面 | 显式 id/type/kind 的 View；Root 的 ToolCatalog 只列类型与名称 |

定义通常放在模块作用域。execute 不属于 definition；bindings 必须完整，每个成员即使 disabled 也有 handler。ArgsOf/SchemaOf 从同一 Schema 推导参数，参数递归只读。没有 isMutating 字段或另一类 Snapshot Tool。

Preact 在共同祖先放一个 AppTools，View 作为独立兄弟页面。用状态决定页面的打开/关闭；不要在每个同类型 View 重复注册 Tool。省略 ToolRef 不禁用能力，enabled 也不等于业务授权。完整 description 和 Schema 只进入 Context Tools；Root 可用 ToolCatalog 按类型列名，页面不复制输入输出结构。

普通 TS Producer 从已有 Runtime/宿主获取 IAppTypeToolPort，使用同一 controller；它不需要复制 SDK 校验、Owner 或清理实现。见 [普通 TS 完整业务 controller](examples/file-controller.ts)及[绑定合同](binding-tools.md)。此入口是已有 Producer 的绑定接口，不是无 DOM 的 createTUIApp 替代工厂；低层 Producer/Host 装配见 Runtime 的纯 Core 指南。

## 动态可用性与业务目标

至少一个匹配 ViewType 的 View 存在时，该类型的绑定才可激活。同类型多个实例共享一组 Tool；最后一个关闭后，旧 activation 失效。ToolRef 的位置不隐式绑定文件或对象。文件使用明确路径参数，已显示的业务对象使用其 View 内 Ref。

静态 ToolSet 和 App 端口在绑定生命周期内固定。handler 更新保留注册身份；禁用再启用产生新资格。改变声明/端口需显式卸载并重新绑定，不能直接覆盖旧控制器。组件提交和普通 TS 的 commit 复用同一 controller。具体生命周期与有界错误说明见 [AppTools](app-tools.md)、[controller](binding-tools.md)。

## Ref：展示与调用地址分开

在 View `detail` 中显示 `[Example](Note:notes[0])`，模型输入 `detail.notes[0]`。`Note[]:notes` 表示整个对象列表，输入 `detail.notes`。输入不带展示类型前缀；Runtime 用原观察的 Ref 元数据和 Schema 检查类型，App 收到解析后的值，继续检查当前业务有效性。

同一 Tool 可接收对象、完整列表、元素、多个/可选 Ref 字段以及 Type.Array(refParam(...)) 多选。缺席、空选择和无效值不同；顺序和重复保留。嵌套字段查询、额外作用域及基础类型体系没有实现。见 [完整 Ref 示例](readonly-ref-v2.md)。

## 结果与更新

ToolResult 以 success 判别：成功只返回 `{ success: true, data?: JsonObject }`；失败必须提供普通 JSON error 记录 `{ code, message, context? }`，可以附短的恢复 data。成功不能带 error 或 effects，失败不能省略 error。不要把 Error 实例、stack、cause、函数或 undefined 放入收据；本地诊断和跨进程错误记录分开。

已知失败副作用用 effects:'none' 或 'partial'；不声明表示无法确定，不会被当成安全重试。非法结果或传输不能证明最终结果时仍为 unknown；未知结果不自动重放。正文、集合和编辑结果放入 View，data 只承载简短收据与必要恢复事实。

App 通过现有提交/发布边界更新页面。宿主观察等待已提交投影，准备 Context 后采用，再开始模型消费和工具调用；采用新观察会撤销旧资格。App 不实现观察采纳或拼接 observationId/bindingId。

文件 App 验证打开后 edit_file 出现、两个同类型 View 共享一组工具、编辑后只读最新页面、关闭后的业务拒绝与旧资格失效。公开导入、匹配包和复跑入口见 [包使用说明](runtime-compatibility.md)。

## App 元数据与安装

`createTUIApp({ app_name, whatItIs, whenToUse, component })` 是应用元数据的唯一手写来源。仓库现有 `scripts/generate-aoapp.mjs` 从构建后的工厂和 package.json 的版本／入口生成 aoapp.json；不要再手写一份说明，也不要把生成物反向导入工厂。标准 Registry 只读这个静态生成物发现应用，不在 Host 为获取名称提前执行 App。

构建、生成后安装 App 目录；注册键必须等于生成的 app_name。Worker 在初始化组件前核对注册名称与工厂的逻辑名称。Runtime 发出的 App ID、执行 instanceId、View instance 和 Binding 都不是 app_name，App 不自行构造它们。Host 的 AOTUI_APP_KEY 仅选择持久化 namespace，不参与 Tool 或 Ref 的执行定位。详情见 [身份边界](../../runtime/docs/runtime-app-interaction.md#身份与元数据来源)。
