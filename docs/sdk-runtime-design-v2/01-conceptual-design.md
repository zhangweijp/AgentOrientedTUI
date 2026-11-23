# 一、概念设计（CON-01 ~ CON-06）

返回 [设计索引](00-index.md)。

---

<a id="con-01"></a>
## CON-01：DOM 渲染与窗口折叠的职责边界（已选定待验证）

- **问题证实度**：代码已证实
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**

### 1. 现状事实（代码证实）
1. **模拟 DOM**：仅存在于 SDK 的 Preact 作者路径（[dom-app.ts](../../sdk/src/preact/dom-app.ts) 引入 `linkedom` 构建模拟 DOM 再转为 Markdown）；纯 TS 路径（`@aotui/sdk/app`）与 Core / Runtime 均不依赖 DOM。
2. **窗口折叠**：Core 实际只关心每页的 `receiverViews` / `refViews` 资格与 `windowAccess` 展开代次，不消费 `note` 文本（[observation-registry.ts](../../core/src/invocation/observation-registry.ts#L386-L418)）；但 Runtime（[worker-host.ts](../../runtime/src/engine/app/worker-host.ts#L278-L316)）仍承载了 `note` 存储、折叠/展开命令及 `'collapsed'` 应用状态。

### 2. 已确认决策（选定方案 1）
1. **折叠态与备注归 Host，执行资格与即时撤权归 Runtime**：
   - Host 记住 Agent 折叠了哪一页、写了什么备注（`note` 由 Agent 写给下一轮的自己，允许留空）；App 继续运行，折叠不改变 App 业务状态。
   - 折叠后不展示正文，针对该页仅剩系统的 `expand_view` 及该页支持独立关闭时的 `close_view`；其他同类型展开页保留共享工具（如折叠 `a.txt` 后，`b.txt` 仍可编辑）。
   - **撤权从折叠成功时生效**：Runtime 立即吊销当前轮次对该页的业务调用、Ref 传递与 Ref 查看/打印资格；同轮即使马上展开，也必须等下一轮重新看到页面并采纳新名单后才恢复资格；折叠前已经发出的操作仍按真实结果记收据。
   - Runtime 移出 `note` 与窗口展示态管理，`AppDiscoveryInfo.status` 还原为纯运行状态。
2. **预算提示与主动折叠分开处理（保留双独立资格位）**：
   - Runtime 对每页保留两项独立资格判断：**能否接收操作**、**能否提供 Ref**。
   - 主动折叠 = 双关（除 `expand_view` 与独立 `close_view`）。
   - 预算提示 = 本轮明确保留的工具仍可用、该页 Ref 不可用。明确实际后果：**若 Host 在预算提示下保留了 `edit_file`，那就真的可以编辑**，不得把预算提示误解成“只能翻页”；同时 Host 必须明确标出预算受限，不能把提示算成正文已完整展示。
3. **模拟 DOM 留在 Preact 内部**：
   - App 对外交付的是页面正文、Ref 和可用动作；无论 Preact 还是纯 TS，折叠后模型所见与可做必须完全一致。`linkedom` 留作 Preact 内部实现，是否更换交由 `MOD-02` 的实际开发对比。
4. **确认新增系统级 Ref 查看需求（具体工具名与参数归入 [`CON-04`](#con-04) 细化）**：
   - Native 与 `run_code` 共用同一份授权，区分“看获准结构”与“打印获准值”，发布页一旦折叠立即停止新的结构查询和取值。

### 3. 决策记录
- **2026-11-23（已确认）**：选定方案 1（折叠与备注归 Host、双资格位与折叠即时不可逆撤权归 Runtime）；区分主动折叠与预算提示；确认 `linkedom` 留在 Preact 内部；确认系统级 Ref 查看需求并挂入 `CON-04`。

---

<a id="con-02"></a>
## CON-02：页面能力契约与调用方式（Native 与 `run_code`）解耦（已选定待验证）

- **问题证实度**：代码已证实
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**

### 1. 现状事实（代码证实）
在 `core/src` 与 `runtime/src` 中，调用方式（Native Tool 与 Console `run_code`）的具体细节已深度渗透进核心契约：
1. **Native Tool 命名与形态耦合**：`ToolDescriptor.nameSharedAcrossViewTypes`（[types.ts](../../core/src/snapshot/types.ts#L63)）仅服务于 Native Tool 命名拼接；`Observation.tools` 在 Core 内部已被 `modelToolSchema()` 改写；`AppInvocation.input` 把 `view_id` 与业务参数平铺混装。
2. **Console（`run_code`）专属概念寄生进 Core**：包含 `programTools`、`programInput`、`programPaths`、`consumer: 'console'`、`readConsoleInputs()` 及 `inputMode: 'program'` + `encodeProgramArguments()` 反向转义补丁（[tool-parameters.ts](../../core/src/tool/tool-parameters.ts#L443-L456)）。

### 2. 已确认决策
1. **范围聚焦**：现阶段只覆盖 **Native**（Agent 直接调用工具）与 **`run_code`**（Agent 写代码调用工具）两种入口；**CLI 入口暂缓**，不为未决入口预设注册抽象。
2. **单一业务契约，各入口各自投影**：App 作者只声明一次业务契约（动作做什么、接收哪些业务参数），Native 与 `run_code` 从同一契约投影派生；移出 Core 中的 `nameSharedAcrossViewTypes`、`programTools`、`programInput` 与 `encodeProgramArguments()`。
3. **`view_id` 保留给框架，两入口遵守同一开页与轮次规则**：
   - 工具参数最外层 `view_id` 专门保留给框架选页，App 作者不得声明同名业务参数；单实例 ViewType 省略选页，多实例必填；Core 调用信封将路由与业务参数拆清。
   - **同一开页与轮次约束**：无论 Native 还是 `run_code`，均须经过同一核心校验链路。例如本轮开始时未打开文件页，`run_code` 第一行可打开 `b.txt`，但**同一段脚本第二行不能立刻调用新出现的编辑工具**，必须等下一轮观察并采纳新页面与新工具后才能编辑。
4. **Ref 消费者授权选定简化 3A**：
   - 严格区分且仅区分两类消费者：**“某个页面要用”** 与 **“本轮脚本要读”**，不做泛化的第三方消费者身份注册体系。
   - **由 Host 在同一份名单里决定谁可以读哪一项，Runtime 在交出数据时强校验，只交出本轮获准的那一项。**
   - *与 [`CON-04`](#con-04) 联动口径修正*：已向 Agent 发布为本轮可见的 `public` Ref，Agent 可直接读取其值（见 `CON-04` 规则表）；仅授权给页面使用、不允许 Agent 直接打印值的场景对应 `private` / `protected` Ref（或本轮未放行给 Agent 的未授权范围），页面使用权限与 Agent 直接读值权限继续分别检查。

### 3. 决策记录
- **2026-11-23（已确认）**：锁定 Native + `run_code` 双入口范围（CLI 暂缓）、单一业务契约、`view_id` 框定保留与开页同规则、简化 3A 两类消费者统一授权名单；记录衍生低优 TODO [`CON-06`](#con-06)。

---

<a id="con-03"></a>
## CON-03：`Static / Dynamic` 分区、框架分配 `view_id` 与 `view_type` 命名校验（已确认待迁移落实）

- **问题证实度**：**已复现**（`view_type` 命名校验差距；`createId` 现行 SDK 仍接受回调待随实现迁移）
- **理想态明确度**：已明确
- **实现方案状态**：**已确认待迁移落实**

### 1. 现状事实与已撤回意见
- **已撤回意见**：正式撤回此前关于“废弃 `Static / Dynamic`、改用 `kind: 'instruction' | 'state'`”的全部方案（A/B/C），以及此前草稿中“保留自定义 `createId`”的旧结论；[AGENTS.md](../../AGENTS.md#L38) 已确立最终口径。
- **现行实现差距**：
  1. [types.ts](../../core/src/snapshot/types.ts#L10) 中的 `isInstanceName` 使用 `/[A-Za-z_]/`，导致 `4_2` 和 `___` 仍被放行；
  2. 现行 SDK 仍接受多实例 `createId` 回调，IDE 与终端 App 的使用方需在实现阶段随目标接口一并迁移。

### 2. 已确认决策
1. **分区选择归 App 作者（保留 `Static / Dynamic`）**：
   - App 作者标为 `static` 的页面由 Host 放入静态区，用于复用相邻轮次上下文前缀、命中 KV Cache 节省 token 成本；静态页内容变更后下一轮照常展示最新已提交内容。
   - App 作者标为 `dynamic` 的页面由 Host 放入动态区，即使多轮未变也按作者选择排布。
   - `region` 可在 `ViewType` 声明默认值，也可在挂载具体页面时显式指定或覆盖，两处至少选定一处；保留 `defineViewType`、`<StaticView>` 与 `<DynamicView>`。
2. **`multiplicity` 与框架分配 `view_id`（取消自定义 `createId`）**：
   - 单实例还是多实例由 `ViewType` 一次决定。
   - 单实例默认以类型名作 `view_id`，挂载时可显式指定 `id`；多实例默认按 `type_1`、`type_2` 递增编号（从 1 开始，挂载可传 `idPrefix`）。
   - **最终决定取消开发者自定义 `createId`**：多实例页面的最终 `view_id` 由框架分配，避免同一个生成器反复返回重名而导致新页始终打不开。分配编号时跳过同一 App 实例中已占用的 ID，提交前仍校验整组同时打开页面的 ID 跨类型唯一。页面更新或重排时沿用原 ID，同名页面关闭后重开获得新的内部 `viewInstanceId`，旧调用不重定向到新页。
3. **待落实修复：`view_type` 严格命名校验**：
   - 规则：仅允许 ASCII 英文字母、数字、下划线，区分大小写，且**至少包含一个英文字母**（`x_y`、`x_4`、`xy` 合法；`42`、`4_2`、`___` 均不合法）。

### 3. 决策记录
- **2026-11-23（已确认并更正）**：保留 `Static / Dynamic` 分区并彻底废弃 `instruction / state`；**更正并确认取消多实例自定义 `createId`**，改由框架跳号分配并做跨类型唯一查重（IDE / 终端 App 迁移留待实现阶段）；将 `view_type` 命名校验收紧至至少含一个 ASCII 字母登记为待落实项。

---

<a id="con-04"></a>
## CON-04：Ref 路径授权、系统级 Ref 查看与大对象只读句柄（已选定待验证）

- **问题证实度**：代码已证实（现行 `ref()`/`arrayRef()` 的 `schema` 仍为可选，缺省时 Core 写入 `refType: "unknown"`）
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**（大对象存储方案暂缓）

### 1. 现状事实（代码证实）
- 现行 `ref()` / `arrayRef()` 的 `schema` 为可选参数（[refs.ts](../../sdk/src/app-factory/refs.ts#L7)），省略时 Core 记 `refType: "unknown"`（[coordinator.ts](../../core/src/projection/coordinator.ts#L169)），导致部分 Ref 无法回答结构。
- `run_code` 已有 `inspect(...)` 打印获准给脚本的 `public` 值；Native 尚无按地址查看入口，两入口均未提供统一的结构查看工具。

### 2. 已确认决策（三句核心规则）
> **本轮可见的 Ref，Agent 可以看它声明的完整结构；每个 Ref 发布时都必须有结构；只有 `public` Ref 可以直接打印值。**

1. **查看工具选 1A，暂不做字段名级授权**：
   - Native 提供单一系统工具 **`system-inspect_ref(address, mode)`**（`mode: "schema" | "value"`）；`run_code` 遵守完全相同的权限与规则。
   - **暂不做字段名级路径权限表**：只要一个 Ref 在本轮对 Agent 可见，查结构即可看到它声明的全部字段名与类型；若某字段名本身不能公开，App 应发布更小的结构。路径（如 `people[0].email`）仅用于**少取一点数据**，不再为字段名额外建权限表。
   - **权限矩阵**（前提均为原发布页仍有效未折叠、该 Ref 仍在本轮可用名单里；一旦折叠，新的结构查询、取值与引用传递立即停止）：

| Ref 范围 | Agent 查结构 | Agent 直接打印值 | 哪些页面可以使用这个值 |
| :--- | :--- | :--- | :--- |
| `private` | 可以 | 不可以 | 发布它的那一个 View 实例 |
| `protected` | 可以 | 不可以 | 同一个 App 实例内的获准页面 |
| `public` | 可以 | 可以 | 可以跨 App 交给获准页面 |

   - **旧例子修正（已替换）**：此前“已向 Agent 发布为可见 `public` 的邮箱，却禁止 Agent 打印、只给发邮件页用”的说法存在内在矛盾，现正式撤回替换——**凡本轮对 Agent 可见的 `public` Ref，Agent 即可直接打印其原观察版本的值**；不允许 Agent 直接打印值、仅允许按引用交给页面使用的场景对应 `private` / `protected` Ref。页面使用权限与 Agent 直接读值权限仍分别检查。
2. **Ref 发布时必须声明 Schema（并在 SDK 发布期校验值匹配）**：
   - 改为发布时强制要求结构（基础类型如 `string`、对象声明各字段名及类型、数组声明元素结构以保证空数组也能回答结构；只写一个名义 `refType` 不够）。
   - SDK 在发布时校验实际值符合声明，缺结构或值不匹配立即报错并指出具体 Ref 与出错位置，让写 App 的 Agent 当场修正。
   - 对 `private` 与 `protected` Ref，查结构只展示声明的字段名和类型，**绝不暴露动态字典的真实键、数组当前长度等运行期实际数据**。
3. **大对象只读句柄：确立 H1 版本规则，存储方案暂缓**：
   - 确立 **H1（按原观察取固定版本）**：例如 Agent 看到网页第 1 版，随后网页更新为第 2 版，本轮交给另一个 App 时接收方必须拿到第 1 版。
   - 具体由 Runtime 托管正文还是由 App 提供按版本读取存储，**暂缓至出现真实跨 App 大文件用例再定**；现阶段继续使用已有内联 JSON Ref，保留 `RefTarget` 扩展边界。

### 3. 决策记录
- **2026-11-23（已确认）**：确立“可见即看声明完整结构、发布必带 Schema 且发布期校验、仅 `public` 可直接打印值”三条规则；查看工具选 1A（`system-inspect_ref(address, mode)`）；撤回旧“可见 `public` 邮箱却禁 Agent 打印”示例；大对象确立 H1 版本规则、存储方案暂缓。

---

<a id="con-05"></a>
## CON-05：异步事件、唤醒判定与变更传播边界（已选定待验证）

- **问题证实度**：代码已证实
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**

### 1. 现状事实（代码证实）
- 现行 `signalPolicy: 'auto' | 'never'` 把“预览刷新通知”和“建议唤醒 Agent”混在同一开关里：设成 `never` 会连预览刷新通知也一起关掉（[worker-host.ts](../../runtime/src/engine/app/worker-host.ts#L1009)）；而 `UpdateSignal` 缺少 `appId / instanceId` 且混用遗留原因名。
- 真实终端代码（[TerminalApp.tsx](../../demo-apps/terminal-app/src/tui/TerminalApp.tsx#L163)）已将“收到输出”与“进程退出”分开在不同回调中；普通工具调用的下一轮观察已由 Host 在保存工具收据后安排（[session-manager-v3.ts](../../host/src/core/session-manager-v3.ts#L811)）；真实 Worker 观察测试（[worker-host.projection-refresh.e2e.test.ts](../../runtime/src/engine/app/worker-host.projection-refresh.e2e.test.ts#L152)）已验证无刷新通知时下一次观察仍能拿到已排队提交的新页面。

### 2. 已确认决策
1. **将“页面变了（预览刷新）”与“值得叫醒 Agent（提醒）”明确分开，移除 `signalPolicy`**：
   - 例如 `pnpm test` 前 50 秒刷 1,000 行日志：终端页面照常更新供人预览，日志本身触发 **0 次模型请求**；第 51 秒进程 `exitCode: 1` 退出时，终端 App 提醒 Host 一次。
   - 复用现有 Desktop 通知入口，按真实事实报告原因（页面更新、投影出错或恢复、App 打开或关闭、App 请求关注），来自 App 的通知由 Runtime 填入真实的 `appId` 与 `instanceId`。
   - **移除 `signalPolicy: 'auto' | 'never'`**。
2. **选定 2A 最小版：SDK 提供零参数 `requestAttention()`**：
   - 语义仅为“有件事值得再看一眼”，第一版**零参数**；退出码、错误日志、未读消息等业务事实只在 View 中写一次，App 先记下业务事实并安排页面更新，再调用 `requestAttention()`（哪怕 3 次提醒合并成 1 次，Agent 下次打开页面仍看到全部业务事实）。
   - **普通工具调用无需作者手动调用**（如 Agent 主动打开 `a.txt`，Host 在收据保存后已安排下一轮观察）；`requestAttention()` 专用于“工具早已返回，后台后来发生了值得关注的事”。
   - **唤醒决策权完全归 Host**：Host 收到提醒先核对该实例是否仍有效、当前会话是否启用了它；Agent 正在回答时可记为“稍后再看”并合并多次提醒；真正开始下一轮时再走正式 `observe → adoptTurn`（当轮正在写的回答仍依据旧观察；若页面更新失败，Host 得到对应投影故障）。
3. **模型读完整最新页面，内部传输交由 `MEC-02` 实测**：
   - 模型每轮直接读约定范围内的完整最新页面（例如终端最后 30 行），无需拼接增量 Diff；Worker 与主线程之间是否传 Diff 由 [MEC-02](04-mechanism-design.md#mec-02) 基于真实帧数/字节数/模型请求数基线决定。

### 3. 核心验收条件
- 保留现有 8 项相关测试通过；
- 新增终端验收场景：**后台持续刷日志时预览可正常更新且不触发唤醒提醒；测试失败退出时 Host 收到 1 次关注提醒，Agent 在下一轮通过正式观察看到退出码。**

### 4. 决策记录
- **2026-11-24（已确认）**：选定 2A 最小版零参数 `requestAttention()`（App 提醒、Host 决定唤醒并走下轮正式观察），移除 `signalPolicy`，复用 Desktop 通知入口补齐准确原因与 `appId / instanceId`，模型保持完整最新页面，内部传输交由 `MEC-02` 实测。
---

<a id="con-06"></a>
## CON-06（TODO）：PTC（`run_code`）模式下查询 App 的 ViewType 与页面实例清单

- **问题证实度**：代码已证实
- **理想态明确度**：部分明确（待定边界）
- **实现方案状态**：未开始（低优 TODO，后续排期讨论）

### 现状事实
- 当前 `run_code` 环境（[declarations.ts](../../agent-driver-adapter/src/console/declarations.ts)）仅向脚本暴露 `refs` 与 `tools`，未提供程序化方式让脚本查询“本轮某个 App 拥有哪些 `ViewType`，以及各 `ViewType` 当前已打开哪些页面实例（`view_id` 列表）”。
- 模型目前只能靠肉眼阅读 `<desktop>` 与 `<view>` 消息并把 `view_id` 硬编码进脚本，无法在脚本里动态遍历同类型已打开页面（例如遍历所有已打开的 `FileDetail` 页面批量操作）。

### 待讨论问题（延后处理）
- 是否向 `run_code` 暴露只读的当前轮次页面目录（如 `views` / `apps` 元数据，不含未授权的正文或隐藏 Ref），以及如何与 `MEC-04` 有效轮次名单保持一致？
