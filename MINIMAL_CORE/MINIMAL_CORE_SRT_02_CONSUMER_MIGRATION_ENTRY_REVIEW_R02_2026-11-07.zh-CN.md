# SRT-02 八文件消费者迁移：r02 入口独立复核

2026-11-07。**APPROVED，限定 r02 精确入口的首次隔离执行。** r01 的准入仍为已撤回状态，不恢复、不复用。此次准入对应新的候选、新的签收与新输出目录；不是行为验收，也不批准生产删除、共享采用、发布或最终 Semantic。

## 修订问题已经核对

负责人逐行审查 [相对 r01 的修订](../review-evidence/srt-02-consumer-migration-r02-20261107/entry-fix-vs-r01.patch)，并从 Host 构造继续追踪到实际目录解析函数：

- `state-storage-host.ts:17–24` 读取 `config.AOTUI_DATA_DIR`，`worker-host.ts:330–331` 传入 Host 的构造 config。r02 的 Ref 与 scoped 两个 Host 都明确提供当前新 run/state；Worker 环境也明确指向新 run 内的 state 或 temp/data-*。不再用 Worker env 推导父侧 Host 存储根。
- scoped 先终止本用例全部 Host／Worker、等待各自资源释放并采集事实，再检查日志。恢复 mocks 放在 finally。原日志断言仍存在，不再因该断言失败跳过前面的资源等待。
- 相对 r01 只有这两个测试文件变化；全部 347 个运行断言表达式与 26 个类型负向表达式不变。运行脚本、配置和五步入口除了 r02 路径，内容不变。r01 原 52 件证据仍逐项一致。

[r01 撤回事实与代码依据](MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_ENTRY_WITHDRAWAL_2026-11-07.zh-CN.md) · [独立修订核对](../review-evidence/srt-02-consumer-migration-r02-20261107/owner-review/r02-delta-check.json)

## 本次独立验证与身份

[r02 preparation-submission.json](../review-evidence/srt-02-consumer-migration-r02-20261107/preparation-submission.json) SHA-256：`bedd81d4057eedf4475a9a7130f7ea3bd815c5047dfe692728aad0557f4472a1`，40 件索引全部核对。[完整八文件 patch](../review-evidence/srt-02-consumer-migration-r02-20261107/eight-file-migration.patch)：`245d0d151542178d1ef4ccdaa62f59b4e6982862a0b509bd4e9f77a0a660ef3f`。[r02 报告](../review-evidence/srt-02-consumer-migration-r02-20261107/REPORT.zh-CN.md)：`b99efad7631cfa2dee5a19541c43abbcb0cf2c5291fda2c4b4b7c64f1afd1767`。

负责人在另一全新目录以 `patch --fuzz=0` 重放，418/418 与 r02 最终源码一致，仍只改原八文件，其余 410 件未变。重新核对 SDK／Runtime／Driver 共 495 包文件、测试 dist、56 个链接、499 个运行输入和 4315 个显式依赖文件／链接。独立 parser 检查 14 个语法单元；从实际重放源码重新提取断言，确认原 295 个运行模板与 24 个类型负向完整映射到新 347／26 个模板。[独立脚本](../review-evidence/srt-02-consumer-migration-r02-20261107/owner-review/verify-entry.py) · [独立结果](../review-evidence/srt-02-consumer-migration-r02-20261107/owner-review/entry-check-01.json)

上述都是静态核对，本批尚无项目行为通过结果。

## 精确准入与准出

只准入 r02 [entry-plan.json](../review-evidence/srt-02-consumer-migration-r02-20261107/entry-plan.json) 的五步顺序执行，候选为 `.tmp/srt-02-consumer-migration-r02-20261107`，输出独占 `review-evidence/srt-02-consumer-migration-r02-20261107/runs/attempt-01`：

1. 三个指定 Worker／双 Producer 测试文件，单 fork、文件串行。
2. w10 `ref-only` 的 TS 5.9.3 公共类型及真实 SDK／Runtime Worker／Source 链。
3. 同次生成的 core、sdk、adapter 三个类型入口分别以 TS 5.3.3 编译，不重复启动 Worker。

执行前再次校验签收输入，使用入口列明的必要环境与新状态路径，HOME 不变。生成输入、日志和资源事实保留；任一步失败或需要外围强制清理，即保留失败、停止后续命令。修订不得覆盖此 attempt。

D1 的授予／歧义拒绝、D2 的 App guard 差异、最后同类 View 的 activation 撤销、原始 payload、容量、调用冲突、结果未知和关闭责任，仍按已审映射验证。短收据与 View 正文分工不变。低层 terminate 不算正常 Runtime shutdown，旧观察显式释放测试不算 SRT-05 自动交接完成。

## 剩余风险与下一条 Prompt

项目行为尚待实际验证；正常安装、全传递依赖封存、完整 w10、真实模型、GUI Host 和最终 Semantic 均未覆盖。旧公开 Core 示例与 IDE 分支本轮不读取／生成／编译／执行，原检查保留；删除旧入口前必须另批同步迁移当前文档，原 35 个生产文件清单不是完整退出范围。页面关闭后的永久 Ref 生命周期仍未裁决。

**下一交付是实际运行及独立结果复核。准出要求**：五步真实退出、所有原始失败、生成文件身份、实际派发／handler／guard／业务计数、关闭后资源事实，以及源码和包未漂移。需要第九个源码、内核或协议修改，先交具体阻断和限定范围。

**Codex Prompt：**

> 使用 r02 新 owner-review/entry-signoff.json，执行已封存 run-proof.py 的 attempt-01 五步计划，旧 r01 签收禁止使用。先核对所有输入身份。只操作自己的候选和新输出目录；不安装、重建、启动 GUI Host／模型／IDE 或旧文档示例，不改生产代码。失败保留并停止后续步骤，任何修订提交具体原因、限定 patch、新入口身份和新输出目录。交回真实结果、计数及清理证据，接受独立复核；不自行批准、共享采用或删除生产路径。
