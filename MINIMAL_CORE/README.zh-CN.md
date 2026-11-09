# Minimal Core 当前进度

**2026-11-09 Minimal Core本线已授权工程任务全部完成，状态APPROVED_ADOPTED。** 原计划、后续明确承接任务和追加清理均已完成相应开发、独立复核及采用；最后M5／R4与M8／R6两项也已实际落到根目录。MC Owner重新核对19路径与批准after一致，Clean62路径的组合结果完整保留，实际根Runtime／SDK／IDE构建全部通过。本线无剩余开发、复核或采用项，不新增批次，不需为工程收尾重复人工验收。正式发布仍由项目所有者决定，本次没有提交、推送或发布；未来专项不计作本线未完成任务。

最后两项消除Worker逐调用参数编译，修复IDE随包入口、测试及文档，并删除旧启动包装；生产净减131行。原实现独立109项测试、随包终端9场景通过，最终组合另由MC Owner独立运行74项注册／真实Worker测试、核对522件当前安装文件通过；执行方当前组合255项及终端9场景直接复用。见[本线裁决与结案补记](MINIMAL_CORE_REMAINING_WORK_REVIEW_2026-11-09.zh-CN.md)、[原计划逐项对应](MINIMAL_CORE_REMAINING_WORK_2026-11-09.zh-CN.md)、[实际采用记录](../SRT/MC_PLAN_CLOSURE_OWNER_ADOPTION_2026-11-09.zh-CN.md)与[MC最后状态核对](../review-evidence/minimal-core-plan-closure-20261109/owner-review/adoption-confirmation.json)。

**2026-11-09 职责与完成结论更正。** 本页记录Minimal Core开发线，由MC Owner组织指定Minimal Core执行Agent开发，并负责本线独立复核；范围依据[Minimal Core原计划](MINIMAL_CORE_REFACTOR_PLAN.zh-CN.md)、后续明确承接的任务和项目所有者最新授权。SRT整条线由Clean Owner（文档中的SRT Owner）负责组织、验收与总进度；两线的相关任务和历史协作有交集，不代表SRT-01～SRT-15整体分配给MC Owner。

此前本页和聊天将“SRT整体完成”用于回答“MC被分配的工作是否全部完成”，归属与判断依据混淆，现撤回该笼统结案表述。[SRT最终验收](../SRT/SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)是另一负责人的整体结论，只作为关联成果引用；上次118路径核对是采用状态确认，不是MC对Clean交付的第二轮代码审查，也不能代替MC原计划的逐项完成核对。各批已完成的代码、独立批准和采用事实继续有效。

**本线最近两轮追加清理已完成开发、MC独立复核及实际采用。** 19路径清理生产净减1769行，14路径清理生产净减311行；合计生产净减2080行、删除12个文件和4个专属依赖。下文列出各自依据。MC历史任务按各自任务／裁决记录判断，不能把两轮完成扩大为本线原计划所有项目的结论。Clean后续完成的facades/index退出及最终合同迁移归其开发线，不计为MC新增交付。

**2026-11-09 内核第二轮减法已独立 APPROVED 并采用实际目录。** 指定MC执行Agent完整交付14路径，删除5个生产文件、生产净减311行：ArrayRef重复记录、LLM转发包装、无生产调用的Desktop DOM观察器，以及固定两规则之外的visitor注册／排序／回退层退出。MC Owner核对实际源码差异、独立重放补丁和431个安装文件，独立82项相关测试与正常安装包两次真实Worker调用／关闭通过；执行方完整Runtime2089、SDK187及构建／严格类型直接复用。SRT Owner已选择性采用14路径、根Runtime／SDK构建通过；MC Owner重新核对14项与批准after一致。见[独立裁决](MINIMAL_CORE_KERNEL_CLEANUP_REVIEW_2026-11-09.zh-CN.md)与[采用记录](../SRT/SRT-15_KERNEL_CLEANUP_OWNER_ADOPTION_2026-11-09.zh-CN.md)。额外facades/index转导出退出已由Clean随完整合同交付收口，不留待后续小批。

**2026-11-09 升级后旧代码清理已独立 APPROVED 并采用实际目录。** 指定执行Agent完整交付19路径，删除7文件和4个专属依赖，生产净减1769行；旧IDE全局文件／LowDB／LSP链退出，当前会话、历史导入、文本替换与关闭责任保留，Runtime只删除冗余记录字段。MC Owner整项核对实际差异及三包555件安装文件，独立13项相关测试、5组真实Worker场景／44调用和3次资源释放通过；执行方Runtime2092、SDK187、IDE63及相关集成结果直接复用。SRT Owner已采用19路径，IDE冻结安装、Runtime／IDE构建通过；MC Owner重新核对实际根19项after全部一致。详见[独立裁决](MINIMAL_CORE_POST_UPGRADE_CLEANUP_REVIEW_2026-11-09.zh-CN.md)和[实际采用](../SRT/SRT-15_POST_UPGRADE_OWNER_ADOPTION_2026-11-09.zh-CN.md)。此轮已收口，下一轮见本页顶部；整份SRT其余目标继续由SRT Owner维护，不把本项完成等同于整体完成。

**2026-11-09 当前 Runtime／SDK 完整回归已 APPROVED／NO_CHANGE。** Runtime 131 文件2092项、SDK 20文件187项全部通过，0失败／跳过／todo；两包构建和两项严格公共类型检查通过。MC Owner独立核对428输入、410产物、真实包解析和全部原始断言，当前共享根与候选一致；未重复运行矩阵，无需生产采用。详见[完整裁决](MINIMAL_CORE_FINAL_CORE_REGRESSION_REVIEW_2026-11-09.zh-CN.md)。此前清理和作者试用签收保持。

**2026-11-09 前一阶段已批准工程任务已完成。** Clean的工具链／IDE／Host完整交付及限定增量已由SRT Owner唯一复核并采用根目录，33路径及三处冻结安装、原run.sh九模块构建、Host GUI和严格类型全部通过；Owner独立6次Driver→Worker→IDE实际调用与关闭释放通过，见[正式采用裁决及G0–G7映射](../SRT/SRT-06_TOOLCHAIN_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)。本页直接沿用结论，不追加复核或矩阵。该批无工程阻断或新增人工前置；精确临时补丁、darwin-arm64原生资格、未发布边界明确。此结论不覆盖整份SRT长期目标，新增清理见本页顶部。D3取消及已暂缓／未来设计保持原决定。

**2026-11-09 SRT-14 新上下文作者试用已独立 APPROVED／NO_CHANGE。** 一个作者只凭当前公共材料和固定 SRT-13 安装包完成书签 App，初稿一次构建通过、零修复、零私有 API。负责人核对作者实际活动、独立严格重编 App／Host并运行真实 Worker，10 帧与11调用通过：8成功、1预期业务拒绝、2旧观察拒绝，完整页面消息与调用结果对照一致，资源归零。没有具体文档或内核缺口，公共材料与生产保持 NO_CHANGE。SRT Owner 已接受限定结论并更新唯一索引，本轮作者试用关闭，无生产采用或新增人工验收。[完整独立裁决](MINIMAL_CORE_SRT14_AUTHOR_REVIEW_2026-11-09.zh-CN.md) · [Owner 收口](../review-evidence/srt-14-owner-acceptance-20261109/acceptance.json)。

**2026-11-09 SRT-15 剩余冗余清理已独立 APPROVED 并采用到根目录。** 20 路径净减 191 行，删除 SDK 无读取计数／引用及四个内部转导出文件；真实 View 身份、挂载释放与公开入口保持。负责人重放 423→419 输入，独立 160 项、两项严格类型和两包构建通过；六入口值导出相同。Owner 已采用 20 路径、根 Runtime／SDK 构建通过，负责人核对 16after、4源码删除、12旧产物退出及20份before备份。本批没有新增人工签收对象；接续 SRT-14 已有作者验证的整项验收。[完整独立裁决](MINIMAL_CORE_SRT15_REVIEW_2026-11-09.zh-CN.md) · [根采用](../SRT/SRT-15_OWNER_ADOPTION_2026-11-09.zh-CN.md)。

**此前已派发的清理与作者试用已收口。** SRT-13协议整理、SRT-15剩余清理已采用，SRT-14作者试用已通过；最终组合回归与工具链集成亦已完成，统一见本页顶部与[唯一索引](../deepseek_review.md)。没有待修订的本轮工程项，不将未来产品／架构设计或未授权发布写成已完成。

**2026-11-09 SRT-13 当前协议与兼容合同收口已独立 APPROVED 并采用到根目录。** 七路径中仅三个 Runtime 生产文件把五处持久化标识复用原常量，另补拒绝测试和当前九类合同说明；不新增协议、公共导出或作者概念。负责人重放 423 个输入、重建两包，136 项相关测试与 44 条协议输出通过；Owner 七路径采用、根 Runtime／SDK 构建通过，负责人已核对 after 与 before 备份。已有人工签收保持，无新增人工前置。[独立验收](MINIMAL_CORE_SRT13_REVIEW_2026-11-09.zh-CN.md) · [根采用](../SRT/SRT-13_OWNER_ADOPTION_2026-11-09.zh-CN.md)。

**2026-11-09 Host预览完整任务已APPROVED并采用到根目录。** 七路径修复持续刷新、迟到读取、Topic/实例隔离及监听清理；首轮三项生命周期问题一次汇总修订后全部关闭。负责人独立77项维护测试与三个原始反例通过，Owner采用七路径并通过根Host main/preload、GUI构建，未追加行为矩阵。真实Electron/用户GUI本轮未重跑，旧事故材料与已有Planning/Ref人工签收保持；本项工程交付已关闭。[最终独立验收](MINIMAL_CORE_HOST_PREVIEW_FINAL_REVIEW_2026-11-09.zh-CN.md) · [实际采用](../SRT/MC-HOST-PREVIEW-01_OWNER_ADOPTION_2026-11-09.zh-CN.md) · [保留的首轮失败](MINIMAL_CORE_HOST_PREVIEW_REVIEW_2026-11-09.zh-CN.md)。

**SRT-11已APPROVED并采用根目录。** 完整测量后只删除授权返回后紧邻的第二次复核，必要检查保留；另一文件补八项授权边界测试。负责人集中审查并独立通过236项相关测试，核对原始次数与计时边界；Owner采用两文件、根Runtime构建通过，没有重复行为矩阵。减少重复工作已被证明，整体明显提速未被证明，不开启第二轮性能项目。[独立验收](MINIMAL_CORE_SRT11_REVIEW_2026-11-09.zh-CN.md) · [实际采用](../SRT/SRT-11_OWNER_ADOPTION_2026-11-09.zh-CN.md)。

**2026-11-09 SDK作者入口与示例整项验收：APPROVED，24路径已全部采用到实际根目录。** 交付统一当前指南、skill、单一声明及完整可运行示例，修正旧调用地址、候选叙述、Core签名和Host漏采用示例。负责人一次集中审查、实际重放24路径，并在新正常消费者独立编译运行安装包中的README／文件／Ref／普通TS／Core／Host示例；四包490文件全等，四Runtime资源释放。生产内核、API、版本和依赖未改；51项SDK相关回归及四包构建复用执行方证据。SRT Owner按24目标before／after采用、备份20原件，未增加第二轮复核或行为矩阵；旧人工签收保持。[完整裁决](MINIMAL_CORE_AUTHOR_DELIVERY_REVIEW_2026-11-09.zh-CN.md) · [实际采用](../SRT/SRT-12_AUTHOR_DELIVERY_OWNER_ADOPTION_2026-11-09.zh-CN.md)。

**2026-11-08 INIT／OPEN诊断缺口已完成，APPROVED并采用到根目录。** Clean完整交付的10个Runtime路径经SRT Owner集中验收采用；原始错误与阶段通过既有cause链保留，公开结果和资源清理边界保持。Clean最终相关134项通过，Owner根Runtime／SDK构建和5项关键真实Worker检查通过；此前一次默认套件2080通过／2失败及后续修正定向证据分别保留，未声称最终默认全绿。Minimal Core沿用集中验收结果，不追加复核。通用错误模型等其余事项仍为TODO。[正式验收](../SRT/SRT-10_INIT_ERRORS_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md) · [实际诊断指南](../runtime/docs/initialization-diagnostics.md)。

**2026-11-08 最新：Ref按View定位已完成，APPROVED并采用到实际根目录。** View展示保留`[设计阶段](Phase:completed_phases[0])`和整数组的`Phase[]:`类型提示；调用使用`plan_b.completed_phases[0]`或`plan_b.completed_phases`，不带类型前缀。Clean整项交付后，SRT Owner集中验收并采用40路径，共用Desktop提示和Planning说明同步迁移。Owner原九模块构建、同类型双View的实际SDK→Worker→Source链路、SDK17项相关用例和Planning27次调用通过；Minimal Core沿用该结论同步进度，不追加复核。结束旧Host后原`./run.sh`即可使用。前一批人工签收保持；`.field`、数据作用域、基础类型及其他name/id治理仍为TODO。[正式验收](../SRT/SRT-09_VIEW_REFS_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md) · [唯一范围SRT-09](../deepseek_review.md#identity-governance)。

**2026-11-08 最新：工具定义与页面精简已完成，APPROVED并采用到实际根目录。** Clean已整项删除SDK／Runtime的`isMutating`分类，完整定义与Schema只进入Context Tools；Root从同一声明按ViewType列名，Planning数据页面仅呈现业务状态与Ref。SRT Owner集中验收、原启动构建及根Planning27次调用通过，17次观察确认页面不重复工具定义且Tools保留Schema。本轮工程验收结束，Minimal Core沿用该集中结论并同步状态，不追加复核或重复测试。结束旧Host后原`./run.sh`即可体验；最终Semantic人工验收及其余独立事项保持原状态。[正式验收](../SRT/FEEDBACK_TOOLS_01_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md) · [唯一任务状态](../deepseek_review.md#review-todos)。

**2026-11-08 最新：Ref＋View联合交付已完成根目录采用，APPROVED／ROOT_ENTRY_VERIFIED_OWNER_ACCEPTED，可以启动完整新版进行人工验收。** SRT Owner已集中审查并采用134路径，完成根目录十模块依赖安装、原九模块及GUI构建、491份产物匹配、17处包解析和Planning27次调用；Minimal Core负责人另行核对134路径当前源码、正式裁决及Git身份一致。View与Ref均已落到实际入口，先前“待整合／尚未采用”的记录为历史阶段。结束旧Host后，继续从仓库根目录运行原`./run.sh`。真实模型体验和所有者最终Semantic验收待完成；SRT-10两项既有诊断失败、Driver／LSP等边界继续单列。[联合工程验收与根入口记录](../SRT/SRT-02_03_07_COMBINED_OWNER_ACCEPTANCE_2026-11-08.zh-CN.md)。

**2026-11-08 View整项最终验收：APPROVED_FOR_COMBINED_INTEGRATION，无剩余View阻断。** 唯一R1回车保真问题已在现有消息边界修复，负责人原反例、48项View＋13项Host、正常包严格类型、12次实际调用及六组XML／Host逐字符对照通过；905源码累计重放一致。原整项316项回归与九模块构建对未改输入继续有效。Ref完整候选也已获批准，两项成果已交Clean集中整合匹配包、消费者及原启动链，再由SRT Owner一次验收和采用；当前尚未将这两份新成果采用到共享入口。[最终裁决](MINIMAL_CORE_VIEW_PIPELINE_FINAL_REVIEW_2026-11-08.zh-CN.md) · [完整联合任务](../SRT/SRT-02_03_07_COMBINED_DELIVERY_CLEAN_TASK_2026-11-08.zh-CN.md)。

**2026-11-08 View完整交付统一验收：CHANGES_REQUESTED，仅一项正文回车保真遗漏。** 92路径完整差异已审，905源码实际重放一致；负责人独立九模块构建、316项相关回归、正常包严格类型及12次运行通过，447dist／483安装文件一致。CRLF正文经标准XML解析变为LF的反例已保留，统一交执行agent修订；其余未改证据复用，不恢复逐小片审批。共享采用与最终Semantic尚未完成。[完整裁决及修订Prompt](MINIMAL_CORE_VIEW_PIPELINE_REVIEW_2026-11-08.zh-CN.md)。

**2026-11-08 最新：Planning Ref 已接入真实根目录并完成工程验收，APPROVED。** 334路径实际采用、两份已批准退役残留删除、17条模块解析及447件核心产物已独立核对；真实根目录原run.sh的9模块构建、GUI bundle和27次Worker调用通过。可结束旧Host后按原命令重启手测，真实模型及最终Semantic验收另计。按所有者最新要求，后续改为完整任务交付后统一验收：由指定Minimal Core执行agent连续完成SRT-03＋SRT-07与相关App、文档、测试和构建整合，不再逐小片审批。[根入口裁决](MINIMAL_CORE_PLANNING_RUN_INTEGRATION_REVIEW_2026-11-08.zh-CN.md) · [完整开发任务](MINIMAL_CORE_VIEW_PIPELINE_DELIVERY_TASK_2026-11-08.zh-CN.md)。

**2026-11-08 Planning Ref 运行入口整合独立复核：APPROVED，可由 Owner 逐文件采用；根入口验证尚待完成。** 相对已批准 SRT-05 的30路径、872件最终源码已独立重放一致；完整9包构建、四App必要测试、30项adapter集成、27次真实Worker调用通过。10个对象工具、页面和Root说明统一使用Ref；内核447件dist与批准父包一致。本轮解决既有应用遗漏，根目录累计334路径由Owner负责采用，不能把隔离通过写成用户入口已经更新。[正式裁决与下一步](MINIMAL_CORE_PLANNING_RUN_INTEGRATION_REVIEW_2026-11-08.zh-CN.md)。

**2026-11-08 SRT-05 串行观察交接独立复核：APPROVED，限定精确隔离候选。** 采用新观察撤销旧调用／Ref资格，无人持有的旧数据立即释放，预览和后台发布不换当前资格；复用现有Core、Scope与Driver每轮释放。负责人独立重放最终50路径补丁、核对870文件，Core／Receiver 1159/1159、Driver 3/3和正常四包的严格类型／普通TS／真实Worker／真实Source通过，三包独立重建一致；执行者Runtime全量2040、SDK178、Adapter46也通过。根目录Planning仍有已确认的整合缺口，Clean已直接进入既定Ref应用与`./run.sh`接线任务，Owner负责采用，Minimal Core复核；不能把隔离通过写成根入口已更新。[正式裁决](MINIMAL_CORE_SRT_05_CLEAN_REVIEW_2026-11-08.zh-CN.md) · [下一片任务](../SRT/SRT-02_PLANNING_RUN_INTEGRATION_TASK_2026-11-08.zh-CN.md)。

**2026-11-08 SRT-08 当前失败隔离核对：APPROVED，无需新增代码。** 当前 adapter 已有逐 App 准备、诊断与释放；现有 Source 单测和真实 Registry / Receiver 组合测试由执行方与负责人分别复跑，均为 42/42。健康 App 实际调用、失败准备释放、修复后恢复与最终清理成立，不再按旧共享树描述重复开发。主线继续由 Clean 实现 SRT-05 新旧观察交接，负责人审实际 patch。[SRT-08 限定裁决](MINIMAL_CORE_SRT_08_CURRENT_REVIEW_2026-11-08.zh-CN.md) · [SRT-05 实现任务](../SRT/SRT-05_CLEAN_TASK_2026-11-08.zh-CN.md)。

**2026-11-08 SRT-04 r02 独立复核：APPROVED，限定精确隔离实现；旧 Ref 单文件测试迁移也已通过。** 原 act 初始化漏等反例已独立转绿；SDK 全量 178/178、刷新 17/17、严格类型、正常安装包的双 Producer 与两个原有作者样例均通过，实际源码和新包一致。原 r01 失败保留；共享采用与最终验收未包含。下一片 SRT-08 当前失败隔离核对已交指定执行agent，先复用现有实现与测试，有真实缺口再修复。[r02 正式裁决](MINIMAL_CORE_SRT_04_CLEAN_R02_REVIEW_2026-11-08.zh-CN.md) · [下一片任务](MINIMAL_CORE_SRT_08_CURRENT_CHECK_TASK_2026-11-08.zh-CN.md)。

**2026-11-08 SRT-04 实际 r01 补丁独立复核：CHANGES_REQUESTED，限定修复已交 Clean。** 负责人独立重放 13 路径补丁，11 个复跑步骤以及 25 项既有 Worker 回归通过；在现有 act 初始化路径上另行复现“渲染未执行，完成等待已返回”，需要修复并补回归。SDK 多个／可选 Ref 的旧拒绝断言与基线一致，另作测试迁移处理，不混作本片新回归。下一步复核修复候选，不追加方案文档门槛。[实际依据、范围与下一批 Prompt](MINIMAL_CORE_SRT_04_CLEAN_REVIEW_2026-11-08.zh-CN.md)。

**2026-11-08 最新推进方式：目标和必要行为由负责人把关，代码与实现细节交给执行 agent。** 按项目所有者最新要求，未封存的 API r02 保留为参考草稿，不再作为小范围开发的前置门槛。当前 SRT-04 SDK/Runtime 提交后刷新已由另一负责人交给 Clean，按 [当前实现任务](../SRT/SRT-04_CLEAN_TASK_2026-11-08.zh-CN.md) 推进；本聊天后续开发交给所有者指定的 Minimal Core 执行agent，避免重复派发本片。负责人依据实际 patch、核心行为及必要测试独立复核；重大公开 API 采用仍基于具体差异交所有者决定。下列材料裁决保留历史事实，不表示必须先穷举实现细节才能开工。

**2026-11-08 SRT-04／05 具体 API 材料独立裁决：CHANGES_REQUESTED。** 推荐保留 Driver 每轮释放，及单 Scope 原子、组合部分失败的论证已回应前批 R1／R2；新增刷新仍需补超时后的真实占位、Preact 调度钩子与 act 作者验证的时序、手写 SPI 消费者分类，以及协议检查先于 unchanged 优化。六项材料及 67 项未来清单仅属提案，未应用或编译，执行方正按限定 r02 文档任务修订。[本轮裁决、具体依据与下一批 Prompt](MINIMAL_CORE_SRT_04_05_API_DECISION_REVIEW_2026-11-08.zh-CN.md)。

**2026-11-08 SRT-04／05 只读方案独立裁决：CHANGES_REQUESTED；已核实的现状盘点继续沿用。** 原 26 项输入、22 对源码（8 相同／14 不同）及容量／raw 解析补充保持封存。两项必补缺口：跨轮 current 会延长同一 Scope 的寿命，使收据 TTL 不会清除的调用条目／指纹／元数据跨轮累积；逐 Scope 同步采用也不能证明多 App／来源整体失败后所有旧资格仍保留。下一批仅补具体 API、生命周期选择、组合失败边界、迁移示例与验证矩阵；不改生产，不重跑 TS／LSP，不启动 Host／GUI／真实模型。注册所有权已有保护，不重复重建。SRT-04／05、共享采用和最终验收均未关闭。[正式独立裁决](MINIMAL_CORE_SRT_04_05_READONLY_REVIEW_2026-11-08.zh-CN.md) · [下一批范围与 Prompt](MINIMAL_CORE_SRT_04_05_API_DECISION_TASK_2026-11-08.zh-CN.md)。

**2026-11-08 当前推进：SDK 工具修复已独立限定 APPROVED；原生 IDE 后端因真实关闭失败为 CHANGES_REQUESTED，接下来进入 SRT-04／05 只读语义准备。** r03 在执行方和负责人各自正常安装中均通过八项能力检查、14 次请求；shutdown 正确响应后，服务收到 exit 自行 code 1 退出，无强杀且进程组已消失。双方 28 条完整协议请求／结果／错误一致，不能据此称为正常关闭。原错误码偏差、FSEvents 与前两次探针失败保留，三模块生产迁移未实施。Driver 上游新补丁的八条类型错误也已独立复现。[原生 LSP 最终裁决](MINIMAL_CORE_TS7_NATIVE_LSP_FINAL_REVIEW_2026-11-08.zh-CN.md) · [下一批只读范围与 Prompt](MINIMAL_CORE_SRT_04_05_READONLY_TASK_2026-11-08.zh-CN.md)。

**2026-11-08 SDK 开发工具最新独立裁决：四文件增量、正常开发安装、M4 原生身份和 Jest 合成诊断分别限定 APPROVED；完整工具链仍为 CHANGES_REQUESTED。** 负责人独立重放 864 件源码并核对 266 件冻结输入，四包正常 frozen 安装／构建、443 dist 一致；新公共消费者严格类型、31 作者负例和九项去抑制负例通过。原 lint 命令恢复运行，33 文件的 3693 errors／110 warnings 与旧有效基线逐项相同，不能称为 lint 全绿。Jest 仅证明两个合成正例和真实 TS2322 拒绝；IDE 原生 LSP 另行审查，Driver 八条严格类型错误、旧 Demo、共享采用和最终验收未关闭。[正式独立裁决、风险与下一批 Prompt](MINIMAL_CORE_TS7_SDK_TOOLING_REVIEW_2026-11-08.zh-CN.md)。

**2026-11-08 TS7 最新独立裁决：新产物的限定构建、Core／SDK 严格消费和双 Producer 运行 APPROVED；整套工具链仍为 CHANGES_REQUESTED。** 负责人独立重放 864 件源码、重建四包 443 份 dist、通过 386 项 Core／CLI；另在全新正常安装消费者重编译并运行普通 TS 与 SDK Worker，各 22 次调用，与执行方及前批完整参数／页面 witness／收据一致，正常释放。源码开发环境的 adapter 缺本地 Node 类型问题保留首失败，补显式依赖后产物一致。官方 TS7 构建＋开发工具 API6 的最小 lint 方案已在第二个正常消费者独立验证，仅批准下一批 SDK 开发环境隔离实施；全量 lint、Jest、IDE、Driver 8 条严格类型错误与完整迁移门禁未关闭。[独立裁决、风险、下一批范围与 Prompt](MINIMAL_CORE_TS7_REVIEW_2026-11-08.zh-CN.md)。

**2026-11-08 当前裁决：SRT-02 多 Ref／可选 Ref 的精确 r02 实现与 r03 入口限定 APPROVED。** 负责人独立重放 739 件源码、通过 381 项定向测试、重建 351 个 Runtime dist，并在正常安装的新消费者验证 445 个包文件与 TS 7.0.2 严格类型；九个去掉抑制注释的负向用法均产生对应真实错误。普通 TypeScript 与 SDK Worker 各 22 次实际调用（14 成功、8 派发前拒绝）在执行方和负责人各自消费者中通过，完整参数、缺席字段、只读路径、页面 witness 与短收据一致，正常关闭，无强杀。SRT-02 整体、共享采用、发布及最终 Semantic 验收仍未完成。[最终独立裁决、未覆盖风险与下一批 Prompt](MINIMAL_CORE_SRT_02_MULTI_OPTIONAL_FINAL_REVIEW_2026-11-08.zh-CN.md)。

r01 的临时参数预算误拒绝已通过一个生产文件修复；首次实际入口的列表 Ref 元数据错误仅改合成样例两处值。原 97／61／39 件封存输入、双方失败、撤回准入和修订均保留，不改写旧结论。[原生产缺陷复核](MINIMAL_CORE_SRT_02_MULTI_OPTIONAL_IMPLEMENTATION_REVIEW_2026-11-08.zh-CN.md) · [首次入口失败与撤回](../review-evidence/srt-02-multi-optional-candidate-r02-20261108/owner-review/run01-withdrawal.json)。

**2026-11-08 新工具链政策：项目所有者明确要求“统一升级到 TS 最新版本吧”。** 负责人已直接核对[原始人类授权](../review-evidence/typescript-unified-latest-20261108/owner-review/owner-authorization.json)及[官方稳定版 7.0.2 身份](../review-evidence/typescript-unified-latest-20261108/owner-review/version-identity.json)。全链统一工具链采用独立候选验证，旧 TS5.3.3／5.9.3 记录保持历史身份。当前多 Ref 候选的正常 TS7 公共消费已通过；全链开发工具迁移和 Driver 第三方严格 Tool 声明问题仍需单独收口，不能用主包源码编译成功替代完整准出。

**2026-11-07 限定裁决：SRT-06 B 独立薄适配包 r02 的限定迁移与 Runtime／SDK 独立消费 APPROVED；完整集成准出仍为 CHANGES_REQUESTED。** 隔离候选为`.tmp/srt-06-adapter-package-20261107/source-r02`，原 r01 保留。负责人独立重放 52 路径补丁，738／738 源码一致；从重放源码重建的四包 443 份 dist 与交付一致，66 项适配／Ref 来源测试、30 项跨包集成、三个启动脚本替身场景通过。两组仓库外新消费者经正常 npm ci／ls 安装通过，Runtime／SDK 不带 Driver，双版本严格类型、真实 Worker 与正常关闭通过；连接包四次 Ref／普通路径调用、最新 View 和正常关闭通过。

完整集成的正常发布依赖图仍有 TS5.3.3 的 51 条、TS5.9.3 的 8 条错误，负责人在同一安装图中仅导入 Driver，逐字复现全部诊断。这次 ai／provider-utils／zod 版本与历史 42／10 不同，不能混作同一输入。共享采用、发布与最终 Semantic 验收未获批准。[B 的独立裁决](MINIMAL_CORE_SRT_06_ADAPTER_REVIEW_2026-11-07.zh-CN.md) · [已选 B、利弊与边界](MINIMAL_CORE_RUNTIME_DRIVER_DECISION_2026-11-07.zh-CN.md) · [原始选择依据](../review-evidence/srt-06-adapter-package-20261107/owner-review/owner-selection.json)。

**已封存类型诊断：三组正常安装诊断与单点声明副本实验均已独立 APPROVED，仅批准诊断及列明根因。** 更换已测试依赖版本仍不能准出；在 zod3 精确图的新物理副本中只改一处第三方声明后，TS5.9.3 的三入口通过，TS5.3.3 原入口仍有 47 条错误，完整 Tool 试件另保留一条负向约束失效。负责人独立重放唯一 patch，完成 13 次编译检查并核对全部安装文件；原发布包没有被修复。此后编译器政策已按上文人类新决定更新，旧实验结论不追溯改写。[诊断裁决](MINIMAL_CORE_SRT_06_DRIVER_TYPE_DIAGNOSIS_REVIEW_2026-11-07.zh-CN.md) · [单点实验裁决、风险与下一批 Prompt](MINIMAL_CORE_SRT_06_DECLARATION_PROBE_REVIEW_2026-11-07.zh-CN.md)。

**已封存前批：旧 Snapshot Tool 清理形成可重放的隔离交付，限定实现与行为复核 APPROVED；完整准出仍为 CHANGES_REQUESTED。** 生产改删34件，包含8个旧文件删除，净减少1594行；候选为 `.tmp/srt-02-retirement-candidate-20261107/source`。负责人从418份冻结基线独立重放106路径补丁，加入已核指纹的只读测试输入后，最终412份源码全部一致。Core 1072/1072、SDK 170/170、真实 Worker／双 Producer 70/70均独立重跑通过；原失败与修正证据分别保留。[最终独立裁决、风险与下一批 Prompt](MINIMAL_CORE_SRT_02_RETIREMENT_REVIEW_2026-11-07.zh-CN.md)。

另73项 Worker与37项 Runtime集成通过，58个原行为测试文件和1个类型试件均有当前通过记录。负责人已独立验证新tar中的双版本Core精确教程、SDK正负类型、4次Ref／文件路径调用与正常Runtime关闭、1／10／100／1000页容量与释放；27份旧构建产物均已退出。17份当前文档已迁移，Ref主教程使用Note，文件编辑继续使用普通路径。完整门禁仍有两项未通过：正常包管理器离线安装缺少输入；适配入口在TS5.3.3／5.9.3完整严格选项下分别有42／10条错误，仅导入冻结Driver即可逐条复现。解包与本地依赖组装不替代正常安装；类型失败也不因行为通过而豁免。该冻结基线的Source仍位于Runtime，后续B迁移使用新的副本，共享生产未采用本候选。

方案文档保留现有Driver子入口、独立薄适配包、Host内部模块的历史比较。此次选择B，接受一个额外发布单元的维护成本，保留现成Source的公共分发，同时让Runtime和Driver各自独立。B现有自己的精确补丁与包消费者独立复核；原Driver `./aotui`技术APPROVED只作为A提案的历史可行性结论保留。

退出范围、公共类型兼容范围和原迁移提案已有独立限定批准。旧工具清理patch已独立复核并封存；SRT-06的B限定迁移和正常安装已独立通过，后续集中处理Driver公开类型兼容方案。Driver执行主链及Core／Ref算法未因搬迁重写，同一生产文件只由一个执行者修改。[原A方案的历史技术裁决](MINIMAL_CORE_SRT_06_RELOCATION_REVIEW_2026-11-07.zh-CN.md)。

退出提案原为8个整文件删除、25处分支裁剪、2个保留项；实际实施增加了独立核准的Store一行裁剪。页面挂载、身份、授权和释放职责继续保留。Runtime去具体Driver依赖与Driver类型兼容分别验收，不能互相抵消。前一轮r05的36条类型错误保留为历史结果，本轮完整选项的42／10条及独立对照见最新裁决。[退出范围独立裁决](MINIMAL_CORE_SRT_02_RETIREMENT_SCOPE_REVIEW_R02_2026-11-07.zh-CN.md) · [兼容范围独立裁决](MINIMAL_CORE_CONSUMER_TYPE_COMPAT_REVIEW_2026-11-07.zh-CN.md)。

**2026-11-07 前一阶段裁决：旧 Snapshot Tool 的八文件消费者迁移已形成可审查隔离交付，运行行为 APPROVED；完整退出准出仍为 CHANGES_REQUESTED。** 三个 Worker／双 Producer 文件执行方与负责人独立重跑均为70/70；公共 SDK→Runtime Worker→Source 四次调用也由双方分别跑通，最新 View、短收据和正常 Runtime 关闭验证通过。TS 5.9.3 三入口、TS 5.3.3 Core／SDK 通过；TS 5.3.3 adapter 的36条错误已由仅导入冻结 Driver 的独立对照复现，兼容门禁未豁免。下一步只读收敛生产退出范围，并在既有 SRT-06 登记类型依赖问题；旧生产路径尚未删除、共享代码尚未采用这批候选。[最终独立裁决、证据、风险与下一批 Prompt](MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_REVIEW_2026-11-07.zh-CN.md)。

2026-11-07。当前共享代码已完成 Host 来源统一、MCP 完成通知修复，以及 Batch 23 的 Agent 参数说明修正；B23 已获独立 APPROVED 并实际应用、构建和复验。普通工具读取页面对象引用的 Batch 22 仍是独立签收的隔离候选，新协议尚未采用或发布。Batch 24 只读采用审查已 APPROVED；Batch 25 已补齐真实 GUI 打开/关闭操作链，限定隔离手测入口获 APPROVED。首次 TUI 预览刷新缺陷仍 OPEN，真实模型与最终 Semantic 验收尚未完成。所有者明确：文件工具直接使用路径，不额外强制包装 Ref；只有明确声明为 Ref 的参数才做引用解析。[B23 落地签收](MINIMAL_CORE_BATCH_23_REVIEW.zh-CN.md) · [B22 隔离签收](MINIMAL_CORE_BATCH_22_REVIEW.zh-CN.md) · [B24 只读签收](MINIMAL_CORE_BATCH_24_REVIEW.zh-CN.md) · [B25 GUI 补验裁决](MINIMAL_CORE_BATCH_25_GUI_REVIEW.zh-CN.md)

一次工具调用可以按这个顺序理解。框架取得本轮页面与工具，模型选择工具，Driver 调用当时捕获的函数，结果保存并触发下一轮。重构围绕这条链消除重复执行、错误身份和重复通知。工具读取页面里的数据时，还必须证明那份数据确实来自本轮获准读取的页面。

2026-11-06 新约束下的最新交付：Ref 应让模型免于抄写内部业务 ID。typed `useDataRef` 与公共 `refParam` 的 SDK 本地候选、Planning 的单目标 Ref 迁移，均已获得负责人独立 APPROVED。Planning 页面、10 个对象操作的参数、Root 指令和错误恢复同步改造；全部 12 个工具已经真实执行覆盖。负责人独立重跑 SDK 91 项、App 15 项、SDK 6 次 Worker 调用与 Planning 27 次调用。新 GUI 的创建、Task Ref 修改、Phase Ref 新增、关闭和 Plan Ref 重开也已独立 APPROVED：核对 10 次实际模型接口请求、5 次业务调用及原始 CUA 输出。SRT Owner 已交接新的独立手测入口，沿用现有 DeepSeek 配置，聊天和业务为空；Minimal Core 核对了交接回执、11 件非秘密文件指纹及启动/停止脚本，未读取私有数据库。真实模型尚未运行。该次交付尚不含整列表。2026-11-07 的一个必填对象列表 Ref 隔离增量已独立 APPROVED；多 Ref、可选 Ref 仍不支持，共享采用或发布尚未批准。[整列表实现签收](MINIMAL_CORE_SRT_02_LIST_IMPLEMENTATION_REVIEW_2026-11-07.zh-CN.md)。[新手测入口与步骤](../.tmp/planning-ref-manual-20261106/ACCEPTANCE.zh-CN.md) · [源码与 Worker 签收](MINIMAL_CORE_TYPED_REF_AND_PLANNING_REVIEW_2026-11-06.zh-CN.md) · [新 GUI 独立签收与下一步](MINIMAL_CORE_PLANNING_REF_GUI_REVIEW_2026-11-06.zh-CN.md) · [前置能力核对与逐工具矩阵](MINIMAL_CORE_PLANNING_REF_AUDIT_2026-11-06.zh-CN.md)

| 工作 | 实际改变 | 当前完成状态 |
| --- | --- | --- |
| Core 的重复管理 | 收拢会话与调用记录的所有权，减少重复扫描和结果转换，释放临时观察。 | Batch 01–08 有历史批准记录。对应原始证据曾由所有者清理，历史成绩按当时签收记录追溯。 |
| 执行入口 | 模型 SDK 只提供工具声明，Driver 拥有工具实际执行。删除旧的分读与执行后备路径。 | 已进入共享代码。模型 SDK 执行业务 0 次、Driver 执行 1 次的真实测试已复核。 |
| 一轮页面与工具的关联 | 五个 Host 来源统一返回 `getContext`。MCP 同名工具后来被替换时，旧 Context 仍绑定原函数。话题已切换时，旧话题操作先被拒绝。 | Batch 09 已签收。2026-11-06 重新核对的 25 个共享文件与上一轮复核字节一致。 |
| 结果到达后继续运行 | 同一次 IM 历史加载共享 Promise，工具结果保存后触发续轮。MCP 的一个通知回调抛错时，其余回调仍各收到一次通知，工具保留自身结果。 | 已进入共享代码。Batch 10 的两个文件与批准指纹一致，落地复验共 46 项通过。 |
| 作者只写一份参数合同 | 在一份声明中表达业务类型和数据形状，由同处推导模型所传的名字与业务收到的值，拒绝错误类型和超限数据。 | 单对象、单个必填对象列表、多个顶层对象／对象列表 Ref、可选组合及旧专属路径清理已获相应限定隔离 APPROVED；其他形状、多选、正式采用和 SRT-02 整体仍未完成。 |
| 计划数据的发布 | 把作者已有的 `Plan` 标注带入实际快照，防止发布时变成“未知类型”。Planning 的两页候选还取消了仅有标题的占位对象。 | 已签收隔离候选。实际 Worker 能通过现有单页工具读到完整计划，正式采用仍需按候选范围决定。 |
| 关闭后的旧调用 | 在同一组 SDK/Runtime 包中验证，即使 App 的关闭回调抛错，旧工具也失去执行资格，健康 App 可以继续调用。 | Batch 20 组合包验证通过。 |
| 普通工具的验收 | 两种错误实现虽都返回正确计划编号，修订后的验收能根据实际执行身份与数据来源拒绝它们。 | Batch 21 修订签收，原包的普通 Plan 声明仍在注册时失败。 |
| Agent 看到的使用说明 | 采用实际的 `[显示文字](完整引用名)`，复制已有前缀和下标；文件路径、普通 JSON、显式 Ref 各按参数合同处理。 | Batch 23 单说明文件已进入共享代码；负责人独立复跑隔离链路，并复验共享 42 项测试和实际构建的六种说明加载场景。 |
| 候选采用前的差异审查 | 识别共享代码已经具有、旧候选基线没有的校验与生命周期保证，核对普通对象、Ref 和 ArrayRef 的实际支持范围。 | Batch 24 只读结果已独立 APPROVED。不能直接把旧基线候选覆盖到共享代码。 |
| 可实际操作的 Ref 验收入口 | 在单独 Host 中复用签收包，让真实 Planning 的 `open_plan` 接收页面上的完整 Plan Ref。 | Batch 25 工程链路与独立 GUI open/close 已通过，限定手测入口 APPROVED。首次预览刷新缺陷保留；不代表完整 GUI 自动同步、共享采用或最终 Semantic 验收。 |
| Planning 的单目标 Ref 迁移 | 10 个对象操作使用必填 Ref，创建/关闭保持明确语义；删除模型抄写 ID、本地 Ref 标注 helper 和占位对象。 | SDK、App 与新 GUI 操作链均独立 APPROVED。GUI 页面在切换 Chat/TUI 后确认；预览缺陷保持 OPEN。真实模型及共享采用待验，SRT-02 仍未整体完成。 |

上述验证的具体范围分别见签收记录。[Batch 09](MINIMAL_CORE_BATCH_09_REVIEW.zh-CN.md) · [Batch 10 实际落地](../review-evidence/minimal-core-batch-10/owner-review/shared-application/final-application.json) · [参数合同](MINIMAL_CORE_BATCH_14_REVIEW_02.zh-CN.md) · [Planning 两页](MINIMAL_CORE_BATCH_13_REVIEW.zh-CN.md) · [Plan 类型](MINIMAL_CORE_BATCH_16_REVIEW.zh-CN.md) · [组合包](MINIMAL_CORE_BATCH_20_REVIEW.zh-CN.md) · [作者验收](MINIMAL_CORE_BATCH_21_REVIEW.zh-CN.md)

Batch 22 用 Planning 示例的一条业务记录验证：Agent 传页面上的名字，框架从原观察获准的快照取出对象，交给普通业务函数。负责人从固定基线独立重建，773 项既有契约断言通过；另补新 V4 工具已进入后的超时、晚响应和 Context 释放，业务均只执行一次，资源最终结清。全 Runtime 严格库检查仍有与基线一致的 130 项 linkedom 声明错误，单列为既存失败。合法持有旧 Context 能读旧对象，不等于“采用新观察后自动撤销旧资格”已完成。

Batch 23 只修正现有系统说明中的旧 Ref 格式、遗漏前缀和过宽的全局规则。隔离实际包中的 Worker/Source/Driver 链路验证三类参数，模型请求确实收到整段新说明；随后只把批准的说明文件应用共享代码。共享实际 Source 复验通过，自定义说明的优先级和内容保持原样；没有带入 B22 协议。受控 provider 的确定性验证不等于真实 LLM 已理解 Ref。[独立验证与实际边界](MINIMAL_CORE_BATCH_23_REVIEW.zh-CN.md)

Batch 24 已完成从 B23 后真实共享版本出发的采用审查。负责人独立重放差异矩阵与纯 Core 探针，确认直接应用候选补丁会冲突，且旧基线缺少共享代码已有的若干保护。例如，当前共享 Core 会在执行前拒绝配置 getter；旧候选基线会调用 getter。审查保留这些事实，未解决集成冲突、修改生产源码或批准协议采用。数组整体、多选、可选 Ref 的声明试件通过，不等于这些形状都已在真实 Worker 接通。

Batch 25 使用精确 B22 SDK 与 B23 Runtime 包，在持久隔离目录中运行真实 Planning、Node Worker 和 Source。为了与所提取 Host 配套，隔离环境使用未改动的 SRT M4.3 Driver，不能将其视作当前共享 Driver。受控 provider 验证了实际 `LLMClient.call` / `streamText` 一次请求只执行一次 Ref 业务；SRT Owner 的独立 A/B 对象验证确认，旧 Context 的引用不会因列表位置复用而指向另一个对象。应用仍检查对象是否存在；删除后返回现有 `unknown + PLAN_NOT_FOUND`，未擅自改写结果分类。

本批手测状态由 SRT Owner 独占准备：只读复用一条现有模型设置，使用空聊天库和独立 Agent，关闭外部连接器。自动检查不再启动或改写这份状态，归档排除凭据和数据库。首次离线 GUI 启动期间，原 profile 四件缓存/WAL 指纹发生变化，无法排除脚手架初始化时序的影响，原记录保留；原配置、聊天和 Planning 数据指纹未变。路径隔离的修正与验证单列记录，不能用后来修正抹去首次事实。

所有者解锁后，GUI 在另一个无真实凭据副本完成。SRT Owner 独占界面操作：open_plan 的 Input 为完整 Ref，Output 仅为操作收据；切回 TUI 后看到正确详情。close_plan 后详情及七个详情工具退出，列表保留，随后窗口正常退出。Minimal Core 独立核对六轮实际请求、两次业务调用、完整业务输入和原始日志；原手测 1,507 件静态文件与 SRT Owner 核对的 50 件私有状态文件未变。首次加载的 TUI 预览仍曾停在空列表，而 Driver 已有正确 Plan，此问题登记 MC-HOST-PREVIEW-01。该 Host 缺陷保持单列，当前先推进上述 Ref 作者接口与 Planning 迁移，不把两项混成一批。人工验收先 Open Folder 选择空目录，再进入聊天；真实模型理解仍由用户手测。[具体步骤](../.tmp/planning-app-install-20261106/REF_ACCEPTANCE.zh-CN.md)

MC-HOST-PREVIEW-01 的后续诊断发生隔离事故：首轮 Host 模块自动初始化读取了用户级 App 配置并动态导入四个应用模块，无法用现有证据排除模块顶层的其他副作用。两轮探针分别因缺依赖、实例查询错误失败，均不是有效的预览缺陷复现。事故与后续隔离预检均为 CHANGES_REQUESTED：负责人在五个新合成场景中独立确认 Node 权限允许列表存在符号链接读取、Worker 清空参数后失去限制的边界；OS 沙盒与指定本地容器入口没有获得可用结果。第三轮 Host 诊断未准入。后续静态责任链、失败封存和最小修复建议已独立 APPROVED：负责人核对了 82 件交付文件、341 件固定基线文件，以及 24 处源码引用。源码显示提交后的通知未接到 GUI 预览缓存，并存在订阅取消缺口；完整根因与修复效果仍须真实运行验证。建议只动 Router、Host 本地 GUI 事件类型和 Bridge 三处，准出条件与 Prompt 已封存；运行仍需合格隔离环境，缺陷保持 OPEN。此前 SDK/Planning/GUI 裁决不改写。[事故事实](MINIMAL_CORE_HOST_PREVIEW_INCIDENT_REVIEW_2026-11-06.zh-CN.md) · [隔离预检独立裁决](MINIMAL_CORE_HOST_PREVIEW_PREFLIGHT_REVIEW_2026-11-06.zh-CN.md) · [静态交付签收与下一批条件](MINIMAL_CORE_HOST_PREVIEW_STATIC_REVIEW_2026-11-06.zh-CN.md)

后续产品选择包括同一 App 两页能否使用相同数据名、列表与单项如何表达业务种类，以及旧观察退出后完整数据保留多久。负责人会把有实际影响依据的方案交所有者决定。最终还需相应组合包回归、真实 App 使用流程和所有者 Semantic 验收。

SRT-01 的 G1–G4 已由 SRT Owner 独立签收，本地工程准出完成。事前固定的六个原合格样本加三个获授权替换样本，程序语义与公开输入均为 9/9；原九次的 6/9 输入合规事实保留。Minimal Core 核对了正式裁决和机器回执 SHA，未重复执行或冒称自己重跑作者试验。此成绩属于精确 SRT M4.3 作者合同，不代表 B22 已采用、所有 LLM 都能理解 Ref 或最终 Semantic 已验收。[SRT-01 最终裁决](../.tmp/worktrees/srt-01-owner-verdict-20261106/SRT-01_G3_OWNER_CLOSURE.2026-11-06.zh-CN.md)

本目录已接收原根目录的 55 份文档和补丁。迁移时逐字核验了原签收指纹。历史文档中指向 `review-evidence/` 的相对路径，以项目根目录为基准。后续任务直接使用当前位置。[迁移核验记录](../review-evidence/minimal-core-batch-22/owner-inputs/document-relocation.json)

Minimal Core 与 SRT 共用一份实现、分别承担明确交付和独立复核责任。SRT-01 及作者输入合规裁决由 SRT Owner 维护；本次由执行 Codex 实施 SDK、SRT Owner 实施 Planning，Minimal Core 分别独立复核并签收。新 GUI 已由 SRT Owner 独占操作、Minimal Core 独立签收，新的手测状态已交给用户，自动脚本不得重置，不另做一套 SRT-02。执行 Codex 的 MC-HOST-PREVIEW-01 静态交付已独立 APPROVED 并冻结；第三轮 Host 行为运行继续暂停。SRT-02 的“一个必填整列表 Ref”任务包也已独立 APPROVED，仅限静态范围与验收条件；负责人核对三包 524 件载荷、B24 的 631 项输入及 12 条源码依据。首次声明探针因混淆 SDK 捕获与正式注册阶段而失败，原始失败及 CHANGES_REQUESTED 保留。修订入口已独立准入，两条真实基线随后通过并获限定 APPROVED：六种 capture 均成功，正式编译／注册只接受单对象；六次 Worker 调用中两次业务进入、四次派发前拒绝，临时持有及真实 Runtime 关闭核对通过。SRT Owner 的两处最小整列表增量已获限定实现 APPROVED。负责人核对 290 件证据、418 件源码、四组合 1,912 件安装文件，独立重跑 Core 28、列表 Worker 16 调用、普通 TS 与 3 Ref 对照、9 项适配器变异及两版严格类型；四组合原件合计 56 调用。旧观察自动退出仍未完成，常规包安装与发布未验证。旧 Snapshot Tool 收尾范围也已完成独立只读复核，未找到必须先扩展多 Ref 的迁移消费者。八文件隔离迁移准备已交审，负责人完成 418 文件独立重放、295 个旧运行断言及 24 个类型负向映射核对。r01 首次运行准入在执行前撤回：两个 Host 只传 Worker env、未传持久化 config，scoped 清理断言顺序也须修正；r02 已在全新副本补齐两处 Host config 并修正收尾顺序，负责人独立重放和追踪实际目录解析后，给予限定首次运行 APPROVED；r02 首命令随后真实失败（70 项：42 通过／28 失败），后四步未执行。独立结论 CHANGES_REQUESTED，已准入一个无 Worker 声明诊断和 r03 七文件限定准备，完整重跑须新入口复核；两项 R11 及八个 plain 构造失败的清理未获证明，r01 仍撤回。[首次结果、证据缺口与下一 Prompt](MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_RUN01_REVIEW_2026-11-07.zh-CN.md)。r03 七文件修复准备随后通过独立入口复核：原断言全部保留、新增 5 个模板，页面身份与工具 activation 变化分别核对，418 件源码独立重放一致；r03 真实运行与负责人独立重跑均为三文件 70/70，限定迁移部分 APPROVED；公共消费者在 adapter 严格类型入口缺少 json-schema 声明而停止，公共运行链及 TS 5.3.3 尚未执行，完整交付仍为 CHANGES_REQUESTED。随后r04仅增加查找根仍失败；r05依据实际编译器解析改为完整声明的精确模块映射，公共行为通过独立复核，TS5.3 adapter依赖兼容阻断仍保留。最新结论见本页顶部及最终裁决。[r03 实际裁决与下一 Prompt](MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_RUN_R03_REVIEW_2026-11-07.zh-CN.md)。[r03 入口裁决与 Prompt](MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_ENTRY_REVIEW_R03_2026-11-07.zh-CN.md)。[r02 入口、限制与执行 Prompt](MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_ENTRY_REVIEW_R02_2026-11-07.zh-CN.md)。后续生产删除尚未准入；另发现旧公开 Core 教程待迁移，35 个生产文件清单不代表完整退出范围。[r01 撤回、代码依据与 r02 Prompt](MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_ENTRY_WITHDRAWAL_2026-11-07.zh-CN.md)。原未获准 Ref 负向、关闭后的派发／handler／业务效果区别、w10 子集和短收据要求均写入裁决。[收尾范围、限制与执行 Prompt](MINIMAL_CORE_SRT_02_RETIREMENT_SCOPE_REVIEW_2026-11-07.zh-CN.md)。[整列表实现签收、风险与下一批 Prompt](MINIMAL_CORE_SRT_02_LIST_IMPLEMENTATION_REVIEW_2026-11-07.zh-CN.md)。[基线失败与预期纠正](MINIMAL_CORE_SRT_02_LIST_BASELINE_REVIEW_2026-11-07.zh-CN.md) · [修订基线签收与实施要求](MINIMAL_CORE_SRT_02_LIST_BASELINE_REVIEW_02_2026-11-07.zh-CN.md)。[整列表范围裁决与准备 Prompt](MINIMAL_CORE_SRT_02_LIST_SCOPE_REVIEW_2026-11-07.zh-CN.md)。冻结 B25 保留为历史入口。分工记录中的早期任务状态保留为当时快照，当前状态以本页及各批最终裁决为准。[本线分工记录](MINIMAL_CORE_SRT_BOUNDARY_2026-11-06.zh-CN.md) · [SRT Owner 边界记录](../.tmp/worktrees/srt-01-owner-verdict-20261106/SRT-01_OWNER_BOUNDARY_MINIMAL_CORE.2026-11-06.zh-CN.md)
