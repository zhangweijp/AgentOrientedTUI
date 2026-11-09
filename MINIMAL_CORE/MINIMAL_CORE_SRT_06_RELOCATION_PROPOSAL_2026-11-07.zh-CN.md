# SRT-06：现有适配器迁移提案

状态：**READY_FOR_REVIEW，限只读提案**。2026-11-07。本次不实施代码、依赖、公开入口或版本变更，不运行编译、测试、安装、打包、Host、Worker、模型或网络。

**推荐把现有 Semantic Source 放入已经公开分发的 Driver 包，以独立的 `@aotui/agent-driver-v2/aotui` 子入口提供。** Runtime 去掉 Driver 生产依赖，保留自己的身份、观察、授权、Ref 和资源机制。这个方案不新建包、不重写 Context/Tool，也不为 Host 和第三方维护两份 Source；但需要负责人明确批准新的公开子入口、Driver→Runtime 的单向依赖及两项小型中立 helper 出口。下面逐项列明决定，不把本提案视为授权。

本提案接续 [独立兼容裁决](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/MINIMAL_CORE/MINIMAL_CORE_CONSUMER_TYPE_COMPAT_REVIEW_2026-11-07.zh-CN.md)。r05 固定 source、包身份及原 36 条诊断沿用旧签收，不复制或重新封存旧依赖树。只记录本次 75 个具名输入、42 个命中文件及其直接引用，见 `review-evidence/minimal-core-srt06-relocation-proposal-20261107/`。

## 1. 为什么选这个落点

| 候选 | 实际证据 | 判断 |
| --- | --- | --- |
| `host/src/adapters/` | 已有 HostDrivenSource、SystemPromptDrivenSource；Host 已依赖 Runtime/Driver | 内部位置自然，但不能作为已存在的第三方公共分发合同 |
| Driver 的 `src/adapters/semantic-aotui-driven-source.ts`，公开为 `./aotui` | Driver `publishConfig.access=public`、`files=[dist]`、有真实根 JS/d.ts；目前无 Runtime 依赖 | 推荐。增加一个入口和单向依赖，复用原 Source；普通 Driver 根入口不 re-export 它 |
| 新 adapter 包 | 分发边界最独立 | 目前没有获准的新包；只有负责人不接受上一行的安装成本或公开职责时，才需要单独决定，不自行创建 |

**Host 不应被误称为 private 包。** 当前 `host/package.json` 没有 `private` 字段，名字是 `@aotui/system-chat`。但 `main` 指向 `dist/electron/main.mjs`，构建入口是 Electron main/preload；没有 exports map，声明的 `dist/index.d.ts` 和 `src/index.ts` 均不存在。其 postinstall、Electron/数据库/GUI 依赖也是产品宿主的分发内容。缺少 private 并不能证明它具备可供第三方稳定安装的轻量 Source 入口，现有 dist 也不能当发布承诺。只迁入 Host 会迫使公开消费者依赖整个桌面宿主，或丢掉原公开能力，因此不推荐把它作为完整方案。

Driver 当前生产依赖没有 Runtime。迁入后会变成 **Driver→Runtime**；只要同时删除 **Runtime→Driver**，最终生产图为 `Host→{SDK,Driver,Runtime}`、`SDK→Runtime`、`Driver→Runtime`，没有循环。若先给 Driver 加 Runtime 而保留旧边，则会形成反向循环，不能用 optional peer、旧 re-export 或编译顺序掩盖。两条边的修改必须属于同一原子候选。Driver 原本不需要 Runtime 的用户将增加安装负担，这是必须接受或否决的具体成本；新子入口能隔离根入口的加载/声明图，不能消除整包安装成本。

## 2. 迁移哪些职责，保留哪些单一来源

r05 Source 的实际依赖集中于 `runtime/src/adapters/semantic-aotui-driven-source.ts:1–12`。它包含 Core receipt→Driver ToolResult 的转换、Context 对 Observation 的持有/释放、模型消息与 Tool 构造、`jsonSchema()`、App 生命周期控制和更新订阅。这些现有适配职责一起迁出；不另设执行器、队列、manager 或协议。

| 旧文件/职责 | 拟议落点/处理 | 必须保留 |
| --- | --- | --- |
| Runtime `adapters/semantic-aotui-driven-source.ts` | 移到 Driver 同名 `src/adapters/` 文件；`./aotui` 直接映射其 dist，不加包装层 | 类名、Options、完整 Context/Tool/Schema/消息元数据、错误与 partial/unknown、逐次门禁、订阅、重叠 Context 和最后 owner 释放 |
| 同文件 `semanticToolResult`、`jsonSchema`、AI 类型 | 随 Source 迁移；AI helper 来自 Driver 已有 `ai`，Context 类型用 Driver 内部正式接口 | 原转换，不新增归一化、裁剪字段或第二执行入口 |
| Runtime `core/presentation.ts` | 移到 Driver `src/adapters/presentation.ts`，对应测试迁移 | 实际生产消费者只有 Source；格式与时间戳规则不改 |
| Runtime `adapters/system-instruction.ts` 的 `loadAOTUIInstruction` | 原函数移到 Driver `src/adapters/load-aotui-instruction.ts` | 文本/path/env/fallback 的优先级、日志及读取语义不改；本次不读取任何实际配置 |
| 同文件 `DEFAULT_AOTUI_SYSTEM_INSTRUCTION` | 留在 Runtime 原公开入口 | 文本保持；Host `src/server/prompt.ts` 继续使用，不用桥接到 Driver |
| Runtime `adapters/public-tool-name.ts` | **留在 Runtime，仅从既有 adapters 入口新增同名出口** | AppKernel 第 402/435 行也调用它，不能迁到 Driver 后让 Worker 反向依赖 Driver，也不能复制命名规则 |
| Runtime `adapters/view-message.ts` | 留在 Runtime，同入口新增 `buildViewMessageMarkup` 出口 | Source 与 Runtime 的 View-fragment 测试共用同一包装；不复制 XML 引擎，不拆正文或重写 envelope |
| Core Snapshot/Observation/Scope/Ref、SDK 参数编译 | 不随 Source 移动 | SDK 继续调用现有同一编译器；不扩大公共内部状态面 |

这里仅提议公开两个已有的小型纯函数，不公开 Receiver、ledger、注册器实现或新状态。另一种做法是在 Driver 复制别名/包装函数，会增加第二份规则源；把 AppKernel 规则移到 Driver 则重新耦合内核，均不推荐。若不接受这两个中立出口，应由负责人另选分发边界，不能在实施中默默改成 deep import。

新 Source 只从 `@aotui/runtime/core`、`@aotui/runtime/spi` 获取已经公开的类型，从中立 `@aotui/runtime/adapters` 获取上述值；不能继续导入 Runtime 私有路径。Driver 根 `src/index.ts`、Core interfaces、LLMClient、Driver 路由不需要修改。

## 3. 公开导入、消费者和声明影响

以下为**拟议**导入，尚未存在或获准：

```ts
// 原来
import { SemanticAOTUIDrivenSource,
  type SemanticAOTUIDrivenSourceOptions } from '@aotui/runtime/adapters';

// 迁移后
import { SemanticAOTUIDrivenSource,
  type SemanticAOTUIDrivenSourceOptions } from '@aotui/agent-driver-v2/aotui';

// 保持
import { DEFAULT_AOTUI_SYSTEM_INSTRUCTION } from '@aotui/runtime/adapters';
```

构造器和 `getContext()` / `executeTool` / `release` 用法保持。Runtime 不保留旧 Source re-export；这是公开入口迁移，需要同步升级说明和版本策略，不能悄悄让旧导入继续加载 Driver。

具名真实消费者分组如下，原行号在 `consumers.json` 中：

- **Host 生产 5 文件**：`src/core/host-manager-v2.ts`（真实 IM 组合）、`session-manager-v3.ts`（普通会话）、`source-controls.ts`（启用门禁）、`semantic-desktop-snapshot.ts`（GUI 独立短 Observation）、`src/types/session.ts`。只换 Source 类型/值进口，不改变调度、通知、业务执行或 release。`src/server/prompt.ts` 的默认指令进口保留。
- **Host 5 测试文件**：`test/semantic-host.e2e.ts`、`token-monitor.semantic.e2e.ts`、`semantic-host-llm.e2e.ts`、`session-manager-v3.integration.test.ts`、`im/im-tool-result-continuation.test.ts`。修改公开进口及 mock 的模块目标；IM 真实续轮断言、pending 时序和安静窗口不变。不因这份清单而准入真实模型/GUI。
- **Source 本地与真实组合测试**：两个 `semantic-aotui-driven-source*.test.ts`、`core/presentation.test.ts` 迁移其适配器责任；`worker-host.empty-view.e2e.test.ts` 和 `kernel/interaction-e2e.test.ts` 的 Source 生命周期部分迁到 Driver 集成测试。Runtime 的 Core/Worker 合同部分留在 Runtime，不能为了测试在 Runtime manifest 新增 Driver devDependency。
- **包消费者**：`runtime/tests/w10-package-consumer.mjs` 的类型、公共 Ref 链及 full-mode 模板，`sdk/tests/srt01-m4/verify-docs.mjs` 都写出旧进口。它们必须指向新正式入口和明确安装的 Driver；Runtime 无 Driver 门禁另用一个明确消费者，不能把原含 Driver 的脚本冒充独立消费。
- **当前说明**：Runtime README、Runtime `src/index.ts` 示例注释、Driver README、Root GUIDE 的 Source 路径需更新；Runtime 包分发说明和 SDK 集成说明应准确表达 SDK→Runtime、Driver 集成另选。已封存报告、历史 W09/W10 成绩和退休范围包不改。

测试迁移有一个已知细节：`real-core.integration.test.ts` 使用私有 `SemanticSnapshotReceiver` 和内部 Store inspection，不能照搬后要求 Driver deep import 或把 Receiver 变成新 public API。实施应把 Receiver/Core 自身断言留在 Runtime 的具名测试，Source 部分改用现有公共 Core/Runtime 能力验证，逐条给出旧→新断言映射；公共能力不足以证明某条必要断言时，交具体阻断，不删断言或发明检查接口。

**manifest/lock/声明**：Runtime 删除 Driver dependency 及 pnpm override；Driver 增加正常 Runtime 依赖和 `exports` 的 `.` / `./aotui`。根入口维持现有 JS/types，新增 exports map 是否影响既有深路径消费须由负责人确认；不能把内部路径默认承诺为公共 API。优先更新 Runtime、Driver 各自 lock；Root lock 没有这两包 importer，不为此改写。Host/SDK 的本地 lock 是否受真实解析影响再据事实决定，不能顺手升级依赖。新消费者 lock 是独立输出。

Driver 的 `files=[dist]`、现有 `src/**/*` 编译覆盖可容纳新文件，不需改构建框架。最终必须审计 Runtime 全部正式入口/传递声明不含 Driver 依赖，Driver 根声明保持，`./aotui` 声明保留完整 Source 合同、改用正式 Runtime 类型路径；生成 dist 只由新候选构建，不手改声明。

新增 helper 出口需要匹配的 Runtime 产物。不能直接声称旧的所有 `^3.0.0` 都包含它们；负责人须指定新的候选版本及依赖范围、联合 tar 身份和 Breaking 说明。本提案不自行定版本或发布。

## 4. 与 SRT-02 的唯一实施顺序

SRT Owner 的 r02 `production-scope.json` 已把同一 Source 列为待裁剪输入，且明确不在其内部改 Driver 依赖。不能两条执行线各改一份 Source 再拼 diff。建议负责人一次下发**一个隔离候选、一个共享文件执行者、两个有序改动组**：

1. **A：先按已冻结 SRT-02 清单应用退役变更**，保留其消费者迁移及明确的 D1/D2 允许差异；Source 的旧实例 Tool/selector 分支先退出。它的公开 Core/SDK 类型出口、当前文档、w10/verify-docs 模板同时按该范围收敛。保留逐断言映射和组 A 指纹，不因已知 Driver 红灯冒称完整验收。
2. **B：从组 A 的精确内容迁出 Source**，应用本提案的入口、消费者和依赖反转；所有 Source 改动以组 A preimage 为基线。组 B 比较完整消息、Schema、Tool 元数据、结果和释放事实；除进口/归属变化外不再混入业务或协议差异。Runtime 的旧 Source 出口在这组移除，中立出口保留/新增，SDK 的退役出口不再被迁移组改第二遍。
3. **一次联合产物验证、分开记账**：在最终无环候选上构建 Runtime→SDK/Driver，正常 tar 安装并运行下列两个门禁。正式批准前不采用共享工作树。已批准白名单中的小修用 attempt 保存失败、增量和复测，不为每个局部问题重新写泛化范围包；超出白名单/公共语义时才定点裁决。

最直接的生产交集是 Source；测试/文档交集是现有 Source 测试、Worker/Kernel 组合、w10、verify-docs 和当前说明。完整逐文件授权以冻结 SRT-02 清单与本提案补充白名单的**显式并集**为准，不能将“迁移”理解为授权整个模块。组 A 尚未获准生产实施的事实保持，本提案也不越权授权它。

## 5. 集中代码与新包消费者验证批次

具体拟议白名单见 `proposed-whitelist.json`。生产只涉及 Source 及具名辅助模块、出口、两包 manifest/lock 和 5 个 Host 进口；SDK 参数编译、Driver 执行主链、Core 生命周期/身份/Ref 算法不动。测试和当前文档按第 3 节名单处理，保留断言。与 SRT-02 共用项只由上述单一执行者按 A→B 顺序改一次。

开工先在实际三包基线上记录完整选项的安装/类型结果，不用 r05 缺少 exactOptionalPropertyTypes 和普通安装的成绩替代。Runtime 原生产图要求 Driver，是待修复的边界事实；缺依赖不能冒充业务先红。迁移等价性比较以组 A 固定结果和组 B 候选为一对，所有诊断、允许差异与失败单列归因。

| 门禁 | 正式包与必须配置 | 行为及拒绝条件 |
| --- | --- | --- |
| R：Runtime 不安装具体 Driver | 新空 ESM consumer，从明确 Runtime/SDK tar 正常全新安装；TS **5.3.3 / 5.9.3** 均 `strict:true`、`exactOptionalPropertyTypes:true`、`skipLibCheck:false`，正例/逐一负例分开；Core ES2022-only/types:[] 与 Node/DOM 入口分开 | Runtime/Core/SPI/中立 adapters/memory-state-storage 所定样本可消费；安装图、加载声明与正式 Runtime 载荷无 Driver/AI 牵连；旧 Source 进口明确不再可用。保留 Snapshot/Observation/Scope/Ref 与 SDK 共用编译的真实行为 |
| I：安装 Driver 的公开集成 | 另一空 consumer，正常安装同一套匹配 tar 加 Driver；相同两版 TS、完整严格选项；从 `./aotui` 导入，完整 Tool/ModelMessage/Schema 类型 | 复用公开 Ref 四调用、最新 View/短收据、普通/Ref 身份、disabled、重叠 Context、最后 owner 与真实结算；Driver 单执行/stop/release、Host 普通会话和 IM 续轮合同保持。未重新准入模型/GUI/Host 私有状态 |

两项都记录真实 argv/cwd、Node/TS、解析路径、pnpm shim、lock、安装 payload/SHA、完整日志与实际资源结束；不使用 workspace alias、绝对 json-schema paths、ambient shim 或跳库。安装缺依赖/缓存属于环境阻塞。执行入口、可写位置和应用模块副作用必须在运行前具体准入，不能把本提案当运行授权；既有 Host preview 第三轮仍冻结。

**Driver 自身 TS 5.3 的 36 错单列为兼容阻断。** 迁移预计解除它对 Runtime 门禁 R 的牵连，但不会使 I 自动通过；启用 exactOptionalPropertyTypes 后还可能有其他诊断。门禁 R 可独立取得事实，I 未过仍如实为失败，整体兼容/退出不得转成通过。Driver 依赖修复或支持政策改变须按单独批准范围进入同一候选或后续专项，不在此白名单内自行降级/升级；保持既定 SRT-06 推进，不拿该选择暂停边界工作。

## 6. 负责人需要决定的项目与下一指令

需逐项批准：① 采用 Driver `./aotui` 及撤去 Runtime Source 出口；② 接受 Driver→Runtime 的安装成本；③ 在中立 Runtime adapters 公开两个现有纯函数；④ 指定匹配版本/依赖范围及深路径消费政策；⑤ SRT-02 A→SRT-06 B 由一个共享文件执行者串行完成，批准具体白名单和运行入口。若拒绝①–③中的关键条件，现有 Host 不能自动补上第三方公开能力，应明确决定独立公开集成包等替代方案，不自行新建。

**有条件工期**：假设组 A 候选已经准备并冻结、上述入口决策一次确定、精确离线依赖和安全执行环境可用，组 B 迁移/消费者改动约 1–2 个有效工程日，测试迁移/当前文档/正常 tar 双编译矩阵约 1–2 日，合计约 **2–4 个有效工程日**。这不是固定完成时间，不包含未实施的 SRT-02 生产退役、负责人复核等待、缺依赖环境处理或未知 Driver 兼容修复。关键不确定性是完整 exactOptional 门禁的新诊断、私有 Receiver 测试的公共合同映射、两包反转后的实际依赖解析和版本政策；当前没有可信依据为 Driver 兼容专项估计上限。

> **最短后续 Prompt（须先批准上列决定）**：以负责人指定的 r05＋具名 Host/Driver 实际内容建立新隔离候选，保护并行工作。单一执行者按冻结 SRT-02 清单形成组 A，再从其精确 preimage 按本提案白名单实施组 B：Source 迁 Driver `./aotui`，移除 Runtime→Driver，建立批准的单向依赖；复用中立 helper，保留完整 Context/Tool/Schema、身份/授权/Ref/资源和 IM 续轮。迁移真实消费者与保留断言，生成独立分组 patch、完整声明和匹配 tar；获准精确运行入口后完成 R/I 两项正常安装、TS5.3.3/5.9.3＋strict＋exactOptionalPropertyTypes＋skipLibCheck:false 门禁及相关真实调用/释放。已知 36 错不豁免，不通过改业务或缩减类型制造绿灯。白名单内小修保留 attempt，不反复重做范围；越界、循环、参数/结果/生命周期变化或不足以保持断言时携证据停在受影响步骤。交 READY_FOR_REVIEW 与完整失败/未执行记录，不自行批准、采用、发布、合并或解除 Legacy/Semantic 条件。

本次只读提案的命令、具名输入、保护核对及产物指纹见证据目录。没有新增编译/运行证据，也没有自行决定新 API 或支持版本。
