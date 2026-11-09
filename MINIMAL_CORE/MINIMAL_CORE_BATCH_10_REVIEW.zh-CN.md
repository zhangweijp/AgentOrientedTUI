# Minimal Core Batch 10 独立技术复核

**隔离候选 Revision 01 的技术结论为 APPROVED。** 签署对象是从 Batch 09 批准字节生成的累计 patch，SHA-256 为 `bcfbd6b4030be5423ce2c568c3eb1b34438bce102c17d9805a936bf84c9ee722`。初版 `3b8396b9` 的结论仍为 CHANGES_REQUESTED。签署时共享生产采用 Batch 09，实现新对外行为需要项目所有者确认。签署身份、命令、日志和工作树校验可追溯。[累计 patch](review-evidence/minimal-core-batch-10/revision-01/MINIMAL_CORE_BATCH_10_CANDIDATE_REVISION_01.patch) · [首轮退回](review-evidence/minimal-core-batch-10/owner-review/REVIEW-01.zh-CN.md) · [独立核验记录](review-evidence/minimal-core-batch-10/owner-review/revision-01/final-verification.json)

## 实现与独立证据

MCP Source 仍负责工具结果映射。这个 patch 把成功和失败两个分支原有的完成通知合到同一个 `finally` 中。每个同步订阅回调单独处理抛错，复用现有日志和订阅列表。禁用门禁在业务进入前返回。控制开关继续调用原有的 `triggerUpdate()`。生产改动集中于这一处，App 作者无需接入新概念。[候选源码](review-evidence/minimal-core-batch-10/revision-01/candidate/host/src/mcp/source.ts)

| 独立核查 | 实际结果 |
| --- | --- |
| 上次退回的传输反例 | 同一份真实 MCP Client、Server、内存 transport 与 MCP 工厂输入在三版各尝试发送一次。传输以 `null` 拒绝时，健康订阅者收到通知的次数依次为 1、0、1。三版均保留原 TypeError。这个探针观察到 Source 的返回边界。 |
| 工具结果与 Driver | 原来成功结果曾被订阅异常覆盖，某些失败还会中断通知，使下一轮模型请求缺席。候选在六个受控模型场景中各执行业务一次，各进行两次模型请求，第二次读取真实收据；600 ms 安静窗口内没有第三轮。Source、server、tool 禁用时，业务与完成通知均为零。 |
| 收据序列化失败的额外差异 | 我用真实 MCP 工厂和内存 Client/Server 返回一个合法 JSON 对象，其中包含 12,000 层嵌套数组。工具调用一次，收据序列化得到相同的 RangeError 错误文本。即使订阅者都正常，Batch 09 也会在成功分支和错误分支各通知一次。现在只通知一次。这属于“每次工具完成只通知一次”的可见效果，随候选一并交所有者裁决。 |
| 测试、类型及保护 | 在新临时目录从批准字节独立重放累计 patch 和“初版＋增量”两条链，正反方向均核对每一步的两文件内容。修复版的 36 个永久用例、2 个独立探针、4 个相邻 Host 测试文件中的 8 个用例通过。严格 TypeScript 检查通过，重新生成的 MCP Source 公开声明与 Batch 09 逐字节一致。 |

两版十条送审轨迹与我重跑得到的字节一致。修复版、开工版和初版的完整日志均保留。这里的 MCP 使用安装包和受控传输，模型使用已安装的 streamText 与受控 provider。此次没有运行完整 Host/Driver/Runtime/SDK、外部 MCP 服务、在线模型或 Electron。异步订阅回调以及在通知过程中增删订阅的合同超出这次复核范围。[开工版](review-evidence/minimal-core-batch-10/owner-review/revision-01/approved-gates.log) · [初版](review-evidence/minimal-core-batch-10/owner-review/revision-01/initial-gates.log) · [修复版](review-evidence/minimal-core-batch-10/owner-review/revision-01/repaired-gates.log) · [相邻 Host 回归](review-evidence/minimal-core-batch-10/owner-review/revision-01/neighboring-host.log)

## 待裁决与后续工作

建议采用候选规则。工具结果反映工具本身的结果。一次工具完成对每个已登记回调最多尝试通知一次，抛错写日志，继续通知后续订阅者和 Driver。控制开关沿用原规则。若选择落地，应用前须重验两个共享原件等于批准基线，并在落地后从共享源码运行对应门禁。

下一批可独立推进 Runtime R4 的参数校验盘点。先在只读基线上查明相同参数经过哪些验证、各自跨越什么信任边界，再决定是否确有可删的重复。具体范围、准出与可直接下发的 Prompt 见[Batch 11 任务书](MINIMAL_CORE_BATCH_11_TASK.zh-CN.md)。
