# RFC 0001：语义交互运行时的技术基线

日期：2026-10-19（Asia/Shanghai；官方及 npm 资料核验于 2026-10-18 UTC）  
状态：技术选型已形成；独立验证切片的结果见文末与 `experiments/semantic-kernel/VERIFICATION.md`。  
适用范围：AgentOrientedTUI 的下一代内核、SDK 和宿主适配。本文不表示现有产品已完成整体迁移。

## 1. 决定

采用 **TypeScript 7 + Node 24 LTS + Effect 4 稳定核心** 建立无 DOM 的交互运行时。公共 SDK 保持普通函数、Promise、AbortSignal 与可序列化的可判别结果；通过 **Standard Schema / Standard JSON Schema** 接受校验器，默认作者入口使用 **Zod 4**。

以 **AI SDK 7** 和 **MCP TypeScript SDK 2** 实现可替换的宿主接入。检查器采用 **React 19.3**；Preact 11 提供可选声明式绑定。桌面参考宿主迁移到受支持的 **Electron 44** 稳定线。数据持久化、遥测和构建工具保持独立边界。

选择的依据是：技术是否直接减少观测、身份、执行条件、生命周期和诊断方面的重复工作，以及升级时能否限制影响范围。补丁版本锁定在可复现的 lockfile 中；每次升级重新验证相关契约。

## 2. 官方资料与实际候选版本

| 层次 | 本次核验基线 | 决定与验证状态 |
| --- | --- | --- |
| JS 执行环境 | Node 24.22.0 LTS | 独立验证使用；Node 26 当前仍为 Current |
| 编译与类型检查 | TypeScript 7.0.2 | 独立验证使用原生 tsc；旧工具的 Compiler API 单独兼容 |
| 结构化执行 | Effect 4.0.5 | 使用 Scope、调用取消、资源 finalizer；只用稳定核心 |
| 公共 schema 接口 | @standard-schema/spec 1.1.0 | 验证接口与 JSON Schema 导出接口分别检查 |
| 默认作者校验器 | Zod 4.6.7 | 独立验证使用；核心不导入 Zod |
| 模型适配 | ai 7.0.143 | 独立验证通过官方 mock provider 驱动真实 SDK 工具回调 |
| MCP 接入 | client / server / core 2.3.1 | 独立协议适配；具体 wire 测试范围按验证记录说明 |
| 核心测试 | Vitest 5.0.5、fast-check 4.10.2 | 契约测试与可重放性质测试 |
| 检查器 | React 19.3 | 下一阶段；本轮未升级现有 GUI |
| JSX 绑定 | Preact 11.0.1 | 可选入口；本轮未迁移现有组件 |
| 桌面宿主 | Electron 44.9.0 | 当前稳定候选；真实桌面和打包验证后迁移 |
| MCP UI 增强 | MCP Apps 2.0.3 | 外围增强；非核心依赖 |
| 本地持久化 | SQLite + better-sqlite3 13.0.3 | 宿主适配器候选；本轮未验证原生模块打包 |
| 遥测 | OpenTelemetry JS Traces / Metrics | 可选导出；不承担执行去重的权威记录 |
| 库构建 | tsc；按分发需要引入 tsdown 0.23.1 | 切片先由 tsc 独占声明和 JS 输出；tsdown 不进入运行时 |
| 发布 | pnpm workspace + Changesets + 产物消费检查 | 现有 workspace 整理是后续迁移工作；切片单独锁定依赖 |

这些版本不是通过旧知识猜测：TypeScript、Effect、AI SDK、MCP SDK、Zod、测试库已经在 npm 注册表交叉核验，并为独立切片实际安装。GUI、数据库和完整发布链仍是待验证候选。

## 3. TypeScript 7 与 Node 24

TypeScript 7 已正式发布，不再按 preview 对待。它适合改善大型框架的类型检查和构建反馈，但不会自动提升应用运行时性能。启用 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes 和清楚的模块边界。

TS 7.0 尚未提供程序化 Compiler API。依赖该 API 的 lint、声明打包器、代码生成器要单独验证；必要时按官方方案并行使用 TS 6 兼容包。公共库首先保证发布的 JS 与声明可被消费者正确解析。

Node 24 是当前 LTS 基线。Node 26 的 LTS 转换按官方计划尚未发生；先加入兼容验证，再决定未来切换默认值。验证切片使用项目专用的官方 Node 二进制，并核对官方 SHA256；不依赖设备上的 Node 23。

## 4. Effect：承担内部生命周期，保持公共 API 普通

长期运行的应用实例、订阅、流式任务和取消操作需要明确的所有权。Effect 4 的 Scope、Fiber 和错误模型提供了现成的组合能力。

独立切片先采用最小集合：

- View 拥有订阅 Scope，关闭时撤销绑定并释放订阅。
- Invocation 拥有执行 Scope，结束、失败或中断时执行 finalizer。
- 外部 Promise 通过边界函数进入 Effect；AbortSignal 传到实际执行器。
- 对外仅返回 AOTUI 自己的结果类型；公共 `.d.ts` 不暴露 Effect 类型。

`activeCalls` 只统计运行时持有的作用域。普通 Promise 的异步 `finally` 可能在取消结果返回之后继续；Scope 关闭不保证任意外部操作已经终止。持久操作必须有自己的查询、取消和清理契约。

后续高频资源流确有需求时，使用有界 Queue / Stream 处理背压；不为了使用新库提前改造全部宿主代码。

Effect 4 正式发布不代表其每个扩展模块都稳定。Cluster、Workflow、标记 unstable 的能力暂不进入内核契约。

### 替代方案

原生 Promise、AbortController、显式 dispose 与普通类型联合更容易直接理解，也可替换内部实现。代价是团队自行承担资源归属、清理和并发竞态的组合工作。本项目的长期资源管理密度较高，因此推荐 Effect；通过独立切片验证收益后逐步扩展。

首版不再引入 XState 管理同一批任务。状态机仍以状态联合、纯转换和穷尽检查表达；如果检查器出现复杂并行交互，再在 UI 层评估 XState。

## 5. Schema：统一连接标准，避免强制一种 DSL

StandardSchemaV1 描述运行时验证；StandardJSONSchemaV1 描述输入和输出的 JSON Schema 导出。这是两项能力。

动作注册时同时检查二者，并导出 `input({ target: 'draft-2020-12' })`。不支持导出的类型在注册阶段报错，不静默退化为空 Schema。参数可以异步校验，但校验完成之后必须再次检查观测有效期和绑定所有权。

默认示例采用 Zod 4。类型转换发生后，执行器接收校验后的输出；模型收到的参数描述仍然表达输入。模型供应商只接受某个 JSON Schema 子集时，在宿主适配器转换，核心继续执行完整验证。

TypeBox 与 Effect Schema 都是可接受的替代入口；有对应标准能力才接入。不要同时维护多份表达相同业务规则的 Schema。

## 6. 观测和动作执行的契约

运行时发布不可变观测，包含视图、目标引用、动作绑定及原始资源版本。每次调用关联 `observationId`、`actionBindingId`、`invocationId` 和输入。

必须保持：

1. 引用在原观测内不重新解释；列表重排不会改指其他实体。
2. 动作定义可以共享，实例绑定有明确所有权。卸载 A 不撤销 B，重开 A 不复活旧绑定。
3. 状态敏感的写入由业务适配器执行原子条件更新。内核不能在调用时偷偷替换原始版本。
4. 无关资源变化不使整个桌面失效；额外业务依赖由资源或动作声明。
5. 调用结果区分 succeeded、rejected、failed、accepted 和 unknown。
6. 相同调用 ID 与相同请求返回原结果；相同 ID 携带不同请求报冲突。在容量不足时拒绝新调用，不通过清空去重记录再次执行旧写入。
7. 观测缓存和调试事件有明确容量。过期或淘汰的观测返回恢复线索。
8. 取消传到执行器，但已发生的外部效果不能自动撤销。执行开始后失去结果，要保留 unknown。

内存 CAS 示例只保证本进程的同步条件更新；跨数据库和远端系统的保证由各自适配器提供。稳定引用、Effect Scope、幂等编号与日志均不单独构成跨系统 exactly-once。

## 7. AI SDK 7：复用模型循环，保留 AOTUI 执行入口

AI SDK 负责供应商适配、流式响应和工具调用。AOTUI 负责观测与动作依据。

默认宿主先使用 ToolLoopAgent 及其现有 hooks。在步间重新观察时，工具回调必须仍绑定到产生该次请求的观测，不能访问一个随时变化的全局 latestSnapshot。

若内置循环不能表达要求的交接，才在适配器层调整控制方式。核心和公共应用 API 不出现 ModelMessage、Tool、UIMessage 或 provider metadata 类型。

v6 到 v7 的迁移需要检查 stream、onChunk、usage、toolCalls 及 finalStep 的语义，特别注意多 step 聚合与末步统计。模型层 mock 测试验证接口连接，不用于证明真实模型的任务质量或节省 Token。

本轮 AI SDK 切片使用绑定到单份观测的通用执行工具。具体动作 Schema 随观测提供，由内核执行完整校验；供应商 Schema 子集转换、流式调用和步间刷新观测尚未验证。

具体模型、供应商和网关由宿主配置；框架不把某个模型名称或云服务账号做成内核前提。

## 8. MCP SDK 2 与 MCP Apps 2

新适配器采用已经稳定的 MCP SDK v2 分包。SDK 版本、协商的协议版本、宿主实际支持的能力要分别记录。旧 v1 宿主通过独立迁移验证接入。

MCP 暴露观测与执行工具；调用带着原始观测关联信息进入同一个内核。资源是否立即进入模型上下文，仍取决于宿主。MCP Apps 负责可交互 UI 的扩展，不能替代 AOTUI 的引用、绑定、条件执行和结果契约。

InMemoryTransport 可验证 SDK 协议处理，但 current-era HTTP 行为应另用对应 transport 验证。所有测试范围以实际验证记录为准。

## 9. 检查器与桌面宿主

React 19.3 通过 useSyncExternalStore 读取运行时发布的不可变观测。GUI 不复制另一套业务状态。Preact 11 是可选 JSX 绑定，核心视图可以是普通数据结构。

Electron 44 稳定线适合现有 Node、终端、文件和 LSP 工作流。运行时可以通过明确协议放在 utility process，主界面负责检查和控制。进程分离不自动等于不受信任插件的权限沙箱。

Tauri 2 在轻量分发和系统 WebView 路线上有价值，但保留 Node 能力可能需要 sidecar 和跨架构交付。只有体积、移动或原生集成目标明确时，再使用真实工作负载比较。Rust / Wasm 同样根据 profiling 出现的 CPU 热点引入。

## 10. SQLite 与 OpenTelemetry：不同的职责

SQLite 适合作为本地 InvocationStore、观测记录和调试索引的默认实现，不强制接管应用业务数据库。better-sqlite3 13.0.3 是候选，须验证目标 OS、Node / Electron 和发布产物。Node 24 的 node:sqlite 当前仍为 Release candidate，暂不宣称 Stable。

参与恢复与请求去重的记录要有明确事务与掉电持久性。WAL 的 synchronous=NORMAL 与 FULL 存在持久性差异；不能仅复制性能配置。进程内存表不提供崩溃恢复。

OpenTelemetry JS 的 Traces / Metrics 已稳定；Logs 与 GenAI 部分约定仍处于发展阶段。核心先产生自己的版本化事件，再通过可选适配器导出遥测。抽样、批量导出的 spans 不承担去重的权威记录；完整观测和模型正文也不默认送入远程 span attributes。

## 11. 验证、构建和发布

采用 Vitest 验证结果、生命周期和适配器；本轮 fast-check 生成可重放的重排及无关对象修改序列，撤销、关闭和重开由定向契约测试覆盖。对真实 Worker、IPC、进程中断和数据库崩溃窗口，另加有针对性的集成验证。检查器 UI 使用 Playwright；其 Electron 自动化能力仍需要按实验性边界使用。

根工作区后续统一为实际包含核心、SDK、适配器和宿主的 pnpm workspace，内部依赖使用 workspace: 协议。发布版本用 Changesets 管理，CI 验证 tarball 安装后的公开入口。

独立切片以 TypeScript 7 tsc 同时生成 JS 和声明。若需要 bundling，再引入锁定的 tsdown。tsdown 与 tsc 明确各自输出职责；不让两个工具同时清理同一产物目录。tsdown 仍为 0.x，保持可替换。

不新增 tsup：其官方 README 已说明不再积极维护并建议 tsdown。publint / Are the types wrong? 可以补充检查，但不能替代实际消费包验证。

## 12. 有条件引入的技术

| 技术 | 何时有价值 | 当前边界 |
| --- | --- | --- |
| Temporal / durable workflow | 跨进程恢复、长时间等待、分布式执行器 | 长期操作适配器；不强制所有动作走工作流 |
| Yjs / CRDT | 协作文档、离线编辑、多端合并 | 特定资源适配；收敛性不能代替业务条件 |
| TanStack DB | 检查器或业务应用需要本地关系查询与乐观更新 | 当前 beta，外围评估；未确认乐观状态不得假装已提交 |
| Electric | 已有 Postgres，需要客户端读同步 | 读路径适配；写入和条件约束仍由业务提供 |
| XState | 复杂嵌套 / 并行 UI 流程与可视化状态图 | 避免与 Effect 同时管理同一个任务生命周期 |
| Rust / Wasm | 性能测量表明投影、解析、序列化存在 CPU 瓶颈 | 明确 FFI 边界后局部引入 |

## 13. 首次落地与后续门槛

本轮新增独立目录 `experiments/semantic-kernel`，使用新依赖验证核心契约和真实 SDK 接入。它是技术及契约切片，不是生产替代内核。26 项测试、250 组生成序列、类型检查、构建、演示和独立 tarball 消费验证已通过，详细结果见 `VERIFICATION.md`。

后续按证据推进：

1. 核心契约和 SDK 适配切片通过；记录准确的验证范围。
2. 将现有一个实际应用迁移到新接口，并运行在 Agentina 和独立宿主。
3. 接入持久化执行记录、Inspector 和真实进程边界。
4. 做真实模型任务评测与发布产物消费验证，再扩大迁移范围。

技术基线的价值必须由开发者集成成本、错误定位能力和真实业务后置结果来证明。

## 14. 官方来源

- TypeScript 7 正式发布及 Compiler API 边界：https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- Node 发布状态：https://nodejs.org/en/about/previous-releases
- Node LTS 排期：https://github.com/nodejs/Release/blob/main/schedule.json
- Effect 4 发布与模块稳定性：https://effect.website/blog/releases/effect/40
- Effect v4 Scope：https://effect.website/docs/v4/resource-management/scope
- Effect v4 异步与中断：https://effect.website/docs/v4/getting-started/creating-effects
- Standard Schema：https://standardschema.dev/schema
- Standard JSON Schema：https://standardschema.dev/json-schema
- Zod JSON Schema：https://zod.dev/json-schema
- AI SDK 发布：https://github.com/vercel/ai/releases
- AI SDK v7 迁移：https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0
- MCP TypeScript SDK：https://github.com/modelcontextprotocol/typescript-sdk
- MCP Apps 发布：https://github.com/modelcontextprotocol/ext-apps/releases
- React 版本：https://react.dev/versions
- React external store：https://react.dev/reference/react/useSyncExternalStore
- Preact 发布：https://github.com/preactjs/preact/releases
- Electron 发布与支持期：https://releases.electronjs.org/ 、 https://releases.electronjs.org/schedule
- Tauri sidecar：https://v2.tauri.app/develop/sidecar/
- SQLite 适用场景：https://www.sqlite.org/whentouse.html
- Node 24 SQLite 状态：https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html
- better-sqlite3：https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.3
- OpenTelemetry JS：https://opentelemetry.io/docs/languages/js/
- OTel GenAI 约定：https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
- fast-check 模型测试：https://fast-check.dev/docs/advanced/model-based-testing/
- Playwright Electron：https://playwright.dev/docs/api/class-electron
- pnpm workspace：https://pnpm.io/workspaces
- Changesets：https://pnpm.io/using-changesets
- tsdown：https://tsdown.dev/guide/
- tsup 维护说明：https://raw.githubusercontent.com/egoist/tsup/main/README.md
- Temporal activities：https://docs.temporal.io/activity-definition
- Yjs updates：https://docs.yjs.dev/api/document-updates
- TanStack DB：https://tanstack.com/db/latest
- Electric writes：https://electric.ax/docs/sync/guides/writes
