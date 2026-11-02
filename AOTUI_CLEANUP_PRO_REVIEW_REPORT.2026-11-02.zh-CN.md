# AOTUI 清理交付与 Pro 复核报告

日期：2026-11-02（Asia/Shanghai）。审计代码版本：`bd5deea359922bd11b3b11021bd962c09d300789`，分支：`codex/guide-tech-stack-analysis`。

仓库：`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI`。下文源码路径相对仓库根目录，临时证据目录使用绝对路径。

本报告供独立审核使用。它汇总清理、R1–R5 修复、两轮追加减法、MEM-01、验收边界及 skills 现状。报告编写阶段重新核对了 Git、源码、现存日志、文件指纹和安装包，**没有重跑整套测试，也没有为写报告修改生产代码或 skills**。

## 1. 当前结论

1. **SDK / Runtime 生产主链已经收敛到唯一 Semantic 路径。**旧 Snapshot / Dispatcher / Fragment 执行链、V1 调用通道、SDK 平行声明方式和生产回退已退出。Preact 默认开发模型、DOM Producer 与纯 TypeScript Core 消费方式保留。
2. **Pro 上一轮提出的 R1–R5 已按最终产品决定修复并回归。**R2 最终是禁止嵌套 View，未保留克隆、剪枝或父子 View 支持。
3. **追加两轮清理已完成。**第一轮 28 项，第二轮 17 项；其中会影响仍承诺行为的断言迁移到正式入口，退出 API 的专属测试删除。
4. **MEM-01 已在原验收配置下关闭。**默认 TypeScript LSP 改用一个完整 tsserver；最终安装包两次独立运行、共六轮通过原 1024 MiB 门槛。它是 IDE 资源配置修复，未以 Runtime 重写、强制 GC、放宽门槛或缩减负载解决。
5. **完整 Host／真实模型／Electron 验收由项目所有者确认完成。**这项确认已入库。它不等同于本代理补跑了可机器重放的最终 Host 全量测试，也不把此前失败或未执行项目改写成当时通过。
6. **“整个仓库连 skills 都已彻底清干净”不成立。**此次报告检查确认应用开发 skill 仍有示例组合矛盾和过时指导；另有一个未跟踪的 Kenton 方法 skill，以及证据归档和发布准备事项。详见第 8–9 节。

因此，适合 Pro 审核的结论是：**核心清理与已列运行缺陷修复已经交付；skills 和交付证据仍有明确的收尾项。**“已完成”指已经实施并验证的范围，不表示证明了全仓零死代码或任意宿主／平台的 Infra 成熟度。

## 2. 产品边界与本轮遵守的原则

应用服务 Agent；SDK 的主要开发者也包括 Agent。View 是进入 Messages 的独立当前工作页面，XML + Markdown 页面作为 User Message 呈现。相同逻辑 View 只保留当前有效快照；真实用户指令、操作收据和审计历史不因此被任意改写。

Tool 发起操作，返回结果和必要提示；当前业务数据经 View 呈现。Tool 的发现、可用性、执行授权与业务前置条件分别处理。打开文件后编辑能力出现，关闭页面后其绑定失效；重新打开同名对象不能使旧调用转向新实例。

SDK / Runtime 对自己管理的提交、身份、观察、绑定、调用、预算和释放负责。文件条件写入、领域权限、外部资源效果等由应用或资源适配器承担。减法优先删除重复解释、失效接口和历史兼容，不删除这些基本保证。

Breaking Change 已获授权；Legacy 退出以项目所有者的 Semantic 验收为前提，该验收已经发生。不恢复双轨，不新建通用权限系统、页面树、业务补偿框架或备用兼容包。

实施方式：代码清理／简化由 GPT-6 Luna Max workers 分工，主代理确定范围、审查迁移、运行集成和新包验证。本轮应用了项目 `.agents/skills/minimalist/SKILL.md`；没有把未提交的 Kenton skill 当作本轮执行依据。

## 3. 提交、基线与统计口径

### 3.1 可追溯的提交

| 提交 | 作用 |
| --- | --- |
| `194daa53` | 在 main 对比前保存当时工作区，含大量已有源码、实验和交付资料；不是单一清理原子提交 |
| `bb2ad7e6` | 修复 Semantic 呈现与桌面预览；作为后续主要清理差异的可用起点 |
| `c1a21d21` | Runtime / SDK Semantic 收敛、既有审核修复及相关 Driver 集成；386 个路径 |
| `8a4d210d` | 五个内置应用及生成脚本迁移；41 个路径 |
| `a040de0b` | Host Semantic Source、应用控制、预览及引用迁移；26 个路径 |
| `bbcea401` | 删除被替代的架构／实验／交付文档，更新开发指导；800 个路径 |
| `106dc737` / `6b1914b5` | 第一轮追加代码清理及对应文档、证据 |
| `d23fea35` / `b5e74d50` | 第二轮追加代码清理及对应文档、证据 |
| `e7507105` | 记录项目所有者完成 Host／真实模型／Electron 验收 |
| `4fa59165` / `bd5deea3` | MEM-01 配置修复、真实 LSP 回归及正式包验收记录 |

最初的审查起点是脏工作树。历史归档摘要记载当时 HEAD 为 `789ef07c`，保存了 935 个文件、283 个未跟踪活跃文件及 staged / unstaged patch。**不能把最初缺陷、清理中暴露的既有问题和本轮新引入回归混为一谈。**上一轮 Pro 已明确：R1–R4 的相关机制在真实起点已存在；测试迁移和无效配置清理遗漏则直接属于清理质量问题。

### 3.2 删除规模

`bb2ad7e6..bd5deea3` 的机械 Git 统计为 **1289 个变更路径、增加 11678 行、删除 302798 行**。其中大量是历史 RFC、实验副本、锁文件和文档，不能宣称为删掉了 30 万行运行代码。

较接近生产源码的辅助口径：只统计 `runtime/src`、`sdk/src` 内 `.ts/.tsx`，排除 `.test.`、`.spec.`、`__tests__`、`e2e-test`、`fixtures` 路径：

| 范围 | 变更路径 | 增加 | 删除 | 净减少 |
| --- | ---: | ---: | ---: | ---: |
| Runtime | 149 | 1786 | 13381 | 11595 |
| SDK | 33 | 401 | 2581 | 2180 |

这是明确过滤规则下的差异统计，不是运行时可达性证明。第一轮追加清理原报告采用更精细的生产源码／类型口径，净减 1640 行；第二轮净减 230 行。不同口径和有重叠的路径数不直接相加。

## 4. 全部清理改动

### 4.1 原 53 项计划覆盖的收敛范围

原始 `AOTUI_SEMANTIC_CLEANUP_TASKS.json` 和计划文件已从当前树删除，可从 `bb2ad7e6` 恢复。该版本原 JSON 是 `planning-only`，53 项状态为 `planned`，不是最终验收单。下表按原 ID 分组交代实际去向；**不把分组说明伪装成重新执行了 53 项逐条验收**。其中 E01 的 skills 部分仍有本次发现的残留。

| 原 ID | 数量 | 改动与保留边界 |
| --- | ---: | --- |
| D01–D12 | 12 | 删除旧 Snapshot builder、Kernel 无效 transformer 注入、私有 Session、bound-action 实验 executor、旧 operation log buffer、View tree、SDK persistence-manager、throw-only View registry Hooks、useResourceRef 别名、useSignalStore 及独占依赖、通用命名校验重导出、旧 workspace composer。真实 ledger、logger、Ref、View 身份和多 App 聚合保留 |
| M01–M10 | 10 | 删除旧 AOTUIDrivenSource、Kernel acquire/releaseSnapshot/execute/getSystemToolDefinitions、SnapshotRegistry、Dispatcher、旧系统操作包装、旧 formatter/templates、Fragment 缓存／getter、旧 IPC 操作消息、桌面锁及纯旧类型。调用统一使用捕获的 Scope / Observation / Binding；Semantic 发布承担更新通知 |
| P01–P06 | 6 | Shadow Receiver 收敛为正式 SemanticSnapshotReceiver；DOM Producer 只产生当前 V2；删除全 App legacy transform、IndexMap 拼接、shadow 开关和配对诊断、exportRefsToIndexMap、Snapshot V1 validator。共享 JSON 捕获、RefKey、容量校验保留 |
| S01–S08 | 8 | 删除 type-wide Tool 重载、AppKernel.typeTools/callTypeTool、InlineView／旧 IView registry、ViewRegistry/renderViewTree、Factory 双模式及 throw-only 分支、重复 selector/context 包装、SDK 根入口内部装配导出。当前唯一托管组件工厂与 View-local Hook 保留；环境读取后续继续收敛到 useAppRuntimeContext |
| T01–T06 | 6 | ordinary-v1、snapshot-value-v1 旧传输、专用只读 Hook 和旧 SDK wrappers 退出；参数合同归 Runtime；正式 interactionModes 取代实验开关。Worker ACK、身份和 callable 资格仍检查。仍有效的有界捕获及终态验证移入共用正式模块 |
| B01–B06 | 6 | 删除 Framework 内专用文件替换、unobservedFileVersions 等业务状态、Ref/只读旧旁路、SDK entity File mutation 切片、create-if-absent 专用协议和 Hook。IDE 创建／版本／冲突策略留在应用资源适配器，通过普通工具调用 |
| L01–L03 | 3 | 删除 WorkerAppHostService / SignalServiceImpl / ViewManager 等多余装配与旧注入回退；正式 managed lifecycle / persistence 失配明确拒绝；useAppLifecycle / createAppScope 使用正式名称，无过渡 alias |
| A01 | 1 | 删除 compatibilityContext / compatibilityPending 和分开的 getMessages/getTools/executeTool 接口；一次 getContext() 捕获呈现和调用目标，Context.release() 管理持有期；Driver 完成调用后释放 |
| E01 | 1 | 更新依赖、exports、构建、锁文件、示例和当前文档，删除被替代实验与交付副本。SDK 只开放根入口，Runtime 保留必要公开子入口。应用开发 skill 三个文件已迁移部分接口，但当前仍有第 8 节问题 |

原计划中“先保留、后收敛”的条目应以当前合同为准。例如 useAppConfig/useAppEnv、View.onClose 曾作为迁移阶段候选保留，后续确认无必要后继续删除，不应照原计划恢复。

### 4.2 第一轮追加：28 项

本节 ID 属于第一轮追加清单，与原 53 项中同名 S01 等不属于同一命名空间。

| ID | 删除／简化 | 保留或迁移 |
| --- | --- | --- |
| S01 | escapeHtml / escapeJsonForAttr、未用验证结果类型 | 删除专属自测与导出文档 |
| S02 | defineParams 包装 | 直接传参数对象；保留参数推断和 Runtime 校验 |
| S03 | RefHandle.data / .id、无效泛型 | 仅保留输出标记所需 formatter；真实 Hook 注册和释放 |
| S04 | 数组 Ref 双别名及重复跟踪 | 每个输出一个 ID，保留 itemType；迁移 Planning 解析 |
| S05 | data-view-generation、公开内部 mount 元数据 | 内部 generation 和 Runtime 实例身份保留 |
| S06 | 无发送方的 View.onClose / aotui:view-close | 应用状态控制页面；卸载使绑定失效并清理资源 |
| S07 | SDK 工厂旧 description、useAppConfig | whatItIs/whenToUse、launchConfig；useAppEnv 当时保留，第二轮再删 |
| S08 | 便利 barrel、内部 Preact 重导层、未发布 JSX 声明 | 正式根 API、直接 preact/hooks、单一 Preact peer |
| S09 | 手工模拟 Hook 的测试、孤立 IDE fixture、过时示例 | 有效行为迁到真实 Hook／Worker 测试 |
| S10 | projection commit coordinator 的旧 Runtime 回退 | RuntimeContext.projection 必需；begin/end 完整配对 |
| R01 | createKernel 工厂包装及孤儿 barrel | createRuntime 直接构造 Kernel |
| R02 | 通用旧 Worker 接口、无消费者消息 | 实际 IPC、RequestID 与来源检查 |
| R03 | AppKernel 未用方法、Ref 转发别名、空 override | Ref 注册和可选应用生命周期派发 |
| R04 | aotui:system → dismount_view DOM 事件链 | Agent 的 Semantic App 生命周期操作 |
| R05 | Transformer 空 context、未用 appId、重复类型／helper | Markdown 转换与普通元素递归 |
| R06 | 无 Producer 的 application Visitor | App 包络由 Source 构造；独立 View 转换 |
| R07 | Fragment timestamp/digest 缓存与 clear 包装 | Source 消息时间、capturedAt、非法嵌套整体拒绝 |
| R08 | Manager 批量关闭／删除／同步 cleanup、测试专用池转发 | beginClose / cleanupAsync / beginShutdown，实际等待与报告 |
| R09 | 旧 destroy 仓储入口、失败路径旧命名 | 接纳点实例检查、诚实失败报告 |
| R10 | system: 特判、孤立 manifest validator/schema/isValidAppName | 实际 aoapp.json entry.main、工厂 appName 和加载 |
| R11 | 重复配置 validator 与 descriptor 捕获 | defineRuntimeConfig 唯一接纳校验；getter 零执行、字段路径、不可变默认值、数值边界 |
| R12 | 孤立 ID guards、错误 helper／注册项 | 实际 AOTUIError 与 Core issue code |
| R13 | Runtime 对 Preact 的生产依赖、未用变量／导入 | Preact 移到开发依赖；SDK peer、应用直接依赖保留 |
| R14 | AppRegistry 两份本地模块入口解析 | 复用 resolveModulePath，保留各入口实际 npm 支持边界 |
| C01 | AppSnapshot 同义 alias、ReturnType alias | AppSnapshotV2 与真实类型签名 |
| C02 | SnapshotDraftEnvelope / SnapshotHealth 公共导出、内部 barrel | 内部来源／健康诊断继续使用 |
| C03 | legacy-raw 存储解码回退 | 只接受正式 envelope；旧数据拒绝但不覆盖、不删除 |
| C04 | Memory storage 恒零统计及未用导入 | owner / namespace / operation 隔离和 unknown 语义 |

额外修正：复现并修复配置默认对象共享可写污染；补齐简化过程中暴露的 NaN 范围检查；SDK 根入口曾漏掉的有效输出 Hooks 在交付前补回。后续第二轮确认没有实际 Provider 的 history Hook 再删除，实时 Hook 保留。

### 4.3 第二轮追加：17 项

| ID | 删除／简化 | 保留或迁移 |
| --- | --- | --- |
| P2-S1 | 不可达 LLM Provider 分支、useLLMOutputHistory | Host → Worker DOM 事件 → useLLMOutputChannel 实时通道 |
| P2-S2 | useAppEnv 单键包装 | useAppRuntimeContext().launchConfig；Terminal、持久化 Hook 和 skill 迁移 |
| P2-S3 | resolvePersistentAppName 及自测 | Runtime namespace、hydration |
| P2-S4 | SDK OperationError / OperationResult 重复定义 | 直接复用 Runtime SPI；SDK 仍导出类型 |
| P2-C1 | Receiver 两个无消费者转发方法 | Scope 内来源捕获与 Ref 参数处理 |
| P2-C2 | Interaction 四个全局计数镜像 | 从 State/ledger 汇总；关闭中工作仍占位，Scope 硬上限 16 |
| P2-C3 | Observation 两个全局计数镜像 | 从 Scope Map 汇总；取消 reservation 结算前仍占位 |
| P2-C4 | semanticToolResult 包级导出 | Source 内部唯一映射，测试通过 executeTool 覆盖终态 |
| P2-C5 | 实现模块 export type * | 定义模块直连，Core 正式具名出口 |
| P2-R1 | Sandbox Worker 状态／快照诊断转发 | WorkerHost 真实健康诊断 |
| P2-R2 | Sandbox fire-and-forget dispose() | 等待 disposeAsync() 报告 |
| P2-R3 | Desktop.drain() 包装 | beginClose() 及共享关闭操作语义 |
| P2-R4 | Desktop.getAppInfo() → Manager.getAllWorkers() 死链 | 测试迁到现有受控查询 |
| P2-R5 | Sandbox._disposed 镜像 | beginCleanup() 同步建立 intent/closed，调用前后检查保留 |
| P2-R6 | 无消息消费者的 promptRole 配置链 | View 继续作为 User Message；生成脚本、类型、文档同步删除 |
| P2-R7 | WorkerPool.warmup() 显式包装 | acquireLease() 首次自动预热；部分构造失败清理 |
| P2-R8 | InstalledApp/AppState 恒空 html、孤立 AppConfig | serialize() 仍返回可读状态／元数据，不冒充保存页面正文 |

集成时修正了 Desktop.drain 遗留 SPI 声明、真实 Worker 复用测试中已删除的 dispose 调用。未以跳过测试处理。

### 4.4 Host、Driver、应用与文档

| 范围 | 交付变化与边界 |
| --- | --- |
| Driver | Context 接口与 release 集成；模型一轮结束及工具调用完成后释放持有。不是重写 Driver 内部架构 |
| Host | Session／Host Manager 使用 SemanticAOTUIDrivenSource；桌面预览读取 Semantic；应用来源控制、Agent App 引用迁移、GUI／TRPC 调用方同步更新 |
| IDE | 默认入口导出 scoped 托管应用；文件编辑、创建和版本冲突由应用承担；动态 FileDetail Tool、LSP 和托管关闭按正式合同工作；MEM-01 在此层修复 |
| Terminal / Lite Browser / Token Monitor | 迁移到当前 SDK／Semantic 接口；移除退出 Hook、配置和注册方式。最终构建已验证；不把“构建通过”替代各应用全部业务旅程测试 |
| Planning | typed Plan/Task Ref 与解析器同步迁移；新 ID 成功、旧无类型 ID 明确不成功，保留业务 unknown 及 PLAN_NOT_FOUND/TASK_NOT_FOUND，不强行改成框架安全重试 |
| 脚本／依赖 | generate-aoapp 同步当前工厂与元数据；SDK 单根 exports，Runtime 必要入口保留；清理旧锁／依赖和实验入口 |
| 文档 | 当前 Runtime／SDK 指南替代旧架构分析与清理草案；删除大型 RFC／实验／交付副本。历史可追溯性依靠 Git 和现存 QA 目录，不伪称旧文件仍在当前树 |

## 5. Pro 的 R1–R5：根因、最终实现、验证

| 编号 | 根因与最终修复 | 核心验证 |
| --- | --- | --- |
| R1，P1 | 生命周期控制原来只按可复用 appId；现在捕获原 AppInstance，经 Desktop 传入 AppManager，在接纳操作且发生副作用前核对。open 针对逻辑安装项；close/collapse/show 针对实例 | Agent 自己关闭并同 ID 重开即可触发边界，不依赖另一个生产入口；旧普通 Tool 和旧控制均拒绝，新 Context 成功，继任实例不受旧调用影响 |
| R2，P1 | 子 View 正文递归进入父 View。最终禁止 View 嵌套：SDK 在子实例／Hook 创建前拒绝，DOM Producer 全量预检后拒绝非法投影；复用健康状态和恢复流程 | 直接／普通组件包装的嵌套都失败；无部分注册／提交；兄弟 View、普通组件嵌套、动态开关、错误修复后发布和关闭成功 |
| R3，P2 | Core setEnabled 改版本，却未同步注册时冻结的 callable 资格 | 删除 Core 第二套启停及注册 enabled；SDK enabled 走 release/register。旧绑定拒绝与新绑定实际进入 handler 成对通过 |
| R4，P2 | postMessage 先读取 live Ref getter，再到 Host 校验已经太晚 | Worker 发送前用已有 copyJson 有界捕获完整 Draft，再核对 epoch；Host 独立验证。真实 Worker getter 次数 0，非法数据健康变化、修复恢复、关闭通过 |
| R5，P2 | bridge.debounceMs / transform.domThrottleMs / transform.maxTreeDepth 没有运行消费者；候选代码另有 accessor 绕过和 reason 字段错误 | 删除失效配置组；descriptor 检查不执行 getter，未知字段拒绝，错误有准确字段路径。后续 R11 收敛成 defineRuntimeConfig 唯一接纳点，补配置不可变、NaN／边界正反断言 |

主要复核位置：`runtime/src/adapters/semantic-aotui-driven-source.ts`、`runtime/src/engine/app/manager.ts`、`sdk/src/components/View.tsx`、`runtime/src/worker-runtime/view-fragment-extractor.ts`、`runtime/src/worker-runtime/index.ts`、`runtime/src/core/tool/view-owned-tools.ts`、`runtime/src/spi/config/define-config.ts`。

R2 旧候选的 `projectionNode()`／克隆剪枝方案不属于交付合同。普通组件组合合法；纯 Semantic Core 只接受独立 View 列表，没有为了拒绝非法 DOM 新建 View 树或权限继承体系。

## 6. 验证结果及其实际含义

### 6.1 各版本不能混用的测试数字

| 阶段 | Runtime | SDK | 实际安装文件核对 |
| --- | --- | --- | --- |
| R1–R5 修复批 | 127 文件，2112 通过，3 skip、7 todo | 17 文件，171 通过 | 8 tar，797 文件一致 |
| 第一轮追加清理 | 126 文件，2101 通过，0 skip/todo | 15 文件，156 通过 | 8 tar，748 文件一致 |
| 第二轮追加清理，当前 Core 版本 | **125 文件，2097 通过，0 skip/todo** | **15 文件，145 通过，0 skip/todo** | **8 tar，745 文件一致** |
| MEM-01，当前 IDE 版本 | Core 源码和包不变，未重跑以上全量 | SDK 源码和包不变 | IDE 重建，其余 7 包复用；测试前后 745 文件一致 |

报告编写时重新读取了第二轮完整测试日志末尾和命令退出码，并再次核对最终安装包的 745 个文件及 tar SHA-256。692 个源文件／测试文件指纹中，相对 MEM 前基线仅 IDE `server.ts` 和 `scoped-lsp.e2e.mjs` 不同，恰好是已单独验证的改动。

第二轮测试减少有明确归属：Runtime 减少 4 项（3 项退出的 promptRole 传播、1 项已删除 getter 空值断言）；SDK 减少 11 项（不可达 Provider/history、孤立持久化 helper）。更早删除的测试较多，本报告给出行为映射，不声称逐条人工证明了每个被删 assertion 都冗余。

### 6.2 当前版本已验证

| 维度 | 已执行结果 | 限制 |
| --- | --- | --- |
| 类型／静态 | Runtime、SDK noUnusedLocals/noUnusedParameters；SDK public type tests；安装包 skipLibCheck=false；退出 API 的负向类型断言 | 不能发现所有动态不可达代码，也不能验证自然语言 skill 的正确性 |
| 构建 | Driver、Runtime、SDK、5 App、Host 共 9 模块最终 exit 0；MEM 后 IDE 再构建通过 | Token Monitor／Planning 用当前源码隔离副本和已有开发依赖，未做全仓干净安装 |
| 纯 Core | ES2022-only 无 Node／DOM 类型消费；独立 TypeScript Producer 示例编译与运行 | 不等同于所有第三方 Producer 都自动可信 |
| 包消费 | 实际 tar 离线安装、ignore-scripts；AOTUI 包无 symlink；安装内容与 tar 一致 | 包内容一致不代表发布生态和所有操作系统已测试 |
| 实际 IDE | 打开→动态 Tool→编辑→最新 View；LSP；managed shutdown | 新一轮没有复跑其他应用全部业务场景 |
| R1–R5 | 新包反例、合法路径与恢复均通过 | 拒绝和成功必须同时看，不能仅看负向测试 |
| 存储／配置 | 正式 envelope、旧数据拒绝且不覆盖；配置不共享可写默认值、不冻住调用方输入；getter／NaN／越界拒绝 | 没有自动迁移旧裸 JSON 的承诺 |
| Planning | typed Ref 真实调用、更新及关闭；旧 bare ID 不误成功 | 业务失败保留真实结果，不被框架兜底 |
| SDK 实时输出 | Host→Worker 两次输出、reasoning／usage；metadata 不变、只呈现最新 View、关闭释放 | 这是模拟输出事件的集成测试，不是真实模型对话 |
| Host／模型／Electron | 项目所有者已确认完成并入库 | 本代理没有新一份完整 Host 全量绿色机器日志，也未重演人工验收 |

清理中出现过失败：旧 Ref 双别名／公开 mount 字段／旧 listener 测试未迁移，配置 NaN 检查遗漏，Desktop SPI 声明遗漏及旧 dispose 调用；均修正后完成最终检查。构建工具缺失、缓存 EPERM、外部 QA 脚本的原型比较和 Preact 参数问题也出现过，不能把重试成功写成首条命令就成功。

### 6.3 原 I01–I20 的当前复核入口

“覆盖”表示有当前断言和所属最近验证结果，未把本表当作本次另跑的 20 个独立测试。特别标明模拟与范围不足的部分，方便 Pro 挑选反例。

| 不变量 | 当前证据入口／边界 |
| --- | --- |
| I01 未开文件不暴露编辑 | `demo-apps/aotui-ide/tests/scoped-ide.e2e.mjs`：真实 Worker Tool 发现 |
| I02 内容／schema／目标同一观察 | 上述 IDE 测试；`runtime/src/core/invocation/observation-registry.test.ts`；`worker-host.scoped-interaction-e2e.test.ts` |
| I03 编辑后仅最新 View、收据不复制正文 | IDE 集成；`runtime/src/adapters/semantic-aotui-driven-source.test.ts`；新包消费 |
| I04 同 ID 重开旧 Binding 不重绑 | R1 AppManager、`runtime/src/kernel/interaction-e2e.test.ts`、新包 R1 对照 |
| I05 停用／更新旧绑定拒绝，新绑定可用 | `view-owned-tools.ordinary-v2.test.ts`、`sdk/src/view-local-tools.test.ts`、publication 真 Worker |
| I06 无关变化不撤销合法绑定 | `source-binding.test.ts`、View-owned lifecycle／Ref V2 测试；应继续检查“变化”与“重注册”边界 |
| I07 长模型回合／release | Observation registry 的模拟时钟推进至 1000000，默认 owner lifetime 仍有效、release 后拒绝；不是实际等待 31 秒的真实 LLM 实验 |
| I08 300 轮 Context | Source 单测执行 300 次 getContext/execute/release 并核对关闭；Scope 为测试替身，不宣称 300 轮真实模型长跑 |
| I09 无 Fragment 的更新通知 | `worker-host.semantic-publication.e2e.test.ts`：auto/never/manual、Ref-only、Tool-only、后台变化、失败健康与恢复 |
| I10 空应用／最后 View 关闭 | `dom-snapshot-producer.empty.test.ts`、Source 空观察及真实发布测试 |
| I11 rejected / none / partial / accepted / unknown | `invocation-outcome.test.ts`、Source executeTool、`worker-host.p0-tool-result.test.ts` |
| I12 重复／冲突调用 | `scoped-interaction.test.ts` 与调用 ledger；同请求不重复进入、冲突 ID 拒绝 |
| I13 参数／Ref 归属与原值 | ordinary contract、`scoped-interaction.ref-v2.test.ts`、SDK Ref 测试及严格类型 |
| I14 发布／传输失败不清除 unknown、不重放 | publication 故障、`worker-host.r1-terminal-race.test.ts`、终态映射与 R4 捕获测试 |
| I15 stop/close 及迟到工作 | `scoped-interaction.close.test.ts`、Worker resources／app lifecycle、IDE 30/45 秒真实超时 |
| I16 flush/unmount/close/release 故障分别保留 | `close-reporting-e2e.test.ts`、Worker persistence/resources；继续尝试独立清理 |
| I17 物理 Worker 复用隔离 | M4 生命周期、Factory／publication 真 Worker 测试及新包关闭 |
| I18 容量、释放后恢复、纯 Core | Observation／Interaction 容量正反测试，公开 ES2022-only 消费 |
| I19 新包／CLI／默认 Host | 新包类型与运行通过；默认 Host 人工验收完成。不能据此称本代理在最终 HEAD 重跑过整个 `./run.sh` 验收 |
| I20 业务 adapters | IDE 新包完整查询／编辑／关闭及 MEM；Planning 实际 Ref；其余应用本轮有构建和调用方迁移，但没有统一的最终自动化全业务旅程记录；Host 人工验收未附逐 App 场景明细 |

## 7. MEM-01：最终修复和测量

基线新包原脚本第 1 轮峰值 **1034.28 MiB**，超过 1024 MiB，退出码 1，因此没有执行后两轮。峰值约为主进程 419.8 MiB + LSP 子进程 614.5 MiB。默认同时有语言服务器、partialSemantic tsserver、完整 tsserver 和 typingsInstaller；额外语法服务器约 194 MiB。基线 44 个子进程与 11 个进程组已经退出，没有据此证明 Runtime 关闭泄漏。

正式生产修改仅一行：`demo-apps/aotui-ide/src/core/lsp/server.ts:98` 中 `tsserver: { useSyntaxServer: 'never' }`。完整服务器处理语法与语义请求，ATA 保留。自定义服务器、版本认证与资源归属合同不变。

| 最终新包运行 | 第 1 轮峰值 | 第 2 轮峰值 | 第 3 轮峰值 |
| --- | ---: | ---: | ---: |
| 正式测试 | 891.05 MiB | 914.13 MiB | 931.77 MiB |
| 独立复测 | 893.83 MiB | 908.23 MiB | 913.95 MiB |

六轮的 60 次循环中位数增量最大 41.55 MiB，低于 128 MiB；198 个记录到的子进程、66 个进程组全部退出，66 次 App 关闭完成。冷查询最大 378.27 ms（门槛 15000），热查询最差 p95 22.05 ms（3000），64 文件完整观察最差 p95 278.90 ms（3000），关闭最差 p95 39.92 ms（5000）。

条件未变：65 文件，每文件 220 行／19140 字节；64 文件边界及第 65 个拒绝；每轮 60 次文件循环、10 次 App 重开关闭；每项 2 预热＋10 样本；完整 View 分页遍历；整个自有进程树 RSS；无 Worker script 覆盖、无强制 GC。原测试 SHA-256 为 `6b0a1c599f2042ee944684fee6d54a5df83b7c7b6e101d3ccd09c28a956276ce`。

另有 14 个集成场景通过：5 个 LSP、5 个 IDE、2 个关闭、2 个容量／超时场景；七类 LSP 返回真实结果。新包探针确认仅一个完整 tsserver，ATA 存在。

适用环境：macOS、Node v24.15.0、typescript-language-server 5.1.3、TypeScript 5.9.3。这不是所有工作区大小／平台／版本的 RSS 上限承诺。大项目加载响应需要按实际负载评估。既有失败记录不回填为通过，MEM-01 的后续验收独立保存。

## 8. Skills：已改内容、确认残留与未验证部分

### 8.1 清单

| Skill／文档 | Git 状态 | 本轮实际情况 |
| --- | --- | --- |
| `.agents/skills/aotui-app-builder/SKILL.md` | 已跟踪、清理批次已修改 | 已转为 View-local Tool、ordinary-v2／Ref V2、收据／View 分离、默认 managed lifecycle；指向当前 API 文档和 ScopedIDEApp，三个本地链接存在 |
| `aotui-app-builder/references/sdk_api.md` | 已跟踪、已修改 | defineParams／useAppEnv 等已迁移；仍有下列样例问题 |
| `aotui-app-builder/references/AOTUI_APP_LLM_FRIENDLY_GUIDELINES.md` | 已跟踪、已修改 | Hook 签名和部分配置更新；仍有旧模板与未经证明的字数硬规则 |
| `.agents/skills/minimalist/SKILL.md` | 已跟踪，本轮未修改 | 本次使用的减法方法；不进入产品 Runtime |
| `.agents/skills/feature-migration/SKILL.md` 及配套文件 | 已跟踪，本轮未修改 | 通用迁移方法，主文件引用的 blueprint、writing rules、脚手架脚本在库内；本次不是用它生成迁移包 |
| `skills/kenton-varda-infra/SKILL.md` | **未跟踪** | 90 行独立方法文档；未纳入上述提交或运行验收，未作为本次实施 skill 使用；当前会话可用 skill 列表也未列出它 |

### 8.2 确认需要收尾的应用开发指导

| 编号／建议优先级 | 事实与影响 | 建议，尚未实施 |
| --- | --- | --- |
| SK-01 / P2 | 主 skill 第 103 行 `WorkspaceView()` 自己返回 `<View>`；第 200–201 行 outline 又在 `<View>` 内渲染同名 `<WorkspaceView>`。参考 API 第 45 行也采用外层包 View 的用法；主 skill 没有明确写出禁止嵌套的规则。分段示例按同一组件组合时会触发 R2 已明令拒绝的结构 | 统一为“页面容器”与“内容组件”两种清楚命名，或仅保留一个可运行示例；直接写明 View 必须独立声明。现有 R2 测试证明运行合同，本次发现来自静态示例核对，未另建 Agent 生成实验 |
| SK-02 / P2 | `references/sdk_api.md:161` 用 `fd_${index}` 作动态文件 View ID；删除或重排文件会令逻辑文件的 View ID 改变。第 142 行 `({}) as any` eventBus 为无实现占位 | 示例改为稳定业务对象 ID 和显式状态回调，或删除这份重复骨架并链接当前应用。不能据此直接断言已有 Runtime 实例隔离被绕过 |
| SK-03 / P2 | 457 行 LLM-friendly guidelines 仍以 SystemIDEApp 为示例（272、282 行），并要求 whatItIs 超过 50 词、whenToUse 至少 5 场景（365–366 行）。主 skill 同时要求渐进披露和避免重复描述，两份指导容易膨胀上下文，字数硬门槛没有本轮效果证据 | 删除重复和过时规范，收敛到当前契约与简短可运行示例；用任务完成／修复轮次评估指导，而不是最低字数 |

两个 reference 文件不被主 SKILL.md 直接链接或要求读取，形成额外的文档漂移面；不等同于已经证明它们永远不会被人工／Agent 搜索使用。SK-01–SK-03 是 SDK 开发者体验和文档正确性问题，不能以 Runtime 拒绝非法输入为理由忽略。

`onDelete` 仍在当前 `TUIAppConfig` 并传入 kernelConfig，不能因为示例较旧就误判这个字段已退出；同样不能因为 `snapshot-value-v1` 字样仍在就误报旧传输恢复。

### 8.3 其他 skills 边界

- Kenton skill 明确自称对公开作品的方法归纳、非本人发布。此处只记录文件状态与内容范围，没有重新联网核验其 10 个来源、没有验证它能提升 AOTUI 开发质量。其 SHA-256 为 `0da89bc8f59274f40abeac9035772340ec673d7c22d9eb51b2836e8d78ca312e`。是否正式采用、放入已发现的 `.agents/skills` 体系或继续独立保留，尚无本次收尾决定。
- minimalist 末尾三个 `engineering/...` Cross References 不对应当前仓库内已提供的 skill 文件；本轮未依赖它们。它们是指导可发现性待核实项，不能当成已加载的规则。
- 没有对 feature-migration、minimalist 或 Kenton skill 做完整执行评测。未跟踪文件没有被擅自删除或提交；本报告不应将它算成已交付 SDK 能力。

## 9. 剩余问题、边界与优先级

| 项目 | 当前状态 | 下一步应如何判断 |
| --- | --- | --- |
| SK-01–SK-03 | 确认的文档／示例残留；本报告未修 | Pro 可优先确认；应以减法收敛，而非新建一套模板体系 |
| Kenton skill 归属 | 未跟踪、未正式采用 | 明确保留位置与启用范围，再决定是否提交；与运行内核无依赖 |
| 完整开发环境可复现 | 未完成全仓从零依赖安装；两 App 使用已有开发工具完成构建 | 对外发布前做一次干净环境安装和构建；不要把离线 tar 消费验证混同于全仓开发依赖验证 |
| Breaking Change 发布 | 未对外发布，也未准备完整版本发布说明 | 发布前列 SDK／Runtime 删除 API、应用迁移及持久化格式变化；不为此恢复兼容代码 |
| 最终 Host 自动化证据 | 项目所有者功能验收完成；代理没有新的完整 Host 全量绿色日志 | 保留两种证据的差异。若需要可重放发布门禁，再补自动化记录，不重复要求用户为同一验收审批 |
| Agent 开发 SDK 的效果 | 未做基于最终 skill 的生成成功率／修复轮次／私有 API 依赖率评估 | 接口与示例验证是必要条件，不等于证明 Agent 能稳定生成正确 App |
| 更大负载／平台 | MEM-01 限于固定版本和工作负载；自定义服务器、其他版本／语言和 Windows 的完整资源释放仍有原合同限制 | 不提高当前支持范围；按真实需求单独验证 |
| 原历史交付目录 | `/rfcs/sdk-runtime-delivery/` 忽略规则仍存在，但本机当前该目录不存在。此前约 17 GB 的未跟踪产物不在此路径 | 本次未查明何时移动或是否另存，不推断已经丢失，也不能称它仍保留在原处；未跟踪内容无法仅靠 Git 恢复 |
| QA 证据耐久性 | 四轮 QA 目录与 Pro 原独立复核目录本次仍在，但都处于临时目录 | 审核前按需归档。第二轮 builds.json 的 Runtime 失败／成功尝试指向同一个 runtime-build.log；退出码历史仍在，但不能声称每次失败 stdout 都独立保存 |
| 原 53 项逐条验收单 | 原 JSON 从 Git 可恢复，但保存版本是 planning-only；当前树没有一份被本次重新核验的 53/53 最终执行表 | 以本报告行为映射、代码和原始 facts 审核；不要把“所有旧路径消失”替代 I01–I20 |

以下是候选优化，不是本轮已证明的泄漏或必须修复的缺陷：Observation／Invocation 为源字节计量重复 copyJson；Snapshot 同时保留对象图与 canonical 字符串用于精确比较；Ref 调用在异步复核中重复构造捕获值。MEM-01 已由应用配置修复，这些候选没有实施。若将来优化，必须先量化分配，保留自定义 SnapshotStore 输入校验、精确比较、来源复核和 lease 生命周期。

应用层仍存在其他待审代码，例如 IDE 的全局 LSP／file-system-service 模块；当前默认入口 `src/index.ts` 导出 `scoped.js`。本轮未给全应用内部做完整可达性删除证明，不能把这类候选直接当作 SDK／Runtime Legacy 仍在生产运行。

## 10. Legacy 退出的准确含义

本次静态复核确认旧 Source、Dispatcher、SnapshotRegistry／builder、shadow receiver、V1 validator、InlineView、旧专用只读／创建 Hook 等代表性文件不存在；Host 使用 SemanticAOTUIDrivenSource。当前包 exports 无旧兼容入口。

以下出现旧词或版本号的内容不表示旧执行链恢复：

- `refSource: 'snapshot-value-v1'` 是 Ref 来源语义标记，执行模式是 `snapshot-value-v2`。
- `state-session-v1` 是当前持久化协议身份，不是此次退出的 Snapshot V1。
- `ideLegacyImportPath` / `readLegacyIDE` 是显式读取旧 IDE 业务数据的应用功能，当前默认不打开旧 LowDB；与 Runtime Legacy 分离。
- 历史报告、迁移前示例、拒绝旧工厂的注释和测试可以保留旧名称。
- `ActionOutcome`、readonly entity Ref、ScopePolicy、租约、预算和失败记录有现行职责，不因不像默认 DOM 作者接口就自动删除。

## 11. 证据目录、包身份与复跑方式

### 11.1 正式报告与原始证据

| 内容 | 位置 |
| --- | --- |
| R1–R5 | `runtime/docs/semantic-review-fixes-2026-11-01.zh-CN.md`；`/private/tmp/aotui-review2-_l1r6lbt` |
| 第一轮追加 | `runtime/docs/core-cleanup-2026-11-01.zh-CN.md`；`/private/tmp/aotui-core-cleanup-qa-rmfct119` |
| 第二轮追加、所有者确认 | `runtime/docs/core-cleanup-pass2-2026-11-01.zh-CN.md`；`/private/tmp/aotui-core-cleanup2-qa-jrdwl4wb` |
| MEM-01 | `runtime/docs/mem01-closure-2026-11-02.zh-CN.md`；`/private/tmp/aotui-mem01-no8r_1nf` |
| 当前实际安装包 | `/private/tmp/aotui-mem01-consumer-q07maitr` |
| Pro 原独立复核 | `/private/var/folders/hp/stypzkys30gdsjlhc9kfsqhr0000gn/T/aotui-independent-review-d9n_5ur8` |

当前关键 tar SHA-256：

```text
@aotui/runtime
c405d30ef622130a89c531f101678a910ca8c0e590f33c38badfbcb0b080bbea
@aotui/sdk
0cd0f10aa3bff3a9c7223be712ea31aa2cf48fea3da777c82a09133efcc80603
@agentina/aotui-ide（MEM 后）
f78900b5f076d7f0a6a20afa23858b16cc7335843c4275254fc3926b7d52121e
@aotui/agent-driver-v2
f844e69352b946d905cdb3f9bae1e00266f656dae872dc831bcb3789a5655477
```

其余 4 App 的哈希、命令、退出码在 MEM 目录 `packages.json`、`consumer.json`、`final-verification.json` 中。MEM 对照和最终数据在 `baseline-*`、`single-ts-ab-*`、`final-*`、`final-repeat-*`、`measurements-summary.json`；只有后两组无临时 Worker 覆盖的正式包数据用于最终关闭。

### 11.2 复核命令

```sh
# 从仓库根运行，先检查真实工作区状态。
git status --short --untracked-files=all
git diff --stat bb2ad7e6 bd5deea3
git show bb2ad7e6:AOTUI_SEMANTIC_CLEANUP_TASKS.json

# 当前 Core / SDK 完整检查；这些命令会实际运行测试。
pnpm -C runtime exec vitest run
pnpm -C sdk exec vitest run
pnpm -C runtime exec tsc --noEmit --noUnusedLocals --noUnusedParameters -p tsconfig.json
pnpm -C sdk exec tsc --noEmit --noUnusedLocals --noUnusedParameters -p tsconfig.json
pnpm -C sdk exec tsc --noEmit -p tsconfig.public-api-types.json

# 原 IDE 性能门槛，消费已经核对的最终安装包。
AOTUI_IDE_CONSUMER=/private/tmp/aotui-mem01-consumer-q07maitr \
  node demo-apps/aotui-ide/tests/scoped-ide-performance.mjs /private/tmp/pro-mem01-recheck.json
```

性能测试需允许读取进程树及探测自己的进程组；临时目录失效时应重建安装包，不要悄悄改成 workspace alias 后仍报告“新 tar 消费”。测试结果只对应实际运行的版本与产物。

## 12. 建议 Pro 的审核重点

1. 从保留入口追踪一次完整的“SDK 声明 → Worker 捕获 → Core 提交 → Scope 观察 → Context 调用 → View 更新 → release/close”，核对内容、Ref、Tool 绑定与实例一致性。
2. 优先检查正反配对：旧目标拒绝／新目标成功；容量满拒绝／释放后可用；非法投影拒绝／修复恢复；关闭等待／真实资源最终退出。不要只统计通过数量。
3. 检查 R1 的实例校验是否真在接纳点；R2 是否双层整体拒绝且不残留注册；R4 是否严格捕获发生在 IPC 前。
4. 检查简化后的计数、关闭状态和源缓存是否在异步未结算时仍正确占位；业务失败、partial、accepted、unknown 是否忠实传递。
5. 核实 SK-01–SK-03，并决定是否用一份可运行示例替代重复指导；明确 Kenton skill 的归属。
6. 区分 Runtime Legacy 下线、应用旧数据导入、历史命名和未审的业务模块；不要按字符串批量删除。
7. 按包哈希复跑关键反例，保留失败；对新发现注明“既有机制”“本轮回归”“文档缺口”或“尚待验证的推测”，不要仅因历史报告写 verified 就放行。

报告编写前的工作树唯一未跟踪文件是 `skills/kenton-varda-infra/SKILL.md`；本报告新增后，代码版本仍为上述 HEAD。没有推送、合并、发布或替用户提交这个独立 skill。
