# Runtime Core Semantic Contract RFC — 目标、原则与约束

- **文档 ID**：RCSC-00
- **状态**：Draft / 指导性文档；未经评审批准不得视为最终接口承诺
- **日期**：2026-10-21
- **实现基线**：本地工作树 HEAD 789ef07，包含大量未提交修改；审查以实际 TS/TSX 代码为准，不以 HEAD 单独代表当前实现
- **决策主题**：方案 C — Runtime-owned Transactional AppSnapshot with Pluggable Snapshot Producers
- **阅读次序**：00 本文 → 01 可行性 → 02 影响面 → 03 技术设计 → 04 开发计划 → 05 测试计划 → 06 一致性审查

> 本目录是设计草案，不代表代码已实现。本次仅定义及评审文档，不改动仓库业务代码。所有技术细节应能从本地代码、测试或显式的待验证假设追溯。

## 1. 北极星目标

让 **Snapshot 成为 Runtime Core 的第一等、版本明确、发布后不可变、可安全寻址的工作世界契约**。任何 App 只要能按契约提交 View/Ref/Tool 的投影，就能被 Runtime 管理，无须把某种 Host、DOM、Preact 或 Worker 实现当作核心语义。

**成功不是「生成另一份文本」，而是：针对同一 App 的一次已发布观察，View 内容、Ref 绑定、Tool 定义与适用范围来自同一个成功提交的版本；旧观察绝不能静默重绑定到新对象。**

## 2. 全局术语（规范性）

| 术语 | 唯一语义 | 命名要求 |
| --- | --- | --- |
| App | 具有生命周期和运行实例身份的应用 | 核心概念 App |
| View | 具稳定实例身份、类型及可观察内容的 Agent 工作视图 | 核心概念 View |
| Ref | 在明确版本、作用域内解析的语义引用 | 核心概念 Ref |
| Tool | 具有身份、参数契约、可用条件和执行绑定的能力 | 核心概念 Tool |
| ViewTypeTool | SDK 按 View Type 定义/注册 Tool 的开发者 API | SDK 专有名称 ViewTypeTool |
| AppSnapshot | 一次 App 内部提交的一致、不可变语义投影 | 目标核心契约 |
| WorkspaceSnapshot | 对多个已提交 AppSnapshot 的版本化组合观察 | 不声称跨 App 事务 |
| SnapshotProducer | 将运行中的 App 状态转成 Snapshot Draft 的可替换适配器 | 不拥有最终提交权 |
| SnapshotCommitter | 验证、复制/冻结和提交 Draft 的 Core 服务 | 拒绝不合法的 Draft |
| SnapshotStore | 管理当前快照、历史保留、lease、读取与失效 | 不管理应用业务状态 |

**历史代码兼容说明**：本地 TS 类型仍含 Operation/OperationResult 等标识；仅在文件路径或迁移清单中称为「历史代码命名」。新契约与新 API 必须使用 Tool、ToolResult、ToolInvocation。实验目录中的 Action/Observation 是独立实验术语，不自动升级为正式契约。

## 3. 决策范围

**本次 P0 必做**：
- 定义 AppSnapshot / WorkspaceSnapshot、Draft、版本、实例世代与发布语义；
- 把 View、Ref、Tool 从混合 IndexMap 中提升为明确的结构化契约；
- 建立 App 级同源一致性屏障、验证、冻结、原子发布与失败恢复；
- 明确 Ref/Tool 与来源 Snapshot 的绑定，以及执行前新鲜度和业务校验的分工；
- 保留当前 IDE 的 Preact/DOM/Worker 路径，增加可替换 Producer 端口与无 DOM 契约测试；
- 制定兼容开关、观测、回退和迁移验收标准。

**仅作边界约束，不在本次实现**：Runtime Core 与 DOM/Worker 的彻底物理拆包；SDK Tool 声明与 JSX 生命周期全面解耦；新的渲染框架；跨 App 分布式事务；统一业务 Store；大规模性能优化；模型调用与编排层改造；Mobile。

## 4. 不可妥协的不变量

| ID | MUST 满足的契约 |
| --- | --- |
| INV-01 | 单个 AppSnapshot 的 View/Ref/Tool 在同一个受控投影周期中准备、验证和提交；不能拼出混合版本。 |
| INV-02 | 已提交数据为快照独立、深度复制且不可由调用方改写的可序列化值；仅 TypeScript readonly 或 Object.freeze 顶层不够。 |
| INV-03 | App 实例有唯一 instanceId；该实例成功改变语义时 revision 严格递增；时间戳绝不替代序号。 |
| INV-04 | 同一未变的已提交状态重复读取得到同一 snapshotId；读取本身不创建语义修订。 |
| INV-05 | Ref 解析必须绑定来源 snapshotId + App 实例 + View 作用域；不存在按后缀全局猜测或旧索引自动落到新对象。 |
| INV-06 | Tool 按稳定内部 Tool ID 和 ViewType 身份绑定；快照保存描述/Schema，不序列化执行 Handler；执行前仍须进行活态校验。 |
| INV-07 | 发布仅替换一个 App 的已验证快照指针；失败不部分发布，也不推进 revision；错误可诊断。 |
| INV-08 | WorkspaceSnapshot 只保证由各 App 已提交版本组成的读一致性，并携带版本向量；不承诺跨 App 的同一时刻原子状态。 |
| INV-09 | 过期、驱逐、实例重启、View 关闭、Tool 停用有确定的错误语义；不得隐式回落当前版本继续执行有副作用 Tool。 |
| INV-10 | Core 的主要契约测试可在纯内存环境运行，不启动 Worker、不初始化 DOM，不导入 Preact。 |
| INV-11 | 业务 Handler 的真实成功/拒绝/失败结果不得被 Runtime 重新包装成成功；未知副作用与安全重试须区分。 |
| INV-12 | Tool 公开可见 ≠ 有权执行。最终副作用前必须复核当前授权和业务前置条件。 |

## 5. 一致性与失败边界

- **App 强保证**：一个已提交 AppSnapshot 内 View/Ref/Tool 可相互核对；相同 instanceId 下 revision 严格前进。
- **Workspace 组合保证**：多个 AppSnapshot 各自原子，组合保留每个版本的来源；不锁住不同 App 的外部数据源。
- **外部现实边界**：文件系统、LSP、数据库等 App 自有数据会变化。快照可以变旧；成功读取快照不等于允许不经复核的写入。
- **提交失败策略**：保留 lastGood 仅供诊断/显式带 stale 标记读取；状态设 degraded；默认 fail-closed 拒绝基于失效状态的有副作用 Tool。不能将旧快照伪称为最新。
- **时间与存储**：expiresAt 是保留/有效性策略，不是业务版本；lease 有界，容量有界，清理不制造错误对象绑定。
- **首次启动**：在首次有效提交前为 unready，不能对外捏造空的成功 Snapshot。
- **无语义变更**：重复触发提交在内容与注册契约均相同且实例未更换时可复用当前已提交快照；任何 Ref/Tool 定义变化即使文本不变也算语义变化。

## 6. 结构设计原则

- **Core owns Commit**：Producer 可以生产草案、提示 invalidation，但不能直接发布已提交快照或自定权威版本。
- **One source per semantic concern**：View、Ref、Tool 各有结构化索引；混合 IndexMap 仅为兼容投影，不是新模型的事实源。
- **Explicit identity**：App ID、AppInstance ID、ViewInstance ID、ViewType、Ref ID、Tool ID 不得用模糊字符串猜测互换。
- **Least intrusive DX**：本阶段不要求修改 IDE 的 createTUIApp / View / useDataRef / useArrayRef / useViewTypeTool 调用方式。
- **No magic lifecycle**：不能只凭 MutationObserver 或 useEffect 时序宣称提交一致；Producer 与 SDK 必须实现可验证的就绪屏障。
- **Honest contracts**：捕获中/提交中/降级中的状态需要可观察；快照 ID 不能仅靠毫秒时间戳排序。
- **Compatibility is bounded**：旧 Snapshot API 可提供过渡适配，但标明废弃期限/准出条件；不能保留无限双写与两套寻址真相。
- **Security is explicit**：Worker Thread 是隔离执行机制，不是可信授权边界；Runtime 不替代 App 领域权限。
- **Prove before optimizing**：先写一致性属性测试与故障注入，再做 diff、缓存、增量发布。

## 7. RFC 决策登记

| ID | 决策 | 状态 |
| --- | --- | --- |
| DEC-01 | 采用方案 C：App 侧 Producer 生成 Draft，Core Committer 验证并发布 | 已选架构方向 |
| DEC-02 | 强原子性仅覆盖单 AppSnapshot；Workspace 为版本向量组合 | 拟定 |
| DEC-03 | 采用 instanceId + 单调 revision + snapshotId 区分重启与状态版本 | 拟定 |
| DEC-04 | Snapshot 内 Ref 只存可序列化 immutable value / stable entity locator，绝不存活 JS 指针 | 拟定，需做兼容性探针 |
| DEC-05 | Tool 描述与执行 Handler 分开，来源绑定 + 活态校验 | 拟定 |
| DEC-06 | 先兼容现有 DOM Producer，再演进 Producer API；本轮不换渲染栈 | 已选约束 |
| DEC-07 | 发布失败保留 lastGood 标记 degraded，写入 fail-closed | 拟定 |
| DEC-08 | 现有 semantic-kernel 仅作可行性样本/测试模式参考，不直接替换生产 Runtime | 已选约束 |

## 8. 准出指标（对应开发与测试计划）

- INV-01～12 各有自动化契约测试；关键故障注入与并发时序用例全部通过。
- 在无 DOM 的纯内存 Producer 上完成一次 App → View/Ref/ViewTypeTool → Snapshot → Tool → 更新闭环。
- 现有 IDE 打开/关闭文件、搜索、编辑、LSP 视图与动态 ViewTypeTool 主要路径均经过集成回归。
- 对比旧路径，SDK 公共调用代码不因本轮改造发生强制性大规模变更；若需变更必须登记并提供迁移方案。
- 无当前 Snapshot 时不制造虚假成功状态；引用冲突或快照过期时不能误操作其他对象。
- 生产切换可回退，且回退不读取不兼容的新存储为旧格式、不会重复执行副作用。

## 9. 现有代码证据（只列源码，不依赖仓库既有文档）

- runtime/src/worker-runtime/index.ts：pushSnapshotFragment 分别抽取 DOM/Ref/ViewTypeTool，IPC 推送。
- runtime/src/engine/app/worker-host.ts：按 timestamp > lastDomTimestamp 缓存 Fragment。
- runtime/src/kernel/index.ts：每次 acquireSnapshot 重新格式化并 create Registry 快照。
- runtime/src/engine/system/registry.ts：create / retain / release / ttl 的快照生命周期。
- runtime/src/engine/view/snapshot/formatter.ts：合并多个 Fragment，工具与 Ref 混用 IndexMap。
- runtime/src/worker-runtime/app-kernel/AppKernel.ts：注册 Ref 和 ViewTypeTool、执行并解析当前活态 Ref。
- sdk/src/hooks/useRef.ts、useArrayRef.ts、useViewTypeTool.ts：注册时序和数据标记的当前实现。
- experiments/semantic-kernel/src/contracts.ts、kernel.ts、task-app.ts、test/kernel.test.ts：实验性不可变观察/执行回执等代码，只作为可验证的技术素材。

## 10. RFC 尚需评审的问题

- 问题 Q-01：极大 Ref payload 和非 JSON 数据（Date、Map、函数、循环引用）何时拒绝、何时通过显式 Codec 转换？
- 问题 Q-02：快照捕获屏障能否与当前 Preact Effects 完整整合？若不能，严格模式是否必须延至 SDK 注册路径变更完成？
- 问题 Q-03：ViewTypeTool 允许在 Root View 注册但作用于 FileDetail 类型；应区分 definition owner 与 executable target。
- 问题 Q-04：首次迁移中旧 Snapshot 消费端与新版本 API 的双轨期、保留期、内存预算及回退路径如何控制？
- 问题 Q-05：有副作用 Tool 的冲突粒度先用 App revision，还是允许声明稳定实体版本？原则是默认保守，基于测试再放宽。

**下一步**：依据 [01 可行性分析](./01-feasibility.md) 验证 Q-01～05，依据 [03 技术方案](./03-design.md) 固化协议，再根据 [04 开发计划](./04-plan.md) 与 [05 测试计划](./05-tests.md) 设立准出门槛。