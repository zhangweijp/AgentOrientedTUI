# SDK / Runtime 设计讨论 SSOT v3

本目录用于记录本轮针对 **AOTUI SDK 与 Runtime（含 Core）走向通用 LLM Agent Infra** 的逐点架构讨论、问题定义、理想态、候选方案、实证边界与最终决策。

> **维护规则**
> - 严格区分**现行实现事实**、**已确认结论（保留 / 否决 / 选定）**、**待逐点讨论方案**与**已更正/撤回意见**，不把候选方案写成现行能力。
> - 每项议题使用三个独立维度度量，不给未实测项打虚假的“100% 信心”：
>   - **问题证实度**：`已复现` · `代码已证实` · `待实测` · `长期演进风险`
>   - **理想态明确度**：`已明确` · `部分明确（待定边界）` · `待实验确定`
>   - **实现方案状态**：`未开始` · `候选对比中` · `已选定待验证` · `已验证` · `暂缓` · `已确认不改`
> - 本轮逐点拍板且验证通过的结论，再同步回写至 [AGENTS.md](../../AGENTS.md) 与模块 README。

---

## 一、已确认的讨论基线

1. **产品定位（前端 + 封装优先）**：AOTUI 是面向 LLM Agent 的前端与状态投影运行时，数据源可以是 CLI / stdio / HTTP / MCP / 本地文件 / SQLite。现阶段优先通过封装已有 CLI / MCP 快速构建高质量 AOTUI App，不以“说服外部应用原生改写”为冷启动前提。
2. **演进总原则（不推倒重来，守住核心保证，外科手术瘦身）**：
   - 最值得长期稳定下来的核心契约是：**Agent 基于刚才看到的页面发出操作，框架权威裁决它是否仍有资格执行、落到哪一个实例；外部世界是否被并发修改、如何合并或拒绝，由应用自己裁决**。
   - 长期演进以“把已验证的交互语义提炼为清晰、简单、正确、可跨语言复现的公开合同”为标尺，做减法而不是推倒重建。
3. **验证优先于臆测**：
   - 不凭感觉估算“代码减少比例”或“缓存命中率”。涉及 SDK 易用性的改动以**干净 Coding Agent 盲测双文件 App**验证；涉及跨语言契约的改动以**Python 子进程双文件 App 纵切**验证；涉及模型准确率与 KV Cache 成本的改动以**真实模型对照实验**裁决。

---

## 二、首轮评审的事实更正与撤回记录（基线纠偏）

以下 7 项首轮评审中存在事实误差或过度推论的表述，已核对源码并正式更正/撤回，不作为后续设计依据：

| 原表述 | 核对后的事实与更正结论 |
| :--- | :--- |
| Node Worker 调用 `process.exit()` 会拖死宿主进程 | **事实错误，已撤回**。Node Worker 中 `process.exit()` 只退出该 Worker 线程，宿主继续运行；真正可能影响宿主的是原生代码崩溃或整进程 OOM。 |
| 每次观察都全量重拷快照 | **与源码不符，已更正**。[worker-runtime/index.ts](../../runtime/src/worker-runtime/index.ts#L278-L328) 已合并普通更新通知，并在内容未变时通过 `PROJECTION_CURRENT` 返回短确认；真正待评估的是“大页面发生实际变化时”的开销。 |
| 忘记 `release()` 以后就永远不能观察 | **表述过重，已更正**。已采用的旧轮次会在下一轮成功 `adoptTurn()` 时自动退役（[request-sources.ts](../../core/src/invocation/request-sources.ts#L164-L192)）；真正会占死单槽位的是忘记 `discard()` 的未采用候选。 |
| `prepareOpeningProjection` 复杂度源于 Core 未先检查容量 | **归因有误，已更正**。[coordinator.ts](../../core/src/projection/coordinator.ts#L214-L225) 已在替换快照前检查容量；`revert()` 的作者负担主要源于 Preact 必须先修改组件状态再渲染以产出候选帧。 |
| 调用链 11 层（把每轮一次的 `adoptTurn` 算进每次调用）且把两道检查都视为多余 | **已修正**。`adoptTurn` 是每轮一次；主线程“轮次/授权校验”与执行端“实时挂载/激活复查”分属不同时间点，两者皆不可省，应删的是纯转发包装与重复边界实现。 |
| 把 6 套内部版本号合并为 1 个数字；用 Standard Schema 直接替代全部 Schema 绑定 | **已修正**。SQLite 落盘格式、内部 Worker 协议与外部 App 协议寿命不同，不应强行合一；普通 Standard Schema 不保证 JSON Schema 导出，需基于 **Standard JSON Schema** 与清晰的 JSON Schema 子集合同；且 `typescript@7.0.2` 非 SDK `peerDependencies`。 |
| “代码可压回 1/3”“挡住 80% 开发者”“无损 KV Cache” | **无实测依据，已全部撤回**。后续涉及代码规模、生态采用率与缓存收益一律以可复现测试数据为准。 |

---

## 三、全量议题索引（17 项）

2026-11-26，项目负责人决定暂缓 OpenAI、Claude 和 DeepSeek 的线上实验。Batch 4 已用独立安装包核对本地协议往返、工具选择与磁盘结果。三家的缓存命中、费用和真实模型误调率均待实测。Ref 继续使用策略 1，工具呈现继续使用现行默认方式。[Ref 对照](04-mechanism-design.md#mec-01) · [工具呈现对照](04-mechanism-design.md#mec-06)

### A. 已确认维持现状 / 暂不入核（4 项，不再反复拉扯）

| ID | 议题 | 结论 | 详情 |
| :--- | :--- | :--- | :--- |
| `CON-03` | `ViewRegion`（`static` / `dynamic`） | **已确认保留**。表达作者对页面所在区域的意图，且已支持挂载期指定/覆盖，不改名为 `volatility`。 | [概念设计](01-conceptual-design.md#con-03) |
| `CON-04` | 长耗时任务（Job）与通用业务事件原语 | **已确认暂不入核**。复用现有异步能力 + 页面呈现进度 + `requestAttention()`，不造内核轮子。 | [概念设计](01-conceptual-design.md#con-04) |
| `SYS-04` | 多人 / 多 Agent 协作的多观察者内核 | **已确认不入核**。多 Agent/多人协作通过应用层或独立 App 实例实现，不给单实例内核叠加多游标复杂度。 | [系统设计](02-system-design.md#sys-04) |
| `MEC-05`（部分） | 6 套不同寿命版本号是否强行合一 | **已确认不合一**。不同寿命格式保持独立版本；仅在 `SYS-01` 明确对外公共 App 协议时单独制定兼容承诺。 | [机制设计](04-mechanism-design.md#mec-05) |

### B. 已定方向的活跃议题（14 项，按讨论顺序排列）

| 序号 | ID | 议题 | 分类 | 问题证实度 | 理想态明确度 | 实现方案状态 | 详情 |
| :---: | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `SYS-03` | 小型状态持久化移出 Runtime 核心启动/关闭合同 | 系统 | 代码已证实 | 已明确 | 内核存储已移出，IDE 与 Planning 的并发及异常退出恢复待修 | [系统设计](02-system-design.md#sys-03) |
| 2 | `MOD-01` | 跨语言 Host 共用页面呈现原语（消除 XML/Ref 漂移） | 模块 | 已复现 | 已明确 | 已实施待复核 | [模块设计](03-module-design.md#mod-01) |
| 3 | `MOD-02` | 缩短纯转发调用链、将 Console 包装移出 Core、收口校验 | 模块 | 代码已证实 | 已明确 | 已实施待复核 | [模块设计](03-module-design.md#mod-02) |
| 4 | `MEC-04` | 未采用候选的防泄漏机制与 Host 易用包装 | 机制 | 代码已证实 | 已明确 | 已实施待复核 | [机制设计](04-mechanism-design.md#mec-04) |
| 5 | `CON-01` | SDK 作者路径主次定位与 Preact 私有钩子风险治理 | 概念 | 代码已证实 | 已明确 | 已实施待复核 | [概念设计](01-conceptual-design.md#con-01) |
| 6 | `MEC-02` | 开页容量拒绝时的作者恢复体验（Preact `revert` 负担） | 机制 | 代码已证实 | 已明确 | 已实施待复核 | [机制设计](04-mechanism-design.md#mec-02) |
| 7 | `MOD-03` | 稳定外部参数 Schema 合同并逐步松绑 `typebox@1.4.3` | 模块 | 代码已证实 | 已明确 | 已实施待复核 | [模块设计](03-module-design.md#mod-03) |
| 8 | `SYS-01` | 跨语言 App 边界（以 Python 子进程双文件 App 纵切驱动） | 系统 | 长期演进风险 | 已明确 | 已实施待复核 | [系统设计](02-system-design.md#sys-01) |
| 9 | `MEC-05` | 面向第三方 App 的外部协议兼容承诺与互通测试（接 `SYS-01`） | 机制 | 长期演进风险 | 已明确 | 外部 v1 已实施待复核，内部版本维持各自演进 | [机制设计](04-mechanism-design.md#mec-05) |
| 10 | `SYS-02` | 面向第三方沙箱的执行后端接口（Execution Backend SPI） | 系统 | 代码已证实 | 已明确 | 已实施待复核 | [系统设计](02-system-design.md#sys-02) |
| 11 | `CON-02` | Ref（观察期常量）表达简化，降低带内转义心智负担 | 概念 | 代码已证实 | 已明确 | 本地合同已实施待复核，真实模型指标暂缓 | [概念设计](01-conceptual-design.md#con-02) |
| 12 | `MEC-01` | 跨 App `public` Ref 动态改写工具 Schema 与缓存影响评估 | 机制 | 本机已验证实际格式与取值，线上缓存待实测 | 待实验确定 | 候选对比中，线上暂缓 | [机制设计](04-mechanism-design.md#mec-01) |
| 13 | `MEC-06` | 动态 Native Tools vs 稳定工具面（`run_code`/固定入口）对照实验 | 机制 | 本机已验证协议往返、收据与磁盘 | 待实验确定 | 候选对比中，线上暂缓 | [机制设计](04-mechanism-design.md#mec-06) |
| 14 | `MEC-03` | 有实际变更的大页面更新开销测量与增量必要性评估 | 机制 | 代码与基准已证实 | 已明确 | 完整帧 `已确认不改` / `diagnosticDigest` `已验证` | [机制设计](04-mechanism-design.md#mec-03) |

17 项议题的设计方向均已确定。Batch 1A 的 `MEC-03` 摘要优化已签收，完整帧协议维持现状。`SYS-03` 按审阅约定保留表中状态。IDE 与 Planning 的竞争写入、异常退出与重开已在真实 Worker 复测，待集中复核。Batch 1B、2、3 及 Batch 4 的本地工程验收已通过，交项目负责人复核。`MEC-01` 与 `MEC-06` 的默认策略维持现状。三家线上实验已暂缓。负责人签收后再同步 [AGENTS.md](../../AGENTS.md) 与模块 README。

---

## 四、逐点决策日志

| 日期 | 议题 ID | 关键讨论与最终决策 | 状态 |
| :--- | :--- | :--- | :--- |
| 2026-11-24 | 基线 | 确立 v3 讨论基线：AOTUI 定位为面向 Agent 的前端与状态投影运行时（优先封装 CLI/MCP）；不推倒重来；更正首轮 7 项事实/推论误差。 | 已确认 |
| 2026-11-24 | `CON-03` | 保留 `ViewRegion`（`static` / `dynamic` 及挂载期覆盖），不改名为 `volatility`。 | 已确认不改 |
| 2026-11-24 | `CON-04` | 暂不在内核引入 Job / 通用业务事件原语，继续复用语言/Web 异步能力 + 页面进度 + `requestAttention()`。 | 已确认暂缓 |
| 2026-11-24 | `SYS-04` | 不引入多观察者内核；多人/多 Agent 协作通过应用层或独立 App 实例实现。 | 已确认不改 |
| 2026-11-24 | `MEC-05` | 不强行把 6 套不同寿命版本号合并为单一数字；外部 App 兼容承诺留待 `SYS-01` 一起拍板。 | 部分确认 |
| 2026-11-25 | `SYS-03` | 小型状态存储移出通用启动和关闭合同的方向已确认。已核对 IDE 和 Planning 的实际用键、v1 恢复与 IDE 保存失败的反馈。建议升级时读回旧值，由 App 接手后续保存。旧版是否还需读取新版写入的会话状态，留待拍板。[方案与验收](02-system-design.md#sys-03) | 候选对比中 |
| 2026-11-25 | `SYS-03` | **最终拍板**：尚无外部开发者，不做 v1 旧数据迁移与新旧双写兼容。彻底从 Core / SDK / Runtime / `aoapp.json` 移除内置持久化合同（`state-session-v2`、跨线程存储代理、`better-sqlite3` 可选依赖与 `CloseReport.persistence`）；Host 仅通过普通 `launchConfig` 按需透传数据目录；`aotui-ide` 改用自有原子会话文件且在 `close()` 中如实暴露保存失败，`planning-app` 将 `activePlanId` 并入自有 `planning.sqlite`。 | 已选定待验证 |
| 2026-11-25 | `MOD-01` | **最终拍板**：选方案 A，将标准 `<view>`（带 `region`）、`<desktop>` 应用目录、投影后业务 Tools、可选标准 `system-*` 控制工具声明、默认指令以及可直接交给 `adoptTurn` 的页面名单统一收口到 `@aotui/runtime/adapters` 与 `aotui-stdio` 的无状态共享呈现出口；修正预算提示误把 UTF-8 字节数标成 `input tokens` 的问题。**同步修正核心规则**：正文因预算省略（`hint`）的页面同样暂停业务 Tool 与 Ref 资格（保留 `system-*` 窗口管理，预算允许后自动恢复，无需手动 `expand`）；Core 将 `{ receiverViews, refViews }` 合一为单一的 `activeViews`，仅本轮展示正文且已采用的页面有资格接收业务调用或提供 Ref。 | 已选定待验证 |
| 2026-11-25 | `MOD-02` | **最终拍板**：采纳全部三项减法且保留 `SemanticSnapshotReceiver` 为可独立测试的内部部件。1) Core 用通用的 `ActiveTurn.readPublicRefs(addresses?)` 取代 `readConsoleInputs`，Console 嵌套树拼装、先校验后去重和 `CONSOLE_INPUT_CAPACITY` 移回 `agent-driver-adapter`；2) 删除 `WorkerInteraction` 与 `forwardRequestSource`，由单 App 控制器负责观察前等待 Worker 刷新、并发观察拦截、默认超时和统一关闭，采用/调用/撤权共用同一 `InstanceInteraction`；3) 在公开 API、IPC 收包和 Host/App 回调返回值入口集中捕获，按规则一致性适度复用 helper，保留授权前后与进入 handler 前全部实时复查。 | 已选定待验证 |
| 2026-11-25 | `MEC-04` | **最终拍板**：选方案 A。TS 提供可跨阶段持有的 `desktop.createCandidateScope()` 及 `[Symbol.dispose]()`（保持 `ES2022` 纯 TS 消费者零 `TS2550` 回归）；`aotui-stdio` 提供带显式 `scopeId` 的 `beginCandidateScope` / `discardScope`（防止同连接嵌套试算误清外层候选，且保留已采用候选在 `stdio` 表中的实例核对记录）。作用域关闭后迟到返回的 `observe()` 立即丢弃；采用失败后留于作用域重试子集须重新生成 Messages/Tools 与测预算；自动 dispose 遇非空清理问题抛带原错误码异常，不静默吞错；不引入超时 TTL 淘汰。 | 已选定待验证 |
| 2026-11-25 | `CON-01` | **最终拍板**：选方案 C。`@aotui/sdk` 根入口提供纯 TypeScript，作为官方唯一的 App 开发方式；彻底移除 Preact 适配层、444 行 `render-commit.ts` 私有钩子劫持、`linkedom` 依赖及 Preact 专用的 `readPreparedProjection()` / 恢复核对分支（保留 `readPreparedViewId()`）；页面正文用 Markdown 字符串与普通函数，JSX 模板暂缓，按重复痛点按需提取小型格式化函数。补齐纯 TS 同页动态改 `name` 保留 `viewInstanceId` 能力；以 `terminal-app` 为首个迁移验证样例，最终以 4 个 Demo 迁移 + 干净 Coding Agent 盲测双文件 App 验收。 | 已选定待验证 |
| 2026-11-25 | `MEC-02` | **最终拍板**：选方案 A。随 `CON-01` 退役 `restore` 恢复核对分支、`retainViews` 与 `readPreparedProjection()`；`prepareOpeningProjection` 准入条件定为“当前有健康投影（`!this.fault && previous`）+ 候选含至少一个新页面实例（按 `viewInstanceId` 判定，允许一次提交内换页如 `search`）”，仅触及 `OBSERVATION_CAPACITY` 时返回 `{ status: 'rejected', issue }` 并保留旧整套页面，其余错误与已处故障态走错误路径；以 `readViewId(handle)` 替代 `readPreparedViewId(viewType, name)` 解决同名页歧义；官方示例采用“同份候选状态驱动所有视图渲染、成功后再落盘为正式状态”的零 `undo()` 范式。 | 已选定待验证 |
| 2026-11-25 | `MOD-03` | **最终拍板**：选方案 A，且 `refParam` 选做法 1（直接在纯 JSON Schema `properties` 中组合 `refParam('Note', schema)`，暂缓 `objectSchema()` 与逐字段第三方库识别）。固化 AOTUI JSON Schema 2020-12 受支持子集与随包发布的测试向量；`@aotui/sdk` 实现零必装第三方 peer，支持纯 JSON Schema、`StandardJSONSchemaV1`（按 `draft-2020-12` 仅在 SDK 作者入口导出、剥离顶层匹配 `$schema` 与 `~standard`、handler 类型跟随 `InferInput`、未知导出关键字带路径报错，未写入 JSON 的 `refine`/`transform` 归 App 自检）与放宽后的可选 TypeBox；三路写法均在工具根写明 `additionalProperties` 策略，并以 `ES2022` + `skipLibCheck: false` 独立安装验收。 | 已选定待验证 |
| 2026-11-25 | `SYS-01` | **最终拍板**：选方案 A + 做法 1。保留现有 Node Worker 不动，新增可信 Host 登记固定参数列表的命令入口（`openApp` 才启动，协议逐行走 `stdin`/`stdout`、日志走 `stderr`，`aoapp.json` 新格式暂缓），Python 首版交付可执行且易读的双文件最小参考 App（暂不发 Python SDK）。实测发现 Python `json.dumps` 空格与 Unicode 转义会导致内部复合键被拒，确认此类内部拼写须集中在适配层。明确区分未执行（`not-entered`）、等待超时通道仍活（`INVOCATION_WAIT_TIMEOUT`，后续可查收据）与进程/管道终止无有效回执（`unknown`，禁重发）；关闭时须读完管道残留回执、确认直接子进程真实退出且在途结清后才报 `resourcesReleased: true`。 | 已选定待验证 |
| 2026-11-25 | `MEC-05` | **最终拍板**：选方案 A。划清三类边界：1) Runtime 与随包 Node Worker 及内部快照格式继续精确匹配随发；2) 第三方 App 进程协议与外部 Host `aotui-stdio` 为两份独立公共协议，各自拥有身份、主版本与独立定稿节奏；3) 当前 `@aotui/sdk` / JS 工厂 / `aoapp.json` 在外部 `v1` 定稿前继续同批配套交付（`state-session-v2` 与 SQLite v1 随 `SYS-03` 实施后退出内核）。外部 `v1` 遵守三条规则（主版本精确匹配且从真实 Python 端透传 `PROTOCOL_UNSUPPORTED` 诊断、握手交换可选/必需 `capabilities`、守住行为语义兼容而不只守 JSON 字段），须分别通过真正独立冻结的 v1 参考 App/Host 夹具“只替换 Runtime”互通验收后才宣布对应 `v1` 承诺。 | 已选定待验证 |
| 2026-11-25 | `SYS-02` | **最终拍板**：选方案 A。由可信 Host 在 Runtime 级统一配置后端并按安装项固定（首版 `openApp` 不覆盖后端，同一 App 可分别登记为 `files-local` / `files-sandbox`，沙箱启动失败绝不静默回退本机）。SPI 必须分开报告两件独立事实：**回执通道永久结束**（读完残余完整回执后将无终局证据的已派发调用立结 `unknown`，执行体仍活则继续占名额）与**执行体真实退出且通道排空（`exited`）**（仅归还一次名额并结合 Runtime 自有资源结清后才报 `resourcesReleased: true`）；先占名额再启动，已创建沙箱须有句柄兜底回收且监听从启动生效；以 Node Worker + Python 子进程共争同一名额及独立 Host 注入受控后端验收。 | 已选定待验证 |
| 2026-11-25 | `CON-02` | **最终拍板**：选方案 A。守住 Ref“观察期只读命名常量”单一概念，保留 `$ref.` 地址、从 0 开始数组下标 `people[2]` 与普通兼容参数跨页/跨 App 传值；顶层 `refId` 收紧为标准标识符 `[A-Za-z_][A-Za-z0-9_]*`（SDK 与 Core 统一校验，避免 `2fa` 或 `items[0]` 需方括号引号），载荷内部特殊键仍用 `["display.name"]`。**明确协议改动**：修复 `$$$ref.` 无法表达字面 `$$ref.` 的缺口，改为“引用照写，原文多加一个 `$`”（顶层普通参数或直接数组元素匹配 `/^\${2,}ref\./` 时剥离一个 `$`），同步覆盖 `const: "$ref.x"` 等受限字符串投影场景；后续模型评测分别统计选错元素、漏转义与“收据成功但最终内容错误”三项指标。 | 已选定待验证 |
| 2026-11-25 | `MEC-01` | **阶段定案（待实验裁决）**：保持策略 1（现行按需投影）为默认，不盲改；受限字符串含 `maxLength`/`const`/`enum` 的转义边界修复归 `CON-02`。锁定两步真实 Provider 对照实验（OpenAI / Claude 需显式核对 `cache_control` / DeepSeek，各与自身基线对比）：先做单换 A 目标 Schema 的隔离缓存重放（消除开关 B 页带来的目录/View/`run_code` 混淆），再跑含 `integer`、`enum` 与 `string[]`（必拆“整组直传”与“混合单项”及错型数组三题）的真实双 App 任务；裁决优先级为先看能否正确直传、再看每成功任务总费用与误调率，差异落入波动范围则保持策略 1。 | 候选对比中 |
| 2026-11-25 | `MEC-06` | **阶段定案（待实验裁决）**：锁定四组真实模型对照评测：组 0（传统按需 `read`/`edit` 追加历史，含 1 短 1 反复改长任务，评估 AOTUI 端到端收益）、组 A（动态 Native Tools 基线）、组 B（各家官方延迟加载：Claude Messages `defer_loading` + 关页合法性/缓存与可选 `tool_result` 引用、OpenAI Responses 重点测 `additional_tools` 并区分 Hosted/客户端搜索、DeepSeek 按端点分组）、组 C（**固定分发工具与 `run_code` 分开记分**，须先核对完整工具表并修清 `run_code` 说明抖动与 `imports.maxItems` Strict 预检缺口）。守住 Core/Driver 边界（“看过工具”与“本轮有权对哪一页调用”分离）。组 B 第一道验收须先补齐 Driver 协议往返（避免服务端搜索被 Host 重执行或丢搜索结果块）；最终以同一道含后台开页的双文件题按四项指标裁决（旧调用写盘直接判不通过）。 | 候选对比中 |
| 2026-11-25 | `MEC-03` | **最终拍板（方案 A + 做法 2，分两条结论落盘）**：1) **完整帧原子提交协议**记为 **`已确认不改`**——本地 Worker 单独测完整帧往返 p50 仅 `0.11–0.59 ms`（即便 10×48 KiB 或 200 Refs），收益远撑不起跨语言补丁/漏帧恢复复杂度；且传整帧还是补丁不改变发给模型的 Messages/Tools。2) **优化 `diagnosticDigest`** 记为 **`已选定待验证`**——改用两个 32 位整数算位一致的 `fnv1a64:...` 摘要（临时副本实测近 500 KiB 整轮中位耗时从 `21.85 ms` 降至 `15.02 ms`，66,068 组输入输出逐位一致），落地时同步修正 [snapshot-processing.mjs](../../runtime/scripts/snapshot-processing.mjs#L54) 依赖拦截 `BigInt.asUintN` 推算摘要调用次数的计数方式。同时写准容量边界：`704 KiB` 限 `Observation`、完整快照默认上限为 `4 MiB`（实测 965 KiB 合法快照对应仅 3.9 KiB Observation）；未来若启用 Python 子进程或远端后端须在对应链路上重测传输成本，高密度 Ref（200 Refs 余约 42 ms）留待成实际负担时再分项剖析。 | 完整帧 `已确认不改` / 摘要 `已验证` |
| 2026-11-25 | Batch 1A 验收 | **`MEC-03` 摘要优化已签收；`SYS-03` 内核存储已移出，IDE 与 Planning 的并发及异常退出恢复待修（1A 返修验证后待审阅方集中复核签收）**：内核与消费端基线（`core` 703/703、`sdk` 210/210、`runtime` 514/514、`scripts/release-local.mjs` 四档干净包与 `runtime/scripts/snapshot-processing.mjs digest` `0/1/0`、无钩子近 500 KiB 整轮 p50 从 `26.276 ms` 降至 `17.440 ms`）已验证；`SYS-03` 在初轮 `aotui-ide` / `planning-app` 回归之外发现 `IDESessionStore.read()` 两步读取 TOCTOU 竞态与 `withLocks`/`withDbLock` Worker 异常退出锁回收缺口，已转入 1A 返修并在实测验证后提交审阅方复核签收；[AGENTS.md](../../AGENTS.md) 与受影响包 README 已按内核无存储合同回写。 | `MEC-03` 已签收 / `SYS-03` 返修待签收 |
| 2026-11-25 | Carbon Review + GPT 复核 | **5 项设计/验收补充落盘**：1) **`MEC-02` 普通 App 故障恢复**：采纳“无后台定时器的普通 App 如何走出投影故障”用例，否决“故障后自动沿用旧健康页继续调工具”；业务已确认写盘并保留收据时，App 可在当次调用重建可显示降级帧并在下轮采用恢复工具，否则 Host 报错并允许正常关闭重开（旧健康帧仅供诊断）。2) **`MOD-01` / `MEC-05` `aotui-stdio` 并发与提醒**：去外层串行循环按请求 `id` 并发分发并推送 `desktop.output` 异步信号（含 `requestAttention()`），`python-host.py` 按 `id` 分流回复与事件，**不新增单 App 排队系统**（保持单 App 串行）。3) **`CON-02` / `MEC-01` 同 App 字符串枚举保护**：本地对照证实目标页获准读含字符串字段的 `protected` Ref 时 `mode` 枚举退化为裸 `string`（不可达 `private` 不影响），纳入实验对照组：保住合法 Ref 传值同时保留枚举提示且不放行 `"turbo"`。4) **`MOD-01` 统一 `view_id` 拆包路由**：共享适配器与 `aotui-stdio` 按当轮工具表统一拆包并沿用原实例/轮次/调用编号。5) **克制边界**：Markdown 工具按 `CON-01` 遇到第二个重复需求时再提取（正文伪造文本不授予权限）；200 Ref 下 41.99 ms 未单测编译占比且跨 Worker 对象身份变化，`compileValueSchema` 缓存待真成瓶颈后再剖析，调高上限属独立产品决策。 | 已补充 |
