# Ref＋View 联合交付：Owner 验收与根入口采用

2026-11-08。**APPROVED，ROOT_ENTRY_VERIFIED_OWNER_ACCEPTED。** Clean 的完整联合交付已通过 Owner 集中验收，并按批准差异采用到实际仓库根目录。用户继续使用原 `./run.sh`；Planning 的既有安装仍指向本仓库并启用自动启动。

下列主体保留交付时的工程验收与实际入口验证事实，未执行发布或 Git 合并，也未启动用户 Electron／模型会话或修改私人配置、数据库。2026-11-08 随后收到本轮用户人工工作流签收，见文末补记。

## 交付行为

- 同一 Tool 声明支持对象 Ref、整个对象列表、自然数组元素、多个／可选 Ref 和有序多选；按调用所属 Observation 解析，采用新观察后旧资格失效。顺序、重复选择、完整预算、只读 payload 与释放合同保留，App 继续负责业务检查。
- View 明确声明 `id/type/kind`；正文与元数据分开，最终 Runtime 边界包装与编码一次，Host 解码一次。CR、CRLF、缩进、围栏和字面标签得到已测保真保证。
- SDK 指南、示例、App Builder skill、四个实际 App 和消费者配套；没有因合并恢复旧接口、旧包版本或“不支持 Ref 多选”的过时说明。

## 集中审查与唯一修订

完整增量为134路径（8新增、122修改、4删除），候选921件源码／配置／资产。Owner 从实际起点独立重放；28个生产源码路径均与已批准的 Ref 或 View 父输入一致。重点审查两份冲突文档、skill、公开示例与新增 Ref 测试的必填 View kind 接合，没有发现生产行为阻断。

统一反馈仅 D1：SDK README 的目录层级占位文字被机械改成错误的 View 标签。Clean 在同一交付将其修为 `Application Instruction → Views → ViewType → Available Tools`。最终921件文件只此一件有变化；SDK tar 的83个文件仅 README 改变，68份 dist（含声明与 map）全等，其余四包未变。原行为日志保持，依据相同实现与产物复用；最终 SDK 另经正常离线安装核验，Owner 独立核对451件 Runtime／SDK安装文件与最终 tar 一致，不冒称新 SDK 包重跑了全部行为。

## Owner 独立验证

| 检查 | 结果 |
|---|---|
| 完整性／补丁 | 原2024件及 D1 后2055件交付材料无差异；原累计补丁独立重放921件，D1仅 README 文案改变 |
| 隔离源码构建 | 原 `run.sh` 九模块构建与 GUI bundle通过；五包491件 dist逐字一致，实际 Host解析器与正文消费测试产物相同 |
| Runtime默认 | 2073通过、2项既有SRT-10诊断失败，无跳过 |
| SDK／严格公共类型 | 185/185，TS7 strict公共类型通过 |
| Adapter／真实跨包集成／Host预览 | 46/46、31/31、13/13 |
| 正常包Ref消费者 | 两种Producer各41调用，每种24成功／17指定拒绝；41对完整handler见证与终态一致；类型、纯入口、品牌及owner一致性通过 |
| 正常包View消费者 | 四包正常安装、严格公共示例、8次View＋4次文档调用通过；六组标准XML／实际Host正文逐字符一致 |
| 最终资源 | Ref与View消费者的Scope、Store／Registry持有量和Worker释放符合原断言 |

两种消费者各自使用全新安装目录，无workspace/source链接替代被测包。pnpm内部store链接、测试用JSDOM开发依赖及实际构建Host解析器的边界已单列。执行方的其他App定向结果保留为执行方证据，不与Owner独立测试混算。

## 实际根目录验证

仅采用批准的134项差异，没有整树复制。采用前备份126份原有文件，8项为新增；采用和构建后核对134项after身份及859份范围外文件。随后Owner更新本报告与全局进度索引，未覆盖其他工作。

根目录10个模块依赖按现有锁离线安装，原 `run.sh` 构建前缀的九模块和GUI bundle通过；五包491件产物与批准包一致，17处包解析均指向实际根目录包。实际根Planning构建产物在新隔离数据目录完成原27次调用：12工具均行使，10个对象工具通过Ref选择，模型可见业务ID为0；资源关闭报告为成功且已释放。

Git HEAD 保持 `8938449925ada2f92e072e1c0492af8f2428d14f`，index SHA256保持 `5b1c429529455ae364786f69c7a01a00f1f22984439e935aeb125565f2cc80b2`。未提交、推送、合并或发布。共享根目录现在具备本次工程交付；已经运行的旧Host需要用户结束后重启。

## 最终身份与证据

最终候选目录：`.tmp/srt-02-03-07-combined-clean-20261108`。

| 对象 | SHA256 |
|---|---|
| source-manifest.json | `ccdadce0f5528819844284986837c2baedc92bd949149668f215a7a16a446b9c` |
| changes.patch | `7b2e57984fb94ec79ca32d2d7b6530cb0e4d186e7401326800c2a9581656b516` |
| DELIVERY.json | `4d9596078e7a728f8e1323c95e2e80872790f2385a8627bf523a339c799d82af` |
| Runtime5.0.0-srt02.1 tar | `cacd622356b86ad7d3f83fc891327e8839d80b14ab9e103b01c3d883d7964e5d` |
| SDK0.6.0-srt02.1 tar | `a27872c4b10ff2395e8db6a0d13de45a7f1d737368c76c29b3a7bcdb67f6f998` |

[Clean最终报告](../.tmp/srt-02-03-07-combined-clean-20261108/REPORT.zh-CN.md) · [Owner根入口事实](../review-evidence/srt-02-03-07-combined-owner-review-20261108/root-verification.json) · [实际采用与回退位置](../review-evidence/srt-02-03-07-combined-owner-review-20261108/root-adoption.json) · [独立源码验证](../review-evidence/srt-02-03-07-combined-owner-review-20261108/source-checks.json)。同目录保留两套正常包消费者、原日志、D1安装核对及复跑脚本。

## 保留边界与下一条指令

没有本次联合交付的剩余阻断。Runtime INIT／OPEN异常详情的两项既有失败仍归SRT-10；Driver第三方完整严格类型、原生LSP和既有首次Host预览问题不因此宣称已修复。本次未运行真实Electron／模型人工流程、全量Host／IDE／LSP或RSS评估。

原下一步是从实际根入口完成 Planning 人工体验验收；现已收到用户签收，该指令已完成，不要求重复执行。全面 Legacy 退出的实施状态仍按其自身记录管理。

SRT-09专项、SRT-10／11低优先级治理，以及跨专项的SRT-12至15仍按唯一全局索引管理，不因为本次三项完成而宣称整个清理项目结束或自动扩入新实施范围。

## 2026-11-08 人工签收补记

用户在 Clean 聊天明确确认本轮四点验收标准满足、可以签收。Ref 选择与对象变更后定位、View／工具随打开关闭变化，以及页面体验均获用户确认；测试计划 A/B 已删除，当前无活动或未完成计划。该事实来自用户提供的体验报告，Owner 只核对并归档，没有重跑流程。

原始消息身份、签收内容及负例边界统一记在 [FEEDBACK-TOOLS-01 人工签收](FEEDBACK_TOOLS_01_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md#2026-11-08-用户人工签收)。其中 complete_task 非法 Ref 用例未执行；空列表 open_plan 的 REF_NOT_VISIBLE 描述与报告末尾措辞不一致，未据此新增负例覆盖结论。本轮工作流人工验收已收口，不追加实现或测试；其他专项保持原状态。
