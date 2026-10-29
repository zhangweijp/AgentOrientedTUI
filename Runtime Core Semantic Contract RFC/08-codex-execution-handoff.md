# Codex 工程执行任务书 — Agent-Native Application Framework

**角色与工作方式**：你是 Codex，负责实际编码、测试、复盘和交付；ChatGPT 是架构负责人和独立验收者。请在当前本地仓库直接工作，依据真实源码而非臆测。不要仅给建议，不要只做设计文档；在安全边界内实施并测试。分阶段完成，达不到 Gate 时如实标记 NO-GO，不要以局部通过冒充完成。

## A. 仓库、方向和不可改变的约束

工作目录：/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI

架构目标：将现有项目渐进演进为 Host/DOM/模型厂商独立的 Agent-Native Application Framework。公共概念为 **App / View / Ref / Tool**，SDK 保留 ViewTypeTool 的兼容入口。**Mobile、Agent Driver 明确不在范围内**。

已经选定且必须保持的方案 B：
- viewId：开发者填写、Agent 可读的逻辑 View 地址；同一挂载期稳定。
- viewType：View 类型，用于公开 Tool 聚合。
- viewInstanceId：Runtime 为每次真实挂载发行的不可重用实例身份；同名卸载重挂载绝不能继承旧实例。
- Tool 在拥有业务上下文的 View 内声明和管理；每实例 Handler 独立。Runtime 按 (App, viewType, toolName) 聚合公开定义，不能多实例覆盖、误删。
- 旧五参数 useViewTypeTool 与 IDE 现有 Tool Handler 必须渐进兼容；不要把历史的 viewGeneration 重命名为未经版本化的 viewInstanceId。
- 不允许将 Snapshot 说明/Tool JSON、可读 viewId 或 viewInstanceId 本身当作业务授权。

**先读**：
1. .agents/skills/minimalist/SKILL.md，遵守 YAGNI → 现有代码复用 → 标准库 → 原生平台 → 现有依赖 → 最小实现。
2. Runtime Core Semantic Contract RFC/00-charter.md、03-design.md、04-plan.md、05-tests.md、06-review.md、07-view-owned-tool-identity-proposal.md。
3. 实施证据 Runtime Core Semantic Contract RFC/m4-preflight/ 与 m4/stage3/、stage4/、stage5/、stage6/ 目录及本次 Stage7 相关日志。
4. 然后按入口函数追踪源码：runtime/src/core/snapshot、runtime/src/core/tool、runtime/src/worker-runtime、runtime/src/engine/app/worker-host.ts、sdk/src/components/View.tsx、sdk/src/hooks/useViewTypeTool.ts、sdk/src/hooks/useRef.ts、demo-apps/aotui-ide/src/tui、demo-apps/aotui-ide/src/core/versioned-file-write.ts。

**极其重要的 Git 安全要求**：当前仓库不是干净的工作树。交接时 HEAD=789ef07，git status --short 约 151 条，其中 git diff --cached --name-only 约 109 个已暂存路径。不要运行 git add、commit、reset、restore、checkout、clean、stash，尤其不能移动或覆盖用户原来的暂存变更。所有新的修改保持未暂存；修改前记录基线 Git 状态，并以 git diff、git diff --cached、git diff HEAD 区分用户原有变更与本次变更。不能把用户已暂存内容当成自己的完成成果。不要删除 untracked 文件，不要重排无关源码。

**安全和资源**：全部会写文件的测试仅可在自己创建的系统临时目录/隔离工作区运行，finally 清理；不得对用户真实 IDE 工作区或用户文件尝试破坏性操作。除非绝对必要，不安装新依赖、不改变 package manager、不联网使用不明外部服务；不得调用真实外部模型执行有副作用任务。测试进程结束后不留后台任务。

## B. 已交付的事实与交接起点

Stage 6 最后一次全量 Gate 真实日志：Runtime Core Semantic Contract RFC/m4/stage6/final-regression.log。
- Runtime：528 passed，3 skipped，7 todo。
- SDK：86 passed。
- IDE Jest：27 passed。
- Runtime、SDK、IDE TypeScript：全部 exit 0。

已经有：M1 Snapshot Core + V1/V2 版本化 Store、V2 严格 Ref/ToolTarget 身份、Snapshot 历史 Lease/TTL、SDK View-owned Tool、Runtime-issued viewInstanceId、Worker Shadow V2、Core source-binding、useEntityRef、真实 Worker/SDK Ref 来源、旧 ToolResult success:false 保真、旧 Ref 后缀跨 View 误解析修复、IDE 稳定公开 fd_N、排他 create_file、受控 versioned-file-write.ts、只读实验 Tool 调度，以及需要单独开关的实验性 versioned mutating File 路径。**上述不表示正式 Agent Router 已完成迁移或 Strict 已可开启。**

Stage 7 最近修改了 worker-host.ts 的关闭/回收/强制终止机制：status=closing、activeFileReplacements、waitForFileReplacements、terminateAfterFileReplacement。Stage 7 的专项 lifecycle.test.ts、部分实际 Worker 组合测试已通过，但 **Stage 7 还没有正式完整回归与 RFC 验收结论**。Stage7 目录有中途失败日志，也有后续通过日志；不得只引用任意一次中间日志作最终判定。

目前最大未关闭的 Gate：
- 写入 Tool 从可信来源到真正业务授权、并发/中断/结果未知的一致性；
- SDK/Preact 异常、异步与第三方 Hook 下的真正 Snapshot Capture Barrier；
- 旧 Agent Tool Dispatcher 的 V2 来源迁移和 Legacy stale Ref 处理；
- 真实 IDE 多文件/LSP/文件修改 E2E 及 CPU/内存/p95 性能预算；
- 纯 TS Semantic Runtime Core 的完整 App/View/Tool/Ref/Snapshot 组合及 DOM/Worker 可替换 adapter，不能因为已有 Snapshot Core 就宣称全 P1 完成。

## C. 必须按此顺序实施；每一阶段均提供证据

### C1. 优先完成 Stage 7：关闭、RESET、terminate 与磁盘写入竞态

第一件事是审查当前 Stage7 diff 和已有测试，不要重新造生命周期框架。

关键不变量：
- Close/RESET/terminate 开始时立即阻止新的实验性写入获授权进入；
- 已开始的磁盘 CAS 是不可简单撤销的副作用。正常 close/池回收须等待已有写入结果明确后才释放旧 App/Worker；
- 正在异步授权或 Worker 验证但尚未开始真正替换时，close 应令其拒绝，不能因等待授权而死锁；
- forced terminate 的等待与多次调用必须幂等；close/RESET/terminate 竞态不能重复关闭、遗失事件或把被回收 Worker 绑定给另一个 App；
- 写入成功但回包丢失、cleanup 失败、Worker 在写盘后崩溃，必须报告真实的 written / conflict / outcome unknown，不可把已成功写盘错误宣布失败以诱导 Agent 重试；
- 同一个 App 的旧 V2 Snapshot 在写入后未刷新实体版本以前，不得重复写入；实际刷新为新版本后才允许再次验证；
- 不要以强制取消 Promise 伪装为撤销已执行的系统调用。

增加稳定、可控的 deferred Promise 屏障测试，不依赖 flaky sleep；包含真实 Worker、同一物理 Worker RESET、并发多个写请求、close/terminate 期间错误结果、Snapshot 回收与 Lease 释放。确认所有资源最终清理且无数据损坏。

### C2. 收敛受控写入的文件系统安全范围

审查 demo-apps/aotui-ide/src/core/versioned-file-write.ts。已采用 SHA-256、工作区 realpath、final symlink O_NOFOLLOW、hardlink 拒绝、同目录 wx 排他锁、临时写入 fsync、最终 inode/版本重查、rename。**它只保证合作式写入者的并发安全，不是无条件的跨进程 OS atomic CAS。**

重点测试/修正：父目录或 lock 被替换、symlink/hardlink 和工作区逃逸、真实文件读取途中被改动、文件不存在、已存在 lock/锁崩溃残留、临时文件清理失败、rename 已成功但 cleanup 失败、8+ 并发写入只允许一个写入成功、非合作外部进程竞态的明确非保证。

安全设计选用现有 Node fs 功能，优先小 diff。不要引入锁服务器或声称通用文件系统事务。若平台做不到强保证，必须 fail closed 并写明边界；不要在用户实际目录做压测。

### C3. V2 来源 + 权限 + 活态 Handler/文件版本写入的严密连接

沿当前现有链路逐层核对：
SDK useEntityRef / View-local Tool
→ Worker DOM V2 Draft
→ Runtime Core Committer/Store
→ acquireVersionedEntitySource (真实 Lease，ViewInstanceId、bindingVersion、File entityVersion)
→ Host 可信、明确的授权回调（检查操作参数、工作区、文件路径/版本、角色）
→ Worker VIEW_TOOL_VALIDATE（只校验活态绑定，**绝不执行 mutating Handler**）
→ 真正磁盘文件 Adapter 的版本检查与受控替换
→ 真正的业务结果及更新后的 Snapshot。

修复“授权开始有效，await 后失效”、“Worker 实例被重用”、“文件外部修改”、“旧快照重放”、“权限拒绝或变更”、“重复写入”、“返回状态异常/未知”等失败路径。尽可能以真实 SDK + Node worker_threads + temp filesystem 构造一个连续 E2E，禁止只用 Mock 宣称通过。

当前 experimentalVersionedMutations 必须保持 **默认 false、与 Shadow 明确绑定且不接入旧 Agent 自动 Tool 路由**。除非真正完成所有授权/业务 CAS/IDE 全栈 Gate，否则不得切换为生产默认 Mutating Tool。

### C4. 解决 Snapshot 捕获原子性剩余硬问题

验证 SDK 初始化、更新和卸载中，View/Ref/Tool 是否在同一受控提交准备后被 Worker 捕获；覆盖仅 Ref 变化、仅 Tool schema/enabled 变化、快速 list reorder、同名 View remount、异常渲染/cleanup、连续异步 state set 和恶意 Ref getter/非 JSON。

每个不一致 Draft 必须拒绝、降级且 lastGood 保留，绝不可错误发布为 ready Strict。检查 AppInstanceId、producerSeq、sourceEpoch、Revision、Lease TTL、Workspace version vector；V1/V2 必须显式共存，混合 Root legacy Tool 与 View-local Tool 不能默默丢失声明。保持 Core 无 DOM/Preact/Worker/模型 Provider imports。

在真正证明 Producer consistency、准出真正 IDE 工作负载及权限前，报告必须维持 producerConsistency=unverified、strictEligible=false；不能通过改字段造绿色报告。

### C5. 正式执行迁移与实际 IDE E2E（按风险渐进）

真实 IDE FileDetail 的 View ID 不得再次由 activeFiles 数组下标决定，也不能在 create_file 后预测一个 fd_N。业务 Tool 优先拥有自己所在 View 的状态；同类型 Tool 名称相同可聚合，不可跨实例覆盖/误删。

逐步建立新旧 ToolResult/参数 Schema/Ref 解析/权限的对照测试，尤其包含：
- 一个 Root 级 legacy Tool 与多个 FileDetail view-local Tool 同时存在；
- 关闭 A 不注销 B；旧 fd_N 不会指向新文件；
- FileDetail 两个文件路径相似/同名 Ref，旧 Snapshot 的 mutating 调用不会误选；
- LSP 未准备好、文件已删除、外部版本变化、工具 Handler 返回 success:false；
- 真正隔离临时 IDE 工作区中的 open→view→Ref→Tool→文件编辑→刷新→再操作流程。

只有来源、执行权限、业务结果、文件版本和性能 Gate 都达标，才考虑正式 Dispatcher 切到 V2。不得一次性重写 RootView 所有业务 Handler，不得把 ViewInstanceId 当成一个“授权凭证”。

### C6. P1 架构边界及性能（在 P0 Gate 证据之后）

评估现有 runtime/src/core 的 App/View/Ref/Tool/Snapshot 是否能完全在纯 TS 内存运行和单测。若缺 App 注册、生命周期、Tool 调用和 View-owned 聚合等必需语义，补最小内存 Core，不回流 DOM/Worker/Preact 到 Core；DOM、Worker、SDK 仅为 Adapter。

补真实 IDE 多 View/LSP 大工作负载性能和资源用量，区分 V1/V2 同负载对比，统计 CPU、峰值内存、Snapshot bytes、revision 抑制、p50/p95，附环境与可复现脚本。早先 Synthetic V2 100 Views 的 p50 大约 9ms 量级，不等于真实 IDE SLA；不能自定预算后立即宣布通过。未经可核查用户批准的阈值，写成“未设产品正式预算，No-Go”。

## D. 编码过程与质量门槛

每段按以下工程循环：
1. 先读相关当前源码并写出精确不变量与反例；查已有实现，不重复造接口。
2. 先有失败测试（或者说明为什么旧测试已足够），最小改动修复，运行定向测试；
3. 运行 TypeScript 和 SDK/IDE 相关测试，审查 diff 没有重复身份/状态源；
4. 真正 Worker / SDK / IDE / 临时文件系统 E2E 及失败路径覆盖；
5. 对风险高的竞态用可控 Promise barrier 或同输入多次复跑证明确定性；
6. 保留每次测试命令、退出码和日志。中途失败不能删除或隐藏，说明修复与最终状态；
7. 阶段严格 Gate 未满足时保持 No-Go，转向有价值的安全任务，不通过降低断言、skip 测试或掩盖错误求绿。

每个完整阶段（不只目标文件）必须执行：
- pnpm --dir runtime exec tsc --pretty false
- pnpm --dir sdk exec tsc --noEmit --pretty false
- pnpm --dir demo-apps/aotui-ide exec tsc --noEmit --pretty false
- pnpm --dir runtime exec vitest run --reporter=dot
- pnpm --dir sdk exec vitest run --reporter=dot
- pnpm --dir demo-apps/aotui-ide exec jest --runInBand

针对 Core/SDK/IDE 的新增关键文件做 scoped 覆盖率；既有某些全模块测试覆盖率未达到阈值，不能通过选择性统计谎称全项目覆盖率达标。对 real Worker + CAS 和旧 Ref/ToolResult 做至少 3 次独立重复执行；若 flake，先定位并修复或标记 Gate FAIL。实际写文件 E2E 使用 mkdtemp 等系统临时目录并在 finally 清理。

## E. 必须保留的安全 No-Go

不允许仅凭 ViewInstanceId 或 Snapshot V2 结构合法就授予写入权限；不允许把来源 Snapshot 的旧资源内容当最新文件内容；不能将 Node fs wx/rename 伪称跨所有非合作进程绝对原子 CAS；不能把 Stage 3 只读实验成功等同所有 Tool 可安全执行；不能把旧 Agent write_file/edit_file/delete_file 路由悄悄改成 Strict。发现无法证明的 OS/文件权限/SDK 异常 Capture 能力应明确标记 No-Go，并报告最小可行替代方案。

**不能重定义项目范围**：不做 Mobile，不做 Agent Driver；不要扩散到无关插件、文档大重排或产品 UI 美化。框架命名以 App/View/Ref/Tool 为准，不把 legacy Operation 扩散到新公共 API。

## F. 交付格式：供架构负责人独立验收

在 Runtime Core Semantic Contract RFC/m4/codex-handoff/ 下交付**一份集中报告 RESULTS.md**（其余以简洁原始测试日志/可复现实验脚本作为证据，避免写五六份内容重复的大文档）。报告必须包括：

1. 基线：HEAD、Node/pnpm、开始时 Git status 总数及 staged/untracked 数；与交接前差异。
2. 事实/修改清单：每一问题的入口代码、失败场景、实施 diff、为何用最少新抽象、兼容路径影响。
3. Gate 表：各阶段 PASS / PARTIAL / NO-GO，明确证据文件和未完成约束；不写空泛“测试通过”。
4. 准确命令/退出码与测试数量：Runtime、SDK、IDE 类型检查、全量测试、真实 Worker E2E、真实文件系统竞态、覆盖率及稳定性复跑。
5. 性能：同一负载的 p50/p95、峰值内存/文件资源、安全局限、真实 IDE 是否达产品预算。
6. 风险与未完成：Legacy Router、真正文件写入权限/CAS、Shadow/Strict、第三方 Hook、Host/Provider 独立性，尤其哪些无法证明。
7. Git 安全审计：未 stage/commit/reset/stash/clean；列出本阶段新增/修改文件；显式说明保留了用户原有 109 个左右已暂存路径及全部 untracked。
8. 最后用最多 10 行的简明工程结论说明“实际完成了什么 / 未完成什么 / 为什么”。

**不要自行宣布生产 Strict 已完成**。完成本次可安全实施的工作后，给用户准确路径和报告摘要，并明确请求 ChatGPT 负责人进行独立验收。ChatGPT 无法自动后台监控你的执行，用户会在 Codex 交付后重新发起验收。

## G. 给你（Codex）的第一条行动指令

**立刻从核对 Stage 7 开始**，不要先生成新框架或重写 RFC：
- 记录当前 git status 与 staged 变更；
- 阅读 worker-host.ts 中 close、releaseWorker、terminate 与 executeVersionedFileReplace、现有 Stage 7 lifecycle/test/log；
- 把 Stage 7 的可控并发/异常恢复测试补齐，完成全量 Runtime/SDK/IDE Gate；
- 然后按 C2→C6 逐项进行，所有修改都必须保持 V1 兼容和默认实验开关关闭。
