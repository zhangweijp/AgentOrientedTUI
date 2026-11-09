# SRT-02 单个整列表 Ref：范围独立复核

2026-11-07。**APPROVED，仅签收静态范围与验收任务包。** 一个必填整列表 Ref 尚未实现；本裁决不批准共享采用、发布、旧入口删除或最终 Semantic 验收。

复核对象为 SRT Owner 提交的 [剩余范围与任务包](../SRT-02_REMAINING_SCOPE_AND_ACCEPTANCE.zh-CN.md)，SHA-256 `0820b462e9600ce8ae2e4d13e17faea30118025ea07701ade15b44ea2ede2556`；[submission-01.json](../review-evidence/srt-02-scope-20261106/submission-01.json) 为 `33f194dd54ebb1f589f457b9a2fc9476ff83cf7ec92036e61535af37b86cbfce`。原提交保留，不用后续状态改写原件。

## 独立依据

Minimal Core 负责人逐项核对了提交清单的 8 件证据；从精确 tar 读取并比对实际解包内容，共 SDK 90、Runtime 388、Planning 46 件文件，合计 **524 件**。B24 的 **600 件源码／配置、31 件消费者输入**与当前对应文件一致。这只说明清单内文件未漂移，不表示共享树干净或可直接覆盖。

另核对 **12 条源码位置及原文、9 件重建输入和 Git tree**，以及旧入口清单的 **255 条文本、64 个文件**。文本存在性核对不能替代动态依赖审查，更不是删除文件许可。[独立核对脚本](../review-evidence/srt-02-scope-20261106/owner-review/verify-scope.py) · [结果](../review-evidence/srt-02-scope-20261106/owner-review/static-verification.json)

本轮没有导入项目模块或运行 Host、Runtime、Worker、GUI、模型；没有新增行为测试通过数。既有 SDK、Planning 和 GUI 成绩仍属于原精确交付。

## 技术结论

1. `useArrayRef` 已发布整列表及单项。整体名如 `Task[]:tasks`，元素名如 `Task:tasks[0]`，两者的显式 refType 均为 `Task`。名称和类型元数据职责不同，不能从字符串前缀重新推断类型。
2. 当前正式参数 profile 只接受必填顶层对象 Ref，调用准备也拒绝数组 payload。这两处是整列表消费的实际边界；发布端无需再建一套机制。
3. 既有 `refParam('Task', Type.Array(TaskSchema))` 可沿同一声明表示模型传字符串、handler 收数组的目标。现有 ArgsOf 的 DeepReadonly 已覆盖数组和元素类型；实际支持范围必须由新包与真实调用验证，不能凭 TypeScript 编译宣称完成。
4. 多 Ref 不属于简单放开数量限制：当前准备循环每次从 rawArgs 重组，会丢失前一字段的解析结果。本批继续拒绝该形状是正确边界。可选 Ref、多选字符串数组、属性路径及 SRT-05 自动观察替换分别保留后续任务。
5. Worker 现有路径复验正式合同、raw/effective 参数、来源与普通字段。是否可以不改 wire 仍待真实混合版本验证；静态范围批准不能替代这一证据。

任务以减法约束实现：复用发布、参数编译、原 Observation 解析、授权与 Worker 执行，优先只调整两处 Runtime 参数逻辑和准确的 SDK 支持说明。App 不新增框架补偿逻辑，也不向 Planning 添加未经要求的批量业务。文件工具继续使用路径。

## 准出与未覆盖风险

任务包 G-A 至 G-G 可作为本批准出条件，必须整体执行。重点包括双 Producer、严格类型与 readonly、错形状／错类型／不可见引用、空列表与 min/max、原观察来源、授权期间撤销、一次真实业务进入、总预算、释放与关闭，以及新旧 SDK／Runtime 四组合。

实施时还须明确记录以下已有要求的实际证据：

- handler 中尝试修改列表或元素时，不能改变框架持有的快照；同时保持只读类型拒绝，不能只测其中一层。
- 先固定四组合的支持预期和拒绝阶段。旧 Runtime 对未支持整列表必须在业务前拒绝；新旧包不能靠静默回退“通过”。
- 基线源码重建须与精确包的实际执行代码、声明对应。README、构建路径或 source map 差异单独列明，不能仅凭版本号或 tar 名认定一致。

目前未覆盖实现正确性、实际 Worker 接受数组、运行时不可变性、混合版本、容量边界和资源结算；也未完成共享集成。B24 已识别的共享保护继续保留，不能把隔离源码整体覆盖到共享树。旧 Snapshot Tool 仍有消费者，本批不删除。

## 下一步已下发的技术工作

SRT Owner 负责在**全新独占目录**重建本批基线，并准备真实消费者入口及合成配置；Minimal Core 负责人负责独立复核。两方不并行修改同一生产文件，不回退或覆盖其他执行者的修改。

本次先下发准备阶段，交付应包含：新目录、实际重建命令和原始输出、与三份精确输入包的关系、目标文件 preimage、依赖真实解析路径、准备运行的消费者脚本／命令、模块初始化链、合成配置与数据路径，以及每个 Runtime／Worker 的创建与关闭责任。重建只能读取历史原件，不能执行可能写回原证据的旧 reproduce 脚本。

这一步可以完成静态复制、补丁重放和构建准备；**首次项目模块行为运行前，由 Minimal Core 审查具体消费者入口**。不把 Host 诊断脚手架复用进来，不导入 Host 默认 singleton、不读取默认用户 Registry、不修改 HOME，不重置已交接手测环境。这个技术检查由负责人处理，不要求项目所有者重复确认日常实施细节。

入口核对后，再按已签范围建立有效失败、实施两处最小改动并执行 G-A 至 G-G；若需改变 wire、capability、公开签名或额外生产模块，先提交具体失败和范围修订。实现者完成后交 READY_FOR_REVIEW，由独立负责人审查 patch、源码和真实产物。

后续完整实施 Prompt 采用原任务包第七节，并附加本裁决的准备阶段检查点。当前准备阶段 Prompt 为：

> 你负责 SRT-02 一个必填顶层 Array<Object> Ref 的隔离基线与消费者准备。你不是唯一执行者，不修改共享生产文件或回退他人修改。以 source-inputs.json 的精确 Git、补丁及原包为只读输入，在新独占目录重建；保存 preimage、输入身份和实际差异。先交源码／包对应关系、具体运行入口、依赖解析、合成配置和完整创建／关闭责任。不要运行 Host 或复用预览诊断脚手架，不导入项目模块，不读取用户私有状态，不改变 HOME，不重跑或重置手测。准备好后交 PREPARATION_READY_FOR_REVIEW；由 Minimal Core 核对入口后再推进真实基线失败与实现。不得借准备任务扩展多 Ref、optional、Ref 数组、协议或共享采用范围。

MC-HOST-PREVIEW-01 与本批分开：静态分析已签收，缺陷 OPEN，事故与权限预检 CHANGES_REQUESTED，第三轮 Host 仍 NOT_ADMITTED。上述 SRT 准备任务不解除该限制。
