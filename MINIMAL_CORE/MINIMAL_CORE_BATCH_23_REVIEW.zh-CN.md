# Batch 23 独立复核：Agent 参数说明已落地

**APPROVED。批准的一个说明文件已应用共享源码并重新构建，负责人完成了落地后的独立复验。** B22 的协议仍仅在隔离候选中，没有一起采用。执行者未自行批准；正式授权先记录在 [精确应用批准](../review-evidence/minimal-core-batch-23/owner-review/application-approval.json)，本记录签收应用后的实际状态。[独立最终核验](../review-evidence/minimal-core-batch-23/owner-review/final-verification.json)

## 改变与职责

默认说明现在使用 SDK 实际输出的 `[显示文字](完整引用名)`，要求保留引用已有的类型前缀、大小写和下标。删除“对象参数一律传 Ref”及“Ref 替代所有普通 ID”的全局指令，明确文件直接传路径、普通 JSON 按 Schema 传值、显式 Ref 参数才复制引用名。任意 Markdown 链接不会因此成为 Ref；引用也不自动把完整对象展示给模型。

必要行为仍由现有模块承担：SDK 发布页面和引用；Source 提供实际上下文与工具声明；既有参数合同和 Core 解析/授权；Driver 执行工具；应用检查自己的文件权限、版本和业务条件。没有新解析器、参数转换、状态管理器、兼容层或依赖。作者不需要为了普通文件路径再注册一层引用。

## 精确签收对象

| 对象 | SHA-256 |
| --- | --- |
| 单文件 patch | `112e2a594ee119e23f15428b85e46445ffe9f9c654a4e60aa08f7dd5e7dac80c` |
| 共享说明源码 | `5aa85eab652e8867d372f6e2d5c68430dd57d099c7d2eacfaa0f061eab7de778` |
| 隔离 READY 报告 | `ab5f982dc6ae5303740347cb6a713d44a2bc13324c25f435737d9495ad8d2370` |
| 隔离 READY 清单 | `0801e72a153d98fe13eac29a2643cb215fc0aedc5acab6262ffbe96cccfe8449` |
| 隔离 B23 Runtime tar | `46c39d592ce11ec950ab10dbf15568b55278d0a5c3702366feb0c443e063a7e6` |

唯一生产差异为 `runtime/src/adapters/system-instruction.ts` 的默认说明文本。应用前核对旧 SHA `1a491f3509ad6aae8bba62a5b4cee659af59e67440915794ec5f98ab82c92c36`；共享构建的 372 个文件前后只有对应 JS、source map 和 d.ts 字面值变化。源码 loader 和其他声明不变。369 份隔离交付逐项核对一致，52 项独立复跑输入未变；本次签收时开工的 12,189 个路径中只有上述目标变化，无缺失，HEAD/index 不变。

原 [READY 报告](MINIMAL_CORE_BATCH_23_REPORT.zh-CN.md) 保留交付时“尚未共享应用”的历史状态，实际应用单独记录，不改写原件。[应用记录](../review-evidence/minimal-core-batch-23/shared-application/application.json)

## 独立验证

负责人在新目录 `/private/tmp/aotui-b23-replay-dbzchre_` 从固定 Git、历史补丁、封存输入重新执行完整 B23 入口，退出 0；候选 tar 与执行交付相同。两侧实际安装包，SDK 不变，包来源逐文件校验。负责人另核对了 provider 请求中整段默认说明与 Source 原文逐字一致。

- 修改前后各 42 项既有 Source 测试通过，覆盖身份、生命周期、错误隔离和说明覆盖方式；未弱化断言或新增镜像测试。
- 每侧真实 Worker/Source、现有 Driver 构建、真实 LLMClient/streamText 接受一次受控 provider 响应；Driver 串行执行三次，路径、普通 JSON、显式 Ref 的业务各进入一次。普通参数无 Ref 来源，Ref 授权及业务得到原观察的对象。
- 省略前缀、猜名、普通 URL 和直接上传对象均在 Core 派发前拒绝。另两项文件权限/版本错误由 App 返回失败，不能写成 handler 从未进入。文件正文只在 View，收据不重复正文。
- 模型只收到工具声明，未获 execute；三个调用/收据配对，Context 释放一次，Scope/lease 归零，实际关闭 `ok/resourcesReleased=true`。
- 原始输入按开工 SHA 封存。另在私有影子目录模拟说明已采用、活文档已更新，历史重建仍成功，未通过改旧记录迁就新状态。

[独立命令](../review-evidence/minimal-core-batch-23/owner-review/independent-commands.json) · [独立完整证据归档](../review-evidence/minimal-core-batch-23/owner-review/independent-evidence.tar.gz)

**共享落地后另验：** 负责人独立执行共享两个原测试文件，42 项通过；直接加载 `runtime/dist` 的真实 Runtime 和 Source，默认、直接覆盖、路径覆盖、环境变量、缺失文件 fallback、opt-out 六项均通过，自定义文本不被改写。共享支持模式仍为 `ordinary-v2`、`snapshot-value-v2`，不以隔离 B22 的普通 Ref 成功冒称共享已具备新协议。[共享测试](../review-evidence/minimal-core-batch-23/owner-review/shared-tests-command.json) · [共享实际构建的六项观察](../review-evidence/minimal-core-batch-23/owner-review/shared-source.json)

## 未覆盖与下一步

受控 provider 固定生成调用，仅证明说明进入请求、参数传递与执行链正确；没有真实 LLM 理解评测、全 App/GUI 验收或发布。既有自定义说明保持原内容，不会自动更新。未改变 Ref 生命周期、公开作者 API、观察采用策略或最终 Semantic 验收状态。

**下一批 Batch 24 已下发只读盘点。** 从 B23 后的真实共享版本，核对 B22 采用的前置改动与共享独有行为，逐项区分 Ref/ArrayRef 的发布、编译、Core 解析、Worker 运行证据，列出现存消费者及旧入口退出条件。准出是可核对的依赖/能力矩阵、保留失败原件的隔离 patch 检查、生产指纹不变，以及一个最小后续实现范围和 Codex Prompt；不执行协议采用或冲突解决。[具体范围、准出及 Prompt](MINIMAL_CORE_BATCH_24_TASK.zh-CN.md)

D3 历史迁移仍取消。SRT-01 的作者评测由另一 Owner 独立签收，不能拿它代替本批 Agent 使用 Ref 的理解验证。
