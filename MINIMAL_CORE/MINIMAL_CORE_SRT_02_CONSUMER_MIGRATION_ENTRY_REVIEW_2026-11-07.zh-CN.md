# SRT-02 八文件消费者迁移：首次运行入口独立复核

2026-11-07。**APPROVED，限定精确准备包的首次隔离执行。** 准入 `entry-plan.json` 的五条顺序命令：三个指定测试文件、w10 `ref-only`（TS 5.9.3 与实际 Worker／Source）、三个生成类型入口的 TS 5.3.3 编译。此结论不是行为验收，不准入生产删除、共享采用、发布或最终 Semantic 验收。

## 独立核对结果

执行方 [preparation-submission.json](../review-evidence/srt-02-consumer-migration-20261107/preparation-submission.json) SHA-256 为 `31ca9073374b765bc1c19a802bb54e73bedf9f718e53c200c5e79a5ad5bedbe9`，52 件索引全部相符；[报告](../review-evidence/srt-02-consumer-migration-20261107/REPORT.zh-CN.md) 为 `7d31906aae2362b738881cffd6921ee9db1976d1ee239cacf321b51d37f6518b`。[八文件 patch](../review-evidence/srt-02-consumer-migration-20261107/eight-file-migration.patch) 为 `da7c1dc9582e17df114b3849f7808dca47aaf47fa8e687edc1a82607cfe17789`。

负责人自行读取 patch 和实际源码，完成以下检查，未启动项目行为：

- 在自己的全新副本以 `patch --fuzz=0` 重放，418/418 与最终候选相符；仅指定八文件变化，其余 410 件未变，没有新增来源不明的源码文件。
- SDK 90、Runtime 388、冻结 Driver 17 件包文件与原 tar 一致；测试使用的 SDK／Runtime dist 共 448 件一致，package.json 也与包内版本一致。56 个显式依赖链接指向声明位置。
- 验证 499 件包／解释器入口和 4315 件显式依赖文件／链接。未将此描述成整个 pnpm 传递依赖库已封存或普通包安装已验证。
- 在重放后的源码上独立运行第三方 TypeScript parser：八文件与六个静态模板共 14 个语法单元无诊断。独立重新提取旧／新 AST 断言，确认 295→347 个运行断言模板、24→26 个类型负向模板；旧项完整、目标位置唯一，保留、迁移、延后执行均有具体记录。这些数字不是测试通过数。

[独立核对脚本](../review-evidence/srt-02-consumer-migration-20261107/owner-review/verify-entry.py) · [核对结果](../review-evidence/srt-02-consumer-migration-20261107/owner-review/entry-check-02.json) · [最终断言映射](../review-evidence/srt-02-consumer-migration-20261107/assertion-map.json)

负责人第一次静态核对误用了保留的 v2 断言位置索引；最终映射实际引用 v3，断言文本与数量没有问题。旧核对输出保留，修正输入引用后重新核对通过，见 [评审侧修正记录](../review-evidence/srt-02-consumer-migration-20261107/owner-review/reviewer-static-correction-01.json)。执行方第一次模板换行转义失败及原输入也仍保留，未被后续语法结果覆盖。

## 允许验证的行为与明确差异

迁移复用普通 Tool 的声明、Ref 参数解析、Observation 授予、类型 activation 与普通 Worker 调用；没有新增产品抽象或框架状态管理器。原旧 Hook、旧参数编译器和页面实例选择辅助分支已从这八个消费者移走，必要行为仍由现有内核负责。App 只复用原有业务对象／会话状态做业务检查，模型继续传完整 Ref 名；公共文件编辑仍使用普通文件路径。

- **D1**：原仅授予 aa 的 foreign-ref 负向仍要求 0 派发／0 handler；另设两页均获准的唯一 Ref 正向和同名歧义负向。真实 owner／snapshot、类型、Schema 和伪造实例检查保留。
- **D2**：关闭或禁用 A、同类 B 仍存在时，普通共享 Tool 进入 App guard；明确验证 1 派发／1 handler／1 guard／0 业务执行，并验证重开后的旧业务会话不能影响新会话。此行为不同于旧实例 Tool 的派发前拒绝。测试结果仍按原 effects 规则映射，不能将 unknown 擅改成 failed。普通 TS 的 Worker 派发数为 null。
- 最后匹配 View 关闭、整个 Tool 禁用／重绑、App reset、scope／Observation 显式释放的框架拒绝仍需实际证明。R14 的触发条件和 scoped 的整 Tool 禁用条件已公开列出变化。
- 原容量上限及超限一项检查保留；新增 payload 字段计入完整 effectiveArgs，不提高 10000 节点上限。特殊字段名、getter、元数据与 payload.type 区别、重复调用、授权等待、失联及禁止自动重试等断言保留。
- 公共 w10 返回短收据，正文通过最新 View 呈现；原 payload 断言移至测试专用见证。私有协议试件返回受控 payload 的用途已明确。

这些是本次要运行的证明，不是已成立的测试结论。旧观察显式 release 前的既有行为不代表 SRT-05 自动交接已完成，也不永久裁决页面关闭后的 Ref 生命周期。

## 精确运行边界

[entry-plan.json](../review-evidence/srt-02-consumer-migration-20261107/entry-plan.json) 与候选 `scaffold/run-proof.py` 为唯一准入入口，使用全新 `runs/attempt-01`。执行前重新核对签收输入；任何身份漂移立即停止。

父进程和 Worker 均使用明示的新 AOTUI_DATA_DIR，Source 使用非空 instruction。子进程只继承入口列明的必要环境键，再加入本次变量；HOME 不变。每条命令有截止时间，只清理自身创建的进程组；强制清理即失败，不可称正常 shutdown。失败时保存输出、停止后续命令。生成 bundle／源码及指纹、实际计数、清理事实必须保留。

不安装、不重建、不运行 GUI Host／模型／IDE／LSP，不接触用户手测目录。w10 `ref-only` 不读取、生成、编译或执行旧 Core 文档示例，也不执行 IDE 类型和运行段；原检查留在 full 分支。正常 Runtime shutdown 与低层 Host／Worker terminate 分开报告。

## 未覆盖风险与下一交付

本轮尚无实际行为结果；三个测试文件与公共消费者可能揭示合同、类型或测试迁移问题。显式依赖以外的 pnpm 传递包仍属于环境依赖；正常安装、发布、真实模型、完整 w10、SRT-05 及最终 Semantic 不在本裁决内。

旧公开 Core 教程仍调用旧 API，删除旧入口前必须同步迁移。负责人另对冻结的 27 份 SDK／Runtime 当前文档做只读搜索，15 份／37 行命中旧入口或模式；这是待分类的文档影响面，历史说明与当前指导须区分，不能按命中批量删除，也不能将原 35 个生产文件清单当成完整退出清单。[文档残余记录](../review-evidence/srt-02-consumer-migration-20261107/owner-review/documentation-residuals.json)

**下一范围**是上述精确入口的执行与结果复核。准出要求：五条命令真实退出、完整失败历史、逐测试结果与计数、生成输入身份、实际清理证据、源码／包未漂移；任何失败先定位，不降低原断言，不改生产内核。生产删除须另交包含文档及公开入口的完整限定范围。

**Codex Prompt：**

> 根据本入口裁决和 owner-review/entry-signoff.json，执行已封存 run-proof.py 的 attempt-01 五步计划。你独占八文件候选，负责人不改你的生产或测试源码。先核对签收指纹，仅使用本次新状态目录与最小环境；失败保留并停止后续命令。报告真实通过／失败、第一行 handler／派发／guard／业务计数、D1/D2 差异、所有退出和资源释放，不把强制终止当正常关闭。不启动旧 Core 文档示例或 IDE，不改包或生产源码。需要修订时先提交具体失败、限定 patch 和新入口身份，使用新输出目录。结果交回独立复核；不得自行批准、采用共享代码或删除旧生产路径。
