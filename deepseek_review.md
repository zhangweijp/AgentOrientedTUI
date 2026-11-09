# AOTUI SDK / Runtime 评审与决策记录

> 基于 2026-11-02 的评审及 2026-11-03 的源码 Review、项目所有者反馈，按议题合并维护。
>
> 范围：`sdk/`、`runtime/` 及必要的对外集成合同；不扩展到 Agent Driver、Host、IDE 内部改造。
>
> **已确认**表示方向或约束获认可，不等于具体 API 获批或实现完成；**建议／待定稿**表示机制仍待设计；**已完成（工作区）**不等于提交或发布；**暂缓／不纳入**分别表示当前不做和超出职责。
>
> 每个议题在对应正文中维护一份“现状—约束—建议—证据”。顶部只保留 TODO 索引，不再另附一份评审报告或旧优先级清单。具体实施状态见各节，历史测试与探针边界统一见第 6 章。

<a id="latest-feedback"></a>

# 2026-11-03 最新反馈收敛：先约束，再方案

**2026-11-10 Git 基线固化：** 此前已验收并采用到实际根目录的 SDK／Runtime、Driver／Adapter、App、Host、工具链、文档和 skills，已按模块分批提交，经 `codex/integrate-srt-cleanup-20261110` 合并到本地 `main`。本轮仅固化已有成果并更新 Git 状态，不改变产品合同或历史验收结论。`review-evidence/`、`MINIMAL_CORE/` 和 `SRT/` 按项目所有者要求整体忽略，原件保留本机；两个任务记录目录已停止跟踪，实际模块代码继续保留在 Git 中，已发布历史不改写。`.tmp/` 和历史交付目录继续保持本机状态。下文指向这些记录目录的链接用于本机追溯；历史报告中的“未提交／未合并”描述其签发时点，当前 Git 身份及远端同步状态以提交日志和 `origin/main` 为准。

当前先做好串行调用与投影语义；Ref、ArrayRef 是核心数据概念。并发和有界资源整体重设计暂缓，错误与性能治理为低优先级。以下是唯一待办索引，编号不表示开发顺序，也不自动授权实施。

**2026-11-08 人工签收：** 项目所有者已在 Clean 聊天确认本轮 Planning／Ref／View 工作流四点标准满足，可以签收；联合交付与 FEEDBACK-TOOLS-01 的本轮人工验收已完成。[签收原始消息及边界](SRT/FEEDBACK_TOOLS_01_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md#2026-11-08-用户人工签收)以用户体验报告为依据，未执行的非法 Task Ref 用例如实保留，不追加验收，也不自动扩展其他专项。

**2026-11-09 Host约定范围人工验收通过，反馈修复已采用：** 用户回传 `AOTUI-验收-20261109-221114`，[接收记录](SRT/HOST_DEEPSEEK_ACCEPTANCE_RECEIPT_2026-11-09.zh-CN.md)保存Planning／Ref、IDE双文件、错误拒绝与恢复及跨App使用的实际报告；随后[补充报告](review-evidence/host-deepseek-acceptance-20261109-221114/USER_FINAL_UI_CONFIRMATION.zh-CN.md)对FileDetail退出、IDE关闭、Planning打开／关闭三项明确确认“全部正常”。本轮不再有待补人工确认项。Clean反馈任务已由SRT Owner唯一[集中复核并采用5路径](SRT/HOST_ACCEPTANCE_FOLLOWUP_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)：A3三条错误提示已改善，根Runtime／IDE构建通过。A2／A4仍为本地未复现、历史逐轮View证据不足；暂停按用户决定跳过，其他人工未覆盖项维持原范围，不扩写为通过。测试数据保留，不新增开发、复核或人工门禁。

**2026-11-09 当前结论：SRT-01～SRT-15 原定工程任务全部完成并采用到实际根目录。** [完整负责人验收与逐项映射](SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)确认此前缺少的App元数据／身份、结果判别合同、协议来源与提前拒绝、时钟恢复检查，以及关联的文档／包消费者／旧入口迁移均已收口。此前将小批次完成误报为整体完成的表述已纠正；本次结论对应完整15项。已有Planning／Ref人工签收继续有效，没有新增人工前置。此结论不表示已经提交或发布，也不包含用户明确未来／暂缓事项。

**2026-11-09 新增清理已完成并采用：验收后完整减法清理。** Clean按[完整任务](SRT/SRT_POST_ACCEPTANCE_SUBTRACTION_CLEAN_TASK_2026-11-09.zh-CN.md)连续完成后，SRT Owner一次集中复核给出[APPROVED_ADOPTED](SRT/SRT_POST_ACCEPTANCE_SUBTRACTION_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)：62路径、5个生产文件删除、生产净减444行，无本轮阻断。实际根目录全部after匹配，正常包文档／Worker独立验证、原run.sh九模块构建段及Host严格类型通过；额外linkedom严格源码依赖检查的既有声明限制单列保留。

**2026-11-09 MC原计划最后两项也已完成并采用。** 参数注册合同复用、Worker退出逐调用编译，以及IDE随包入口／文档迁移由MC执行，获[MC Owner唯一APPROVED](MINIMAL_CORE/MINIMAL_CORE_REMAINING_WORK_REVIEW_2026-11-09.zh-CN.md)；SRT Owner随后[采用最终19路径增量](SRT/MC_PLAN_CLOSURE_OWNER_ADOPTION_2026-11-09.zh-CN.md)。全部before／after匹配，保留Clean已采用删除，实际根Runtime／SDK／IDE构建通过。此前所列两项遗漏至此完成实现、复核和采用，已授权工程范围没有剩余开发阻断，不再以“MC尾项进行中”表示当前状态；各线历史交付与验证仍分别归属，不重复代码审查。

**执行与采用结果：** Clean完整交付后由SRT Owner集中复核；唯一实测缺失App入口回退问题已修复，最终修订及交叉导出迁移通过后选择性采用。MC两组清理由MC Owner唯一复核，SRT Owner直接接收并采用19路径、14路径，不重复代码审查。实际根目录采用、必要构建及当前匹配包证据见[最终验收](SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)。D3取消、并发与资源策略暂缓、Ref字段访问／数据作用域／基础类型等未来事项保持原决定。

**2026-11-09 本地修复阶段（历史记录）：** [SRT-06完整任务](SRT/SRT-06_TOOLCHAIN_CLOSURE_CLEAN_TASK_2026-11-09.zh-CN.md)已由Clean交付[本地修复与采用方案](review-evidence/srt06-toolchain-closure-clean-20261109/REPORT.zh-CN.md)，按用户最新分工，SRT Owner已直接复核通过本地修复与限定证据，MC Owner重复复核已撤回。LSP官方PR本地回移得到正常关闭code1→0、提前exit仍1及9项有限检查通过；provider-utils精确类型补丁使严格正向通过、8非法项目被拒绝，实际包运行5项通过。以上为执行方本地实验结果，正式依赖仍有原问题，IDE原生后端尚未迁移，补丁没有默认进入生产或公共分发。Owner已核对202交付文件与520共享输入及ZIP身份。[负责人裁决](review-evidence/srt06-toolchain-closure-owner-20261109/REVIEW.zh-CN.md)确认两份本地修复无待修订问题；生产继续当前正式依赖，LSP等待稳定包修复，类型补丁保留为内部备选。已有人工签收保持，无新增人工流程。

**2026-11-09 负责人分工修正：** Clean开发→SRT Owner直接复核和交付；Minimal Core执行Agent开发→MC Owner复核，SRT Owner接收结论并协调采用。每项只保留一次负责人复核，验证围绕实际改动，复用已有结果，不重复矩阵或扩大证据流程。SRT-06现按此执行，历史签收记录保留。

**2026-11-09 SRT-06工程交付完成：** 已完成[工具链与实际入口采用](SRT/SRT-06_TOOLCHAIN_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)。Clean完整候选及Host增量由SRT Owner唯一复核，33路径采用到根目录；Driver／IDE／Host冻结离线安装、原run.sh九模块、Host GUI和严格类型全部通过，Owner独立6次实际包链路及关闭释放通过。本结论只证明该项完成，不代表整份SRT清单完成。当前使用明确的精确临时补丁，原生LSP资格限darwin-arm64；未提交、推送、合并或发布。

**2026-11-09 当前内核完整回归收口：** [MC Owner最终裁决](MINIMAL_CORE/MINIMAL_CORE_FINAL_CORE_REGRESSION_REVIEW_2026-11-09.zh-CN.md)为APPROVED／NO_CHANGE。当前Runtime默认131文件2092项、SDK默认20文件187项全部通过，零失败／跳过／todo；两包构建及现有两项严格公共类型检查通过。无生产、测试或依赖修复需要采用，SRT Owner直接复用结论。此前SRT-10全量两失败及其后定向验证保留为历史记录，当前组合完整回归缺口已关闭；工具链与IDE最终集成已完成，见[本轮工程收口](SRT/SRT-06_TOOLCHAIN_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)。

<a id="review-todos"></a>

| ID | 工作 | 当前状态与边界 | 正文位置 |
|---|---|---|---|
| HOST-ACCEPTANCE-01 | Host实际验收反馈核实与限定修复 | 已APPROVED_ADOPTED，约定范围人工验收已通过。A3三条提示采用5路径，根Runtime／IDE构建通过；最终界面三项用户确认“全部正常”，无待补确认。A2／A4仍本地未复现、历史View缺失；暂停跳过及其他未覆盖范围保留，无工程阻断 | [最终复核与采用](SRT/HOST_ACCEPTANCE_FOLLOWUP_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)、[人工确认原件](review-evidence/host-deepseek-acceptance-20261109-221114/USER_FINAL_UI_CONFIRMATION.zh-CN.md)、[报告接收](SRT/HOST_DEEPSEEK_ACCEPTANCE_RECEIPT_2026-11-09.zh-CN.md) |
| POST-SRT-CLEANUP | 已验收内核的完整减法清理 | 已APPROVED_ADOPTED。Clean完整交付、SRT Owner集中复核并采用62路径；5生产文件删除，生产净减444行。消费者／分发同步，必要验证和根构建通过，无本轮阻断。关联MC两项尾项也已按本线批准结论采用 | [负责人验收与采用](SRT/SRT_POST_ACCEPTANCE_SUBTRACTION_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)、[MC最后增量采用](SRT/MC_PLAN_CLOSURE_OWNER_ADOPTION_2026-11-09.zh-CN.md)、[完整执行任务](SRT/SRT_POST_ACCEPTANCE_SUBTRACTION_CLEAN_TASK_2026-11-09.zh-CN.md)、[产品约束](AGENTS.md#十二2026-11-09-反馈验收后继续做减法) |
| FEEDBACK-TOOLS-01 | 删除Mutating分类，工具定义仅进入Context Tools，精简Planning正文 | 2026-11-08完整交付已APPROVED并采用到实际根目录。isMutating已从SDK/Runtime合同删除，Root按ViewType仅列工具名，Planning数据View不再重复列Tools。根九模块+GUI构建、SDK186、Adapter46、当前集成31、Planning27次实际调用通过；Runtime2073过/2项既有SRT-10失败。用户已明确签收本轮人工工作流；原./run.sh入口与本批均已收口 | [集中验收与根采用](SRT/FEEDBACK_TOOLS_01_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md)、[产品约束](AGENTS.md#九2026-11-08-反馈工具定义只进入-tools删除-mutating-分类) |
| SRT-01 | 单一声明、实例 handler、动态可用性与目录生成 | M4.3 精确候选已通过 G1–G4，本地工程准出完成；固定六原格＋三替换格的作者验证为 9/9。2026-11-08已随Planning统一入口采用到根目录并通过实际构建及调用验证；发布与最终Semantic人工验收未包含 | [2.5](#sdk-authoring)、[最终工程裁决](.tmp/worktrees/srt-01-owner-verdict-20261106/SRT-01_G3_OWNER_CLOSURE.2026-11-06.zh-CN.md)、[技术方案与交付计划](SRT/SRT-01_SINGLE_DECLARATION_PLAN.zh-CN.md) |
| SRT-02 | ViewType Tool 统一 Ref／ArrayRef 参数，删除独立 Snapshot Tool 路径 | 完整Ref＋View联合交付已APPROVED并采用到实际根目录。对象/整列表/元素、多个/可选Ref和Ref名数组均贯通，旧专属路径与文档/包/测试收口。独立SDK185、Adapter46+集成31、两Producer各41调用通过；Runtime2073过/2项既有SRT-10失败。根9模块+GUI构建、17包解析、Planning27调用通过；实际入口的本轮Planning/Ref人工工作流已由用户签收，见顶部签收记录 | [联合验收与根采用](SRT/SRT-02_03_07_COMBINED_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md)、[完整任务](SRT/SRT-02_03_07_COMBINED_DELIVERY_CLEAN_TASK_2026-11-08.zh-CN.md) |
| SRT-03 | 显式 ViewType 与 instruction/state 元数据 | 完整联合交付已APPROVED并采用到实际根目录。SDK必填type/kind、Runtime根元数据、四App及公共示例贯通；联合SDK185、正常包严格示例和真实调用通过，实际根构建与Planning调用已验证。本轮View/工具变化人工工作流已由用户签收 | [联合验收与根采用](SRT/SRT-02_03_07_COMBINED_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md)、[View独立裁决](MINIMAL_CORE/MINIMAL_CORE_VIEW_PIPELINE_FINAL_REVIEW_2026-11-08.zh-CN.md) |
| SRT-04 | 串行观测前刷新 | 隔离r02已获独立APPROVED并完成本地工程收口。现有Scope.observe等待已提交投影并接受相容快照；无通知、无变化、投影失败保留业务结果和关闭路径通过。r01的act漏等已修复，原失败保留；独立SDK178/178、刷新17/17、原反例2/2、严格类型、双Producer及两个原作者样例通过。2026-11-08已随Planning根入口采用并核验；发布与最终Semantic人工验收未包含 | [3.8](#serial-observation)、[r02交付](.tmp/srt-04-clean-r02-20261108/REPORT.zh-CN.md)、[独立批准](MINIMAL_CORE/MINIMAL_CORE_SRT_04_CLEAN_R02_REVIEW_2026-11-08.zh-CN.md)、[Owner收口](review-evidence/srt-04-clean-owner-20261108/r02-identity.json) |
| SRT-05 | 新观测替换、旧 Ref 失效与释放；注册所有权 | 精确隔离候选已获独立APPROVED并完成工程收口。正式采用新观察后撤销旧调用/Ref资格，释放无人持有的旧数据；后台发布/预览不切换，部分采用失败有逐App结果且仍释放。复用现有Scope、lease和Driver finally，未新增管理器；独立Core/Receiver1159/1159、Driver3/3、真实Worker/Source及公开包消费者通过。2026-11-08已随Planning根入口采用并核验；最终Semantic人工验收未包含 | [3.8](#serial-observation)、[4.6](#ref-ownership)、[独立批准](MINIMAL_CORE/MINIMAL_CORE_SRT_05_CLEAN_REVIEW_2026-11-08.zh-CN.md)、[Owner收口](review-evidence/srt-05-owner-20261108/identity.json) |
| SRT-06 | Runtime 去具体 Agent Driver 依赖及工具链收口 | 已APPROVED并采用实际根目录。B独立薄适配包保持；统一TypeScript7.0.2，完整Driver／Host严格类型通过Pnpm精确provider-utils补丁解决；IDE原生后端、真实查询／外部更新／正常关闭接入完成，暂停续轮缺陷已修复。33路径根采用，三处冻结安装、原run.sh九模块、GUI和严格类型通过；Owner独立6次真实Driver→Worker→IDE调用与释放通过。当前使用明确临时修复，原生资格限darwin-arm64；正式发布未包含，历史失败保留 | [最终验收与G0–G7映射](SRT/SRT-06_TOOLCHAIN_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)、[3.1](#driver-dependency)、[B决策](MINIMAL_CORE/MINIMAL_CORE_RUNTIME_DRIVER_DECISION_2026-11-07.zh-CN.md) |
| SRT-07 | 正文与元数据分离、唯一包装 | 完整联合交付已APPROVED并采用到实际根目录。Runtime唯一外壳/编码、Host解码一次，R1回车保真已关闭；六组标准XML/实际Host逐字符一致，联合Host预览13项通过，根实际解析器与被测产物相同。用户随后提供的本轮页面体验报告已签收，独立工程测试与用户报告分别记录 | [联合验收与根采用](SRT/SRT-02_03_07_COMBINED_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md)、[View独立裁决](MINIMAL_CORE/MINIMAL_CORE_VIEW_PIPELINE_FINAL_REVIEW_2026-11-08.zh-CN.md) |
| SRT-08 | 单 App 声明／投影失败隔离 | 当前隔离候选已获独立APPROVED，无需新代码。已有逐App准备、诊断、碰撞处理和失败清理；Source及真实Registry/Receiver组合独立42/42通过，覆盖健康App实际调用、失败资源归零与修复恢复。SRT-05及跨包回归保留这些保证；2026-11-08已随Planning根入口采用，最终人工验收未包含 | [3.9](#app-failure-isolation)、[独立核对](MINIMAL_CORE/MINIMAL_CORE_SRT_08_CURRENT_REVIEW_2026-11-08.zh-CN.md) |
| SRT-09 | name/id 专项治理与App元数据单一来源 | 已APPROVED并采用。保留View局部类型展示与view_id.local_ref调用；复用工厂声明及现有生成器，Registry静态发现、注册／Worker身份核对、运行ID和持久化namespace分责；原生工具名限制留在适配入口。缺失明确local源不再回退。字段路径／数据作用域／基础类型仍为未来TODO | [最终完整验收](SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)、[3.2](#identity-governance)、[3.3](#public-tool-names) |
| SRT-10 | 错误／结果模型与初始化诊断 | 已APPROVED并采用。INIT/OPEN本地诊断保留，ToolResult改为成功／失败判别联合及JSON错误记录，复用既有捕获和IPC边界；none／partial／unknown与未进入handler的区别保持，非法结果后不自动重试。生产消费者、类型负例及真实Worker六种结果已验证 | [最终完整验收](SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)、[4.1](#result-errors) |
| SRT-11 | 重复转换、Schema 编译、复制与缓存 | 已APPROVED并采用。沿用测量支持的recheck减法和236项独立验证；补齐时钟10→9拒绝→10恢复观察及调用、关闭后scope／lease／bytes归零检查。关联MC R4注册合同复用及Worker逐调用编译退出也已批准并采用。没有无据缓存或普遍提速承诺 | [最终完整验收](SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)、[MC最后增量采用](SRT/MC_PLAN_CLOSURE_OWNER_ADOPTION_2026-11-09.zh-CN.md)、[既有测量验收](MINIMAL_CORE/MINIMAL_CORE_SRT11_REVIEW_2026-11-09.zh-CN.md)、[4.7](#conversion-performance) |
| SRT-12 | 文档单一事实来源与可执行示例 | 已APPROVED并采用。已有24路径作者交付有效；最终元数据／结果／协议变化已同步指南、示例、迁移、App Builder skill及唯一索引，Driver说明已改为SRT-06精确补丁支持范围。示例通过实际安装包编译和运行 | [最终完整验收](SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)、[5.1](#documentation-governance) |
| SRT-13 | 协议清单与兼容矩阵 | 已APPROVED并采用。常量按Runtime SPI／Core合同归属复用，包版本与独立协议分开；工厂／端口v4，Snapshot仍3，INIT要求app-snapshot/v3，ACK必须包含请求的全部能力；九类清单、匹配组合与旧组合拒绝规则一致 | [最终完整验收](SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)、[3.5](#protocol-compatibility) |
| SRT-14 | 正式包消费者与两种 Producer 契约验证 | 已APPROVED并采用。新合同实际四包安装、完整Driver严格声明、文档／普通TS／Preact、Tool／Ref调用和资源释放通过。既有新作者一次构建、0修复／0私有API的限定评测直接复用，不外推普遍作者成功率 | [最终完整验收](SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)、[作者验收](MINIMAL_CORE/MINIMAL_CORE_SRT14_AUTHOR_REVIEW_2026-11-09.zh-CN.md)、[5.2](#consumer-validation) |
| SRT-15 | Breaking Change 迁移与旧路径退出 | 已APPROVED并采用。旧SnapshotTool及历史入口、作者迁移、原20路径减法有效；MC19路径与14路径清理已采用。本轮进一步删除作者协议旧包装、发现回退及facades纯转导出，完成配置／导出／测试／包消费者迁移。没有长期双轨或新增人工审批 | [最终完整验收](SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)、[MC升级后采用](SRT/SRT-15_POST_UPGRADE_OWNER_ADOPTION_2026-11-09.zh-CN.md)、[MC内核减法采用](SRT/SRT-15_KERNEL_CLEANUP_OWNER_ADOPTION_2026-11-09.zh-CN.md)、[5.3](#breaking-change) |
| MC-HOST-PREVIEW-01 | Host 首次 TUI 预览未跟上已提交数据 | 2026-11-09 r02完整独立APPROVED并采用根七路径，本项工程交付关闭。首轮回收重激活、无关Topic空闲时间、部分订阅失败清理三项阻断全部关闭；77维护项+3原反例独立通过，根Host main/preload与GUI构建通过。SRT-11采用保持；真实Electron/用户GUI体验未在本轮重验，历史事故与签收保留 | [最终独立验收](MINIMAL_CORE/MINIMAL_CORE_HOST_PREVIEW_FINAL_REVIEW_2026-11-09.zh-CN.md)、[根采用](SRT/MC-HOST-PREVIEW-01_OWNER_ADOPTION_2026-11-09.zh-CN.md)、[首轮裁决](MINIMAL_CORE/MINIMAL_CORE_HOST_PREVIEW_REVIEW_2026-11-09.zh-CN.md) |
| DEFER-01 | 并发 Tool Call／并发观察 | 暂缓，只做串行主链 | [3.8](#serial-observation) |
| DEFER-02 | 有界资源、预算、配额与整体回收策略 | 暂缓，保留现有保护，不影响必要的生命周期正确性 | [3.10](#resource-bounds) |

此前确认的 [collapse/expand 方向](#view-collapse)、[CLI 双轨实验](#cli-experiment)和[生命周期统一方向](#app-lifecycle)仍保留；具体行为／注册方式待确认，本次不新增实施排期。

---

# 0. 术语与阅读规则

| 术语 | 本文含义 |
|---|---|
| Projection | 应用已提交状态的投影，不是修改 Agent 记忆或任意 Messages CRUD |
| View / ViewType | 当前页面实例 / 页面类型；同类型实例共享一组 Tool |
| Snapshot / Observation | 应用已提交的状态快照 / 某次正式观察获得的内容及调用来源；二者不是同一生命周期 |
| Ref / ArrayRef | 快照中的具名数据引用 / 对整个数组及数组元素的引用能力；不是权限，不是另一类 Tool |
| Ref 参数 | 模型传引用名，Runtime 从绑定且有效的 Observation 解析数据，handler 接收不可变值 |
| Scope / Binding | 可信集成下的观察与调用范围 / 调用与所观察工具来源的关联 |
| Receipt | 操作结果与必要提示；主要业务数据通过 View 呈现 |

2026-11-08 根目录已完成 SRT-02：Ref／ArrayRef 参数统一到 ViewType Tool，独立 `useViewSnapshotTool` 路径已退出。下文保留原评审时点的现状与建议；当前实现与验收以顶部索引及各项最新交付为准，不把历史提议自动视为已实现 API。

---

# 1. 总体判断与职责边界

## 1.1 保留内核保证，不全量推倒，也不冻结现有全部 API

项目值得继续。已有一致提交、观察来源、调用资格和生命周期机制是重要资产；应削减的是同一意思在声明、组件、DOM、注册表和呈现层反复表达，以及作者必须手工保持它们一致的负担。

| 应保留的机制 | 作用与边界 | 源码依据 |
|---|---|---|
| App + ViewType 共享 Tool，区分逻辑名与实际运行身份 | 十个同类页面共用一套工具；同名重开不让旧资格复活；业务目标仍由 App 校验 | [view-owned-tools.ts](runtime/src/core/tool/view-owned-tools.ts)，mount / registerTypeTool / listTools |
| View／Ref／Tool 一致提交 | 不拼接新版正文、旧引用和另一版工具；不承诺外部业务资源的全局事务 | [store.ts](runtime/src/core/snapshot/store.ts)，accept；[dom-snapshot-producer.ts](runtime/src/worker-runtime/dom-snapshot-producer.ts) |
| Observation 来源绑定与执行前复核 | 不偷偷替换模型当时的观察；可见性、激活、授权与业务条件分别检查 | [scoped-interaction.ts](runtime/src/core/invocation/scoped-interaction.ts)，run / recheck |
| 诚实表达收据与失败事实 | 拒绝、失败、结果未知不同；unknown 不自动重试；业务成功与投影可见不同 | [scoped-interaction-types.ts](runtime/src/core/invocation/scoped-interaction-types.ts)，InvocationOutcome |
| 扁平 View 与明确资源所有权 | 保留当前独立 View 模型；停止准入、回调结束和资源真正释放分开 | [View.tsx](sdk/src/components/View.tsx)；[runtime-shutdown.md](runtime/docs/runtime-shutdown.md) |

“简单”应让作者少理解内部协议，而不是让每个 App 自己防止快照混合、绑定串错和 cleanup 误删。支持必要 Breaking Change，但重构不能丢掉上述保证。

## 1.2 谁负责什么

| 所属层 | 必须承担 | 不因此承担 |
|---|---|---|
| SDK | 声明／类型推导、Ref／ArrayRef 发布、作者诊断、renderer 提交接入、清理注册 | 文件冲突策略、业务权限、通用业务状态机 |
| Runtime 语义内核 | 一致快照、观察来源、Ref 解析、工具资格、结果事实与自有引用生命周期 | 解释文件内容、推断业务对象、业务重试／回滚 |
| 运行与集成适配层 | renderer／Worker 通信、刷新接入、唯一包装、原生 Tool／CLI／Driver 格式转换 | 另建平行的 Tool／Ref／授权语义 |
| App 与宿主各自的资源／策略层 | 业务状态、真实资源、授权政策、条件写入、后台任务和分页 | 弥补框架注册误删、内容损坏或绑定串错 |

**应用必须对业务真相负责，但不应该为框架把数据传错、显示错、清理错负责。**

## 1.3 当前不扩张的范围

并发和有界资源整体重设计暂缓，保留现有保护。不新增 trust/provenance、提示注入防护框架、默认最小权限体系、跨 App 透明安全沙箱、priority/token budget/quota/自动摘要或通用 Messages CRUD；不将文件、LSP、搜索、终端等业务语义塞进内核。已有实验方向不自动变成本轮开发任务。

---

# 2. 概念设计

---

<a id="projection"></a>

## 2.1 Projection，而不是 Messages CRUD

**状态：已确认。**

### 现状

`SemanticAOTUIDrivenSource.getContext()` 每轮从当前 Snapshot 重新生成 View 消息：

- 当前有哪些 View，就生成哪些 User Message；
- 旧 View 不存在了，就不生成；
- 没有 Message ID，没有 edit/delete 历史消息 API；
- 已关闭 View 不再生成，更新 View 只投影当前版本；这不等于删除独立的用户历史或操作收据。

见 [semantic-aotui-driven-source.ts](runtime/src/adapters/semantic-aotui-driven-source.ts#L168)、[view-message.ts](runtime/src/adapters/view-message.ts#L2)。

### 结论

项目所有者明确纠正：这是 **Projection**，不是“修改 Agent 工作记忆”。App 维护业务状态，SDK/Runtime 将已提交的 View、Ref 和当前工具能力投影到上下文；Messages 是呈现结果，不是应用任意操作的业务数据库。

```text
App state
  → View
  → Snapshot
  → Observation
  → projected User Messages
```

保留这个模型，理由：

- 旧快照不会污染当前状态；
- 不需要维护 Message ID、删除标记、排序冲突；
- 应用状态是唯一真相，View 只是投影；
- 不会把用户真实消息和应用数据做原地修改；
- 上下文重建规则可以独立测试。

### 行动项

- 文档和示例统一使用“Projection / 当前状态投影”，不再使用“Agent 编辑 Messages 记忆”。
- 不新增 `updateMessage/deleteMessage` 一类通用 API。
- View 的关闭、重开、替换由 App 状态和 Snapshot 表达；不通过编辑历史消息实现。
- 如果产品需要“View 关闭事件”，作为 View 生命周期/操作回执表达，而不是消息编辑。

---

## 2.2 信任/来源分层：不纳入 SDK/Runtime

**状态：不纳入。**

当前实现中，View 被包装为 User Message，而真实用户消息也是 User Message，见 [semantic-aotui-driven-source.ts](runtime/src/adapters/semantic-aotui-driven-source.ts#L245)、[view-message.ts](runtime/src/adapters/view-message.ts#L17)。这确实会让 App 内容和用户指令在模型看来缺少结构差异。

但根据项目所有者反馈：

- 这属于应用层/Host 的职责；
- 不在 SDK/Runtime 内部增加 `origin`、`trust`、prompt-injection 防护或安全沙箱；
- SDK/Runtime 不替应用判断内容是否可信；
- 如果未来需要多租户或第三方不可信 App，应作为 Host 安全模型单独立项，而不是塞进语义内核。

### 行动项

- 本轮不新增 trust/provenance 字段。
- 不把“Worker isolation 等于安全沙箱”写成框架承诺；安全边界由 Host/应用说明。
- 应用层自行处理内容清洗、提示注入和业务授权。

---

<a id="refs"></a>

## 2.3 Ref 与 ArrayRef：快照中的具名数据引用

**状态：SRT-02完整能力已于2026-11-08随Ref＋View联合交付获APPROVED并采用到实际根目录，见[联合验收与根采用](SRT/SRT-02_03_07_COMBINED_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md)。对象/对象列表/元素、多个/可选Ref及Ref名数组均已实现；根Planning的10个对象工具Ref合同和27次真实调用通过。Driver完整严格声明与最终人工Semantic验收仍另列。下文历史草案的具体API不自动代表当前实现。对应SRT-02、SRT-05。**

以下为此前共享工作树及原评审基线的历史边界，与已签收并于2026-11-08采用到根入口的新版本分开：普通 ViewType Tool 不接受 Ref；`useViewSnapshotTool` 限制为只读、一个必填顶层 Ref，消费 payload 必须是非 null JSON 对象，数组值不被该路径接受。默认 DOM Producer 将 `refType` 写成 `unknown`。`useArrayRef` 已发布整体列表与元素，但“能发布列表”不等于“Tool 已能消费列表”。原问题依据：[snapshot-value-arguments.ts](runtime/src/core/tool/snapshot-value-arguments.ts) L95–133；[dom-snapshot-producer.ts](runtime/src/worker-runtime/dom-snapshot-producer.ts) L66–74；[useArrayRef.ts](sdk/src/hooks/useArrayRef.ts) L63–107。隔离候选的显式类型贯通和正式消费限制以本节后续签收记录及 [2026-11-06 静态核查](SRT/SRT-02_REMAINING_SCOPE_AND_ACCEPTANCE.zh-CN.md)为准。

**Tool 是操作，Ref／ArrayRef 是参数取值方式，不应因此分成两种工具。数据类型不是页面类型，Ref 也不是权限。**

### 2.3.1 Git 历史里的 Ref

本节只依据 SDK 与 Runtime。`2bbfdcea`（`feat: add ref hooks and snapshot bundle`）中的 SDK 已使用两参数 Hook：

```ts
// 2bbfdcea:sdk/src/hooks/useRef.ts
const pinned = useDataRef('messages[0]', message);
pinned('Pinned message'); // [Pinned message](messages[0])
```

同一提交的 SDK 数组接口是 `useArrayRef(refId, data, { itemType })`。因此，这份历史不能支持“SDK 后来从三参数退化为两参数”的判断；能确认的是当前数据发布接口与 Tool 参数能力需要重新贯通。

SDK 侧也有对应的参数类型：

```ts
// 2bbfdcea:sdk/src/operation/types.ts
export type ParamBaseType = "string" | "number" | "boolean" | "object" | "reference";

export interface ParamDef {
  type: ParamType;
  required?: boolean;
  desc?: string;
  refType?: string;
  // ...
}
```

Runtime 的 `AppKernel.resolveTypeToolArgs()` 则在参数定义为 `type: 'reference'` 时，把 LLM 传来的字符串 Ref 解析成对象，再交给 handler。数组写法是 `type: 'array', itemType: 'reference'`，不是字面量 `type: 'reference[]'`。这些是代码静态核对结果，不代表已经运行历史端到端测试。

**与项目所有者此次确认一致的目标语义：**

- 展示使用 `[DataDesc](DataType:RefName)`，完整名字作为参数；格式及调用说明已由 B23 对齐实际 Markdown 输出，不能沿用早期反写示例；
- `RefName` 是应用定义的数据名；
- Tool 参数可以声明 `type: 'reference'`、`refType: 'User'`；
- Runtime 解析 Ref，handler 收到对象；
- Ref 的公开名字不编码 View ID；这不要求 Runtime 删除发布来源、可见性和清理所需的内部 owner 信息。

**历史核对补充（Codex，2026-11-03；仅静态阅读，没有运行历史测试）：**

| 历史证据 | 实际行为 |
| --- | --- |
| `2bbfdcea:sdk/src/hooks/useRef.ts:47` | 两参数 Hook，已经输出 `[desc](refId)`；描述没有消失 |
| `2bbfdcea:sdk/src/hooks/useArrayRef.ts` | 使用 `(refId, data, { itemType })`；格式化列表及列表项，但该 Hook 的注册循环只登记逐项数据，不能仅凭列表 formatter 推断整个数组已经注册 |
| `2bbfdcea:runtime/src/worker-runtime/app-kernel/AppKernel.ts:361` | Runtime 以 `viewId:refId` 保存引用 |
| 同文件 `:704`、`:787` | 先查相同 ViewType 的 View，再按后缀取首个匹配；这段路径没有检查 `def.refType`，也没有绑定调用的 Observation；还接受对象参数并跳过 Ref 查找 |

因此可以恢复带类型的具名引用、字符串参数解析及数组引用的产品能力，但不能照搬旧 Runtime 的后缀查找、重名处理和对象直传分支。当前缺少的 ViewType Tool Ref 参数能力，需要接入已有 Observation 的可见性、固定快照、参数预算和失败反馈合同。

### 2.3.2 Ref 的正确模型

```text
[DataDesc](DataType:RefName)
```

例如：

```text
[The user with the highest spending on November 1st](User:topSpendingUserOnNov1)
```

- `DataDesc`：给 LLM 看的描述；
- `DataType`：业务数据类型，例如 `User`、`Order`；
- `RefName`：应用定义的引用名；
- Agent 把页面给出的完整 `DataType:RefName` 作为 Tool 参数，保留前缀、大小写及下标；
- 属性访问 `RefName.property` 是待评估扩展；
- Runtime 从本次调用绑定的 Observation 解析 Ref。

Ref 适合复杂数据：

```text
Tool: send_coupon(user: User, amount: number)
Call: send_coupon("User:topSpendingUserOnNov1", 20)
```

文件编辑可以直接使用业务路径，不强制使用 Ref：

```text
edit_file(filePath, oldString, newString)
```

是否采用 Ref 由业务接口决定；无论采用哪种参数，都要校验当前业务条件。

**2026-11-06 所有者补充：Ref 应免除模型抄写业务 ID。** Planning 已通过引用呈现的 Plan、Phase、Task，应由描述和完整 Ref 名表达可选择的对象；模型调用时传 Ref，不再另抄 `plan_id`、`phase_id`、`task_id`。内部 ID 留在 App 状态、数据库及 Ref payload 中，由 handler 使用解析后的对象继续执行存在性、归属、当前状态和权限检查。该约束不要求将文件路径等有独立业务含义的普通输入统一改成 Ref。

SRT-02 的应用迁移验收必须同时覆盖 View、参数 Schema、Root 指令和错误恢复说明：模型不依赖内部业务 ID 即可选择并操作页面对象；也不能只删显示文字、保留必填 ID 参数，或把一个 ID 字符串改名成 Ref。错误、过期或属于其他对象的 Ref 仍须按框架合同及 App 业务前置条件拒绝，不允许错误作用于新对象。

**历史与当前候选边界。** [B25 隔离试件](MINIMAL_CORE/MINIMAL_CORE_BATCH_25_GUI_REVIEW.zh-CN.md)只将 `open_plan` 改为一个必填 Plan Ref；其他对象操作仍使用 ID，页面仍显示 ID。该历史链路证据有效且保持冻结。2026-11-06 的新隔离候选已经将全部 10 个对象目标操作迁移为一个必填 Ref，并同步移除 View、Root 和恢复说明中的抄写业务 ID 要求；创建和关闭工具保持普通参数／无参数。SDK 增加 typed 单对象发布和公共 `refParam(refType, valueSchema)` 薄入口，Runtime 固定 B23 原包。15 项应用测试和 27 次真实 Worker 调用已通过，并由 Minimal Core Owner 独立重编译复跑；SDK 与 App 精确候选均获 [独立 APPROVED](MINIMAL_CORE/MINIMAL_CORE_TYPED_REF_AND_PLANNING_REVIEW_2026-11-06.zh-CN.md)。其后受控 GUI 的创建、Task Ref 修改、Phase Ref 新增、关闭和 Plan Ref 重开也获 [独立 APPROVED](MINIMAL_CORE/MINIMAL_CORE_PLANNING_REF_GUI_REVIEW_2026-11-06.zh-CN.md)，页面结果经 Chat/TUI 切换观察；MC-HOST-PREVIEW-01 仍 OPEN。独立手测入口 `.tmp/planning-ref-manual-20261106/launch.sh` 已准备 DeepSeek 配置和空状态，交接后未自动运行真实模型。这不等于 SRT-02 整体完成、共享主线采用或项目所有者最终验收。

**2026-11-06 已实施的隔离候选合同。** `update_plan` / `delete_plan` 改用一个必填 Plan Ref，明确移除“省略目标即使用 activePlan”的旧应用分支；这是应用参数合同的 Breaking Change，不宣称兼容，也不为保留该分支扩大到 optional Ref 内核实现。`create_plan` 保持普通创建字段，`close_plan` 保留应用明确的单活动计划关闭语义；其他现有对象操作按一个必填目标 Ref 加普通编辑字段收敛。Phase/Task 与当前 Plan 的归属和状态检查仍由 App 承担。此边界不等于正式发布 SDK API 或改变冻结 B25 试件。

### 2.3.3 参数能力与候选 API：发布、展示、调用解析

**以下更完整的 `refType`／`refParam` 及 Hook options 是设计候选，不是已发布 API。** 2026-11-06 的最小隔离候选只实现 `useDataRef(id, value, { refType: 'Plan' })` 与 `refParam('Plan', valueSchema)`；下文 `refType(...)` 描述符、`{ type: descriptor }` 和更广参数组合尚未实现，不能把同名 helper 的不同签名混为一谈。先满足单一声明与数据能力约束，再确定后续语法；不以示例锁定实现。

已核对历史 SDK 是两参数 `useDataRef(refId, data)`；此前三参数原型不是当前 SDK 历史。候选方案保留 `(refId, data)` 的相对顺序，以 options 增加类型描述；最终签名仍待设计。

#### 类型描述符

```ts
// 只声明一次
const UserRef = refType<User>('User');
```

或者由 Schema 推导 TypeScript 类型：

```ts
const UserRef = refType('User', UserSchema);
```

规则：

- `refType<User>('User')` 只提供静态类型；运行时只有 `User` 标签和基础 JSON 合同。
- `refType('User', UserSchema)` 由 Schema 推导 TypeScript 类型，避免 `User` 与 `UserSchema` 各自修改后不一致。
- 不要同时写泛型和 Schema。
- `UserRef` 是轻量共享声明；Runtime 接收可序列化标签和必要 Schema，不建立全局业务类型注册中心，也不比较描述符对象的内存地址。

#### View 发布

```tsx
const topSpender = useDataRef(
  'topSpendingUserOnNov1',
  user,
  { type: UserRef },
);

return (
  <p>
    {topSpender('The user with the highest spending on November 1st')}
  </p>
);
```

渲染：

```text
[The user with the highest spending on November 1st](User:topSpendingUserOnNov1)
```

- 保持现有 `refId, data` 的相对顺序，候选方案通过 options 增加类型描述；
- 描述继续由 formatter 提供，不增加必须同步维护的 `options.description`；
- `type: UserRef` 让 SDK 在编译期检查发布的数据类型；
- 如果 `UserRef` 带 Schema，发布时做一次数据校验；
- 数组沿用 `useArrayRef('users', users, { itemType: UserRef })`，把类型信息真正发布到 RefDescriptor。

#### Tool 参数

继续使用现有 TypeBox `inputSchema`，不新增 `toolInput` 包装：

```ts
defineViewTypeTool({
  viewType: 'Coupon',
  name: 'send_coupon',
  description: 'Send a coupon to a referenced user.',
  inputSchema: Type.Object({
    user: refParam(UserRef),
    amount: Type.Number(),
  }),
  async execute({ user, amount }) {
    // user: DeepReadonly<User>
    // 应用检查业务条件并执行操作，结果数据通过 View 呈现
  },
});
```

需要明确区分两种类型：

- **模型输入**：`user` 是引用名字字符串；
- **handler 输入**：`user` 是解析后的不可变数据。

这要求 SDK 修改现有参数类型推导：`Type.Object` 中的 `refParam(UserRef)` 在模型侧是 string，在 handler 侧是 User。Runtime 的参数准备过程也要识别 Ref 字段。

首版需覆盖的数据与组合能力（以下用候选 `refParam` 语法说明）：

- `refParam(UserRef)`：一个完整对象 Ref；
- `refParam(UserRef, { array: true })`：一个列表 Ref，handler 得到 `readonly User[]`；
- `Type.Array(refParam(UserRef))`：多个对象 Ref，逐个解析；
- `Type.Optional(refParam(UserRef))`：可选 Ref；没传就不解析，传了无效 Ref 就报错，不能把解析失败当成“缺省”；
- 多个 Ref 参数可以同时存在；
- 首版不支持 `RefName.property` 属性路径。

### 2.3.4 Runtime 的参数准备

一次 Tool 调用：

1. 确认本次调用绑定的 Observation 仍有效；
2. 对每个 Ref 参数，按**完整 RefName** 在该 Observation 的 Ref 表中查找；
3. 校验 `DataType` 与 `refType` 一致；
4. 校验 payload 是基础 JSON 合同；
5. 沿用现有有界参数检查，不借此次迁移重设计资源额度；
6. 执行现有授权检查，见 [scoped-interaction.ts](runtime/src/core/invocation/scoped-interaction.ts#L297)；
7. 把不可变数据交给 handler。

如果参数是 `Type.Optional` 且没有传，跳过解析；如果传了字符串但找不到/类型不符，返回明确错误，不当作缺省。

首版错误建议：

```text
REF_NOT_FOUND
REF_TYPE_MISMATCH
REF_VALUE_INVALID
REF_DUPLICATE
REF_BUDGET_EXCEEDED
```

不接受模型直接提交对象来绕过引用解析。Ref 字段必须传引用名字字符串。

#### 类型标签与运行时校验边界

- `refType<User>` 的泛型运行时消失，只帮助应用代码做静态检查；
- Runtime 检查 `User` 标签、基础 JSON 合同和预算，不承诺完整 User 字段校验；
- 如果提供 Schema，数据在进入框架管理的不可变 Snapshot 时完成一次校验；之后复用同一份已验证数据，不必每次调用重复遍历相同 payload；
- 消费方提出不同约束时，才需要额外检查。

#### 读与写

“Ref 只读”只表示 **handler 不能修改捕获的快照数据**。使用 Ref 的 Tool 可以执行业务写操作：

- `send_coupon(user: User)` 可以发券；
- `update_order(order: Order)` 可以更新订单；
- 快照对象不可变，业务状态变化通过 App 状态和 View 发布。

不能因为 Ref 参数恢复，就重新引入旧 Ref Tool 的“只读 Tool”限制。

#### Runtime 职责边界

| 层 | 职责 |
| --- | --- |
| SDK | 声明与类型推导、发布接口、展示格式、开发诊断 |
| Runtime | 从绑定 Observation 解析；框架访问范围/授权检查；类型、数据结构和参数预算；快照与资源生命周期 |
| App/Host | 业务权限、对象当前状态、业务操作是否允许 |

### 2.3.5 名字、发布与生命周期

RefName 是应用定义的完整数据名，不是 View ID 或永久对象身份。必须明确查找与唯一性范围；当前建议 App 内唯一，不做跨 App 解析，最终命名合同纳入 [3.2](#identity-governance)。同一命名空间内，同一发布者可更新自己的值，不同发布者重名应拒绝；公开名字不必编码 View ID，内部仍保留发布来源和清理所有权。

有效 Observation 内，Ref 总是解析为该次快照的值；新 Observation 接替旧观察后，旧调用及 Ref 解析资格失效。新观察可以重新发布同名 Ref，但不会复活旧资格。具体切换与释放规则唯一维护在 [3.8](#serial-observation)。

ArrayRef 同时支持整体列表和元素引用。`messages[0]` 可以是一个完整的已发布 RefName，表示那次观察中的位置；不因此强制使用业务 key，也不自动启用属性路径解析。稳定业务 key 可在有需求时扩展。

View 卸载后停止向新快照发布对应 Ref；是否还能执行旧调用，要同时遵守观察、工具资格和业务检查，不能只靠 TTL 判断。注册所有权缺陷与修复边界见 [4.6](#ref-ownership)。

### 2.3.6 删除 `useViewSnapshotTool`

`useViewSnapshotTool` 是后来引入的独立 Ref Tool 包装：

- 绑定具体 View 实例；
- 只读；
- 只能一个必填 Ref；
- 使用 `snapshot-value-v2` 独立模式；
- 需要 target selector。

它应删除，Ref 参数改由 ViewType Tool 承担，并接入统一调用链。

删除范围：

- `useViewSnapshotTool` 及 `SnapshotValueTool*` 类型、测试、文档、包消费脚本导入；
- View-instance Tool 注册/执行、target selector、多 binding；
- `snapshot-value-v2` 独立 interaction mode；
- `view-tool-ref-invoke/v3` 等独立 Ref Tool 协议。

保留并改造：

- `useDataRef` / `useArrayRef` 的 Ref 发布；
- `RefDescriptor` / `refType` / Ref payload；
- `Observation.refs` / `ScopePolicy` 的 Ref grants；
- Ref 解析逻辑，接入 ViewType Tool 的 `reference` 参数准备。

此前历史核对确认当时的 HEAD 中存在 Snapshot Ref 合同、测试、文档和公开消费者；不能因某个拆出的 Hook 未跟踪就判定能力只是实验。删除 `useViewSnapshotTool` 是有消费者的公共合同变更，依据是产品方向，必须同步迁移文档、测试和包消费脚本。

### 2.3.7 应用层负责业务目标校验

文件编辑可以使用 `filePath`；Ref 也可以携带业务标识，但不会替代业务校验。以下是统一后的职责合同，不代表当前普通 Tool 已具备 Ref 参数能力。

Runtime 只保证：

- Ref 属于本次调用绑定的 Observation；
- 类型标签匹配；
- Tool binding/activation 未失效；
- Ref 可解析；
- 框架的执行授权检查通过；App 仍在 handler 或资源边界检查业务权限。

App 仍然负责：

- 数据当前是否仍有效；
- 业务对象是否允许操作；
- 副作用和恢复。

### 2.3.8 首版边界与后续扩展

首版的数据与组合能力见 2.3.3；旧路径退出范围见 2.3.6。不因简化包装而削弱列表、元素、多个或可选 Ref。

首版不做：

- `RefName.property` 属性路径；
- 稳定业务 key 强制要求；
- 跨 App Ref；
- 属性路径的命名空间/转义规则。

属性路径后续真正困难的不只是安全，还有“名字解释规则”：

```text
messages[0]
```

它可能是：

1. 一个完整 Ref 名字；
2. `messages` 数组 Ref 的第 0 项。

“先找完整名字，找不到再解析路径”会让新增 Ref 改变旧表达式的含义。因此属性路径必须单独设计 RefName/路径分界、转义和旧名字保持原义，不能顺手加一个 `eval` 或“最长前缀”猜测。

### 2.3.9 仍需定稿的接口细节

这里保留更广方案的待定项。现有 `refParam(refType, valueSchema)` 和 typed `useDataRef` 的最小入口已在隔离候选实现；新增描述符不是下一批整列表工作的前置，也不因本文列出而获准实施。

1. `refType` 重载签名：`refType<User>('User')` 与 `refType('User', UserSchema)` 的最终形式。
2. `refParam(UserRef)` 的 TypeBox 表达方式；`refParam(UserRef, { array: true })` 与 `Type.Array(refParam(UserRef))` 的 API 细节。
3. 单对象的模型 string／handler payload 类型推导已经实现；整列表及其他组合仍须与正式运行合同逐项验证。
4. RefName 唯一性范围：App 内还是整个 Desktop；建议 App 内，冲突报错。
5. `useArrayRef` 的 itemType 选项与新类型描述符的关系。
6. 可选／多个 Ref 的错误表达及现有参数限制如何沿用；不重设计整体资源预算。

### 2.3.10 2026-11-06 剩余范围收口

**当前结论（2026-11-07）：** 旧 Snapshot Tool 的 Group A 隔离清理已获[独立限定实现 APPROVED](MINIMAL_CORE/MINIMAL_CORE_SRT_02_RETIREMENT_REVIEW_2026-11-07.zh-CN.md)，完整准出仍为 CHANGES_REQUESTED。精确补丁 `7bf92c2e84d8ea0964131482bbfe4d12760069daa617a1ca0357ed950cb68693` 从冻结 r05 重放后，412 份源码与清单逐项一致；8 个旧生产文件删除、26 个裁剪、2 个保留项未改，生产净减 1594 行。59 个原测试文件均保留，529 个真实旧 case family 的处置已核对；17 份当前文档及精确 Core 教程已同步迁移。Core 1072／SDK 170／真实 Worker 70 由负责人独立复跑通过，其他边界、Worker、教程、公开 Ref 调用、容量和正常关闭证据见裁决。

上述 Group A 封存时，正常包管理器安装未通过；真实 tar 与本地依赖链接只作为诊断消费者。完整 `strict`、`exactOptionalPropertyTypes:true`、`skipLibCheck:false` 且无 json-schema 路径覆盖时，adapter 在 TS5.3.3／5.9.3 为 42／10 条错误，独立 Driver-only 对照逐项复现，未作为退出豁免。其后所有者已选 SRT-06 的 B：独立薄适配包；新候选已完成迁移及两组正常安装，完整集成类型仍有同图 Driver-only 复现的 51／8 条错误，具体新输入与状态见 [3.1](#driver-dependency)，不追溯修改 Group A 裁决。共享采用、整体 Legacy 下线、最终 Semantic 验收及 SRT-05 均未由本次批准覆盖。[最终机器裁决](review-evidence/srt-02-retirement-candidate-20261107/owner-review/final-signoff.json)与[封存交付](review-evidence/srt-02-retirement-candidate-20261107/delivery-r02/DELIVERY.zh-CN.md)保留完整证据。

**以下为逐批历史记录；其中“未获准生产删除”等描述适用于当时批次，当前进度以上述最终裁决为准。**

SRT Owner 已从精确 SDK／B23 Runtime／Planning 包完成静态核对，并确认 B24 列出的 600 项共享源码／配置和 31 项消费者输入均未漂移。现有 formal profile 与参数准备都拒绝列表载荷；多 Ref 还涉及累积解析，可选 Ref 涉及缺席语义，不能只删除声明限制。具体位置、旧入口消费者及下一批门禁统一见 [SRT-02 剩余范围与验收任务包](SRT/SRT-02_REMAINING_SCOPE_AND_ACCEPTANCE.zh-CN.md)。

下一批先贯通一个必填顶层对象列表 Ref，复用现有 `refParam('Task', Type.Array(TaskSchema))` 和 `useArrayRef`。**2026-11-07 已获[独立范围 APPROVED](MINIMAL_CORE/MINIMAL_CORE_SRT_02_LIST_SCOPE_REVIEW_2026-11-07.zh-CN.md)，仅签收任务与验收条件，没有新实现或新行为测试通过。** SRT Owner 已在新目录重建基线，新编译 SDK 76 件／Runtime 372 件 dist 与签收包逐字一致；[原入口已获准运行](MINIMAL_CORE/MINIMAL_CORE_SRT_02_LIST_ENTRY_REVIEW_2026-11-07.zh-CN.md)，但首次探针把 SDK capture 与正式注册混同，Node exit 1，属于消费者断言错误，不能作为产品回归或整列表已支持的证据。[纠正裁决](MINIMAL_CORE/MINIMAL_CORE_SRT_02_LIST_BASELINE_REVIEW_2026-11-07.zh-CN.md)要求保留原版并分层验证；[attempt-02 已获独立基线签收](MINIMAL_CORE/MINIMAL_CORE_SRT_02_LIST_BASELINE_REVIEW_02_2026-11-07.zh-CN.md)：六捕获／一注册通过／五明确拒绝，六 Worker 调用两次业务进入，关闭完成。当前在全新候选实施一个必填对象列表 Ref，生产逻辑仅两处 Runtime；28 Core、91 SDK、273 Runtime 回归及 TS 5.3.3／5.9.3 严格类型检查通过。四个历史容量 fixture 失败在未改 B23 同样复现，修正测试使用的正式 profile 后原边界断言通过，原失败保留。完整列表 Worker 四包组合现已通过：56 次入口调用、22 次实际进入业务、34 次框架派发前拒绝；另有普通 TS Producer 对照、9 项 V4 适配器变异。精确六文件 patch、包、所有失败与修订已经封存于[本批交付](review-evidence/srt-02-list-ref-candidate-20261107/REPORT.zh-CN.md)，现已获[独立实现 APPROVED](MINIMAL_CORE/MINIMAL_CORE_SRT_02_LIST_IMPLEMENTATION_REVIEW_2026-11-07.zh-CN.md)，限定该精确隔离候选。终审核对并独立复跑了 Core、类型、16 次列表 Worker、普通 TS 与 V4 变异；SDK/Runtime 回归日志另行核对。tar 相比原 tar 恢复了源码 prepublishOnly/pnpm.overrides，含本地 link 路径；[元数据增补](review-evidence/srt-02-list-ref-candidate-20261107/PACKAGE_METADATA_ADDENDUM.zh-CN.md)明确普通包管理器安装与正式采用尚未验证。[旧 Snapshot Tool 收尾范围](SRT/SRT-02_SNAPSHOT_TOOL_RETIREMENT_SCOPE.zh-CN.md)已获[独立限定批准](MINIMAL_CORE/MINIMAL_CORE_SRT_02_RETIREMENT_SCOPE_REVIEW_2026-11-07.zh-CN.md)：418 个冻结源文件及 Planning 63 文件身份核对一致；只准八个消费者／测试文件的隔离迁移准备，不准生产删除。现已形成 [PREPARATION_READY_FOR_REVIEW](review-evidence/srt-02-consumer-migration-r02-20261107/REPORT.zh-CN.md)：八文件 patch 静态重放 418/418 一致，原 295 个运行断言模板与 24 个类型负向逐项映射，包和其余 410 个源文件未变，r01 发现两处 Host 存储 config 隔离缺口后在执行前撤回，原件保留；r02 在原八文件范围补配置和清理顺序，全部断言文本保留。[r02 新入口获准](MINIMAL_CORE/MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_ENTRY_REVIEW_R02_2026-11-07.zh-CN.md)后首次运行 70 测试为 42 pass／28 fail，首命令 exit1 后未执行其余四步。r02 当时为 CHANGES_REQUESTED；[失败与限定修订提案](review-evidence/srt-02-consumer-migration-r02-20261107/DIAGNOSIS_AND_REPAIR_SCOPE.zh-CN.md)区分迁移接线问题与尚待验证的假设，也明确两个 R11 cleanup 缺失和 plain 工厂返回前失败，不能把外围进程组结束当作生命周期已完成。获准的无 Worker 声明诊断已退出 0，确认公开声明规范化可被严格 Core 接受，typed useDataRef 确实拒绝数组；[r03 修复准备](review-evidence/srt-02-consumer-migration-r03-20261107/REPORT.zh-CN.md)保持原 347／26 断言表达式、增加 5 个证明模板，仅在原范围内改七文件。View 保持、schema 与 activation 一起替换的差异明确记录。[r03 五步入口获准](MINIMAL_CORE/MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_ENTRY_REVIEW_R03_2026-11-07.zh-CN.md)后，首步 70/70 通过，Minimal Core Owner 独立重跑也是 70/70；Ref 39、scoped 17、dual plain／sdk-worker 各 12 条清理记录结清，这些是记录数而非不同 Worker 数。第二步公共消费者通过 TS 5.9.3 Core／SDK 类型入口后，在 adapter 因 TS7016 缺 json-schema 声明停止，公共调用链和后三步 TS 5.3.3 未执行。[r04 限定修正准备](review-evidence/srt-02-consumer-migration-r04-20261107/REPORT.zh-CN.md)只改 w10 生成配置的 typeRoots，并把现有完整 @types/json-schema@7.0.15 链接到新消费者；417 其他源文件、495 包文件、全部 352／26 断言表达式不变，严格检查不放宽。70 项复用已复核的 r03 证据。[r04 四步入口获准](MINIMAL_CORE/MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_ENTRY_REVIEW_R04_2026-11-07.zh-CN.md)后仍在相同 adapter TS7016 失败；17 项输出与输入身份已核对，公共 App 尚未生成，后三步未执行，零外围强杀。仅 typeRoots 足够的静态推断已被实际结果否定。Minimal Core Owner 的实际 trace 确认 NodeNext 成功解析 JS 后不会进入 typeRoots 后备；精确 paths 到完整 @types/json-schema 声明后 TS5.9 --noEmit 退出 0，TS5.3 则暴露 36 条 NoInfer／泛型 Uint8Array 错误。只导入冻结 Driver 的 ESM 对照未加载项目 SDK／Runtime 声明，仍逐项复现相同 36 条；归因与原失败记录见[独立诊断审计](review-evidence/srt-02-consumer-migration-r04-20261107/owner-review/run-and-type-diagnostic-review.json)。[r05 准备](review-evidence/srt-02-consumer-migration-r05-20261107/REPORT.zh-CN.md)仅替换一行 paths、保留四步；[获准](MINIMAL_CORE/MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_ENTRY_REVIEW_R05_2026-11-07.zh-CN.md)后 exit codes 为 0／0／0／2。公共链 4 次调用为 3 成功、1 FILE_NOT_OPEN App guard 拒绝，实际 4 次 handler、1 次 guard、1 次业务写入；两次 Ref payload 冻结，最新 View 替换旧正文、Tool 仅短收据。Runtime 正常关闭报告资源结清，TS5.9 三入口与 TS5.3 Core／SDK 通过；TS5.3 adapter 的 36 错与 Driver-only 对照逐项一致。32 项输出与输入身份已核对，见[实际交付](review-evidence/srt-02-consumer-migration-r05-20261107/DELIVERY.zh-CN.md)。[独立终审](MINIMAL_CORE/MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_REVIEW_2026-11-07.zh-CN.md)已签收隔离消费者迁移行为；负责人又实际重跑三个 TS5.9 入口和公共四调用、最新 View、短收据与正常 Runtime 关闭，19 项输出核对完成。TS5.3 Core／SDK 仅核对执行方原始结果，不冒称另重跑。完整退出仍 CHANGES_REQUESTED；最低 TS 版本、第三方依赖及完整类型门禁没有改变。[退出范围 r02](review-evidence/srt-02-retirement-scope-r02-20261107/RETIREMENT_SCOPE.zh-CN.md)重新核对固定 418 源／495 包，把原35生产影响面分为8删除提案、25旧分支裁剪提案和2保留项，补齐59测试审查输入、17当前文档/3教程、27旧产物以及具名外部消费者义务；现已获[独立只读范围批准](MINIMAL_CORE/MINIMAL_CORE_SRT_02_RETIREMENT_SCOPE_REVIEW_R02_2026-11-07.zh-CN.md)：负责人核对14件提交、418固定源、128具名输入、1187行引用和27旧包产物，未发现漂移；这些是静态核对数，不是新增测试。生产删除尚未批准，范围包保持冻结，先完成SRT-06具体迁移落点与文件交集顺序。D1 原未获准 Ref 负向保留，另加明确跨 View 正向；D2 单对象关闭可能从派发前拒绝变为 App guard 拒绝，明确列为语义差异，不视作原框架保证等价。原包 Core 公开文档仍使用旧 API，本轮 ref-only 不编译或执行；删除旧入口前须另批同步迁移。后续生产退出仍需独立裁决；多 Ref、可选与多选 TODO 保留，不据参数形状对称直接扩展。释放 Context 后临时 lease/交互归零，但 Store 仍按既有策略保留一个当前及五个历史快照；这不代表 SRT-05 已完成。SRT-05、Host 预览、共享采用与整体 Legacy 退出分别保持原边界。

---

<a id="view-collapse"></a>

## 2.4 View 投影的 collapse/expand

**状态：此前方向已确认；行为合同、API 和排期待定，本次不新增实施任务。**

### 2.4.1 不做 priority / budget / quota

项目所有者明确：

- 出现的 View 就是 focus；
- 暂不考虑 priority、token budget、quota、自动 summary；
- 不做 Source 级自动选择策略。

因此删除原评审中的以下建议：

- `View.priority`
- `View.visibility: full/summary/hidden`
- Source 的 `selection/budget`
- 自动业务摘要

### 2.4.2 新增系统级 collapse/expand

唯一新增的上下文收缩机制：Agent 可以主动 collapse 一个 View，并输入简短 summary；需要时再 expand。

这不是自动摘要或优先级系统，而是 Agent 对当前应用投影的显式呈现控制，不改写用户历史。

#### 工具

建议命名为：

```text
system-collapse_view
system-expand_view
```

与现有 `system-open_app`、`system-close_app` 保持同一 `system-*` 命名空间。

#### 输入

```ts
// collapse
{
  app_id: string;
  view_id: string;
  summary: string;
}

// expand
{
  app_id: string;
  view_id: string;
}
```

需要 `app_id` 是因为 `view_id` 只在 App 内唯一。

#### 行为

- `system-collapse_view`：
  - 目标必须是本次调用绑定的 Observation 中存在的、未 collapse 的 View；
  - `summary` 必须非空，长度有界（建议 1–512 字符）；
  - 记录 collapse 状态，以及该 View 的 `appId + viewInstanceId`；
  - 返回回执，不返回 View 内容。

- `system-expand_view`：
  - 目标必须是当前 collapse 集合中的 View；
  - 移除 collapse 状态；
  - 下一次 `getContext()` 恢复完整 View 内容。

#### 投影

Collapse 后，该 View 不再生成完整 View 消息，而是生成一个**折叠标记**，例如：

```text
<collapsed-view id="fd_2" type="FileDetail" name="File: b.txt" app_id="..." app_name="...">
Summary: Agent 输入的简短摘要
</collapsed-view>
```

具体 XML 名称可以再定，但语义必须是：

- 它不是完整 View；
- 它保留 App/View 身份和 Agent 写的 summary；
- 它提示 Agent 使用 `system-expand_view` 恢复。

不建议复用 `<view>` 的完整外壳，避免模型误以为内容仍然完整。

#### Tool 处理：建议先采用 presentation-only，待单独确认

这是需要明确选择的部分。三种方案：

**方案 A：collapse 只影响呈现，不影响 Tool（推荐第一阶段）**

- Tool 与 Ref 标识的可见性、ViewType activation、Ref 参数解析资格保持不变；
- collapse 只把完整 View 内容替换成 summary 标记；
- Agent 仍可调用 `edit_file` 或其他 Tool，包括指向 collapsed 对象；
- App 不知道 collapse 状态，继续按业务规则检查对象；
- collapse 不是授权/执行边界，只是上下文压缩；
- 优点：简单、无新执行语义、无 App 耦合；
- 缺点：Agent 可能对看不到内容的对象执行操作，需要自行承担判断，App 仍做业务校验。

**方案 B：collapse 同时暂停对象操作**

- collapsed View 的 Ref 从模型可见列表中移除；
- 使用 collapsed View 的 Ref 参数调用被拒绝；
- 对于 ViewType Tool，需要额外的 per-instance 执行约束，或要求所有对象操作都通过 Ref；
- 这会把 collapse 变成执行语义，Source/App 需要共享 collapse 状态；
- 复杂度高，暂不建议。

**方案 C：某 ViewType 全部 collapsed 时隐藏该类型 Tool**

- 混合场景下不一致：a.txt 展开、b.txt 折叠时，`edit_file` 仍存在，仍可编辑 b.txt；
- 无法真正实现“折叠即不可操作”；
- 不建议。

**候选方案推荐 A，尚未确认采用。**
文档必须诚实表达：collapse 是上下文管理，不是权限/执行边界。若后续需要 B，再单独设计。

#### Observation 阶段

当前 Source 先 `observe({ all: true })`，成功后才生成 Messages。如果只在生成 Messages 时折叠正文，完整 Observation 可能已经因超过 256 KiB 而失败。

因此，collapse 需要在**观察投影阶段**生效：

- Source 维护 `[appId, viewInstanceId] -> { summary, collapsedAt }`；
- 在 `ScopePolicy.project` 中，对 collapsed View 设置 `content: 'hide'`；
- 保留 View 元数据、Refs、ToolBindings，因此 Tool 可见性和 Ref 参数解析不受影响（方案 A）；
- 这样 Observation 不携带折叠 View 的正文，能减少字节；
- 首次打开就超过上限的 View 仍然无法先折叠；这是另一个问题，需要应用分页/缩小 View，或后续讨论“目录视图”。

#### Summary 语义

- Summary 是 **Agent 在 collapse 时写下的摘要**，不是 Runtime 自动生成的业务事实；
- 正文变化后，summary 默认不更新；它是当时写下的摘要，不是当前业务真相；
- 可以后续增加 `changed: true` 或 `summaryAt`，但当前先不做；
- Expand 后以最新 View 内容为准。

#### 状态生命周期

Collapse 状态建议由投影集成层维护；历史候选位置是 `SemanticAOTUIDrivenSource`，去 Driver 依赖后不因此反向塞回 Core：

- Source 已经负责上下文投影和 system controls；
- 折叠呈现本身不另造 Snapshot/Scope 语义；仍遵守新旧观察交接合同；
- 不需要把 Agent 的 summary 写进 App Snapshot；
- 不需要 App 参与。

状态键：

```text
[appId, viewInstanceId] -> { summary, collapsedAt }
```

清理规则：

- View 关闭/卸载：删除对应状态；
- View 重新打开：新 `viewInstanceId`，默认不 collapse；
- App 关闭/重启：删除该 App 的所有 collapse 状态；
- Source 被 disable：清空；
- Context release：保留会话级的折叠呈现状态；不据此保留已失效 Observation 的 Ref 数据。

#### 需要确认的细节

1. Summary 上限：建议 512 字符或 2 KiB。
2. 是否允许更新已 collapse View 的 summary：建议先 expand 再 collapse。
3. Collapse 的 Tool 处理：推荐方案 A（presentation-only）。
4. Collapsed View 内容变化时，是否显示 `changed: true`：后续再加。
5. 首次打开超过 Observation 上限的 View 如何提供可折叠入口：未解决。

---

<a id="sdk-authoring"></a>

## 2.5 SDK authoring：先明确约束，再设计 App Definition / Producer

**状态：SRT-01 的 M4.3 精确候选已通过 G1–G4 本地工程签收，见[最终裁决](.tmp/worktrees/srt-01-owner-verdict-20261106/SRT-01_G3_OWNER_CLOSURE.2026-11-06.zh-CN.md)。下文保留 2026-11-03 的问题依据、约束与方案比较，不作为该候选的当前 API 说明；共享采用、发布和 SRT-14 整体完成须另行核对。**

### 2.5.1 现状与问题

纯 Core 已有不依赖 DOM、Worker 或模型 SDK 的正式入口，见 [core-public-entry.md](runtime/docs/core-public-entry.md)。默认 Worker 却只接受 managed component factory，见 [worker-runtime/index.ts](runtime/src/worker-runtime/index.ts) L323–334。因此不是“完全被 DOM 锁死”，而是好用的作者路径主要服务于 Preact；普通 TypeScript 接入还要装配较多低层合同。

当前 Tool 定义同时包含静态 Schema 与可随组件状态变化的 handler；Hook 计算定义身份、登记工具并维护已提交的 handler。已有处理不能简单删除，但作者仍需配合定义、注册、ToolUI、手写 Root 目录和 hooks 规则。依据：[view-type-tool.ts](sdk/src/tools/view-type-tool.ts) L66–107；[useViewTypeTool.ts](sdk/src/hooks/useViewTypeTool.ts) L80–132。

IDE 的 `ToolRegistration`／`IDEToolUIProvider`／`ToolRef` 展示了作者侧样板成本，见 [ScopedIDEApp.tsx](demo-apps/aotui-ide/src/tui/ScopedIDEApp.tsx) 与 [ide-tool-contracts.ts](demo-apps/aotui-ide/src/tui/ide-tool-contracts.ts)。它们不是将 IDE 业务服务搬进内核的理由。

### 2.5.2 任何方案必须满足的约束

| 约束 | 要求 |
|---|---|
| 一份声明 | Tool 类型归属、名称、参数和说明只手写一次；注册、类型推导、验证和目录复用它 |
| 类型共享 | 同一 App + ViewType 只注册一组 Tool；实例增加不复制工具／Schema |
| 静态与动态分开 | 静态目录说明有哪些能力；当前工具集合说明现在能调用什么；实例 handler 与 enabled 可变化 |
| 数据能力完整 | Ref／ArrayRef 的发布、呈现、类型、解析贯通；普通值与 Ref 值进入同一验证／执行链 |
| 不猜业务 | ToolUI 不授予权限，不隐式选择文件；业务目标通过参数表达，App 校验 |
| 作者只接触必要概念 | 无需手写 activation、binding、Worker 能力协商等内部字段 |
| 同一内核 | Preact 和普通 TypeScript 共用提交、观察、调用与清理语义，不各建一套运行机制 |

静态检查可以要求 Tool 声明的 ViewType 已定义，但**不能要求此刻已经打开该类型的 View**。暂未打开文件是正常状态，不是定义错误。

### 2.5.3 候选实现方向，不锁定签名

可以将工具静态声明、App 实例 handler 绑定、当前启用状态分开，并从声明生成静态工具目录。`useViewTypeTools([...])`、`validateApp()`、声明式 `AppDefinition` 等是可比较的方案，不是已经选定的 API。验证可以覆盖类型归属、Schema、Ref 声明和展示错配；不能声称框架能静态推断所有业务可达性。

应用与 Runtime 的最小关系应是：

```text
应用声明：页面类型、工具与参数合同
应用实例：业务状态与 handlers
Producer：提交当前 Views、Refs、工具启用状态
Preact adapter / 普通 TypeScript：生成同一种提交
```

handler 留在执行端，不放进可传输快照；App 不能通过声明自授 Host 权限。Preact 可以继续默认使用，但不应定义 AOTUI 的核心语义。

### 2.5.4 不扩张的边界与待定项

不新建另一套通用 UI 框架、业务状态机、远程 App 商店／沙箱或 Agent 代码生成运行时。批量注册、handler 绑定方式、AppDefinition 字段和校验入口需比较作者用法后定稿。ToolUI 实现问题见 [4.3](#tool-ui)，静态 instruction 规则见 [3.6](#static-instruction)，App 元数据唯一来源见 [3.2](#identity-governance)。

---

<a id="cli-experiment"></a>

## 2.6 CLI 双轨制

**状态：此前已确认实验方向；配置与默认模式未定，本次未新增实施排期。**

项目所有者决定：

- CLI 和动态 Tool 两种模式都开发；
- 通过配置切换；
- 不是用一个替代另一个，而是双轨实验。

### 2.6.1 共享语义

两种模式应共享：

- 同一份 Tool 声明；
- 同一套 Scope/Observation/Binding；
- 同一套 `ScopeClient.invoke`；
- 同一套业务 handler；
- 同一套应用层校验。

区别只在“模型如何发现和调用”：

```text
Tool 声明
  ├─ Native Tool 前端：JSON Schema + Function Calling
  └─ CLI 前端：命令 + 参数 + help
```

Ref 参数在两种前端中都保留：Native Tool 用 Ref 字符串作为参数，CLI 用同样的 Ref 字符串作为命令参数。Runtime 仍在同一 Observation 中解析 Ref。

### 2.6.2 配置

Host 层面提供模式：

```ts
capabilitySurface: 'native-tools' | 'cli'
```

具体命名可以再定。关键是：

- 这是 Host/Agent 配置，不是 App 业务配置；
- 同一个 App 不因模式不同而重写业务逻辑；
- 两种模式都受 Scope/授权/绑定校验约束；
- CLI 模式不绕过 Observation，不直接调用 Worker。

### 2.6.3 CLI 模式的待解问题

- CLI 如何表达“当前可用的 ViewType/Tool”；
- `--help` 是否由 Source 动态生成；
- CLI 输出如何保持结构化，避免把业务数据塞回 Tool Result；
- CLI 模式下如何表达参数校验和失败 effects；原 `isMutating` 分类已被2026-11-08反馈取消，不再作为后续要求；
- Shell 转义/注入风险由哪一层处理；
- 是否需要为 CLI 单独设计“命令描述符”，还是从 Tool Schema 自动生成。

### 2.6.4 评估指标

双轨实验应比较：

- 任务成功率；
- 上下文 token 成本；
- 模型调用次数/延迟；
- 错误恢复能力；
- 安全/误操作率；
- Agent 生成 App 的代码量；
- CLI 的帮助文本与动态 Tool 描述的可发现性差异。

---

<a id="view-semantics"></a>

## 2.7 ViewType 与页面类别必须明确

**状态（2026-11-08）：SRT-03完整候选已获[独立最终批准](MINIMAL_CORE/MINIMAL_CORE_VIEW_PIPELINE_FINAL_REVIEW_2026-11-08.zh-CN.md)，已通过[联合验收并采用到实际根目录](SRT/SRT-02_03_07_COMBINED_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md)。** SDK明确要求type/kind，Runtime只读根元数据，四App、公开文档及真实消费者同步迁移。下面保留原问题依据，不将其作为新候选的当前行为。

此前评审基线的 `View.tsx` 中 `type` 可省略，默认等于实例 `id`；这项旧行为已由本次显式元数据合同替代。作者写 `<View id="file_1">` 能得到页面，却未必得到预期的 FileDetail 工具。决定能力归属的类型不应由容易遗漏的实例字段推断。

当前 [view-fragment-extractor.ts](runtime/src/worker-runtime/view-fragment-extractor.ts) L14–22 通过自身或后代的 `data-role="application-instruction"` 推断整张 View 的类别。正文结构不应隐式改变 instruction/state 语义。

目标是显式 ViewType 与显式页面类别元数据。可以通过必填字段或共享类型定义表达，但不预设复杂类型系统。静态 instruction 的内容稳定规则另见 [3.6](#static-instruction)。

---

# 3. 系统设计

---

<a id="driver-dependency"></a>

## 3.1 去具体 Driver 依赖，先修边界而不是全面拆包

**当前状态（2026-11-09）：APPROVED／ADOPTED。** 独立薄适配包已采用，SDK／Runtime不依赖具体Driver；本次工具链、原生IDE和实际Host消费已采用到根目录，冻结安装、原运行入口构建及严格类型全部通过。精确临时类型补丁与7.0.2源码回移的来源、darwin-arm64范围、实际调用与关闭证据见[最终裁决](SRT/SRT-06_TOOLCHAIN_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)。本节以下保留此前阶段的输入与裁决，不再作为当前未完成状态。

**历史状态（2026-11-07）：所有者已选择 B：独立薄适配包，允许隔离实施及必要验证。`@aotui/agent-driver-adapter` 的 r02 迁移、Runtime／SDK 独立消费与列明集成运行行为已获 [Minimal Core 独立 APPROVED](MINIMAL_CORE/MINIMAL_CORE_SRT_06_ADAPTER_REVIEW_2026-11-07.zh-CN.md)；共享工作树的生产实现尚未采用。两组仓库外正常安装、Runtime／SDK 无 Driver 的严格类型和运行验证已通过；完整集成的严格类型门禁仍失败。未修改编译器支持政策，没有发布、推送或合并。**

### 2026-11-07 历史基线与候选修正

```text
sdk → runtime → agent-driver-v2
```

Runtime 的纯 Core 不需要模型 SDK，但发布包依赖具体 Driver。直接源码导入集中在 [semantic-aotui-driven-source.ts](runtime/src/adapters/semantic-aotui-driven-source.ts) L2、L8，其中包括运行时 `jsonSchema()` 和 Driver 类型；包依赖分别见 [runtime/package.json](runtime/package.json) 和 [sdk/package.json](sdk/package.json)。

SDK 并非“只需要 Runtime 类型”：它实际调用 `compileOrdinarySchema`，见 [view-type-tool.ts](sdk/src/tools/view-type-tool.ts) L2、L66–77。因此去 Driver 依赖与 SDK/Core 发布单元拆分是两个任务，不能为去依赖复制第二套参数编译器。

**历史消费者兼容实证。** SRT-02 r05 的公共 adapter 在 TS5.9 通过，TS5.3 在冻结 Driver 的 ai／provider-utils／zod 声明中出现 36 条 NoInfer／泛型 Uint8Array 错误；Core／SDK 两版均通过。Driver-only ESM 对照逐项复现同一 36 条，见[独立诊断审计](review-evidence/srt-02-consumer-migration-r04-20261107/owner-review/run-and-type-diagnostic-review.json)。r05 使用了精确 json-schema 声明路径映射，未启用 exactOptionalPropertyTypes，也未验证普通安装，不能扩大该历史通过范围。[公共类型范围复核](MINIMAL_CORE/MINIMAL_CORE_CONSUMER_TYPE_COMPAT_REVIEW_2026-11-07.zh-CN.md)只批准范围与方案准备，不改变最低编译器版本或授权依赖修复。

**Group A 封存门禁（2026-11-07，历史输入）。** 旧路径退出候选启用 `strict`、`exactOptionalPropertyTypes:true`、`skipLibCheck:false`，去掉 json-schema 路径覆盖后，adapter 在 TS5.3.3／5.9.3 分别报告 42／10 条错误；仅导入冻结 Driver 类型的独立对照逐项相同，见[当前比较](review-evidence/srt-02-retirement-candidate-20261107/owner-review/driver-strict-control/comparison.json)。其中两条 json-schema 解析错误属于当前本地依赖装配；正常安装是否相同尚未验证。空隔离缓存下实际 offline npm install 返回 ERESOLVE／preact@undefined，输入不足不能被写成已证实版本冲突，也不能将 tar 解包与依赖链接称为正常安装。完整准出仍 CHANGES_REQUESTED，迁出 Source 不会自动修复 Driver 自身类型问题。

**B 的当前实现与验证。** r01 原 730 份固定输入保留；r02 另列 run.sh／setup.sh 两份输入，联合基线 732 份，累计补丁重放得到相同的 738 份候选。412 份 Group A 原件哈希未变。Source、Driver 专属转换和指令读取迁至独立适配包；Runtime 只公开两个已有中立呈现函数，Driver 生产源码不变，Host 五处生产导入随迁。四包构建、43 项适配器、30 项跨包、Host 编译及 25 项受控测试通过。独立复核指出的根 esbuild 缺声明与当前 Source 文档遗漏已在 r02 修正；根依赖按冻结锁正常安装后重跑跨包 30/30。两个启动脚本补齐 adapter 接线，三个受控替身场景验证调度顺序，未实际启动用户 Host。原封存 Source 单测中一项仍使用已退出的 view-instance 绑定，已经在原封存包复现失败；新候选把它迁为拒绝旧绑定的断言，原失败和变更分别保留，不将其当成旧基线全绿。详见 [r02 交付](review-evidence/srt-06-adapter-package-20261107/delivery-r02/DELIVERY.zh-CN.md)。

最终实际 tar 在 `/private/tmp` 的两个空消费者执行正常 npm install，祖先路径没有项目 node_modules，包文件不是工作区链接；两组 npm ls 均通过。Runtime／SDK 消费者的依赖图没有 Driver／AI SDK；两版 TypeScript 的完整严格检查、精确 Core 教程、Runtime 教程和真实 Worker 两调用／正常关闭通过。完整集成的四次 Ref 调用符合预期，最新 View 与正常释放通过；完整类型门禁仍失败：TS5.3.3 为 51 条（NoInfer、泛型 Uint8Array 与 Tool 约束），TS5.9.3 为 8 条 Tool 约束错误。同图仅导入 Driver 的对照完整诊断相同，且没有加载 Runtime／SDK／适配包声明。本轮解析为 ai 6.0.324、provider-utils 4.0.64、zod 4.6.7，不能把它与旧 42／10 当作同一冻结输入比较；json-schema 正常解析问题在本轮不再出现。

**Driver 类型阻断诊断（2026-11-07，后续新输入）。** 三组新目录正常安装均完成：只固定 Zod 3 为 51／8，AI 6 声明下界组合为 42／8，AI 7 越界负对照为 171／18；均不满足原门禁。两个编译器的同图 Driver-only 与集成完整诊断逐字相同。该[诊断已获独立 APPROVED](MINIMAL_CORE/MINIMAL_CORE_SRT_06_DRIVER_TYPE_DIAGNOSIS_REVIEW_2026-11-07.zh-CN.md)：132 件输入、原 r02 的 28 个引用已核对；负责人独立复跑六次 Driver-only 和六次缩小模型。已明确区分旧编译器缺少 NoInfer／泛型 Uint8Array 与严格可选 Tool 声明冲突。按独立限定准入完成的新物理副本[单点声明实验](review-evidence/srt-06-driver-declaration-probe-20261107/REPORT.zh-CN.md)只改 provider-utils 4.0.64 的 any 分支，运行时 JS 未变；TS5.9 原两个完整入口和新增真实 Tool 正负向均通过，TS5.3 原入口仍有 47 条能力错误，新增负向另保留一条 NoInfer 导致的未拒绝错误。该[限定实验与根因结论已获独立 APPROVED](MINIMAL_CORE/MINIMAL_CORE_SRT_06_DECLARATION_PROBE_REVIEW_2026-11-07.zh-CN.md)：负责人另建物理副本重放唯一 patch，独立复跑原后两编译器三入口，并另去掉五个负向注释确认五个真实类型拒绝。结果只标记为 LOCAL_DECLARATION_EXPERIMENT，不能代替正常发布包通过。原 trial、r02 与原裁决保持封存；原签收两份当前入口文档的后续更新按明确历史副本映射保留，其余 26 引用原路径未变。

**下一条执行指令。** [具体选择与独立上游复现](review-evidence/srt-06-upstream-type-repro-20261107/OWNER_CHOICES.zh-CN.md)已获[独立决策材料 APPROVED](review-evidence/srt-06-upstream-type-repro-20261107/owner-review/REVIEW.zh-CN.md)：无 AOTUI 的正常 npm 消费者同样复现 51／8，AI6／provider-utils4 最新正式版本仍是当前报错组合；源码 patch 草稿未外发。2026-11-08 所有者明确要求「统一升级到 TS 最新版本吧」：全链改为统一最新稳定编译器，已从官方 registry 核实目标为 TypeScript 7.0.2；新工具链候选与严格验证正在准备，旧 5.3.3／5.9.3 裁决原样作为历史保留，不再以旧版本支持阻塞新候选。该决定不豁免第三方 Tool 声明问题或完整集成门禁，生产依赖与共享采用尚未宣称完成。继续审查[SRT-02 多 Ref／可选 Ref 隔离范围](SRT/SRT-02_MULTI_OPTIONAL_REF_SCOPE.zh-CN.md)，738 个基线源文件核对未变并已物理复制，当前只读准备。初版／r02 对 Worker 可验证来源和 payload 的承诺过宽，原件已保留；r03 用无 Worker 的 21 场景反例明确 schema/raw/envelope 一致性与 Runtime 原 Observation 真实性的分工，已获[独立范围与基线准备 APPROVED](MINIMAL_CORE/MINIMAL_CORE_SRT_02_MULTI_OPTIONAL_SCOPE_REVIEW_2026-11-07.zh-CN.md)。随后[新公共包基线](review-evidence/srt-02-multi-optional-baseline-20261107/REPORT.zh-CN.md)正常 npm ci／ls 通过；九个 SDK 捕获中，正式 Core 注册两项接受、七项明确拒绝，所有 registry 结清；两版严格 ArgsOf 与九个负向通过。负责人已在另一正常安装消费者复跑并移除负向注释确认真实错误，[公共基线与三处实现准入已 APPROVED](MINIMAL_CORE/MINIMAL_CORE_SRT_02_MULTI_OPTIONAL_BASELINE_REVIEW_2026-11-07.zh-CN.md)。随后[隔离实现交付](review-evidence/srt-02-multi-optional-candidate-20261107/REPORT.zh-CN.md)完成三处 Runtime 最小修复、375 项定向测试、九项正式注册、两版严格公共类型与正常包安装；SDK 可执行及类型逐字未变，仅文档同步。原试件失败与离线缓存元数据失败均保留。[r01 独立裁决 CHANGES_REQUESTED](MINIMAL_CORE/MINIMAL_CORE_SRT_02_MULTI_OPTIONAL_IMPLEMENTATION_REVIEW_2026-11-08.zh-CN.md)：负责人独立375/375及351件dist重建通过，但新增反例证明中间混合参数预算会误拒绝合法最终参数；当前仅该生产缺陷阻断。随后 r02 限定修复并增加顺序/边界回归，381/381 独立通过。首次真实入口发现两处合成 ArrayRef 元数据误写，双方均在第二调用停下并正常释放，Worker 未启动；原失败保留，r03 仅修该两处 fixture。现已获[最终限定 APPROVED](MINIMAL_CORE/MINIMAL_CORE_SRT_02_MULTI_OPTIONAL_FINAL_REVIEW_2026-11-08.zh-CN.md)：新正常包消费者、TS7严格类型、普通 TS/SDK Worker 各22调用（14成功/8指定拒绝）、完整参数/View witness/短收据及正常清理均独立复跑通过；双方44调用逐项一致，重复复验不计新场景。精确运行见[r03交付](review-evidence/srt-02-multi-optional-entry-r03-20261108/DELIVERY.zh-CN.md)，97/61/39历史输入清单与739 r02源均保持。不得默认长期 fork、shim、缩窄公共类型或放松严格检查。完整集成继续 CHANGES_REQUESTED。共享采用、发布、SRT-05 和 SRT-02 剩余形状／多选均另行跟踪，不把 Driver 外部依赖诊断扩大为其他隔离范围准备的自动禁令。方案 A 的旧 2–4 个有效工程日粗估不是 B 完整兼容问题的承诺工期。

### 最小候选方案

```text
集成适配层 → Runtime
     └───→ Agent Driver
```

将 Driver 专属 Source、类型转换和 `jsonSchema()` 包装迁到 Runtime 包外。已复核的[方案 A](MINIMAL_CORE/MINIMAL_CORE_SRT_06_RELOCATION_PROPOSAL_2026-11-07.zh-CN.md)使用现有 Driver 子入口，不新增包，但 Driver 安装图会带上 Runtime。方案 B 通过独立薄适配包保持两者独立，适合继续向第三方宿主公共分发现成 Source；代价是多一个发布单元及版本配对维护。方案 C 放在 Host 普通内部模块，同样可保持 Runtime 与 Driver 独立，官方 Host 使用时成本更低；模块可以不依赖 Electron／GUI 初始化。它意味着旧 `@aotui/runtime/adapters` Source 公开能力需要明确退出与消费者迁移，不能把 Host 私有路径当作同等公共分发。代码在 Host 目录但有独立 package.json 和发布产物仍属于方案 B；Host 包增加子入口也不会自动免除整个 Host 的安装依赖。

所有者已确认长期采用 B，独立包继续公共提供现成连接器，官方 Host 是其消费者；A／C 保留为已比较但未选择的方案。实现边界是 Runtime 保留 Snapshot／Observation／Scope／Ref、参数编译与资源释放；Driver 保留模型回合；适配代码只负责现有连接，不复制校验、开放私有 Receiver 或另建执行体系。旧 Runtime Source 转发出口不能暗中保留反向依赖。

迁出代码使用正式公共入口，连同测试、文档示例和消费者一起迁移；清除 Runtime manifest、锁文件、导出及声明文件中的 Driver 依赖。仅改成 `import type`、可选 peer 或保留旧 re-export 都不算完成。

### 验证与拆分边界

干净项目不安装具体 Driver，也应能通过正式包入口编译、运行 Runtime 核心消费者；集成消费者另装 Driver 后，观察、调用来源与 Ref 生命周期语义不变。验证方法统一见 [5.2](#consumer-validation)。当前 B 隔离候选实施 Host 导入迁移，不改变 Driver 回合与执行算法；完整集成类型尚未通过，不能据 Runtime 独立消费者通过宣称全部完成。

此前提出过 `spec/core/sdk/runtime-node/adapter/cli/conformance` 多包候选。它说明可能的模块边界，不是发布计划；先证明独立消费再决定发布单元，CLI/registry/catalog 是否独立也后定。不预建所有 Agent 框架的适配注册中心。

---

**2026-11-09本地修复已由SRT Owner直接复核通过。** [完整交付](review-evidence/srt06-toolchain-closure-clean-20261109/REPORT.zh-CN.md)使用正式AI6.0.326／provider-utils4.0.65复现原8条错误，再以仅两个类型文件的补丁完成严格正负与实际包验证；AOTUI生产源码未改。LSP固定7.0.2源码回移官方未合并PR，单个生产文件修复正常退出传播，保留提前退出失败；本地darwin-arm64二进制通过有限功能和正常释放，既定IDE三模块及跨平台支持仍未实施。类型补丁不会自动随原Driver tar传递给消费者；LSP二进制也不是官方稳定包，两者均需明确采用和维护政策。Owner已核对ZIP／202文件／520当前输入，HEAD不变，Git索引字节变化但无暂存内容差异的事实保留。[SRT Owner裁决](review-evidence/srt06-toolchain-closure-owner-20261109/REVIEW.zh-CN.md)直接审查两份补丁并补跑六个相关检查，其余有效结果复用；MC Owner重复复核已撤回。两份本地修复无待修订问题，正式工具链仍未关闭；当前沿用正式依赖和既有IDE后端，本地类型补丁保留为内部备选，不追加Planning人工验收。

<a id="identity-governance"></a>

## 3.2 name/id 专项治理与 App 元数据单一来源

**状态：SRT-09已完整APPROVED并采用。** Ref View定位及人工签收保留；App元数据来源、静态发现、注册／运行身份和原生别名边界已随[最终交付](SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)完成。字段访问、数据作用域与基础类型体系仍是用户明确未来事项。

### 当前执行：Ref 的 View 定位（2026-11-08）

**已实现并采用：** View 外层 XML 提供 id，正文保留 `[设计阶段](Phase:completed_phases[0])`，通过类型前缀表达数据类型，不重复 View id；调用传入 `plan_b.completed_phases[0]`，不带 `Phase:`。整数组展示 `Phase[]:completed_phases`，调用用 `plan_b.completed_phases`。业务类型元数据及参数合同保留，不同 View 的同名引用必须可分别使用。Owner 先前将“调用不带类型前缀”误解成“展示也删除类型前缀”，现已按用户纠正撤回该指令。

**改造依据与结果：** 原注册和快照已有 View 归属，但调用仅按裸 refId 查找，重名会拒绝。现保留类型展示、登记局部名，并按 viewId.localRef 从原 Observation 选择精确来源；Worker同步核对。复用已有快照和实例绑定，没有新增数据存储体系。

**完整实施任务交 Clean：** 从最新已验收实际根目录取得独占副本，连续完成 SDK Ref 展示与调用地址映射、Runtime 调用与 Worker 来源核对、必要的 Planning/示例/当前文档迁移及针对性验证。Owner 负责本文件与 AGENTS 的状态，Clean 不覆盖这两份文件。常规实现选择自主处理，完成后一次交付可采用的差异、变更路径前后身份和简明验证结果；不逐小点交审，不重做历史全套证据包。

**Desktop 调用说明同步：** 共用指令来源为 `runtime/src/adapters/system-instruction.ts`，Adapter Source 和 Host 导出复用它。将旧的“原样复制包含类型前缀的完整 Ref”改为“展示保留类型前缀，调用使用所在 View id + 局部 Ref”；示例与关键提醒、Planning 相关提示一并迁移。检查实际 Source Context 的指令，普通参数保持原合同，不另建重复 prompt 或额外验收项目。

**验收重点：** 展示保留类型提示而调用地址不带类型前缀；两个同 ViewType 的 View 发布同名数组而互不覆盖；按完整 Ref 分别取得正确数组/元素；错误或缺少 View 的引用明确失败；既有旧观察失效与关闭清理保持。保留当前对象/整列表/元素及多个/可选 Ref 消费能力。Owner 只核对实际差异、相关测试与关键运行路径，不重复全项目矩阵。

**交付结果：** Clean完整交付已获Owner集中APPROVED，40路径采用完成。Owner独立根构建、双View真实链路、SDK17项与Planning27次调用通过；[证据与边界](SRT/SRT-09_VIEW_REFS_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md)。本项收口，不重复已完成的人工验收。

**后续人工体验：** 用户提供六场景报告，主要流程记为“发生偏差、恢复后复验通过”。原始调用日志未留存，报告中的三个越界/不可见地址不能证明原计划三类负例分别执行；裸名成功的表述也不据此判为Runtime缺陷。清理仅记用户报告，不扩成独立数据库检查。[完整补记](SRT/SRT-09_VIEW_REFS_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md#2026-11-08-人工体验补记)。工程批准与采用保持，不追加验收。

**未来 TODO，不在本轮实现：** 字段访问（如 `view_id.completed_phases[0].field`）；View 私有、App 公用、全局公用作用域；基础数据类型及操作语义。当前支持范围仍按已有参数合同，不把这些方向写成已经支持的接口。

### 原问题与当前实现

工厂声明是作者源；既有`scripts/generate-aoapp.mjs`从构建工厂和package.json生成`aoapp.json`，本轮复用并修正为读取实际package.main。五个App构建均接入，不需要手写两份元数据或反向导入生成物。

Registry只读取静态manifest，不为发现名称和说明执行App模块；注册键必须与app_name一致，alias和元数据覆盖退出。Worker初始化前核对注册名与工厂名。缺失manifest、缺失明确source、显式入口不一致均按现有错误合同拒绝，正常目录和有效显式入口保留。

AppKernel从Runtime上下文接收不可更换的App ID，逻辑app_name不再兜底运行身份。App、View、Tool、Ref、Snapshot、Observation、Binding及原生别名的生成方、唯一范围、生命周期与执行用途统一见[身份表](runtime/docs/runtime-app-interaction.md#身份与元数据来源)。AOTUI_APP_KEY仅负责持久化namespace，替代歧义的AOTUI_APP_NAME；默认值保持已有数据位置，不迁移或删除业务数据。

旧manifest-first、manifestDigest等草案未被采用；不预建通用身份或数据作用域框架。公共名字与内部身份边界见下节。

---

<a id="public-tool-names"></a>

## 3.3 公共工具名：碰撞、长度与内部身份的边界

**状态：SRT-09已完成并采用。** 内部Tool身份保持`[appId, viewType, toolName]`；AppKernel不再以原生调用入口的ASCII／64字符限制拒绝结构化注册。`buildPublicToolName`继续在呈现适配边界校验三个字段、确定拼接与总长，失败隔离对应App；不静默截断、覆盖或增加别名注册器。

早期字段允许连字符造成的拼接歧义已由现行规则解决，不能当作当前复现；此前24字符App名称上限只是未采用草案。实际公共命名与健康App隔离已有契约测试，结构化名字可用而原生别名不可表达的情形也分别验证。

---

## 3.4 默认 allow-all 策略

**状态：暂缓，低优先级。**

当前标准 Host 创建 `SemanticAOTUIDrivenSource` 时不传 policy，Source 默认：

```ts
authorize: context => this.allowed(app) && (custom ? custom.authorize(context) : true)
```

见 [semantic-aotui-driven-source.ts](runtime/src/adapters/semantic-aotui-driven-source.ts#L148)。

项目所有者认为优先级不高。本轮决策：

- 保持现状；
- 应用层负责业务授权；
- Host 如果需要更严格策略，自行传 `policy`；
- 文档继续明确“可见 Tool 不是授权”；
- 不在本轮引入 allow-all 强制标记或最小权限默认策略。

---

<a id="protocol-compatibility"></a>

## 3.5 协议版本单一来源与兼容矩阵

**状态：SRT-13已完整APPROVED并采用。** 既有九类清单、持久化常量和136项／44协议输出证据保留；最终交付将跨SDK／Runtime的当前标记按所属SPI／Core合同共用来源，未增加spec包或通用协商平台。

当前工厂与端口共用`view-type-tools-v4`；Snapshot版本仍为3，工具IPC仍为v4，生命周期为2，持久化会话与记录各为1。包版本与这些独立合同分别演进，当前匹配包、九类协议及拒绝边界统一见[runtime-compatibility.md](sdk/docs/runtime-compatibility.md)。

Host INIT始终请求`app-snapshot/v3`，即使显式关闭Tool能力；Worker在导入App前拒绝缺失或不支持的能力，Host在OPEN前要求ACK确认全部请求能力。工具输入／结果、实例来源和预算仍独立校验。旧工厂与旧RPC无执行回退；现行纯Core profile及可信invoker的ordinary-v2名字不因此退役。

历史草案Snapshot 4、生命周期v3、统一大版本与兼容日期平台均未采用。迁移和真实包验证分别见5.2／5.3。

---

<a id="static-instruction"></a>

## 3.6 静态 instruction 必须稳定

**状态：稳定性约束已确认，具体开发期检查为建议；不表示相关应用已经迁移。**

### 问题

页面类别应按 [2.7](#view-semantics) 显式声明；instruction 进入 static 区，见 [view-fragment-extractor.ts](runtime/src/worker-runtime/view-fragment-extractor.ts#L16)、[semantic-aotui-driven-source.ts](runtime/src/adapters/semantic-aotui-driven-source.ts#L252)。

但 IDE 的 Root instruction 内容会随文件打开变化：

```tsx
{tools.workspace.filter(tool => tool.name !== 'batch_edit' || owner.files.size > 0)...}
```

见 [ScopedIDEApp.tsx](demo-apps/aotui-ide/src/tui/ScopedIDEApp.tsx#L136)。

项目所有者确认：**这说明应用设计有问题，静态 instruction 不可以动态。**

### 决策

- 静态 instruction View 在 App 实例生命周期内必须内容稳定；
- 动态可用性只能由实际 Tool 列表 / `enabled` 表达，不能写进静态 instruction；
- Root instruction 可以列静态 Tool catalog，但不能写“当前只有哪些 Tool 可用”；
- 如需动态说明，放入独立的 dynamic View，而不是 instruction View；
- `ScopedIDEApp` 移除 Root 中基于 `owner.files.size` 的 `batch_edit` 条件；
- `.agents/skills/aotui-app-builder/SKILL.md` 中“只在类型 active 时展示 section”的指导需要修正。

### 开发期校验

建议 SDK/Worker 在 dev 模式检查：

- 第一次 observation 记录 instruction View 的 content digest；
- 后续同一 `viewInstanceId` 的 digest 变化时，报 `STATIC_VIEW_MUTATED`；
- 生产环境如何处理变化、热更新是否开启新实例，需要与生命周期合同一起定稿。

### 不在本轮

- 不引入 priority/budget；
- 不自动拆分 static/dynamic；
- 不修改 Agent Driver 的 context 排序。Driver 的 active tail 排序问题另行验证。

---

<a id="app-lifecycle"></a>

## 3.7 统一生命周期 API

**状态：方向确认；注册方式待确认。**

### 当前问题

两套生命周期：

- `createTUIApp({ onDelete, onReinitialize })`
- `useAppLifecycle({ stop, close })`

见 [createTUIApp.ts](sdk/src/app-factory/createTUIApp.ts#L46)、[useAppLifecycle.ts](sdk/src/hooks/useAppLifecycle.ts#L6)。

App 作者需要理解 factory 级、component 级、同步/异步、早晚注册等差异。

### 决策

统一的是 **`AppLifecycle` 合同和状态机**，不一定是唯一注册位置。Codex 指出的问题成立：`delete` / `reinitialize` 可能发生在组件尚未挂载、挂载失败或已经卸载时，不能简单假设 Hook 一定存在。

建议：

```ts
type AppLifecycle = {
  stop?(): void;
  close?(): void | Promise<void>;
  delete?(): void | Promise<void>;
  reinitialize?(reason?: string): void | Promise<void>;
};
```

注册分两个 scope，但共享同一合同：

- **App 级**：`createTUIApp({ lifecycle: { delete, reinitialize } })`
  用于不依赖组件挂载的资源/数据清理，必须在组件不存在时也能执行。
- **组件级**：`useAppLifecycle({ stop, close })`
  用于组件拥有的资源，支持晚注册和 unmount 保留。

规则：

- 不再保留两套语义不同的回调命名；统一按阶段解释；
- `stop` 同步、其他可异步；
- SDK 处理晚注册：如果 App 已 stop，注册时立即执行 stop；
- unmount 不丢弃已注册 cleanup；
- Runtime 继续区分“回调完成”和“资源实际释放”；
- 如果坚持只保留一个注册入口，需要先证明所有阶段都不依赖组件生命周期。

### 兼容

这是潜在 Breaking Change，具体注册方式与排期仍待定，不因示例写入文档就视为获批。迁移规则见 [5.3](#breaking-change)；不永久保留两套生命周期。

---

<a id="serial-observation"></a>

## 3.8 串行观测：刷新、交接与旧 Ref 失效

**状态：SRT-04 观测前刷新已在隔离r02工程收口，见[独立批准](MINIMAL_CORE/MINIMAL_CORE_SRT_04_CLEAN_R02_REVIEW_2026-11-08.zh-CN.md)；SRT-05 也已在精确隔离候选实现并获[独立批准](MINIMAL_CORE/MINIMAL_CORE_SRT_05_CLEAN_REVIEW_2026-11-08.zh-CN.md)：显式采用切换资格并释放无人持有的旧引用。2026-11-08已随Planning根入口采用并验证；历史快照仍保持。DEFER-01暂缓并发。**

### 3.8.1 当前实现与候选主线

当前 Core 和异步 Worker 入口允许调用交错，并未提供全面的串行合同；来源校验不能替代业务执行顺序。这里只收敛串行路径，不设计并发调度器。依据：[scoped-interaction.ts](runtime/src/core/invocation/scoped-interaction.ts) L361–409；[worker-runtime/index.ts](runtime/src/worker-runtime/index.ts) L136–155。

共享树旧实现：新 Observation 被加入观察表，不会自动替换旧观察；释放观察也不必然立即删除已退休快照。依据：[observation-registry.ts](runtime/src/core/invocation/observation-registry.ts) L429、L465–468；[store.ts](runtime/src/core/snapshot/store.ts) L124–158。

已批准隔离候选的流程：`采用 O1 → 串行执行本轮 Tool Call → 刷新已提交投影并准备 O2 → Driver 在交给模型前显式采用 O2 → 撤销 O1 并释放旧独占引用`。低层观察及预览只准备，不自动采用；刷新或准备失败不得伪造成功切换。Driver保留每轮finally释放，不延长为跨轮永久Scope。

### 3.8.2 “先刷新”到底刷新什么

刷新的是 App 已经提交的 View、Ref、Tool 投影，不是重新执行 Tool，也不是让 Runtime 重读全部文件、刷新外部 API 或等待后台任务结束。SDK/renderer adapter 负责提交完成边界，纯 Core 不调用 Preact 或 DOM。

没有变化可复用已确认快照；有待提交变化才准备新快照。不能用固定 sleep、猜测“等几个微任务”，或永久等待所有后台活动静止作为协议。共享树旧主链在 Tool 终态前调用 `flushInteractionProjection()`，纯Core `ScopeClient.observe()` 本身不负责renderer刷新。已批准的隔离SRT-04 r02在Worker Host的既有Scope观察入口加入真实提交等待与关联Snapshot接收；普通TS Producer在既有提交边界后观察。两份来源分开，不把共享旧代码行号当r02行为。参见 [worker-runtime/index.ts](runtime/src/worker-runtime/index.ts) L153、L672–715，以及 [scoped-interaction.ts](runtime/src/core/invocation/scoped-interaction.ts) L399–409。

后台通知/预发布可以保留以支持主动更新，但下一次观察的正确性不依赖通知碰巧提前到达。不要同时引入两套都必须理解的最终提交规则。初版不加两阶段提交或模型已读 ACK。

业务成功但刷新失败时：保留业务收据，返回该 App 的观察错误，不自动重试业务；旧 last-good 只能按明确的旧状态/诊断语义使用，不能伪装成最新正常状态。其他 App 仍可正常观察。

### 3.8.3 “读到新快照”用可验证的运行边界表达

Runtime 不知道模型在心理意义上是否读懂了内容。已批准候选以同一串行消费会话成功将新 Observation 设为当前观察作为交接点；外部模型请求失败后可重用当前新观察，不回退到已撤销的旧观察。低层后台捕获和诊断预览不应擅自切换当前轮次。

每个串行消费会话最多一份**可用于后续调用的当前观察**。构造新快照的短暂中间值不是第二份可调用的当前观察。本轮多个 Tool Call 可共同引用 O1；尚未切换 O2 时，后台发布新值不自动将 O1 的 Ref 改成新值。App 关闭、工具撤销和业务检查仍可更早拒绝调用。

新观察成功切换后，旧 Observation/Binding 不能再用于进入 handler；旧 Ref/ArrayRef 也不能再解析。新观察重新发布同名 Ref 是新的观察内引用，不是旧资格复活。只携带裸 RefName 无法证明“这个字符串是模型从哪一轮抄来的”；防止旧调用改绑依赖 Observation，不在本轮擅自要求所有公开 Ref 名加入版本号。

失效范围属于对应消费会话；不要把一个消费者换轮误写成全 Runtime 销毁所有消费者的数据。当前只落实串行路径，不据此设计多消费者并发协议。无内容变化时可共享不可变快照值，但新旧观察的调用资格仍要正确交接。

以 ArrayRef 为例：O1 的 `users[0]` 是张三，O2 的同名引用可以是李四。O1 有效时只能解析张三；切换 O2 后旧 O1 调用被拒绝；O2 调用才解析李四。框架携带观察身份，不能把旧调用静默改绑。

### 3.8.4 “立即释放”不能只做表面清理

旧调用资格立即撤销；Runtime/SDK 释放旧观察的注册、闭包及其他自有持有引用。若旧快照已不再是当前状态，也无其他合法持有者，不能只 release lease 却让 history 表无理由继续留住完整 Ref payload。只为诊断保留必要元数据，不把全文/Ref 数据保留说成无成本。

这不删除 App 自有业务状态、仍需为新快照发布的 Ref 声明或新快照仍用到的共享数据；也不声称能撤回已交给外部代码的对象、强制 GC 或保证 RSS 立刻下降。授权失效与对象物理回收分别验证。

观察交接不能替代注册所有权保护：同一快照准备时也可能撞名或被旧 cleanup 误删，具体证据与规则见 [4.6](#ref-ownership)。已批准候选中单Scope无效采用不撤销当前资格；跨App部分采用如实给出逐App结果，失败轮次不进入模型并正常释放，健康App可重新准备。不能把失败说成成功换轮，也不能以失败为由自动重放业务操作。

---

<a id="app-failure-isolation"></a>

## 3.9 单 App 投影失败隔离

**状态：规则已确认，SRT-08；此前从暂缓提升为重点，不再保留另一套 P0 排期。**

历史共享树描述：旧标准 Source 能将部分观察拒绝记为单 App issue，但工具名冲突、绑定不一致或直接异常仍可能使整体构造失败；原依据为共享树 [semantic-aotui-driven-source.ts](runtime/src/adapters/semantic-aotui-driven-source.ts) L199–263。当前隔离候选已迁入独立 adapter，逐App局部准备、诊断、碰撞处理与释放已具备，并获[独立42项核对批准](MINIMAL_CORE/MINIMAL_CORE_SRT_08_CURRENT_REVIEW_2026-11-08.zh-CN.md)；不再沿旧共享树描述认定候选缺少实现。

目标是按 App 准备、按 App 失败、按 App 报告。应用自己的声明、命名或投影错误，默认只使该 App 本轮不可用；应清理失败准备的观察资源并给出诊断，不静默丢掉错误、不返回假正常或半套错误能力。其他健康 App 仍可被观察和调用。

这不要求通用容错平台，也不要求把真正影响全局可信性的错误强行吞掉。工具名称冲突的归属和别名映射由 [3.3](#public-tool-names) 治理；验收同时覆盖失败 App 的资源清理与健康 App 的可用性。

---

<a id="resource-bounds"></a>

## 3.10 有界资源：保留事实，暂缓整体重设计

**状态：DEFER-02，暂缓；不删除现有保护，不新增预算／配额体系。**

Snapshot 与 Observation 的额度不同；当前默认完整 Observation 的字节上限小于 Snapshot，标准 Source 又默认 `observe({ all: true })`。因此提交成功不等于整个 App 能一次进入观察。依据：[snapshot-support.ts](runtime/src/core/snapshot/snapshot-support.ts)；[observation-registry.ts](runtime/src/core/invocation/observation-registry.ts) L14–23；[semantic-aotui-driven-source.ts](runtime/src/adapters/semantic-aotui-driven-source.ts) L203。

Core 还保留已使用实例身份以避免复用，累计身份额度与同时活跃额度不同；见 [core-lifetime-and-bounds.md](runtime/docs/core-lifetime-and-bounds.md)。这些是现状和后续设计输入，不在本轮解决容量扩展、自动驱逐或身份代际退休。

新观察采用后撤销旧资格、释放框架专属引用，是 [3.8](#serial-observation) 的必要正确性，不因资源整体设计暂缓而搁置，也不借该要求启动通用资源管理工程。

---

# 4. 代码实现与清理

---

<a id="result-errors"></a>

## 4.1 结果／错误模型

**状态：SRT-10已完整APPROVED并采用。** INIT/OPEN诊断和本地cause链保留；公共ToolResult已收敛为success判别联合，生产消费者、示例及普通包类型同步迁移。

成功返回`{ success: true, data?: JsonObject }`，不能同时带error或effects。失败返回`{ success: false, error: { code, message, context? }, data?, effects? }`，error必填，data只承载简短收据与恢复事实。权威类型见[tool-result.ts](runtime/src/spi/core/tool-result.ts)。

Core和Worker在既有有界JSON捕获后复用形状校验；Error实例、自定义原型、函数、undefined、stack/cause不直接充当业务收据。本地开发诊断按[初始化诊断](#initialization-diagnostics)处理，不机械重写所有Error或新增异常基类。

失败effects为none／partial时保留已知事实，省略表示无法确定；未进入handler、已失败、结果未知和后续执行不可用保持区分。非法结果不能被标成安全失败，未知操作不自动重放。没有统一retryable开关，也不以message前缀替代稳定code；业务数据继续由View呈现。

原宽泛接口及ToolErrorRecord／AotuiError新体系只是原评审草案，现由上述公共类型与既有诊断边界承担，不继续作为待实现任务。

---

<a id="view-encoding"></a>

## 4.2 View 正文保真与唯一包装

**状态（2026-11-08）：SRT-07完整候选已获[独立最终批准](MINIMAL_CORE/MINIMAL_CORE_VIEW_PIPELINE_FINAL_REVIEW_2026-11-08.zh-CN.md)，已通过[联合验收并采用到实际根目录](SRT/SRT-02_03_07_COMBINED_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md)。** 元数据和正文分离，现有Runtime呈现边界统一包装并编码XML文本，Host识别外壳后解码一次；原样正文的空白、围栏、字面标签和CR/CRLF有真实消费验证。原完整验收的R1回车遗漏已修复，原失败证据保留。以下为历史问题与设计依据，具体已实现合同以最终候选及其公开指南为准。

### 4.2.1 已复现的表示问题

以下来自此前源码探针，不是本次整理重新运行的结果：

| 输入情形 | 观察到的结果 | 原因与依据 |
|---|---|---|
| 原样代码 `    print("hello")\n` | 代码块中首行四个空格消失 | [pure.ts](runtime/src/engine/view/transformer/pure.ts) L38–40 与 [html.visitor.ts](runtime/src/engine/view/transformer/visitors/html.visitor.ts) L128–136 使用 trim |
| 正文 `<view id="literal">body from file</view>` | 原本属于正文的外层被剥掉，只剩 body from file 被重包 | [view-message.ts](runtime/src/adapters/view-message.ts) L11–20 把正文当成已有框架 envelope |
| View 名称 `foo>bar` | 重包后的正文开头混入 `bar">` | DOM visitor 先生成包装，正则把引号内的 > 误认成标签结束 |

DOM 生成包装见 [view.visitor.ts](runtime/src/engine/view/transformer/visitors/view.visitor.ts) L45–49。当前最终属性转义并不能弥补更早一步拆错正文的问题。

### 4.2.2 已确认约束与候选修复

内部明确分离 View 元数据与正文，正文不携带框架外层 envelope；由唯一呈现边界正确生成包装，不用正则猜正文是否“已经包装”。正文中合法的 `<view>`／`</view>` 不能被禁止或剥掉。

普通说明可以有声明过的排版规则；代码、补丁、日志、原样文本不能擅自 trim。固定三反引号围栏还需覆盖正文自身含围栏的情形；这是待补的边界测试，不把未经验证的情况全部称为已复现。

序列化应处理 envelope 分隔符、属性、Ref marker/suffix 及相关应用描述、日志和工具说明的边界。具体编码方案待定，保持 XML＋Markdown 的产品呈现约束，不借修复另起传输体系。Ref 名称的字符／长度规则由 [3.2](#identity-governance) 治理。

这属于内容正确性，不是性能优化，也不等于建立提示注入防护或接管业务信任策略。

---

<a id="tool-ui"></a>

## 4.3 ToolUI 展示与类型激活的一致性

**状态：下文为 2026-11-03 的问题依据与设计约束；SRT-01 的 M4.3 精确候选已完成本地工程签收，实际机制及验证范围以[最终裁决及其 M4 交付引用](.tmp/worktrees/srt-01-owner-verdict-20261106/SRT-01_G3_OWNER_CLOSURE.2026-11-06.zh-CN.md)为准，不表示共享工作树已采用。**

[useViewTypeTool.ts](sdk/src/hooks/useViewTypeTool.ts) L124–132 返回的 ToolUI 只生成 `<tool-ref>`，没有检查它是否处在匹配的 ViewType；真实激活由类型注册和当前 View 决定。作者可能把指引放错页面，正文与可调用能力因此不一致。

修复可选开发期检查或由单一声明生成正确指引；选择标准见 [2.5](#sdk-authoring)。ToolUI 位置不能变成执行授权、隐式业务目标或另一种运行时绑定。校验也不能要求所有已声明的 ViewType 此刻都有实例。

---

<a id="public-contract-cleanup"></a>

## 4.4 公共合同清理与当前实施状态

**Ref统一已于2026-11-08完成联合验收并接入实际根入口，当前能力见[2.3](#refs)及顶部SRT-02。** 结果与通用任务查询机制的前一批清理保留；SRT-10当前结果合同收尾不恢复已删除的任务查询机制。

旧 Snapshot Tool 的删除与保留清单统一见 [2.3.6](#refs)。Ref／ArrayRef 的发布、RefDescriptor、类型、payload、Observation refs 和 grants 必须保留并接入统一参数链；删除包装不等于删除数据概念。

### 已完成的历史批次

- `ActionOutcome` 曾被纯 Core 公共示例以 `kind: 'action'` 使用，因此属于有消费者的 Core 公共合同 Breaking Change，不是清理从未使用的死代码。前一批已统一为 ToolResult 对应的 `kind: 'tool-result'`，并迁移 [公共示例](runtime/docs/core-public-entry.md)、测试与 [包消费脚本](runtime/tests/w10-package-consumer.mjs)。
- `OperationProvider`／后续名 `TaskProgressProvider`、`accepted` 查询和 `readReceipt` 已退出。`invoke()` 直接返回收据；同一 Scope 内相同完整请求的去重、读取权限、失败副作用分类和资源清理仍保留。见 [当前接入合同](runtime/docs/semantic-host-integration.zh-CN.md)。没有为这些已删抽象建立 jobs 包；独立任务系统需有真实需求再评估。

### 仍需独立评估

`ViewContent.format: 'semantic-v1'` 是否有真实 Producer 支撑，以及 `RefTarget.kind: 'entity'` 的 Core 消费者与保留价值，需要单独核对。后者仍有公共类型／包消费使用，不能因为默认 SDK 路径不用，就叫它死代码或与 snapshot Ref 一并删除。

每个保留概念都要有真实应用、宿主或明确承诺的 Core 消费者。迁移统一遵循 [5.3](#breaking-change)，不重复列旧 P0/P1/P2 清单。

---

<a id="initialization-diagnostics"></a>

## 4.5 初始化诊断：别把原因压成一句失败

**状态：2026-11-08本轮INIT/OPEN诊断缺口已集中验收并采用到实际根目录；通用错误模型重设计仍为TODO。** [Owner验收与采用记录](SRT/SRT-10_INIT_ERRORS_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md)明确本轮边界及实际验证。

此前 Worker catch、Host 初始化拒绝与两层 INSTALL_FAILED 包装会丢失原始原因，首次渲染错误还可能被持久化失败摘要覆盖。当前 Worker 在清理前捕获有界 name/message/stack，复用已有响应传输；Host 根据本地请求绑定 appId / phase，把诊断放入非枚举 cause，Sandbox 与 AppManager 保留完整原因链。OPEN 主错误为 E_OPEN_FAILED，真实 persistence / appCleanup 收尾事实独立保留。

开发诊断不自动进入公开 ToolResult、View 或关闭摘要。字段上限、裁剪标记、非 Error 抛出及本地 cause 用法见 [当前初始化诊断说明](runtime/docs/initialization-diagnostics.md)。本轮没有新增通用错误框架，也没有实现未来的诊断 path / docs 指引或结果判别联合；其余设计继续见 [4.1](#result-errors)。


### 本轮完成：INIT/OPEN 原始错误传递与失败收尾

Clean从已采用SRT-09的根目录起点连续完成10个Runtime路径。原真实Worker的INIT/OPEN两项失败已通过，健康安装及资源释放保持正确。B05断言改正错误归类，并保留不保存默认数据、unsafe、ownerSlots归零、dispose/release和禁止复用的要求。

执行方只跑一次Runtime默认套件：2080通过、2失败，发现本地message漏码和B05旧归类预期；修正后10文件134项定向通过。Owner集中核对全部差异后选择性采用，根Runtime/SDK构建和5项关键真实Worker场景通过。最终候选没有再次默认全量，不把组合证据记成最终全量全绿。完整身份与日志链接在上述Owner记录。

本批无未解决阻断。下一条指令为继续已分派的SDK作者入口、示例、迁移及包消费整项交付，作者指南可引用本轮独立诊断页；由Minimal Core Owner一次集中验收，SRT Owner负责根采用和索引，不重复检查。通用错误模型、性能和未来Ref能力不并入本批。

---

<a id="ref-ownership"></a>

## 4.6 Ref 发布注册的所有权与稳定性

**状态：早期缺陷与当前实现分开记录。2026-11-08 只读核对确认，已签候选及当前共享均已有重复注册拒绝和entry身份update/release；跨观察失效及payload释放随后在SRT-05精确隔离候选完成并获[独立批准](MINIMAL_CORE/MINIMAL_CORE_SRT_05_CLEAN_REVIEW_2026-11-08.zh-CN.md)。原注册机制继续保留，没有重建一套注册体系；2026-11-08已随Planning根入口采用。早期事实见[只读报告](review-evidence/srt-04-05-readonly-20261108/REPORT.zh-CN.md)。**

早期诊断曾记录 AppKernel 按 `viewId:refId` 直接 Map.set/delete，useRef cleanup 仅携带名字、没有注册身份；当时的探针复现如下。该历史说法及旧行号不能用于描述当前文件：

```text
A 注册 vv:selected → { owner: A }
B 注册 vv:selected → { owner: B }，A 的值被静默覆盖
A 执行旧 cleanup → B 的注册也被删除
```

既有目标保持：同一发布者更新自身值、不同发布者重名拒绝、cleanup 只释放自身注册。当前实际已经使用 registerRef 返回的 binding.update/release，并检查 entry identity；候选 AppKernel 231–262、当前共享256–289及各自useDataRef/useArrayRef均有依据。类型贯通存在候选/共享差异，源码核对不等于本批新增行为测试通过；本批保留了已存在机制，并通过SRT-05跨观察合同复核；没有重复造注册体系。

该错误在构建同一份快照时也能发生，所以“新观察替换旧观察”不能自动解决它。发布应与 View 提交一致；formatter 只生成文本，不在格式化期间修改共享 Registry。`useDataRef` 的依赖变化可能重新注册；应避免无关 render 导致不必要 churn，但优化不能削弱所有权。

ArrayRef 的索引名字、真实 refType、整体列表与元素发布和解析合同唯一维护在 [2.3](#refs)；跨观察失效唯一维护在 [3.8](#serial-observation)。它们不能被归为纯展示细节。

---

<a id="conversion-performance"></a>

## 4.7 重复转换与实现清理

**状态：2026-11-09本轮测量与最小清理已独立APPROVED并采用到实际根目录。** [完整任务](SRT/SRT-11_MEASURE_REUSE_CLEAN_TASK_2026-11-09.zh-CN.md)、[执行测量](review-evidence/srt-11-measure-reuse-20261109/REPORT.zh-CN.md)、[独立验收](MINIMAL_CORE/MINIMAL_CORE_SRT11_REVIEW_2026-11-09.zh-CN.md)、[根采用](SRT/SRT-11_OWNER_ADOPTION_2026-11-09.zh-CN.md)。生产仅删授权返回后同一同步边界紧邻的第二次recheck，授权后完整资格复核保留；新增8项行为场景，独立3文件236/236通过。原始计数独立重算确认成功调用少一轮参数准备、一次profile编译及11次copyJson，Worker与无变化观察计数不变。根Runtime构建通过，SRT Owner未重复行为矩阵。计时改善有限且部分p95上浮，不外推普遍加速，不据此启动第二轮性能改造。

原评审沿组件状态、DOM、Markdown、快照复制、Worker传输、验证与观察呈现列出可疑成本，静态Schema的编译和身份计算也曾列为线索。SRT-01单一声明及后续清理已经改变部分实现，原useViewTypeTool路径已退出；本项必须依据当前保留入口重新测量，不能把历史怀疑当成当前已复现退化。

优化顺序建议是先删不必要的表示转换，例如加包装再拆包装；再复用静态声明；最后有完整链路测量依据才考虑增量捕获、缓存或 diff。跨信任边界的验证、不可变捕获和执行前资格复核有作用，不能因“看见重复”就删除。

AppWorkerHost、ScopedInteraction、ViewOwnedTools、ObservationRegistry的密度与可读性不以行数判断必须重写。unchanged成本沿用实际测量；原清单的时钟回拨检查现已补齐：10→9时观察失败且不进入handler，恢复到10后重新观察／采用／调用成功，关闭后scope、lease及bytes归零。检查未要求生产修复，不新增缓存、dirty协议或性能项目。

Driver 的签名算法、日志等内部事项不在本轮范围；不作为 SDK/Runtime 清理任务。正式包验证统一在 [5.2](#consumer-validation)，避免用源码内部测试或历史性能数字替新交付背书。

---

# 5. 文档、兼容与演进治理

<a id="documentation-governance"></a>

## 5.1 文档按议题维护，不按对话轮次叠加

**SRT-12。** 当前作者指南必须说明适用版本、已实现 API、限制和可运行示例。根目录目标与决策记录描述方向，不能让 Agent 把“待迁移”当成“现在可调用”，也不能把当前限制当作永久设计原则。

原评审记录中的双 Tool 路径已经由SRT-02退出；当前指南应按已采用的单一Tool与Ref合同说明，不再把已完成迁移写成未来目标。更新同一议题时，直接修改该议题的现状、约束、建议和证据；被新反馈替代的优先级或机制不再作为并行清单保留。历史依据放在有关议题或验证记录中，不要求读者在多份结论间选版本。

每项变更先说明维护哪条目标／约束、状态和资源归谁、如何验收。已有工具可自动生成的目录／参数说明不再手写第二份；这不要求建立新的文档平台。

**2026-11-09 当前交付已采用：** [完整独立验收](MINIMAL_CORE/MINIMAL_CORE_AUTHOR_DELIVERY_REVIEW_2026-11-09.zh-CN.md)批准24个作者路径，SRT Owner已核对before/after、保留原件并[采用到实际根目录](SRT/SRT-12_AUTHOR_DELIVERY_OWNER_ADOPTION_2026-11-09.zh-CN.md)。根/SDK/适配包导航、SDK指南与实际示例、App Builder skill及Runtime公共入口现在指向同一当前合同。文件例子的两种实现复用一份Tool定义，Ref完整例子只维护一份，普通TS低层Producer接线留在验证侧。新正常包消费者中的完整示例严格编译、实际运行和清理通过；采用时沿用独立结论，没有重复行为矩阵。

上述24路径是当时作者交付。最终SRT-09／10／13已同步当前指南、可执行示例、skill、迁移和支持说明，Driver文档准确描述SRT-06精确临时补丁及消费者自行安装规则。[最终四包验证与根采用](SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)已完成；AGENTS与本索引由SRT Owner统一维护。

<a id="consumer-validation"></a>

## 5.2 正式消费者、两种 Producer 与 Agent 作者验证

**SRT-14，协议兼容矩阵见 [3.5](#protocol-compatibility)。**

仓库已有 [w10-package-consumer.mjs](runtime/tests/w10-package-consumer.mjs) 与历史分发记录，不能说从未验证。问题是每次新改造都要按实际交付重验，而不是仅复用源码 alias 或旧结果。

**2026-11-09当前作者交付证据：** [独立验收](MINIMAL_CORE/MINIMAL_CORE_AUTHOR_DELIVERY_REVIEW_2026-11-09.zh-CN.md)通过正常四tar安装核对490份文件，实际文档与Preact/普通TS示例严格编译、运行和释放通过，已[采用根目录](SRT/SRT-12_AUTHOR_DELIVERY_OWNER_ADOPTION_2026-11-09.zh-CN.md)。离线缓存与ignore-scripts的边界明确保留；没有将当前文档消费者结果外推为完整Driver第三方声明、原生安装脚本或新模型作者评测全绿。

验证至少覆盖：干净目录无 Driver 的核心消费；另装 Driver 的集成消费；严格声明链和实际包内容；普通 TypeScript 与 Preact 对相同状态满足相同 View／Ref／工具和失效合同。具体反例只在第 6 章维护，不在每轮评审新增一份验收清单。

**2026-11-09本次作者试用已完成：** [新上下文Agent作者试用](MINIMAL_CORE/MINIMAL_CORE_AGENT_AUTHOR_DELIVERY_TASK_2026-11-09.zh-CN.md)由指定Minimal Core执行agent组织，[完整交付](review-evidence/srt-14-agent-author-20261109/REPORT.zh-CN.md)已获[独立APPROVED／NO_CHANGE](MINIMAL_CORE/MINIMAL_CORE_SRT14_AUTHOR_REVIEW_2026-11-09.zh-CN.md)，[Owner接受并关闭本批](review-evidence/srt-14-owner-acceptance-20261109/acceptance.json)。作者从新上下文使用18份限定公共资料及冻结的SRT-13批准包，App初稿一次严格构建通过、作者修复0轮、私有API依赖0；初稿到最终源码相同。独立重编App与公共Host、真实Worker复跑10帧／11调用（8成功、1预期业务失败、2旧观察拒绝）通过，完整View消息、调用输入／结果／阶段及资源归零报告与执行方一致。协调者自己的类型／选页夹具失败原件保留，不记作作者失败；独立核对冻结材料与安装物，未随SRT-15根采用重跑矩阵。本样本没有证实指南／示例／skill缺口，生产和文档均无patch，Owner不再重跑测试或索取人工签收。结论限单作者、单App及所测流程，不报普遍成功率、迁移率、真实Driver／模型使用效果或成本。

**最终合同消费者：** [最终四包](SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)正常安装，完整Driver公开类型以strict／exactOptionalPropertyTypes:true／skipLibCheck:false通过；两Producer文档示例、Ref调用及结果记录、关闭释放通过。此次未重复新作者或真实模型评测，未变输入的历史结论保持各自范围。

Agent 开发应用与 Agent 使用应用是两类评测。作者评测应只提供公开文档，让 Agent 完成小 App，记录契约符合率、修复轮次、私有 API 依赖和迁移成功率；“能编译”不等于行为正确。模型任务成功率、成本和延迟另行验证，不从删旧 View 推导成本必然更低。

<a id="breaking-change"></a>

## 5.3 Breaking Change 与旧路径退出

**SRT-15。** 支持为统一 Tool／Ref、内容表示、作者接口和适配边界做必要破坏性变更，但保留一致提交、来源检查、调用资格和诚实失败语义。

迁移覆盖实现、公共导出、类型、配置、文档示例、测试和实际消费者；不能将有公开消费者的 API 当作死代码。旧路径在约定验收完成后退出，不永久保留每代分支，也不因为本次整理就宣称已获得项目所有者的实现验收。

**2026-11-09当前作者迁移已采用：** SDK指南与[迁移说明](sdk/docs/migration.md)不再要求读者在旧阶段教程和当前合同间选择，现有替代API、包说明和完整示例同步验证。历史证据保留，此次文档收口不自动扩展为所有Legacy删除或发布批准。

**2026-11-09本批清理已独立通过并采用：** [已验收入口的剩余清理与退出范围核对](SRT/SRT-15_REMAINING_CLEANUP_CLEAN_TASK_2026-11-09.zh-CN.md)由Clean完成，[独立验收APPROVED](MINIMAL_CORE/MINIMAL_CORE_SRT15_REVIEW_2026-11-09.zh-CN.md)后[采用实际根目录](SRT/SRT-15_OWNER_ADOPTION_2026-11-09.zh-CN.md)，覆盖20路径（4删除、16修改，净减191行）。删除SDK无人读取的私有挂载计数／只写ref与4个无独立职责的Runtime内部barrel；原源符号、公共入口、Runtime实例身份及Core生命周期保留。独立14文件160/160、两项严格公开类型检查、Runtime／SDK构建通过，六个公开值导出集合保持；声明内部import路径改变，不宣称d.ts逐字不变。执行方CLI过滤名修正和复核方清点范围修正原始记录保留。Owner备份20个before，采用后16个after与4项源码删除匹配；根Runtime／SDK构建通过，12件旧barrel产物退出，未重复行为矩阵。本批新增人工签收对象为0，限于实际私有冗余退出；已有签收保持，不扩为全面Legacy退出或未来设计批准。SRT-14作者指南／示例／skill未被本项修改，继续作为下一完整工作独立推进。

**2026-11-09升级后清理已采用：** [MC完整清理](MINIMAL_CORE/MINIMAL_CORE_POST_UPGRADE_CLEANUP_REVIEW_2026-11-09.zh-CN.md)获唯一APPROVED，[SRT Owner采用19路径](SRT/SRT-15_POST_UPGRADE_OWNER_ADOPTION_2026-11-09.zh-CN.md)，删除7文件及四个专属依赖；19份before备份、after一致、根冻结安装和两包构建通过。Runtime2092／SDK187及MC独立44次真实Worker调用等有效证据直接复用。已有人工签收有效，无新增人工前置。

**2026-11-09内核第二轮减法已采用：** [MC唯一裁决](MINIMAL_CORE/MINIMAL_CORE_KERNEL_CLEANUP_REVIEW_2026-11-09.zh-CN.md)批准14路径，[SRT Owner采用](SRT/SRT-15_KERNEL_CLEANUP_OWNER_ADOPTION_2026-11-09.zh-CN.md)后9个after、5项源码删除及旧产物退出匹配，实际根Runtime→SDK构建通过。删除重复登记／转发、无使用者的Desktop Mirror DOM observer和固定转换的visitor包装。随后Clean已完成facades纯转导出及当前元数据／结果／协议迁移，[最终集中验收与采用](SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)关闭剩余合同。没有恢复长期兼容双轨，MC代码不重复审查。

**2026-11-09追加完整减法已采用：** [Clean交付及Owner一次集中验收](SRT/SRT_POST_ACCEPTANCE_SUBTRACTION_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)完成62路径，删除5个生产文件、生产净减444行。退出单模式包装、聚合接口拆层、只写活动日志缓存、无用选项／转发及旧AppContext渲染接线，同步实际包消费者和当前文档。全部after与实际根目录一致，原run.sh构建及Host严格类型通过。随后MC原计划参数编译和IDE消费者两项获其Owner批准，[最终19路径增量也已采用](SRT/MC_PLAN_CLOSURE_OWNER_ADOPTION_2026-11-09.zh-CN.md)，生产再净减131行、退出旧启动脚本，根三包构建通过；两项原遗漏已关闭。

旧P0/P1/P2不作为第二份排期；统一使用顶部TODO状态。包边界、API、协议版本及错误结构按对应章节收口，不建设通用兼容日期平台或适配注册中心。

---

<a id="verification"></a>

# 6. 验证证据与候选验收

## 6.1 已有证据及其边界

源码事实基于评审时工作区，不等于已提交或发布版本。下表记录此前深度 Review 的工具结果；本次按议题合并只修改文档，未重新运行这些测试、探针、构建或性能验证，也不宣布缺陷已经修复。

| 验证 | 已记录结果 | 不能据此声称 |
|---|---|---|
| 选取的 Runtime 测试 | 5 个文件、195 项通过 | 全量 Runtime 验收通过 |
| 选取的 SDK 测试 | 5 个文件、59 项通过；两者合计 254 项 | 尚未实施的统一 Ref、刷新和观察交接已正确 |
| 源码探针 | Ref 注册误删、代码缩进丢失、正文误拆包、名称含 > 时正文污染已复现 | 已通过完整模型端到端验证；其细节分别见 4.6、4.2 |
| 历史 Ref 语义核对 | 提交 2bbfdcea 的接口与解析路径静态阅读 | 运行过历史版本的端到端测试；详情见 2.3.1 |
| 历史分发／性能记录 | 仓库保留旧交付的正式包消费者与性能证据 | 数字自动适用于当前或未来依赖图 |

历史记录入口：[sdk-runtime-distribution.md](runtime/docs/sdk-runtime-distribution.md)。结果／任务查询机制的前一批工作区清理状态见 [4.4](#public-contract-cleanup)，不能与本次文档编辑或待实施的 Ref 迁移混为一谈。

## 6.2 按对应议题验收，不新增排期

以下在对应改造进入实施时转成契约测试；候选机制定稿前不把示例测试当作额外产品决定。已有测试数量不能替代它们。

| 对应项 | 应验证的反例或行为 |
|---|---|
| SRT-01 / SRT-03 | 同类型多 View 只一组 Tool；声明类型暂时无实例合法；ToolUI 错配可诊断；instruction 类别不由后代标记暗改，静态内容变化可识别 |
| SRT-02 | ViewType Tool 统一 Ref／ArrayRef 参数，删除独立 Snapshot Tool 路径 | 完整Ref＋View联合交付已APPROVED并采用到实际根目录。对象/整列表/元素、多个/可选Ref和Ref名数组均贯通，旧专属路径与文档/包/测试收口。独立SDK185、Adapter46+集成31、两Producer各41调用通过；Runtime2073过/2项既有SRT-10失败。根9模块+GUI构建、17包解析、Planning27调用通过；实际入口的本轮Planning/Ref人工工作流已由用户签收，见顶部签收记录 | [联合验收与根采用](SRT/SRT-02_03_07_COMBINED_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md)、[完整任务](SRT/SRT-02_03_07_COMBINED_DELIVERY_CLEAN_TASK_2026-11-08.zh-CN.md) |
| SRT-04 | 通知未先到也能在下一次观察取得最新相容的View/Ref/Tool；无变化可复用，投影失败不重放业务，新增等待可随所属Scope/App关闭 |
| SRT-05（观察） | O1 有效时 Ref 不被后台重排改义；O2 成功接替后旧调用拒绝、旧专属引用释放；共享数据不误删；失败准备不伪装成功切换 |
| SRT-05（注册） | 同一发布者能更新；不同发布者撞名明确失败；旧 cleanup 不删除新注册 |
| SRT-07 | 正文与元数据分离、唯一包装 | 完整联合交付已APPROVED并采用到实际根目录。Runtime唯一外壳/编码、Host解码一次，R1回车保真已关闭；六组标准XML/实际Host逐字符一致，联合Host预览13项通过，根实际解析器与被测产物相同。用户随后提供的本轮页面体验报告已签收，独立工程测试与用户报告分别记录 | [联合验收与根采用](SRT/SRT-02_03_07_COMBINED_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md)、[View独立裁决](MINIMAL_CORE/MINIMAL_CORE_VIEW_PIPELINE_FINAL_REVIEW_2026-11-08.zh-CN.md) |
| SRT-08 | 一个 App 声明／命名／观察／投影失败后，其他 App 仍可用；失败 App 有诊断并清理准备资源；不输出假正常或半套错误能力 |
| SRT-06 / SRT-14 | 正式包不安装具体 Driver 即可消费；安装集成后来源和释放语义不变；普通 TS 与 Preact 满足同一合同 |
| SRT-10 | 错误／结果模型与初始化诊断 | 已APPROVED并采用。INIT/OPEN本地诊断保留，ToolResult改为成功／失败判别联合及JSON错误记录，复用既有捕获和IPC边界；none／partial／unknown与未进入handler的区别保持，非法结果后不自动重试。生产消费者、类型负例及真实Worker六种结果已验证 | [最终完整验收](SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)、[4.1](#result-errors) |
| SRT-11 | 重复转换、Schema 编译、复制与缓存 | 已APPROVED并采用。沿用测量支持的recheck减法和236项独立验证；补齐时钟10→9拒绝→10恢复观察及调用、关闭后scope／lease／bytes归零检查。没有无据缓存或普遍提速承诺 | [最终完整验收](SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)、[既有测量验收](MINIMAL_CORE/MINIMAL_CORE_SRT11_REVIEW_2026-11-09.zh-CN.md)、[4.7](#conversion-performance) |

正文保真完整候选已通过工程验收并进入联合整合；错误与性能低优先级，并发与资源整体重设计暂缓。各项合同和修复范围遵循对应正文，不把本表视为全量立即实施任务。


**统一 TypeScript 最新稳定版候选（2026-11-08）。** [隔离迁移报告](review-evidence/typescript-unified-latest-20261108/REPORT.zh-CN.md)已提交独立复核：864 源输入、40 文件变更，携带已签收 r02 预算修复；11 个直接编译器声明固定 7.0.2，11 份 pnpm lock 正常重新解析（10 个直接 compiler importer），无无关版本新增。Runtime／SDK／Driver／adapter／Host 源码编译通过；源码依赖复用与 skipLibCheck:true 均明确标记，未冒充完整消费者门禁。新四包 tar 的两个正常 npm lock/ci/ls 消费者通过，Core/SDK 445 文件与完整图477文件逐字匹配；SDK/Core严格正向、原9负例和独立31作者负例、386 Core/CLI回归通过。4个旧Demo的55/24/9/11条旧SDK入口诊断在TS5.9同图对照复现，不宣称Demo通过。整套迁移仍未准出：SDK正常frozen开发依赖安装后的TypeScript ESLint解析器实际失败；IDE ts-jest/旧tsserver接口尚不兼容；完整Driver正常消费者仍8条Tool声明错误。新TS7构建产品包已获[精确有限运行准入](MINIMAL_CORE/MINIMAL_CORE_TS7_DUAL_PRODUCER_ADMISSION_2026-11-08.zh-CN.md)，我方随后完成普通TS/SDK Worker各22真实调用（14成功/8拒绝），与r03逐项一致，正常关闭无强杀；[新增原始结果](review-evidence/typescript-unified-latest-20261108/DELIVERY.zh-CN.md)已交独立复验，整体工具链仍未准出。下一条执行指令是独立核对本候选并有限验证新产物，随后按官方现有能力提交lint/IDE最小兼容方案、真实依赖图和维护成本；不静默降级、删功能或降低严格检查。


**官方开发工具方案的隔离诊断。** [具体方案和实际依赖图](review-evidence/typescript-unified-latest-20261108/official-tooling-options/OPTION.zh-CN.md)使用Microsoft官方并行包：native编译器7.0.2、官方JS API兼容包6.0.2（底层6.0.3）、当前parser/plugin8.72.1。新正常npm lock/ci/ls通过，原SDK lint配置逐字复制后最小正例通过，unused仍error、any仍warning。28件独立诊断清单已封存；原279项TS7候选和864源码保持不变。该结果仅证明一种可审查的开发工具方案，尚未采用，不表示Jest/IDE或完整lint已通过；额外API依赖、入口归属、约24.3MB文件量及维护成本已列明。下一步先技术审查限定范围，不重新询问最新稳定编译器决定，也不静默把公开门禁改用旧编译器。

**TS7 最新独立状态与开发工具收尾（2026-11-08）。** [首轮独立复核](MINIMAL_CORE/MINIMAL_CORE_TS7_REVIEW_2026-11-08.zh-CN.md)已批准限定构建、严格 Core/SDK 消费与两条 Producer 的实际运行；负责人独立 386 回归、443 dist 和各 22 调用通过，完整 Driver 图仍独立复现相同 8 条 TS2344。后续 [SDK 工具四文件增量交付](review-evidence/typescript-sdk-tooling-20261108/REPORT.zh-CN.md)已经封存 266 件并交独立终审：正常仓库外 frozen 安装后的四包构建通过，adapter 使用自己声明范围内的 @types/node 20.19.43；443 dist 与原 TS7 tar 全等。新 SDK tar 仅说明和开发元数据改变，新正常 npm 消费者的运行图没有 API6；直接原生 TS7 严格 Core/SDK、9 项参数约束及作者正向/31独立负向通过。SDK 原 lint 命令检查全部33文件，完整诊断与TS5.9同源码有效基线一致，仍为3693错误/110警告，不能写成lint全绿。现有 M4 封存采集增加实际平台原生二进制身份，完整离线准备及正反身份检查通过，零模型调用。Jest 沿用原 IDE 配置的合成2正例通过，TS7及ts-jest都拒绝TS2322负例，不代签IDE原测试。原始未完成安装和LSP准备脚本导入错误分别保留；最终LSP入口仅 --prepare 通过、未启动服务。现已获[正式独立限定批准](MINIMAL_CORE/MINIMAL_CORE_TS7_SDK_TOOLING_REVIEW_2026-11-08.zh-CN.md)：四文件、正常开发安装与构建、M4身份、Jest合成诊断分别签收；负责人另独立正常安装并核对445包文件、31负例、9项去抑制真实错误，签署前再次核对266项和864源未变。[原生LSP入口已获独立准入](MINIMAL_CORE/MINIMAL_CORE_TS7_NATIVE_LSP_ENTRY_REVIEW_2026-11-08.zh-CN.md)，首次一次实测七项通过，但未知方法返回-32600/InvalidRequest与规范期望-32601不同，恢复hover和正常shutdown未执行；SIGTERM后实际进程组释放，七次FSEvents启动失败单列为外部监听未验证。[首次失败26项证据](review-evidence/ts7-native-lsp-run-20261108/REPORT.zh-CN.md)已冻结；对应固定提交源码确认该返回，当前IDE一般查询失败映射不依赖这两个码。当前下一条指令：[限定r02入口](review-evidence/ts7-native-lsp-r02-entry-20261108/PROPOSAL.zh-CN.md)独立复核后只执行一次；唯一修改是精确断言-32600且消息InvalidRequest，错误恢复及正常关闭要求保留，协议偏差不作规范通过。生产IDE尚未修改。原279/28件输入及864源基线保持不变。另已[复查正式上游补丁](review-evidence/ts7-upstream-release-recheck-20261108/REPORT.zh-CN.md)：AI6.0.325/provider-utils4.0.65在无AOTUI正常消费者、原生TS7严格检查下仍逐项复现8条TS2344，未改生产依赖或放行完整集成。



**原生 LSP r02/r03 失败定位（2026-11-08）。** [r03 准入与 r02 独立失败裁决](MINIMAL_CORE/MINIMAL_CORE_TS7_NATIVE_LSP_ENTRY_REVIEW_R03_2026-11-08.zh-CN.md)确认 r02 的8项通过及探针显式undefined被JSON-RPC编码为[null]的问题，独立内存wire六项通过；生产client原本正确，无需为探针改生产。获准的r03只修两处wrapper，实际shutdown返回null、exit被服务收到，但原生7.0.2自行code1/signal null退出、stderr context canceled；无强制信号，实际进程组已释放。完整[25项r03失败证据](review-evidence/ts7-native-lsp-r03-entry-20261108/execution/REPORT.zh-CN.md)已封存，正常关闭仍失败；固定源码EOF/取消/CLI传播与观测一致，未修改上游。r01七次、r02/r03各十次FSEvents警告分别保留，不认定外部监听健康。下一条指令：独立消费者一次复核同一r03，形成阻断裁决；不把code1改成成功，不实施[尚待准入的三模块方案](review-evidence/ts7-native-ide-scope-20261108/PROPOSAL.zh-CN.md)。正式AI6.0.325/provider-utils4.0.65的八条TS2344也已获[独立诊断复核](review-evidence/ts7-upstream-release-recheck-20261108/owner-review/REVIEW.zh-CN.md)，完整集成继续未准出。SDK四文件增量的独立限定批准保持。


**2026-11-08 最新串行语义准备。** [原生LSP最终独立裁决](MINIMAL_CORE/MINIMAL_CORE_TS7_NATIVE_LSP_FINAL_REVIEW_2026-11-08.zh-CN.md)正式确认双边8项/14请求、shutdown null后自行code1、无强杀且组已释放，原生IDE迁移不准出。SDK四文件限定批准保持。已按[只读任务](MINIMAL_CORE/MINIMAL_CORE_SRT_04_05_READONLY_TASK_2026-11-08.zh-CN.md)完成[26项SRT-04/05准备](review-evidence/srt-04-05-readonly-20261108/REPORT.zh-CN.md)：22对候选/共享源码，8相同14不同，明确四时点与现有owner、失败/预览/在途/共享数据。首选复用现有Context和Scope的显式框架采用及最后合法hold释放；API草图和历史完整数据退出均属待决定差异，未实施。下一条指令：独立复核事实及最小方案，形成精确公开API/迁移diff和所有者决策材料，不重问已确认目标，不让Driver/LSP外部阻断变成全部主线停工。


**2026-11-08 SRT-04/05 具体材料已提交。** [只读独立复核](MINIMAL_CORE/MINIMAL_CORE_SRT_04_05_READONLY_REVIEW_2026-11-08.zh-CN.md)以 R1（跨轮 Scope 的防重记录累计）和 R2（多 App/来源缺少整体失败保留旧资格的依据）裁定 CHANGES_REQUESTED；已核实的盘点继续复用。已按[下一任务](MINIMAL_CORE/MINIMAL_CORE_SRT_04_05_API_DECISION_TASK_2026-11-08.zh-CN.md)提交[6项具体方案](review-evidence/srt-04-05-api-decision-20261108/DECISION.zh-CN.md)，manifest SHA256 e4f15fbdea51369a7aef111eb36918ab47b3c19754576556ca58c5aec9293895。推荐显式 Core 采用＋Driver 每轮 finally 释放，给出准确接口、单 Scope／多 App／多 Source 失败状态、真实 renderer 完成接线、容量/旧 prepared/实际在途/TTL惰性清理边界、说明用迁移 diff 与未来验证矩阵；67条未来文件名单包括生产、现有消费者测试和文档，不是本批改动。材料待独立复核；未应用补丁、未类型检查、未跑新行为/TS/LSP/Host/模型，原封存输入保持。下一条指令：独立裁决具体材料，若有阻断限定修订；材料充分后再提交真正的公开合同选择，不把方案批准冒充实施批准。

**2026-11-08 最新执行调整。** 项目所有者明确要求“不要过度防御，不要提前深入到细节里，代码开发的任务请交给 Clean”。已核对 Clean 的原 SRT-01 G3 工程收口状态，并将 [SRT-04 最小实现任务](SRT/SRT-04_CLEAN_TASK_2026-11-08.zh-CN.md)交接给该聊天（local/01a1834f-f8f0-7692-ab43-3c66d959648f）。Owner 停止继续细化 API r02，将其标为[未封存参考](review-evidence/srt-04-05-api-decision-20261108/r02/DRAFT_STATUS.zh-CN.md)，不把草图作为开工门槛。Clean 负责隔离实现与必要测试，Owner 管范围、质量及下一步；已与 Minimal Core Owner 协调生产文件归属。下一条执行指令：Clean 完成提交后刷新小片并交实际 patch，Owner 根据代码做独立复核；不把 SRT-05 大套 API 设计并入本片，不重做两项 TS 上游阻断。

**2026-11-08 SRT-04 实际交付进入独立复核。** Clean 的[隔离r01](.tmp/srt-04-clean-20261108/REPORT.zh-CN.md)已完成实际代码与相关验证，Owner独立核对源码、补丁和完整交付身份一致，[核对记录](review-evidence/srt-04-clean-owner-20261108/identity.json)仅证明身份，不冒充行为复验。已送 Minimal Core Owner 审查实际patch和必要行为；当前状态为独立复核中，尚未接受本片。执行方报告的SDK默认全量单项Ref旧断言失败保留：原基线171过1失败，本片173过同一失败；按SRT-02已认可的multiple/optional Ref行为处理归属，不在此抹除。下一条执行指令：独立裁决；若有具体阻断交Clean限定修复，修复后复核，不重做无关工具链矩阵。

**SRT-04 实际复核阻断及修复派工。** 独立复核方在全新目录完成11步重放；随后[对照反例](review-evidence/srt-04-clean-review-20261108/sdk-act-refresh-repro.test.tsx)复现：act内初始化组在渲染队列未释放、正文/Ref/Tool仍为旧值时，whenProjectionCommitted提前完成；普通初始化控制组正常等待。[原始事实](review-evidence/srt-04-clean-review-20261108/sdk-act-refresh-facts.json)及日志保留。Owner已将此实际问题交Clean在新r02限定修复，原r01冻结；SDK旧Ref断言按独立测试增量处理。[正式独立裁决](MINIMAL_CORE/MINIMAL_CORE_SRT_04_CLEAN_REVIEW_2026-11-08.zh-CN.md)为CHANGES_REQUESTED，仅此已复现问题阻断；另25项既有Worker回归通过。当前不批准SRT-04，下一条指令为Clean修复并提交精确候选，Minimal Core Owner复核实际差异及回归。

**2026-11-08 SRT-04 工程收口。** [r02交付](.tmp/srt-04-clean-r02-20261108/REPORT.zh-CN.md)与[正式独立批准](MINIMAL_CORE/MINIMAL_CORE_SRT_04_CLEAN_R02_REVIEW_2026-11-08.zh-CN.md)的源码、补丁和包身份一致，Owner核对34份独立证据及12份轻量交付指纹后接受精确隔离实现；[收口记录](review-evidence/srt-04-clean-owner-20261108/r02-identity.json)。r01原失败不改。旧Ref单测试迁移同时限定批准，SDK默认全量由独立178/178证明，未重跑无关工具链。下一条执行指令：Clean实施SRT-05串行观测交接小片；Minimal Core侧并行核对SRT-08当前事实与既有测试，发现代码缺口后仍交Clean。共享采用、发布和项目所有者最终Semantic验收未包含。

**2026-11-08 用户根目录Ref验收入口缺口。** 用户在Clean聊天明确从共享根运行`./run.sh`仍看到plan_id/task_id。Owner读取原始反馈并核对：共享树、SRT-04 r02和SRT-05当前基线的`planning-tools.ts`均为SHA256 `985dca540117cd192902a4f1891babc9e5b8a01d238fb921a930190f3915beb2`，RootView均为`c489ae019f6323b62ab97cf12727f8c90de1906d305fee53a01f82c09fe28da5`，仍是业务ID合同；run.sh重新链接并构建根目录包。[已批准Planning Ref迁移](MINIMAL_CORE/MINIMAL_CORE_TYPED_REF_AND_PLANNING_REVIEW_2026-11-06.zh-CN.md)没有纳入后续统一基线，不能仅解释成用户未切隔离目录。这是Owner整合责任。已将[实际运行入口整合](SRT/SRT-02_PLANNING_RUN_INTEGRATION_TASK_2026-11-08.zh-CN.md)派给Clean，当前SRT-05限定交审后优先执行，目标为用户原命令实际得到Ref合同；当前未更改共享运行入口，不声称已可验收。

**2026-11-08 SRT-05 工程收口。** [正式独立裁决](MINIMAL_CORE/MINIMAL_CORE_SRT_05_CLEAN_REVIEW_2026-11-08.zh-CN.md)为APPROVED；Owner已核对最终870件源码清单、50路径补丁、四包及独立输入与裁决一致，见[收口记录](review-evidence/srt-05-owner-20261108/identity.json)。独立Core/Receiver1159/1159、Driver采用3/3及公开类型/真实Worker/Source通过；执行者Runtime2040/2040、SDK178/178、Adapter46/46属于相应完整回归，不与子集重复累加。原失败、C06存量fixture迁移及上游严格类型/LSP边界保留。Clean已从该精确父基线开始Planning Ref与根目录run.sh整合；这是当前唯一执行优先项，共享采用及用户重启结果尚待完成。

**2026-11-08 根入口完成与推进方式调整。** [根入口报告](.tmp/planning-run-ref-root-verification-20261108/REPORT.zh-CN.md)经[独立关闭](MINIMAL_CORE/MINIMAL_CORE_PLANNING_RUN_INTEGRATION_REVIEW_2026-11-08.zh-CN.md)APPROVED：真实根9模块构建、GUI构建、17解析和27次Ref调用符合预期，447核心产物与批准候选一致；334路径采用加2份已批准退役遗留删除均核对，私人状态和Git身份未改。用户可结束旧Host后原./run.sh重启，人工模型验收另记。项目所有者要求改为完整任务交付后一次验收：Clean连续完成[Ref全链与退役收口](SRT/SRT-02_COMPLETE_DELIVERY_CLEAN_TASK_2026-11-08.zh-CN.md)；Minimal Core指定执行agent连续完成[View语义与唯一包装](MINIMAL_CORE/MINIMAL_CORE_VIEW_PIPELINE_DELIVERY_TASK_2026-11-08.zh-CN.md)。两者分工清楚，日常修复自主完成，不再逐小片停工等审；Owner收到完整交付后集中验收，并一次汇总缺陷。SRT-09及低优先级治理不混入当前两项任务。
