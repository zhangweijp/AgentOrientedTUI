# SRT-02 首次基线：验收阶段纠正

2026-11-07。**CHANGES_REQUESTED，针对声明探针与四包组合的拒绝阶段预期。** 原静态重建和文件身份核对保持有效；不能按原错误预期继续 Worker 或整列表实现。

获准的 declaration 入口执行一次，Node exit 1，外层包装也返回失败。六个 defineViewTypeTool 调用全部成功捕获声明，其中五个被脚本错误地预期为拒绝。原输入、JSON、stdout/stderr 和 process 记录已保存在 [baseline-runs](../review-evidence/srt-02-list-ref-baseline-20261107/baseline-runs/commands.json)，负责人逐字核对其与实际消费者产物相同。Worker 未启动、生产未改的执行者回执已收到，审查时对应 Worker 产物仍不存在。[独立事实记录](../review-evidence/srt-02-list-ref-baseline-20261107/owner-review/baseline-expectation-review-01.json)

具体原因已由真实结果和源码共同确定：SDK `captureOrdinarySchema` 使用 `ref-value-specimen`，支持描述比当前正式执行合同更广的形状。SDK `createToolBindings.commit` 调用实际 appTypeTools port，Core `registerTypeTool` 才以 `view-type-parameters-v1` 校验。该正式合同仍限制一个必填对象 Ref。SDK 会把注册根因包成 `TOOL_BINDING_COMMIT_FAILED`，原始 `PARAMETER_DECLARATION_UNSUPPORTED` 位于诊断的 original.code；不能把不同边界的错误码混为一个。

这不是包漂移，不证明整列表已经能执行，也不是已有产品能力的新回归。它是消费者断言错误，且暴露了 Minimal Core 前置复核的遗漏：[首次入口裁决](MINIMAL_CORE_SRT_02_LIST_ENTRY_REVIEW_2026-11-07.zh-CN.md)中“公开声明阶段拒绝”的预期不成立，本记录明确纠正；历史裁决和原始失败不改写。

下一步只修验收入口和预期，不改生产代码：

1. 保留原 consumer 与 submission，在新 attempt-02 中分别记录 SDK 声明捕获、正式 profile 编译、实际 Core 注册。
2. 可复用公开 createViewOwnedTools 与 createToolBindings，让真实 SDK commit 转发至真实 Core 注册函数，转接只传递参数，不模拟校验。逐形状核对实际顶层错误／根因、注册计数、业务进入 0 和 dispose。
3. 纯 profile 编译、Core 注册和完整 Worker 是不同层证据。修订不得仅把五个 expected 改为 true，就宣称负向验证通过。
4. 四包组合的原预期保留，追加修订为正式 profile／注册阶段的业务前拒绝；新 Runtime 的能力仍由真实 Worker 矩阵验证。冻结新脚本与准确命令后先交入口复核，再运行。

给 SRT Owner 的当前 Prompt：在新副本准备上述分层基线，保存原失败与新旧差异，交 revised entry READY_FOR_REVIEW；未获新版准入前不运行第二次探针、原 Worker 或整列表实现。原功能范围不扩大，Host 预览诊断仍 NOT_ADMITTED。无需项目所有者为本次测试纠错重复确认产品方向。
