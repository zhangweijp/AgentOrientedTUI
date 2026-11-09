# SRT-02 消费者迁移：r04 公共入口独立复核

2026-11-07。**APPROVED，仅准入 r04 精确四步首次隔离运行。** 沿用 [r03 实际裁决](MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_RUN_R03_REVIEW_2026-11-07.zh-CN.md)中两次 70/70；不重复执行未改变的 Worker 测试。完整迁移仍待公共消费者真实结果。

负责人核对 [单行差量](../review-evidence/srt-02-consumer-migration-r04-20261107/repair-vs-r03.patch)：仅 w10 生成的 adapter-tsconfig 增加消费者的显式 typeRoots。strict、skipLibCheck:false、所有公共导入、352 个运行断言模板与 26 个类型负向及位置完全不变。新增一条链接指向已有完整 `@types/json-schema@7.0.15`，四个包文件与十个解析关键文件逐项核验；没有 shim、安装或依赖 store 修改。负责人读过两版实际 TypeScript 解析源码，待运行验证此配置能否解决原 TS7016。

[38 件提交](../review-evidence/srt-02-consumer-migration-r04-20261107/preparation-submission.json) SHA-256 `82b3943c45789dc321fcb8974a948cad3ba4b3b90559145bc8f426869bc74b9e` 全部核对。独立重放 418/418，相对 r03 其余 417 件不变，495 包文件不变；57 个链接、499 运行输入、4315 个显式依赖项及 14 个语法单元通过静态核验。原 295／24 个模板完整映射。负责人首次静态脚本沿用了 r03 的 v3 断言文件名而停止；已保留该脚本和输出，改为实际 v4 文件后在新路径完成重放。这是复核脚本错误，未执行项目行为，不归因于执行方。

[独立结果](../review-evidence/srt-02-consumer-migration-r04-20261107/owner-review/entry-check-02.json) · [源与依赖差量](../review-evidence/srt-02-consumer-migration-r04-20261107/owner-review/r04-delta-check.json)

只准入 [entry-plan.json](../review-evidence/srt-02-consumer-migration-r04-20261107/entry-plan.json) 四步：公共 ref-only（TS 5.9.3 与真实 SDK／Runtime Worker／Source）→ 同次生成的 Core、SDK、adapter 分别以 TS 5.3.3 编译。输出仅新 `review-evidence/srt-02-consumer-migration-r04-20261107/runs/attempt-01`。与 r03 比较确认剩余四命令不变，仅新路径和删去无用 Worker 环境键；runner 另外增加十个解析输入的执行前校验。

准出须有公共调用结果、短收据与 View 正文、原始 Ref payload、绑定拒绝及公共 Runtime 正常关闭事实，并确认两版严格类型和源／包未漂移。失败或外围强制清理即停并保留，不改历史 attempt。普通安装、完整 w10、GUI Host、模型、SRT-05、最终 Semantic 未覆盖；当前文档及 Core 教程仍需下批迁移。生产删除、共享采用和发布均未批准。

**Codex Prompt：**

> 读取 r04 owner-review/entry-signoff.json，核对输入，使用已封存 run-proof.py 执行新 attempt-01 四步。只写隔离候选和新输出；不安装、改生产包、启动 GUI Host／模型／IDE 或旧 Core 教程。失败即停，交具体失败及新修订范围；通过则交公共调用／关闭事实、两版类型、源和包身份，接受独立终审。保留此前所有失败和限定裁决，不自行批准、采用或删除。
