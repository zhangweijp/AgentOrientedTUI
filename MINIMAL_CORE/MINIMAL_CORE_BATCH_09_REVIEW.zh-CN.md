# Minimal Core Batch 09 独立复核

**结论为 APPROVED。** 批准的 Batch 09 patch 的 SHA-256 为 `8cb6cec060457de802277a7e82fba8c419e7bfff2b1d25de09aaf20e73e9374b`。2026-11-05，执行者交付 READY_FOR_REVIEW 后由接任技术负责人签署。执行者负责生产与永久测试，负责人单独保存输入、复现缺陷、运行门禁及重放 patch。发布和最终 Semantic 验收由项目所有者决定。[批准的 patch](MINIMAL_CORE_BATCH_09.patch) · [执行者封版清单](review-evidence/minimal-core-batch-09/final-delivery.json)

## 对批准对象的核查

基线采用开工工作树保存的文件内容。HEAD 为 `8938449925ada2f92e072e1c0492af8f2428d14f`，索引条目指纹为 `c8419cfb69b4fcf282b76cff78071fd09c6bfcf14c42d8b9d12869448f411451`。四次修订的任务书指纹逐段相接，最终为 `72a4440e03e7b31b9ebdbdef3cede1c6877677745b0b69e3b653f5ce7ee7871a`。复核时从原件校验了各次补充授权的文件及其证据，其中 compaction fixture 和 MCP 工厂还核对了授权时留存的副本。[输入与范围](review-evidence/minimal-core-batch-09/owner-review/review-start.json)

有效白名单有 27 个路径。patch 实际修改 25 个，其中生产文件 12 个、测试文件 12 个、Driver README 1 个。两项原有 Driver 测试仅复跑。正向重放得到独立测试使用的文件逐字节内容，反向重放还原全部原件与新增测试原先不存在的状态。生产改动增加 137 行、删除 294 行。两个装配点各去掉一处 MCP 强转。IM 接口删除一个字段，compaction 测试的两个夹具各补一个通知函数。[独立重放与文件清单](review-evidence/minimal-core-batch-09/owner-review/replay-final.json)

## 行为与责任

| 复核点 | 源码与实际结果 |
| --- | --- |
| Driver 与 Source 作者 | 五个 Host Source 都只实现 `getContext`。Driver 删除分读与两处 Source 执行后备，每轮按顺序取 Context，保留同名后者覆盖、执行前 stop/禁用门禁、真实工作完成后逆序释放。Source 作者在一次返回中关联消息、工具与执行器，普通 App 没有新增接线。该批没有开展普通 App 作者体验评测。[Driver](agent-driver-v2/src/core/agent-driver-v2.ts) · [公共类型](agent-driver-v2/src/core/interfaces.ts) |
| MCP 执行身份 | 开工版在 A 后捕获同名 B，两次调用都进入 B。候选依次进入 A、B，替换原 Tool 的 execute 后仍使用原函数和接收者。禁用来源、服务器、工具三种情形均为业务零进入。MCP 工厂的描述、Schema、dynamic 标记、客户端实参、超时和结果在三个对照场景相同。[MCP Source](host/src/mcp/source.ts) · [开工轨迹](review-evidence/minimal-core-batch-09/owner-review/opening-identity-records.json) · [候选轨迹](review-evidence/minimal-core-batch-09/owner-review/identity-results.json) |
| Host topic | 读取 A 时切换到 B，已发出的 A 操作得到 `E_SOURCE_UNAVAILABLE`，服务与通知均为零。新 Context 能压缩 B。执行时先比较捕获的 topicId 与当前 topicId，再解析 summary。这一合同按 ID 判断，未引入世代编号。[Host Source](host/src/adapters/host-driven-source.ts) |
| 捕获失败与 IM 续轮 | 负责人退回的初版中，SystemPrompt 配置读取抛错会中断健康 Source。相同公共 Driver 反例在开工版、初版、修复版中分别捕获健康来源 1、0、1 次。修复只在 SystemPrompt 捕获点记录原错误并返回完整空 Context，下次读取恢复。普通 atomic Source 抛错仍终止并逆序清理。解析到新构建 Driver 的 Host → IM Session → IM Source → Driver 十个场景轨迹与重建开工对照逐字节相同，含 600 ms 安静窗口。[初版反例](review-evidence/minimal-core-batch-09/owner-review/initial-prompt-isolation.log) · [修复复跑](review-evidence/minimal-core-batch-09/owner-review/final-prompt-isolation.log) · [IM 轨迹](review-evidence/minimal-core-batch-09/owner-review/sealed-im-trace.json) |

## 独立执行

- Driver 全量 46 通过、1 项开工时已跳过。指定 Host 12 个文件共 130 通过，两个 Runtime adapter 文件共 42 通过。Driver 全量包含真实安装的 `streamText` 与受控模型，验证模型 SDK 执行业务 0 次、Driver 执行 1 次。[Driver](review-evidence/minimal-core-batch-09/owner-review/final-driver-tests.log) · [Host](review-evidence/minimal-core-batch-09/owner-review/sealed-host-tests.log) · [Runtime](review-evidence/minimal-core-batch-09/owner-review/runtime-adapters.log)
- 开工身份探针重跑 8 项按预期失败、4 项正常保持。候选 12 项通过。MCP 工厂另有 3 项等价对照通过。开工 Host 门禁原有 14 个失败用例和一处测试模块加载失败，涉及过期装配或测试夹具。它们与错投 MCP、跨 topic 执行的有效先红分开计。[开工探针](review-evidence/minimal-core-batch-09/owner-review/opening-identity.log) · [候选探针](review-evidence/minimal-core-batch-09/owner-review/identity.log) · [MCP 工厂](review-evidence/minimal-core-batch-09/owner-review/factory.log) · [开工 Host 日志](review-evidence/minimal-core-batch-09/baseline-host-tests.stderr.log)
- 独立构建 Driver，检查 Driver 生产与测试类型、Host 受影响生产入口与测试，并从语义 TypeScript Program 重新生成 12 份 `.d.ts`。Host 实际解析到隔离副本新建的 Driver。tarball SHA-256 为 `3472bd33818ae452386b728b89169db59a8a1a613dfbf03d0f7a557ad7a8f5d0`，与执行者产物相同。解包后的真实消费者可完成捕获与释放，原子 Source 和 Runtime adapter 类型通过，split-only 精确报 TS2741。[Host 解析](review-evidence/minimal-core-batch-09/owner-review/host-driver-resolution.log) · [包运行](review-evidence/minimal-core-batch-09/owner-review/pack-run.log) · [旧接口负例](review-evidence/minimal-core-batch-09/owner-review/pack-negative.log)
- 工厂旧声明和开工 IM 完整轨迹是用保存输入重建的对照。原开工声明、原始失败日志、后补重建及修复后的独立结果各自保留。此次未运行完整 Host/SDK/Runtime 套件、GUI/Electron、实网模型或实网 MCP。[执行报告](MINIMAL_CORE_BATCH_09_REPORT.zh-CN.md) · [负责人核验记录](review-evidence/minimal-core-batch-09/owner-review/final-verification.json)

## 已知例外与下一批

开工基线已列 37 个缺失的历史路径。此外，前八批开工时仍有指纹的 963 份证据，复核时全部缺失。项目所有者确认由本人清理，并确认按批外变化继续交付。保留原路径和指纹，原件内容目前无法再验。Batch 09 这次批准使用本批的原件、独立重放和新运行结果。D3 历史消息迁移已取消。[历史差异](review-evidence/minimal-core-batch-09/historical-protection-drift.json) · [所有者处置](review-evidence/minimal-core-batch-09/historical-protection-disposition.json)

开工版与封版产物的独立复跑均复现同一订阅异常。业务执行一次后，如一位 MCP 更新订阅者抛错，健康订阅者可能被通知两次，成功结果可能变成订阅错误。所有者明确要求本批保留旧行为、单独处理。Batch 10 只针对这条异常路径，在隔离副本验证工具结果、各订阅者次数以及 Driver 的后续表现。异常结果对外合同由上级确认。下一批任务书已写明范围、准出条件和 Codex Prompt。[封版异常复现](review-evidence/minimal-core-batch-09/owner-review/sealed-mcp-subscriber.log) · [下一批任务书](MINIMAL_CORE_BATCH_10_TASK.zh-CN.md)
