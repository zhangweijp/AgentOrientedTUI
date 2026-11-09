# View 全链路完整交付：最终独立验收

2026-11-08。**APPROVED_FOR_COMBINED_INTEGRATION：整项工程验收通过，无剩余 View 阻断。** 原完整复核的唯一问题 R1 已修复。此结论批准下述精确候选进入 Ref＋View 联合整合；不表示新候选已采用到共享运行入口或完成所有者最终 Semantic 验收。[原 CHANGES_REQUESTED 及反例](MINIMAL_CORE_VIEW_PIPELINE_REVIEW_2026-11-08.zh-CN.md)保持原样。

本项按一个完整任务交付：指定 Minimal Core 执行agent 自主完成 SDK、Runtime、Adapter、Host 预览、四个 App、公共文档、消费者和必要测试，负责人集中审查完整差异与运行行为。未按单文件或单测试设中间审批。

## 改动与职责

- **页面类别由作者明确声明。** SDK 的 View 明确要求 `type` 和 `kind`，Runtime 只读取页面根上的元数据，删除从实例 ID、正文后代及旧展示属性推断类别的路径。页面如何展示不再暗中改变工具所属类型或 instruction/state 类别。[View 声明](../.tmp/view-pipeline-cr-20261108/candidate/sdk/src/components/View.tsx) · [Runtime 提取](../.tmp/view-pipeline-cr-20261108/candidate/runtime/src/worker-runtime/view-fragment-extractor.ts)。
- **正文保持正文，框架只包装一次。** 现有 Runtime 呈现边界负责 XML 外壳和一次编码；Host 提取外壳后解码一次。原样内容的缩进、首尾空白、围栏及字面标签得到保留，App 无需修补。[最终消息边界](../.tmp/view-pipeline-cr-20261108/candidate/runtime/src/adapters/view-message.ts) · [Host 消费](../.tmp/view-pipeline-cr-20261108/candidate/host/src/gui/components/TuiParser.ts)。
- **生产修订只有一行。** R1 在上述现有编码函数中补充 CR → `&#13;`，防止标准 XML 解析将 CRLF 或独立 CR 改成 LF。没有新编码层、新依赖或管理器。六个既存路径的修订包含测试、真实消费者夹具和说明；累计仍为92路径。Ref 参数解析、Driver 回合与资源策略不在本项改动内。

必要行为仍由现有 SDK／Runtime／Adapter／Host 各自承担。作者只声明页面类别并提交业务内容，不需要理解 DOM 推断规则、历史包装路径或额外正文预处理，减少了开发 App 时的隐含约定。

## 精确交付

候选：`.tmp/view-pipeline-cr-20261108/candidate`。负责人核对905份源码、364份修订交付材料及原535份材料；实际重放修订增量和累计补丁，最终905份源码全等，原交付未改。

| 对象 | SHA-256 |
| --- | --- |
| 累计 VIEW_PIPELINE.patch | `b7c7588012da48a2dc0ff8118625a4b68d560a0b9326faaccb6ee809a77982fd` |
| R1_INCREMENT.patch | `684e72edd8bdbeca012708f6abf21e2d1b7061db6650ab71535594967b390dce` |
| final-delivery.json | `1180565126694984c5ac3c762e48858827e75f89596f4c2c3acd589ac9a231d6` |
| 候选源码清单 | `96f24065a4f3e884aadb926e9fe32012f50597af90f93cdb5a43f8b1f2e242b0` |

[累计补丁](../review-evidence/view-pipeline-cr-20261108/VIEW_PIPELINE.patch) · [交付清单](../review-evidence/view-pipeline-cr-20261108/final-delivery.json) · [负责人核对事实](../review-evidence/view-pipeline-cr-owner-review-20261108/verification.json)。

## 独立验证

原整体验收已独立完成九模块构建、316项相关回归及正常包消费。R1 只影响消息编码，未变输入的证据继续有效；本轮在新的重放目录和新的正常包消费者中复跑受影响链路，没有把重复运行相加成更多独立用例。

| 本轮负责人实际运行 | 结果 |
| --- | --- |
| 原 CRLF 失败脚本，保持原断言 | CRLF 与 LF 均逐字符恢复，R1 关闭 |
| Runtime 构建、View 相关回归 | 构建通过，48/48 |
| 实际 Host 预览回归 | 13/13 |
| 四包正常 frozen/offline 安装及公共严格类型 | 通过，无源码 alias 替代包 |
| 真实 SDK Worker／普通 TS Core／Source、发布文档示例 | 8＋4次调用通过，保留 Ref、更新采用、旧资格拒绝及关闭释放断言 |
| 标准 XML 与实际构建的 Host 解析器 | 六组正文逐字符一致：LF、CRLF、独立 CR、SDK Worker 初值、普通 TS 初值、SDK 更新；实体与属性同测 |
| 产物与包身份 | 447份 dist 与 tar 一致，483份正常安装文件与 tar 一致；对前版仅 Runtime 包装 JS 与 map 改变，146份声明全等 |

源码构建复用现有第三方依赖，内部包指向负责人自己的重放目录；R1 重建 Runtime，其他无变化产物沿用负责人上一轮独立构建结果。正常包消费者另行安装最终 tar。[构建与回归命令](../review-evidence/view-pipeline-cr-owner-review-20261108/source-commands.json) · [正常消费者命令](../review-evidence/view-pipeline-cr-owner-review-20261108/public-commands.json) · [原反例重跑](../review-evidence/view-pipeline-cr-owner-review-20261108/original-counterexample-rerun.json) · [六组完整对照](../review-evidence/view-pipeline-cr-owner-review-20261108/xml-host-facts.json)。

执行者的 `xml-host-actual.json` 被命令记录覆盖，不能当作六组正文事实使用；负责人已独立重跑并以独立路径保存完整对照，不影响上述结论。

## 未覆盖范围与下一步

本轮没有重新跑不受修订影响的 Runtime 全量、全部 App 或真实模型。原 View 全量记录的既有 Worker 安装失败保留；联合整合以 SRT-02 已迁移 fixture 和 SRT-10 两项 INIT／OPEN 诊断失败记录为准。Driver 第三方严格声明、原生 LSP、真实 Electron／模型体验及最终 Semantic 验收仍按既有边界跟踪。

**下一项为一次完整的 Ref＋View 联合整合，已交 Clean 执行，SRT Owner 统一验收和采用。** 范围、输入身份与准出条件见[联合任务](../SRT/SRT-02_03_07_COMBINED_DELIVERY_CLEAN_TASK_2026-11-08.zh-CN.md)。保留 Ref 已批准的新匹配版本，合并两份成果在源码、文档、示例和消费者上的交集，完成真实调用及原 `run.sh` 构建链后整体交审。不另派 View 生产修改或重复 Ref 复核。

Codex Prompt：

> 以已批准 Ref 完整候选和本报告 View 最终候选为输入，连续完成联合交付。保留双方语义增量与 Ref 已批准版本，自主处理常规冲突；统一公开指南、示例和正常包消费者，验证两种 Producer、真实 Worker、Ref 生命周期、View 元数据及 XML／Host 正文保真、Planning 27次调用和原启动构建链。完成后一次提交完整差异、匹配包、可复跑命令和结果，由 Owner 集中验收并采用。中间修复不逐片审批；不扩入 SRT-09、诊断治理、并发、预算重设计或新兼容层。
