# 07 · DOM 转换与作者适配层的边界

文档 ID：AOTUI-D07 · 修订：0.6 · 更新：2026-11-18（Asia/Shanghai）

**列表词界在现有 DOM 转换器中修复。** JSX 作者只需写出自己想呈现的文字和空格。长期归属上，DOM 转换服务作者适配层，Core 只消费已提交的页面。迁移公开入口或引入 AST 工具，应分别说明现有消费者会少承担哪项责任、现有转换器已经难以处理哪种真实页面。

## 状态与范围

| 项目 | 当前记录 |
| --- | --- |
| 状态 | 列表词界经三版安装包独立复验，第四批已验收。标准 XML 互操作是否属于默认承诺、DOM 模块迁移及 Markdown profile 仍待讨论 |
| 代码基线 | `90449dc2d7ed51ed00f17b24d45bb19c5610c811` |
| 最近讨论 | 2026-11-18，Asia/Shanghai |
| 本文负责 | DOM 如何成为页面正文，转换代码归属，格式与转义合同 |
| 相邻议题 | [06](06-preact-semantic-bridge.md)负责真实提交时机；[08](08-ref-authoring-scope.md)负责 Ref 作者接口 |

**DOM 可以继续作为 Preact 适配器的内部实现。** 解耦不等于必须立刻移除 DOM，也不等于重新实现浏览器。本文没有批准目录迁移或更换默认作者入口；开页准入按用户要求暂缓。

## 用户原话与边界

> 7. “DOM 转换应当完整归入作者适配层” 有优秀/成熟的解耦方案吗？

> AOTUI 的一个 View 实例 对应的 就是 GUI 网站内/桌面应用的一个页面

页面可以是列表、详情、仪表盘或混合工作区，不能因为采用文档树就要求每页只对应一个固定业务对象。Messages 也兼具事实呈现与记忆作用；输出格式的稳定性会影响 Agent 的持续工作，但不改变内容的业务所有者。

## 先看同一个 IDE 的输出链

Files 页为 `view_id=files`、`type=FileList`，`results` ArrayRef 中显示 `[测试文件](File:results[0])`，调用地址则是 `files.results[0]`。Editor 页为 `view_id=editor`、`type=FileDetail`，先显示 `test.txt`，以后可以在同一页面切到 `notes.txt`。这些名称是共用解释用例，不强制现有 App 的工具命名。

例如示意切换请求 `{ view_id: 'editor', target: 'files.results[0]' }` 中，接收页和引用来源页不同；正文转换不能把来源前缀擅自改成 `editor`。

假设 `test.txt` 包含 `if (x < 3 && y > 0) {}`。从组件到模型应经历三件不同的事：

1. Preact 提交后，适配器读到页面中的原始代码文字，并形成有合适 fence 的 Markdown。
2. 唯一呈现边界加上 `<view id="editor" ...>` 外壳，把正文中的 `<`、`&`、`>` 编码一次。例如源代码的 `<` 变成 `&lt;`，不能因重复编码误变成 `&amp;lt;`。
3. 这份 XML + Markdown 作为 User Message 进入 Messages；下一次成功观察只呈现 Editor 的最新快照。编辑 Tool 仍返回收据与必要提示，不承担第二份正文真相。

另一个容易忽略的例子是 Files 中的 Ref formatter。它生成 `[测试文件](File:results[0])`，若新 AST serializer 把这串字符当普通字面文本重新转义，输出就可能失去原来的 Ref 标记形式。**“都生成 Markdown”不等于“生成同一应用接口”。** 同样，格式化时不能重新生成页面 owner、Ref 身份或工具激活。

模型开始生成后，本轮输入固定。后续切文件或改格式不会让该轮模型自动看见新内容；回来的调用仍按原 Observation 解析引用，App 使用当前执行环境检查业务条件。DOM 转换无需、也不能替它判断文件冲突。

## 现状：转换职责分散，但已有可复用边界

[createTUIApp.ts](../../sdk/src/app-factory/createTUIApp.ts)在 SDK 中组织组件挂载，却从 Runtime 的 [dom-app.ts](../../runtime/src/adapters/dom-app.ts)取得 DOM 创建、页面读取与事件派发。后者又调用 [transformer/pure.ts](../../runtime/src/engine/view/transformer/pure.ts)和 [html.visitor.ts](../../runtime/src/engine/view/transformer/visitors/html.visitor.ts)，把标签转换成 Markdown。普通 TS 的 [createApp.ts](../../sdk/src/app-factory/createApp.ts)则直接提供 Markdown。

当前 [ViewContent](../../runtime/src/core/snapshot/types.ts)已经是 `markdown-v1` 正文加独立元数据，不需要 Core 理解 DOM。最终 XML 外壳由 [view-message.ts](../../runtime/src/adapters/view-message.ts)统一生成。这两条边界应保留。

真正的问题是所有权：DOM 遍历、标签语义、空白处理属于作者渲染适配；它们现在位于 Runtime 的多个目录，容易让后续实现误以为 DOM 是应用协议的一部分。另一个问题是转换规则尚以 visitor 行为为主：例如普通文本会 trim，标签间会插入空格，而 `pre/code` 另有保真处理。以后替换转换器，不能仅以“同样输出 Markdown”判断兼容。

### 已修复的列表项词界

JSX 会把变量和相邻文本交给 DOM 作为多个节点。例如 `{path} — View {id}` 中，空格就保存在中间的 Text 节点。旧 visitor 在外层列表项逐节点 trim，在嵌套项又按空格连接，结果既会丢失词界，也会凭空加词界。第四批首次交付修复了直接 Text 节点的拼接。下面是当时已经通过的实际正文差异。

| 真实请求中解码出来的旧正文 | 修复后的正文 | 来源 |
| --- | --- | --- |
| `test.txt— Vieweditor` | `test.txt — View editor` | IDE 的已打开文件 |
| `FileDetail:edit, close` | `FileDetail: edit, close` | ToolCatalog 相同的 JSX 拼法 |
| `**Status:**ready` | `**Status:** ready` | Terminal 的 strong 后接状态 |
| 嵌套项 `pass word` | 嵌套项 `password` | 两个无空格的相邻 Text 节点 |

首次验收在同一词界规则下发现行内元素回归。形如 `<span>Open </span><span>file</span>` 的嵌套项在第三批是 `Open file`，第四批首次交付变成 `Openfile`。把空格移到右侧 span 开头也会复现。外层对应布局此前已有同一缺陷。原因是行内元素交回普通遍历时，它的边沿空格已被裁掉，列表拼接拿不到原来哪一侧表达了分隔。

修正后，`li` 的行内遍历递归读取透明元素中的原 Text 节点。强调和链接的边沿空格放在 Markdown 分隔符外侧，代码内容和反引号的选择继续走已有规则。列表项外沿仍按已有规则整理。外层和嵌套项共用这套行内读取。其他段落和标题仍走各自访问规则。

| 已提交列表页的嵌套项 | 第三批 | 第四批首次交付 | 第四批修正后 |
| --- | --- | --- | --- |
| 相邻 span，空格在左侧尾部或右侧开头 | `Open file` | `Openfile` | `Open file` |
| strong 加带前导空格的 span | `**Status:** ready` | `**Status:**ready` | `**Status:** ready` |
| 两个不带分隔的 span | `pass word` | `password` | `password` |
| 分隔藏在 span 内的 small 中 | `Nested file` | `Nestedfile` | `Nested file` |
| em 本身表达边沿空格 | `State *ready* now` | `State*ready*now` | `State *ready* now` |

三份安装包使用同一扩展夹具生成真实 provider 请求。XML 解码后，外层和嵌套项的九组正反例分别匹配预期，代码围栏文本、Ref 标记、编号、页面元数据、工具 Schema、实际接收页和调用结果通过对照。扩展夹具的三份请求为 15,503 / 15,499 / 15,515 B，Tools 均为 3,344 B，与首次使用较小夹具的请求记录各自保留。现有 JSX 可直接获得修复，依赖旧输出文本的 golden 文件应按实际词界更新。[原转换点](../../runtime/src/engine/view/transformer/visitors/html.visitor.ts)、[列表页夹具](../../sdk/tests/fixtures/ref-prompt-app.tsx)、[实际请求验证](../../sdk/tests/fixtures/ref-prompt-consumer.mjs)

负责人独立复跑了三份安装包，在 fetch 边界读取 provider 序列化后的 POST 请求，响应由固定的工具调用脚本提供。三版的 Tools 内容逐项一致。各版在其 Driver 预算门槛少一单位时均未采用、未发送，恰达门槛时均发出请求。修正版的 43 项 Runtime 定点用例通过。原样 Work Items 另经托管 Worker 和独立 Core 跑完，取得 11 张收据，关闭后本地持有与托管待完成操作均归零。这组证据覆盖输出、调用与资源边界。真实模型能否更快读懂页面，需要另用 Agent 任务测量。[请求替身](../../sdk/tests/fixtures/scripted-provider-turn.mjs) · [原样 App 消费](../../sdk/tests/fixtures/assembly-consumer.mjs)

## 一个补充反例：转义正确，仍可能不是合法 XML

在已安装的 Preact Worker 中，同一个页面同时发布真实的 `A` + U+0000 + `B`，以及字面的 `A\u0000B`，Desktop 同时有一个健康 App。两版 stock 包均接受 Core revision 2，Source 正常准备并采用两个 App 的观察。Provider 解码 JSON 后的 Messages 保留真实 NUL，配套 Tools 仍能调用。Python 标准库 XML parser 拒绝该页，健康 App 的四页均可解析。Ref payload 可继续持有真实 NUL，在原观察和显示已修复的新观察中均有成功调用。纯包装探针另覆盖孤立高／低代理项、合法补充字符 🧪、View 名称和 suffix，以及实体和 CRLF 往返。孤立代理项和非法属性／suffix 的结论来自纯包装探针。

[W3C XML 1.0 字符规则](https://www.w3.org/TR/xml/#charsets)排除 NUL、孤立代理项等表示；[字符引用规则](https://www.w3.org/TR/xml/#NT-CharRef)还要求数字引用指向合法字符，所以 `&#0;` 不能修复 NUL。合法补充平面字符不能因其 JavaScript 表示使用代理对而被误拒绝。标准允许的范围、仅建议避免的字符，也不能混为一谈。选用哪版 XML profile 尚未决定；[XML 1.1](https://www.w3.org/TR/xml11/#charsets)同样不允许 NUL。

### 两个已跑通的候选行为

仅在隔离的 Source 呈现调用点注入候选，真实包继续负责准备、采用、调用和清理。两种候选的输出都进入真实 provider 序列化，以下为模型实际收到的内容或故障信息。产品仍按 stock 路径运行。

| 策略 | 模型实际收到 | 观察、调用与恢复 |
| --- | --- | --- |
| 按 App 拒绝并定位 | Desktop 的候选诊断为 `AOTUI_VIEW_XML_UNREPRESENTABLE`，指出 U+0000 和 `View sample.markup[10]` | 故障 App 的页面与工具一起退出该候选，未采用该 App 的观察。健康邻居照常采用并调用。App 或有权限的宿主可以修正显示，之后正常观察 |
| 显式可逆的可见编码 | View 加 `text_encoding="aotui-code-unit-escape-v1"`。解码 XML 后，真实 NUL 显示为 `A\u0000B`，原有字面序列显示为 `A\\u0000B` | XML 可解析，按明确规则逆转义可还原原始正文。两 App 仍采用、可调用。需约定哪些字段编码，以及模型和下游怎样辨认与解码 |

只把 NUL 替换为 `\u0000` 会让这两行变成同一显示。可逆候选先转义该 View 显示字段中所有反斜杠，再编码非法 UTF-16 单元，普通合法 View 沿用现有路径。该候选覆盖正文、suffix、View 名称，非法路由字段仍拒绝，以保留接收和引用标识的含义。采用这种合同需要同步更新解码、模型提示、调试工具和依赖正文的编辑流程。

仅准备或放弃候选时，旧已采用观察中的调用仍成功。在三条实际请求路径中，采用下一轮后 Source 释放其此前持有的旧来源，旧 ID 的新调用被拒。按原 `observationId` 和 `invocationId` 回查先前的成功收据仍有效。隔离拒绝只改变模型呈现，Core revision 2 仍被观察为完整帧。本次由有权限的宿主用独立 Core 观察修复显示，随后同一个实例以 revision 3 恢复成功观察。各 Host 中独立持有的来源继续按拥有方的采用和释放合同处理。

### Claude 和 DeepSeek 怎样使用标签

Anthropic 对 Claude Code 给过一个具体例子。文件或时间变化后，客户端把 `<system-reminder>` 放进下一条 user 消息或工具结果，给 Claude 新信息，同时复用之前的提示缓存。其提示指南也建议用标签划出指令、资料和例子的边界。这里可核实的是更新何时到达模型、文字如何分段；公开资料没有规定该标签遇到 U+0000 时的线上处理。[Claude Code 工程说明](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything) · [Claude 提示指南](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)

DeepSeek 也区分消息字段与模型侧表示。它公开的 V3.2 编码器将工具调用转换成 DSML 标签，对字符串参数直接插入文本，对其他参数使用 JSON。其 API 另有实际的 `latest_reminder` 角色，适用于日期、位置等用户元信息，放在对应 user 消息之前。一个是具体模型的专用编码，一个是客户端可以调用的消息合同。这两份材料都没有规定第三方 App 的 View 必须通过标准 XML 解析。[DeepSeek V3.2 编码实现](https://huggingface.co/deepseek-ai/DeepSeek-V3.2/blob/main/encoding/encoding_dsv32.py) · [DeepSeek 用户元信息标记](https://api-docs.deepseek.com/zh-cn/guides/latest_reminder/)

### AOTUI 的默认输出要向谁保证可解析

**负责人建议先保留现行的标签呈现及一次转义。是否承诺“每条成功的 View Message 都可交给标准 XML 1.0 解析器”仍待用户决定。** 当前 Runtime 可直接提供结构化的观察、Ref 和工具，Source 从同一观察生成 User Message 和当轮 Tools。仓内 GUI 预览会识别外壳并解码实体，现有测试还验证合法字符可经标准 XML 解析器往返。这两种消费都值得保住。上述厂商实践解释了模型为何能利用文字标签，不能替 AOTUI 决定对第三方 Host 的发行承诺。[Runtime 集成合同](../../runtime/README.md) · [Source 组装](../../agent-driver-adapter/src/semantic-aotui-driven-source.ts) · [GUI 预览](../../host/src/gui/components/TuiParser.ts) · [XML 往返测试](../../runtime/src/adapters/view-message.test.ts)

以能读含 NUL 的日志页为例，App 可以将该字节显示成 `[00]`，原值留在业务数据或 Ref 中。模型读得懂显示，程序仍可通过既有 Ref 取得原值。如果项目选定标准 XML 作为对所有 Host 的输出保证，建议在最终 View 外壳按 App 拒绝并定位，走已有的失败与恢复路径。其实际代价是这个 App 当轮失去业务工具，需由 App 或授权宿主修正。只有必须让这类页面持续可操作、同时又要求通用 XML 往返的具体消费者，才值得让模型提示、GUI 与其他读取方共同承担可逆编码。三条路径均已有对照；产品实现仍采用现行行为。

## 成熟模式与可借用组件

成熟的文档处理通常分开“输入结构、规范化文档树、输出序列化”。[mdast](https://github.com/syntax-tree/mdast/blob/main/readme.md)是 Markdown 的中立语法树规格；[hast-util-to-mdast](https://github.com/syntax-tree/hast-util-to-mdast/blob/main/readme.md)转换 HTML 语法树；[mdast-util-to-markdown](https://github.com/syntax-tree/mdast-util-to-markdown)负责序列化并提供扩展入口。它们证明这种模块边界已有成熟实践。

但这些工具不知道 AOTUI 的 View owner、Ref 捕获或工具激活，也不自动保持当前输出字节。把 Ref formatter 返回的字符串当普通文本交给新序列化器，还可能转义掉 Ref 标记。这是接入成本，不能把库的存在当作已经验证的兼容保证。

| 方案 | 收益与局限 | Agent 作者成本 | 即时与长期维护 | 适用条件 |
| --- | --- | --- | --- | --- |
| A. 保留 visitor，迁到 Preact 适配 | 保持现有能力，先解决职责分散；仍要维护标签细节 | 现有 JSX App 无需改写 | 近期最小；长期靠明确 profile 控制范围 | 现有标签集合已够用，主要问题是边界不清 |
| B. DOM → hast → mdast → Markdown | 复用成熟转换与序列化；不自动兼容 Ref、空白及输出字节 | 作者可继续 JSX；格式变化需要说明与迁移 | 近期增加依赖、节点策略与兼容工作；复杂文档增多后可能减少自研维护 | 已有多种实际格式需求，visitor 修补成本持续高于接入成本 |
| C. 作者直接提供 Markdown | 复用现有纯 TS 能力，链路短 | 简单页面容易；复杂列表、fence 与文本拼接由作者承担 | 近期无需 AST 平台；长期需公共格式 helper 避免各 App 重复错误 | 页面以文本为主，作者不依赖组件组合 |
| D. 作者提供文档 AST | 内容结构可组合，再统一序列化 | 需学习节点模型；Agent 写简单页会更啰嗦 | 初期作者 API 与节点合同较多；长期适合共享复杂文档能力 | 已证实结构化文档组合是普遍需要，而不只是一次格式修复 |

Minimalist 在这里不是选择字符数最少的 serializer，而是先复用已能工作的 visitor 和纯 TS 入口，减少独立格式真相。**本文建议近期采用 A，并保留 C 已有能力，尚待确认。** 先建立可测试的 Markdown profile，再决定是否引入 AST 库，否则只是把未说明的规则换成另一个工具的默认值。B/D 都不应因“成熟库存在”成为默认新依赖。

## 拟议代码迁移地图

以下位置均为方案，不是已完成修改。共享公共类型沿用议题 05 的中立 AppContract 决策，不在本文另定一个合同包。

| 当前实现 | 归属建议 | 迁移要求 |
| --- | --- | --- |
| `runtime/src/adapters/dom-app.ts` | Preact 作者适配内部，如 `sdk/src/adapters/preact/dom-app.ts` | DOM 初始化、附着读取与清理一起迁移；Runtime 不反向依赖 SDK |
| `runtime/src/engine/view/transformer/` | 同一作者适配的正文转换模块 | 首轮保持现行输出；标签规则与对应测试一起迁移 |
| `sdk/src/app-factory/createTUIApp.ts` | 继续作为 Preact 装配入口 | 依赖内部适配及中立提交合同；提交时机由议题 06 负责 |
| `runtime/src/core/snapshot/types.ts` | 保留中立内容与快照合同 | 不增加 Element、VNode 或 HTML 属性依赖 |
| `runtime/src/adapters/view-message.ts` | 保留在协议呈现边界 | 负责 XML 外壳和一次编码，不并入 DOM visitor |

现有 `/adapters/dom` 是公开导出，迁移前要确认真实消费者，并按 [05](05-compatibility-and-distribution.md)决定兼容或 Breaking Change，不能只改内部 import。若未来纯 TS 和组件作者都需要同一个 Markdown serializer，再提取纯文档函数；不要仅为可能的复用预建多层包。

迁移时仍只有一个页面所有者和一套已提交元数据。Files 与 Editor 的工具按 App + ViewType 共享、按打开和启用条件激活；visitor 只转换正文，不通过扫描正文发现或注册工具。这样移动代码不会创造第二个能力目录。

## Markdown 与转义合同建议

以 [CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/)作为可核对的语法基线，再明确 AOTUI 子集与扩展，**不宣称当前 visitor 已完整实现 CommonMark 或 GFM**。初版 profile 应覆盖现有标题、段落、强调、链接、引用、列表、分隔线、行内代码和 fenced code。表格等未明确支持的能力另行声明，不默认为浏览器 HTML 全部可用。

需要明确三种不同责任：

1. 作者提供原始正文或文档节点；代码内容不得被普通文本的 trim 规则修改。
2. Markdown serializer 处理 Markdown 自身的标点、链接与 fence；Ref 标记遵循专门规则，显示地址与调用地址保持分离。
3. XML 呈现边界对完整 Markdown 正文及属性各编码一次；预览只解码一次。不能预先把 `&` 变成实体后再次编码，也不能靠正则拆除用户正文中的 `<view>`。

对已接纳、能够由选定 XML profile 表达的正文，XML 往返要保持原始 Markdown 文本；Markdown 解析后的展示并不自动等同于原文件字节。需要精确编辑的文件内容仍由 App 数据与操作合同负责。

下面是**拟议分层伪码，不是新公共 API**：

```ts
const committedViews = preactAdapter.readCommittedViews();
const frame = committedViews.map(view => ({
  ...view.metadata,
  body: markdownProfile.serialize(view.document),
  refs: view.capturedRefs,
  bindings: view.committedBindings,
}));
// Core 验证并准备中立投影，不解析 HTML。
const prepared = core.prepare(frame);
// 后续唯一呈现边界才为 body 包 XML 并编码一次。
```

`view.document` 可以先保留为适配器内部 DOM；引入 AST 时再替换。采用成熟 AST 的意义是让格式规则可组合，而不是强迫 Runtime 保存整套树。

## 现在的最小做法与后续触发条件

本批选择在已有 visitor 修复已观察的空白缺陷。保持原输出会让 App 逐处自行修改 JSX，其他同形列表仍受影响。直接迁 DOM 模块也会保留旧输出的缺陷，同时涉及公开 `/adapters/dom` 消费者和包依赖。已安装包验证该入口继续可导入，纯 TS 路径也能在无 Preact 安装中编译与执行。整理位置和选择 XML 字符策略均需各自的决策。

当表格、复杂嵌套内容、多个输出适配等**实际需求**反复出现，并且现有 visitor 的维护成本已经明确时，再用 Files/Editor 的同一组内容比较 B。只有共享文档结构确实改善 Agent 的组合能力时，才继续考虑 D。长期选择的依据是维护责任与作者正确性，而不是 AST 节点更多、架构图更完整。

## 迁移与验收

先把现有样例固化为输入/输出 fixtures，再进行路径迁移，最后比较候选 serializer。必须覆盖：相邻行内节点空白、嵌套列表、反引号与多行代码、CR/CRLF、XML 特殊字符、字面 `<view>`、空页面、Ref 标记、同类型多页面。未知标签必须有明确行为，不能静默声称完整支持 HTML。

这一批的安装包验证覆盖真实 NUL / 字面转义、相邻健康 App、拒绝与编码候选，以及修复后观察和旧收据。孤立代理项、合法补充字符、属性与 suffix 另由纯函数探针覆盖。正式采用一种策略时，应把该行为变成常规回归，并记录对旧 App 字符输入的影响。这里的 HTTP 响应使用脚本替身，真实模型如何理解修复后的正文需单独验证。

跨议题验收还应确认：06 证明真实 commit 之后才读取正文；08 的新 Ref 声明仍产出相同展示形式；05 的公共合同不暴露 DOM 类型。开页准入与 rollback 不属于此次转换迁移。

## 未决问题

1. Markdown profile 的首版是严格兼容当前输出，还是允许一批明确的格式修正？
2. 先保留 visitor，还是已有具体样例证明 AST 工具能减少维护成本？
3. Ref 在 AST 中采用专用节点还是受控序列化扩展，如何兼容现有 formatter？
4. XML profile 与不可表示字符的诊断如何确定，怎样接入原 App 的恢复和观察采用路径？未知 HTML 标签策略随首版 Markdown profile 一并明确。

## 讨论与撤回记录

| 日期与时区 | 记录 |
| --- | --- |
| 2026-11-18 · Asia/Shanghai | 用户要求研究成熟解耦方案；本文推荐先明确输出合同并迁移职责，再决定转换器。 |
| 2026-11-18 · Asia/Shanghai | 澄清“DOM 归适配层”不等于“必须移除 DOM”；Preact 默认入口未改变。 |
| 2026-11-18 · Asia/Shanghai | 排除把 View 限制为固定业务对象的解释；Ref 显示/调用地址维持分离；开页准入暂停。 |
| 2026-11-18 · Asia/Shanghai | 复核 [Review 07](REVIEW-2026-11-18.md#review-07)并用当前源码验证字符反例；采纳 XML 范围与诊断边界的补充，拒绝策略仍为倾向建议。参见 [审查回复](REVIEW-RESPONSE-2026-11-18.md)，不收紧全部 Core JSON/Ref，也不宣布实现。 |
| 2026-11-18 · Asia/Shanghai | 按 DOM Text 节点的原词界修复 `li`。实际 provider 对照验证正文修正，保留公开 DOM 入口。XML 候选完成隔离验证，待选择 XML 1.0 拒绝或引入可逆编码合同。 |
| 2026-11-18 · Asia/Shanghai | 首次验收发现嵌套 `li` 的行内元素丢失词界。将按 DOM 原词界读取的范围延伸至列表项的行内递归，三版实际请求覆盖两层及透明元素嵌套。 |
| 2026-11-18 · Asia/Shanghai | 用户追问两家模型厂商如何使用标签。核对 Anthropic 工程说明、DeepSeek 公开编码器和仓内消费者，补上保留现状这一选项。把是否承担标准 XML 互操作承诺放在拒绝与编码之前。此处记录技术建议，产品选择待定。 |
| 2026-11-18 · Asia/Shanghai | 负责人重跑第三批包、第四批首次包及修正版。带分隔的两个 span 与无分隔的两个 span 在两层列表中均得到作者原意，代码、Ref、工具表和原样 App 通过复验，第四批验收通过。 |

## 文档修订记录

| 修订 | 日期与时区 | 变化与决定状态 |
| --- | --- | --- |
| 0.1 | 2026-11-18 · Asia/Shanghai | 建立成熟 AST 资料、代码迁移地图和格式边界；未批准新依赖。 |
| 0.2 | 2026-11-18 · Asia/Shanghai | 增加 Files/Editor、代码特殊字符与 Ref formatter 的具体因果例子；分开直接 Markdown 与 AST 作者方案，补齐成本和触发条件；仍先复用现有 visitor。 |
| 0.3 | 2026-11-18 · Asia/Shanghai | 增加 NUL 与 Unicode 表示反例、三种字符策略和恢复责任；明确公开 DOM 入口的迁移边界。XML profile、诊断类型及实现仍待讨论。 |
| 0.4 | 2026-11-18 · Asia/Shanghai | 记录已修复的列表词界及真实包请求。补现行与两个 XML 候选的采用、调用、修复、分字段纯探针和决策成本。 |
| 0.5 | 2026-11-18 · Asia/Shanghai | 保留首次交付的行内回归，记录列表内修正、强调分隔符和三版包对照。XML 候选维持待决策。 |
| 0.6 | 2026-11-18 · Asia/Shanghai | 记录修正版的独立包消费、预算边界和原样 App 复验。把已完成的词界修复、XML 互操作承诺和模块迁移各自的决定状态写明。 |
