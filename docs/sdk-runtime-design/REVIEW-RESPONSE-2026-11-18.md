# 对 Astra 6.2 Review 的回应与采纳记录

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-11-18（Asia/Shanghai） |
| 评审输入 | [REVIEW-2026-11-18.md](REVIEW-2026-11-18.md)，原文保留不改 |
| 核对基线 | `90449dc2d7ed51ed00f17b24d45bb19c5610c811`；原议题修订 0.2 |
| 本轮产出 | 12 篇议题与索引更新至 0.3；本文件记录回应、采纳范围和分歧 |
| 文档性质 | 可转发的评审回复；具体设计仍以 [SSOT 索引](README.md)及各议题为准 |
| “采纳”的含义 | 将核实的事实、成立的理由和推荐取舍写入正文；不把候选 API 记成用户最终选型或已实现能力 |

## 总体判断

**这份 Review 整体合理，最有价值的是把若干宽泛的架构判断落到了可检查的调用点、错误路径和输出合同上。** 我采纳其中成立的新增内容，并对实施范围作进一步收窄。核心交互模型不需要因此推倒重来：View 仍是页面，Messages 同时是事实与记忆，Ref 保留原观察与双格式，业务目标和冲突判断继续归 App。

它带来的实质增量主要有五项：XML 字符范围的反例、Ref 参数在模型侧丢失的类型/形态提示、公开 `entity` 分支与当前生产路径不一致、Ref 发布范围与正文展示范围的区别，以及诊断摘要可以先做的更小优化。

另一些观点与 0.2 已经一致，例如不增加重复 owner、不冻结业务闭包、不因框架超时就重试业务、AST 与增量传输按需求采用。它们应继续保留，但不能全部记成新发现的遗漏。

还有几处需要补上现有实现和测试的事实。默认适配器已经处理部分采用、已经透传 App 原始错误码和 data；Driver 已有采用失败时不调用模型的测试；Preact 已有共享队列下的多根失败隔离检查。新增工作的重点应该是贯通或补齐具体边界，避免重复建设已有机制。

## 一、逐篇判断与本轮处理

| 议题 | 对 Review 的判断 | 本轮写入 SSOT 的内容 |
| --- | --- | --- |
| [01](01-messages-facts-and-memory.md) 事实与记忆 | 采用与发送应分开，采纳；双 App 探针只证明局部采用没有自动形成跨 App 事务 | 拆分时点，补预算失败、部分采用、发送失败；如实记录现有处理与测试，把新证据限定为完整组合用例 |
| [02](02-view-page-semantics.md) 页面与对象 | 认同并加强原分工 | 强调合法调用仍可能表达错误业务目标；版本条件要在真实业务写入边界发挥作用 |
| [03](03-core-assembly.md) Core 装配 | 反对第二层空包装成立，原文已认同；实施门槛需要分层 | 加 owner 迁移核查；区分内部归位、独立消费者验证、公开稳定入口，不能按 `closed` 变量名机械合并状态 |
| [04](04-execution-backend.md) 后端与收据 | 终态与外部效果分离、启动失败清理、指令措辞建议均有价值 | 保留当前透传事实，明确剩余恢复字段问题；推荐分配者继续清理；不新增效果分类或安全沙箱承诺 |
| [05](05-compatibility-and-distribution.md) 兼容 | `entity` 是具体可核实的收窄候选；旧产物及失败路验证有价值 | 增公开类型实例、实际依赖解析及失败路；不据仓内搜索断言外部无人依赖 |
| [06](06-preact-semantic-bridge.md) Preact 桥 | 相同错误码与不同健康后果成立；多根覆盖需说准确 | 区分无提交与真实故障，说明已有多根测试，补未来后端的 globals、事件和独立关闭责任 |
| [07](07-dom-adapter-boundary.md) DOM / XML | NUL 反例成立；更换 Markdown 库不能解决该字符合同 | 在 XML 呈现边界比较拒绝、显式可见编码与弱化格式三条路线；不把 XML 限制施加到全部 Core JSON |
| [08](08-ref-authoring-scope.md) 作者作用域 | 诊断先行、同页重名拒绝成立；作者收益不能只看一次错误率 | 保留 descriptor 候选，比较组合和修改成本；重名规则复用既有 owner 与检查 |
| [09](09-schema-and-tool-naming.md) Schema / 别名 | 提示丢失成立；容量调用链和类型来源要展开；全面改名应有明确承诺范围 | 用已有显式 refType 和值形态生成提示；保留四处表示消费者的责任；区分同声明稳定和跨版本稳定 |
| [10](10-opening-deferred.md) 开页 | 保留暂缓，改善当前失败说明，采纳 | 区分专用 opening 容量拒绝、前段快照校验失败、整轮模型预算；未选恢复方案 |
| [11](11-ref-address-contract.md) Ref 双格式 | 合法错选与发布/格式化差异成立；最终 Messages 还有目录补充 | 加四层范围说明、两个同名合法来源和先限定集合再捕获的例子；双格式不变 |
| [12](12-snapshot-performance.md) 性能 | 更小 P0 与各候选独立取舍，采纳 | 保留 published `contentDigest` 字段与结果；先评估未消费计算，其他优化各自过证据门槛 |

## 二、最值得采纳的具体改进

### 1. P0 应先避开未消费的摘要计算，保留公开摘要合同

这一点改变了我原来建议的精度。0.2 写“诊断按需计算”还不够明确，因为当前 `AppSnapshot.contentDigest` 是公开的必填字符串，已有测试固定它的 FNV 输出。它不负责授权与判等，不代表可以在一次普通性能修改中删掉字段、换算法或改成函数。

实际调用链更适合做一个小改进：prepare 调用 validator 后只取 draft 和 canonical 内容；Store 又在验证之后才判断 unchanged。可以先研究省掉这两个分支中未被消费的 digest，真正发布新 Snapshot 时仍提供相同的普通字符串值。该方向不要求先引入 WeakMap 句柄、页级共享或新的公开配置。[准备端](../../runtime/src/core/projection/coordinator.ts) · [Store](../../runtime/src/core/snapshot/store.ts) · [公开类型](../../runtime/src/core/snapshot/types.ts) · [摘要合同测试](../../runtime/src/core/snapshot/validator.metadata-boundary.test.ts)

P0、候选复用、页共享、ArrayRef 复用与 delta 各解决不同瓶颈。完成 P0 后可以停止；若仍有可测的重复捕获，再评估相应候选。避免把“优先级”读成必须走完的重写路线。这次没有实施优化或重跑性能基准，也没有据历史微基准承诺新的毫秒收益。

### 2. Ref 提示缺失成立，但要使用真正存在的类型信息

当前 `refParam(refType, valueSchema)` 已有作者显式类型与目标值 Schema。模型表示去掉内部注解后，单个 File、单个 Task、一个 File 数组值，在外层参数条件相同时可以变成相同的地址字符串 Schema。执行校验依然严格，但模型在发起调用前缺少了原本可以提供的选择线索。[作者声明](../../sdk/src/tools/view-type-tool.ts) · [表示生成](../../runtime/src/core/tool/tool-parameters.ts)

建议从同一声明产生简短提示，区分：

| 目标 | 模型输入形态 | 提示依据 |
| --- | --- | --- |
| 单个文件值 | 一个地址，如 `files.results[0]` | 作者显式 refType + 目标值 Schema |
| 整个文件数组值 | 一个地址，如 `files.results` | 同一 refType + 目标值为 array |
| 逐项选择若干文件 | 地址数组，如 `["files.results[1]", "files.results[0]"]` | 外层多选参数结构 + 每项 Ref 合同 |

这里有两个不能省略的细节。第一，TypeBox 的局部变量名不会自动成为规范语义；有 path 字段也不能被框架猜成 File。第二，`arrayRef(..., { itemType: 'File' })` 的根数组与元素实际可以共用 `File` 这个 refType，`[]` 是整数组的展示格式。不能为了生成提示，擅自要求作者改成一个新的 `File[]` 存储类型。[捕获与 formatter](../../sdk/src/app-factory/refs.ts)

提示可能减少失败尝试，也会增加 Tools 输入量。当前已证明的是表示遗漏，尚未证明改提示后实际模型错误率或总 token 一定下降。有限示例对照足以开始验证，不需要先建设新的 Schema DSL 或通用评测平台。

### 3. XML 字符集合确实需要明确，不应默默修改业务数据

对真实 `A + U+0000 + B`，本轮独立小实验确认当前 Core validator 接受，而现有 XML 包装输出被标准解析器拒绝。对照的 `<`、`&`、字面反斜杠文本 `A\u0000B` 和合法补充平面字符能够通过。这说明分隔符转义与字符可表示性是两件事。

W3C XML 1.0 的字符集合不含 U+0000，数字字符引用同样受该集合限制；改成 `&#0;` 不能绕过。XML 1.1 也不允许 NUL。孤立 UTF-16 代理项等边界也需考虑，不能粗略禁止一切控制字符而误拒绝规范允许的内容。[XML 1.0 字符](https://www.w3.org/TR/xml/#charsets) · [字符引用](https://www.w3.org/TR/xml/#NT-CharRef) · [XML 1.1](https://www.w3.org/TR/xml11/#charsets)

我倾向在 XML 呈现边界拒绝不可表示的实际输出，并给出 App、View、字段与位置；App 再选择 hex 或可读转义等业务展示。拒绝策略、目标 XML profile 和错误码仍需明确决定。Core 的 JSON/Ref 值域不应为了一个输出格式被全局缩小；静默删除或替换字符则会改变事实呈现，也不能声称保真。

呈现失败必须与来源采用衔接，不能漏掉故障页还沿用完整成功来源的工具资格。健康 App 可以按自己的来源处理，不需要另造一套资格注册表。这个反例不能证明 LLM 一定读不懂输入，也不能单凭它选定 AST 或更换 Preact。[XML 包装](../../runtime/src/adapters/view-message.ts) · [现有往返测试](../../runtime/src/adapters/view-message.test.ts)

### 4. 发布范围与正文可见范围需要分开教学

Review 对“捕获 100 项、只格式化 10 项”的判断成立。Formatter 产生标记，不能撤销其余 Ref 的发布或授予。授予根数组时，整个数组仍可能被一个适配 Schema 的参数选中。

还应补充当前消费者的事实：默认适配器会追加已授予 Ref 的 `Available references` 目录。所以主正文只画 10 项，不等于最终 Messages 只出现 10 个可选地址。应分别解释捕获/发布集合、观察授予集合、App 主正文、最终模型输入。[Ref 捕获](../../sdk/src/app-factory/refs.ts) · [授予](../../runtime/src/core/invocation/observation-registry.ts) · [实际呈现](../../agent-driver-adapter/src/semantic-aotui-driven-source.ts)

App 如果只想提供当前十项，应先构造这十项的业务集合，再交给 Ref 捕获。它减少所发布的值与成本，不能代替权限检查。若 App 确实要同时提供全量数组和当前页，也可以明确表达，不应由 Runtime 扫描正文猜作者意图。

两个合法地址之间的选错也一样：模型想选 `search.results[0]`，却传入同样被授予且符合 Schema 的 `editor.results[0]`，Runtime 没有额外事实证明模型心里选的是另一个。可区分对象的标签、跨页例子和 App 的业务前置条件更有意义，统一两种地址或禁止跨页都不能解决这个意图问题。

### 5. 公开面收窄应落在具体消费者与真实产物上

`Observation.refs[].kind` 的公开类型允许 `entity`，当前 RefTarget、快照验证与生产路径却只有 `snapshot-value`。仓内核查没有发现正常 consumer 依赖 entity 分派，这是一个合理的发布前清理候选。[Observation 类型](../../runtime/src/core/invocation/observation-types.ts) · [实际 RefTarget](../../runtime/src/core/snapshot/types.ts)

仍需把仓内未发现与外部无人依赖分开。外部 mock、visitor 或手写 Observation 可能受到类型变化影响；实施前应核对受支持消费者并一次迁移。拒绝非法 entity 的边界测试仍有价值，不应随多余 union 分支一起删除。

原样保留的 App 产物还应记录 App、SDK、Host 实际解析到的依赖与 Preact 实例，同时覆盖成功路径与失效调用路径。当前单版本源码和测试不能证明已经实现跨版本产物兼容。独立 contracts 包依然是有条件的载体，稳定的具体行为才是承诺对象。

## 三、对 Review 需要补充或保留分歧的地方

### 1. 采用/发送建议要建立在已有失败处理之上

我采纳把 adopt 和实际 send 分开讲。采用会改变调用资格，网络发送随后仍可能失败；两个 App 逐个采用也不会自动形成一个全局事务。Review 主动限定了纯 Core 探针不能证明当前 Host 发错请求，这个限定正确。

补查发现，默认 adapter 已收集每个 App 的采用结果，并在部分成功时释放无法继续使用的上下文，抛出 `SEMANTIC_ADOPTION_PARTIAL`。Driver 在配置预算时会在 provider 调用前检查实际输入，并在请求前采用观察；现有模型替身测试也覆盖采用失败后不调用 provider。因此不能用纯 Core 探针中的“旧 B 仍有效”直接描述默认 adapter 收尾后的状态。[采用收尾](../../agent-driver-adapter/src/semantic-aotui-driven-source.ts) · [实际 provider 边界](../../agent-driver-v2/src/core/llm-client.ts) · [已有采用测试](../../agent-driver-v2/tests/core/context-adoption.test.ts)

值得新增的是把真实多个 App 的 O1/O2 正文、Tools、alias、最终预算和失败收尾贯通到同一个请求捕获点。发送出错也不能被解释成模型一定没有收到；若放弃该轮，就释放该轮资格并拒绝其晚到输出继续分派，已有在途工具仍按真实责任收尾。无需为此增加模型已读 ACK 或回滚旧观察资格。

### 2. 收据风险要区分 Runtime 外壳和模型实际看到的内容

`success: false` 映射到 `failed / TOOL_FAILED` 的事实成立。函数已返回却无法确认远端业务效果，也是需要教清楚的场景。但默认 adapter 已解包 `details.result`，保留应用的 error code、message 和 data；不能将问题概括为当前模型只会看到 `TOOL_FAILED`。[映射](../../runtime/src/core/invocation/invocation-outcome.ts) · [直接消费者](../../agent-driver-adapter/src/semantic-aotui-driven-source.ts)

尚需明确的是哪些恢复信息属于 Agent 可见合同，以及当前未完整透出的 `error.context`、`executionPhase` 是否需要呈现。先检查信息放在哪里、消费者实际读到了什么，再决定修正。业务结果未知仍由 App 表达，不新增效果分类，也不把已结束 handler 改成永不终结的框架调用。

### 3. 多根 Preact 已有证据，但不代表整个同进程环境已经证明隔离

安装包检查已经把两个 App 放在同一个 Preact 队列，验证一个根的 render/layout/class lifecycle 失败不污染另一个根的有效投影。应复用这一基础，不能列作从未验证的空白。[现有安装包检查](../../sdk/tests/package-consumer/verify-preact-commit.mjs)

未来后端还有自己的责任：DOM adapter 会共享或创建 global document/window，LLM usage hook 在 document 上监听，事件从 App 根冒泡。独立关闭与另一个根的待提交工作交错、环境所有者及事件作用域需要在后端装配中说明。不能简单给每个 App 加一段“恢复所有 globals”的 cleanup，因为这可能拆掉另一个根还在使用的环境。[DOM 环境](../../runtime/src/adapters/dom-app.ts) · [事件 hook](../../sdk/src/hooks/useLLMUsage.ts)

### 4. 不能把第二个正式消费者当成所有内部改进的先决条件

我赞成用一个最小独立消费者检验 03，并以 01 的实际请求和 05 的保留产物验收；这能让集成负担可见，也不要求先承诺第二个后端。

我的进一步限定是：内部职责已明显放错位置、重复接线已经存在时，可以根据现有证据整理。公开一个长期稳定的入口，才需要更强的独立消费者证明。Minimalist 的门槛应落在新增责任和兼容承诺上，不能变成所有内部归位都要等待第二个正式产品上线。

同理，若诊断改善后 Agent 能写对 hooks，仍要比较被迫拆组件、传递参数、组合与后续修改成本。首次错误率低，不自动证明 descriptor 没有收益；descriptor 代码短，也不自动证明它值得公开。这里保留多方案比较，比单一指标更符合 SDK 服务 Agent 开发者的目标。

### 5. 命名和容量的改动需要更完整的消费链

Review 对全面改名保持谨慎，我采纳它作为近期取舍。当前 N1 已能保证同一声明集合中的页面开关不改变别名；新增另一 ViewType 的同名操作，可能使下一版本 App 的别名变化。N2 能减少这类变化，但当前 adapter 的 64 字符及字符集合限制会使全面限定产生新拒绝。是否承诺跨 App 版本别名稳定，要由 05 与实际消费者共同决定，不能把当前 adapter 限制写进核心工具身份。

`modelToolSchema` 也不只有两个消费者：SDK 声明捕获、Runtime defineTools、SDK 静态目录、加入当轮 eligibleViewIds 的模型 adapter 都使用它。拆模块时需分别保留中立声明限额、表示限额与 Host 总预算，不能只移动函数。CLI 保留为同一任务、同一授权和观察条件下的候选对照，不凭工具表看起来更短就替换默认 Tools。

## 四、本轮证据边界

| 证据类别 | 本轮实际完成 | 不能据此宣称 |
| --- | --- | --- |
| 当前源码、公开类型与直接消费者 | 核对 Review 相关路径，确认现有分支及其职责 | 生态中所有消费者都已被覆盖 |
| 现存测试源码 | 核对 no-render / fault、多根隔离、采用失败、错误透传、摘要固定值等断言 | 本轮重新运行并通过了这些整套测试 |
| 独立字符小实验 | 内存编译当前 validator 与 XML wrapper，比较 NUL、分隔符、字面转义、孤立代理项与合法补充平面字符 | 本轮重跑完整 publish/observe/adopt 链，或证明 LLM 实际误读 |
| Review 自述的 12 + 6 项测试及四个探针 | 保留原文报告，与源码机制相互核对 | 将其运行次数、Node 版本或结果冒充本轮独立测试 |
| 真实性能与产品效果 | 未重跑历史 benchmark，未调用真实 LLM、未验证跨版本发行 | 已证明某候选更快、更省 token、更好学或产物兼容 |

源码基线未变，SDK / Runtime 实现、依赖和发布配置未修改。开页机制继续暂缓；事实修订和推荐收敛没有变成未经决定的实现批次。

## 五、可以继续对齐的下一步

我同意将 03 作为系统设计的下一项讨论，用同一份小 App 同时检验公共装配、实际模型请求和保留产物。下一轮最有价值的产物是明确哪些接线由现有 owner 接手、哪个调用边界能证明结果，以及因此减少了哪些公共承诺。

更小的 XML 输出合同、Ref 提示和摘要计算建议可以分别确认，互不要求先完成大规模重构。每项都保留自己的事实依据与收益门槛；用户选定后再进入实现。本文的采纳内容已回写各议题，后续继续修改这些正文，不以本回复替代它们。
