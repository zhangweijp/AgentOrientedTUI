# 02 · 系统设计（System Design）

本分册跟踪 Runtime 的跨语言边界、执行隔离、持久化归属与协作拓扑。

---

<a id="sys-01"></a>
## SYS-01 · 跨语言 App 协议边界（以 Python 子进程双文件 App 纵切驱动）

- **三维度状态**：问题证实度 `长期演进风险` ｜ 理想态明确度 `已明确` ｜ 实现方案状态 `已选定待验证`

**已拍板结论（2026-11-25）**：选方案 A + 做法 1。保留现有 Node Worker 与 TS 实现，先用本地命令纵切接通**一个可执行、易读的 Python 双文件最小参考 App**（实际读写 `A.txt` / `B.txt`，暂不发布 Python SDK，`aoapp.json` 扩展暂缓），用同一套行为测试反推哪些字段值得向所有语言长期承诺。

### 现行事实与探针实测发现
- Host 消费侧已有跨语言原型 [runtime/src/stdio.ts](../../runtime/src/stdio.ts#L75) 与 [python-host.py](../../runtime/examples/python-host.py)；App 侧目前仅支持动态加载 JS 模块（[worker-runtime/index.ts](../../runtime/src/worker-runtime/index.ts#L167)）。
- **临时 Python 子进程探针实测发现了两项关键工程边界**：
  1. **内部复合键序列化差异**：当前工具表和 Ref 键使用无空格 `JSON.stringify` 字符串作键（[validate-snapshot.ts](../../core/src/snapshot/validate-snapshot.ts#L228)、[snapshot-support.ts](../../core/src/snapshot/snapshot-support.ts#L90)）。Python `json.dumps` 默认产出 `["files", "File", "edit"]`（多两个空格），或将中文 Ref 名写成等价 Unicode 转义，直接导致快照被拒。这证明**内部复合键拼写必须集中在适配层**，App 作者只需声明结构化语义（如“这是 `File` 页的 `edit` 工具”），现有内部消息尚不宜原样公布为长期外部标准。
  2. **三态终结与迟到回执实测**：同一子进程在写 B 前退出与写 B 后退出（退出码均为 23、均无回执），磁盘状态一未变一已变，必须记为 `unknown`；写完暂扣回执时 Host 先收 `INVOCATION_WAIT_TIMEOUT`，通道保持存活后以原 `observationId` + `invocationId` 查得成功，且实际只派发一次（另 24 项现有 Node Worker 相关测试通过，见 [worker-host.scoped-interaction-e2e.test.ts](../../runtime/src/engine/app/worker-host.scoped-interaction-e2e.test.ts#L246)）。

### 选定方案与精确边界规则

1. **启动登记方式（做法 1）**：
   - 可信 Host 将 `installationId` 登记到固定参数列表（如 `["python3", "-u", "/path/to/files_app.py"]`，不经 shell 拼接）；注册时只登记，`openApp` 时才启动进程并分配新的实例身份；Agent 只能选择已登记 App。
   - 协议逐行走 `stdin`/`stdout`（JSON-Lines），App 自身日志走 `stderr`；`aoapp.json` 新格式等纵切稳定后再定。
2. **协议适配分工**：
   - 纵切阶段复用现有纯 JSON 消息语义，但把内部复合键拼装（如 `toolId` / `refKey` 规范化序列化）收口在 Runtime 适配层，不强迫外部语言猜 JS 的 `JSON.stringify` 空格或转义格式。
   - Python 首版交付**可读、可反复测试的最小双文件参考 App**，以及一套任何语言都能用来检验自身的行为测试；待有更多真实非 JS App 需求时，再从重复代码中提炼 Python SDK。
3. **调用状态三态诚实规则（修正后的硬契约）**：

| Runtime 掌握的证据 | 应向 Host 报告的结果 |
| --- | --- |
| 请求尚未发出，或执行端明确回复 `not-entered` | 确认未执行，按 `rejected` 处理 |
| 请求已发出，本次等待超时，但原进程与回执通道仍存活 | 返回 `INVOCATION_WAIT_TIMEOUT`，保留原调用；后续以原 `observationId` 与 `invocationId` 查收据 |
| 进程或回执通道已终止，读完残留输出仍无有效回执，或执行端明确回复 `finished-unknown` | 终局记为 `unknown`，**禁止自动重发** |

4. **关闭与管道排空语义**：
   - 区分两件独立事实：**业务操作有没有确认结果** vs **子进程资源有没有收干净**（两者可以同时出现“文件结果 `unknown`”且“`resourcesReleased: true`”）。
   - 子进程退出前可能刚写出最后一行回执，Runtime 必须等待直接子进程真实退出、**`stdout` 管道全部读完关闭（对应 Node `child_process` `close` 语义而非仅 `exit`）**、在途调用结清后，才报告 `resourcesReleased: true`。

### 验收标准（正式命令注册、开关页与 TS/Python 共跑通过后升为 `已验证`）

| 验收维度 | 验收标准 |
| --- | --- |
| 同一脚本验两种 App | 现有双文件验收脚本（[verify-two-file-author.mjs](../../tests/fixtures/verify-two-file-author.mjs#L40)）仅替换注册方式，TS 与 Python App 共用全部断言：未开页无 `edit`，开 A、B 后共用一份 `edit`，点名 B 只改 B，下轮在 B 页见新正文；单页容量时拒开 B、A 仍可编辑。 |
| 身份隔离与执行端复查 | 保持原轮次有效，后台关闭重开 B 时旧调用被拒（`VIEW_INSTANCE_REVOKED`）；A 的 Ref 从 `public` 收紧为 `private` 时 B 失去使用资格；Python 在进入业务函数前复查当前页面实例、工具启用态、本地 Ref 范围和最终参数；同步断言错误码与磁盘内容。 |
| 超时、崩溃与关闭排空 | 覆盖写前退出、写后无回执退出（终局 `unknown` 且不重发）、写后暂扣回执（先 `INVOCATION_WAIT_TIMEOUT` 后查得唯一成功）、退出前末行回执读完不丢，以及进程退出+管道收完+在途结清后 `resourcesReleased: true`。 |

---

<a id="sys-02"></a>
## SYS-02 · 面向第三方沙箱的执行后端接口（Execution Backend SPI）

- **三维度状态**：问题证实度 `代码已证实` ｜ 理想态明确度 `已明确` ｜ 实现方案状态 `已选定待验证`

**已拍板结论（2026-11-25）**：选方案 A。随 `SYS-03`、`MOD-02` 与 `SYS-01` 抽离极简公开执行后端 SPI，由可信 Host 在 **Runtime 级统一配置、按安装项固定绑定**（首版 `openApp` 只接收安装 ID 与调用策略，不临时覆盖后端）。Runtime 负责名额、协议、收据与真实退出核验；文件和网络权限隔离由所选第三方沙箱落实，不自造沙箱也不在内核造纸面权限语言。

### 现行事实与探针实测
- [worker-host.ts](../../runtime/src/engine/app/worker-host.ts#L361-L594) 当前直接耦合 `node:worker_threads.Worker`；默认 Node Worker 与本地子进程均按可信 App 托管。
- 实测核对现行 `openApp` 合并语义（[manager.ts](../../runtime/src/engine/app/manager.ts#L120)）：同一安装项并发发起两次相同 `openApp` 时只初始化一次并返回同一 `instanceId`，已运行时再打开报 `LIFECYCLE_CONFLICT`，关闭重开才得新实例。因此后端绑定在安装项上（同一 App 可分别登记为 `files-local` 与 `files-sandbox`）天然避免并发打开冲突，且沙箱启动失败绝不悄悄回退本机执行。
- **Python 子进程双方向管道时序实测**（另 37 项启动/名额/关闭测试通过）：
  1. 读取端暂停时 Node 已报告进程退出，恢复读取后最后一条成功回执才到达；
  2. 子进程主动关闭回执管道后仍存活并能响应测试指令、收到终止信号后进程仍未退出。
  这证明第三方沙箱的“已收到终止请求”只代表请求已受理，**“回执通道永久结束”与“执行体真实退出且通道排空”必须作为两件独立事实分别报告**。

### 选定方案与精确 SPI 合同

1. **后端配置与启动所有权**：
   - 后端由可信 Host 在 Runtime 级配置并按安装项选定；每次**真正的新启动**独占一个执行句柄（不可跨启动复用）。
   - Runtime **先占名额，再启动**；若后端确认什么都没创建，可立即退还名额；若沙箱已创建，哪怕握手失败或 Host 中途关闭，也必须有句柄负责回收；消息与退出监听须从启动瞬间生效，接住首条消息与刚启动即退出的边界。
   - 协议转换留在 Runtime 适配层，沙箱实现方只需对接公开 SPI，无需仿造 Node `Worker` 对象或实现私有 `app-worker/v10`。
2. **双事件诚实汇报规则（回执通道 vs 执行体退出）**：

| 后端能确认的事实 | Runtime 应做的事 |
| --- | --- |
| 调用已发出，等待超时，回执通道仍可用 | 返回 `INVOCATION_WAIT_TIMEOUT`，保留原调用，允许按原 `observationId` + `invocationId` 查收据。 |
| **回执通道已永久结束**（单独通知） | 先处理已收到的完整回执并核对实例与请求编号；仍无终局证据的已派发调用**立即记为 `unknown`** 且不自动重发；执行体若仍存活，继续占用并发名额，不误报已释放。 |
| **执行体已确认退出且通道排空（`exited`）** | 该实例的执行名额只归还一次；等 Runtime 持有的在途工作与本次启动拥有的资源全部结清后，才报告 `resourcesReleased: true`。 |

3. **终止失败与延迟释放保留首错**：`terminate()` 失败或退出尚未证实时，关闭报告如实给出失败阶段与 `resourcesReleased: false`；若后续证实释放，可更新释放状态同时保留第一次错误（[worker-host.resources.test.ts](../../runtime/src/engine/app/worker-host.resources.test.ts#L75)）。

### 验收标准（公开 SPI、双后端共用控制器与独立 Host 注入完成后升为 `已验证`）

| 验收维度 | 验收标准 |
| --- | --- |
| 双真实后端共跑与名额竞争 | 内置 Node Worker（TS）与本地子进程（Python）共用同一单 App 控制器、观察、调用、收据与关闭逻辑；Runtime 设名额为 `1` 时，两种后端竞争同一名额；覆盖双文件验收、退出前末行回执、断线后仍存活（调用立结 `unknown` 且继续占名额）、终止失败与迟到旧实例消息。 |
| 独立 Host 公开 SPI 注入 | 独立 Host 仅通过发布包公开的 SPI 注入受控后端完成启动、收发与关闭，不依赖私有协议或假 `Worker`；同一 App 登记为本地与沙箱两项时，沙箱启动失败绝不回退本机。（测试桩验证插槽与故障处理，具体第三方沙箱的权限隔离须在该沙箱上实测。） |

---

<a id="sys-03"></a>
## SYS-03 · 小型状态持久化移出 Runtime 核心启动/关闭合同

- **三维度状态**：问题证实度 `代码已证实` ｜ 理想态明确度 `已明确` ｜ 实现方案状态 `已选定待验证`

**已拍板结论（2026-11-25）**：彻底将小型状态持久化移出 Core / SDK / Runtime 核心合同，**不背负 v1 旧数据迁移与新旧版本双写兼容**（当前尚无外部开发者，仅内部 Demo App）。App 对自己保存的数据、落盘确认和关闭失败反馈负全责；Runtime 仅负责停接调用、等待 App 清理（`appCleanup`）、确认所托管的执行环境退出，并如实汇报失败或未知结果。

### 现行合同和两个实际消费者

今天 App 显式声明 `persistence: true` 后，Worker 核对声明、创建存储端口，关闭时等待 App 清理，再封存会话、检查 `flush` 和释放结果。共用的清单（`aoapp.json`）、启动协议（`INIT` / `STATE_STORAGE_*`）、关闭报告（`CloseReport.persistence`）及可选原生依赖 `better-sqlite3` 均与存储深度耦合。[Worker 初始化](../../runtime/src/worker-runtime/index.ts#L195) · [关闭时的确认](../../runtime/src/worker-runtime/state-persistence.ts#L24) · [Host 存储合同](../../runtime/README.md#L225)

| App | 当前交给 Runtime 小型存储的数据 | 已由 App 自己保存的数据 |
| --- | --- | --- |
| `aotui-ide` | 工作区目录 `workspaceFolders`、打开的文件路径 `activeFiles`、展开的目录 `expandedDirs`。重开时按路径读磁盘上的正文。 | 编辑结果写入工作区文件，收据用 `diskCommitted` 报告文件操作已提交。最近打开记录另存于 IDE 自己的历史文件。[会话读写](../../demo-apps/aotui-ide/src/core/ide-session.ts#L113) · [编辑收据](../../demo-apps/aotui-ide/src/core/ide-session.ts#L339) · [历史文件](../../demo-apps/aotui-ide/src/core/app-options.ts#L18) |
| `planning-app` | `activePlanId` 记录上次选中的计划，显式 `null` 表示没有选中计划。 | 计划、阶段和任务写入 App 自己的 `planning.sqlite`。恢复选中项时还会核对该计划是否存在。[选择状态](../../demo-apps/planning-app/src/tui/PlanningApp.tsx#L25) · [业务数据库](../../demo-apps/planning-app/src/db/index.ts#L10) |

### 选定方案与边界细节

1. **Core / SDK / Runtime 彻底“无存储感知”**：
   - **Core**：移除 `@aotui/core/persistence` 子入口、`STATE_SESSION_PROTOCOL`、`AppStatePersistence`、`RuntimeContext.persistence` 及相关错误码。
   - **SDK**：移除 `AppConfig.persistence`、`useAppRuntimeContext().persistence`、`AppAuthorContext.persistence`，以及 `generate-aoapp` / `aoapp.json` 中的 `persistenceSupport` 声明与核对。
   - **Runtime**：移除 `storageBackend`、`StateStorageHost`、`sqlite-state-storage` / `sqlite-state-worker` / `memory-state-storage`、`state-storage-protocol` / `state-storage-proxy`、`worker-runtime/state-persistence`、`STATE_STORAGE_*` IPC 消息、`HostResourceReport.storage`、`CloseReport.persistence`、`PERSISTENCE_CLOSE_FAILED` 以及可选依赖 `better-sqlite3`。当前 `AppWorkerHost.retryResourceRelease()` 仅服务于滞留 `persistenceHost`（[worker-host.ts](../../runtime/src/engine/app/worker-host.ts#L199-L208)），随存储移出一并收敛；通用关闭流程继续严格核实 Worker 退出、App 清理（`appCleanup`）和交互持有释放。
2. **Host 仅透传数据目录配置，不接管存储协议**：
   - Host 可通过普通 `launchConfig` 按需给 App 传入跨重启稳定的数据目录路径（具体位置归 Host 规划，Runtime 透明透传，不打开、不加锁、不托管）；`AOTUI_APP_KEY` 退出 Runtime 内置存储魔术键角色。
3. **「已编辑」「已记住」和「已关闭」由 App 接住失败反馈底线**：
   - **`aotui-ide`**：将三组导航列表改存为 IDE 自管的原子 JSON 会话文件（临时文件 + 落盘确认 + 原子替换；多实例共用会话路径时由 IDE 自行加锁或报错）。文件编辑成功后保持 `diskCommitted: true` 收据，不因会话保存失败而重试编辑；后台会话保存失败时继续给页面挂 `SESSION_UPDATE_FAILED`，**并修复现行缺口——`IDESession.close()` 必须等待已发出的会话写入完成，并在存在保存失败或未知结果时明确让 `close()` 失败**，使外层通用 `AppCloseReport.appCleanup` 如实反映未保存事实（[IDE 关闭](../../demo-apps/aotui-ide/src/core/ide-session.ts#L579)）。
   - **`planning-app`**：将 `activePlanId` 并入 App 既有的 `planning.sqlite`（按 `desktopId` 维度存储）；`selectPlan` 等待写入确认并反馈失败，关闭时统一经由 `useAppLifecycle({ close: () => planningService.close() })` 确认释放 DB。
4. **旧数据策略（已拍板）**：不实现 v1 `state.sqlite3` 迁移读取与降级双写兼容；直接清理旧存储代码（不主动删除磁盘上用户已有文件）。

### 验收标准（待实现后验证）

| 验收场景 | 应看到的结果 |
| --- | --- |
| 未使用任何存储能力的 App 在无 `better-sqlite3` 环境下启动、调用、关闭 | Core / SDK / Runtime 零存储协议字段、零原生驱动依赖，走纯通用生命周期。 |
| `aotui-ide` 打开/编辑文件后重启；主动清空目录/文件后再重启 | 精确恢复打开列表并读取磁盘最新正文；显式清空的状态重启后保持为空（不回退为默认展开）。 |
| `aotui-ide` 编辑文件成功但会话文件写入失败或损坏；写入进行中触发关闭 | 文件编辑收据保持 `diskCommitted: true`；页面提示 `SESSION_UPDATE_FAILED`；`close()` 明确失败并在通用 `AppCloseReport.appCleanup` 中暴露，Worker 正常退出释放。 |
| `planning-app` 选中/清空计划后重启，写入失败与关闭 | 选中项随 `planning.sqlite` 正确持久化与恢复，清空状态保持 `null`，关闭时 DB 正常释放。 |

*(注：本轮前期在临时 v1 库上已完成基线验证，证实了现行 `IDESession.close()` 静默吞掉保存失败的真实缺口；上述新方案待进入实施批次后统一实现并验证。)*

---

<a id="sys-04"></a>
## SYS-04 · 多人 / 多 Agent 协作与多观察者内核［已确认不入核］

- **三维度状态**：问题证实度 `已确认不改` ｜ 理想态明确度 `已明确` ｜ 实现方案状态 `已确认不改`

### 结论与依据
- **用户明确决定**：不认可将多观察者协作机制做进内核；多人 / 多 Agent 协作应在应用层实现，现有框架不限制开发多人协作 App。
- **GPT Review 核对**：同意该判断。两个 Agent 可各自启动独立 App 实例操作同一份共享后端文档/数据库，版本、冲突、合并由协作应用自己处理。当前单观察者限制的是“两个独立模型轮次同时持有同一个运行实例的执行资格”，这是极窄且高成本的需求，现阶段没有理由让所有 App 承担多游标与快照淘汰复杂度。
