# AOTUI Infra 化评估：从“产品内框架”到“可被广泛采用的运行时”

> 视角：系统架构 / 框架架构，长期主义  
> 范围：只讨论 SDK 与 Runtime，忽略 Mobile 与 Agent Driver  
> 日期：2026-10-28  
> 方法：读根目录文档、`runtime/docs`、`sdk/docs`、RFC 与部分实现；跑 SDK / Runtime 测试；核对包入口、发布状态、构建产物与 IDE 的 legacy / scoped 两条入口。

---

## 0. 判断

先说结论：

> **现在的 AOTUI 是一个“有 Infra 潜力的产品内框架”，还不是 Infra。**
> 它已经拥有一个相当扎实的语义内核（SnapshotCore / ViewOwnedTools / ScopedInteraction）、一套真实的资源生命周期，以及一个复杂到足以暴露问题的 IDE。但它离“被广泛采用的 Infra”还差三样东西：**更小的契约、更单一的路径、更外部的证据。**

如果用 Infra 的标准问三个问题：

1. **别人能不能只依赖一个稳定、可理解、可版本化的契约？**  
   现在不能。契约是有的，但它被包在 3/4 参 API、legacy/semantic 双平面、多个包入口和大量内部概念里。
2. **别人能不能在自己的环境里用它，而不是搬到你的宿主里？**  
   部分可以。`@aotui/runtime/core` 是纯的；但默认 SDK 是 Preact/DOM，默认 Runtime 是 Node/Worker，默认产品是 Agentina。**纯 Core 是“存在”，不是“主路径”。**
3. **别人能不能相信它长期不变、可复现、可调试、可运维？**  
   还没有。构建产物与源码漂移、包发布滞后、没有公开的 conformance suite、没有产品级性能/可观测性承诺、没有看到公开的治理与兼容政策。

所以我的判断是：

| 维度 | 当前判断 | 一句话理由 |
|---|---|---|
| 语义内核 | **强** | 身份、绑定、观察、回执、资源所有权都写进了代码，不是概念 |
| 工程纪律 | **强** | 关闭报告、容量、租约、失败分类，很多商业框架都做不到 |
| 契约收敛 | **弱** | 双平面 + API 面过宽 + 概念密度过高 |
| 可移植性 | **中** | Core 纯，但默认路径与 Preact/DOM/Worker/Node 强耦合 |
| 可运维性 | **中弱** | 资源上限有，trace/metrics/inspector 没有 |
| 采用证据 | **弱** | 一个宿主、一个 IDE、少量下载、没有看到外部开发者/采用者的公开证据 |
| 治理/发布 | **弱** | 没有看到公开的 semver 政策、LTS、conformance、roadmap |

**一句话：它现在最像“一家公司内部长出来的优秀框架”，还不像“别的公司敢押注的基础设施”。**

---

## 1. Infra 的六个门槛

“Infra”不是“代码多、抽象多、文档多”。它是一组可被外部依赖的承诺。我把它拆成六个门槛：

| 门槛 | 含义 | 外部用户会问的问题 |
|---|---|---|
| **Contract** | 一个小的、稳定的、可版本化的公共契约 | 我依赖的到底是哪几个类型/方法？它们会怎么变？ |
| **Portability** | 不绑定某个 UI 框架、宿主、进程模型 | 我能不能在 Node / Browser / Edge / 自己的 Agent Loop 里用？ |
| **Semantics** | 身份、生命周期、失败、并发、幂等有明确保证 | 旧引用会不会指错对象？失败会不会被吞？关闭会不会泄漏？ |
| **Operability** | 可观测、可限额、可恢复、可压测 | 出问题我怎么定位？容量到了会怎样？重启后怎么办？ |
| **Adoption** | 干净安装、10 分钟跑通、迁移路径、示例 | 我今天能不能不读源码就跑起来？ |
| **Governance** | 版本、兼容、安全、贡献、发布节奏 | 我敢不敢把它放进长期架构？ |

AOTUI 在 **Semantics** 上已经明显高于同类原型；在 **Contract / Portability / Operability / Adoption / Governance** 上，还处在“内部框架”阶段。

---

## 2. 现状打分

以下评分是主观判断，用于横向比较，不是精确度量。

| 维度 | 分数 | 依据 |
|---|---:|---|
| 语义内核 | **8/10** | SnapshotCore、ViewOwnedTools、ScopedInteraction、五态回执、观察固定源 |
| 资源生命周期 | **8/10** | WorkerPool lease、Sandbox close report、persistence flush、App cleanup |
| 契约收敛 | **4/10** | 双平面；3/4 参；多个 hook；deprecated alias；240+ 个形如 CODE 的常量（含内部） |
| 可移植性 | **5/10** | `@aotui/runtime/core` 纯；但 SDK / 默认 Runtime 仍绑 Preact/DOM/Node/Worker |
| 可运维性 | **4/10** | 有容量与关闭报告；没有公开的 trace/metrics/inspector/重放 |
| 采用证据 | **2/10** | 一个宿主、一个 IDE、npm 下载量很小、没有看到外部应用/采用者的公开证据 |
| 发布/治理 | **2/10** | 没有 semver 政策、LTS、conformance、公开 roadmap |
| 长期可持续性 | **4/10** | 范围很宽、分支/工作树很多、维护面大 |

注意：**分数低不代表代码差。** 很多低分项是“产品化/生态化”问题，不是“实现能力”问题。但 Infra 的价值恰恰由这些低分项决定：别人不是被你的内核打动，而是被你的**可依赖性**打动。

---

## 3. 十个问题

我按“对 Infra 采用的杀伤力”排序，而不是按代码位置排序。

### P0-1. 双平面：系统有两个真相

这是最大的问题。

- Legacy plane：`Kernel.acquireSnapshot → SnapshotFormatter → AOTUIDrivenSource`；默认 IDE、Agentina 走这条。
- Semantic plane：`SnapshotCore → Observation → ScopedInteraction → ViewOwnedTools`；`scoped.ts` 走这条。

两条路径共享 Desktop / AppManager / Worker，但语义不同：

- Legacy 是 pull-based：`getMessages` / `getTools` / `executeTool` 各自取一份快照；没有 observationId / bindingId / 五态 receipt。
- Semantic 是 pinned-observation：`observe` 固定 revision 和 binding；`invoke` 只能使用这个 observation 的 binding；旧观察不会重定向。

对内部开发者，这意味着“你要先知道自己在哪一层”。对外部 Infra 用户，这意味着**同一个 Runtime 有两种行为，取决于入口和配置**。这是采用者最害怕的事情：不是功能少，而是“不确定”。

长期影响：

- 文档必须写两遍；
- 测试必须覆盖两套；
- Bug 会在两套里以不同形式出现；
- 用户无法判断自己拿到的保证是哪一套；
- 版本升级时，无法用一个兼容政策覆盖全部。

**改进方向：一个 App 实例只允许一个平面；新应用只走 semantic；legacy 只作为明确的兼容 adapter，不再作为默认。**

---

### P0-2. 契约没有收口：API 面太宽，且成熟度混杂

SDK 根入口有 25+ 组 export、20 个 hook 目录条目（含测试）、3 个 `experimental_` hook；`useViewTypeTool` 有 3 参和 4 参两种重载；`useDataRef` / `useArrayRef` / `useEntityRef` / `useResourceRef`（deprecated）/ `usePersistentState` / `persistenceManager`（deprecated）并存；`mountable/dynamic` 被导出但调用即抛错。

Runtime 侧也一样：根入口、`/spi`、`/adapters`、`/core`、`/adapters/memory-state-storage` 多个子路径；root API 仍有 legacy `acquireSnapshot` / `execute`，同时又有 `experimentalCreateAppScope`。`runtime/docs` + `sdk/docs` 已经 1,153 行，还没有算 RFC、验收记录和 IDE 文档。

这不是“文档多”，而是**公共表面太大**。Infra 的采用成本与公共表面成正比：

- 每多一个 export，就多一个兼容承诺；
- 每多一个重载，就多一种误用；
- 每多一个 experimental，就多一次“我该不该用”的犹豫；
- 每多一个 deprecated alias，就多一条迁移路径。

**改进方向：定义一个“Kernel Contract v1”，只包含 4–5 个公共原语；其余全部降为 adapter / internal。SDK 只保留一条推荐路径（3 参 View-local），4 参冻结为 legacy。**

---

### P0-3. 可移植性停在“Core 存在”，不是“Core 是主路径”

`@aotui/runtime/core` 是纯的：不依赖 DOM、Worker、Node、模型 SDK。这是非常正确的方向。

但默认 SDK 是 Preact/DOM；默认 Runtime 是 Node/Worker；默认应用是 Agentina；默认 IDE 是 Preact 组件。一个外部团队想在自己的 Agent Loop 里用 AOTUI，需要：

- 自己写 Producer（把业务状态投影成 `AppSnapshotV2`）；
- 自己写 ExecutionResolver / ExecutionBinding；
- 自己接 ScopePolicy；
- 自己处理 persistence / lifecycle / close；
- 自己理解 observation / binding / receipt。

这不是“可移植”，这是“可重写”。Core 的纯，是“内核可以脱离宿主”，不是“用户可以不搬到你的宿主”。

**改进方向：把 Core 做成主路径，把 Preact/DOM/Worker/Node 做成官方 adapter。至少提供两个官方 Producer：Preact 和 plain TypeScript；至少一个非 Node 宿主示例（HTTP / CLI / in-memory）。**

---

### P0-4. 失败语义碎片化

当前至少有四套失败表达：

| 层 | 表达 |
|---|---|
| Legacy Runtime | `OperationResult { success, error, data }` |
| Semantic Core | `Receipt` 五态 + `ExecutionFact` + `InvocationOutcome` |
| SDK | 抛 `Error`，code 在 message 或对象上；部分 API 明确 reject |
| Close / Persistence | `CloseReport` / `StateFlushReport` / `issues` |

每一套单独看都合理；放在一起，开发者需要学四套。更麻烦的是，同一个失败在不同层的语义不一致：

- legacy 的 `success:false` 曾经会被外层包成 `success:true`（现已修复 type tool 路径，但历史语义仍在）；
- semantic 的 `unknown` 不能被当成“未执行”；
- SDK 的 `REF_CONTRACT_UNSUPPORTED` 只给 code，没有 hint；
- close report 的 `ok:false` 与 `resourcesReleased:true` 可以同时存在。

Infra 的错误不是“抛个异常”，而是**契约的一部分**：调用者要根据它做恢复、重试、告警、审计。

**改进方向：一份错误目录（code / category / retryability / user action / docs URL），所有层共用；所有边界错误都带 `code`、`cause`、`context`；禁止 `console.error` 后继续假装成功。**

---

### P0-5. 可复现构建 / 发布缺失

当前工作树的状态很说明问题：

- `sdk/dist` 落后于源码，没有 `CreateIfAbsentOutcome`，导致 IDE 的两个 Jest suite 编译失败；
- Runtime 的 emitted SDK/Host/Worker 测试出现 `APP_INIT_ACK_INVALID` / `legacy-unverified` / `acceptedCapabilities` 不匹配；
- 上次核验 npm 上的包停留在 2026 年 3 月，当前代码已经走到 10 月；
- 文档要求“相同版本号不代表兼容”，要使用精确 tarball / SHA256。

从安全角度，这些是严谨的；从 Infra 采用角度，这是**灾难性的使用成本**。一个外部团队不会愿意为了试一个运行时，先学一套 tarball / lock / manifest / consumer 的发行流程。

**改进方向：一个干净的 `git clone` 后，`pnpm install && pnpm build && pnpm test` 必须全绿；用 pnpm workspace + changesets + lockstep 版本；发布 npm provenance；把“精确产物”作为内部验收手段，而不是外部用户的使用门槛。**

---

### P1-6. 可观测性 / 调试缺失

现在有容量、关闭报告、错误码，但没有：

- 一次 run / observation / invocation 的结构化 trace；
- `observationId → bindingId → invocationId → receipt` 的可视化链路；
- metrics（active scopes、observations、bindings、invocations、p50/p95、拒绝原因）；
- inspector / devtools；
- 可重放的 fixture；
- 日志脱敏与级别。

调试主要靠 `console.log`（Agent Driver 甚至打印完整 messages/tools；Runtime 也有不少 console）。对 Infra 来说，**可观测性不是附加功能，是采用的前提**：用户第一次集成失败时，能不能在 10 分钟内定位，决定他会不会继续用。

**改进方向：结构化事件 + OpenTelemetry exporter + 一个最小 Inspector；默认脱敏；错误码与 trace 关联；把“为什么被拒绝”做成可查询的事实。**

---

### P1-7. 性能 / 资源没有产品化

Runtime 有大量工程上限（Snapshot 32MiB、Observation 256KiB/256 bindings、Interaction 64MiB、Worker pool 10 等），文档也写了“这些不是产品 SLA”。这很诚实，但 Infra 需要反过来：

- 典型工作负载的 p50/p95；
- 内存 / GC / 快照复制成本；
- 100 / 1,000 / 10,000 View 的曲线；
- observe / invoke / close 的延迟；
- 背压与拒绝行为；
- 与 baseline（直接 tool call）的对比。

现在这些数字散落在验收记录里，没有一个公开的 benchmark suite。外部用户无法判断“它会不会拖慢我的 Agent”。

**改进方向：一个可复现的 benchmark（fixture + script + 结果表），覆盖 snapshot commit、observe、invoke、close、并发、内存；把预算写进 CI gate；每季度公开一次。**

---

### P1-8. 安全模型没有定义

当前事实：

- Worker 是执行隔离，不是权限隔离；App 仍可以调用 Node 能力；
- ScopePolicy 由 Host 提供；没有标准 policy 模型、权限 scope、审计持久化；
- 没有“可信 App / 不可信 App”的明确边界；
- 没有看到供应链签名 / provenance 的公开说明；
- 没有看到 threat model 文档。

对内部可信 App，这不是问题；对 Infra 广泛采用，这是必须先回答的问题：**我能不能运行第三方 App？如果不能，就要明确说“只支持可信代码”，并把这条写进采用契约。**

**改进方向：一份 threat model；两种模式（trusted / sandboxed）明确边界；policy 参考实现；权限 scope；审计日志；供应链签名。**

---

### P1-9. 采用路径缺失

外部开发者今天要做的步骤大概是：

1. 读 README / GUIDE；
2. 理解 Runtime / SDK / Driver / Host 四层；
3. 跑 setup.sh（安装、link、build、agentina link）；
4. 理解 `createTUIApp`、View、3/4 参 Tool、Ref、Persistence、Lifecycle；
5. 理解 legacy / scoped 两个入口；
6. 理解 snapshotShadow / experimentalInteractionModes / ScopePolicy；
7. 才能写第一个“能被 Agent 调用”的 App。

这不是 10 分钟，这是 1–2 天。Infra 的 adoption 曲线必须是“10 分钟 hello world，1 小时真实小应用，1 天生产集成”。

**改进方向：`npm create aotui-app` 或一个单文件示例；一个 View、一个 Tool、一个 observe/invoke 的 Controller；一个“不用 Electron、不用 Preact”的 plain TS 示例；一个“接到自己的 Agent Loop”的最小 adapter。**

---

### P1-10. 治理 / 版本 / 兼容 / 社区缺失

当前没有看到：

- 公开的 semver 政策（哪些包稳定、哪些 experimental）；
- LTS / 支持窗口；
- 兼容矩阵的公开版本；
- CONTRIBUTING / CODE_OF_CONDUCT / SECURITY；
- 公开 roadmap / RFC 流程（内部 RFC 很多，外部流程没有）；
- 发布节奏 / changelog；
- 外部 maintainer / adopter 名单。

Infra 的长期价值来自“别人敢依赖”。这需要治理，不是代码。

**改进方向：一个 `GOVERNANCE.md`、一个 `COMPATIBILITY.md`、一个 `SECURITY.md`、一个公开 roadmap；把 experimental 的退出条件写清楚；每个 minor 发布附 changelog / migration。**

---

### P2-11 到 P2-15：更长期的问题

这些不是当前最痛，但会影响 2–3 年后的 Infra 形态：

- **多租户 / 配额 / 公平**：一个 Runtime 多 Desktop、多 App、共享 Worker pool；没有 tenant quota、fair scheduling、noisy neighbor 隔离。
- **持久化 / 恢复 / 幂等**：invocation ledger 在内存；跨进程重启、崩溃恢复、远端 exactly-once 没有实现。Infra 需要明确“保证到哪一层”。
- **互操作 / 协议**：目前是库 + 私有快照格式；没有 wire protocol；MCP / AG-UI / MCP Apps 的适配是实验性的。要决定“库还是协议，还是两者”。
- **命名 / 定位**：`AOTUI` / `TUI` 容易让人以为是终端 UI，而核心是“Agent 的语义工作层”。名字会限制采用。
- **范围过宽**：Host、5 个 App、CLI、MCP、Skills、IM、语义内核、Harness 集成；维护面太大，真正的内核只占一小部分。

---

## 4. 改进方案：如果目标是 Infra，我会怎么投

### 4.1 先做“一个小而稳定的 Kernel Contract”

不要把“Runtime 的所有能力”都变成公共 API。Infra 的公共契约应该小到可以一页纸读完。

我建议只保留四个公共原语：

```text
Session      一个可信执行作用域（AppInstance + Scope + lifecycle）
View         一个可观察的语义视图（id + type + content + lifecycle）
Action       一个可执行的动作（name + input schema + target binding）
Observation  一次固定的世界切片（views + actions + revisions + receipt）
```

对应四个公共操作：

```text
open(session) -> view / observation
observe(session, selection) -> observation
invoke(observation, actionBinding, input) -> receipt
close(session) -> closeReport
```

其余概念——SnapshotCore、ViewOwnedTools、ObservationRegistry、ScopedInteraction、ExecutionBinding、Policy、Projection、Persistence——都应该是**实现细节**或**高级接入 API**，不是应用开发者的日常。

具体动作：

- 把 `@aotui/runtime/core` 提升为 canonical 包（例如 `@aotui/core`），只导出这四个原语 + 错误类型 + 版本；
- 把 Preact / DOM / Worker / Node 放进 `@aotui/sdk-preact` / `@aotui/runtime-node`；
- 把 `useViewTypeTool` 3 参作为唯一推荐；4 参冻结为 `legacy`，不再出现在新文档；
- 删除或隐藏 `mountable/dynamic`、deprecated alias；每个 experimental 写明退出条件；
- 用 `KernelContract@1` 做 capability negotiation；semver 只对公共契约承诺，内部实现可自由演进。

### 4.2 再做“一个平面”

Infra 最怕“两个真相”。在 12 个月内，我建议：

1. **新 App 只允许 semantic plane**；legacy 只作为 adapter，服务历史 App。
2. **scoped IDE 成为默认入口**；legacy IDE 只作为回退，并有明确退出日期。
3. **只保留一个 Snapshot 模型**（V2 / Observation）；legacy `SnapshotFormatter` / `indexMap` 只读兼容。
4. **同一 App 实例不允许混用两套权威**；如果必须迁移，用新的 AppInstance，不复用旧绑定。

这件事的收益不是“代码变少”，而是“用户只需要理解一套语义”。这是 Infra 采用的前提。

### 4.3 然后做“可验证的信任”

Infra 不是靠文档说服人，是靠可复现的证据。建议三件套：

**① Conformance suite（公开、可跑）。**

至少覆盖：

- 旧 observation 不重定向；
- 列表重排 / View 卸载 / 同 ID 重开，旧 binding 永远拒绝；
- 相同 invocationId 幂等，不同 input 冲突；
- cancel / close 返回 unknown，不自动重试；
- 容量拒绝不驱逐仍在承担去重责任的记录；
- policy 拒绝不进入 handler；
- close report 区分业务失败 / 资源释放 / 未知；
- Producer 一致性（Preact / plain TS 同一不变量）。

这套 suite 应该能对任何 adapter / host 跑，而不是只对内部 fixture 跑。

**② Benchmark（公开、可复现）。**

- snapshot commit / observe / invoke / close 的 p50/p95；
- 100 / 1,000 / 10,000 View；
- 1MiB / 4MiB payload；
- 并发 Scope / 并发 invoke；
- 内存 / GC / 快照复制；
- 与“直接 tool call + 手写状态管理”的 baseline 对比。

**③ 外部应用。**

不是再加一个 demo，而是 3 个“不是作者写的”应用：

- 一个 plain TS / HTTP producer（不用 Preact）；
- 一个非 Electron 宿主；
- 一个真实业务场景（工单、CRM、运维、文档）。

没有这三样，AOTUI 的“Infra”主张就只能靠内部叙事。

### 4.4 再做“可运维”

- **Trace**：每次 `observe` / `invoke` / `close` 产生结构化事件；带 `observationId` / `bindingId` / `invocationId` / `sourceRevision`。
- **Metrics**：active scopes、observations、bindings、invocations、拒绝原因、p50/p95、队列/容量。
- **Inspector**：一个最小 UI/CLI，能看“当前有哪些 App / View / Binding / Observation / Receipt”，以及“为什么被拒绝”。
- **Redaction**：默认不记录业务正文；只记录 ID、code、size、timing。
- **Recovery**：明确内存 receipt 的边界；如果要跨重启，提供可选 durable ledger，不要把“内存去重”说成“exactly-once”。

### 4.5 最后做“生态与治理”

- **MCP / AG-UI / MCP Apps 适配**：不是替代它们，而是把 AOTUI 的 semantic view / action binding 映射过去；至少要有一个可运行的 adapter。
- **文档按用户旅程组织**：Start（10 分钟）、Build（一个 App）、Integrate（自己的 Host）、Operate（trace/limits）、Migrate（legacy → semantic）、Reference（API）。
- **治理**：CONTRIBUTING、SECURITY、COMPATIBILITY、ROADMAP、release cadence；experimental 的退出标准。
- **命名**：如果目标是广泛 Infra，考虑把“AOTUI/TUI”作为产品名，把核心包命名为更中性的 `agent-view-runtime` / `semantic-ui-runtime` 之类；不要让“TUI”限制想象。

---

## 5. 12 个月路线（建议）

### 0–3 个月：把“可依赖性”做出来

1. **冻结 Kernel Contract v1**：四个原语、四个操作、错误目录、版本号。
2. **一个平面**：新 App 只走 semantic；legacy 标记为兼容；scoped IDE 成为默认。
3. **干净构建**：workspace + changesets + lockstep；`pnpm install && build && test` 全绿；发布 provenance。
4. **10 分钟 hello world**：一个 View、一个 Tool、一个 observe/invoke；不需要 Electron、不需要 Preact 也能跑 plain TS。
5. **公开 conformance 的第一版**：10 条不变量。

### 3–6 个月：把“可验证性”做出来

6. **Benchmark suite**：snapshot / observe / invoke / close / memory；公开结果。
7. **3 个外部应用**：plain TS、非 Electron host、真实业务。
8. **Trace + metrics + 最小 Inspector**。
9. **错误目录全链路落地**：code / hint / docs / retryability。
10. **SDK API 收敛**：3 参唯一推荐；4 参冻结；deprecated alias 移除计划。

### 6–9 个月：把“可扩展性”做出来

11. **第二个 Host**：不是 fork，而是用同一 Core 的 adapter。
12. **MCP adapter**：把 observation / invoke 映射到 MCP tools/resources。
13. **Security model**：trusted / sandboxed 两档；policy 参考实现；审计。
14. **Durable ledger（可选）**：跨重启幂等；明确保证边界。

### 9–12 个月：把“可治理性”做出来

15. **LTS / 兼容政策 / 发布节奏**。
16. **公开 roadmap / RFC 流程 / CONTRIBUTING / SECURITY**。
17. **生态案例 / 采用者名单 / 公开 benchmark 对比**。
18. **决定“库 vs 协议”**：如果要做协议，发布 wire spec；如果只做库，明确不承诺跨语言。

---

## 6. 长期主义：什么该做，什么不该做

**该做（会复利）：**

- 一个小的公共契约；
- 一套公开 conformance；
- 一个可复现 benchmark；
- 一套错误目录；
- 一个干净安装 / 发布链；
- 一批外部采用者；
- 一套治理与兼容政策。

这些资产会随着时间增值：每多一个采用者，契约更稳、测试更全、生态更强。

**不该做（不复利，甚至负复利）：**

- 继续加 Host、App、IM、GUI 功能；
- 继续维护 legacy + semantic 两个真相；
- 继续增加公共 hook / overload / alias；
- 继续用内部验收文档代替公开 conformance；
- 继续用“精确 tarball / 手工 prepare”作为外部使用路径；
- 在只有内部用户时追求“完整框架”；
- 在没有 benchmark 时宣称“更省 token / 更可靠”。

**长期主义的核心不是“做更多”，而是“让少数东西变得可信”。**

---

## 7. 结论

AOTUI 最值钱的资产，不是它已经写了多少行代码，而是它已经证明了三件很难的事：

1. **语义视图可以被运行时维护**（SnapshotCore / Observation）；
2. **对象身份和绑定可以被运行时保证**（viewInstanceId / bindingVersion）；
3. **资源生命周期可以被认真对待**（lease / close report / persistence）。

这三件事是 Infra 的“内核”。但它们现在被包在：

- 双平面；
- 过宽的 API；
- 过高的概念密度；
- 不完整的发布/治理；
- 缺少外部证据。

所以我最后的判断是：

> **AOTUI 不需要再证明“能不能做”，它需要证明“别人敢不敢用”。**
> 前者靠代码，后者靠契约、证据、治理和采用。

如果未来 12 个月只能做三件事，我会选：

1. **一个小而稳定的 Kernel Contract v1**；
2. **一个平面 + 一个干净构建 + 一个公开 conformance**；
3. **三个外部应用 + 一个非 Electron Host**。

这三件事做完，AOTUI 才有资格谈“Infra”。  
在那之前，它更像一个非常优秀的“内部框架 + 研究资产”——这本身很有价值，但还不是 Infra。

---

*本文只讨论 SDK 与 Runtime，忽略 Mobile 与 Agent Driver；两者的集成问题另文分析。*
