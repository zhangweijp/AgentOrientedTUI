# 用 Ref 选择已展示的业务对象

Ref 是 View 发布的具名数据。模型选择 Ref，Runtime 从本次调用采用的 Observation 解析数据；handler 接收通过 Schema 检查的递归只读对象或对象列表。应用仍检查对象是否存在、父子归属、当前状态和业务权限。

先运行 [完整笔记示例](examples/ref-app.tsx)，再按下面的参数形状扩展。示例中的 `Note` 是笔记的业务类型，`NoteDetail` 是应用自定义的 ViewType，`detail` 是页面实例 ID；这些名称都由示例应用决定。页面打开后才提供检查工具，结果进入页面的 Inspection 区域，关闭页面后该类型工具失活。示例不读写磁盘。

## 展示标记与调用地址

SDK 在 View 内注册局部名，展示保留类型提示；Tool 输入使用 **View 实例 id + 局部名**，不带展示类型前缀。

| 发布方式 | 页面展示的链接目标 | 在 `<view id="detail">` 中的调用参数 |
| --- | --- | --- |
| `useDataRef('current', note, { refType: 'Note' })` | `Note:current` | `detail.current` |
| `useArrayRef('notes', notes, { itemType: 'Note' })` 的整数组 | `Note[]:notes` | `detail.notes` |
| 同一 ArrayRef 的第一个元素 | `Note:notes[0]` | `detail.notes[0]` |

例如 `[First note](Note:notes[0])` 位于 `id="detail"` 的 View 中，调用 `inspect_note` 时传 `{ "note": "detail.notes[0]" }`。使用 XML 中的 id，不使用 ViewType 或 name，也不猜“当前 View”。同一 App 两个 View 的同名 Ref 可分别寻址。业务类型由元数据核对，字符串前缀不能伪造类型。

## 一份 Tool 声明，几种参数形状

完整定义、绑定和发布只维护在 [ref-app.tsx](examples/ref-app.tsx)；它使用与普通参数相同的 `defineViewTypeTool`、`defineToolSet` 和 `AppTools`，没有第二类 Ref Tool。

| 参数 Schema | 模型输入 | handler 接收 |
| --- | --- | --- |
| `refParam('Note', NoteSchema)` | 一个对象 Ref 地址 | 一个只读 Note 对象 |
| `refParam('Note', Type.Array(NoteSchema))` | 一个整数组 Ref 地址 | 原来的只读 Note 列表 |
| `Type.Array(refParam('Note', NoteSchema))` | Ref 地址字符串数组 | 按输入顺序解析的只读 Note 数组 |
| `Type.Optional(refParam('Note', NoteSchema))` | 可省略的对象 Ref 地址 | 省略时字段仍缺席 |
| `Type.Optional(Type.Array(refParam('Note', NoteSchema)))` | 可省略的 Ref 地址数组 | 缺席与提供 `[]` 不同 |

示例的 `inspect_selection` 可同时传多个选择、可选对象和可选整数组：

```json
{
  "selected": ["detail.notes[1]", "detail.notes[0]", "detail.notes[1]"],
  "primary": "detail.current",
  "whole": "detail.notes"
}
```

`selected` 保持顺序和重复项，不自动去重。`{ "selected": [] }` 是合法空选择，可选字段不填默认值。`null`、显式 `undefined`、空地址、不可见 Ref、错误类型或 payload Schema 不匹配都会拒绝整次调用；不可把它们当成“未提供”。普通参数同样不做隐式 coercion、default 或 trim。

这些 Ref 参数位于 Tool 入参对象顶层，可以与路径、标题、编辑内容等普通字段组合。Ref payload 支持 JSON 对象和对象列表；`.field` 查询、嵌套 Ref 参数、新作用域和基础类型 payload 体系尚未提供。文件打开与编辑仍可使用有业务意义的文件路径，不应为统一形式而全部改成 Ref。

App 可用解析对象里的内部 ID 操作自己的状态，不要求模型另抄 `plan_id`、`phase_id` 或 `task_id`。只读参数不限制业务副作用，也不承诺多选业务原子性。完整展开参数与来源 envelope 共同受预算约束，额度不会按字段或选项重置。

## 观察与来源

Host 准备 Observation 后显式采用，再使用其中的绑定；标准 Driver 通过 `Context.adopt()` 完成。采用新 Observation 会撤销旧调用资格；单纯发布或诊断预览不采用，其他独立 Scope 持有者不受影响。App 不生成 observationId／bindingId，也不实现私有 Ref 解析器。

Runtime 保留 Ref owner、View 实例、类型、原 Snapshot、来源、调用授权和预算检查。Tool 按 App + ViewType 共享，Ref 选择才指定数据；关闭一个页面而同类型其他页面仍打开，不会把共享 Tool 隐式绑定到剩下的某个对象。Tool 收据只报告完成及必要恢复提示，最新业务数据看 View。

## 数据捕获与失败

Worker 发出 Snapshot 前有界捕获严格 JSON，不冻结或修改 App 拥有的原对象。getter、隐藏字段、Symbol、循环和类实例会被拒绝；当前默认捕获限额为 48 层、100,000 个节点、约 8 MiB 的近似输入字节，Host 仍独立校验完整 V3 Snapshot、归属及规范化字节预算。

非法 Draft 产生 `SNAPSHOT_SERIALIZATION_ERROR` 并使该来源 degraded，不把失败 Draft 冒充最新有效状态。修正后下一份有效 Snapshot 可恢复 ready。`auto` 自动发布并通知，`never` 自动发布但抑制通知，`manual` 不自动发布后台变化；Tool 调用仍会提交当时投影。信号策略不放宽校验，也不等待尚未完成的外部业务工作。

配对包、运行步骤和验证命令见 [包使用说明](runtime-compatibility.md)。底层协议与资源合同属于 Runtime／Host；普通 App 作者只需声明数据、参数及业务检查。
