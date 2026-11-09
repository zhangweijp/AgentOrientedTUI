# SRT-02 消费者迁移：r03 入口独立复核

2026-11-07。**APPROVED，仅准入 r03 精确五步入口的首次隔离运行。** 尚未验收本轮行为，不批准生产删除、共享采用、发布或最终 Semantic。r02 的 42 通过／28 失败和 r01 的执行前撤回保留。

## 修复依据与实际范围

负责人独立检查了 [七文件差量](../review-evidence/srt-02-consumer-migration-r03-20261107/repair-vs-r02.patch)及实际源码。相对 r02 只改原八文件中的七个，w10 原样；冻结 SDK、Runtime、Driver 包没有重建。

- dual 两种 Producer 复用同一份公开 ToolSet 和捕获后的 inputSchema；纯 Core 在创建资源之前检查声明。此前获准的纯声明诊断证明原始 TypeBox 元数据导致拒绝，公开 SDK 捕获后的两份声明可编译，没有依据放宽 Core 校验。
- Ref fixture 只按声明版本重挂 AppTools，View 保持稳定兄弟节点。R11 default／refType、R15 replace 实际检查 View 身份不变、schema 改变、activation 改变。这验证的是合同与绑定同时替换；不声称同一 activation 原地改变合同。R09 正常 payload 更新仍要求 activation 不变。
- R11 在 finally 释放授权等待并等待已开始调用收束，原变更异常继续抛出；不延长超时。R14 只观察实际仍存在的 aa。Worker 错误名称、消息和 code 进入私有事实。
- scoped 用已有 useArrayRef 发布 `Data[]:array_alpha`，额外核对实际 refType 为 Data、payload 为数组；对象参数仍须以 `REF_VALUE_UNSUPPORTED` 在派发前拒绝，不能拿错名字或错类型冒充形状验证。

[r02 失败与诊断准入](MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_RUN01_REVIEW_2026-11-07.zh-CN.md) · [诊断实际结果独立核对](../review-evidence/srt-02-consumer-migration-r02-20261107/owner-review/diagnostic-result-check.json)

## 独立验证与精确身份

[preparation-submission.json](../review-evidence/srt-02-consumer-migration-r03-20261107/preparation-submission.json) SHA-256 为 `4f7d05c634403517f22e7d169188c8ef09414c55834bd301f1ea5c3c90215205`，38 件逐项核验。完整八文件 patch 为 `b1b8a13c44ad2891e147cf9dbe9a298224681a00c64c704fe73641acd1420794`；七文件差量为 `66e2bf3b2f367e26e081a0fbc53a642c7393844391b68ced886068267305c56a`。

负责人在另一全新目录以 `patch --fuzz=0` 独立重放，418/418 源文件与 r03 一致，410 件未改。另核验 495 个包文件、56 条依赖链接、499 个运行输入及 4315 个显式依赖文件／链接；14 个语法单元无诊断。重新从源码提取并核对原 295 个运行断言模板、24 个类型负向的完整映射。相对 r02 的 347／26 个表达式没有删改，新增 5 个运行模板；当前 352／26 是静态数量，不能当成通过测试数。

[独立重放与映射结果](../review-evidence/srt-02-consumer-migration-r03-20261107/owner-review/entry-check-01.json) · [修订范围及断言差量](../review-evidence/srt-02-consumer-migration-r03-20261107/owner-review/r03-delta-check.json)

运行脚本、Vitest 配置、五步计划与预览均逐字或结构比较确认：除 r03 新路径外与已审 r02 相同。Ref／scoped 的 Host config 及 Worker env 继续显式指向新 run 目录；不更换 HOME。没有执行 r03 项目行为来代替入口审批。

## 执行、准出与剩余限制

只准入新候选 `.tmp/srt-02-consumer-migration-r03-20261107` 的 [entry-plan.json](../review-evidence/srt-02-consumer-migration-r03-20261107/entry-plan.json)，输出独占本证据的 `runs/attempt-01`：三个指定 Worker／双 Producer 文件 → w10 ref-only（含 TS 5.9.3）→ 同次生成的 core、sdk、adapter 三个入口分别以 TS 5.3.3 编译。

准出须交五步真实退出、生成输入、派发／handler／guard／业务效果、关闭事实及源码和包未漂移。任一步失败或外围强制清理，停止后续步骤，保留原失败。既有 D1 未授予 Ref 拒绝、D2 App guard 差异、容量边界、调用身份、结果未知、短收据与 View 正文分工均继续验证；新结果不能追溯改写 r02 缺失的两条 R11 清理及八条 plain 初始化清理事实。

未覆盖正常包安装、完整 w10、GUI Host、真实模型、最终 Semantic；低层 Host／Worker 终止不算公共 Runtime graceful shutdown。SRT-05 新观察自动撤销旧资格尚未完成，页面关闭后的永久 Ref 生命周期未在本批裁决。旧 Core 公开教程与 IDE 分支仍不执行，生产删除前须单独同步当前文档，原 35 文件影响面不等于完整退出计划。

**下一交付与 Codex Prompt：**

> 读取 r03 新 owner-review/entry-signoff.json，用已封存 run-proof.py 执行 attempt-01 的精确五步计划。先核对所有输入，只写自己的候选和新输出目录。不得安装、重建生产包、运行 GUI Host／模型／IDE 或旧文档示例。首次失败保留并停止后续命令；任何修订交具体失败、限定补丁、新入口与新输出目录，不能覆盖 attempt。交实际运行、计数、清理及输入身份，接受 Minimal Core 独立复核。不得自行批准、采用共享代码或删除旧生产路径。
