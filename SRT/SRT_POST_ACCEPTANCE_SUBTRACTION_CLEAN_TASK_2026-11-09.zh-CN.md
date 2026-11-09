# 已验收内核的完整减法清理

2026-11-09。执行：Clean。集中复核与采用：SRT Owner。**状态：APPROVED_ADOPTED，完整交付、集中验收并采用到实际根目录。** 62个路径、5个生产文件删除、生产净减444行；实际构建及必要验证通过，详见[负责人验收与采用](SRT_POST_ACCEPTANCE_SUBTRACTION_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)。本任务来自项目所有者在SRT-01～SRT-15采用后追加的指令：“旧／废弃代码”“可删可不删的代码我们都删除了”，目标是强大、稳定、简洁的内核。已有验收继续作为基线，不把本轮新清理假称为旧任务尚未开发。以下保留本轮执行范围与原任务要求。

## 完整目标与判断标准

从当前受支持的SDK／Runtime入口追踪依赖，完成一轮剩余生产代码、公共导出、相关消费者和分发内容的整体减法。没有当前独立职责的代码默认删除，不为假设需求、历史兼容身份或未来扩展保留。执行仓库minimalist技能，不新增框架、依赖、保存区、兼容包或第二条执行路径。

优先处理：未使用及被替代的实现／选项／分支；无职责转导出和转发包装；重复数据镜像、只写不读状态和恒定策略包装；废弃配置、导出、初始化或订阅副作用；删除后不再需要的依赖、构建项、旧测试与当前文档。可合并到唯一现行实现的直接合并，机械改名、格式化和拆大文件不计清理成果。不要只交静态扫描或下一轮计划。

“没有仓内调用”是线索，要同时核对包入口、动态加载、CLI、Worker、两种Producer及当前示例。仍受支持的低层入口不能仅因默认Host不使用就误判为死代码；历史兼容入口也不因导出过就永久保留。实际需要的公共迁移直接完成并说明Breaking Change，保持当前产品能力，不逐小点请求批准。

保留框架实际承担的一致提交、观察采用／失效、Ref所有权及来源绑定、执行资格与边界参数检查、诚实结果和自有资源释放。只在同一职责已由保留路径承担时删除重复检查，不把跨边界必要检查当重复代码，也不新增假设风险防御层。

## 基线、文件归属与并行工作

使用当前共享工作树建立新独占候选，基线包含已采用r02-combined及MC19／14路径。共享main有大量已验收未提交和未跟踪文件，不能从HEAD重建或整树覆盖。你不是唯一执行者，保留其他人的修改。

Clean拥有本任务的SDK／Runtime剩余清理及直接受影响的导出、测试、示例、构建／包配置和文档。其他模块仅为这些退出做必要消费者迁移，不扩展Host、Driver、IDE内部重构或业务功能。

MC当前按`MINIMAL_CORE/MINIMAL_CORE_REMAINING_WORK_2026-11-09.zh-CN.md`独占以下尾项，本任务不重复实施或审查：

- Runtime参数接收、编译与注册链：`adapters/ordinary-invocation-v2.ts`、`worker-runtime/ordinary-invocation-v2.ts`及`index.ts`、`worker-runtime/app-kernel/AppKernel.ts`、`core/tool/view-owned-tools.ts`、参数合同／profile辅助及直接类型测试。
- SDK必要参数执行链：`utils/ordinary-parameter-tool.ts`、`tools/view-type-tool.ts`及该项直接测试。
- IDE随包本地入口迁移：`demo-apps/aotui-ide/SCOPED_IDE.md`、`examples/local-scoped-ide.mjs`、其实际入口测试、`scripts/scoped-ide.mjs`及必要相关包／文档。

先连续完成无交集的全部工作。若本轮删除必须迁移上述文件，提出具体路径和最小交叉差异；Owner按该项实际交付协调采用，不暂停无关部分、不让两个Owner重复复核。MC结论按其线接收，不能用SRT完成状态声称MC已全部完成。

### 已出现的两文件交集：限定到代码段继续实施

Clean报告旧AppContext渲染回调链及私有app-kernel转导出退出涉及上述两个文件。现明确：Clean可以在自己的独占候选中直接完成以下改动，无需等待MC整项交付；MC继续拥有参数编译／接收／注册逻辑。

- `runtime/src/worker-runtime/index.ts`：AppKernel导入改为直接来源；退出OPEN中的旧`renderCallback`／`isRendering`／`needsRerender`／`scheduleRender`与AppContext的`onRender`／旧`markDirty`接线，清除reinitialize对应空回调。
- `runtime/src/worker-runtime/app-kernel/AppKernel.ts`：清除`projection.recordMutation`之后对旧AppContext的`this.context.markDirty()`转发。

Clean保留SDK RuntimeContext.markDirty、投影失效、Preact及当前ComponentRenderer提交／卸载职责；关联SPI和测试随该线完整迁移。交付列出这两个文件的限定差异及before，最终组合按实际交付先后保留已批准内容，由后交付方将自己的差异叠加到新基线并完成直接相关检查，不以整文件覆盖另一条线。双方都只在自己的候选开发，不写共享生产；集中复核按开发归属各一次，不为本交集追加中途review或停止其他工作。

**实际采用顺序：** 本轮Clean先完成，Owner已采用62路径，MC参数实现尚未包含。MC后续组合需保留上述两个生产文件及`AppKernel.ordinary-v2.test.ts`的AppContext夹具迁移，在新基线上继续本线尾项。准确after见[采用清单](../review-evidence/post-srt-subtraction-owner-20261109/adopted-changes.json)，不追加另一Owner复核。

## 验证与一次交付

按实际删除影响复用现有测试：证明保留能力、调用入口和生命周期仍成立；退役入口专属测试可以删除，仍证明当前合同的断言保留或迁移。完成受影响包构建和严格公共类型；若公共导出、打包内容或启动链变化，使用现有正常安装包入口验证相关普通／Ref调用及关闭，不用源码alias代替包消费。无依据不重复GUI、真实模型、历史全套矩阵或人工Planning验收。

交付一个完整可采用候选：简明删除说明、实际patch与变更文件before／after、必要命令和结果。说明删除的职责由哪个保留入口承担；确实保留的可疑项只写具体当前职责，不制作庞大例外清单。报告净变化、删除文件／依赖、相关公开迁移和有无具体未完成项。不要求删除数量目标，也不为多删几行增加替代框架。

完成后主动交付SRT Owner。Owner只在整项完成后集中复核实际差异；常规修复连续完成，真实问题一次汇总。通过后选择性采用、重建受影响产物并更新唯一索引。不轮询聊天、不等待额外确认、不逐小点交审，不提交、推送、合并或发布。

## 不扩张的事项

用户未来Ref字段／作用域／基础类型、并发和资源策略重设计保持原决定。历史验收报告、证据、冻结候选及用户数据不属于本轮生产清理对象；不清空`.tmp`或证据目录。独立lint／RSS项目不混入本任务。确实需要重大产品能力取舍才由Owner提出具体问题，其余清理持续推进。
