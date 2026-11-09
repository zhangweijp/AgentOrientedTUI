# Minimal Core 原计划核对与尾项完整任务

2026-11-09。**APPROVED_ADOPTED：两项尾项已开发、独立批准并采用到实际根目录，本线已授权工程任务全部结案。** 本记录以Minimal Core原计划及本线后续任务为依据，不以SRT-01～15整体签收替代本线结案。已批准的两轮清理及其他批次成果保持有效；指定Minimal Core执行Agent完成本次遗漏，MC Owner独立复核，SRT Owner依结论协调采用。见[最终裁决及结案补记](MINIMAL_CORE_REMAINING_WORK_REVIEW_2026-11-09.zh-CN.md)和[实际采用](../SRT/MC_PLAN_CLOSURE_OWNER_ADOPTION_2026-11-09.zh-CN.md)。批准patch为`50575be4591e42a15ac6f0c56f298b1b50129d63b8a890a684bf95136a510d25`，19项实际after再次核对一致，根Runtime／SDK／IDE构建通过；没有剩余实施项、新增开发批次或用户确认项。以下21:20记录是组合完成前的历史进展，已由本结案状态覆盖。

**执行进展（2026-11-09 21:20）：** A、B已作为19路径整项交付，原patch为`4a68be46fa8c89873d3720259e05304651c722872cb78d5bb2da74225daee516`。MC Owner已独立核对源码，109项参数／调用测试、正常安装包随包终端9场景、537件包文件和补丁正反向重放通过，暂未发现本线逻辑阻断。复核期间Clean的62路径减法先采用到实际根目录；因此原先“MC先采用”的时序已被实际状态替代。MC执行Agent已收到最终组合任务：以现行树为基线叠加本线差异，保留Clean已删除的旧渲染接线，新增AppContext夹具仅传身份字段；复用有效检查，只补必要组合验证。最终负责人裁决和根目录采用仍待完成，无需新增用户确认。原完整回归Runtime2098／SDK188仅属于原交付候选，不能冒称新组合已测。依据见[独立复核事实](../review-evidence/minimal-core-plan-closure-20261109/owner-review/review-notes.json)。下表保留此次开工核对结果，完成状态以后续裁决与采用记录为准。

## 原计划与当前事实

| 原计划事项 | 本次核对结果 | 依据与归属 |
| --- | --- | --- |
| M0／M1：基线、CLI释放、MCP／IM缺陷 | 相关批次已交付；B10已有实际采用复验，不再把它列为等待用户批准 | MC交接记录中的B01、B06／07；B09独立裁决；`review-evidence/minimal-core-batch-10/owner-review/shared-application/final-application.json`为APPLIED_AND_VERIFIED |
| M2～M4：ledger、Scope owner、观察管理与时钟扫描减法 | 已实施。当前scoped-interaction拥有唯一states与clock，Observation操作接收同一states；独立ledger文件已退出 | B01历史批准保留；本次只读核对当前实现；已验收的当前完整Core回归复用，不重建用户明确清理掉的历史原件 |
| M5／R3：结果重复解释收敛 | B02／04已完成原终态规则和发送端捕获减法；后续结果合同变化属于Clean线输入 | 不把Clean后续结果判别合同计作MC新增成果 |
| **M5／R4：最终调用校验及重复编译** | **已批准并采用。** 开工时遗留的逐调用编译已退出；B11确认有独立职责的校验继续保留 | 现有注册记录保存compiled contract，Worker复用它。普通／Ref各四次调用仅注册时编译一次，坏输入、旧绑定、重开／替换／关闭及低层trusted factory行为经测试；见最终尾项裁决 |
| M6／D1、D2、D4：Source统一、唯一执行、身份及续轮 | 本线B09／B10等已批准并采用；当前五个Host Source与AOTUI Adapter均使用getContext，MCP完成通知位于finally且逐订阅者隔离异常 | MC自身批次与当前源码；后续Clean的Driver暂停修复作为关联输入，不冒认开发归属 |
| M7：普通工具消费Ref／ArrayRef、退出旧专属执行路径 | 本线B12～25样例／协议候选、后续普通Ref与旧入口退出工作已有对应裁决；完整当前合同由后续联合交付承接采用 | B22及MC后续Ref验收，关联联合采用分别注明；当前SDK无旧useViewSnapshotTool导出，Worker保留的是旧协议拒绝分支，不能误删 |
| **M8／R6：旧作者路径、示例、文档和消费者迁移** | **已批准并采用。** 主要作者路径交付后发现的IDE随包入口遗漏已修复；旧模式、旧view-instance分支及失效启动包装退出 | 下方保留开工反例；现行匹配包终端9场景完成真实观察／采用、文件操作、最新View、收据回读、LSP和关闭，文档及测试同步迁移 |
| M9：组合验证与作者试用 | **本线已完成。** MC完整Core回归、Host预览、作者材料及新上下文作者试用等结论继续有效；最终组合和根目录采用也已完成 | 各项裁决按对应版本复用；最终组合255项、Owner独立74项及包终端验证通过，实际根三包构建通过。Clean成果按其归属接收，不重做另一Owner审查 |
| 用户追加两轮减法 | 已开发、MC独立APPROVED并采用 | 19路径与14路径；生产净减1769／311行，采用事实已核对 |

原计划是目标与约束，不能把每条最初删除建议都机械执行。B11已经用实际反例关闭了两条不安全的直接删除建议；它未关闭重复编译问题。D3取消，公开Scope／receipt、现有TTL与容量职责保留，未来Ref字段／作用域、并发、整体资源政策不计本线未完成项。正式发布仍由项目所有者决定，不借本任务开展发布。

## 已确认的消费者反例

`demo-apps/aotui-ide/SCOPED_IDE.md`目前以当前SDK／Runtime版本介绍安装，却在示例和正文要求`ordinary-v2`、`snapshot-value-v2`及旧v3工具能力。`demo-apps/aotui-ide/examples/local-scoped-ide.mjs`同样传入旧模式，并在投影中保留旧view-instance分支。两者都在IDE package.json的files内，README还将该文档作为当前合同入口，不属于历史证据目录。

MC Owner把示例的原interactionModes参数传给当前根Runtime公开安装API，使用新建临时目录且没有操作用户Host／项目数据：实际拒绝码为`INTERACTION_MODES_INVALID`，当前允许模式仅`view-type-parameters-v1`，随后正常关闭且resourcesReleased=true。此探针证明当前安装参数失效，没有把它说成已完整运行随包终端。

原始脚本、日志、命令和结果位于[本线核对证据](../review-evidence/minimal-core-plan-closure-audit-20261109/ide-retired-mode-facts.json)。已有`demo-apps/aotui-ide/tests/local-scoped-ide.e2e.mjs`可用于修订后的真实包入口验证；其当前覆盖、版本与启动方式须由执行者核对。

## 一次完成的执行任务

执行者：Minimal Core执行Agent，聊天`01a19fd2-78ed-7a91-b34e-c2c0e00976aa`。你不是唯一执行者，保留当前工作树全部已采用修改和有效未跟踪文件；从当前树新建独占副本，不覆盖共享生产，不改写历史候选或证据。Clean前一整项已完成采用，本任务使用该新基线；如果出现新的实际文件占用，只协调冲突文件，其余工作继续。

**已明确的两文件交集（2026-11-09补充）：** Clean另有[验收后减法任务](../SRT/SRT_POST_ACCEPTANCE_SUBTRACTION_CLEAN_TASK_2026-11-09.zh-CN.md)，仅在自己的候选中修改以下代码段；MC继续独占本任务的参数编译／接收／注册逻辑及IDE消费者迁移，两线直接继续，无需等待确认。

- `runtime/src/worker-runtime/index.ts`：Clean负责AppKernel直接导入、OPEN旧AppContext的renderCallback／isRendering／needsRerender／scheduleRender及onRender／旧markDirty接线退出，并移除reinitialize的对应空回调。
- `runtime/src/worker-runtime/app-kernel/AppKernel.ts`：Clean负责删除projection.recordMutation之后的旧`this.context.markDirty()`转发。SDK RuntimeContext.markDirty、当前Preact／ComponentRenderer与投影提交职责仍由该线保留。

MC不重复实施上述删除；若R4确实需要修改相同代码段，报告精确交集并继续其他工作。交付保持本线独立patch和before，采用时先保留已批准MC内容，再由Clean按代码段叠加自身差异及必要验证，不整文件覆盖。各线仍只由对应Owner集中复核一次，不因共享文件名称相同插入中途review。

### A. 完成R4中的真正减法

责任范围：Runtime现有参数接收／验证入口、view-owned-tools注册与调用、AppKernel接线，以及必要SDK参数执行消费者和相关测试。重点为：

- `runtime/src/adapters/ordinary-invocation-v2.ts`
- `runtime/src/worker-runtime/ordinary-invocation-v2.ts`及`index.ts`
- `runtime/src/worker-runtime/app-kernel/AppKernel.ts`
- `runtime/src/core/tool/view-owned-tools.ts`、现有参数合同／profile辅助及必要类型
- `sdk/src/utils/ordinary-parameter-tool.ts`、`sdk/src/tools/view-type-tool.ts`及直接相关测试（仅在必要时修改）

沿用现有注册所有者及其已编译合同，消除同一Worker对同一有效注册在每次调用时重新编译的工作。检查同一执行段中的重复绑定／参数校验，只有没有独立职责的部分才删除。不得用新全局缓存、Manager、第二套validator或跳过IPC校验代替收敛。

保留B11确认的不同信任边界：Core授权前校验、Worker接收端的身份／参数／Ref来源检查、SDK当前执行资格，以及公开低层trusted factory的既有行为。低层直调不能被无声改为强制校验或跳过既有校验；错误、进入handler的次数、raw/effective参数和关闭失效保持。涉及真实公开语义取舍时明确列出，不自行扩大权限，其余工作继续。

用实际注册后多次调用证明不再重复编译，同时保留普通参数与Ref、坏参数、篡改来源、撤销／重开及公开低层调用的必要测试。复用现有入口和断言；不机械新增实现镜像测试，不重跑历史全部矩阵。保留必要校验并给出具体理由也是有效裁决，不以删光检查为准出。

### B. 完成现行发布消费者迁移

责任范围：IDE当前SCOPED_IDE文档、随包local-scoped-ide示例、直接启动脚本`/scripts/scoped-ide.mjs`、现有local-scoped-ide测试及实际受影响的包入口／文档引用。核对原计划明确涉及的其他当前示例是否仍引用同类已退出合同，按实际调用链清理；历史报告与失败证据不改写。

把仍受支持的本地消费方式接到现有当前合同，删除旧模式、旧执行类别分支及无职责的启动包装。复用当前公共入口和已有示例／测试，不新建终端框架、兼容层或重复Ref解析。文档、实际代码及包files保持一致；不要仅修改文档版本号或让启动测试只检查--help。

使用正常安装的当前匹配Runtime／SDK／IDE包，实际启动随包入口，完成观察／采用、至少一次文件操作、最新View和正常关闭。复用现有临时项目与验证脚本，不使用用户真实目录、不启动用户Host或GUI。不新增无关IDE／LSP资格矩阵。

## 完整交付及准出

连续完成A、B的分析、实现、消费者迁移、相关验证及常规修复，再一次交付；不要交计划后等待，不逐小点请求review。完成后主动向MC Owner汇报，负责人不轮询聊天，也不重复跨Owner进度同步。

交付相对实际开工基线的patch、变更before／after、简明报告和必要真实命令／结果。报告分别说明R4删了什么、哪些检查因真实职责保留，旧消费者如何迁到当前入口，原计划还有无具体未完成项。只保留必要原始证据，不制作全仓哈希包；引用其他线成果时注明开发及验收归属。

准出为：R4的重复编译已在真实调用链消除且边界行为正确；随包示例能用当前合同实际启动和操作；相关源码、类型、当前文档及包内容一致；无新增抽象、依赖或兼容执行路径；没有覆盖其他执行者。MC Owner集中给出APPROVED／CHANGES_REQUESTED后继续采用，不由执行者自批，不提交、推送或发布。

## Codex Prompt

> 立即完成Minimal Core原计划尾项收口：一是R4的Worker每次调用重新编译与同段无职责重复校验，二是IDE随包本地消费者及当前文档遗漏迁移。按本任务书，以当前已采用树建立独占候选，使用minimalist，复用注册合同与现有公开入口；保留跨信任边界、低层trusted factory、Ref及资源责任。不要重新实施或审查整份SRT，连续完成实现、迁移、自测、修复后一次提交完整结果并主动汇报MC Owner。你不是唯一执行者，不覆盖共享树，不因普通实现选择等待确认。
