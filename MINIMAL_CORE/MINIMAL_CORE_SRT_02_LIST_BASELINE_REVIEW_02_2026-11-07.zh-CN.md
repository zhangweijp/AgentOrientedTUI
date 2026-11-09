# SRT-02 修订基线 02 独立结果复核

2026-11-07。**APPROVED，仅签收修订后的基线结果。** 这证明已固定的基线、分层拒绝阶段和单对象 Worker 回归符合预期；整列表新实现仍未验收。

SRT Owner 按 [修订入口准入](MINIMAL_CORE_SRT_02_LIST_ENTRY_REVIEW_02_2026-11-07.zh-CN.md)首次顺序执行 declaration、worker，Node 与包装器均 exit 0。Minimal Core 负责人核对了 [14 件原始运行产物清单](../review-evidence/srt-02-list-ref-baseline-20261107/attempt-02/runs/manifest.json)、实际消费者产物和已签入口指纹，没有把执行者摘要直接当成验证结果。[独立核对脚本](../review-evidence/srt-02-list-ref-baseline-20261107/owner-review/verify-baseline-results-02.py) · [结果](../review-evidence/srt-02-list-ref-baseline-20261107/owner-review/baseline-results-check-02.json)

| 层次 | 实际结果与核对范围 |
| --- | --- |
| SDK 声明捕获 | 六种形状均接受，符合描述层能力；不推导执行支持 |
| 正式 profile／真实 Core 注册 | 单对象成功，整对象列表、数值列表、optional、多 Ref、Ref 名数组五项拒绝。实际 SDK commit 顶层错误和 original.code 与修订预期一致；每项注册调用一次、清理后绑定及 Core retainedBytes 为零 |
| 真实 Worker | 六次 Context 工具调用，两次正确对象调用各派发并进入业务一次；错类型、仅伪装类型前缀、空 Ref、不可见 Ref 四项均在派发前拒绝，业务进入零 |
| 输入与来源 | 成功调用的 rawArgs、有效参数、普通 title、Ref 类型、完整名字及原 snapshot 来源一致；handler 数据与实际业务记录相符，记录的深层 frozen 检查通过 |
| 释放与关闭 | Context/Source 清理后临时观察指标及 activeLeases 为零；随后 Runtime 真实回执 settled、ok/resourcesReleased=true、pending/failure/unverified 为零，池 total=0 |

关闭前 Store 仍有一份当前快照；上述临时持有归零不等于那个时点整个 Store 已空，更不承诺 JavaScript GC 或 RSS 变化。最终关闭按 Runtime 管理范围的回执计证。

本轮独立审查采用原始源码、指纹和执行记录核对，负责人没有再运行一次这些项目模块，不将执行者的六次调用改写为负责人独立重跑。两条基线均不启动 Host、GUI 或模型。

首次声明探针的 Node exit 1 和五个错误拒绝预期完整保留。该次 CHANGES_REQUESTED 的当前问题已由新副本、新准入和真实分层结果解决；不改写首次失败为通过，不否认前置审查遗漏。

## 下一批具体实施

SRT Owner 已按既定授权进入 `.tmp/srt-02-list-ref-candidate-20261107`，拥有本批隔离实现；Minimal Core 独立终审。基线目录和历史包冻结，不覆盖共享生产，也不与其他执行者同时修改同一文件。

实施目标仍为一个必填顶层 Array<Object> Ref，优先仅改 Runtime 正式参数合同及原观察参数准备两处；SDK 支持说明与相关测试同步。复用已有 useArrayRef、refParam、来源／授权／Worker 链，不增加 Tool 种类或新的管理器。App 继续承担业务前置校验，文件仍直接使用路径。

准出沿 [G-A 至 G-G](../SRT-02_REMAINING_SCOPE_AND_ACCEPTANCE.zh-CN.md)和 [四组合修订预期](../review-evidence/srt-02-list-ref-baseline-20261107/attempt-02/expected-combinations-revision-02.json)：严格类型和运行时不可变；双 Producer；列表／元素错形状、空列表和上下限；原观察来源与授权撤销；真实 mutating Tool 恰好进入一次并更新 View；整体预算及资源结清；实际 tar 消费和新旧组合。纯 Core 注册不能替代完整 Worker 负向验证。

当前 Codex Prompt：在新候选目录完成上述最小实现，保留有效基线与所有失败，提交相对固定源码的独立 patch、精确包、原始命令／日志、行为与资源证据，状态 READY_FOR_REVIEW。不得扩大多个／可选 Ref、Ref 名数组、属性路径、Observation 采用、Host 或 Planning 业务范围；需要额外生产模块／wire／capability／公开签名变化时，先给具体失败和范围修订。实现者不自行批准代码，由 Minimal Core 独立审查 patch、实际源码和必要重跑后裁决。

未覆盖的新工作包括整列表真实消费、完整混合包矩阵、容量和不可变性边界，以及新代码对生命周期的影响。共享采用、发布、旧入口退出和最终 Semantic 验收尚未完成。Host 预览缺陷继续 OPEN，第三轮 Host 运行仍 NOT_ADMITTED。
