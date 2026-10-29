# CODEX_MASTER_PROMPT — AgentOrientedTUI M4/M3/M5 交接

**Codex 是实施工程师；ChatGPT GPT-6 是架构与独立验收负责人；用户是最终产品所有者。**

工作仓库：/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI
当前最新已验收阶段：M4 Stage 7 limited PASS；真正的 M4 Full / Strict / M5 **NO-GO**。
**本次只执行 Wave 1 / Stage 8，完成后停止，交付给 ChatGPT 验收，未经验收不得自行开始 Wave 2–4。**

## A. 必须先查证现状，不能直接写代码

1. 完整阅读 .agents/skills/minimalist/SKILL.md；同时阅读 Runtime Core Semantic Contract RFC 下 00-charter 至 07-view-owned-tool-identity-proposal，以及 m3/RESULTS.md、m4-preflight/STAGE1_RESULTS.md、STAGE2_RESULTS.md、m4/stage3 至 stage7 的 RESULTS.md。**实际 TypeScript 代码和实际运行结果优先于历史文档**，报告任何差异。
2. 首先以只读方式记录：git rev-parse HEAD、git status --porcelain=v1、git diff --cached --binary | shasum -a 256、git diff --binary | shasum -a 256、Node/pnpm 版本。仓库 HEAD 历史为 789ef07，至少 150 项 staged/modified/untracked；全部视为用户数据。
3. 先列出真正要变更的模块、可复现缺陷以及新负例测试，再最小修复。不进行架构重写或扩张范围。
4. 当前历史回归：Stage 7 Runtime 65 files / 536 passed、3 skipped、7 todo；SDK 86 passed；IDE 27 passed；三处 tsc exit 0。这些是历史证据，**不是今天当前测试已通过的断言**，你必须重跑。

## B. 不可触碰的红线

- 严禁 git add、commit、reset、checkout、restore、clean、stash、push、rebase；严禁对用户原有的 staged/untracked 改动做任何清空、覆盖、批量重置。最初和最终 staged binary diff SHA-256 必须一致，HEAD 必须一致。若改变则停止并上报，切勿自己修复 index。
- 不降低 TypeScript 配置、不 skip/todo 失败用例、不篡改测试期望隐藏问题。新增测试必须真正捕获失败，并证明修复效果。
- 不添加依赖、Tool 注册框架、额外身份系统或第二份 Snapshot Store。复用已有 Core / Store / SDK Hook / Worker IPC / Node。遵循 minimalist、YAGNI 与最小差异。
- 不触碰 Mobile / Agent Driver，纯 Core 不可引入 DOM、Preact、Worker、模型供应商和文件系统；Host/DOM/model-vendor independent 的 App/View/Ref/Tool 是长期目标。
- Shadow 的 producerConsistency=unverified 和 strictEligible=false 没有严格一致性证据不得修改。V2 的结构、ViewInstanceId、isMutating、内容哈希都不是权限凭据。
- 默认 Agent 的 Legacy write_file/edit_file/delete_file 与自动 Tool Router 不得无授权改路由。实验写入只有 Runtime Host 显式开关 + Controller 显式权限策略 + 来源 V2 + 活态 Worker Tool 校验 + 资源版本 CAS 才能运行。
- 测试所有文件操作仅可使用 mkdtemp 内独立工作区；不得碰真实用户文件、Git 配置、Secrets 或外部网络。
- 不能承诺对不合作的外部写入进程存在真正 OS 原子 compare-and-swap；Node wx 锁只序列化合作写入者，hash 无法识别 A→B→A，rename 会改变 inode/ACL/xattr。未证实写 NO-GO 或 NOT TESTED。

## C. 已确立的长期契约（严守）

- viewId = 开发者填写、Agent 可读的地址。viewType = View 类型与 Tool 聚合分组。viewInstanceId = Runtime 为每次真实挂载发放的不可复用具体身份。不得再造长期 ViewKey/Generation/UUID 互相竞争。
- View 自己声明/注册/启停 Tool；Runtime Map 按实例隔离 Handler，按 App+ViewType+ToolName 自动聚合公共定义；bindingVersion 只用作注册版本/可用性失效，不是第四个 View 身份。
- Snapshot V1 / V2 显式版本化；V2 同一 Core Commit 记录 ViewInstanceId、Ref 来源、Tool target 及 bindingVersion；Store 的 Lease/History/TTL 是唯一可信来源。不能从旧字符串重新按当前 ViewId 选择 Handler。
- 观察不等于授权：执行前检查 AppInstance、ViewInstance、Tool binding/schema、用户角色/权限、业务状态和文件内容版本；Legacy global suffix Ref fallback 禁止恢复。
- ToolResult 业务 success:false 必须透传到 Agent；IPC 交付成功不等于业务成功；文件已修改但适配器响应丢失时返回 outcome unknown，不能谎称失败诱导重试。
- M4 Stage 7 的实验写入已有 Store→Worker VIEW_TOOL_VALIDATE（只检查绑定）→受信任 Controller 注入的版本文件适配器；默认关闭、不调用 SDK Mutating Handler。不要擅自宣传为完整生产 Mutating Tool。

## D. 当前代码与测试入口

Core：runtime/src/core/snapshot/{types,json,validator,v2-validator,store,index}.ts，runtime/src/core/projection/coordinator.ts，runtime/src/core/tool/{view-owned-tools,source-binding}.ts。
Worker：runtime/src/worker-runtime/{app-kernel/AppKernel,dom-snapshot-producer,index}.ts，runtime/src/spi/worker-protocol/messages.ts。
Host：runtime/src/engine/app/worker-host.ts、runtime/src/adapters/snapshot/shadow-receiver.ts。
SDK：sdk/src/components/View.tsx，sdk/src/hooks/{useViewTypeTool,useRef}.ts，sdk/src/app-factory/createTUIApp.ts。
IDE：demo-apps/aotui-ide/src/tui/{SystemIDEApp,RootView,create-file-workflow,file-view-ids}.ts(x)、core/{versioned-file-write,file-system-service}.ts。
重点 E2E：runtime/src/engine/app/worker-host.m4-{lifecycle,versioned-file,producer-race,v2-shadow,readonly}.test.ts，runtime/src/core/tool/versioned-file-integration.test.ts，SDK src/view-owned-tools.test.ts，IDE src/__tests__/versioned-file-write.test.ts。

## E. 当前实施：Wave 1 / M4 Stage 8（执行并停在 Gate）

**目标：补齐真正会造成误写、错误结果、半关闭或来源撕裂的反例，不扩大 Agent 执行权限。**

1. 检查 experimental executeVersionedFileReplace 请求值在 async policy 等待期间能否被 caller 改变。若可复现，使用现有 copyJson 严格校验五个字符串字段并深度复制/冻结一次；此后 source 选择、authorize、Worker IPC、File Adapter 只能使用同一份稳定值。新增真实 Worker 测试：改变目标 viewId/newContent，恶意 getter（不能执行），超预算/未知字段、非法对象；禁止把捕获失败当 raw success。
2. 审核 AppWorkerHost 重复 close、releaseWorker、terminate、open/pause/resume/reinitialize 与正在授权/写盘交错。精确区分只是在政策等待（可在 closing 后拒绝）与已进入不可撤销的磁盘副作用（关闭/回池应等待真实结果）。用最小 Promise single-flight，不发送重复 APP_SHUTDOWN/APP_CLOSE；失败时不能卡在半关闭。确定性 Promise gate 单元测试与至少 1 个真实 Worker 关闭竞争 E2E。
3. 审核写盘成功但 V2 Ref 尚未更新、写入内容哈希不变（仍改 inode）、CAS adapter 返回 unknown、WorkerPool RESET 之后的重试和权限泄漏。正确区分 success/conflict/outcome unknown；结果未知和无可检测新版本时 fail closed。明确系统限制：不合作外部写入者、A→B→A 和真实磁盘事务不受内容 hash 保证。
4. 审核现有 Worker 在 captureV2 Draft 构造前后的 epoch 检查；已存在机制不要重复造。用 SDK+真实 Worker 故障注入证明：构建 Draft 期间 epoch 变化 → SNAPSHOT_PREPARE_FAILED、不发布 torn Draft、稳定后恢复。
5. 测两个 FileDetail 同名 file Ref、同名 replace_file Tool，历史 fd_0 不能误操作 fd_1；以真实 V2 Core + 临时文件系统或真 Worker 的稳定测试证据证明。
6. 如发现可造成真实误写的新增高优先级漏洞，可以在 Wave 1 范围内修复并留证据。其余问题不得趁机做全项目重构。拒绝依赖延时猜测的 flaky 测试；优先 Promise gate 和受控状态迁移。
7. 每个安全用例先写失败原因、对应测试、最小修复、重跑结果。定向稳定性至少 3 次、真实 Worker E2E，每次实际 exit 0。
8. 完整回归必须执行：
   - pnpm --dir runtime exec tsc --pretty false
   - pnpm --dir sdk exec tsc --noEmit --pretty false
   - pnpm --dir demo-apps/aotui-ide exec tsc --noEmit --pretty false
   - pnpm --dir runtime exec vitest run --reporter=dot
   - pnpm --dir sdk exec vitest run --reporter=dot
   - pnpm --dir demo-apps/aotui-ide exec jest --runInBand
   各命令需保留真实退出码和日志；不要按历史基线虚构 PASS。
9. 编写真实证据于 Runtime Core Semantic Contract RFC/m4/stage8：CODEX_RESULTS.md、GATE_STATUS.json、test-*.log、source-fingerprints.json、NEXT_WAVE_RECOMMENDATION.md。说明局限、未覆盖情况、所有原 staged 文件的 SHA 对比。
10. **完成 Wave 1 即停止、不得开始 Wave 2**。Codex 的“建议 PASS”仅供 ChatGPT 验收，不准 Codex 自行调整 Strict、合并、提交或开始后续阶段。

## F. Wave 1 验收后才允许继续的后续路线

### Wave 2 / M4 Stage 9 — 正式 Ref/Tool 来源路由
- 从 Agent 的所见 V2 Snapshot，通过可信 Store/Lease 把 viewId 固定到 viewInstanceId，再与当下 Tool binding/Schema/Handler/角色权限和业务版本比对。不从 Legacy 同名后缀猜 Ref，不因为 UI 重挂载误导路由。
- 新/旧 useViewTypeTool 签名兼容，Root 自己拥有 Workspace Tool，FileDetail 自己拥有文件 Tool，Runtime 聚合类型定义。
- ToolResult 业务失败/传输成功彻底分开；真实 Worker + SDK + Agent Adapter + IDE E2E。
- 不得直接把 Legacy write_file/edit_file/delete_file 切为 V2 可写路径；需要另有权限与资源版本 CAS 证明。

### Wave 3 / Strict Snapshot Capture 和 Mutating 正式 Gate
- 预期的 Preact 事务边界、异常重入、Ref/Tool-only、不可序列化 Ref、Marker 词法/转义和业务无通知原地修改，做到可验证的 contract 或明确拒绝/降级，不承诺无法实现的全知检测。
- 对 100/1000/10000 个 Ref/Tool/Targets 的 JSON bytes、CPU/heap/TTL/Lease 预算做真实压力验证并 fail closed。
- Mutating Tool 必须被可信 App/View/Tool/Ref 与权限和文件实体版本约束；业务写入当下比对版本，处理外部并发、取消、结果未知和崩溃锁。所有写入测试只用 mkdtemp 隔离目录。

### Wave 4 / M5-M6 — 真 IDE/LSP 与第二 Host Adapter
- 多文件打开/关闭/重排/创建/编辑/删除、LSP 背景结果、Provider 变化、Worker/DOM reset 的真实 IDE E2E。
- 至少一个独立的非 DOM/Worker Core Adapter 真合同测试；别用 mock 假装证明 Host 无关。
- 实际 IDE CPU/heap/Commit p50/p95 与相同负载对照；合成微基准不等于产品 SLA。
- RFC 的 00–07 与阶段报告、INV/D/M traceability 实测更新；完成所有 Gate 才可能推荐 Strict GO。

## G. Codex 每批输出和退出标准

本阶段必须在 m4/stage8 内真实写入：
- CODEX_RESULTS.md：真实修改文件、失败场景、原因、取舍、兼容风险、完成与残余限制。
- GATE_STATUS.json：stage、head、baselineIndexSha256、finalIndexSha256、tests 每个命令的 exitCode/passed/skipped/todo、securityCases、performance、goNoGo、blockers（未知必须填 null/NOT_TESTED）。
- test-*.log：工具真正运行的 stdout/stderr 和 exit code，禁止只写概况或编造数据。
- source-fingerprints.json：本阶段所有新/改文件 SHA-256；区分先前工作树和本阶段改动。
- NEXT_WAVE_RECOMMENDATION.md：下阶段最小路径及未满足门槛，不替 ChatGPT 直接批准。

最后 Codex 答复按六块组织：实际代码交付、通过的 Gate、失败/无法验证、原 staged index 是否完全保持一致、证据文件路径、下一批最小建议。**Wave 1 完成后必须停止，把所有内容交给 ChatGPT 做独立审核。**
