# Clean 完整任务：Ref 与 View 联合整合

2026-11-08。实施负责人 Clean；整体验收和共享根目录采用由 SRT Owner 负责。两项输入均已获 APPROVED_FOR_COMBINED_INTEGRATION，现在直接实施，不等待新方案审批或报告排版。

## 一个交付目标

将已批准的 Ref／ArrayRef 与 View 元数据／正文呈现成果整合成同一套可运行源码、公共包、文档和消费者。用户最终从仓库根目录运行原 `./run.sh`，得到这套完整行为。

## 已批准输入

1. **Ref 完整交付**：`.tmp/srt-02-complete-clean-20261108/candidate`；累计补丁同目录 `changes.patch`，SHA256 `e78d19e336a532ed73b4881ffd6c6941316581a2b143c67be254e9aadb76b1f5`；源码清单 SHA256 `bc2abeba8f8c02b5709c379a9e514a0dd8b1a90f552841a6e53d3290779ea43a`。55 路径。[Owner 验收](SRT-02_COMPLETE_OWNER_REVIEW_2026-11-08.zh-CN.md)。
2. **View 最终修订**：`.tmp/view-pipeline-cr-20261108/candidate`；累计补丁 `review-evidence/view-pipeline-cr-20261108/VIEW_PIPELINE.patch`，SHA256 `b7c7588012da48a2dc0ff8118625a4b68d560a0b9326faaccb6ee809a77982fd`；`final-delivery.json` SHA256 `1180565126694984c5ac3c762e48858827e75f89596f4c2c3acd589ac9a231d6`。92 路径，包含已修复的 CR／CRLF 保真问题。[独立批准事实](../review-evidence/view-pipeline-cr-owner-review-20261108/verification.json)。

两份补丁各有自己的实际基线，不能依赖当前 Git HEAD 或依次盲目套用。保留完整语义增量，按实际差异解决交集；不整树覆盖。沿用 Ref 已批准的匹配版本 Runtime `5.0.0-srt02.1`、SDK `0.6.0-srt02.1`、Adapter `0.2.0-srt02.1`、Driver `0.3.0`，不要被 View 输入的旧版本声明回退。

View 的[最终正式裁决](../MINIMAL_CORE/MINIMAL_CORE_VIEW_PIPELINE_FINAL_REVIEW_2026-11-08.zh-CN.md)已归档，SHA256 `73dcfac584eb0864325f2214c1a22347cfd238f8a0b80ec8027161ca1f4b1fd5`，批准身份与上述输入一致。六组 XML／实际 Host 正文对照使用负责人独立保存的 `review-evidence/view-pipeline-cr-owner-review-20261108/xml-host-facts.json`；执行者的 `xml-host-actual.json` 是命令记录，不能当正文事实。这只是证据指向补充，不增加实施或重复验证要求。

## 实施责任与完成条件

- 从当前实际共享树建立独占隔离副本，包含有效未跟踪源码和必要资产。你负责本次所需的 Runtime、SDK、Adapter、Host、App、测试、包及文档整合；你不是唯一在仓库工作的执行者，保留其他人的修改，不能回滚共享工作。
- 统一公共指南、App Builder skill 和示例：Ref 支持对象、整列表、元素、多个、可选及有序多选；ViewType／kind 明确、正文与元数据分离、唯一包装和 CR 保真；继续使用同一 Tool 声明与绑定。让示例、公开类型、实际包及应用符合这两项成果。
- 在合并后的候选上验证真实交集：两种 Producer 的 Ref 调用、采用后旧资格失效、View 元数据与正文的标准 XML／Host 消费、相关生命周期和释放、正常安装公共包的严格类型与真实 Worker。已有有效测试和复跑入口直接复用，不新增同构验证框架，不对每个修复重复无关矩阵。
- 保持 Planning 现有十个对象工具的 Ref 合同和业务守卫，验证原 27 次调用；完成原 `run.sh` 构建链和 GUI bundle，使最终差异可直接用于根目录采用。应用业务职责不进入 SDK／Runtime。
- 提交一份完整差异、匹配包、简洁报告、可复跑命令和实际结果。说明冲突如何解决、已知失败与未验证边界；无需为每个中间修复另建一套交付材料。Owner 收到完成态后统一验收，必要问题一次汇总反馈。

INIT／OPEN 异常详情两项既有失败保留在 SRT-10；Driver 上游完整严格声明、LSP 和最终人工 Semantic 验收仍按原边界记录。SRT-09、诊断治理、并发、资源额度重设计、额外业务及新兼容层不并入。不能以旧失败为理由抹除新回归，也不把未运行的检查写成通过。

## 交付与采用

当前授权为连续完成整个隔离联合交付，包括常规冲突解决和相关修复。日常实现不逐小片交审；只有实际产品约束冲突、外部阻断或需要额外权限时提前上报。

保留共享根目录当前可运行版本。完整候选通过后由 Owner 按差异采用并验证原运行入口；不操作用户正在使用的 Host、私人状态或模型会话。`deepseek_review.md` 的当前全局状态由 Owner 合并，不用候选中的旧索引覆盖。不得推送、合并 Git、发布或重置共享 main/index。
