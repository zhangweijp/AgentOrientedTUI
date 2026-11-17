# AGENTS.md

## 文档目的与状态

本文件记录项目所有者明确的产品目标、交互约束，以及据此评审设计和实现的方法。初始基准为 2026-10-28，后续反馈按各节日期记录。自 2026-11-11 起，本机 SDK / Runtime 设计与验收索引位于 Git 忽略的 `docs/sdk-runtime-design/README.md`，2026-11-17 重新建立的可读取四层主文档与维护规则见第二十四节；第二十一节保留此前四层讨论记录，第十五节保留此前三层讨论记录，发布前兼容清理见第二十节。第十六至十九节保留 B01–B04 交接，第十三、十四节保留此前路线与交接事实。仓库提供 [SDK README](sdk/README.md) 和 [Runtime README](runtime/README.md)。各节引用的旧评审 `deepseek_review.md` 可在提交 `60ee17785` 中查阅。

这些目标是设计基准，不表示现有实现已经满足全部要求。阅读代码时必须区分「目标」「当前实际行为」「提议中的改造」；发现冲突应明确指出，不能用现状反向改写目标。

本次架构评审聚焦 SDK 与 Runtime。Mobile、Agent Driver 和其他模块的内部实现不在本轮范围内；可以定义 SDK/Runtime 对外必须提供的集成契约。本段仅记录此次任务范围，不限制后续任务涉及其他模块。

## 一、产品目标

1. 使用 AgentOrientedText-basedUI（AOTUI）构建的 Application，主要服务对象是 LLM Agent。
2. AOTUI SDK 的核心应用开发者也是 Agent。人类需要能够理解、审查和维护，但不能只用人类开发者对某种框架的熟悉度评价 SDK。
3. 项目希望成为可被不同 LLM Agent 系统复用的基础设施。重点是稳定的应用交互语义、可验证的运行行为，以及 Agent 构建正确应用的能力。
4. AOTUI 之于 Agent，类似 GUI 之于人类：它为使用者维护当前工作对象、可见状态和可用操作。

## 二、已经确认的交互约束

呈现方式、动态操作、最新快照与数据分离来自项目所有者的明确要求；下文关于所有权、授权和发布状态的说明是对这些要求的工程解释，不表示某种具体机制已经被批准。

### 2.1 View 是进入上下文的应用页面

- Application 通过 View 向 Agent 呈现当前应用状态。
- 当前呈现格式是 XML + Markdown；View 被包装为 LLM 上下文 Messages 数组中的 User Message。
- Agent 可以通过应用提供的操作，控制 View 的打开、更新、关闭及其他明确支持的状态转换。
- 2026-11-15 项目所有者明确：页面只有打开与未打开；本轮采用的同一快照中，所有已打开页面都应进入观察。上下文不足不应接受新页面打开，不能让页面保持打开却在成功观察中被挑选省略。请求前准备/采用属于内部交接，不构成页面第三种状态；真实模型输入必须与已采用来源对应。具体容量准入与实现差距见 C02 / K04。
- 不应把视觉布局或 DOM 机制本身当作产品目标；采用何种内部渲染技术，需要以这些交互语义为依据。

### 2.2 应用当前状态的 Projection（投影）

- 项目所有者于 2026-11-03 明确：采用 Projection，而不是“修改 Agent 工作记忆”或通用 Messages CRUD 作为系统模型。
- Agent 操作 App，App 更新自己的业务状态；SDK/Runtime 将已提交的 View、Ref 和当前工具能力投影到上下文。Messages 是呈现结果，不是应用任意修改的业务数据库。
- 对同一个逻辑 View，当前上下文中只呈现其最新有效快照。更新不能持续追加多份看似都代表当前状态的旧快照。
- 「只保留最新 View」针对当前状态投影，不等于要求删除用户对话、操作收据或审计记录，也不要求为没有持有者的旧快照保留完整 Ref payload。有仍然有效的 Observation 或已分发且尚未终结的调用时，按各自所有权暂时持有必要来源；资格撤销与数据释放分开，责任结束后释放。此原则于 2026-11-15 再次确认，当前实现核对见 C01。
- 应用只管理自己的投影部分，不能改写用户指令或其他来源的上下文；不因此扩展出通用记忆管理系统。

### 2.3 View 与可用行为共同构成充血模型

- View 不只是数据文本，也承载当前工作对象及其适用操作。
- 面向 Agent 的 Tool 定义按 App + ViewType 共享。2026-11-15 第四轮项目所有者明确每个 View 实例拥有自己的状态与局部操作，Agent 用 `view_id` 选择实例。2026-11-16 合并版已实现页面实例绑定。业务有效性由 App 校验，作者接口与验收状态见 [View Type SDK 专题](docs/sdk-runtime-design/view-type-sdk/README.md)。
- 2026-11-16 项目所有者确认新版页面实例 Tool 的 `view_id` 由框架自动加入模型 Schema，始终必填。作者只声明业务参数。Runtime 消费该字段并校验接收者，handler 接收业务参数。跨页 Ref 与调用合同见 [View Type SDK 已确认目标](docs/sdk-runtime-design/view-type-sdk/01-goals-and-invariants.md#confirmed-contract)。
- App 业务 Tool 会随着 Agent 打开 View、进入某个对象上下文或发生状态转换而逐渐暴露。
- 例如，尚未打开任何文件时，不暴露针对已打开文件的编辑能力；文件打开后，其 FileDetailView 才提供相应编辑操作。
- 2026-11-13 项目所有者明确，`system-open_app` 与 `system-close_app` 是 Desktop 基础工具。Apps Source 启用时，两项工具的名称和参数 Schema 固定，即使当前没有可操作的 App 也可见。调用时从当前 Desktop 选取 App ID，按话题启用范围、App 状态和关闭所绑定的实例判断能否执行。
- 操作的可发现性、当前可用性、执行时授权和业务前置条件是需要分别说明的概念。仅隐藏 Tool 不能代替执行时校验。
- 动态可用性是产品语义。是否使用原生 Tool、CLI 或其他调用入口表达它，仍属于待评估的实现选择。

### 2.4 操作与数据呈现分离

- 项目采用类似 CQRS（Command Query Responsibility Segregation）的职责分离思路：Tool 发起操作；具体业务数据及其变化通过 View 呈现。
- Tool 返回操作结果、必要提示及恢复操作所需的信息；文件正文、查询结果集合等主要业务数据应进入对应 View。
- 不应在 Tool Result 与 View 中同时维护两份独立的「当前数据真相」。
- 这条约束并不自动要求采用 Event Sourcing、独立读写数据库或分布式事务。
- 操作已受理、业务已完成、结果已进入可观察 View，是需要区分的事实。实现不能仅凭 handler 返回，就宣称新的 View 已经可见。

### 2.5 SDK 与 Runtime 的职责边界

- SDK 与 Runtime 的目标是服务好 AOTUI 开发者，构建简单、强大、稳定的内核。
- 应用层应自行承担自己的业务职责。SDK 与 Runtime 不应为了替应用兜底而接管业务规则、推断业务依赖或进行过度设计。
- 工程评审应区分框架拥有的交互机制与应用、宿主拥有的策略：框架对自己管理的提交、身份、绑定、调用和资源生命周期负责；业务数据是否正确、外部操作是否成功、何时更新业务状态由对应应用或资源适配器负责。
- 常见需求可以通过可选 SDK helper、环境适配器或示例支持；是否进入必需的内核路径，应以跨应用通用性、框架能否独立判断以及资源所有权为依据。
- 简化应优先消除重复解释、历史兼容和模糊接口；不能把框架应有的一致性、隔离、清理和失败反馈责任转嫁给每个应用作者。

## 三、规范性示例：打开并编辑 test.txt

1. Agent 打开 aotui-ide。此时没有打开文件，也没有针对文件的 edit file 操作。
2. Agent 调用 read file（其语义是打开/展示文件）打开 test.txt。该操作产生操作收据与必要提示，以及包含文件内容和相应操作的 FileDetailView(test.txt)。
3. FileDetailView(test.txt) 以 XML + Markdown 包装后进入 Messages，并提供当前对象的 edit file 等可用操作。test.txt 正文统一通过该 View 呈现，不在 Tool Result 中重复返回。
4. Agent 调用 edit file，应用执行编辑。该操作产生操作收据与必要提示，更新后的正文通过 FileDetailView(test.txt) 呈现。
5. 下一次呈现当前应用状态时，旧快照退出，最新快照按明确规则进入 Messages；不能同时存在两份均自称当前状态的 FileDetailView(test.txt)。
6. View 被关闭后，其当前状态内容退出应用投影；Tool 仍按 ViewType 共享，最后一个匹配 View 关闭后该类型能力不再激活。Ref 与旧观测的生命周期另按明确合同处理，不能从共享 Tool 推导具体业务对象仍可操作。

read file / edit file 在这里表示交互语义，不要求保留这些字面 API 名称。操作收据与 View 的发布顺序及下一轮观察保证由公共契约明确；本例不预先规定 IPC 或消息发送时序。快照排序、关闭后的重新打开等细节，也应由具体公共契约明确，而不是由各应用自行猜测。

## 四、评审 SDK 与 Runtime 时必须回答的问题

以下是从目标推导的评审维度，不表示某个具体技术方案已经被批准或实现。

### SDK：让 Agent 容易生成语义正确的应用

- Agent 能否仅根据公共文档、类型和示例完成应用，而不需要阅读 Runtime 内部协议？
- 示例是否遵守「操作返回收据、业务数据通过 View 呈现」？不能只检查示例能否编译。
- 是否能从同一份声明得到一致的 View 内容、对象引用、当前操作和输入校验？哪些同步职责仍由应用作者承担？
- 相同名字或相似签名是否隐含不同的生命周期、目标范围或执行语义？
- 错误是否提供稳定 code、具体位置和可行动的修复信息？面向应用作者的诊断与面向应用使用者的收据应有合适边界。
- 应以 Agent 生成应用的契约符合率、修复轮次、依赖私有 API 的比例和迁移成功率评价 SDK，而不只比较代码行数。

### Runtime：维护可信的当前工作环境

- 一次观察得到的 View、Ref 和可用操作是否来自兼容的已提交状态？
- 调用是否能追溯到 Agent 实际观察到的目标，而不会因同名 View 重开或绑定变化而误作用于其他对象？
- 操作完成与结果投影可见之间有什么明确保证？后台任务、失败和外部变化如何表达？
- 只保留最新快照时，是否仍保留足够的操作因果信息与恢复依据？
- View 打开、关闭、摘要、分页和刷新如何影响上下文预算、能力可见性与资源生命周期？
- 是否诚实区分未执行、失败、部分副作用、已受理、结果未知和资源已释放？
- 当前状态、操作发现和执行验证是否遵守同一语义来源？

### 广泛复用：可替换实现，稳定语义

- 不同宿主、渲染方式和调用入口，应能够实现同一组交互不变量。
- 将领域数据与权限、条件写入等业务保证放在能实际承担它们的层；不能用 UI 可见性或普通进程隔离代替。
- 定义支持范围、版本兼容、诊断、持久化与关闭行为；不要把单一 Demo 成功等同于通用 Infra 成熟。
- 评估上下文总量、实际模型输入成本、刷新延迟和任务成功率；不能仅凭「删除旧 View」推导出成本必然降低。

## 五、改造与验证原则

- 先阅读既有架构决策。已接受的 RD 总体路线由 Git 历史中的 0003 决策记录追溯：复用现有 Core、保留 Preact 默认开发模型、用 DOM 与普通 TypeScript 两种 Producer 验证；公共术语统一为 Tool，实验中的 Action 是同一概念，不另建平行体系。该 RFC 文件已从当前工作树移除，核对原始决策时应从 Git 历史检索，不要依赖失效的本地路径。
- 本次明确的产品目标是新的评审基准；如需改变既有技术路线，应说明被调整的决策与理由。本文件不将既有已接受路线改写为「从未决定」，也不把 RFC 中的目标接口或历史验收状态当成当前已实现能力。
- 可以提出 Breaking Change，包括替换公共 API、默认执行路径或内部实现。实施范围以当前具体任务为准。
- 重构应保留已被证明有价值的语义保证。减少代码或采用新技术本身，不是丢弃一致性、生命周期、授权、资源边界和失败语义的理由。
- CLI 替换原生 Tool、改变默认 authoring 技术、替换内部库或调整包边界，均属于可重新评估的设计选择；本文件不批准这些替代方案，也不取消既有路线。
- 用代码与测试核对文档；历史验收记录、当前运行结果和架构推断需要分别说明。
- 优先验证打开文件后能力出现、编辑后仅最新 View 可见、关闭后旧绑定失效、外部修改被识别、长任务保持有界、失败能被 Agent 理解和恢复等场景。
- Agent 使用应用和 Agent 开发应用是两类评测，应分别设计。
- 修改本文件时保留既有仓库指导，并清楚区分项目所有者确认的目标与尚未决定的建议。


## 六、Semantic 收敛与 Legacy 退出

本节记录项目所有者于 2026-10-28 补充的清理方向和退出条件。

### 已确认的方向与条件

- 在项目所有者本人完成新 Semantic 路径的测试并验收后，Legacy 可以下线，SDK 与 Runtime 以唯一的 Semantic 路径为维护目标。
- 当前优先级是清理和收敛内核，以及 SDK、Runtime 内未使用、被替代、实验遗留和过时未删除的代码；清理以减法为主，不借此扩展业务职责或增加新的框架体系。
- 上述条件不表示验收已经完成。内部测试、历史交付签署或名称中的 semantic 均不能代替项目所有者此次验收事实。
- 验收后的目标不包含长期维护 Legacy 兼容包、旧入口回退或新旧双轨。已有明确验收后，不为同一退出决定追加重复审批。

### 清理方法与边界

- 从保留的 Semantic 入口追踪提交、观察、调用、投影和关闭依赖，按剩余职责判断去留；不能仅凭目录名或 legacy、experimental、shadow 等字符串批量删除。
- 属于已验收 Semantic 能力的实验实现应收敛为正式入口；没有保留职责的实验实现及其专属包装应删除；有真实需求且属于应用或宿主的能力才外移，不建立“以后可能有用”的代码保存区。
- 下线时同步处理实现、公共导出、类型、配置、仅为双轨比较存在的机制、构建产物、示例和当前使用文档。协议身份、来源检查和必要能力校验不因去掉实验标签而自动删除。
- 只验证已退出接口或实现的测试可以删除；仍证明 Semantic 契约的测试应保留或迁移。不得通过弱化现存契约测试掩盖清理回归，也不要求已明确删除的旧 API 继续通过兼容测试。
- 当前主链共用的身份、来源绑定、参数合同、调用记录、容量限制和资源释放保证继续保留。删除旧包装不等于删除其底层仍被使用的能力。
- 检查导出、静态与动态入口、调用方、构建脚本和初始化/订阅副作用。公共 API 的历史兼容身份不构成永久保留理由，但仍承诺支持的 Semantic 消费方式必须得到迁移和验证。
- CODE_CLEANUP_PLAN.zh-CN.md 与 CODE_CLEANUP_COMPATIBILITY.zh-CN.md 中“保持公共接口稳定”“保留兼容项”等要求属于原清理批次；它们不限制本节约定的验收后 Breaking Change。保留历史验收事实，当前方向以本节和项目所有者最新指令为准。

## 七、2026-11-03 反馈：设计约束与当前范围

本节记录最新反馈，不表示 API 已实施。约束以项目所有者明确要求为准；具体机制、签名、包名和实施顺序仍须与建议分开。详细 TODO 统一维护在 `deepseek_review.md` 的“2026-11-03 最新反馈收敛”，不另建平行任务清单。

### 已确认的设计方向

- **Ref 与 ArrayRef 是核心数据概念。** 它们发布与快照相关的具名数据；Tool 使用它们作为参数，不因此产生独立工具类别。保留并贯通数组整体、数组元素的发布与消费，删除 `useViewSnapshotTool` 的独立包装方向不变。
- **ViewType 与页面类别必须明确。** 不把实例 ID 默认当作类型；`instruction` / `state` 由明确元数据表达，不扫描正文或 DOM 后代来猜测。
- **先约束，后 API。** 工具所属类型、名称、说明、参数合同只手写一份；注册、类型推导、参数校验和工具目录复用它。静态说明与动态可用性分开，ToolUI 位置不授予权限；具体声明/批量 API 尚未定稿。
- **Preact 是适配实现，不是应用规范。** 强内核的语义不依赖 Preact、DOM 或某个具体 Agent Driver；普通 TypeScript 与 Preact 应共享提交、观察、调用和清理合同，不另造第二个内核。
- **先做好串行。** 当前只设计、验证串行 Tool Call 主路径；不扩展并发执行、并发观测或通用调度器。
- **新观测替换旧观测。** Agent 使用过旧快照并采用新快照后，旧快照的调用/Ref 解析资格应立即失效，相关旧数据的框架持有引用应释放；不能只从 Messages 隐藏旧页面却继续开放旧 Ref。
- **只包装一次。** View 元数据与正文分开，正文不携带框架外层 envelope；由唯一呈现边界完成正确包装，不用正则猜测并拆除正文中的 `<view>`。
- **按 App 隔离投影错误。** 单 App 声明、命名或投影错误不能默认拖垮其他健康 App；不静默丢掉错误，也不伪造正常快照。

### 执行边界的建议细化，尚非已批准实现

- 对“观测前先刷新”的建议：串行调用完成后，在观测入口等待已提交的投影更新，再捕获一致快照。没有变化可以复用已确认的快照；不能以任意延迟冒充提交完成。
- 刷新指应用已经提交的 View / Ref / Tool 状态，不要求 Runtime 重读磁盘、轮询外部业务数据或等待尚未完成的后台任务。业务已成功但投影失败时，报告观察失败，不重做业务操作。
- 建议将“Agent 采用新快照”落实为同一串行消费会话成功切换当前 Observation；不推断模型心理状态，不增加模型“已读 ACK”。后台发布和诊断预览不应擅自替换该会话的当前观测。
- 建议区分调用资格撤销与引用释放：旧观测专属引用立即清理；新快照仍使用的共享数据和 App 自有业务状态不删除。不能只释放 lease 却无理由继续保留旧 Ref payload，也不承诺强制 JavaScript GC 或即时 RSS 下降。
- Ref 的旧观测失效规则不能替代注册所有权校验：同一快照准备期间，不同发布者重名和旧 cleanup 误删仍需解决；不把这类框架问题交给应用兜底。

### 范围与治理

- 有界资源的额度、预算、配额与回收策略重设计暂缓；不据此删除现有保护。旧观测/Ref 的生命周期合同仍需明确，不借此启动通用资源管理项目。
- name / id 的全链路职责与唯一来源单列专项 TODO；不是全仓机械改名，具体规则与排期未定。
- 错误/诊断治理与重复转换/性能梳理记录为低优先级 TODO，不与当前语义收敛混做。
- 文档明确区分产品约束、当前实现、已确认目标、待确认方案和历史证据。协议清单、兼容矩阵、正式包消费者测试与 Breaking Change 迁移规则分别列 TODO；不默认批准多包拆分或长期新旧双轨。
- 后续改动先说明维护哪条约束、谁拥有状态与资源、如何验证；应用业务权限、文件冲突、外部任务和自动摘要不进入内核。

## 八、2026-11-06 反馈：Ref 免除模型抄写业务 ID

项目所有者明确：Planning 无须展示 `plan_id`；引入 Ref 的目的包括让大模型免于自己输入各种业务 ID。以下是已确认的产品约束，不表示当前应用已经完整迁移。

- 对已经通过 Ref 呈现的业务对象，View 提供可理解的对象描述及完整 Ref 名；Tool 通过 Ref 选择对象，不再要求模型另行抄写 `plan_id`、`phase_id`、`task_id` 等内部定位 ID。
- 业务 ID 可以保留在 App 自有状态、持久化数据及 Ref payload 中。Runtime 从调用绑定的 Observation 解析 Ref，handler 接收该对象；App 自行使用内部 ID，并校验对象是否仍存在、父子归属、当前状态及业务权限。Ref 不替代这些检查。
- 页面呈现、Tool 参数合同、Root 使用说明和错误恢复提示必须同步迁移。不能仅隐藏 ID，却继续要求模型在调用时提供 ID；也不能把内部 ID 改名为 `ref` 就宣称完成了 Ref 解析。
- 此约束不取消有独立业务意义的普通参数，例如文件路径、标题、编辑内容或金额；不要求把所有字符串包装为 Ref，也不把 Ref 名变成永久业务身份。
- 当前 B25 隔离试件只验证了 `open_plan` 的单个必填 Plan Ref，其他 Planning 工具仍使用业务 ID。其历史限定验收保留，但不能把该试件当作完整满足本节的应用。后续实现及验收统一跟踪 `deepseek_review.md` 的 SRT-02，不扩展 SDK/Runtime 的业务职责。

## 九、2026-11-08 反馈：工具定义只进入 Tools，删除 Mutating 分类

项目所有者在 Clean 聊天中的原始反馈已由 SRT Owner 核对。以下是已确认的产品约束；实施和验收状态另记，不因写入本文就宣称当前根目录已经满足。

- 不需要 `isMutating`／`Mutating` 工具分类。删除对应声明与实际合同，不以只隐藏页面标签代替删除。
- 工具完整定义、说明和参数 Schema 通过上下文专属的 Tools 数组提供，不在 Root 或各类型 View 中重复写入完整定义与输入输出结构。
- Root 按 ViewType 简要列举工具名称，保留必要的应用流程和页面说明。Planning 的 PlanList／PlanDetail 数据 View 呈现业务状态与 Ref，不重复列举 Tools。

据此执行时，同一份 Tool 声明仍是类型、注册、参数校验和工具目录的来源，不为简化正文新增一份手写定义或工具表。去掉分类不取消既有 Scope 授权、参数只读、Ref 绑定与失效、调用防重、结果 effects／partial／unknown 语义及清理责任；这些是独立合同，不得随字段删除一并弱化。

**2026-11-12 更新：** 上段保留当时的合同背景，其中要求保留 `effects` 的部分已由项目所有者的新决定覆盖：删除 `effects` 及其同义框架分类。当时方向见第十五节及旧版 `docs/sdk-runtime-design/01-concept-design.md` 的 C04；旧主文档当前不可读取，不能将这项历史引用与本轮重新建档后的 C04 页面操作议题混同；不表示当时代码已完成迁移，必要的调用、防重与清理责任不因此消失。

本轮由 Clean 在独占副本连续完成实现、消费者／文档迁移与必要验证，再由 Owner 集中验收及采用。2026-11-08 已完成本轮工程验收并采用到实际根目录；原有历史验收事实保留，最终 Semantic 人工验收另记。交付与证据跟踪在 `deepseek_review.md` 的唯一索引。

## 十、2026-11-08 反馈：View 内局部 Ref，调用时指定 View

项目所有者确认当前先解决 Ref 的 View 定位。以下为本轮目标，实施状态以 `deepseek_review.md` 的 SRT-09 为准。

- View 的 XML 外层已经包含 view_id，正文中的 Ref 保留类型提示和局部名称，例如 `[设计阶段](Phase:completed_phases[0])`；不逐项重复 `plan_b.`。整数组继续展示类型提示，例如 `Phase[]:completed_phases`。
- Tool 的 Ref 参数使用 `view_id.ref_id`，例如 `plan_b.completed_phases[0]`；调用地址不带 `Phase:` 类型前缀。模型使用所在 View 的 id 与局部数据引用组成输入；应用说明清楚讲解一次即可，不在页面重复完整 Tool Schema。
- AOTUI Desktop 的实际函数调用 prompt 必须同步解释展示标记与调用地址的转换，并同步相关 App 提示。复用现有共用指令来源；只有显式 Ref 参数使用该格式，普通路径、文本及 JSON 仍按各自 Schema。
- 展示标记负责表达类型与局部引用，调用地址负责指定 View 和数据。Ref 在 View 内命名；两个同类型 View 可以分别发布同名数组和元素，调用必须明确选中所属 View。业务类型仍由 Ref 元数据及参数合同校验。
- 2026-11-16 项目所有者确认新版调用支持同一个 App 运行实例的原 Observation 内跨 View 传递显式 Ref。顶层 `view_id` 选执行页面，Ref 地址的前缀选数据来源页。两者分别校验，业务适用性仍由 App 判断。
- 第八节所说的完整 Ref，在本轮目标中由 View 外层 id 与正文局部 Ref 共同表达。模型仍不需要业务 ID；Runtime 保留现有 App、Observation、快照及 View 实例绑定、失效与释放合同，App 继续负责业务校验。
- `view_id.completed_phases[0].field` 字段访问、View 私有／App 公用／全局公用的数据作用域及基础数据类型体系均为未来 TODO。本轮不实现这些能力，不预建表达式语言或作用域框架。

该限定项已于2026-11-08由Clean整项交付、Owner集中验收并采用到实际根目录，Desktop调用prompt同步更新；已有人工签收事实保留，字段访问、数据作用域和基础类型体系仍为未来TODO。


## 十一、2026-11-09 反馈：按开发线承担一次负责人复核

项目所有者明确要求减少重复负责人审查，并再次强调不要过度防御：

- Clean 开发的任务，由 SRT Owner 直接复核、采用和交付，不再转交 MC Owner 追加复核。
- Minimal Core 执行 Agent 开发的任务，由 MC Owner 复核；SRT Owner 接收结论、协调采用和维护总进度，不再做第二轮代码审查。
- 整项交付后集中复核一次。仅针对实际改动及其影响做必要验证，已有有效检查直接复用；不为假设风险层层加门禁、重复跑矩阵或扩大证据整理。
- 当前 SRT-06 工具链任务按上述分工调整；历史已完成的签收记录保留事实。

### 持续推进方式（2026-11-09 项目所有者再次明确）

项目所有者明确要求先交给执行Agent一个完整大任务，做完后集中验收，并要求“不要等待聊天，现在就开始这样工作，记下来”。以下方式立即执行，各开发线仍按本节既定归属承担一次负责人复核。

- 负责人先下发目标、范围、交付物和准出条件明确的完整任务；执行 Agent 连续完成分析、开发、消费者与文档迁移、自测、常规修复和报告，整项交付后再由对应负责人集中验收。不把逐文件或逐小点 review 变成继续开发的前置条件，不交一份计划就停下。
- 已授权工作立即推进，不等待追加聊天确认或项目所有者反复催促。中途的解释、进度问答和协调消息处理后，继续当前任务；只有明确取消、暂停或不兼容的新指令才改变这一点。
- 负责人只在真实阻塞、文件写入冲突或需要所有者决定的重大范围变化时介入；其余工作继续。无交集的任务可并行，有交集只协调对应文件，不让整条开发线等待。
- 收到完整交付后直接集中审查实际差异与必要证据，真实问题和必要修订一次汇总；复用已有有效测试，不追加假设风险门禁。通过后继续完成已授权的采用和必要验证。进度沟通集中于实质进展、阻塞和交付结论，不用细碎协调替代执行。
- SRT-01～SRT-15整份清单由Clean Owner（文档中的SRT Owner）负责总体交付；Minimal Core由MC Owner按本线原计划及明确承接的任务推进。项目所有者再次指出两位Owner承担不同工作，不能把SRT整体分配或完成结论当成MC本线的分工或完成依据。关联任务可以引用另一开发线已验收结果，注明归属，不重复审查。小批次完成不等于本线原计划整体完成；用户明确取消、暂缓或未来再做的事项保持原决定。
- 执行 Agent 整项完成后主动汇报。负责人不轮询执行者聊天，也不调用聊天等待工具守候进度；收到主动提交的完整交付后再集中验收。项目所有者已完成的跨 Owner 同步不重复发送。

## 十二、2026-11-09 反馈：验收后继续做减法

项目所有者在SRT-01～SRT-15交付后明确要求清理旧／废弃代码，并要求“可删可不删的代码我们都删除了”，以构建强大、稳定、简洁的内核。

- 没有当前独立职责的实现、兼容分支、重复状态、转发包装和预留抽象，默认删除；不以历史存在或以后可能有用为保留理由。
- 从受支持入口和真实消费者追踪去留，同步实现、导出、配置、分发、测试及当前文档。已有明确验收不追加重复审批。
- 保留仍承担一致性、身份／Ref绑定、执行校验、失败反馈及资源释放的机制；重复职责收敛到既有所有者，不新造替代框架或将责任转给应用。
- 代码继续交Clean整项实施、SRT Owner集中验收；MC当前独占尾项仍由该线完成和复核。该反馈不是宣称新一轮清理已经完成。

## 十三、2026-11-11 反馈：SDK / Runtime 设计 SSOT 与最小内核

项目所有者要求按讨论层次维护本机设计文档。统一入口为 `docs/sdk-runtime-design/README.md`。旧章节中的评审文件、任务索引和验收记录保留历史意义。

### 已确认方向

- 目标是找到根因，用正确、简单的方式解决；非必要不新增实体或概念，过去的冗余抽象也可以删除。
- App 规范独立于 Preact / DOM；普通 TypeScript 与 Preact 共享内核语义。
- Ref 所指业务值尽量复用 OpenAI / DeepSeek Tool Call 的 JSON 数据体系；若 TypeBox 覆盖目标 schema，则保留 TypeBox，不另造 schema DSL。provider 的具体 strict 能力仍需以官方资料及兼容证据为准。
- 静态定义、实例、观察与调用资格应整理成长期稳定的最小关系，不用多套名称表达同一职责。
- 默认 App 实例采用新的 Worker 执行环境。
- 当前一个 Agent 独占自己启动的 App 实例；同一 App 代码可创建多个独立实例，暂不设计多 Agent 共用同一实例。
- Host 联系可以参考 MCP，资源生命周期学习成熟设计；不因此默认引入 MCP Server、通用会话或恢复系统。
- Ref 原地更新问题先核实真实根因；view_id / ref_id 明确禁止点号 `.`，该限制不扩展到普通业务路径和文本。
- 上限统一考虑 LLM 上下文长度，具体 token 与资源保护边界在设计文档中说明。
- 重新判断 Scope 是否必要；移除或内收具体接口属于设计建议，不因记录该问题就宣称已经完成。

### 最新讨论方向：View 只读 Ref 与 Agent 自建 var / val

2026-11-11，项目所有者进一步澄清：View 暴露的 Ref 默认都是对 Agent 只读的 val；在明确约束、协议与接口前，不开放通用赋值或删除。App 仍可通过自己的合法操作或后台更新发布新值；只读不等于业务数据永久不变。Ref 应支持字段读取，Agent 可以另外创建自己的 var / val，并在上下文专门区域呈现，数据类型尽量对齐 Tool JSON 值域并做严格验证。

项目所有者最新明确：Ref 的展示和使用保持现状，即 `[label](type:ref_id)` 与显式 Ref 参数中的 `view_id.ref_id`；未来是否统一取值写法仍可研究，不提前迁移。Agent 自建常量 / 变量的关键字、`Type name` 或 `name: Type` 展示、`$name` 取值都不是固定要求，允许参考成熟语言后给出建议。

当前建议借用 TypeScript 的 const / let 展示，优先研究在既有显式 Ref 参数入口增加 Agent 变量来源；显示文本不构成可执行语言。上轮 literal / ref 结构与 JSON Pointer 的总体首选下调为候选，不能因此要求改造现有 Ref 展示与调用。归属、JSON / TypeBox、读取时刻与写入合同统一维护在 docs/sdk-runtime-design/02-sdk-types-and-refs.md 和 04-observation-and-invocation.md；这些方案未冻结或实现，也不开放任意对话历史 CRUD。

项目所有者已明确：这些后续能力不必先实现，只要求 P0 设计考虑演进。P0 继续聚焦统一发布和 Ref 更新一致性；变量存储、字段读写、释放语义与引用协议的完整设计及实现都不是前置条件或验收门槛，不提前添加占位 API、可变性字段或新的管理实体。

### 技术方案与 Codex 交接（2026-11-11）

项目所有者要求技术负责人提供详细技术方案、可行性分析、影响面评估、开发计划与可转交 Codex 的 Prompt，可设置里程碑。完整计划维护在 docs/sdk-runtime-design/07-delivery-plan.md，首批 P0 Prompt 在 08-codex-p0-prompt.md；事实与验收继续记录在 06。

首批执行包聚焦统一成功发布、Ref 更新一致性及必要消费者迁移。M0—M4 是自检点，通过后自主继续，整项集中交付；不将每个节点变成人工审批，也不把后续生命周期、完整公共 SDK 或变量语法默认塞入 P0。本次对话只完成文档交接，不宣称已实施代码。

### 文档与实施事实

- 文档分别记录已确认方向、建议方案、当前事实和待核实项；不将新方案写成已实现或已验收能力。
- 新讨论更新对应主文档，索引只维护跨主题关系。源代码实施后的验证和完成事实统一更新在该目录的实施依据文档。
- 保留仍承担一致性、Ref 绑定、真实在途执行、未知副作用防重及资源所有权的必要机制；删除公开包装不能删除其真实责任，也不新增换名后的平行实体。

## 十四、2026-11-11 反馈：本轮技术负责人交接给 Codex

项目所有者明确要求将本次 SDK / Runtime 优化升级的负责人职责交给 Codex，使其能持续、高质量地完成整项工作。交接合同在本机 `docs/sdk-runtime-design/11-codex-owner-handoff.md`。P0 至 P3 的阶段工程验收保留。收尾修订与当前证据在本机设计索引中记录。

- Codex 负责本轮技术决策、任务拆解、实现或分派、直接消费者迁移、验证、问题修复、集中复核、阶段验收与 SSOT 维护。P0/P1 既有验收继续有效，当前工作区为实际起点。
- 后续按 07/11 的既定路线推进 P2a、P2b、P3。阶段通过后自主制定下一批完整任务并继续，不等待 ChatGPT 再发 Prompt 或追加前任负责人复核。
- 既有执行合同中的“负责人集中验收”由接任的 Codex 组织；记录为 Codex 技术负责人验收，不冒充项目所有者本人已完成人工验收。实现与复核可使用不同子 Agent 视角，但不增加多级 Owner 或重复门禁。
- 产品目标、重大范围变化与未授权对外操作仍由项目所有者决定。普通技术取舍、必要 Breaking Change、消费者迁移和常规修复自主完成；真实阻塞只暂停受影响工作。
- 本次核心工程边界与独立变量/字段协议里程碑按 11 明确执行，既不遗漏后续目标，也不因长期 Infra 定位无限扩张范围。
- 此交接仅覆盖本次 SDK / Runtime 优化及直接消费者。前述 SRT/Clean/MC 分工和签收保留历史事实；本节更新本轮后续工作的负责人路由，不接管其他独立项目，不要求重复既有验收。
- 唯一设计与进度入口仍为 docs/sdk-runtime-design。接手、阶段切换和中断恢复均维护现有主题文档及 06/07，不建立平行总计划。


## 十五、2026-11-12 反馈：按三层维护 SDK / Runtime 讨论 SSOT

项目所有者要求将问题、关键讨论和当前决定分别写入概念设计、系统设计、代码实现文档，持续讨论并更新。统一入口仍为 [SDK / Runtime 设计索引](docs/sdk-runtime-design/README.md)，主文档为：

- [概念设计](docs/sdk-runtime-design/01-concept-design.md)：ViewType、Ref、两层公共接口、删除 effects。
- [系统设计](docs/sdk-runtime-design/02-system-design.md)：发布与观察、既有调用查询、状态所有权、现有预算口径。
- [代码实现](docs/sdk-runtime-design/03-code-implementation.md)：Preact 适配、现有 handler 绑定、Tool Schema、文档与产物合同，以及跨层改动的实施依据。

本轮十二项反馈的原始编号保留在索引中，各主题按职责归入主文档；不能把重新归类理解为项目所有者已批准尚未讨论的系统或实现方案。旧章节引用的分主题文件与验收记录保留其历史含义。本次工作树未提供的旧文件不猜测重建；本轮讨论以三份主文档为准。

### 当前决定摘要

- ViewType 需要先解释清楚。保持既有 App + ViewType、同类型 View 共享工具模型；工具身份解耦仍是未获批准的候选。
- Ref 统一解释为 View 展示数据的索引、当前观察中的只读值。展示与调用格式保持现状。TypeScript const / let 和可能的数据定义、数据结构区域属于后续议题，优先不改现有 Ref。
- 认可 App 作者与 Host 集成者两层公共接口，尽可能简化公开概念；具体 API 尚未冻结。
- **删除 effects** 是明确决定，覆盖第九节相反的旧要求；不得换名保留同一框架分类。最小失败与未知结果表达已由后续第十六节的 B01 细化，本次未修改实现。
- 发布与收据查询的具体机制尚未批准。要求方案简单、正确，不由认可目标推导新增结果类型、查询签名或管理实体。
- 认可每种真实状态只有一个所有者、每条状态转换只有一处权威判断。预算先统一已有定义、单位、来源、默认值与边界行为，不建设复杂预算系统。
- Preact 是实现适配。第 10 项保持当前全量发布与 handler 绑定方式，本轮不实施初始化仅绑定一次等替代方案。
- Tool 参数体系对齐 OpenAI / DeepSeek，可采用更严格的接受范围；具体 Provider 版本与兼容细节待核实。文档、模型指令、公共合同与可消费产物应一致。

### 同日补充：例子、方案比较与整体一致性

项目所有者要求每个议题先用具体例子深入浅出地讲清问题，再基于长期主义和 Minimalist 比较多个方案的优劣。文档按“具体例子、问题与证据边界、方案比较、当前建议、责任与最小验证”展开；比较必须说明真实收益、长期代价及适用条件，推荐不等于批准实施。

共同目标、约束、判断准则及方案之间的关系统一维护在设计索引。所有建议继续服务 Agent 使用 App、Agent 开发 App 与通用 Infra 的目标，保持 View / Tool / Ref、最新投影和应用职责边界。Minimalist 以完整路径的正确性、单一所有者和总复杂度判断，不通过省略必要事实或把内核责任转给应用制造表面简洁。明确保持的 Ref 格式和 handler 绑定不因方案比较自动重开。

### 更新与实施状态

三份主文档分别维护问题、事实、用户反馈、当前决定、候选方案和实施状态；同一议题只有一个权威记录，其余文档引用。新决定应注明覆盖关系，“未理解”“认可方向”“保持现状”不得被改写为具体实现已获批准。

本轮只建立和更新文档，没有启动候选代码改造、测试或发布。以后实施时再补充实际版本、修改与必要验证，不把建档视为已完成代码迁移，也不据此否定其他独立工作的历史授权与验收。


## 十六、2026-11-12 反馈：分批技术方案与 B01 执行交接

项目所有者要求由技术负责人分批给出详细技术方案、可行性、影响面、开发计划和可转交 Codex 的 Prompt，并设置里程碑检查点。本轮已形成新 B01 交接，入口如下：

- [07 分批技术方案与开发计划](docs/sdk-runtime-design/07-delivery-plan.md)：当前详细技术合同、影响与连续准出条件；B02–B04 的后续方向。
- [08 B01 Codex 执行 Prompt](docs/sdk-runtime-design/08-codex-b01-prompt.md)：本次单批执行指令。
- [06 实施事实与交付记录](docs/sdk-runtime-design/06-implementation-evidence.md)：实际基线、后续修改、命令、产物及验证结果。

本轮 B01 与第十三、十四节的历史 P0–P3 分开；旧验收保留历史事实，不视为本批已经完成。本次 Prompt 只实施 B01，完成后整批交付，不自动推进尚未下发的 B02–B04。三层主文档仍拥有各自议题；07 拥有批次任务，06 记录实际证据，不建立平行总计划。

### B01 已选范围与执行方式

- 完整删除 Tool 公共结果及调用链的 effects / failureEffects 分类，迁移 SDK、Runtime 与必要的 Adapter / IDE / SQLite 直接消费边界。具体最小结果、真实异常出口及局部 ABI / IPC 合同以 07 为准；不恢复更名后的分类，不扩大成统一结果框架。
- 保留 App 自有业务恢复事实与独立资源合同。不能以全仓 effects 零命中为完成标准，也不能因同名保留项漏掉 Tool 边界的旧分类。
- Ref 展示与调用格式、App + ViewType、完整 publish({views,bindings})、AppTools、handler 生命周期与闭包更新继续保持；不借本批重写 Preact、添加预算系统或业务自动重试。
- M0–M4 是 Codex 连续自检点，通过后自动继续，不逐项等待确认。常规实现选择、消费者迁移和必要修复在本批完成；真实阻塞只暂停受影响部分，其他可完成工作继续。最后一次整批交付差异、验证证据、Breaking Change 和剩余限制。
- 保留现有工作树修改。若建立隔离 worktree，确保本批依赖的 ignored SSOT 随工作可访问。先重建配套 Runtime / SDK，再验证实际消费者；不把旧 dist、同版本旧 tar 或历史通过当成本批证明。

本轮实际完成的是针对性只读核对和文档交接；尚未修改 SDK / Runtime 源码、执行构建测试或发布。Codex 实施时按实际起点更新 06，未执行或被阻塞的验证如实记录，不冒充项目所有者人工验收。第十五节此前关于最小结果仍待讨论的状态，由本节 B01 细化覆盖；其余未下发设计继续保持原讨论边界。

## 十七、2026-11-13 反馈：B01 完成后的 B02 技术交接

项目所有者转交 B01 工程完成与负责人验收报告，要求继续提供 B02 的详细技术方案、可行性、影响面、开发计划和 Codex Prompt。已读取实际 B01 证据，并对相关源码做只读核对；B01 的验收与已知限制保留，B02 尚未实施或验证。

### 当前权威入口

- [09 B02 详细技术方案](docs/sdk-runtime-design/09-b02-technical-plan.md)：本批精确合同、选项取舍、源码依据、迁移范围、验证和 M0–M4。
- [10 B02 Codex Prompt](docs/sdk-runtime-design/10-codex-b02-prompt.md)：当前可直接转交的连续实施指令。
- [06 实施事实与交付记录](docs/sdk-runtime-design/06-implementation-evidence.md)：B01 已有证据及 B02 独立实施记录。
- [07 分批路线](docs/sdk-runtime-design/07-delivery-plan.md)：总体 B01–B04 路线和 B01 历史详细方案；三层主文档仍拥有对应设计议题。

当前执行 B02，08 是已完成 B01 的历史 Prompt。第十五节及早期候选中“仅调用 ID 查询”“Host 再加统一 Session”等建议不覆盖 09 的当前决定；没有下发的 B03 / B04 不自动执行。

### B02 选定范围与保持条件

1. `readReceipt` 改为严格两字段 `ReceiptQuery { observationId, invocationId }`，去掉查询中的 binding 和 input。旧观察的过期记录可忘记，新观察可复用 invocationId，故不能只按 invocationId 查询。复用原 Entry metadata、admitRead / read / permitted、策略、TTL、防重和真实在途持有；定位字段不恢复旧观察资格。旧完整请求运行时拒绝，不设兼容重载或静默裁剪。
2. `createObservationOperations` 已绑定唯一 state，返回方法不再重复接收它；原 state、隔离、鉴别、取消 reservation、计量和 lease 释放保持。删除没有独立行为的 `sweepExpired` 别名，保留 inspect 与自动到期处理。不合并不同真实生命周期，不新增状态所有者。
3. SDK 作者 API 保持。Runtime 根从既有 Core 定义显式 type-only 重导出 09 指定的 15 个 Host 类型；纯 Core 入口继续支持。完整 Host 示例移动到 Runtime 既有指南，SDK 保留作者内容并链接过去，实际包教程抽取与类型消费同步迁移。
4. Source 和 preview 继续使用 desktop + kernel。Kernel 在全局与单 Desktop 关闭时有更早的准入撤回；本批不为了减参增加 isOwnerActive / 父级 gate、不改 Source options 严格度、不重排 Kernel / Manager / Desktop 关闭链。
5. Ref 两种格式、App + ViewType、完整 publish({views,bindings})、AppTools、enabled 与最新闭包、单 Agent 串行合同继续保持。Preact 仅记录真实维护依赖，不重写 renderer 或改版本。B01 的结果语义、Tool IPC v5、ordinary-invoker/v3 和纯 Core ordinary-v2 保持，不恢复 effects 的同义分类。

### 执行与证据

B01 完成内容仍包含在当前 dirty 工作树和新增未跟踪 fixture 中，不能以裸 HEAD 作为 B02 起点。保留已有差异、试件和 ignored SSOT；隔离 worktree 必须带入它们。B01 的 tar、日志、补丁和历史 AGENTS 哈希保留，B02 使用独立证据目录并记录自己的实际基线。

M0–M4 是连续自检点，通过后自动继续，最后整批集中复核和交付；不逐个 API、文件或里程碑请求确认。按实际依赖重建并消费配套产物，关键回归与已知限制分开记录。B01 的 17 项原有失败、IDE LSP 关闭问题和未验证的第三方干净安装不要求先全部修复，也不能豁免本批新回归。

本次交接只更新文档和根指导，没有修改生产源码、构建、测试、发布或部署。后续实际结果写入 06 的 B02 部分，不能将方案完成或 B01 验收写成 B02 已通过。

## 十八、2026-11-13 反馈：B02 完成后的 B03 技术交接

项目所有者转交 B02 工程完成与负责人验收报告，要求技术负责人继续提供 B03 的详细技术方案、可行性、影响、开发计划和可直接转交 Codex 的 Prompt。已读取对应证据并针对当前源码做只读核对；本次只更新文档与根指导，B03 尚未实施、构建、测试或调用模型。

### 当前权威入口

- [11 B03 详细技术方案](docs/sdk-runtime-design/11-b03-technical-plan.md)：本批具体合同、方案取舍、影响、验证和 M0–M4。
- [12 B03 Codex Prompt](docs/sdk-runtime-design/12-codex-b03-prompt.md)：本批连续实施指令。
- [06 实施事实与交付记录](docs/sdk-runtime-design/06-implementation-evidence.md#b03)：B01 / B02 历史证据与 B03 的实施、验证和复核状态。
- [07 分批路线](docs/sdk-runtime-design/07-delivery-plan.md#current-b03)：总体路线；三层主文档仍拥有各自议题。

第十六、十七节及 08–10 保留历史；其中“当前执行 B01 / B02”和当时未实施、未清理的状态不再作为本批当前任务。当前仅下发 B03，完成后不自动实施 B04，不发布或部署。

### B03 选定范围

1. Snapshot Core 创建时一次捕获自己的 limits，不再每次提交重读调用方可变对象。保留公开 Partial 入口，验证九字段并保存独立冻结的完整配置；不冻结调用方对象。缺省或 undefined 使用默认值，0 合法，给定数值须是安全整数且不超过对应默认值。将默认值作为只能下调的硬上限是本批新的 Breaking Change，不能冒充已有合同。拒绝 getter / 非数据属性而不执行它们；仅处理 limits，不扩张为所有 options 的捕获框架。
2. Schema 保留已有递归白名单、Ref 解析校验及分层复制 guard。完整含内部 marker 的 normalized Tool profile 统一使用现有 64 KiB canonical JSON UTF-8 上限，在原生成 / 消费路径检查，SDK 静态定义复用 Core 提前预检。新增声明 CAPACITY 分支，与 INVALID / UNSUPPORTED 区分；只映射真实容量失败。内部 copier 使用不可从 Core 公共入口导出的明确错误身份，不猜 message，不改变普通参数输入和业务错误合同。TypeBox 只修已定位的重复计量，并先验证全部 descriptor，再过滤输出；保守 guard 不宣称是精确最终 JSON。
3. SDK View ID 删除独立的 2–15 长度要求，保留非空 ASCII 字母、数字、下划线子集，两种 SDK Producer 入口使用同一规则。Core 更宽的身份合同保持，不新增 64 / 128 / 256 等身份阈值。Ref 两种格式不变。外部 Tool 别名不包含 View ID，生产校验仍由 Source 执行；只修正 Host 指南中 AppKernel 先校验的错误陈述，不改变别名生成和回路由算法。

九字段精确数值、计量对象、已有不同预算、完整错误映射、路径及验证条件以 11 为准。本批不增加 Schema 词汇，不启用 Provider strict，不改 optional / null / default 语义，不联网或调用真实模型来冒充 Provider 兼容验证；本地转换证据与最新云端接受性分开。

### 保留合同与实施证据

保持 B01 结果语义与 Tool IPC v5、ordinary-invoker/v3、Core ordinary-v2；保持 B02 两字段收据查询、实例绑定操作、Host 类型 / 教程归位及 Source / preview 的 Desktop + Kernel 关闭准入。App + ViewType、完整 publish({views,bindings})、AppTools、enabled 与最新 handler 闭包、单 Agent 串行、Preact 适配与 Ref 格式继续保持。业务状态、权限、外部写入和恢复仍由应用或真实资源适配器负责；不建设变量引擎、CLI、通用预算系统、统一会话或自动业务补偿。

当前基线包含 B01 / B02 的 dirty 修改、未跟踪旧 SDK 试件、另行授权的 Runtime 测试清理与 ignored SSOT。不得 reset / clean 或从裸 HEAD 丢失这些前提；隔离 worktree 必须带入实际起点。原 17 项失败是历史证据，2006 项全量通过属于 B02 开工前，B02 最终执行的是定向验证；IDE 综合 LSP 关闭与第三方干净安装仍按实际验证边界记录。B03 记录自己的独立差异、实际产物身份和验证，不能套用历史通过数。

M0–M4 是连续自检点，通过后自动继续，不逐个文件或里程碑请求确认；常规实现与直接消费者迁移属于本批。可以分派子 Agent，负责人统一合同并在整批完成后集中复核一次。真实阻塞只暂停受影响部分，其余工作继续；最后交付真实修改、验证、Breaking Change 与限制。后续实现事实统一更新 06，不把本次技术交接写作 B03 已验收。

## 十九、2026-11-13 反馈：B03 完成后的 B04 技术交接

项目所有者转交 B03 工程完成与负责人验收报告，随后下发 B04。B04 已完成 M0–M4 并通过本批工程验收。交付包括四份本地 tar、两次独立构建的比对结果、两套消费者的首次安装及同锁重装，以及随包原教程的执行报告。实际工具链、命令与验收范围见 [06 B04](docs/sdk-runtime-design/06-implementation-evidence.md#b04-review)。

### 当前权威入口

- [13 B04 详细技术方案](docs/sdk-runtime-design/13-b04-technical-plan.md)：确定版本与依赖合同、重建 / 重装、文档范围、影响和准出条件。
- [14 B04 Codex Prompt](docs/sdk-runtime-design/14-codex-b04-prompt.md)：本批 M0–M4 的原始实施指令。
- [06 B04 事实记录](docs/sdk-runtime-design/06-implementation-evidence.md#b04)：实际执行、产物、验证和验收状态。
- [07 总体路线](docs/sdk-runtime-design/07-delivery-plan.md#current-b04)：当前 B04 与前三批历史关系。三层主文档继续拥有各自议题。

第十六至十八节和 08–12 是前三批历史交接，其中“当前执行 B01 / B02 / B03”及当时尚未实施的表述不再作为当前任务。当前只下发 B04，不自动生成新的 B05 或启动其他长期议题。

### B04 已选合同

1. 冻结本地交付版本 Runtime 7.0.0、SDK 0.8.0、Adapter 0.4.0、Driver 0.3.1。SDK 的 Runtime dependency、Adapter 的 Runtime / Driver peers 精确匹配这组版本；Adapter Driver peer 收紧需记录。包版本、已有内部 ABI、tar 哈希分责，不新增运行时 SemVer gate 或兼容协商。目标版本未查询 registry，不宣称已发布或外部可用。
2. Driver 正式 dependencies 补 @types/json-schema 7.0.15，dev Zod 与 lock 对齐精确 3.25.76；完整 Host 验证图保持 ai 6.0.326、provider-utils 4.0.65 及已有公开声明补丁。正常更新必要锁文件及直接版本消费者，不顺带升级其他 Provider、不重建全仓 workspace。严格类型不能靠 paths / shim / skipLibCheck 救场。
3. Driver 补丁仍由消费者显式声明：从本次 Driver tar 取公开 patch，在首次安装前写入消费者自身配置，由 pnpm 正常应用。依赖包自己的配置不视为自动传递；不加 postinstall，不改 Driver 公共类型来隐藏上游问题。普通 SDK 作者不承担可选 Driver 的依赖图。
4. 用一个有限交付 runner 串联现有构建、pack、pnpm 和消费者验证。两次隔离构建都来自同一实际 dirty 源码 / lock / patch，不复制旧 dist 或 node_modules，四包都重建。比较全量包 payload，分别记录原始 tar 哈希；同平台内容复现不等于跨平台或 tar 封装字节保证，不自造打包器。
5. 两种独立消费者：A 是无 Preact / Adapter / Driver / AI 的普通 TS 作者与中立 Host，B 是 Preact 与完整 Source Host。各自正常安装最终 tar，再在第二空目录用同一 lock 重装并验证。包管理器正常缓存和内部链接允许；手工工作树链接、源码路径注入与原 node_modules 借用不构成干净安装。依赖获取可使用已配置 registry 或完整缓存，不搜索最新版本；真实阻塞如实记录。
6. 复用 W10、verify-docs 与 runtime-lifecycle 原行为断言。verify-docs 增加有限 plain profile，runtime-lifecycle 提供已安装 consumer 模式；默认快速测试保留原 completeCleanInstall:false，不能混写发行证据。Source 原教程修正旧 Ref，并真实运行安装包中摘出的原文；当前 transient installAll 已等待 INIT / OPEN，不重复 openApp，按目标 Tool 可观察条件有界取得并采用 Context。

精确版本表、依赖关系、脚本入口、文档归属和验证条件由 13 唯一定义。当前文档沿既有 SDK 作者、Runtime Host、Driver STRICT_TYPES 归位，不新建文档平台；迁移导航链接原权威指南，历史 W09/W10 与前三批证据保持。

### 范围、保护与完成方式

B03 完成工作树还包含 B01 / B02、独立 Runtime 测试清理、未跟踪旧 SDK 试件和 ignored SSOT。不得 reset / clean 或从裸 HEAD 遗漏这些输入；任何隔离构建与工作副本都必须以本批实际内容为依据。保存前三批产物与日志，B04 使用独立证据目录，首次修改前记录自己的 AGENTS 与文件身份。

保持全部已收敛内核合同：View 最新投影、App + ViewType、Ref 两种格式、完整 publish({views,bindings})、AppTools、enabled 与最新闭包、Preact 适配、单 Agent 串行；保持 B01 结果与 IPC / invoker、B02 收据和实例绑定 / 关闭准入、B03 固定限额 / 容量诊断 / View ID。业务规则、外部写入及恢复仍由 App 或真实资源适配器承担。

M0–M4 连续自检，通过后自动继续，最终集中复核一次；常规安装、编译、消费者迁移和实际问题修复属于本批，不逐文件等待确认。真正阻塞只暂停受影响工作，其他可完成工作继续。独立安装或关键声明验证仍 blocked 时，不把 B04 整体标记为通过。

B04 止于确定的本地产物与证据。npm 发布、tag、push、部署和 B05 均未启动，本批没有调用真实 Provider、开展网络研究或检索外部记忆。IDE 综合 LSP、其他平台和项目所有者人工验收未执行。2,006 项全量属于 B02 开工前基线，B03 的通过数属于其定向验证，本次 Runtime 全量复跑和实际 tar 消费各有独立报告。[06 B04](docs/sdk-runtime-design/06-implementation-evidence.md#b04-execution)

## 二十、2026-11-13 反馈：发布前清理旧版本兼容

项目尚未正式发布，项目所有者明确要求清理只为兼容旧版本存在的概念和代码。先查受支持入口、实际消费者与职责，再删除无独立用途的分支、别名和旧产物路径。必要的 Breaking Change 同批迁移第一方代码、测试、公共声明及当前教程。现行的身份检查、调用授权、资源持有、持久化数据和真实业务规则仍由原所有者处理。

当前盘点、删除范围、外围候选的证据条件及 M0–M4 见 [15 发布前兼容清理](docs/sdk-runtime-design/15-pre-release-cleanup-plan.md)。本次明确退役 B01–B04 当时保留的纯 Core `ordinary-v2` 分支和旧参数形态，现行 Worker 协议和执行保证照常验证。按真实工作树继续，保留 B01–B04、后续用户改动及历史证据；不得以裸 HEAD 覆盖。代码、直接消费者和验证交由「项目优化 Coding」整项执行，完成主动回报，负责人集中复核一次。实施事实写入 06。

2026-11-14 继续盘点发布前遗留。项目所有者要求优先清理 SDK 和 Runtime，第一阶段只迁移两包删除所必须的第一方调用方。Host 的聊天、存储、IM/MCP 和 Driver 路由作为后续独立清理。按 [16 当前执行顺序](docs/sdk-runtime-design/16-remaining-compatibility-cleanup-plan.md#当前执行顺序) 先提交可独立复核的核心差异。实施与验证事实仍维护在 06。

2026-11-15，SDK 与 Runtime 核心批通过研发负责人本地工程验收。当前基线是已核对的共享源码与本批修订 tar，后续以各批构建产物和源码身份验证。[核心批验收与配套清单](docs/sdk-runtime-design/06-implementation-evidence.md#remaining-sdk-runtime-cleanup-acceptance-20261115)

同日已将 Host 聊天与存储、IM/MCP 和关联死代码的独立清理交由「项目优化 Coding」实施。按现有证据边界验收 Host，Driver 模型路由与 IDE 独立配置后续分批处理。[Host 实施顺序与准出](docs/sdk-runtime-design/16-remaining-compatibility-cleanup-plan.md#三host-实施顺序与准出)

Host A–C 最终 r2 通过研发负责人本地工程验收。已将 Driver 模型路由清理作为独立批下发给「项目优化 Coding」。[Host 最终验收](docs/sdk-runtime-design/06-implementation-evidence.md#host-compatibility-acceptance-20261115) · [Driver 实施顺序与准出](docs/sdk-runtime-design/16-remaining-compatibility-cleanup-plan.md#driver-model-routing-delivery)

Driver 模型路由的修订包通过研发负责人本地工程验收。IDE 启动配置清理已下发给「项目优化 Coding」。[Driver 最终验收](docs/sdk-runtime-design/06-implementation-evidence.md#driver-model-routing-acceptance-20261115) · [IDE 实施顺序](docs/sdk-runtime-design/16-remaining-compatibility-cleanup-plan.md#ide-launch-option-cleanup)

IDE 启动配置已通过本地工程验收，[16](docs/sdk-runtime-design/16-remaining-compatibility-cleanup-plan.md) 所列四批完成。IDE 综合 LSP 后代组关闭仍保留历史失败，前后包均有常规权限下的独立对照。[IDE 最终验收](docs/sdk-runtime-design/06-implementation-evidence.md#ide-launch-option-acceptance-20261115) · [四批验收汇总](docs/sdk-runtime-design/06-implementation-evidence.md#remaining-compatibility-closure-20261115)

## 二十一、2026-11-15 反馈：按四层维护 SDK / Runtime 讨论 SSOT

项目所有者要求将本轮评审的问题、关键讨论与决定，按概念设计、系统设计、模块设计、机制设计分别记录，继续边讨论边更新，直到双方与文档一致。唯一入口仍为 [SDK / Runtime 设计索引](docs/sdk-runtime-design/README.md)，当前主文档为：

- [01 概念设计](docs/sdk-runtime-design/01-concept-design.md)：C01–C04，当前投影与历史来源持有、View/Tool/对象的不同条件、按所见观察拼装输入，以及页面局部状态/方法与实例路由的作者目标及候选机制。
- [02 系统设计](docs/sdk-runtime-design/02-system-design.md)：S01–S03，Snapshot Core 所有权、发布完成层次、Runtime 未终结调用与 App 业务任务。
- [03 模块设计](docs/sdk-runtime-design/03-module-design.md)：M01–M03，两种生产者接口、Preact 兼容性与默认入口分开决策、接口稳定等级。
- [04 机制设计](docs/sdk-runtime-design/04-mechanism-design.md)：K01–K05，bindingId 减法、作者类型与展示一致性、Adapter 名称约束、预算可发现与冻结数据复用。

每项只由一份主文档维护完整决定，索引映射本轮原始 14 项及后续新增讨论的状态。当前事实、用户复现、源码/测试断言查阅和实际执行结果必须分开；方向认可不等于 API 已冻结或代码已实施。

### 本轮关键决定与未决边界

- 原第 1 项原则已确认：最新 View 的呈现规则不排斥真实 Observation/在途调用的必要来源持有；业务完成与投影完成分别表达。现有机制已经核对，作者发布反馈仍归 S02 讨论。
- 原第 3、4、6 项在首轮保持澄清状态；同日后续反馈已更新：S01 的单实例 Snapshot Core 简化方向获认可，具体 API/迁移尚未实施；C03 的隐含目标例子属于 App 可能引入的参数误用，框架没有自动 currentView；S03 优先研究直接超时错误，公开 pending 不作为必要前提。当前最新 handler、原观察 Ref 解析、串行调用和两字段收据查询合同仍作为现状记录。
- 原第 8 项必须拆开：Preact 私有 hook 的兼容性风险成立；更换 SDK 默认入口是独立产品选择，尚未决定。不得据此取消现行 Preact 默认路线。
- 原第 12 项修正前次诊断：身份分离与按 App 诊断隔离已经存在；先提前反馈 Adapter 可表示范围，同名多实例的稳定消歧按实际需求决定。
- 删除独立 Observation bindingId、改善 Ref schema/value 推导及同源展示等方向已获认可，具体迁移和 API 尚未实施；删除 bindingId 不等于删除 SDK publish 的 handler bindings。具体边界由 K01/K02 唯一定义。
- 接口稳定等级、两种 producer 边界与性能问题按主文档继续细化；不从认可诊断推导拆包、重写 renderer、修改硬上限、自动业务重试或通用任务系统。

### 本轮范围与历史关系

本次任务是建立文档、核对源码与更新当前指导，没有启动候选生产改造、测试、构建、发布或部署，也没有自动下发新的研发批次。

读取基线为 76d46300dfa561e835607e7647d3c25ed90b48c2。建档核实时，旧 docs/sdk-runtime-design 文件不可读取，四层记录沿用原目录。第十三至二十节的决定与批次完成事实保留，缺失的旧文件链接是历史定位。新的 03-module-design.md 与旧 03-code-implementation.md 分属不同记录。当前设计和升级入口以本节主索引及第二十二节专题为准，后续实现再记录实际差异与必要验证。

### 同日后续：打开即观察、业务目标与超时表达

项目所有者进一步明确已打开页面应全部进入本轮观察，确认可简化 Core 内重复职责，并追问 handler 隐含目标的责任与“超时报错即可”的方案。当前决定归属仍为 C02/C03、S01/S03、K04，不另建平行清单。

- 已打开页全量观察是产品约束；原先选择性省略已开页面的建议撤回。现有 viewIds 子集和 content hide 能力需按实际消费者收敛，不能将现状当作保留兼容 profile 的理由。工具授予范围与真实来源校验仍保留。
- 默认请求链在正式请求模型之前采用 Observation；若启用了输入预算检查，该检查先于采用。候选 Messages 已组装不等于模型已看到，页面产品状态与这些内部交接分开。
- App handler 若忽略传入的 A 而使用自己维护的 currentFile=B，属于业务实现错误；不据此要求通用上下文冻结。若 Runtime 把原 A Ref 解析成 B，则是框架必须防止的来源错误。
- 超时可以直接反馈等待错误；它不自动代表未执行或取消成功。已分发工作的内部防重、来源持有与迟到终结责任继续存在。具体错误结构待细化，不新增业务任务系统。
- 本轮延续文档讨论与源码核对，没有自动启动单实例 Core 或其他生产代码改造。

### 同日第三轮：页面数据与调用接收者仍属候选讨论

项目所有者提出 View 能否携带数据并作为 Tool 的隐性参数，及 ViewTypeTool 一对多是否有缺陷。唯一归属为 [C04](docs/sdk-runtime-design/01-concept-design.md#c04)。当前 Ref 已支持显式选来源、按原观察注入捕获值；共享操作定义本身不要求复制每实例 Tool，但代码尚无统一页面默认上下文/接收者合同。

用户的提问不等于已批准新 API。继续比较主 Ref 的 SDK 作者辅助与直接选 View 的接收者协议；若引入后者，应复用现有捕获和来源所有权，不读取最新可变页面状态来冒充原观察数据。C03 中具体 handler 的参数误用仍属 App Bug，同时可以评估 SDK 是否让常见正确写法更直接。未改变既有 App + ViewType、App 级 handler owner、最新已提交 handler 或原观察 Ref 合同，未启动生产改造。

### 同日第四轮：类型级定义与实例执行绑定分开

项目所有者明确原意：页面可以像 HTML + JavaScript 一样声明局部状态和操作；不同 FileDetailView 实例各有 count，Agent 的 toolcall 明确 view_id，对外仅保留一份同类型工具定义。这是作者目标澄清，具体语法、API、协议和生产迁移仍待设计。唯一归属仍是 [C04](docs/sdk-runtime-design/01-concept-design.md#c04)。

按此目标评估，最近已核对实现将每定义的 handler 集中到 App 级，未直接支持局部页面绑定。共享定义与实例绑定应分开；可保留一个 App 聚合协调者，但不能据此要求全部页面共用一个执行闭包。原 Observation 固定目标实例和 Ref 观察值，不冻结当前 count；函数与状态留在执行端，Runtime 不分析或序列化任意闭包。

第三轮主要讨论的“冻结页面数据注入”不能代替完整页面运行上下文；其全部来自 Snapshot 的要求仅适用于声明的观察输入。当前代码与历史验收事实保留，新目标不自动启动生产改造。本轮远程连接恢复后确认 HEAD 仍为 76d46300dfa561e835607e7647d3c25ed90b48c2、原文档身份未变，并复核关键绑定实现；本轮仅更新讨论文档，没有实施生产改造。

## 二十二、2026-11-15 反馈：高优先级 View Type SDK 独立专题

项目所有者将页面局部状态/工具绑定改动列为高优先级，要求盘清：新的 View Type SDK 与作者代码、View 改动范围、Root 元数据来源、上下文呈现，并独立建立目标、技术设计、可行性和影响文档。上下文展示以保持现有方式为设计基准。

唯一专题入口是 [View Type SDK](docs/sdk-runtime-design/view-type-sdk/README.md)，包含 01 目标、02 SDK、03 Runtime、04 Root/上下文、05 可行性、06 影响/迁移、07 决定/验证。父 C04 只保留议题路由与沿革，旧完整讨论明确归档；不要在多个目录继续维护平行技术方案。

专题建档时推荐静态 ViewType descriptor、页面实例 bindings、纯 TS 稳定 handle 和原观察实例路由。Root 名称目录、XML + Markdown User Messages 与动态原生 Tools 的呈现分工成为本轮设计基准。

建立专题时的交付是研究、源码核对和设计文档。后续现行基线复测、已确认调用合同及候选实现状态分别登记在 [专题决定与验证](docs/sdk-runtime-design/view-type-sdk/07-decisions-and-validation.md)。2026-11-16 升级前完成文档一致性复核，实际状态以专题为准。

2026-11-16 已实现上述页面实例绑定：SDK 使用 `defineViewType` 与页面 `bindings`，Runtime 按已采用的观察校验显式 `view_id` 和独立的 Ref 来源。共享定义、页面打开和关闭、旧观察失效与一组原生 Tools 贯通 Preact、普通 TypeScript、Worker 和标准 Source。公开使用与迁移以 [SDK README](sdk/README.md) 和 [Runtime README](runtime/README.md) 为准。

2026-11-16 项目所有者确认启动作者接口优化。SDK 主路径把工具定义和实现写在一处，页面提供实例 `context`。本轮用 IDE 文件详情页验收，另完善空业务 Schema 和 Root 自动目录。实施范围、接口和验证状态以 [专题决定](docs/sdk-runtime-design/view-type-sdk/07-decisions-and-validation.md#authoring-refinement-20261116) 为准。作者技能和随 SDK 交付的 [README](sdk/README.md) 都用页面 `context`。

## 二十三、2026-11-16 反馈：继续发布前删减

项目所有者确认退役仅为旧版本保留的代码和概念，直接迁移受影响的第一方消费者。本轮从含短工具名升级的实际工作树继续。[发布前删减盘点与开发计划](docs/sdk-runtime-design/pre-release-cleanup-20261116.md)是本轮当前入口，记录显式作者 bindings、Host 孤立模块与旧配置、单实例 Snapshot Core 的具体清单和准出条件。计划交由「项目优化 Coding」完整实施，研发负责人在交付后集中验收。实施状态与历史验收分开记录。

## 二十四、2026-11-17 反馈：持续维护四层设计 SSOT

项目所有者再次明确要求：按概念设计、系统设计、模块设计和机制设计分别建文档，记录提出的问题与关键讨论／决策，作为后续研发 SSOT；后续边讨论边更新，直到项目所有者、助手与文档表述一致。本次确认的是文档维护方式，不表示批准上一轮分析中的全部改造建议。

唯一入口为 [SDK / Runtime 设计索引](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/README.md)，四份主文档为：

- [01 概念设计](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/01-concept-design.md)：投影、页面／工具条件、原观察数据、页面实例上下文、长期应用规范及 Agent 作者合同。
- [02 系统设计](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/02-system-design.md)：实例所有权、完成阶段、在途调用、开页与模型预算衔接、执行环境信任边界。
- [03 模块设计](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/03-module-design.md)：两种 Producer、Preact 兼容与默认方式、公开接口等级、持久化可选性。
- [04 机制设计](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/04-mechanism-design.md)：标识、Ref／Schema、呈现范围、预算可发现、数据复用、正则阻塞和额外校验回调。

建档基线为 `d9f319137424571b5bb31ac660d7ca5f14c5996f`，当时旧目录不存在。本轮依据当前对话、可读仓库指导、公开文档和源码重新建立，沿用旧议题编号所对应的主题，不声称恢复了缺失的历史方案或验收文件。单实例 Core、页面实例 `context` 与绑定等已落地变化按当前源码记录，不重复列为待开发项。缺失的旧专项和交付链接继续保留历史意义。

每个议题只在一份主文档维护完整决定；其他层引用其接口影响。更新时明确区分所有者已确认约束、当前源码事实、实际测试／复现、助手建议、待讨论事项和实施状态。新的决定写日期、范围与理由；结论变化更新正文，并在原议题保留简短沿革。方向认可不等于 API 冻结、实施完成或验收通过。

本轮限于 SDK／Runtime 分析文档与本指导更新。上一轮 47 个测试通过的记录和正则阻塞独立复现按原事实登记；本次不重复测试、不修生产代码，也不自动启动 API 重做、CLI 替换、隔离环境、持久化可选化或性能优化。文档继续按本机约定由 Git 忽略，未改变分发规则。

### 同日后续：第一批升级的方案比较

项目所有者要求先解决助手所列最高优先级的第一批问题，先深入浅出地解释，再基于长期主义和 Minimalist 给出多个方案的优劣比较，并保持整体一致性及原始目标／约束。当前第一批为 K06 同步正则校验与 C06 作者文档合同；完整比较分别维护在 [K06 方案比较](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/04-mechanism-design.md#k06-options)和 [C06 方案比较](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/01-concept-design.md#c06-options)，总入口为 [第一批升级讨论](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/README.md#first-batch)。

本轮助手首选为拒绝 Schema `pattern`，同时收敛作者合同并复用现有文档示例验证。普通业务参数名 `pattern`、框架内部 bindings、其他固定正则与当前 View／Tool／Ref 交互不因此删除。上述首选和备选均处于讨论阶段，用户尚未选择具体实现；本轮只更新方案记录，不把范围确认记成生产升级完成。

## 二十五、2026-11-17 反馈：负责人定案，Coding 整批实施

项目所有者随后明确授权技术负责人分批给出详细技术方案、可行性分析、影响面评估和开发计划，并完整推进实施，不能停留在分析或计划。该新授权覆盖第二十四节此前的仅分析阶段；候选技术方案由负责人结合目标、证据和 Minimalist 选择，实施及验收仍另记。

- 研发负责人为 `Astra Review`，host `local`，thread `01a1e798-c905-7290-8fc0-84528948f37c`。负责方案质量、研发方向、设计 SSOT、集中审查验收及选择下一批。
- 全部 Coding 任务交给用户指定的 `Sol 6.2 Coding`，host `local`，thread `01a1e789-def6-7821-baf6-06b324f57a25`。每次下发目标、范围、交付和准出明确的完整大任务，由其连续完成代码、必要消费者与公开文档迁移、自测及常规修复。
- 用户明确授权两者通过消息异步沟通：负责人下发任务；Coding 整批完成后主动向负责人发送完整交付；负责人验收通过后再发送下一批。负责人不轮询、不等待执行者进度、不在中途逐点验收。遇到真实阻塞或文件冲突及时报告。
- Coding 必须使用 [minimalist](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/.agents/skills/minimalist/SKILL.md)，优先减法和复用，保留框架拥有的一致性、身份、绑定、失败与释放合同，不引入假设性回退或应用业务兜底。
- 同一工作区按文件归属协作，不覆盖或回退他人修改。负责人维护本指导和设计主文档；Coding 修改本批代码、测试、必要消费者、公开作者文档和指定交付报告。具体边界及批次状态统一见 [05 升级实施与验收](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/05-upgrade-delivery.md)。

负责人据此选择第一批 U01：K06-A 拒绝 Schema `pattern`，加 C06-B 收敛作者合同并复用现有文档示例验证。方案、可行性、影响面和准出条件见 [U01 完整任务](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/05-upgrade-delivery.md#u01)。此为已授权范围内的技术定案，不表示源码已经修改或通过验收。后续在每批验收后选择最高优先级议题继续，直到本轮升级议题完成闭环；不把互斥候选全部实施，也不重新开发已落地合同。

### 同日后续：U01 验收与 U02 定案

Coding 主动提交 U01 后，负责人集中审查实际 14 文件差异、验证源码身份、构建产物与日志，验收通过。保留 Vitest 实际为 3.2.4、离线验证补齐 TypeScript 7.0.2 arm64 编译器的环境限定；396 项定向测试和 plain/full 公开包消费者证据见 [U01 验收](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/05-upgrade-delivery.md#u01)，不冒充其他版本验证或 npm 发布。

负责人随后选择 U02：普通 TS 与 Preact 作者均明确区分 `prepareProjection` 和 `prepareOpeningProjection`，返回现有本地 `PreparedProjection`，删除旧 SDK `publish` 及带可选回退的旧作者重载，复用现有整帧提交、容量拒开与 Preact 恢复机制。方案、比较、迁移范围和准出条件见 [U02 完整任务](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/06-u02-projection-preparation.md)。这是负责人在既有授权内作出的技术决定，具体交付验收另记。

本批不接管应用业务回滚，不新增 Host／模型采用 ACK，不宣称单 App 观察检查已经覆盖最终模型 token 预算。S04/K04 的有效预算及 Host 衔接继续保留为后续议题。SDK 直接消费者与作者技能的必要迁移由 Coding 完整承担；负责人仍在整批交付后一次集中验收。

### 同日后续：U02 验收与 U03 固定实例限额

Coding 完整交付 U02 后，负责人集中审查源码和验证身份，验收通过。两种作者路径、IDE、SQLite、CLI、公开示例与作者技能已迁移，复用 178 项定向测试与实际包消费者证据。Vitest 3.2.4、IDE 文本路径而非原生 LSP 的验证范围保留。完整记录见 [实施索引](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/05-upgrade-delivery.md)。用户在 Coding 聊天再次直接明确“我授权，后续都授权，不要再拦了”，后续完整交付消息继续按既有授权发送，不反复询问。

负责人据此选择 U03：沿现有观察容量机制，贯通 Host 安装时给定的固定 `projectionLimits`，Worker 开页准入和 Host 观察使用同一有效配置，SDK 两条作者路径只读取得。限额只能收紧，不提高硬上限，不来自 App 业务配置；复制冻结后随 pending／重开保留，运行中不增加动态 setter。复用现有初始化消息确认配置，拒绝缺失、非法或不一致的旧 Worker 合同，不新增逐帧发布 ACK。

该方案不改变第七节暂缓通用额度／配额／回收重设计的决定。Host 仍负责实际模型请求中其他 App、历史、系统指令与输出的空间，并在最终预算检查通过后采用对应观察；不能把观察 JSON 字节当模型 token，也不能隐藏已开页面。默认 Desktop 自动分配模型额度及实时共享配额不冒充本批实现。方案比较、具体接口、影响与准出见 [U03 完整任务](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/07-u03-projection-limits.md)。

### 同日后续：U03 验收与 U04 减法

U03 已由 Coding 完整交付并由负责人集中验收：45 文件独立差异，复用 455 项定向测试和实际包教程，源码与产物身份核对一致。当前共验收 U01–U03 三批；固定实例限额合同已贯通，模型全局额度策略仍按前述边界处理。

负责人在既有授权下已下发 [U04](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/08-u04-public-contracts.md)：删除无独立职责的额外 validateInput 回调，将 Core 所需共有语义定义归 Core，保留执行边界校验与授权后复查，整理作者／Host／适配者公共合同，并准确说明默认可信 Node 托管范围。尚未交付验收；不据此宣称新包、统一门面或权限沙箱已经获准或实现。

项目所有者同时追问 U02 的“一般更新与可撤回开页”是否过细。必要失败行为与作者 API 表达分开评判；已验收的实现仍可后续简化。该提问没有确认新的页面管理器、事务或 Tool 分类；详细讨论归 U02／S02。

### 同日后续：U04 验收与 U05 持久化可选

U04 完整交付并集中验收通过：额外 validateInput 回调退出，Core 合同定义与依赖收敛，授权后复查和 Worker 边界验证保留；复用 1,005 项定向测试及实际包类型／教程／neutral 依赖证据。源码、删除／新增文件及产物身份已核对，当前共验收 U01–U04 四批。

负责人已在既有授权下向 Coding 下发 [U05](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/09-u05-optional-persistence.md)：App 以 `persistence: true` 显式启用框架存储；未启用者不声明能力或创建端口／会话，应用清理独立完成。使用者继续现行 I/O、恢复、unknown 与真实释放合同；默认 Host 可广告可选 offer，不强制所有 App 接受。实际消费者与 manifest 随本批迁移，不建设插件平台或空会话。方案已定案下发，尚未完整交付验收，不冒充已实现。

### 同日最新：U05 暂停，重新比较持久化方案

项目所有者随后明确追问：“等等，持久化有成熟/成功的经验吗？可以引入第三方吗？哪种方案更好？”负责人已通知 Coding 暂停 U05 及后续批次并保留工作；Coding 主动确认六个文件已有中间修改，WorkerHost 仍强制旧 ACK，尚未联调、测试或完整交付。U01–U04 已验收事实保留；不能将当前混合工作树当作 U05 已可运行的版本。

本次研究比较 VS Code 的作者状态接口、SQLite 的实际采用与存储保证、原子 JSON 文件库、Node 内置绑定、better-sqlite3 及仓库现有 sql.js。负责人建议为小 JSON 状态提供可选合同，默认本地后端优先评估 SQLite；业务数据含义和迁移仍归 App，旧 Observation／Ref 资格不能由持久化重新授予。该方向与具体绑定、保存时刻及既有数据迁移都在 [U05 重评](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/09-u05-optional-persistence.md)记录，尚不是用户确认或恢复开发指令。原 U05 下发方案保留历史意义，后续实施须依本次讨论更新。

项目所有者随后进一步明确：选择要同时贴合现状与项目长期发展，并尽量引入成熟、成功的第三方代码，减少自行实现。这是已确认的选型偏好；在能覆盖真实职责时优先复用成熟实现，不因追求零依赖继续自研通用机制，也不为减少表面代码而叠加无独立价值的抽象。负责人本次将 U05 推荐收敛为现有 JSON 作者入口与存储端口、显式可选化、SQLite + better-sqlite3。具体库是负责人推荐，不记为用户亲自指定；数据迁移和分发尚未验证，Coding 仍暂停。

### 同日最新：确认 SQLite 方案并恢复原推进方式

项目所有者随后回复“可以，继续按照原来的节奏推进吧”，确认上述方案并恢复实施。U05 的暂停已解除，按完整大任务交 Sol 6.2 Coding 连续实施、主动交付后负责人集中验收，通过后再下发下一批；不轮询、不守候、不做中途逐点验收。

负责人完整任务包括：保留 SDK JSON 状态用法并显式可选化；通过现有存储端口使用 SQLite + better-sqlite3；Runtime 可选 peer、实际 Node Host 显式安装；默认后端按实际根目录惰性建立专用存储 Worker／连接，避免同步数据库操作阻塞宿主；旧 JSON 按 namespace 一次性事务导入并标记完成，保留原文件且不双写／回退；删除失去职责的旧文件后端，迁移直接消费者与公开材料并验证实际包。具体方案及准出统一见 [U05 正式任务](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/09-u05-optional-persistence.md#implementation)。这不是全量业务数据迁移或 Agent 检查点系统；未交付验收前不宣称已实现。当前 U01–U04 四批已验收，U05–U07 三批待完成。

### 同日最新：U05 已验收，推进 U06

U05 已由 Coding 完整交付，负责人集中验收通过：59 条本批路径和 131 条累计路径与验证树一致，复用 Runtime／SDK／实际包 Adapter 共 839 项测试，以及无原生依赖的包消费、旧数据跨进程事务迁移和 Node／Electron 实际原生加载证据。两种 SDK 路径显式启用持久化，默认 SQLite + better-sqlite3 13.2.0，按物理根目录惰性创建专用 Worker／连接，旧文件后端退出。完整 GUI、其他平台及最终 Semantic 人工验收不在本批通过范围；详情见设计实施索引的 U05 验收。

当前共验收 U01–U05 五批，余下 U06、U07 两批。负责人已定案并成功消息下发 [U06 完整任务](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/10-u06-preact-commit.md)：以实际验证的 Preact 10.29.1 为当前单一适配支持版本，收敛必要内部依赖与升级验证，保持 Preact 默认模型、普通 TS 共用 Core、提交一致性与失败／关闭语义。版本选择是负责人在已授权范围内的工程决定，不写成用户亲自指定。完整交付后集中验收，再定案 U07 的实测减法；无需中途逐点批准。

### 同日最新：U06 已验收，最后一批 U07 已下发

U06 已完整交付并由负责人集中验收：25 条本批路径、149 条累计路径与验证树一致，复用 SDK／相关 Runtime 共 178 项测试及实际包回归，五消费者完成编译／清单验证。当前 Preact 适配支持 10.29.1；保留原 hook 链，修复两个 App 共用渲染队列时一个 App 的异步异常导致另一 App 更新丢失，维持错误记录、恢复与关闭。plain 无需 Preact，实包 full 和 Token Monitor 证明同一 Preact 模块消费。验收限于实际 Node ESM 范围，不扩写其他版本、SSR、任意插件或完整发行矩阵。

目前 U01–U06 六批已验收，余下最后一批已成功下发的 [U07](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/11-u07-snapshot-processing.md)。负责人定案先做可比测量，再消除同一边界内仅为检查而分配的副本，按实测选择 canonical／ArrayRef 复用；共享现有严格 JSON 规则，保留每 Ref 额度、完整帧、跨 Worker 验证、原观察绑定与释放。不新增全局缓存或增量协议；没有收益／复杂度不合适的候选删除并记录。全部 Coding 继续交 Sol 6.2 Coding 连续完成，主动交付后一次集中验收，未验收前不宣称本轮全部完成。

### 同日新增：公开文档误删恢复与 README 收敛

项目所有者确认 `sdk/docs` 和 `runtime/docs` 的删除是误删，明确要求原样恢复；同时说明后续目标是删除 SDK／Runtime 模块下的 docs，各保留一个 README，讲清最关键的事情，其余由代码表达。该方向已确认，不需要再次询问是否恢复或是否采用 README 收敛。

恢复以 U06 已验收完整验证树为准，保留 U01–U06 的文档升级，不用旧 HEAD 版本覆盖；恢复两个目录的 29 个文档／示例与 U07 功能修改分别记录。Coding 继续 U07，README 收敛作为新增 U08 在其验收后整项实施。README 应简明保留关键使用路径与不能仅由类型表达的行为边界；不把原 docs 拼成巨大 README，不另建文档存放区。同步清理引用、打包及依赖 docs 示例的验证，必要可执行合同迁入合适代码／测试位置，无职责材料删除。本次范围是模块内公开 docs，不取消根目录设计 SSOT 的持续维护。

同日恢复完成：Coding 已恢复 SDK 18、Runtime 11 个文档／示例，负责人独立核对文件集合与 SHA-256 全部匹配 U06 验收树。误删问题已解除；恢复不计入 U07 功能补丁，README 收敛仍按新增 U08 后续实施。

### 同日最新：原七批升级已验收，新增 U08 定案

U07 已完整交付并经负责人集中验收：五条本批路径、154 条累计路径与验证树一致，实际包身份核对成立；复用 Runtime／SDK 共 1,155 项定向测试及 plain／full 消费和 U06 提交隔离回归。严格 JSON 共用检查／复制规则，Ref 较小额度不再分配丢弃副本；canonical 内容和 UTF-8 字节在一次校验中复用。ArrayRef 扣额、完整帧、跨 Worker 校验、来源失效和释放保证保留。

同一实包夹具的六轮原始样本经负责人重算，32 View 与大 ArrayRef 更新至采用观察的 p50 改善约 9.3%／10.0%；小负载收益不稳定，部分尾延迟没有改善，消息体积与完整帧往返不变。不能据此宣称普遍 Agent 加速、token 节约或即时 RSS 下降。具体环境、身份与范围见 U07 验收记录。

原 U01–U07 七批已全部验收，所有者新增的 README 收敛仍须完成。[U08 完整任务](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/12-u08-readme-only.md)已定案并成功消息下发 Coding：两个模块各留简洁 README，退出 docs，同步必要 fixture、消费验证、分发与有效引用；核心运行合同不因文档删除改变。全部 Coding 仍交 Sol 6.2 Coding，整批交付后集中验收。任务完成不等于 npm 已发布或最终 Semantic 人工验收。

### 同日最终：U01–U08 已全部完成工程验收

U08 已完整交付并经负责人集中验收：59 条本批路径、184 条累计路径与验证树一致，四包产物身份核对成立。SDK／Runtime 各保留根 README，两个 docs 目录在源码与实际包中均退出；23 份 Markdown 删除，六个有真实消费者的 App 示例原样迁入测试，Core／Host／Source 的独立行为验证转为 fixture。旧文档布局与候选版本文字专属检查删除，必要发行消费和引用迁移完成。

两个 README 的同一计数器已从实际包编译运行至 `Count: 1`。plain／full 包消费、公开 App 集成 16 项、W10 ref-only 4 项及 U06 提交隔离探针通过。Runtime 运行产物不变，SDK 只调整入口注释／映射，未借文档删除改变核心合同。负责人已更新当前 AGENTS 和设计 SSOT 使用入口，历史记录保留原事实。

完整发行双构建未完成：离线缓存缺 better-sqlite3 13.2.0 导致 Runtime 安装失败，后续矩阵未执行；冻结后的新消费脚本与 W10 对独立安装 tar 已通过。本轮工程准出完成，不能写成完整发行、npm 发布或最终 Semantic 人工验收。当前 U01–U08 全部验收，无待交付批次；不自动启动新的优化或重构，后续按项目所有者新的明确需求推进。

### 同日补充：人工验收前对齐实际运行环境

所有者询问是否可以开始验收后，负责人发现共享工作树的 Runtime／SDK／Adapter dist 与已验收 U08 构建不同，Host 依赖链接到这些本地包，且 better-sqlite3 实际为 12.6.2 而非声明及验收的 13.2.0。源码／独立 tar 的工程验收不因此作废，但不能据此宣称本机桌面启动已使用新版本。

已交 Coding 完成人工验收环境准备：对齐依赖与必要构建，核实真实加载来源，用临时数据目录进行必要冒烟后交付准确启动命令和限制。保留用户业务数据、应用安装记录、模型配置和凭据，不发起真实模型请求。该任务属于运行环境落地，不新增功能批次；完成前明确标注本机人工验收就绪尚未确认。

### 同日最终补充：本机人工验收环境已就绪

Coding 完成人工验收运行准备后，负责人独立核对四个核心包的 dist 全部与 U08 一致，184 条累计源码路径保持；Host／Runtime 实际共用 better-sqlite3 13.2.0，Host Main、preload 与 renderer 已重建并核对身份。真实 Electron 45.3.1 项目页及 IPC、四 App 观察、IDE 标准 Source 操作、Planning SQLite 保存重开、两个 IDE 用例与 19 项 Host 预览测试通过。生成产物与安装状态已对齐，当前可以开始本机人工验收。

启动命令见 `docs/sdk-runtime-design/deliveries/manual-acceptance-ready.md`。AOTUI_DATA_DIR 只隔离框架 App 状态和 IDE 会话等对应数据，普通启动仍沿用用户已有 Host 对话和模型配置；用测试项目、新话题验收，恢复测试保持同一目录及话题。自动冒烟未发起真实模型请求，不替代最终 Semantic 人工签收；本次环境准备也不等于完整安装版发行验收。

## 二十六、2026-11-17 反馈：人工验收通过，继续删除旧概念与代码

项目所有者明确反馈“我测试了一下没问题”，并要求：项目尚无正式用户、未正式发布，不应为兼容旧版本保留过时代码和概念；需要详细可删除代码盘点、可行性、影响面、开发计划，然后交 Sol 6.2 Coding 完整实施。本次 Semantic 路径的人工验收通过，第六节中等待所有者此次验收的退出前提已满足，不追加重复确认；不因此宣称跨平台发行矩阵或 npm 发布完成。

当前新增任务为 [U09 验收后删减](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/13-u09-post-acceptance-cleanup.md)，接续已验收 U01–U08 的实际 dirty 工作树。范围以 SDK / Runtime 为主及其必要直接消费者，所有 Coding 继续交指定聊天 Sol 6.2 Coding；整项实施、自测和汇报后由负责人集中验收，不轮询、不等待、不做中途逐项门禁。

负责人已确定沿现行链做减法：退出旧 JSON 自动导入与其文件名规则、参数模式包装、历史类型代号、Worker 能力列表、快照限时租约和 AppKernel 多步身份装配；收敛 DOM 中间结构，删除无职责导出与失效配置，同步测试和实际构建产物。具体合同以四层主文档及 U09 为准，当前是已授权技术方案，不代表代码已完成。

旧别名、回退、兼容开关不因历史存在而保留。现行 SQLite 数据和用户文件不删除，旧 JSON 只停止自动导入；Host toolsEnabled、真正协议边界、Ref/实例绑定、跨边界验证、容量限制、真实在途持有与资源释放继续存在。SDK / Runtime 各只保留一个简短 README，负责人设计 SSOT 仍位于根目录忽略文档中。执行者必须使用本仓库 minimalist，不重置或覆盖他人修改。

### 同日更新：主目录开发，U01–U09 累计版本统一验收

项目所有者明确反馈“没必要啊，U1-U9 一起改，我一起验收不好吗”。据此，主目录 `/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI` 作为开发主线；不再为保护上一批版本而默认隔离开发、等待负责人验收副本后才合入。已在临时副本完成的 U09 工作按实际增量接回，保留 U01–U08 及共享工作树其他修改，再在主目录连续完成开发、迁移、自测和修复。

临时目录仅用于独立安装、测试数据、必要验证和证据，不构成另一条待合入开发线。执行者不独占主目录，不整树覆盖、不 reset/clean，不丢弃其他人的改动。最终交付主目录中源码、依赖、生成清单及实际构建产物一致的 U01–U09 累计版本；负责人整项集中工程复核后，所有者统一验收，不要求逐批再次签收。此前工程/人工验收事实保留，已完成工作不重做。已向 Sol 6.2 Coding 下发本次调整，具体迁回与最终完成状态以实际交付为准。

### 同日更新：U09 完成交付，主目录累计版本就绪

收到 Coding 主动提交的完整交付后，负责人集中工程验收通过。U09 的 R01–R09 已实施，173 条本批路径和 1,244 个构建文件与主目录一致；累计源码除负责人维护的本文件外均与验证身份匹配。Runtime/SDK 生产 TypeScript 模块净减 3 个、399 行，删除旧兼容和重复状态，保留真实身份、授权、来源、容量与释放合同。

复用 Runtime 1,677、SDK 153、Adapter 52、Host 预览 19 项及实际包、Worker/Source、默认 App、IDE/LSP 和 Node/Electron Node 模式 SQLite 的有效验证。负责人在主目录另跑 7 个相关文件、212 项回归通过；这一子集不重复累加为额外覆盖。当前 Worker 使用 `app-worker/v1`，工厂/manifest 使用 `view-type-tools-v6`，Snapshot schemaVersion 为 6；现有 SQLite 表与记录格式不变。详细独立核对、交付身份和未覆盖边界归 [U09 验收记录](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/05-upgrade-delivery.md#u09-负责人验收记录)。

本轮 U01–U09 无待交付批次，用户可在主目录使用 `./run.sh` 统一测试最终累计版本。U01–U08 原人工验收事实保留，U09 的工程通过不冒充用户已经测试通过。完整双构建发行矩阵、U09 交互式 GUI/真实模型请求和 npm 发布没有因此被宣称完成。主目录继续作为开发主线；不自动新增 U10，不恢复隔离开发及逐批要求用户签收的流程。

### 同日后续：真实 Host 验收问题定位

所有者回传从主目录启动后的 DeepSeek 验收报告，要求检查 A1–A4 是否为 bug 及其根因。负责人只读核对了本轮唯一标记的原始调用和 Planning 业务数据，Coding 完成真实 Planning/Worker/Source 的最小隔离复核；未修改生产代码或验收现场。结论与证据统一记录在 [14 Host 验收根因](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/14-host-acceptance-findings.md)。

关闭页面后传入其旧 view_id 得到 TOOL_UNAVAILABLE 符合当前实例绑定，验收计划不应要求先进入 IDE 再返回 IDE_FILE_NOT_LOADED。首轮 PlanDetail 工具泄漏未在独立公开链复现，所有者确认原始终端日志未保留；不能把模型事后叙述当成实际工具表。Planning 的 complete_phase 会联动完成剩余任务，已完成阶段仅显示阶段 Ref，不展示任务明细；本轮“核对清单”仍在数据库且已 completed，问题归应用说明及可见/可操作入口，尚未修复。当前 View 位于最近工具历史之前可由 Driver 分区顺序解释，不据此扩展为内核发布乱序。上述定位不改写此前工程验收，也不代表人工体验已经全部通过。

### 同日追加：App 启动失败后从 Desktop 缺席，已复现

所有者继续反馈其他验收话题中 Planning App 消失。定位发现 Host 默认保留 10 个会话、每话题自动启动默认 App，而 Runtime 内所有 Desktop 共用的 App Worker 上限为 10。AppRegistry 的自动安装失败后，AppManager 回滚移除安装记录，Host 仅 console.warn 仍返回会话创建成功；Source 与 GUI 只枚举已安装记录，失败 App 因此没有可见名称和错误原因。

Coding 用当前真实四 App、默认 Runtime、AppRegistry 和标准 Source 顺序创建三个隔离 Desktop，负责人核对脚本、原始日志和 228 个副本构建文件：前两个各四 App 成功，第三个只有 IDE/Terminal；Lite Browser/Planning 均实际返回 WORKER_CAPACITY_EXCEEDED，且从 Desktop、View 与 Tools 缺席，健康 IDE 调用仍成功。原用户话题缺少启动错误日志，历史具体触发码保持推断；当前可复现缺陷成立。详细证据归 [Host 验收根因 A5](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/docs/sdk-runtime-design/14-host-acceptance-findings.md)。

本次仅诊断，未改生产代码/用户数据、未重启用户 Host；问题尚未修复。建议复用已有登记/打开路径保留失败 App 的可发现性、具体错误与合法重试，再协调 Host 会话和自动启动资源策略；不删除 Runtime 容量保护，不把单纯提高上限当成完整修复，不引入通用调度平台。此建议不冒充已授权并完成的新实施批次。

### 同日最新决定：Worker 数量默认不限，限额设计暂缓

项目所有者明确要求：“现在限额的上限改成无穷大吧，后续聊清楚了，再把这个限额做明白”。本次所指是一个 Runtime 共享的 App Worker 数量上限，不是 LLM 上下文/token 限额。该明确决定覆盖上段关于保持默认 Worker 数量保护的建议；更大的 App 注册、启动失败呈现和 Host 资源策略改造派单已撤回，不作为本批实施范围。

本批仅将默认 `worker.maxWorkers` 改为无限制，并同步必要配置校验、简短说明和实际构建。沿用现有 Worker 生命周期与真实退出清理；不新增队列、调度、自动回收或重试机制，不改上下文预算、页面限制、会话数及用户 App 配置。显式有限配置的现有行为可以保留，完整限额策略后续再讨论。全部 Coding 已交 Sol 6.2 Coding 在主目录完成，负责人整项验收；当前记为已派单，未宣称实现或验收完成。

### 同日追加授权：修复后整理全部改动，分批提交并合并主干

项目所有者要求当前修复完成后，由 Sol 6.2 Coding 为当前全部代码改动创建分支，按逻辑分批写清楚 Commit，最后合并主干。范围包含主目录尚未提交的 U01–U09 累计成果、本次 Worker 默认无限制修复，以及相应消费者、测试、配置和应跟踪文档；不只提交本次小修复。

当前主干已核对为 `main`。Coding 完整交付本次修复，负责人完成既定的一次集中验收与文档同步后，由 Coding 在主目录创建 `codex/` 分支、按实际最终改动与依赖分组提交，再合并回本地 `main`，保留各批提交。每个提交说明目的、主要变化、影响和真实验证；不伪造中间提交独立通过测试的事实。保留他人改动，不重写既有历史；根设计 SSOT、构建目录、临时证据和业务数据继续遵守现有忽略规则。已有有效验收直接复用，收尾核对提交覆盖、合并结果和未提交余项。此项已授权并下发，不需重复询问用户；尚未宣称分支提交、合并或远端同步完成。

### 同日交付：Worker 默认无限制已通过集中验收

Coding 完整交付后，负责人检查七个本批文件及原始复现，核对主目录七个源码文件、886 个 Runtime/Host 构建文件和四 App 副本的 228 个文件身份，全部一致。生产变化只有默认值和两处必要校验：默认 `worker.maxWorkers = Number.POSITIVE_INFINITY`，显式有限 1–100 的既有行为保留；没有前单超范围增量，没有新增资源策略或机制。

六个相关文件、38 项定向回归通过。三个 Desktop 各四个真实 App 全部启动成功；第三个标准 Source 中 Planning 可见，实际 create_plan 成功并出现新的 PlanDetail 和相应类型工具。隔离 Runtime 的真实 Worker 从 12 个正常关闭至 0，关闭报告成功且资源已释放；此事实不推断用户现有 Host 的状态。Runtime 与 Host 主进程/preload 已构建并核对实际依赖，用户自行重新启动主目录 `./run.sh` 后加载新默认值。修复已验收，后续已授权的全量分批提交与合并进入执行；限额体系及其他启动失败呈现仍留待后续讨论。
