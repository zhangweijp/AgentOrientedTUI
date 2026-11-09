# Minimal Core 与 SRT 执行边界记录

2026-11-06。双方负责人依据所有者要求协调重叠任务。本记录说明已有事实、当前执行责任与跨边界复核安排，不扩大协议采用、共享集成、发布或最终 Semantic 验收授权。SRT 专题编号的最终索引由 SRT Owner 核对维护。

## 已有授权与实际位置

Minimal Core Owner 负责日常组织、已授权清理和修复、执行 Codex 管理、独立技术复核与风险升级；上级/项目所有者保留重大架构、产品语义、重大公开 API、发布与最终 Semantic 验收。Batch 22 按所有者“继续推进”完成隔离实现，负责人独立裁决 APPROVED，仅签收限定样机。Batch 23 按所有者新确认修正 Agent 使用说明，独立批准后只落地该说明文件。

共享项目：`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI`。Minimal Core 当前任务、报告、签收与 patch 在 `MINIMAL_CORE/`，证据在根 `review-evidence/`。执行 Codex 为 local/01a19fd2-78ed-7a91-b34e-c2c0e00976aa；技术负责人为本 chat。生产候选先在各自临时副本，正式证据另封存回项目。

| 成果 | 共享状态与签收范围 |
| --- | --- |
| Batch 01–08 | 前期 Core/Driver 等清理有历史批准记录；所有者曾删除 963 份原始证据。保留该已知历史限制，不把快照当实时回归。 |
| Batch 09 | 五个 Host Source 的 getContext、Driver split/fallback 退出、MCP executor 与 topic 身份修正已在共享树；后续按实际文件指纹核对。 |
| Batch 10 | MCP 通知异常修复两个文件已按所有者批准落地，46 项复验通过。 |
| Batch 11 | R4 独立责任审计，不能删除的检查已明确；不全局改变公开低层 Registry 的受信工厂职责。 |
| Batch 12–21 | 有界类型/业务候选、原来源/生命周期/包消费及验收证据；各批按自身签收范围，未据此将候选批量应用共享树。 |
| Batch 22 | 22 文件隔离生产 patch，普通 ViewType 工具消费一个必填对象 Ref，技术签收 APPROVED；共享树未采用该协议。 |
| Batch 23 | Agent 参数使用说明修正，当前已授权下发；只允许 system-instruction.ts 的受审修改，不带入 B22 协议。 |

## 一份实现，各自承担明确责任

- Minimal Core 继续负责 B22/B23 执行链的交付与独立质量复核。重叠的普通 Tool/Ref 接线直接继承 B22，不另启动一套 SRT-02 实现。后续列表、多选、可选 Ref、公开 helper 与 App 迁移需要明确范围。
- SRT Owner 负责 SRT-01 收口、已签收 SDK 作者合同、公开输入合规评测状态、SRT 索引及总体证据。其文档工作位于 `.tmp/worktrees/srt-01-owner-verdict-20261106`，Minimal Core 不并发修改该工作树。
- 跨 SDK/Runtime 的声明、类型、绑定、协议与生命周期变化，由实现执行者之外的人复核；另一 Owner 检查其负责的既有合同与上游证据。对方核对指纹不冒称重新执行完整测试；技术签收不代替产品所有者的采用决定。
- 近期 Minimal Core 生产写入仅限 Batch 23 的 `runtime/src/adapters/system-instruction.ts`，先隔离后独立批准。负责人本轮新增本目录记录，不修改 SRT 工作树索引或冻结历史报告。

## 继承与尚未完成的部分

继承 SRT M4.3 精确 Git `853495dd9954eb4f8a91998bcc59e19326765981` 及其已有作者合同；SRT Owner 的文档裁决为 `51e0b900b19caca962583129a8824933354fe385`。B22 在该基线叠加 B14 R1、B15 R1、B16，并单独验证自己的 22 文件改动；没有把自己的实验结果回写成原 M4.3 能力。候选包内版本字符串可能相同，身份以完整 tar SHA 为准，见 [B22 独立签收](MINIMAL_CORE_BATCH_22_REVIEW.zh-CN.md)。

B22 的“合法旧 Context 读 A、新 Context 读 B、显式 release 后拒绝”只证明原观察来源，不等同于 SRT-05 所要求的串行会话成功采用新观察后自动撤销旧资格。B18/B19 的取证也不能代替该策略实施。SRT-06 与已落地 Driver/Source 边界需按现存真实证据逐项映射，不重复实现，也不整项冒签完成。

SRT 作者程序运行为 9/9，公开输入合规为 6/9，门槛 8/9；追加三个固定替换样本仍由 SRT Owner 等待所有者授权，无新增模型调用。Minimal Core 不替代或重复该评测。

所有者最新明确：文件工具直接接收路径，不额外强制包装 AOTUI Ref；Ref 仅用于明确要求该参数语义的地方。当前说明修正不改变文件权限、版本冲突或业务规则的归属。最终 Semantic 验收与全面 Legacy 退出仍由项目所有者完成；D3 历史迁移已取消，不重新列入任何一条线。
