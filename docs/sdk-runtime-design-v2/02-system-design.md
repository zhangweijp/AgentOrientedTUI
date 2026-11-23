# 二、系统设计（SYS-01 ~ SYS-04）

返回 [设计索引](00-index.md)。

---

<a id="sys-01"></a>
## SYS-01：语言无关的公开合同与跨语言边界（已确认方向与验收标准）

- **问题证实度**：代码已证实
- **理想态明确度**：已明确
- **实现方案状态**：已确认方向与验收标准（通信格式、版本号策略与内部复查字段留待后续按实需细化）

### 1. 现状事实（代码证实）
1. Runtime 与 Worker 之间已存在内部消息协议 `app-worker/v6`（[messages.ts](../../runtime/src/spi/worker-protocol/messages.ts)），但宿主消费侧（边界 A）仅提供进程内 JS/TS API，其他语言 Agent 无法直接接入消费现有 App。
2. 默认托管启动路径（[worker-runtime/index.ts](../../runtime/src/worker-runtime/index.ts#L194-L212)）核对显式协议标识（`WORKER_PROTOCOL`、`VIEW_TYPE_TOOL_PROTOCOL`、`APP_LIFECYCLE_PROTOCOL`、`STATE_SESSION_PROTOCOL`），并加载 JS 工厂对象 `TUIAppFactory`。
3. 现有工具调用路径（[tool-invocation.ts](../../runtime/src/worker-runtime/tool-invocation.ts#L48-L69)）在主线程解引用并校验后，跨 IPC 仍下发 `rawArgs + refSources` 给 Worker 二次重建和验型；业务 handler 本身已经直接接收解析好的值。

### 2. 已修正/撤回意见
- 撤回“宿主小版本一升，所有 App 都报废”的不准确表述。
- 撤回“优先投入多语言 App SDK（先让外部语言重写 App）”的排序建议：AOTUI App 的现实定位是**套 CLI / MCP / HTTP 壳子的前端交互壳**，类似网页，优先让更多语言的 Agent 能消费已有 TS App 收益最大。
- 撤回“现阶段为历史 Demo 维护跨版本向后兼容合同”的要求：当前尚无外部用户基于旧版开发 App，仓库内均为自有 Demo，不背历史包袱；先把正确且长期的框架做出来，框架升级后直接重写 Demo。

### 3. 已确认决策
1. **双边界优先级与定位**：
   - **优先打通边界 A（Host ↔ Runtime 消费边界）**：先让 Python 等其他语言的 Agent 能通过公开消费合同使用现有 TS 壳子 App。
   - **延后边界 B 的多语言 App SDK**：用其他语言开发原生 App 待真正有需求时再推进；现阶段 TS App 壳子直接复用 CLI / MCP / HTTP 数据源。
2. **App 与 Runtime 的五项核心职责边界**：
   - **开始时说清楚**：App 声明自己能展示哪些页面类型、每种页面能做什么。
   - **页面和操作要对得上**：多同类型页面共享同一动作契约，但每次操作必须路由到选定的具体页面实例。
   - **结果要说实话**：保存成功但刷新页面失败，必须如实报告“保存成功，页面刷新失败”；请求发出后断线/超时，必须如实报告“结果未知”，绝不掩盖或瞎猜。
   - **关页要认准原来那一页**：关闭并同名重开后，旧请求绝不能落到新页上；允许从外部关闭哪些页由 App 声明。
   - **退出要有人收尾**：App 负责关闭自己启动的外部程序和连接；Runtime 负责停止接收新操作，并确认已开始的操作最终如何收尾。
   - **移出 App 强制关注项**：工具重名计算（如 `nameSharedAcrossViewTypes`）由框架自己算；状态持久化（如记住上次打开了哪些页）由有需要的 App 按需选择，不强迫所有 App 作者操心。
3. **Ref 职责分工**：
   - **Runtime 记住 Agent 当时选了谁**（按原 Observation 解析并传递选中对象的只读值）；**App 检查现在还能不能对它做这件事**（挂载存活、业务存在性、归属与外部变更冲突）。
   - 框架内部如何传递与复查这些信息的具体字段，留待测试验证够用再定，不在此时过早写死。
4. **核心验收考试（定义完成标准）**：
   - 用 Python 写一个 Agent，通过公开消费合同使用现有 TS 文件 App，验证：
     1. 打开 A、B 两个文件 → 实际请求中为 2 个页面、1 个共享编辑工具；选 B 只改 B；
     2. 外部修改磁盘文件 → App 检出冲突而非盲目覆盖；
     3. 关闭后同名重开 → 旧页请求被拒；
     4. 编辑工具禁用再启用 → 旧激活绑定请求被拒；
     5. 写成功但刷新页面失败 → 保留并如实报告写入成功与刷新失败，并可正确恢复。
   - 传输通信格式与版本号策略细节按实际需要后定。

### 4. 决策记录
- **2026-11-23（已确认）**：确立“先让跨语言 Agent 用上已有 App、让 App 作者只管业务、由 Runtime 记住每次选中的对象”三项核心原则与 Python Agent 验收考试；不为现有自有 Demo 背跨版本兼容包袱。

---

<a id="sys-02"></a>
## SYS-02：信任模型与防御检查的收益审计（已选定待验证）

- **问题证实度**：已复现
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**

### 1. 现状事实（代码审计与实测复现）
- **三处上限各自独立有效**：实测用 7 万个换行符模拟编辑文件，JSON 编码后原始参数达 **140,011 字节**（超过原始参数 **128 KiB** 上限），但整条消息仍未超限；反之极短的 Ref 地址可展开为超大数组（[adapters/tool-invocation.ts](../../runtime/src/adapters/tool-invocation.ts#L8)）。
- **Node 消息通道结构化克隆行为实测**：发送前已冻结的嵌套对象经消息通道到达 Worker 后重新变为可变，Mon Nov 23 23:59:42 CST 2026 原样作为 Mon Nov 23 23:59:42 CST 2026 到达。
- **嵌套启动配置浅拷贝漏洞复现**：注册 App 时传入 `settings.theme = "light"`，注册后 Host 原地改为 `"dark"` 再打开 App，**真实 Worker 读到了 `"dark"`**（[desktop.ts](../../runtime/src/engine/core/desktop.ts#L213) 仅复制了外层配置）；另核实 `projectionLimits` 已在 [interaction-config.ts](../../runtime/src/engine/app/interaction-config.ts#L21) 复用校验过的值。
- **Worker 最终执行入口与耗时实测**：`invokeTypeTool()`（[view-owned-tools.ts](../../core/src/tool/view-owned-tools.ts#L310)）本身即做一次最终参数验型并同时服务独立 Core 使用方；但现行 `validateResolvedInput()`（[tool-parameters.ts](../../core/src/tool/tool-parameters.ts#L313)）自带复制与序列化，单函数处理 6,000 个字符串约耗时 **4.4 ms**；且 `scopeAllows` 当前与 `acorn` 解析器同在 [ref-parameters.ts](../../core/src/tool/ref-parameters.ts#L1)。

### 2. 已修正/撤回意见
- 修正初稿“五层都把整份配置重新深验了一遍”的过宽表述：`projectionLimits` 已通过 WeakSet 复用校验结果，实际问题在于入口未深固定嵌套启动配置，且各层仍有不必要的描述符/getter 审查。
- 修正初稿“只查整条消息上限即可”的隐含风险：原始参数、Ref 展开后数据、整条消息三项上限各自覆盖不同风险，必须保留，只应合并重复拷贝与排序序列化。

### 3. 已确认决策
1. **合并重复拷贝，保留三项独立上限与防重指纹**：
   - **统一规则**：外部交来的可变数据由 Runtime 接手时做**一份独立副本**，随后在同一副本上分别检查原始参数、Ref 展开后数据、整条消息各自上限（算字节时省掉反复排序和序列化，但须准确计算中文、换行等编码后大小，参考 [json.ts](../../core/src/snapshot/json.ts#L52)）；保留用于判断“同一调用编号是否携带同一份参数”的稳定防重指纹（[app-interaction.ts](../../core/src/invocation/app-interaction.ts#L522)）。
   - **通道克隆后的归属与只读**：Worker 直接在收到的消息副本上核对消息并落实传给 handler 的只读保证；主线程仍核对回包属于哪次请求、哪个实例，编辑已执行却收到坏回包时结果记为**“未知”**，绝不据此重试（[worker-message-capture.ts](../../runtime/src/adapters/worker-message-capture.ts#L53)）。
2. **配置检查收归公开入口并深度固定嵌套启动数据**：
   - **公开入口**：统一检查拼错选项与错误类型，并在第一次 `await` 之前**深度固定**本次注册的启动数据（含嵌套对象，修复上述 `settings.theme` 泄漏）；带方法的服务对象（如 `policy`、`storageBackend`）继续按引用传递。
   - **内部各层**：直接使用已固定配置和 Runtime 自产报告；真实 Worker IPC 消息仍须核对协议、实例与必要字段（如格式错误的持久化确认须报协商失败，见 [worker-host.ts](../../runtime/src/engine/app/worker-host.ts#L890)），测试改发真实通道可传递的错误数据，不再靠假 Worker 造 getter。
3. **默认 Node Worker 选定 3B：Ref 只在主线程解一次，执行前用本地 Schema 直接验一次**：
   - **主线程**：按 Agent 原 Observation 取 Ref 原值、检查授权（异步授权返回后复查本轮资格）与业务参数，下发**最终业务值** + 本 App 仍须现场核对的本地 Ref 清单。
   - **Worker**：进入 handler 前确认仍为原 App 实例、原页面、原工具且本次启用仍有效，确认本地来源 Ref 仍在发布且当前范围允许接收页使用，随后用本地登记的 Schema **直接校验收到的最终业务值**（受第 1 项约束，**不再为了这一次验型另造整棵副本**）；App 作者只管业务与外部变更检查。
   - **兑现 Worker 零加载 `acorn`**：将 `scopeAllows` 从 [ref-parameters.ts](../../core/src/tool/ref-parameters.ts#L1) 中与 `acorn` 地址解析模块拆开，并以**真实 Worker 实际加载模块清单**验收零加载 `acorn`。

### 4. 决策记录
- **2026-11-23（已确认）**：确认单副本多上限 + 稳定防重指纹 + 坏回包记未知；确认配置公开入口一次检查并深度固定嵌套启动数据（服务按引用传），真实 IPC 核对协议与必填字段；选定 3B（主线程解 Ref、Worker 实时核对身份与本地 Ref 范围后原地用本地 Schema 验一次且拆离 `scopeAllows` 以真实 Worker 验收零 `acorn`；本轮针对现行实现选跑 33 项相关测试全通，端到端耗时收益待实现后验证）。
---

<a id="sys-03"></a>
## SYS-03：可选持久化与内核类型及关闭流程解耦（已选定待验证）

- **问题证实度**：已复现
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**

### 1. 现状事实（代码与实测复现）
- 实测启动并关闭无持久化 App：关闭成功、未创建数据目录（已做到“没用就不开数据库”），但主线程仍静态加载了 SQLite 适配器和存储宿主（[state-storage-host.ts](../../runtime/src/engine/app/state-storage-host.ts#L14)），Worker 入口仍静态加载了存储代理和会话代码（[worker-runtime/index.ts](../../runtime/src/worker-runtime/index.ts#L8)）。
- [manifest.ts](../../runtime/src/engine/app/manifest.ts#L47) 读取清单时虽已校验 `persistenceSupport`，但返回结果丢弃了该声明，导致主线程每次 `INIT` 仍无条件附带 `persistence` offer。
- [close.interface.ts](../../runtime/src/spi/runtime/close.interface.ts#L30-L35) 将 `persistence`（10 项字段）与存储专属 `resources` 写死为必选顶层；[desktop.ts](../../runtime/src/engine/core/desktop.ts#L330-L335) 直接读取 `retainedStorageOwners` 编排释放重试；[runtime/src/index.ts](../../runtime/src/index.ts#L90) 从 `@aotui/core/internal` 暴露 `StateStorageBackend`，[messages.ts](../../runtime/src/spi/worker-protocol/messages.ts#L4) 反向导入 `worker-runtime/state-persistence.ts`。
- 实测同目录双实例冲突：两个实例先后写同一份 `notes` 草稿（首实例不释放），共用统一协调后端时第二次写入被 `NAMESPACE_BUSY` 拒绝；若拆成两个各自独立的 SQLite 后端实例指向同一目录，第二次写入会错误返回成功并静默覆盖第一份草稿（占用表保存在后端实例内，见 [sqlite-state-storage.ts](../../runtime/src/adapters/storage/sqlite-state-storage.ts#L148)）。

### 2. 已修正/撤回意见
- 撤回初稿 3A 中“每个 Runtime 各建一个独立 SQLite 后端实例”的提议：经实测会破坏同一物理目录内的 `NAMESPACE_BUSY` 独占协调，导致双 Runtime 互相覆盖数据。

### 3. 已确认决策
1. **双端真正按需加载与统一接入流程**：
   - **有清单（`aoapp.json`）**：沿用并透传已有 `persistenceSupport` 字段至启动阶段，由 Worker 核对实际 App 声明；清单与 App 不一致时明确报错。
   - **无清单（裸模块）**：Worker 加载 App 后，只有发现其声明了 `persistence: true`，才向主线程申请存储；两种方式共用同一条存储接入流程。
   - **双场景验收**：
     1. 单独运行无持久化 App（如 `code_viewer`）：主线程与该 App Worker 均**零加载**存储实现（`@aotui/core/persistence`、`state-storage-host`、`sqlite-state-storage`、`state-storage-proxy`、`state-persistence`）；
     2. 与持久化 App（如 `notes`）同时运行：`code_viewer` 的 Worker 零加载存储实现、不申请存储、关闭时不参与存储收尾。
2. **关闭报告与内部收尾解耦（选定 2A）**：
   - **公共 `CloseReport` 行为**：`CloseReport.resources` 改为通用未释放托管资源口径；`CloseReport.persistence` 改为按需出现的可选摘要：
     - 从未申请存储的 App（如 `code_viewer`）：省略 `persistence`；
     - `notes` 写入结果未知但连接已释放：保存结果标示为“未知”，`ok: false`，`resourcesReleased: true`；
     - `notes` 已确认保存但连接释放失败：保留保存成功事实，`resourcesReleased: false`；重试仅释放连接，成功后更新释放状态并保留第一次错误。
   - **严守关闭顺序与计时起点**：先让 App 完成自身清理（可能写入最后一笔草稿）→ 停止接收新写入 → 等待后端确认已接收写入 → 释放存储资源（见 [state-persistence.ts](../../runtime/src/worker-runtime/state-persistence.ts#L31)）；清理报错仍须尽力完成后续收尾并分别报告。**从后端开始打开那一刻起就计为未结束工作**，防止 Desktop 提前报告已关完。保住既有 5 项关闭与重试验收行为（[close-reporting-e2e.test.ts](../../runtime/src/kernel/close-reporting-e2e.test.ts#L188)）。
   - **内部收尾槽位**：拥有资源的实例只需回答“还有工作没结束吗、释放成功了吗、能否重试释放”，Desktop 负责等待与汇总，SQLite 细节留给存储实现；删除 `unusedStorageStats`。
3. **默认 SQLite 体验与同目录统一协调（选定修正后 3A）**：
   - 保留 Node Host 默认 SQLite 零配置体验（按需动态加载，缺失可选原生驱动 `better-sqlite3` 时给出安装驱动或配置自定义后端的明确错误）；Host 传入自定义 `storageBackend` 时直接使用。
   - `StateStorageBackend` 公共类型归 `@aotui/core/persistence`，SQLite 实现归 Node 适配器，Worker 协议消息只引用协议类型（解除对 `worker-runtime` 的反向依赖）。
   - **所有权与同目录协调红线（写入验收）**：每个 Runtime 只负责释放自己申请的资源；**同一物理数据目录的命名空间占用由存储适配器统一协调**。关闭 Runtime A 时 Runtime B 正常继续使用自身数据；A 释放某份笔记后 B 才能接手；同一目录的**最后一个使用者退出后**再关闭底层存储 Worker。

### 4. 决策记录
- **2026-11-23（已确认）**：确认双端按需加载与双场景验收、选定 2A 关闭报告与四步关闭顺序/打开即计未结束工作、选定修正后 3A（默认惰性 SQLite + 同目录统一占用协调 + 最后使用者退出再关存储 Worker），撤回“每 Runtime 建独立 SQLite 后端”提议。

---

<a id="sys-04"></a>
## SYS-04：单 Agent 串行与多 Agent 共享演进边界

- **问题证实度**：长期演进风险
- **理想态明确度**：部分明确（待定边界）
- **实现方案状态**：**暂缓**

### 已确认共识
- 当前坚持单 Agent 独占实例与串行调用主路径，利于调用归属、防重与失败恢复的正确性。
- 多 Agent 共享真正需要回答的是“A 采纳新观察是否撤掉 B 的资格”“双方能否看到不同页面”等语义问题，而非简单把并发度从 1 调到 4。
- 现阶段不改造并发执行，仅在定义 `SYS-01` 公开合同时留意区分“属于 App 实例的状态”与“属于单个会话的观察资格”。
