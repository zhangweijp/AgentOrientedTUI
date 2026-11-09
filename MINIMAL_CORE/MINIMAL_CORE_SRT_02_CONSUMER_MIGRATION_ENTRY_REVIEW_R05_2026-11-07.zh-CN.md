# SRT-02 消费者迁移：r05 公共入口独立复核

2026-11-07。**APPROVED，仅准入精确四步隔离运行；完整类型门禁未豁免。** r04 的 typeRoots 修订仍报 TS7016，原失败与17项输出已核对保留。

负责人用失败的实际配置执行编译器解析跟踪，确认 NodeNext 已成功找到 json-schema 的 JavaScript，因此没有进入 nullish typeRoots 后备分支。新私有诊断只把模块名映射到已有完整 `@types/json-schema@7.0.15/index.d.ts`，TS 5.9.3 严格检查退出0；TS 5.3.3 的 json-schema 错误消失，但出现36条 Driver 传递依赖的 NoInfer／泛型 Uint8Array 错误。

负责人再建立仅导入冻结 Driver 公共 ContextDrivenSource 的 ESM 对照：不加载项目 SDK／Runtime 声明，5.9退出0，5.3仍为完全相同的36条错误。第一份对照少了 ESM 标记，多出一条 TS1479，原件保留；新目录纠正后完成比较。这证明当前冻结 Driver 与依赖组合在5.3下已有类型兼容阻断，不证明所有历史版本均失败，也不改变承诺支持的最低版本。[实际解析、基线与原始日志索引](../review-evidence/srt-02-consumer-migration-r04-20261107/owner-review/run-and-type-diagnostic-review.json)

r05 [单行差量](../review-evidence/srt-02-consumer-migration-r05-20261107/repair-vs-r04.patch)与获验证的精确 paths 相同，未修改声明、降低检查或增加 shim。其余417件源码、495件包载荷不变，352／26个断言及位置不变，57条链接的目标和身份不变，仅一条用途说明随配置更新。沿用 r03 执行方与负责人两次70/70，避免重复测试。

[38件提交](../review-evidence/srt-02-consumer-migration-r05-20261107/preparation-submission.json) SHA `33e3afb6cf34e8fac28ed0c0cb50a6bb2534717418926cb6f5a68206098233b7` 已核对。负责人在新目录重放418/418，核对495包、57链接、499运行输入、4315显式依赖、10解析输入、14语法单元和原295／24个模板的完整映射。[独立结果](../review-evidence/srt-02-consumer-migration-r05-20261107/owner-review/entry-check-01.json) · [差量](../review-evidence/srt-02-consumer-migration-r05-20261107/owner-review/r05-delta-check.json)

准入新 `runs/attempt-01` 的四步：公共 ref-only（5.9类型及真实SDK／Runtime／Source）→ 同次生成 Core、SDK、adapter 各以5.3编译。第四步预计暴露上述兼容问题，仍须真实记录；前三步若通过也不得把整次运行记为成功。runner、四命令和环境仅更换r05路径，先校验再运行，失败即停并保留。

准出要分别提供公共调用、原Ref数据、最新View、短收据、Runtime正常关闭和每个类型入口结果。范围外兼容问题登记后单独给出方案；禁止通过依赖降级、修改最低版本、删除导入或关闭库检查绕过。旧API生产删除、共享采用、安装／发布、GUI、真实模型及最终Semantic均未准入。

**Codex Prompt：**

> 使用r05新 owner-review/entry-signoff.json 执行已封存四步 attempt-01，只写隔离新输出；不修改生产包或依赖，不启动GUI／IDE／模型。失败按规则停止，原件保留。交真实公共链、关闭与各类型结果；已知5.3兼容失败不能伪装通过，登记责任与后续范围后接受独立终审。不要自行采用或删除。
