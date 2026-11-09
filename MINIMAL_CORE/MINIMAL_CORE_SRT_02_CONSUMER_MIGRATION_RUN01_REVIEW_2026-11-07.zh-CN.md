# SRT-02 消费者迁移：r02 首次运行独立复核

2026-11-07。**CHANGES_REQUESTED。** r02 attempt-01 首条命令真实退出 1，70 个测试为 42 通过／28 失败，后四条命令未执行。没有批准重跑或生产修改。另准入下述精确无 Worker 诊断入口及 r03 限定准备，r03 的完整执行仍须新入口复核。

## 实际依据

负责人核对 [原始 Vitest 结果](../review-evidence/srt-02-consumer-migration-r02-20261107/runs/attempt-01/facts/vitest.json)、[runner 退出](../review-evidence/srt-02-consumer-migration-r02-20261107/runs/attempt-01/result.json)、22 件输出索引及实际源码。执行后准备包、源码、包和显式依赖身份仍与 `bedd81d4…` 一致。[独立结果核对](../review-evidence/srt-02-consumer-migration-r02-20261107/owner-review/run01-audit.json)

| 测试文件 | 通过／失败 | 当前结论 |
| --- | --- | --- |
| dual Producer | 8／8 | SDK／DOM／Worker 的八项通过，包含 D1/D2；普通 TS 八项在 actor 返回前声明失败，不能算双 Producer 验收 |
| Ref protocol | 34／4 | 三项声明更新／替换等待失败，一项选择已关闭页面导致观测拒绝；两项失败还缺完整清理事实 |
| scoped interaction | 0／16 | 在 managed 初始化阶段失败，尚未证明预定的执行场景 |

已实际保存 37 条 Ref、16 条 scoped、12 条 dual 的资源释放记录。这是记录条数，不是不同 Worker 的数量，健康 RESET 存在复用。R11 default／ref-metadata 没有 cleanup 记录；其失败约 65 秒，另含 afterEach 错误。八个 plain actor 在构造返回前失败，外层 finally 未执行。外围没有超时或强杀且进程组已退出，但不据此宣称这些 authority 的生命周期已完成。公共 Runtime graceful shutdown 尚未运行。

## 修复依据与范围

[执行方归因与修订提案](../review-evidence/srt-02-consumer-migration-r02-20261107/DIAGNOSIS_AND_REPAIR_SCOPE.zh-CN.md) 的状态划分与原件相符，允许在新 r03 副本内准备七文件修订，w10 不动，SDK／Runtime 包和生产源码不动：

1. dual 的 business／app／test 复用同一份公开 Tool 定义及其规范化 inputSchema，声明检查先于创建 Core／authority。原始 TypeBox 元数据与 Core 严格 JSON 合同的具体诊断仍由下述纯声明探针确认，不能放宽内核校验。
2. Ref fixture 按 SDK 已有要求重挂 AppTools owner。稳定 View 放在该 owner 的被替换子树之外，验证 View 身份保持；公开 schema 与 activation 均改变，明确这是合同和绑定一起替换。`view-owned-tools.ts:397–405` 在有匹配 View 的新注册时会生成新 activation，不能要求它不变或把页面重开当成同一证明。普通 payload／revision 更新仍保持原 R09 activation 不变保证。
3. Ref test 的 R14 只观察实际存在的 aa；R11 gate 在 finally 无条件释放，并等待已开始调用收束，保留原失败。记录真实 Worker error 的必要诊断，不用增加超时掩盖问题。
4. scoped fixture 使用现有 useArrayRef 发布真正的 typed whole-array Ref，测试同步完整名称；对象参数 Schema 仍须在派发前拒绝该数组，不能换成因错误名称或 refType 而拒绝。

AppTools 的单 owner 定义固定要求与 typed useDataRef 拒绝数组，均已由负责人读取实际源码确认。scoped 外层错误显示为 managed persistence 失败，不能由此断言存储后端损坏；内部数组错误仍需具体诊断。此轮不改诊断体系或内核语义。

## 无 Worker 诊断入口准入

允许执行 [diagnostics-preparation/submission.json](../review-evidence/srt-02-consumer-migration-r02-20261107/diagnostics-preparation/submission.json)（SHA `05b3f40659194983538ebd32558298b7e9419cad01388ca893a85efa6580af0f`）的精确脚本，10 件引用已核对。

使用 r02 entry-plan 中已核对的 Python 解释器运行 `diagnostics-preparation/run-schema-diagnostic.py`。脚本再次核对冻结输入，30 秒上限，最小环境，独占新 `diagnostics-attempt-01`；Node 只导入已封存 SDK／纯 Core／业务声明，比较 raw 与公开声明捕获后的编译结果，并验证数组在进入 Hook context 前被 typed useDataRef 拒绝。不创建 App、Core 实例、Host、Worker、Source 或模型，不修改候选。失败保留，不自动换命令或重跑。

## 准出、风险与下一条 Prompt

r03 仍须交完整八文件 patch、相对 r02 的七文件差量、断言映射、实际 owner／View／activation 变化、gate 异常清理、输入身份与新运行入口。不得减少旧断言、D1/D2 计数、容量上限、未知结果或清理合同。完整 Worker／公共消费者／两版类型验证尚待新准入后执行；当前 42 项通过不能代替整批通过。

旧公开文档、完整 w10、正常安装、真实模型、SRT-05、页面关闭后的永久 Ref 资格、生产删除及最终 Semantic 仍未完成。原 r01 撤回、r02 失败与缺失清理事实全部保留，不覆盖。

**Codex Prompt：**

> 先运行已签的无 Worker 声明诊断，交回真实 issue 和结果。在新 r03 副本只准备上述七文件修订，w10 与所有生产源码／包冻结。AppTools owner 重挂保持 View 身份，真实验证并披露 activation 改变；ArrayRef 负向仍证明正确类型下的对象形状拒绝。异常时 finally 释放测试 gate 并收束调用，不增加超时，不把进程退出当完整生命周期。提交精确新 patch、映射、输入与入口后等待独立运行准入，不自行重跑 r02 或采用共享代码。
