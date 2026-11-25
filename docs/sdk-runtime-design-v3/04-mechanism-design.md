# 04 · 机制设计（Mechanism Design）

本分册跟踪快照、Schema 投影、容量控制、轮次管理、版本兼容与缓存策略等底层运行机制。

---

<a id="mec-01"></a>
## MEC-01 · 跨 App `public` Ref 动态改写工具 Schema 与缓存影响评估

- **三维度状态**：问题证实度 `代码已证实（缓存影响待实测）` ｜ 理想态明确度 `待实验确定` ｜ 实现方案状态 `候选对比中`

**阶段定案（2026-11-25）**：**策略 1（现行按需投影）继续作为默认**，不凭猜测改动；受限字符串（`const` / `enum` / `maxLength`）的转义投影修复归 `CON-02` 确定落地；锁定下方两步真实 Provider 对照实验作为策略 1 / 2 / 3 的最终裁决依据。

### 现行事实与真实 Worker 实测基线
- 在 [tool-projection.ts](../../runtime/src/adapters/tool-projection.ts#L69-L119) 中：显式 `refParam` 与无约束普通 `string` 的 Native Schema 本身静态不抖动；仅非 `string`（`integer` / `number` / `boolean` / `array` / `object`）和受限 `string` 会随本轮可达 Ref 形状动态改写（[tool-projection.test.ts](../../runtime/src/adapters/tool-projection.test.ts#L16-L27)）。
- **双 Worker 通讯录 + 草稿箱实测**（另 50 项投影与 Provider 路由测试通过）：
  - 通讯录发布 `emails: string[]`，草稿 `to` 要求 `string[]`：
    1. **整组直传** `"$ref.contacts.book.emails"` → 一次调用写入全部邮箱且顺序正确（原始数组 Schema 会挡住字符串地址，现行动态投影允许提交）；
    2. **混合单项** `["copy@example.test", "$ref.contacts.book.emails[1]"]` → 正确写入两个邮箱（原始数组元素本即 `string`，无需改写即可提交）；
    3. **错型数组** `"$ref.contacts.book.numbers"`（`[2, 7]`）→ 动态投影仅判定双方均为数组而放行提交，Runtime 解引用后按业务 Schema 报 `REF_VALUE_UNSUPPORTED`（[snapshot-value-arguments.ts](../../core/src/tool/snapshot-value-arguments.ts#L95)），磁盘草稿保持原值。
- 本地编码捕获确认 OpenAI / Claude / DeepSeek 三家均能正确发出该组用例的 `strict: true` 与投影 Schema；同时发现**默认 Claude 请求当前未附带 `cache_control` 标记**，实测 Claude 缓存前须显式确认已带缓存标记。

### 三种待实验裁决的候选策略
- **策略 1（现行默认 · 按需动态投影）**：仅当本轮存在可达且形状相容的 Ref 时改写对应非 `string` / 受限 `string` 参数。
- **策略 2（按作用域/授权收窄跨 App 改写）**：同 App Ref 照旧按需改写；跨 App `public` Ref 默认仅流入 `string` / `refParam` / 开放类型，不自动改写其他 App 的非 `string` 或受限 `string` Schema（除非 Host 在 `grant.consumers` 显式授权）。须保留“未额外指定 `consumers` 时 `public` Ref 直接传值”的默认对照用例（[observation-types.ts](../../core/src/invocation/observation-types.ts#L32)）。
- **策略 3（始终静态附加 `anyOf`）**：凡允许接 Ref 的普通参数始终输出同一静态 Schema，彻底消除 Ref 引起的 Schema 抖动，但承受平时 `anyOf` 体积与模型误传类型风险。

### 锁定两步对照实验设计与裁决口径

1. **第一步 · 隔离缓存重放（单测“改一处 Schema 付多少钱”）**：
   - 直接开关 App B 页面会同时改动 View、`<desktop>` 目录、`system-inspect_ref` 与 `run_code` 说明（[semantic-aotui-driven-source.ts](../../agent-driver-adapter/src/semantic-aotui-driven-source.ts#L483)、[console-tool.ts](../../agent-driver-adapter/src/console/console-tool.ts#L44)），无法归因。
   - 改为从真实投影取出 App A 的两版工具声明，用同一份足够长的请求回放：固定模型版本、端点、Strict 设置、消息、工具名与顺序，**只替换 App A 的目标参数 Schema**；每组先预热确认原样重放有缓存命中，再多次配对比较“维持原声明”与“切换声明”。
   - 在 OpenAI、Claude Messages（确认实际携带 `cache_control`）、DeepSeek 上各自与自身基线对比，保存实际发出的工具声明与原始 `usage`（区分缓存读取、写入与普通输入）。
2. **第二步 · 双 App 真实任务评测**：
   - 题型覆盖 `integer`、`enum` 及必测的 **`string[]`（明确拆为“整组直传”、“混合单项”与“错型数组拒绝”三题）**，在多轮开关页场景下用三种策略跑同一组任务。
   - 分别记录：模型能否提交地址、Runtime 是否接受、首次调用与最终落盘内容是否正确、额外工具调用次数、每成功任务总费用与耗时；策略 2 必须单独区分“一次 Native 直传整组邮箱”与“先 `inspect_ref` 读值再手填完成”；Provider 预检拒绝（如字符串 `const`）单记为 Host 兼容性问题，不混入模型误调率。
3. **最终裁决顺序**：**先看能否正确直传，再看每个成功任务总费用与误调率**。若策略 2 省了缓存却迫使整组邮箱多绕一步，须将能力取舍单列评审；若策略 3 保住直传且总费用更低、误调率可接受，策略 3 可胜出；若差异落在重复实验波动范围内，保持策略 1。

---

<a id="mec-02"></a>
## MEC-02 · 开页容量拒绝时的作者恢复体验（Preact `revert` 负担）

- **三维度状态**：问题证实度 `代码已证实` ｜ 理想态明确度 `已明确` ｜ 实现方案状态 `已选定待验证`

**已拍板结论（2026-11-25）**：选方案 A。随 `CON-01` 彻底移除 Preact 双回调 `revert`、`restore` 恢复核对分支、`retainViews` 与 `readPreparedProjection()`；纯 TS 的 `prepareOpeningProjection` 将预期容量拒绝改为 `{ status: 'rejected', issue }` 返回值，按“当前健康 + 至少含一个新页面实例”判定（允许同次提交换页）；以 `readViewId(handle)` 替代按显示名反查的 `readPreparedViewId(viewType, name)`。

### 现行事实与验证基线
- Core 的 [coordinator.ts](../../core/src/projection/coordinator.ts#L214-L231) 已在提交前检查容量，拒绝时不调用 `plan.accept()`（公开多实例编号不空耗）。真实 Worker 基线验证证实：超容替换 `search` 可保住旧 `search` 的正文、工具、Ref 与实例身份；放得下的替换沿用 `search` 路由并令旧观察调用得 `VIEW_INSTANCE_REVOKED`；开 `fd_1` 后拒开超容页，随后成功开新页拿到 `fd_2`。
- 现行三处待改问题：
  1. [createApp.ts](../../sdk/src/app-factory/createApp.ts#L98-L106) 把 Core 的 `{ status: 'rejected' }` 重新抛成 `SnapshotDataError`，迫使作者手写 `try/catch` 判 `code`；
  2. 当前纯 TS 路径在投影**已处于故障态**时再试超限开页，Core 仍可能返回 `rejected`（见 [coordinator.test.ts](../../core/src/projection/coordinator.test.ts#L169)），掩盖原故障；
  3. [readPreparedViewId(viewType, name)](../../core/src/projection/coordinator.ts#L132) 按显示名反查，遇到多目录同名文件（如两个 `index.ts`）会因不唯一返回 `undefined`。

### 选定方案与关键细则

1. **Core 准入与故障优先规则**：
   - 退役 `restore` 分支、`retainViews` 标记与 `readPreparedProjection()`。
   - `{ opening: true }` 试探准入条件定为：**当前无故障且已有健康基线（`!this.fault && previous`）+ 候选帧按页面实例身份（`viewInstanceId`）至少含一个新实例**（允许在一次原子提交里用新实例换旧实例，例如连续搜索替换 `search` 页而不必先关再开丢掉可用旧结果）。
   - 满足上述条件且完整候选仅触及本 App 的 `OBSERVATION_CAPACITY` 时，返回 `{ status: 'rejected', issue }` 并完整保住提交前的整套页面；首次投影失败、纯修改旧页超限、重复 ID、非法 Schema、关闭后提交，以及**投影本就处于故障态时**，一律走错误路径让作者看见真实故障（再用 `prepareProjection` 提交有效帧恢复）。
2. **SDK 返回值分流 + `readViewId(handle)`**：
   - `prepareOpeningProjection({ views })` 按 Core 返回的 `status` 分流：成功返回 `{ status: 'prepared' }`，预期容量拒绝返回 `{ status: 'rejected', issue }`，其余真实故障继续抛错（防止误吞真 Bug）。
   - 用 **`readViewId(handle)`** 替代 `readPreparedViewId(viewType, name)`：直接从本 App 当前健康已提交的挂载表查询该 `ViewHandle` 对应的 `view_id`（[view-owned-tools.ts](../../core/src/tool/view-owned-tools.ts#L279)）；未提交、被拒、已卸载或属于其他实例的句柄返回 `undefined`。该 ID 可用于操作收据，Agent 的调用资格仍由 Host 实际采用的观察决定。
3. **零 `undo()` 官方示例范式（跨视图候选状态一致）**：
   - 因 `prepareOpeningProjection()` 在调用内同步执行每页 `render()`（[createApp.ts](../../sdk/src/app-factory/createApp.ts#L69)），若目录页读旧 `openFiles`、详情页传新文件 B，会造成同一帧里 B 已打开而目录仍写着“只打开 A”。
   - 官方示例明确示范：**目录页与详情页均从同一份候选状态渲染，确认 `status === 'prepared'` 后再将该候选状态落定为 App 正式状态**；拒绝时目录与旧页同步保住，彻底零 `undo()`。磁盘写入、子进程启动等业务副作用仍由 App 安排；`prepared` 仅代表本 App 投影准备成功，整次模型请求 Token 预算由 Host 另算。

### 验收标准（待实现后验证）

| 验收场景 | 应看到的结果 |
| --- | --- |
| 增页拒收与换页拒收/成功 | 容量仅够 1 页时，拒开 B 返回 `{ status: 'rejected', issue }`（`OBSERVATION_CAPACITY`），A 完好且多实例编号未空耗；超容替换 `search` 保住旧 `search` 实例与 Ref，放得下的替换沿用 `search` 路由并使旧观察调工具返回 `VIEW_INSTANCE_REVOKED`。 |
| 非容量错误与故障态优先 | 首次投影超限、单纯改大旧页、重复 ID、非法 Schema、关闭后提交，以及 App 已处于故障态时试开超容页，均走抛错/故障路径，不返回 `rejected` 掩盖故障。 |
| `readViewId(handle)` 精准查询 | 同显示名的两个 `index.ts` 分别返回各自精确 `view_id`（如 `fd_1` / `fd_2`）；未提交、被拒、已卸载或跨实例句柄返回 `undefined`。 |
| 跨视图一致的零 `undo()` 示例 | 打开 B 成功的同一帧内，详情出现 B 且目录同步列出 A、B；B 被拒时目录仍只列 A 且 A 页继续可用。 |

*(注：本轮两份现行 Core 测试共 25 项通过，并在真实 Worker 中验证了底层增页、换页与编号不空耗基线；新联合返回值、句柄查询、故障态优先及零 `undo()` 示例待实施阶段验收。)*

---

<a id="mec-03"></a>
## MEC-03 · 有实际变更的大页面更新开销测量与增量必要性评估

- **三维度状态**：问题证实度 `代码与基准已证实` ｜ 理想态明确度 `已明确` ｜ 实现方案状态 `完整帧 已确认不改 / diagnosticDigest 已选定待验证`

**已拍板结论（2026-11-25）**：选方案 A + 做法 2，拆为两条结论落盘：
1. **完整帧原子提交**：记为 **`已确认不改`**。一次提交把同一版的页面正文、Ref 与可用工具整体交给 Host；不引入跨线程/跨进程的增量补丁协议（否则每种语言都须维护基线版本与漏帧恢复，本地 Worker 实测收益远撑不起这份复杂度）。
2. **优化 `diagnosticDigest`**：记为 **`已选定待验证`**。用两个 32 位整数计算原有的 64 位 FNV-1a 摘要，保持 `fnv1a64:...` 输出逐位一致；Core 仍以完整规范化内容判断两帧是否相同（[store.ts](../../core/src/snapshot/store.ts#L227)），仅发布新快照时计算诊断摘要（[store.ts](../../core/src/snapshot/store.ts#L271)）。*(注：本次结论基于临时编译副本实测，仓库源码尚未修改。)*

### 现行机制与容量边界（澄清 704 KiB vs 4 MiB）
- 无变更路径：[worker-runtime/index.ts](../../runtime/src/worker-runtime/index.ts#L278-L328) 已合并普通 `view_updated` 通知，快照未变时通过 `PROJECTION_CURRENT` 返回短确认。
- **两层默认容量上限必须区分**：
  - **`Observation` 默认上限约 `704 KiB`**（[projection-limits.ts](../../core/src/snapshot/projection-limits.ts#L7)）：观察结果只列出 Ref 的地址信息与 Schema，不含 Ref 载荷值（[observation-projection.ts](../../core/src/invocation/observation-projection.ts#L97)）。
  - **完整快照默认上限为 `4 MiB`**（[snapshot-support.ts](../../core/src/snapshot/snapshot-support.ts#L9)）：Worker 快照携带完整 Ref 载荷值。实测 4 个各 `240 KiB` 的 Ref 构成合法快照约 **`965 KiB`**，对应 `Observation` 仅 **`3.9 KiB`**。
- **传输字节 vs 模型 Token 是两笔账**：只要最终发给模型的 Messages 与 Tools 相同，Worker 传整帧还是补丁，模型收到的输入完全一致。将来接入 Python 子进程（`SYS-01`）或远端执行后端（`SYS-02`）时，应在对应真实链路上单独重新测量传输成本。

### 本地 Worker 实测基线（Apple M2 Pro · Node v24.15.0）
- **测法**：用当前源码重新编译两套包（唯一差异是 `diagnosticDigest` 实现）；打开 1 个根页 + 10 个文件页，每轮通过真实 Worker 调用编辑工具在内存改第一页 1 个字符，再 `observe()`、`adoptTurn()`；两种实现交错运行，每档预热后取 40 轮并核对其余 9 页内容。最后一列为另起本地 Worker 预装真实捕获快照，实测“发一个小请求 → 收回完整帧”120 次的独立往返耗时（避免用整轮中位数减另一组实验均值推算纯 IPC）。

| 负载 | 原版整轮 p50 / p95 (ms) | 优化后整轮 p50 / p95 (ms) | 单独测完整帧往返 p50 (ms) |
| :--- | ---: | ---: | ---: |
| 10 × 20 KiB，20 个 Ref | 12.81 / 13.83 | 9.75 / 10.59 | **0.11** |
| 10 × 48 KiB，20 个 Ref | 21.85 / 24.46 | 15.02 / 16.27 | **0.13** |
| 10 × 20 KiB，200 个 Ref | 46.17 / 51.07 | 41.99 / 44.37 | **0.59** |

- **结论支撑**：
  1. 即便在 200 个 Ref 负载下，完整帧本地 Worker 往返也仅 **0.59 ms**（常规 10×20 KiB / 10×48 KiB 仅 **0.11–0.13 ms**），充分证明本地 Worker 无需增量协议。
  2. 在近 500 KiB 负载下，仅替换 `diagnosticDigest` 即可把整轮中位耗时降低约 **6.8 ms**（`21.85 → 15.02 ms`）。
  3. 200 个 Ref 场景下剩余的约 **42 ms** 属 Core 内部局部 CPU 开销，留待高密度 Ref 成为真实应用负担时再分别剖析 Schema 编译、校验与对象遍历，不提前做复杂化优化。

### `diagnosticDigest` 落地细则与验收标准（待实施阶段验收）
- **算法与位一致性**：在 [json.ts](../../core/src/snapshot/json.ts#L189-L195) 用无 `BigInt` 分配的两个 32 位整数完成原 64 位 FNV-1a 计算，保持 `fnv1a64:...` 输出与原实现逐位一致（临时副本已通过 **66,068 组字节输入**逐位一致性核对及现有 3 个快照测试文件共 **56 项**测试，含 [validator.metadata-boundary.test.ts](../../core/src/snapshot/validator.metadata-boundary.test.ts#L24-L27) 固定摘要断言）。
- **同步修正仓库基准计数**：现有 [snapshot-processing.mjs](../../runtime/scripts/snapshot-processing.mjs#L54) 通过拦截 `BigInt.asUintN` 推算摘要调用次数；替换算法后三档负载虽均发布了新摘要，旧脚本却全部误报为 `0`。正式落地时必须同步改准该基准脚本的计数方式，确保后续维护者能明确区分“算得更快”和“少算了一次”。
- **验收标准**：
  1. 现有快照单测与位一致性测试全通（`contentDigest` 十六进制输出逐位不变）；
  2. [snapshot-processing.mjs](../../runtime/scripts/snapshot-processing.mjs) 准确报告摘要调用次数（不再误报 `0`）并体现提速；
  3. 完整帧原子提交合同及 `PROJECTION_CURRENT` 路径无行为变更。

---

<a id="mec-04"></a>
## MEC-04 · 未采用候选的防泄漏机制与 Host 易用包装

- **三维度状态**：问题证实度 `代码已证实` ｜ 理想态明确度 `已明确` ｜ 实现方案状态 `已选定待验证`

**已拍板结论（2026-11-25）**：选方案 A。TS 侧提供可跨预算阶段持有的 `desktop.createCandidateScope()` 以及符合 `ES2022` 消费者兼容要求的 `[Symbol.dispose]()`；`aotui-stdio` 侧提供带显式 `scopeId` 的 `beginCandidateScope` / `discardScope`。不引入固定时间 TTL 淘汰。

### 现行事实与核心问题
- 已采用的旧 `ActiveTurn` 会在下一次 `adoptTurn()` 成功时自动退役（[request-sources.ts](../../core/src/invocation/request-sources.ts#L164-L192)）；且 Core 的 `candidate.discard()` 对当前已采用候选天然幂等且安全返回（[request-sources.ts](../../core/src/invocation/request-sources.ts#L127-L132)）。
- 真正的泄漏陷阱在于**已准备但最终未采用的 `ObservationCandidate`**（预算剔除、命名冲突跳过、采用被拒放弃或中途异常早退）：漏调 `discard()` 会永久占住该 App 在 [observation-registry.ts](../../core/src/invocation/observation-registry.ts#L345) 的唯一空余槽位，导致后续所有 `observe()` 失败报 `OBSERVATION_CAPACITY`（已通过真实 `aotui-stdio` 复现：准备 A、B 后只采用 A，B 再次观察确报 `OBSERVATION_CAPACITY`，显式丢弃 B 后恢复）。

### 选定方案与关键细则

1. **TS 侧：可持有的 `desktop.createCandidateScope()` + 兼容 `ES2022` 的 `[Symbol.dispose]()`**：
   - 选用可持有的作用域对象而非仅回调包装，以适配现有 Host 先由 `prepareContext()` 返回上下文、跨过预算试算、直到发送模型请求前才 `adopt()` 的异步生命周期（[semantic-aotui-driven-source.ts](../../agent-driver-adapter/src/semantic-aotui-driven-source.ts#L658)、[agent-driver-v2.ts](../../agent-driver-v2/src/core/agent-driver-v2.ts#L645)）。
   - **准备时**：`scope.observe(app)` 自动登记每个成功返回的候选；若作用域已关闭后一个尚在等待的 `observe()` 才返回成功，作用域立即丢弃该迟到候选，避免槽位泄漏。
   - **采用被拒时**：Host 可留在作用域内保留健康候选 A 重试，但从 `A+B` 改为只选 `A` 后，必须用 `A` **重新生成实际发给模型的 Messages、Tools 并重新核对预算**（省掉的是重新观察 A）。
   - **采用成功时**：准备作用域即可收尾，选中的 A 交由 `ActiveTurn` 持有，落选的 B 立即腾出槽位；等待模型思考时长本身绝不会让候选或轮次过期。
   - **清理错误不静默**：`using` 会忽略 `[Symbol.dispose]()` 的返回值，因此显式 `discard()` / `release()` 继续返回 `Issue[]`，而 `[Symbol.dispose]()` 在批量尝试完所有候选并汇总非空问题后，应抛出带原错误码的异常；若准备与清理双双失败需保留两份错误；若 `adoptTurn` 已成功，单独报告清理问题并保留已采用的 `ActiveTurn`（[现有清理错误合同](../../core/src/invocation/observation-registry.ts#L157)）。
   - **类型兼容性红线**：在公开声明中引入 `[Symbol.dispose]` 时，必须确保仅启用 `lib: ["ES2022"]`、无 Node/DOM 类型的纯 TS 消费者不会报 `TS2550`（[现有包消费测试](../../sdk/tests/package-consumer/verify-package-consumer.mjs#L89)）。
2. **`aotui-stdio` 侧：带显式 `scopeId` 的 `beginCandidateScope` / `discardScope`**：
   - 不采用全局 `discardUnadopted`，避免同一条串行连接中外层保留 A、内层辅助函数试算 B 失败退出时误清外层 A。
   - `beginCandidateScope` 分配仅在当前 stdio 连接内有效的 `scopeId`，`observe` 可传入 `scopeId` 登记候选，`discardScope` 幂等清理该批次中仍未采用的候选。
   - **保留已采用候选的实例核对表项**：批量清理时，已被当前活跃轮次采用的候选必须保留在 `stdio` 的候选核对表中，防止后续 `invoke` 做实例核对时误拒合法调用（[stdio.ts](../../runtime/src/stdio.ts#L138)）。

### 验收标准（待实现后验证）

| 验收场景 | 应看到的结果 |
| --- | --- |
| 多 App 部分采用 / 拒绝重试 / 异常早退 | 准备 A、B 仅采用 A（或早退/抛错），收尾作用域后未采用的 B 立即释放可再 `observe()`，已采用的 A 不受影响；A 健康、B 关闭导致 `adoptTurn([A, B])` 拒绝后，同作用域内剔除 B 重生成消息/工具并采用 A 成功。 |
| 嵌套作用域隔离与迟到 `observe()` | 外层持有 A、内层放弃 B，退出内层后 B 可重新观察且外层 A 仍可采用；作用域关闭后才结算的 `observe()` 被立即丢弃，槽位可再用。 |
| `stdio` 跨语言批次清理与调用核对 | Python `with` 块经 `beginCandidateScope` / `discardScope` 清理未采用候选，未采用 App 槽位立即可再观察，已采用 App 的 `invoke` 仍通过实例核对正常执行。 |
| 清理错误暴露 | 显式 `discard()` 返回 `Issue[]`；自动 `[Symbol.dispose]()` 遇非空清理问题抛带原错误码异常；批量尝试完所有候选再汇总，准备失败与清理失败同时保留，采用成功时保留已采用 `ActiveTurn`。 |
| 发布包编译兼容 | 实际发布包同时验证使用 `using` 的 Host 与仅开 `ES2022`、无 Node/DOM 的纯 TS 消费者（均零编译错误）。 |

*(注：本轮已在真实 `aotui-stdio` 上复现单槽位卡死与剔除重试路径，两份 Core 测试共 106 项通过作为底层行为基线；新作用域接口待实施阶段验收。)*

---

<a id="mec-05"></a>
## MEC-05 · 协议分层演进与外部兼容承诺（不强行合一版本号）

- **三维度状态**：问题证实度 `长期演进风险` ｜ 理想态明确度 `已明确` ｜ 实现方案状态 `已选定待验证`

**已拍板结论（2026-11-25）**：选方案 A。不把不同寿命的格式强行合一；清晰切分“内部随发边界”与“两份独立的外部公共协议（第三方 App 协议与外部 Host `aotui-stdio` 协议）”，JS/TS 工厂与 `aoapp.json` 在外部 `v1` 定稿前继续同批配套交付。对第三方 `v1` 的核心承诺是：**只要新版 Runtime 仍声明支持 `v1`，只用 `v1` 基础能力的旧 App 与旧 Host 无需重编或重生成清单即可原样运行**，且须由真正冻结的旧夹具实跑通过后才宣布对应 `v1` 承诺。

### 现行事实与实测基线
- 当前源码仍保留 6 个边界标识（[runtime/README.md](../../runtime/README.md#L233-L250)），其中 `state-session-v2`（[state-persistence.interface.ts](../../core/src/app/state-persistence.interface.ts#L4)）与 SQLite 记录格式 1（[sqlite-state-worker.ts](../../runtime/src/adapters/storage/sqlite-state-worker.ts#L25)）将在 `SYS-03` 实施后退出内核。
- `aoapp.json.version` 来自 App 自身包版本（[generate-aoapp.mjs](../../sdk/bin/generate-aoapp.mjs#L33)），仅改包版本不影响登记；改协议标识才触发兼容性检查。
- **错误透传实测缺口**：合法清单配上旧协议标识的 JS 工厂在打开时失败，TS 端可在 `cause` 中读到 `APP_AUTHORING_PROTOCOL_UNSUPPORTED`，但 Python 经 `stdio` 只收到笼统的 `INSTALL_FAILED`（[manager.ts](../../runtime/src/engine/app/manager.ts#L214)、[stdio.ts](../../runtime/src/stdio.ts#L46)）；当前 `stdio` 也可直接调用 `desktop`、尝试 `initialize` 返回 `METHOD_NOT_FOUND`。
- 现行跨语言基线（同批 Python Host + Runtime + TS 文件 App）与 25 项清单/Worker 生命周期测试均通过；但现有 [verify-turn-stdio.py](../../tests/fixtures/verify-turn-stdio.py#L19) 从被测 Runtime 包加载同批 Host 示例，双方一起更新，仅适合当前版本回归，不能替代跨版本冻结夹具测试。

### 选定方案与三类边界分工

| 边界 | 拍板口径 |
| --- | --- |
| Runtime 与随包交付的 Node Worker | `WORKER_PROTOCOL` 与内部快照格式继续精确匹配、随 Runtime 同步升级；外部 App 适配层负责转换，第三方无需感知内部快照版本号。 |
| 第三方 App 与 Runtime、外部 Host 与 `aotui-stdio` | 拆为**两份独立的公共协议**，各有独立协议身份、主版本、能力协商与定稿节奏（App 侧管发页面/接操作/交回执，Host 侧管观察/采用/调用/读结果），可分别达到 `v1` 门槛后单独宣布。 |
| 当前 `@aotui/sdk`、JS 工厂与 `aoapp.json` | 外部 `v1` 定稿前继续同批 SDK + Runtime 配套交付，保留现行精确校验，暂不维护多代 `view-type-tools-vN`。将来若额外承诺“旧 TS 安装包直接运行”，须单独保存真实打包产物由新版 Runtime 安装运行验收（Python 进程协议通过不自动等同于 JS 工厂跨版本兼容）。 |

### 外部 `v1` 三条演进规则
1. **先核对协议身份与主版本，且错误直达调用方**：主版本不匹配在第一笔业务操作前拒绝，返回稳定错误码 `PROTOCOL_UNSUPPORTED`，并明确告知请求版本与对端支持范围（必须从真实 Python 端验证透传不被 `INSTALL_FAILED` 吞掉）。纵切阶段使用明确实验标识，跑通后再定正式 `v1` 字段。
2. **握手交换 `capabilities`，未声明新能力按 `v1` 基线运行**：新功能经双方握手确认后才启用；旧端不认识的可选能力可继续工作；若新端**必须**依赖某项能力才能正确工作，握手期明确指出缺失能力项。能力声明只决定消息支持范围，页面调用与 Ref 资格仍由当轮观察与执行端复查裁决。
3. **同主版本守住行为语义兼容，不只守 JSON 字段**：仅在约定扩展位增加省略后保持原行为的字段才算兼容；改变核心行为语义（例如把“等待超时、稍后可查回执”改为“直接失败、可安全重试”）即便 JSON 字段零改动也属破坏性变更，必须升主版本。

### 外部 `v1` 毕业门槛与冻结夹具验收（待实施后分别验收）

| 验收门槛 | 验收要求 |
| --- | --- |
| App 侧公共协议门槛 | 跑通 `SYS-01` Python 双文件 App 全部验收（页面/Ref 资格、等待超时与最终未知、关闭排空），外部作者无需复刻 JS 复合键拼写。 |
| Host 侧 `stdio` 协议门槛 | 落地 `MOD-01` 与 `MEC-04`，由独立 Python Host 验证 XML 呈现、可调用页面（`activeViews`）与批次候选清理。 |
| 真正冻结的跨版本夹具互通 | 独立保存首个 `v1` 的冻结参考 App、冻结参考 Host、Schema 与 XML 测试向量副本；后续升级**只替换 Runtime** 直接运行旧夹具，并同步覆盖主版本错误（透传 `PROTOCOL_UNSUPPORTED`）、可选能力缺失（降级基线正常运行）与必需能力缺失（握手期明确拒绝）。 |

---

<a id="mec-06"></a>
## MEC-06 · 动态 Native Tools vs 延迟加载 vs 稳定工具面（`run_code` / 固定入口）对照实验

- **三维度状态**：问题证实度 `待实测` ｜ 理想态明确度 `待实验确定` ｜ 实现方案状态 `候选对比中`

**阶段定案（2026-11-25）**：记为**候选对比中**，暂不改内核主模式。锁定四组真实模型对照评测：**组 0**（传统按需 `read`/`edit` 追加式基线）、**组 A**（动态 Native Tools 基线）、**组 B**（供应商官方延迟加载/动态发现）与 **组 C**（固定分发工具与 `run_code` 分开记分）。线上胜负以实测数据裁决。

### 不变边界：SDK / Runtime Core vs Driver / Adapter
- **SDK 与 Runtime Core 继续守住同一条规则**：Agent 曾经看过某个工具，与它此刻是否有权对哪一页使用该工具，是两件独立事实。Host 基于本轮候选页面生成请求、核算预算，在请求发送前采用同一份候选（[agent-driver-v2.ts](../../agent-driver-v2/src/core/agent-driver-v2.ts#L645)）；实际执行仍必须经过 `ActiveTurn` 与执行端页面实例复查（[view-owned-tools.ts](../../core/src/tool/view-owned-tools.ts#L125)）。
- 供应商侧如何延迟声明、按需展开或缓存工具，完全归 **Driver / Adapter 层**承接，不回流污染 App 业务契约与 Core 授权裁决。

### 本地协议拦截基线（已证实的 Driver / Console 缺口）
- **Claude 编码与响应重建**：当前 Claude 编码器能发出真正的 `tool_reference`，但把同名 JSON 放进普通 App 收据时发出去仅是一段文本（[agent-driver-v2.ts](../../agent-driver-v2/src/core/agent-driver-v2.ts#L815)）；向当前 Driver 喂入模拟的 Claude 服务端搜索响应后，Driver 把“服务端搜索”和 `edit_file` 都还原成普通工具调用，并在历史里丢失了搜索结果块（[llm-client.ts](../../agent-driver-v2/src/core/llm-client.ts#L336)）。
- **OpenAI 编码**：当前已安装的 OpenAI 编码器未把测试指定的 `defer_loading` 与 `tool_search` 实际发到线上请求。
- **`run_code` 工具面抖动与 Strict 预检**：当前 `run_code`（[console-tool.ts](../../agent-driver-adapter/src/console/console-tool.ts#L43)）在开页前后参数 Schema 虽不变，但 **`description` 文字会随页面变化**；且其 `imports.maxItems` 过不了仓库对 Claude Strict 和 DeepSeek Strict 的本地预检。

### 四组对照实验设计与关键修正

| 实验组 | 定义与关键约束 |
| :--- | :--- |
| **组 0（传统 Append-Only 基线）** | 传统 `read`/`edit` 按需读取、结果追加进历史（**不是**把 AOTUI 每版 View 快照追加进历史），用于单独衡量“AOTUI 整体是否值得接入”。必测 **1 条短任务 + 1 条反复改文件的长任务**，双方使用同一模型、同一文件后端、同一预算，按相同的最终磁盘文件内容判分。 |
| **组 A（动态 Native Tools 基线）** | 现行做法：随本轮已采用页面动态增删顶层业务工具定义。 |
| **组 B（供应商官方延迟加载）** | 按三家真实协议能力分别适配（见下方细则），并在进入成本对比前**先通过第一道协议往返验收**。 |
| **组 C（稳定固定工具面）** | **固定分发工具与 `run_code` 分开记成绩**（`run_code` 可靠一段脚本完成多步操作，省下的轮次来源不同）。两者都必须核对最终发出的**整张工具表**（含系统工具、顺序、说明与 Schema），确保入口确实通过 Strict 预检到达模型后再比较费用。 |

#### 组 B 三家协议细则与第一道验收门槛
1. **Claude Messages**：延迟工具仍需随请求提交完整定义（`defer_loading: true`），API 会在历史 `tool_reference` 所在位置展开它；若历史里仍引用 `edit_file`，本轮却删除对应定义，Anthropic 官方明确列为 **HTTP 400**（[Tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) · [Prompt caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)）。重点实测：最后一页关闭后，适配器能否构造合法的下一轮请求同时让旧工具退出本轮可用操作，以及对应的缓存开销；开文件后在真实 `tool_result` 中附带 `tool_reference` 保留为“省一次搜索”的候选，首次启动或后台开页（无对应回执）从下一轮真实观察进入发现流程。
2. **OpenAI Responses API**：最贴合 AOTUI 主动开页的是 **`additional_tools`（`role: "developer"`）**——当 Host 已明确知道文件刚打开即可在指定位置注入新工具，无需等模型先搜索（[OpenAI Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)）。同时区分另两条路径：Hosted 搜索（同一响应完成）与客户端搜索（回传匹配 `call_id` 的 `tool_search_output`）；留意官方说明从原加载记录移除工具会让缓存从修改处往后失效，且单独延迟函数起初仍暴露名称与说明、主要延迟参数 Schema。
3. **DeepSeek**：按实际端点分组。仓库当前 DeepSeek Chat 路径先测组 A / 组 C；DeepSeek 官方 V4.1 协议实现已列出 Messages 延迟工具与 Responses 客户端工具搜索（[CHANGELOG](https://github.com/deepseek-ai/deepseek-recipe/blob/main/CHANGELOG.md)），其他端点可作为组 B 候选按所选模型与实际请求验证。缓存必须以服务端已保存前缀与返回命中数据为准（[DeepSeek KV Cache](https://api-docs.deepseek.com/guides/kv_cache/)），不可仅凭 HTTP JSON 是否逐字节一致推算。
4. **组 B 第一道验收门槛（Driver 往返完整）**：在正式评测前，必须验证连续两轮真实请求与历史回放的编解码全部完整，且**服务端已经执行过的搜索绝不会被 Host 再执行一次**。

### 统一裁决题与四项记分指标（待线上实测）
- **标准双文件裁决题**：打开 `A.txt` → 打开 `B.txt`（两页共用同一把 `edit`）→ 关闭 `A` 后编辑 `B` 成功、对 `A` 的旧调用被拒 → 关闭 `B` 后最后一个 `edit` 退出 → 重开同名文件并发送绑定旧实例的调用，核对磁盘字节未被修改 → **另加一次后台开页**覆盖无 `tool_result` 的路径。
- **控制变量与四项记分**：
  - 各模型固定同一套 Ref 投影策略（与 `MEC-01` 解耦）和相同上下文预算，分别记录缓存读写、客户端额外往返与服务端搜索次数。
  - **四项核心结果**：
    1. **协议合法性**：API 是否接受该轮请求；
    2. **模型误调数**：模型误调已退场工具被框架拦住，记 1 次模型误调；
    3. **安全红线（一票否决）**：旧实例绑定调用若真的写进重开的新文件，**直接判该方案未通过**；
    4. **端到端性价比**：每个正确完成任务的总费用与总耗时。
