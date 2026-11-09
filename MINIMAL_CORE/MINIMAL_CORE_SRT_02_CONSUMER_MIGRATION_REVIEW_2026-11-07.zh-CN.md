# SRT-02 消费者迁移：独立技术裁决

2026-11-07。**隔离消费者迁移行为 APPROVED；完整退出准出 CHANGES_REQUESTED。** 八文件迁移已有可审查补丁和真实运行证据。当前阻断是 TS 5.3 adapter 的既有依赖类型兼容问题，不能把全部类型门禁写成通过；旧生产路径、共享采用、发布和最终 Semantic 均未批准。

## 改动解决了什么

八个测试／fixture 消费者改用普通 ViewType Tool 的显式 Ref 参数合同，替代原专属 Snapshot Tool 接入。工具声明、注册和验证复用现有 SDK／Core；纯 TypeScript 与 SDK Worker 使用同一份公开捕获声明。数组使用既有 ArrayRef，没有新加另一套工具类别、状态管理器或兼容层。文件编辑仍用普通路径和内容参数；快照数据读取试件的 Ref 用于选择已呈现的数据。

必要行为继续由原模块承担：SDK 发布具名数据与工具声明；Core／Runtime 核对观察来源、类型、参数、绑定和授权，解析后交给 handler；App 检查自己的业务对象是否仍可操作。Tool 返回短收据，业务正文通过 View 呈现。消费者入口修订只补隔离依赖解析，没有修改冻结生产包或第三方声明。

最终候选：`.tmp/srt-02-consumer-migration-r05-20261107`。相对原签收列表基线仍只改八文件、其余410件不变；相对已通过Worker测试的r03，只有w10类型配置改变，其余417件不变。[完整补丁](../review-evidence/srt-02-consumer-migration-r05-20261107/eight-file-migration.patch) · [逐断言映射](../review-evidence/srt-02-consumer-migration-r05-20261107/assertion-map.json)

## 独立验证结果

| 检查 | 执行方结果 | 负责人独立工作 |
| --- | --- | --- |
| 三个Worker／双Producer文件 | 70/70 | 新目录实际重跑70/70，核对身份、拒绝与清理事实 |
| 公共SDK→Runtime Worker→Source | 4次调用均符合预期 | 新目录实际重跑，4次调用与原始JSONL一致 |
| TS 5.9.3 Core／SDK／adapter | 三入口严格检查通过 | 公共消费者重跑时三入口再次通过 |
| TS 5.3.3 Core／SDK | 两入口严格检查通过 | 核对同次生成输入、命令和退出记录；未冒称另重跑这两项 |
| TS 5.3.3 adapter | 36条依赖声明错误 | 精确配置独立诊断，并用仅导入冻结Driver的对照复现相同36条 |

公共链每次实际有4次handler进入：两次Ref读取、一次被App guard拒绝的编辑、一次成功业务写入。拒绝前后状态不变；两个Ref payload分别为编辑前后数据，均冻结。新Context的View包含新正文、排除旧正文，Tool Result不重复正文。Runtime实际调用 `beginShutdown().completion`：ok／resourcesReleased为true，managed／completed为1、failed为0，scope／bytes／Worker池／存储owner／pending等结清，持久化flush确认。此处是正常Runtime关闭；此前低层Worker终止证据仍按原限定解释。

[公共链原始交付](../review-evidence/srt-02-consumer-migration-r05-20261107/DELIVERY.zh-CN.md) · [负责人实际公共重跑](../review-evidence/srt-02-consumer-migration-r05-20261107/owner-review/runs/public-01/result.json) · [两次公共链独立审计](../review-evidence/srt-02-consumer-migration-r05-20261107/owner-review/public-run-audit.json) · [独立70项重跑](../review-evidence/srt-02-consumer-migration-r03-20261107/owner-review/worker-rerun-audit.json)

负责人核对r05的38件准备提交、10件交付引用、418件源码独立重放、495件包载荷、57条链接、499个运行输入、4315个显式依赖和10个解析输入；执行方32项输出、负责人19项公共输出索引吻合。原295个运行断言模板／24个类型负向完整映射至352／26；静态模板数不等于通过测试数。ref-only实际编译Core15、SDK8、adapter2个负向，另1个IDE负向保留于未运行分支。

## 阻断和未覆盖风险

1. **兼容门禁未过。** r05四命令实际为0／0／0／2，runner保持FAILED。完整声明路径已解决json-schema缺失；剩余36错来自冻结Driver的ai／provider-utils／zod。仅导入Driver、没有加载项目SDK／Runtime声明的ESM对照仍产生完全相同错误，故不能归为本批Ref解析回归，也不能据此豁免门禁。当前未改变最低TypeScript版本，未降依赖或加shim。[基线与诊断索引](../review-evidence/srt-02-consumer-migration-r04-20261107/owner-review/run-and-type-diagnostic-review.json)
2. **新旧调用边界有已记录差异。** 同类型Tool仍活跃时，关闭单个业务对象的旧Ref可能进入App guard后被拒绝；原实例路径可能在框架派发前拒绝。两种Producer的实际差量和零业务效果已经验证，不能冒称完全相同行为。本批不永久裁决关闭后的Ref资格；SRT-05新观察自动撤销旧资格仍未完成。
3. **生产退出未完成。** 旧API和当前文档还在；15份文档／37行已知命中包含当前指南、可执行教程及混合历史文字，须逐项处理，不能机械删除历史事实。原35件生产影响面不是完整退出范围。
4. **验证范围有限。** 使用冻结包解压与明确依赖链接，没有验证普通包管理器安装、完整w10、IDE／LSP、GUI Host、真实模型或最终Semantic。公开文件编辑案例使用应用内合成状态，不代表真实磁盘编辑验收。

r01执行前撤回、r02失败、r03／r04类型失败、负责人诊断试件纠正及全部原件都保留。新通过结果不追溯改写缺失的旧清理事实。[r03裁决](MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_RUN_R03_REVIEW_2026-11-07.zh-CN.md) · [r05准入与诊断边界](MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_ENTRY_REVIEW_R05_2026-11-07.zh-CN.md)

## 下一批范围、准出与Codex Prompt

下一批由SRT Owner独占准备，Minimal Core独立复核，**当前只准只读范围收敛与文档任务登记，不批准生产修改或额外行为探针**：

- 在现有SRT-06登记公共类型依赖问题，核对最低TS承诺来自何处，区分Core、SDK、adapter／Driver的真实支持矩阵。交可选解决范围、影响与准出方案；涉及支持版本、公共类型边界或依赖策略的选择另交负责人／所有者决定。
- 从已验收的新路径逐项核对旧入口剩余职责与消费者，更新精确退出清单。纳入公共导出、协议能力、源码、保留测试、当前文档和可执行Core教程；每个候选删除项说明保留行为由谁承担，保留对应真实验证。

**准出要求：** 源与证据身份可核对；没有把历史签收当实时事实；当前指南与历史说明分别处理；未解决的语义差异明确列出；退出实施Prompt包含文件所有权、准确基线、测试矩阵和停止条件。未确认发布条件不进入删除阶段。

**Codex Prompt：**

> 以r05隔离消费者交付和本裁决为固定输入，继续只读收敛旧Snapshot Tool退出范围；复用已签收行为证据，不重跑未变测试。逐文件列明删除／收拢职责、唯一保留模块、真实消费者、测试、文档及可执行教程义务。同时在现有SRT-06登记TS5.3 adapter兼容阻断，引用冻结Driver独立对照，查清支持版本承诺并给出最小解决选项。只写本批范围文档、证据和既有任务状态；不改生产源码、依赖、最低版本，不执行新探针，不操作私有手测状态。提交具体范围、准出条件和实施Prompt，由Minimal Core独立复核；公开语义／API／发布选择保持上级决策边界。
