# Batch 22 独立复核：普通工具接收页面中的对象引用

**APPROVED。签收对象是隔离候选，不是共享代码采用或发布。** 技术负责人逐文件审查了 22 个生产差异，在新目录从签收 Git 与三个既有补丁重建，并独立执行全部验收入口。执行者没有批准自己的代码。[执行报告](MINIMAL_CORE_BATCH_22_REPORT.zh-CN.md) · [独立核验记录](../review-evidence/minimal-core-batch-22/owner-review/final-verification.json)

## 改动解决什么

作者可以在一份普通工具声明里表达“这个参数使用页面上发布的一个对象引用”。Agent 传页面上的完整名字，Core 根据原观察获准的来源取出对象，授权策略和业务函数收到内容相同的值。工具仍属于 App 的 ViewType，数据来自具体页面；两种身份各自保留，没有借用旧实例工具冒充普通工具。

验收采用 Planning 示例的一条业务记录作数据，不表示项目要引入新的计划管理功能，也不要求文件等已有自然标识的对象改用 Ref。项目所有者随后明确：文件工具直接使用文件路径，不再强制包装一层 AOTUI Ref。只有显式声明为 Ref 的参数执行引用解析。

本批收敛普通工具的参数解释与跨进程传参，复用现有编译合同、观察来源、SnapshotStore、授权、Scope/调用记录和 Worker 门禁；没有新增管理器、状态镜像、依赖或公共 Ref helper。原单页 Ref 入口仍有消费者，保留既有实现，待完整迁移后另行退出。作者没有新增手工解析、二次声明或自行授权步骤。

## 精确签收身份

| 对象 | SHA-256 |
| --- | --- |
| 独立生产 patch | `0b59acc9823c868c928e68def85d1fe9ad10c64e82d7401dc3b53cdf5671b22a` |
| 执行报告 | `3d5325075631b0e389a31890d4fc7446ae6dacfa8a40d8fe2c55b83901f408d6` |
| 执行交付清单 | `289e5f12ddae852af11dd05bcf6058ccba1aa2bb5c0540fe2fb966d22d88511f` |
| 候选 SDK tar | `c5c750464c7151e230654fcf4ae5846df4d2a02f47876d558a4a1b48257391ff` |
| 候选 Runtime tar | `0f0896237ec113c65fcd91b4e3697229fd7b647a811eae10f8b4dbb2f4f7573b` |

基线是 SRT M4.3 `853495dd9954eb4f8a91998bcc59e19326765981` 加 B14 R1、B15 R1、B16 签收补丁。两个候选沿用包内版本字符串，因此必须用 tar SHA 区分，不能把这里的能力归到原 M4.3 包。415 个既有源码路径只出现白名单内 22 个生产差异，patch 正反重放均精确恢复。

负责人全新复跑目录为 `/private/tmp/aotui-b22-replay-pq67y3b9`。23 个顶层命令按实际预期结束，其中两个完整 Runtime 严格库检查仍为既存失败，详见下文。68 个重放输入前后未变；671 份交付文件与 3 份已有负责人输入逐一核对；签收时开工的 11,382 个共享路径、HEAD 与 index 均未改变或缺失。[命令原始记录](../review-evidence/minimal-core-batch-22/owner-review/independent-replay-commands.json) · [独立复跑完整证据归档](../review-evidence/minimal-core-batch-22/owner-review/independent-replay-evidence.tar.gz)

## 行为依据

- 原作者 TSX、编译 JS、原 R1 验收未改：旧包真实注册失败，新包一次执行成功。两份会使旧业务断言误过的错误 SDK，仍分别被执行身份与 Ref 来源检查拒绝。
- 同一个页面真实更新后，合法持有的原 Context 读 A，新 Context 读 B；显式释放后拒绝。异步授权期间撤销观察，恢复后派发和业务均为 0。直接上传对象、猜名字、类型错误、失效工具及 15 条坏 Worker 请求均拒绝。
- 新组合仍支持原单页 Ref。普通数字 2→3；原 64/80/120 KiB 输入仍成功，140 KiB 拒绝；带 Ref 的大普通附加参数同样保持有界。没有提高原预算。
- 四组实际 SDK/Runtime 包组合、两个实际交叉 Host/Worker 组合完成验证；每组另核对原作者程序。错配在业务前拒绝，健康 App 仍可执行。
- 候选既有契约断言共 773 项通过。五份测试只迁移协议字段/字面值，原件、全部断言与 diff 保留。R4 的公开低层 Registry 仍由受信工厂选择是否验证输入，没有被全局强制改变。
- 严格 Core 与作者包消费通过，286 份声明原件保留，14 份必要变化已审查。公开 Core 导出列表未增加 Ref 准备 helper。

负责人额外在最终实际安装包上验证了两条 **V4 普通 Ref 工具的真实在途路径**：工具进入后超时，结果保持 unknown，晚响应不触发重试；Context 释放后真实 pending request 与 active invocation 保留到 handler 结算。两种情况均只有一次业务进入，后续失效调用拒绝，最终 `close.ok/resourcesReleased=true`。[探针源码](../review-evidence/minimal-core-batch-22/owner-review/v4-lifecycle.mjs) · [超时证据](../review-evidence/minimal-core-batch-22/owner-review/v4-lifecycle/timeout.json) · [释放证据](../review-evidence/minimal-core-batch-22/owner-review/v4-lifecycle/context-release.json)

## 复核发现及修正

早期候选曾隐藏原单页工具、对参数原值和解析值重复计费，以及宽松接纳非字符串版本/未知编译模式。负责人分别用真实安装包、同一业务 App 和基线对照复现，执行者修正后再独立复验。原始失败均保留，没有反转成功断言或删掉现有保证。[首次发现](../review-evidence/minimal-core-batch-22/owner-review/initial/) · [中间独立验证归档](../review-evidence/minimal-core-batch-22/owner-review/intermediate-independent-evidence.tar.gz)

## 未覆盖与剩余边界

完整 Runtime 的 `skipLibCheck=false` 前后均有 130 项 linkedom DOM 声明错误，完整诊断逐字节一致。这项检查失败，没有计入通过或用放宽选项替代。无真实 LLM 理解试验、无全仓/GUI/实网验收，也未完成真实 App 的全部迁移。

本批只验收一个必填对象引用。列表、多选、可选 Ref、重名规则、历史数据寿命、公共 helper 冻结、旧入口退出及最终 Semantic 验收仍各有范围。合法旧 Context 读取原 A，只证明原来源保持；**不代表 SRT-05 的“串行会话采用新观察后自动撤销旧资格”已经实现。** Worker 检查当前合同与传输一致性，原观察授权由 Host/Core 证明。

下一批是 **Batch 23：统一 Agent 看到的引用格式和参数使用说明**。修正真实系统说明中的旧格式、遗漏前缀和“对象一律使用 Ref”的过宽规则；文件路径、普通 JSON 与显式 Ref 各按自己的参数合同处理。生产范围先限定一个既有系统说明文件，不修改 B22 协议或 SDK 作者接口。[Batch 23 的范围、准出和 Codex Prompt](MINIMAL_CORE_BATCH_23_TASK.zh-CN.md)
