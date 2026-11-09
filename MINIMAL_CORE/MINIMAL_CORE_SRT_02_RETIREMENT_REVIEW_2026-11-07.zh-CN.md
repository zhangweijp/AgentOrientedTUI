# SRT-02 旧 Snapshot Tool 退出：独立复核与下一批范围

2026-11-07。执行方：SRT Owner；文档执行方：既有文档任务；独立复核：Minimal Core 技术负责人。

**完整准出结论：CHANGES_REQUESTED。本批限定的隔离清理实现与已列行为验证：APPROVED。**

旧 Snapshot Tool 的专属实现已从隔离候选删除，保留的行为归并到现有普通 Tool 参数路径，补丁、教程和真实运行已完成独立复核。公共适配入口的完整严格类型检查仍失败，正常包管理器安装也未通过，因此不能将本次结果当作共享采用、正式 Legacy 下线或发布批准。Source 仍在 Runtime，Runtime／Driver／Host 的包边界尚未选定。

## 1. 本批到底改了什么

以前，普通工具和读取页面 Ref 的工具各有一套声明、注册、校验和传输路径。本批删除旧 `useViewSnapshotTool` 及其参数方言、实例目标选择器、专属编译器和旧 Worker 成功调用分支。App 作者使用现有 `defineViewTypeTool`、`refParam`、`AppTools`／`ToolRef` 声明和绑定工具；`useDataRef`／`useArrayRef` 仍负责发布页面数据。

Ref 是普通工具中的一种明确参数。模型传页面上的完整 Ref 名，Runtime 从调用绑定的 Observation 中解析获准的数据，业务 handler 接收冻结的对象或对象列表。普通文件工具继续使用文件路径，不额外强制套一层 Ref。

| 必须回答的问题 | 本批答案 |
| --- | --- |
| 删除了什么重复职责？ | 8个旧生产文件及其他旧分支；34个生产路径实际改变，新增92行、删除1686行，净减少1594行。 |
| 谁保留必要行为？ | 现有 SDK App 工具绑定、共同参数编译器、Core Observation／Scope、类型工具注册表及现有 V4 Worker 调用路径。没有新包、兼容转发层或状态管理器。 |
| 什么真实测试证明？ | 负责人独立重跑 Core 1072、SDK 170、真实 Worker／双 Producer 70；实际 tar 的双版本类型、精确 Core 教程、4次 Worker／Source 调用与正常关闭，以及容量和释放检查。详见下表。 |
| 作者负担是否减少？ | 普通参数和 Ref 参数采用同一工具声明与绑定方式；不再另学专属 Snapshot Hook、参数方言和实例注册。框架仍维护身份、授权、绑定、参数校验和资源释放；App 继续负责原有业务存在性、状态和权限检查。 |

同类型多个页面共享工具，因此关闭其中一个页面，与关闭最后一个同类型页面的语义不同。前者可能仍进入共享 handler 的业务校验，后者撤销该类型的激活资格。D2 的6个对应场景均为 handler进入1次、业务校验1次、业务写入0次；测试中的 App 失败没有声明 effects，收据仍为 `entered-returned / unknown`。不能将这些结果写成“框架均在派发前拒绝”。

## 2. 精确交付与独立核验

候选：`.tmp/srt-02-retirement-candidate-20261107/source`。基线：已签收的 r05 隔离源码，418份文件逐项核对后复制。当前补丁影响106个路径，包含生产清理、必要测试迁移、维护脚本及当前文档。

- [最终累计补丁](../review-evidence/srt-02-retirement-candidate-20261107/delivery-r02/cumulative.patch)：SHA-256 `7bf92c2e84d8ea0964131482bbfe4d12760069daa617a1ca0357ed950cb68693`。
- [最终源码清单](../review-evidence/srt-02-retirement-candidate-20261107/delivery-r02/source-final.json)：412份，SHA-256 `bd6e3272ce435aa863cd9b808774cf96c1639dc96c73875b4c8a2ad6e0b87eef`。
- [负责人独立补丁重放](../review-evidence/srt-02-retirement-candidate-20261107/owner-review/patch-replay-result.json)：从418份冻结基线应用补丁，再加入1份已核指纹的只读 IDE AST 输入，最终412份全部一致。该 IDE 文件不在补丁中，没有迁移或运行 IDE。
- [当前测试定位核验](../review-evidence/srt-02-retirement-candidate-20261107/owner-review/assertion-ast-r02-audit.json)：59个原测试文件、529个真实旧 case family、567个当前断言目标，实际 AST 位置与调用正文 hash 全部一致。定位相同不自动证明语义相同；负责人另行检查生命周期、预算、错误阶段、旧协议拒绝及 D2 差异。
- [最终逐文件执行覆盖](../review-evidence/srt-02-retirement-candidate-20261107/owner-review/final-test-file-coverage.json)：58个行为测试文件和1个类型试件均有当前通过记录；类型试件在两版编译器下验证。
- [文档最后修订核验](../review-evidence/srt-02-retirement-candidate-20261107/owner-review/docs-attempt04-identity-audit.json)：18个文档／新教程测试路径和82份文档证据指纹一致，增量及累计补丁可反向校验。17份当前文档已迁移；Ref 主教程使用内存 Note，文件编辑教程保留普通路径。

生产改动限于原批准清单，加上编译器实际发现的 Snapshot Store 一行旧 `targets` 分支删除；[该补充的范围与保留职责](../review-evidence/srt-02-retirement-candidate-20261107/owner-review/scope-notes.json)单独保留。两个明确保留项继续承担 View 挂载／卸载和通用调用终态职责。

## 3. 验证结果与实际边界

| 验证 | 执行方结果 | 负责人独立证据 |
| --- | --- | --- |
| Runtime Core | 1072/1072通过 | 独立重新执行1072/1072；正常退出，无强制清理。 |
| SDK | 170/170通过 | 独立重新执行170/170；与 Core 合计91个输入路径在运行前后指纹一致。 |
| 三文件真实 Worker／双 Producer | 70/70通过 | 使用本轮重新构建的 dist 独立执行70/70；430份运行输入核验一致。 |
| 额外9个 Worker 文件 | 73/73通过 | 审查实际源码及原始结果；运行中的 V4 Worker 收到 V2／V3 请求均返回匹配 requestId 的明确错误，handler进入0次。 |
| 边界单元与集成 | 20个文件各有修正后的通过记录 | 首轮193项中2项旧 AppKernel 预期失败；相关12项修正后12/12，Registry另有30/30当前复验。原失败不覆盖，不宣称首轮全部通过。 |
| 完整 Runtime 集成 | 两文件37/37通过 | 审查真实 tar 输入、原始结果和关闭证据；第三方依赖有本地链接，不称为全新正常安装。 |
| SDK 文件、Note Ref、Runtime 教程 | 两版完整严格类型通过，14次文件／Ref调用，另有2次 b2调用 | 三个场景均通过，3份真实 Runtime 关闭报告均为 ok且资源释放；原件独立审阅。 |
| Core 精确公开教程 | 修正后两版编译及执行通过 | 负责人从新 tar 精确提取原文，在TS5.3.3／5.9.3独立编译执行；旧／新冻结 payload、3次handler、旧activation拒绝、状态恢复41及零scope／字节／lease均验证。 |
| SDK 原有公共类型试件 | 两版均通过 | 负责人独立验证正向推导与负向断言；6个退役DSL类型逐一要求不再导出，没有恢复旧类型来伪造兼容。 |
| 公共SDK→Runtime Worker→Source | 原样JS四次调用通过 | 负责人独立重跑：读旧Ref、错误路径由App拒绝、正确路径编辑、读新Ref；正文只出现在最新View，收据不复制正文；正常Runtime关闭，scope／存储owner／Worker池归零。 |
| 容量与释放 | 修正后1／10／100／1000 View通过 | 负责人独立重跑。始终2次工具注册、2个共享工具；1000页全选按256上限拒绝，100页选择成功；重复释放后资源归零。计时包含新的公开Scope调用链，不与历史内部Registry毫秒数作等价比较。 |
| 旧构建产物 | 27份均不在新tar中 | 负责人独立重新打包并核验。 |

原始依据：[独立 Core／SDK](../review-evidence/srt-02-retirement-candidate-20261107/owner-review/unit-independent-result.json)、[独立70项](../review-evidence/srt-02-retirement-candidate-20261107/owner-review/worker-independent-result.json)、[额外Worker复核](../review-evidence/srt-02-retirement-candidate-20261107/owner-review/integration-attempt01-review.json)、[首次公共结果复核](../review-evidence/srt-02-retirement-candidate-20261107/owner-review/public-attempt01-review.json)、[修正后负责人公共复验](../review-evidence/srt-02-retirement-candidate-20261107/owner-review/public-independent-result.json)。

本轮发现并修正了教程 union 缩窄／统计字段错误、旧公共类型试件引用、容量脚本使用过期内部构造器和错误方法名。首次失败、修正和复验分别封存。没有降低 `strict`、`exactOptionalPropertyTypes:true`、`skipLibCheck:false`，也没有把异常强制清理计为通过。

## 4. 为什么完整准出仍未通过

**适配入口的完整严格类型仍失败。** 当前诊断消费者中，TS5.3.3有42条、TS5.9.3有10条错误。负责人仅导入冻结 Driver 的 `ContextDrivenSource`，不导入 Runtime／SDK，得到逐条相同诊断；[独立对照与逐条比较](../review-evidence/srt-02-retirement-candidate-20261107/owner-review/driver-strict-control/comparison.json)证明本批清理未引入这些错误。它们仍然是准出失败，不能用行为通过或搬移 Source 抵消。两条 `json-schema` 解析错误来自当前本地装配；实际正常安装是否相同尚未验证。

**正常包管理器安装尚未完成。** 已在隔离目录实际运行 offline npm install，空缓存下返回 `ERESOLVE / preact@undefined`。这不足以证明版本冲突，也不是安装成功。实际 tar 加本地第三方依赖链接支持上述诊断和运行验证，不能代替正常安装门禁。未使用 force、legacy-peer-deps、声明shim或放宽编译选项绕过。

以下范围也没有被本批结果覆盖：仓库外消费者、已列范围外 IDE／技能文档的后续迁移、真实模型和最终 Semantic 验收。SRT-05“采用新观察后自动撤销旧观察资格”尚未完成；本批不把释放 Context 的测试冒充该保证。MC-HOST-PREVIEW-01仍OPEN，未新增Host诊断运行。D3历史消息迁移已取消，不重新列入计划。

## 5. 下一批具体范围与准出条件

下一批沿既有 SRT-06 收敛公共分发与类型兼容。先完成不依赖包边界选择的安装输入核对和修复方案；Source迁移实施以所有者选择为前提。[给所有者的具体方案](MINIMAL_CORE_RUNTIME_DRIVER_DECISION_2026-11-07.zh-CN.md)已经比较Driver子入口、独立薄适配包与Host内部模块，说明安装成本、公共支持范围和长期维护责任。

下一批必须交付：

1. 固定本批已封存tar和Driver依赖，列出真实正常安装需要的精确输入；区分缓存不足、声明查找问题和真实类型不兼容。
2. 为42／10条诊断提出最小可审查修复选项，注明对编译器支持、依赖版本及现有消费者的影响；不擅自修改第三方声明或支持政策。
3. 选定Source归属后，按明确公共入口迁移真实调用方；App工具写法、Core所有权、调用绑定和关闭合同保持。
4. 正式采用前，真实tar通过正常包管理器安装，Core／SDK／连接入口在两版完整编译选项下验证，并完成相应真实组合调用与关闭。未经批准的支持范围变化不得由测试豁免代替。

可直接交给 Codex 的下一步 Prompt：

> 你负责既有 SRT-06 的限定准备，不能自行验收自己的交付。先读取本复核、Runtime／Driver方案文档、本批 delivery-r02及负责人 public-independent-result、driver-strict-control。其他执行者仍在仓库工作，不覆盖或回退别人的编辑。生产与已封存证据保持不变；可在新的隔离证据目录写安装输入清单、失败归因和修复提案。复用42／10条独立对照，不重复已通过回归。只检查本批精确包及其已知依赖／缓存输入，给出正常包管理器安装所需条件和可复现命令；安装输入不足就明确列出，不能把解包和符号链接称为正常安装。比较最小依赖修复、声明依赖修正及编译器支持方案的影响，不默认批准其中任何一项。Source暂留Runtime原入口，不新建包、不移入Driver或Host、不加shim、不降低strict/exactOptional/skipLibCheck。输出精确文件范围、利弊、准出测试、尚需所有者决定的事项，再交Minimal Core独立复核。共享采用、发布、最终Semantic验收和已取消D3不在本任务范围。

