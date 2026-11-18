# 11 — Ref 展示格式与调用地址保持分离

| 项目 | 内容 |
| --- | --- |
| 文档 ID | AOTUI-D11 |
| 状态 | **已确认；统一地址建议已撤回** |
| 修订 | 0.5 · 2026-11-18（Asia/Shanghai） |
| 代码观察基线 | `90449dc2d` |
| 关联 | [08 Ref 作者作用域](08-ref-authoring-scope.md)、[09 Schema 与命名](09-schema-and-tool-naming.md)、[12 快照优化](12-snapshot-performance.md) |

## 用户决定

> Ref 的显示地址与调用地址 不能统一，这是我的设计

**正文保留类型提示与局部名称；工具输入使用带 View 前缀的调用地址。两种格式按各自职责存在，不进行统一。**

上一轮建议把正文直接改成全限定调用地址，现明确撤回。

## 先看一个例子：页面里的标签与调用时的地址分别解决什么问题

`files` 页面列出了两个文件，正文中有 `[测试文件](File:results[0])`。Agent 不需要先理解底层业务 ID：标签告诉它这是一个可选择的文件值，页面外壳告诉它该值来自 `files`。

当一个操作由 `editor` 页面接收，并且参数 `target` 被明确声明为文件 Ref 时，输入是：

```json
{
  "view_id": "editor",
  "target": "files.results[0]"
}
```

三个组成部分各有用途：

| 组成 | 在例子中 | 回答的问题 |
| --- | --- | --- |
| 展示标记 | `File:results[0]` | 页面中这个选择是什么类型、叫什么局部名称？ |
| 调用地址 | `files.results[0]` | 原 Observation 的哪个页面提供了这个值？ |
| 接收页面 | `view_id: editor` | 哪个页面实例处理这个操作？ |

若另一个页面也发布了名为 `results` 的 Ref，展示仍可使用自己的局部标记；调用时页面前缀区分来源。`File` 是展示类型提示，不代替值 Schema 验证；`files` 是来源路由，不赋予跨 App、跨任意历史观察的读取权。

因此需要改善的是**让作者和 Agent 容易正确使用两个表示**，而不是把已经确认的两个职责压成一种字符串。

## 已有合同

继续使用页面 id `files`；除 `results` 数组外，这个例子再用一个名为 `current` 的单值 Ref 说明三种选择：

| 选择 | 正文展示 | 显式 Ref 参数中的输入 |
| --- | --- | --- |
| 一个对象 | `[当前文件](File:current)` | `files.current` |
| 数组元素 | `[测试文件](File:results[0])` | `files.results[0]` |
| 整数组 | `[全部文件](File[]:results)` | `files.results` |

其中：

- `File`、`File[]` 是正文中的类型提示；
- `current`、`results[0]`、`results` 是页面内的局部名称；
- `files` 是调用时的数据来源页面前缀；
- 顶层 `view_id` 选择执行页面，可以与 Ref 的来源页面不同；
- 跨页面引用仍限制在同一 App 运行实例、同一原 Observation，并通过来源与当前资格校验。

例如，工具由 `editor` 页面接收，但数据来自 `files`：

```json
{
  "view_id": "editor",
  "target": "files.results[0]"
}
```

这不是把 `File:` 写进调用参数，也不意味着可以跨任意 App 或任意历史观察读取对象。

### 两个都合法的地址，仍可能选错业务对象

若 Files 与 Search 两页都显示 `[测试文件](File:results[0])`，模型想把搜索结果交给 `editor`，应使用 `view_id=editor` 与 `target=search.results[0]`。如果它误写成 `files.results[0]`，而两项都已授予、都满足相同的类型和值 Schema，那么两种调用在协议上都合法，Runtime 无法推断模型原本想选哪一项。

如果 Editor 自己也有同名 Ref，错误地把接收页写成来源前缀，也可能通过相同校验。这不能靠更严格的字符串规则通用解决，更不能要求来源页等于接收页，否则会破坏正常跨页操作。作者应给出足以区分对象或来源的业务标签；工具提示使用来源页与接收页不同的例子；具体业务前置条件仍由 App 判断。[解析与校验依据](../../runtime/src/core/tool/snapshot-value-arguments.ts)

### 发布了一百项，只画十项，不等于只提供十项

一个正常的 `arrayRef` 会捕获整数组及各元素；若数据有 100 项，通常登记根数组加 100 个元素，共 101 个 Ref。formatter 只决定正文输出多少标记，不反向删掉已捕获项。应区分四件事：

| 层次 | 谁决定 | 一百项例子中的可能结果 |
| --- | --- | --- |
| 发布的数据与 Ref | App 提供给捕获/提交的数据 | 根数组及全部 100 个元素 |
| 主正文的标记 | 作者调用 formatter 的位置和次数 | 仅前 10 项 |
| 本次授予的 Ref | Observation 的 grant 策略 | 可以授予已发布项的子集；默认完整策略授予全部 |
| 最终模型输入 | 呈现 adapter 组装正文与目录 | 当前 adapter 还追加全部已授予 Ref 的 `Available references` 目录 |

因此，正文只画前十项，不能推出最终 Messages 只有十个地址；也不能推出整数组不能被选择。只要根 Ref 已授予且参数 Schema 接受数组，选择 `files.results` 就能把整组捕获值交给 handler。Runtime 按 grant 与原观察解析，不扫描 Markdown 来决定权限。[捕获与格式化](../../sdk/src/app-factory/refs.ts)、[观察授权](../../runtime/src/core/invocation/observation-registry.ts)、[当前目录呈现](../../agent-driver-adapter/src/semantic-aotui-driven-source.ts)

若 App 希望只提供本页十项，应先 slice 或构造这十项业务集合，再传给 `arrayRef` 捕获。这样减少发布内容、可选范围与相关成本；它不替代授权、来源资格或业务权限检查。仅隐藏元素标记，或者过滤元素 grant 却仍授予包含全部数据的根数组，都不能证明剩余值不可被选中。

另须保持显示与实际类型的区别：当前 ArrayRef 根值与元素使用相同 itemType；整数组展示的 `File[]` 由 formatter 附加 `[]`，不是要求作者另造一个强制 `File[]` refType。整数组和元素的值形态由目标值 Schema 区分。

## 各层责任

| 层 | 责任 |
| --- | --- |
| SDK | 根据局部 Ref 描述生成符合现有语法的正文标记，校验标记及标签转义 |
| View 呈现边界 | 提供明确的页面 id 与正文包装，使局部标记具有页面上下文 |
| 参数合同 | 识别哪些参数是显式 Ref；普通文本、路径等不被误当成引用 |
| Runtime | 解析调用地址，绑定原 Observation、来源页与捕获值，完成相应校验 |
| App | 判断解析出的观察值在当前业务状态下是否仍适合操作 |

## 三种保持双格式的作者实现方案

| 方案 | 怎样生成上述例子 | 优点 | 成本与长期问题 | 适用判断 |
| --- | --- | --- | --- | --- |
| A. 作者自己拼接展示文本与局部名字 | 一处注册 `results`，另一处手写 Markdown；调用提示也由作者说明 | 无需新 API；很小的示例容易理解 | 名称、类型、下标和转义可能分散；页面重构时易漏改；Agent 作者要记更多细节 | 可作为解释协议的例子，不宜鼓励每个 App 复制格式化规则 |
| B. 复用唯一 Ref formatter，并让声明与展示共享描述值 | 现有 formatter 生成局部标记；08 的可选 descriptor 方案可进一步让同一声明进入 `View.refs` | 保留语法；减少重复字符串和错配；不需要在 Core 增加地址种类 | formatter 仍须测试标签转义；descriptor 若采用，必须复用现有捕获与提交机制 | **近期推荐复用现有 formatter**；是否新增 descriptor 由 08 单独决策 |
| C. 作者适配器内部保留结构化 Ref 节点，最终序列化双格式 | 页面文档树里保存 Ref 节点，Markdown 输出时由专用规则产生局部标记；调用解析不变 | 适合已经采用 AST 的内容管线；避免普通文本 serializer 把 Ref 当链接文本误处理 | 需新增节点、visitor、序列化与逃逸规则；如果全项目还没需要 AST，这些机制可能比问题更大 | 仅当 07 的实际转换需要 AST 时评估；不为 Ref 单独引入一套文档平台 |

这三种方案都保持同一公开协议。它们不是要求长期维护三套并行 Ref 系统，也不把“统一显示与调用地址”重新放回选项。

### 长期主义与 Minimalist 的取舍

先把两个格式、一个规范 Ref 语义讲清楚，并复用已存在的 `formatRef()`。如果 08 的 descriptor 能在实际 App 中减少作者错误，则让它成为现有格式化与捕获机制的输入；不要另建一套注册表。若 07 后续选 AST，Ref 节点也只是作者适配内部的表示，不能把 Runtime 变成 Markdown AST 解释器。

长期需要稳定的是局部展示规则、调用来源解析及其校验，而不是每个 App 都能自由选择不同地址语法。这里可以用少量共享实现减少维护成本，没必要增加配置项、全局 Ref ID 服务或跨观察永久链接。

## 兼容验收用同一组选择完成

以 `files.results` 为例，任何作者 API 或性能优化后都应证明：整数组调用使用 `files.results`，元素调用使用 `files.results[0]`；明确声明的多选参数可以携带多个合法调用地址，可选参数保持原有缺省语义。展示仍使用带类型提示的局部标记，不把这组地址原样替代到正文。

同时检查跨 View 接收、不同页同名 Ref、普通文件路径不被误解析、原观察取值、关闭重建和当前资格变化。页面 ID 与局部 Ref 名称的点号限制不扩展到普通路径或正文。由此既证明双格式保留，也证明改进没有只保住“字符串长得一样”却丢失原本能力。

额外保留两类用例：两个合法同类型地址之间的选择不能被框架擅自“纠正”；捕获 100 项而正文只画 10 项时，发布、grant、最终地址目录及根数组选择应符合各自合同。它们用于揭示边界，不把当前正常行为误标成 Runtime 缺陷。

第三批在实际请求里同时观察到 `[all files](File[]:items)` 和 `[label](File:items[0])`。接收页均为 `editor`。调用传 `files.items` 时 handler 得到整组文件；传 `files.items[0]` 时得到原观察的第一个文件，即使之前的调用已将页面列表反转。另一个页面可以独立发布同名 `items`。受测的多选保留了第二项、第一项、第二项的顺序，省略参数与显式空数组在 handler 中也可区分。此例覆盖两个元素的完整集合，部分 grant 的情形仍按上节单独判断。[实际请求与操作断言](../../sdk/tests/fixtures/ref-prompt-consumer.mjs)

第五批把返回时机放进同一选择过程。Work Items 的请求发出后，Host 暂停本轮并重排 App 数据。新页已发布，原观察中的第一个值仍为 `0`。合法响应迟到时，Core 在仍有效的接收页 `b` 执行，下一观察同时显示重排后的列表和这次对原值的检查。这个例子验证了数据来源、当前接收页与传输结束各自承担的责任。[请求与收据实测](01-messages-facts-and-memory.md#已发送的轮次如何收尾)

## 可以改进而不改变这条合同的内容

1. [08](08-ref-authoring-scope.md) 可以用 descriptor 或显式页面作用域，让作者更容易正确发布和显示 Ref。
2. 说明文字与示例可以更一致，让 Agent 清楚知道“局部标记 + 所属 View id”如何形成调用地址。
3. [12](12-snapshot-performance.md) 可以减少数组值的重复捕获和内部表示开销。
4. [09](09-schema-and-tool-naming.md) 可以独立表达 Ref 的模型输入类型与 handler 接收类型。

以上改变都不得把展示标记替换为全限定调用地址，不得取消类型提示、整数组、元素、多选、可选或跨 View 引用能力。

内部缓存与传输优化不能改变原观察解析语义。即使捕获值恰好与最新值相同，也不能绕过 Observation 和实例资格检查。

## 当前代码证据

- [SDK README 的 Ref 表格](../../sdk/README.md)。
- [refs.ts](../../sdk/src/app-factory/refs.ts)：`formatRef()`、`captureRefEntries()`。
- [tool-parameters.ts](../../runtime/src/core/tool/tool-parameters.ts)：显式 Ref 参数与模型 Schema。
- [snapshot-value-arguments.ts](../../runtime/src/core/tool/snapshot-value-arguments.ts)：原观察参数解析。
- [observation-registry.ts](../../runtime/src/core/invocation/observation-registry.ts)：授权目录与完整投影策略。
- [semantic-aotui-driven-source.ts](../../agent-driver-adapter/src/semantic-aotui-driven-source.ts)：最终 Messages 中已授予 Ref 的地址目录。

修订 0.3 参考 [Astra 6.2 Review](REVIEW-2026-11-18.md)并独立核对，采纳同名合法错选与捕获/展示边界，补充当前 adapter 的目录事实。限定见[评审回复](REVIEW-RESPONSE-2026-11-18.md)。这属于设计说明更新，不改变已确认的双格式，不代表新增实现已获批准。

## 决策与讨论记录

| 日期 | 记录 | 状态 |
| --- | --- | --- |
| 2026-11-18 | 上一轮提出展示与调用地址统一 | **已撤回** |
| 2026-11-18 | 用户明确分离是设计要求 | **已确认** |
| 2026-11-18 | 后续作者体验和性能方案均以现有双格式为约束 | **约束生效** |
| 2026-11-18 | 修订 0.2：加入 Files → Editor 的完整示例，比较手写、复用 formatter、适配器 AST 三种兼容实现；不重新讨论格式统一 | **说明与候选取舍更新** |
| 2026-11-18 | 修订 0.3：说明合法地址间意图错误的能力边界，区分发布、正文、grant 与最终目录；补充先限定集合再捕获、实际 itemType 与显示数组类型的区别 | **评审采纳为设计更新；未批准实现** |
| 2026-11-18 | 修订 0.4。第三批从真实包的请求到 handler 核对整组、元素、跨页、多选及原观察值，为后续呈现调整留下兼容基线 | **既有选择合同已复验** |
| 2026-11-18 | 修订 0.5。第五批用已发轮次中的暂停、后台重排和迟到的合法结果，再次验证原观察取值与当前接收页校验 | **既有选择合同沿用** |

## 待讨论

本条格式分离本身没有待确认问题。若讨论诊断文案或 API 便利性，分别进入 08 或 09，不在其他文档重新打开统一格式方案。
