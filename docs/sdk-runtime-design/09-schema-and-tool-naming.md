# 09 — Schema 与工具命名：语义合同和模型表示分别负责

| 项目 | 内容 |
| --- | --- |
| 文档 ID | AOTUI-D09 |
| 状态 | **分层方向已获用户认可。Ref 参数提示已通过第三批验收。其他协议、工具命名与迁移待讨论** |
| 修订 | 0.5 · 2026-11-18（Asia/Shanghai） |
| 验收基线 | `90449dc2d` 加前三批工作树改动，SDK 0.9.0、Runtime 8.0.0 |
| 关联 | [05 兼容合同](05-compatibility-and-distribution.md)、[08 Ref 作者作用域](08-ref-authoring-scope.md)、[11 Ref 双格式](11-ref-address-contract.md) |

## 结论

**业务操作是什么、业务参数和 Ref 解析后应是什么值，由中立语义合同定义；某个模型 API 用什么工具名称、怎样表达 Schema 和候选页面列表，由表示适配层决定。**

运行时仍必须校验原始输入、页面路由、显式 Ref、来源资格和解析后的业务值。分层不是把这些检查交给模型，也不是让工具隐藏代替执行授权。

## 用户意见

> “Schema 和工具命名，需要区分语义合同与表现形式” 没问题

用户认可的是分层方向。本文提出的 profile、公开类型调整、别名映射与迁移步骤仍是候选，不能记为已批准实现。

## 先看一个例子：模型传的是字符串，为什么 handler 收到文件对象

`files` 页面显示 `[测试文件](File:results[0])`。`editor` 页面有一个“编辑指定文件”的操作。为了说明边界，假设 App 把文件路径和所见版本放入 Ref 值，并让该操作接收 `target` 与 `replacement`；这只是示意业务声明，不是新增固定 SDK API。

模型调用中的业务参数是：

```json
{
  "view_id": "editor",
  "target": "files.results[0]",
  "replacement": "Hello world"
}
```

通过合法来源解析后，handler 接收的业务参数则是：

```json
{
  "target": { "path": "test.txt", "revision": 7 },
  "replacement": "Hello world"
}
```

前一份里的 `target` 必须是 Ref 地址字符串；后一份里的 `target` 必须满足文件值的 Schema。`view_id` 已由框架用于选页，不能让作者再维护一份同名业务路由。Runtime 验证两种形态及其来源；App 进一步判断版本 7 是否仍可编辑。

再假设 FileList 和 SearchResults 两种页面都有一个名为 `open` 的操作。模型 API 需要一个可用的工具名字，但打开或关闭 SearchResults 不应让 FileList 原有操作突然改名；模型别名也不能因为看起来相同，就代表相同的页面操作。

因此真正的问题有两层：**同一个业务合同要正确生成不同边界的表示；不同业务操作又必须保持各自身份。** 把它们都塞进某个模型的函数名和参数 Schema，或者让作者手写每一份形态，都会增加不必要的耦合。

## 当前已经存在的两类合同

`defineViewType()` 将说明、业务 Schema 与实现声明在一处；`refParam()` 用 `x-aotui-ref-kind/value` 表达显式 Ref。Runtime 参数编译器分别验证模型输入和解析后的 handler 输入。`modelToolSchema()` 去掉内部 Ref 注解并加入框架管理的 `view_id`。

这说明当前已有正确分层的基础。问题在于，业务声明编译与模型 Schema 构造还位于同一个核心模块，公开 `ToolDescriptor` 还携带服务于别名显示的字段。

证据：

- [SDK view-type-tool.ts](../../sdk/src/tools/view-type-tool.ts)：`defineViewType()`、`refParam()`、`captureViewBindings()`。
- [SDK typebox-schema.ts](../../sdk/src/tools/typebox-schema.ts)：TypeBox 到 JSON 声明的转换。
- [Runtime tool-parameters.ts](../../runtime/src/core/tool/tool-parameters.ts)：两个输入验证阶段与 `modelToolSchema()`。
- [view-owned-tools.ts](../../runtime/src/core/tool/view-owned-tools.ts)：共享定义与实例绑定。
- [public-tool-name.ts](../../runtime/src/adapters/public-tool-name.ts)：字符与长度规则及公开别名拼接。

### Ref 参数如何提示模型选择

改前的公开包把单个 File、单个 Task、指向整组 File 的 Ref 都表示为相同的 `target` 字符串 Schema。三者共用地址说明，业务要求仍由 Runtime 校验。多选参数原有的外层 array 和 items 表达地址数组，`required` 表达参数是否可省略。

现在由同一个 `modelToolSchema()` 从规范声明派生提示。作者说明保留在前面，新增提示使用声明中的 refType 和能确定的目标值形状。以下四种选择都用 `target` 和同一句作者说明，接收页面均为 `editor`。

| 声明形态 | 模型提交的 `target` | 实际 Tools 中的类型和提示 |
| --- | --- | --- |
| `refParam('File', FileSchema)` | `files.items[0]` | 必填字符串，`Ref type "File". Value shape object.` |
| `refParam('Task', TaskSchema)` | `tasks.items` | 必填字符串，`Ref type "Task". Value shape object.` |
| `refParam('File', Type.Array(FileSchema))` | `files.items` | 必填字符串，`Ref type "File". Value shape array.` |
| `Type.Optional(Type.Array(refParam('File', FileSchema)))` | `["files.items[1]", "files.items[0]", "files.items[1]"]` | 可省略的字符串数组，元素说明为 File 对象，按给定顺序保留重复项 |

地址说明指出应使用来源 View 的 id、确切局部名和已有索引。顶层 `view_id` 独立选择执行页面。根数组与元素共用 `File` refType，`File[]` 是 formatter 给整组文件的展示提示。Tool 的目标 Schema 决定接受整数组还是元素。[实际 App 样例](../../sdk/tests/fixtures/ref-prompt-app.tsx)、[Ref 注册与展示](../../sdk/src/app-factory/refs.ts)

可靠的信息来源是声明的 refType 与目标 Schema 的类型关键字。可推导的 `anyOf` 会合并值形状，例如 `object or array`。无法确定值形状时只展示可确认的 Ref 类型和地址。声明为 `unknown` 时仍可提示已知形状。整段框架提示沿用旧地址说明的 118 个 JSON UTF-8 字节预算，含转义开销。名称过长时优先保留可确认的形状与地址，执行端继续用完整声明校验。模型获得类型、形状和地址说明，原观察继续持有所选值。作者仍可通过 description 补充业务含义。[提示生成与校验](../../runtime/src/core/tool/tool-parameters.ts)

保留旧提示的成本最低，同名字符串参数的目标差异仍须作者逐个补写。增加说明空间可以展示更长的类型名，却可能使既有声明超出完整 Schema 上限。沿用现有字节预算保留两种容量边界，同时覆盖测试中的类型和形状区分。真实模型的误选率及恢复轮次需要独立样本。

## 参数处理建议：一份规范声明，两个输入形态

| 形态 | 例子 | 谁解释 |
| --- | --- | --- |
| 作者类型 | TypeBox 表达业务对象和输入类型 | SDK 作者适配 |
| 规范语义声明 | 操作、参数、明确的 Ref 注解及目标值 Schema | 合同层与 Runtime |
| 模型输入 | `view_id` 与 `files.results[0]` 这样的地址字符串 | 模型表示适配与 Runtime 入口验证 |
| handler 输入 | 去除路由字段、解析为原观察只读值后的业务参数 | App handler |

例如，本文 `target` 的 handler 类型可以是 `File`，模型输入却是 Ref 地址字符串。这不是类型系统错误，而是明确的解析步骤。应保持单一声明能推导两种形态，避免作者维护两份 Schema。

推荐依次执行：

1. SDK 从 TypeBox 导出受支持的中立声明，在声明阶段报告不支持的关键词。
2. 合同层规范化并固定输入规则，Runtime 取得可复用的参数合同。
3. 表示适配根据具体模型约束生成工具 Schema；可以列出当前可接收页面，但不因此拥有最终授权。
4. 调用时 Runtime 校验原始形态，选择页面，解析原观察 Ref，再校验解析后的业务值。
5. App 检查业务前置条件并执行，仍使用当前页面的状态与服务。

`view_id` 仍由框架保留和消费，不能因移动模型 Schema 生成器而失去执行端校验。没有 Ref 注解的普通路径、标题或字符串，仍按普通业务参数处理。

## 有限 Schema profile：明确支持范围，而非扩张成完整标准实现

当前编译器是受限的 JSON Schema 风格合同，并不接受 TypeBox 可生成的所有结构。有限范围符合小内核目标；需要改善的是可发现性与规范性。

建议在合同版本内定义一个固定 profile，至少说明：

- 支持的 JSON 值与类型、对象/数组约束、`enum/const/anyOf` 等现有关键词；
- `default` 仅是注释，不填值、不转换类型；
- Ref 注解允许的位置与解析后目标值校验；
- 当前不支持的 `pattern` 等关键词明确失败，业务参数名称 `pattern` 本身合法；
- 声明大小、深度等资源限制与 Host 可配置投影额度的不同责任。

JSON Schema 官方把 dialect 定义为关键词及其语义的组合，并支持声明该组合。这可作为规范设计参考，但不能把当前有限实现直接标为完整支持某个 Draft。[官方说明](https://json-schema.org/understanding-json-schema/reference/schema)

本文不建议增加新 Schema DSL，也不建议为了规范性而立刻支持所有 JSON Schema 特性。是否替换当前编译器为通用验证库，必须以实际维护成本与语义一致性为依据；库的兼容范围与 AOTUI 的 Ref 转换规则不同。

首版可以继续现有实现，通过正反例与诊断用例固定 profile。后续新增关键词时，按 [05](05-compatibility-and-distribution.md) 声明最低合同要求，避免旧 Runtime 静默误解。

### Schema 的三条路线

| 方案 | 收益 | 即时成本 | 长期代价与边界 | 本项目判断 |
| --- | --- | --- | --- | --- |
| A. 保留 TypeBox 作者入口和现有编译器，固定有限 profile，拆开表示生成 | 复用已有能力；作者一份声明；现有值域、Ref 与诊断可以保持 | 整理支持表、分离纯语义编译与模型 Schema 构造，补成对合同用例 | 自维护有限编译器；需持续检查规范与实现一致，但稳定面可控 | **当前推荐**；先按模块职责拆，不因“分层”立即增加 package |
| B. 在有限 profile 后使用成熟通用验证器 | 可复用通用 Schema 校验实现；当支持范围扩大时可能降低维护成本 | 引入或调整依赖，映射错误、资源限制和转换差异，验证现有合同不变 | 通用库不会自动理解 AOTUI 原观察 Ref；仍需专有解析与值校验边界；不能顺便承诺全标准或所有库特性 | 仅在真实支持需求或维护成本证明值得时评估，先用合同用例比较候选 |
| C. 新建 AOTUI 专用 Schema DSL 或元编程体系 | 可以把页面、Ref 和业务类型做得更紧凑 | 作者语法、类型推导、编辑器支持、编译器、迁移都要重新建立 | Agent 又需学习一种体系；与普通工具链互通成本高；容易把当前可用问题变成语言维护问题 | 当前无足够收益，不采用；TypeBox 已提供作者表达基础 |

选择 A 不等于拒绝成熟库，而是先确认现有工具是否足够。选择 B 的前提也不是库名更成熟，而是它在同样 AOTUI 合同下确实减少总维护负担；不得通过弱化 Ref、深度或来源检查来取得更短实现。

### 模型 Schema 移动时，容量检查的责任也要一起迁移

`modelToolSchema()` 当前不只在最终请求阶段使用：

| 当前调用位置 | 提供的保证 |
| --- | --- |
| SDK `captureType()` | 作者声明时预检默认模型表示，尽早给出可行动的容量诊断 |
| Runtime `defineTools()` | 校验绕开 SDK 的声明入口，不能假定作者已预检 |
| SDK `getToolCatalog()` | 生成不含当轮候选页的静态模型目录 |
| 模型 adapter 构造工具时 | 加入当轮 eligibleViewIds 后再次检查完整表示 |

源码见 [SDK 声明及目录](../../sdk/src/tools/view-type-tool.ts)、[执行端登记](../../runtime/src/core/tool/view-owned-tools.ts)、[当轮模型表示](../../agent-driver-adapter/src/semantic-aotui-driven-source.ts)。直接把函数从 Core 搬走，不能顺便删除这些入口承担的责任。

应明确三类限制：**Core 的中立声明、JSON 与执行参数资源限制；表示 adapter 对完整模型 Schema 的限制；Host 对实际 Messages、Tools、历史等整份请求的预算。** 当前声明和模型表示都出现 64 KiB 限额，不表示它们是同一合同；模型生成器还会加入额外描述与候选页。

分层后，Core 继续守住中立语义限额；默认 SDK 路径可预检同一默认表示以保留早诊断，对应托管/适配接入负责覆盖绕开 SDK 的情况；最终 adapter 检查包含当轮候选页的表示。Host 仍核对完整实际请求，不能以单工具检查替代总预算。纯 Core 接受一份语义声明，也不意味着它保证所有模型都能承载该声明。此处是职责迁移要求，不要求现在增加一个新的校验框架或所有模型的统一配额平台。

## 工具身份与模型别名建议

当前语义工具 id 由 App、ViewType、名称组成；同类型多个页面共享定义，实例由 `view_id` 选择。这应继续保留。

当前 `nameSharedAcrossViewTypes` 在定义阶段针对全部声明计算，用于别名是否包含 ViewType。这个设计有实际用处：避免仅根据当前可见页面决定名称，导致开关页面时工具改名。

因此不能直接删掉字段，然后让 adapter 只看本轮可见工具自行猜测。

这份稳定性有范围：在同一份 App 声明、App 命名空间及同一 adapter 规则下，开关页面不会改名。若 App v1 只有 FileList.open，别名可能是 `ide-open`；v2 新增 SearchResults.open 后，即使新页面尚未打开，原别名也可能变成 `ide-FileList-open`。这是**同声明稳定**与**跨 App 版本稳定**的区别，不是当前规则失效。

三种可行表示候选：

| 候选 | 在 FileList.open / SearchResults.open 中的行为 | 优点 | 代价与适用条件 |
| --- | --- | --- | --- |
| N1. 保持现行别名策略，把完整声明的命名信息留在适配元数据 | 依据静态完整声明判断是否需带 ViewType，隐藏某页不改变判断 | 现有名称迁移成本最低；Agent 可继续使用熟悉名称 | 保留静态目录命名元数据；不得只看当前可见集合；适合先拆责任、暂不改名称 |
| N2. 始终按完整语义身份生成限定别名 | 两个 open 各有包含 App / ViewType 信息的稳定编码 | 规则统一；不依赖当前可见工具；便于解释与缓存，Core 无需 shared-name 显示字段 | 名称可能更长且有一次 breaking migration；仍需字符、长度、冲突处理；适合愿意统一迁移的稳定发布前阶段 |
| N3. 使用简短不透明别名，并保存显式映射 | 如两个短别名分别映射两个语义工具，模型从描述中理解差异 | 短；可以适应特别严格的名称限制 | 名称自身不可读；映射必须正确绑定观察；重新分配可能降低可预测性和复用；适合确有表示限制的特定模型 adapter |

近期推荐 N1。只有 [05](05-compatibility-and-distribution.md) 明确需要跨 App 版本的别名承诺，或真实消费者证明新增声明触发改名的成本值得解决，才考虑长期采用 N2。N2 能在 App / ViewType / 操作名不变时避免其他新增声明引发改名；它不保证重命名这些标识或更换编码规则后别名仍相同。N3 是表示适配的特殊策略，不应影响 Core 身份，也不值得现在做成一个通用命名策略平台。

这三种候选不代表默认 SDK 要长期支持三个可配置开关。决策时选一条合适主路径；确有提供商差异时才由相应 adapter 承担差异。

表示适配应建立显式 `alias -> toolId` 映射，并把它与对应观察一起绑定。模型返回的是别名，执行仍须回到权威语义 id 与原观察校验。别名不承担权限，也不能用于猜测当前对象。

如果模型限制名称长度，需要有确定、可验证的编码与冲突处理。短 hash 可以辅助命名，但必须检测冲突并保留映射，不能仅凭 hash 判定工具身份或授权。本文不冻结一个尚未验证的命名算法，也不把某个提供商的限制写进核心工具身份。

当前 adapter 的实际规则是：组成部分只含 ASCII 字母、数字和下划线，拼接后的完整名称不超过 64 个字符。全面限定会让原来未进入短别名的 ViewType 也承担字符与长度限制；现有测试已包含短名合法、限定名因 ViewType 不合法而被拒的情况。因此 N2 的成本不只是名称看起来长一点，不能未经消费检查就全面改名。[命名规则](../../runtime/src/adapters/public-tool-name.ts)、[消费者用例](../../agent-driver-adapter/src/semantic-aotui-driven-source.test.ts)

## 与动态能力的关系

- 静态 ViewType 操作定义只声明一次，不代表它现在可调用。
- 当前页面打开且实例启用时才形成可用工具能力。
- 适配层可生成更明确的接收页面 Schema，但 Runtime 仍核对真实页面实例和激活。
- 缓存工具 Schema 时要区分静态业务部分与观察相关的候选页面部分。
- App context 与 handler 的当前状态不能被静态 Schema 缓存冻结。

## 长期主义与 Minimalist：稳定含义，减少重复声明

近期最小可行改进是 **Schema 方案 A + 命名 N1 的责任拆分**：作者照常使用 TypeBox 和 `defineViewType()`，规范声明与业务输入语义有唯一来源，模型差异进入现有表示适配目录。它可以先改善边界，不要求同时改完包结构、命名算法和作者 API。

若决定为首次稳定生态做一次 breaking migration，再独立评估 N2 并迁移真实消费者。这样有明确的长期目标，又不会把三个问题捆成一次全仓重写。CLI 作为另一种调用表面时也应复用同一语义身份、参数与观察校验；本轮不据此选择 CLI 替代 Tools，也不新建 CLI 子系统。

若后续比较 CLI 与原生 Tools，应从相同初始状态、同一 App 语义和授权条件出发，覆盖开文件、跨页 Ref、关闭后恢复，记录误选、恢复轮次与实际输入成本。统一命令入口可能缩短固定工具表，也可能把成本移到发现、帮助和解析错误上；比较结果出现前，原生 Tools 继续作为默认入口，不宣称 CLI 必然更省 token。

一份业务声明、一个权威工具身份、一条来源校验路径，是需要保留的一致性。多个输入形态、多个渲染格式，是边界确实存在的差异；强行合成一份 Schema 并不更简单。

## Ref 地址约束

本文完整遵守 [11](11-ref-address-contract.md)：正文保留 `[测试文件](File:results[0])`，调用使用 `files.results[0]`。改进 Schema 分层不能统一这两种表示，也不能把普通字符串自动转成 Ref。

## 迁移与验收

1. 固定当前规范化 Schema、模型 Schema、调用输入和 handler 输入的成对用例。
2. 把纯声明规范化与模型表示构造分开，迁移 SDK 早诊断、绕开 SDK 的接入检查、目录及当轮表示校验，保持原语义和诊断 code；总请求预算仍由 Host 负责。
3. 将 TypeBox 依赖留在 SDK；合同层只接收 JSON 声明和必要的纯类型。
4. 在别名真实消费者上重点比较 N1 / N2；只有实际名称限制需要时才评估 N3，再决定是否一次 breaking migration。
5. 验证单值 Ref、数组、多选、optional、跨 View、同类型多实例、关闭重开与禁用后调用；同时验证普通路径/文本不被误解析。
6. 验证工具别名不因无关页面开关发生变化，并区分新增 App 声明造成的跨版本变化；新增单值、整数组和多选提示的成对用例，模型提示不替代执行端校验。

本批验证覆盖 SDK 声明、Core `defineTools`、静态目录和带 `["editor"]` 的模型 Schema。相同的 65,361 B 语义声明，加入接收页后从 65,536 B 到 65,527 B。额外加入测试中的较长接收页，仍触发现有的完整表示容量保护。含 63,000 B refType 的 65,536 B 语义声明在两版均通过，完整类型保留在语义声明，模型收到地址和简短形状提示。

原始 HTTP 请求由真实 Worker、Source、Driver 与模型 provider 适配器生成，HTTP 响应用替身脚本提供。Tools 数组从 3,381 B 到 3,344 B，完整请求体从 14,949 B 到 14,912 B。两次运行均验证总预算不足时既不采用 Observation 也不发请求，达到当次字节估算门槛才采用并发送，预留输出为 256。数字描述请求实际字节与当前估算器行为。错误类型和错误形状在分发前拒绝，后续脚本使用正确地址成功。[公开包请求验证](../../sdk/tests/fixtures/ref-prompt-consumer.mjs)

负责人从改前、改后归档的请求体独立计数，再从两个安装目录重跑同一用例，得到相同的 Tools 字节数、接收页清单和请求预算门槛。每版各发起 9 次调用，错误类型与形状的两次都未分发，其余 7 次成功。目标列表重排后，同一观察仍读取原来的元素。单独复跑的 117 项参数与容量测试通过，原样 Work Items 也通过两种 Runtime 装配。由此可以确认模型输入已能区分表中四种选择；这些脚本给定了调用顺序，模型实际误选率仍待测量。[参数测试](../../runtime/src/core/tool/tool-parameters.test.ts) · [容量测试](../../runtime/src/core/tool/tool-schema-limit.test.ts) · [原样 App 双路径](../../sdk/tests/fixtures/assembly-consumer.mjs)

修订 0.3 参考 [Astra 6.2 Review](REVIEW-2026-11-18.md)并独立核对，采纳提示丢失与容量调用链证据，限定名义类型推导与跨版本别名承诺；详见[评审回复](REVIEW-RESPONSE-2026-11-18.md)。这是设计内容更新，不代表实现、CLI 或命名迁移已获批准，也不复述为已经验证模型效果。

## 待讨论

1. 首版 profile 是否只固定当前子集？推荐是。
2. 模型 Schema 构造归独立表示 adapter 还是现有 adapters 入口？先按责任分模块，不急于拆包。
3. 是否采用始终限定的工具别名，接受一次名称迁移？
4. 当前 shared-name 信息移除前，哪些消费者需要兼容迁移？

## 决策与讨论记录

| 日期 | 记录 | 状态 |
| --- | --- | --- |
| 2026-11-18 | 用户认可语义合同与表现形式分层 | **方向已确认** |
| 2026-11-18 | 有限 profile、类型/输入分阶段处理、稳定别名映射 | **具体方案待讨论** |
| 2026-11-18 | Ref 两种地址保持分离，普通业务字符串不强制 Ref 化 | **已确认约束** |
| 2026-11-18 | 修订 0.2：补充同一文件参数两种形态及同名 open 例子，分别比较三种 Schema 路线和三种命名路线；近期边界拆分与可选名称迁移分开 | **具体方案继续待讨论** |
| 2026-11-18 | 修订 0.3：补 Ref 选择形态与可靠提示来源，明确四处表示生成及三层容量责任；区分同声明/跨版本别名稳定，N1 近期保留，N2 与 CLI 按证据评估 | **评审采纳为设计更新；未批准实现** |
| 2026-11-18 | 修订 0.4：复用现有生成器，在旧提示字节预算内派生 Ref 类型与形状，记录真实包的请求、容量和操作回归。工具命名、CLI 和表示职责迁移仍按各自议题的决策推进 | **Ref 提示已实现并经包消费验证** |
| 2026-11-18 | 修订 0.5。复核改前与改后安装包、实际 HTTP 参数及恢复结果。过长名称采用可容纳的形状与地址提示，执行端依然按完整声明校验 | **第三批已验收** |
