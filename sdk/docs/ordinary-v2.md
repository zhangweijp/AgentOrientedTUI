# Tool 的 TypeBox 参数合同

用 `defineViewTypeTool` 声明 ViewType、名称、说明和 TypeBox `inputSchema`。普通 TS 用 `createApp` 的 `publish` 提交实例绑定，Preact 使用 `AppTools`。SDK 在声明时捕获并冻结规范化 schema，Runtime 在注册时独立校验；`ArgsOf` 和 `SchemaOf` 复用声明的静态类型。两种实例共用声明的代码见 [App 作者指南](app-authoring.md)。

## 支持的本地 schema

完整 Tool 参数必须是 `Type.Object(...)`。普通字段和解引用后的值可为 null、布尔、字符串、有限数、数组或普通 JSON 对象。数组项可以使用普通对象或联合类型。值捕获拒绝 undefined、数组空洞、循环、访问器和自定义对象原型。

| 位置 | 支持的关键词 |
| --- | --- |
| 对象 | `type: 'object'`、`properties`、`required`、布尔 `additionalProperties` |
| 字段与 Ref 值 | `type`、`enum`、`const`、`anyOf`。类型为 `null`、`boolean`、`string`、`number`、`integer`、`array`、`object` |
| 字符串 | `minLength`、`maxLength`、以 JavaScript Unicode 模式执行的 `pattern` |
| 数值 | `minimum`、`maximum` |
| 数组 | 单个 schema 的 `items`、`minItems`、`maxItems` |
| 注释 | `description`、`default` |

`Type.Optional` 控制所属对象的 `required`。可选字段省略时保持缺席，显式 null 需要其 schema 允许，`default` 只保留为注释。省略 `additionalProperties` 时允许额外 JSON 字段，可用 `false` 关闭。`Type.Unknown()` 和 `Type.Any()` 仍受普通 JSON 捕获与预算约束。

SDK 在声明时为不支持的关键词、tuple、schema 引用、可执行 refinement / codec 以及超出预算的 schema 提供有界诊断，包含代码与路径。

## Ref 参数和执行

`refParam(refType, valueSchema)` 可用于根对象的直接参数，也可作为直接数组参数的元素。模型为每个选中的 Ref 传入 `view_id.local_ref` 字符串。显式 Ref 可以指向标量、null、对象、整数组或一个元素。可选 Ref 省略后不解析。Ref 多选保留顺序与重复，完整调用共用参数和封包预算。Ref 的可选源 schema 在发布时执行，目标 schema 在从已采用的 Observation 解引用之后执行。见 [Ref 参数](readonly-ref-v2.md)。

模型侧工具目录保留支持的 schema 约束，Ref 位置显示地址字符串。Runtime 校验原始输入和解引用后的值，再以深只读参数调用已提交 handler。完整业务数据通过 View 呈现，handler 返回短收据。业务副作用与 View 可观察是两个完成条件。

托管 SDK 工厂自动提供 `view-type-tools-v4` 作者标记。当前 Host／Worker 调用使用 `view-type-parameters-v1`，具体支持范围见 [匹配包说明](runtime-compatibility.md)。App 绑定的生命周期见 [生命周期合同](tool-lifecycle.md)。

## Native Host 工具名称

默认 Host adapter 使用 `appName-ViewType-toolName`。每段仅使用 ASCII 字母、数字与下划线，整名最长 64 字符。无效名称会在 adapter 边界报告。
