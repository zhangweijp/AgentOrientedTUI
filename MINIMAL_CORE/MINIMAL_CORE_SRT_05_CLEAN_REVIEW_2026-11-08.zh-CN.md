# SRT-05 串行观察交接独立复核

2026-11-08。**APPROVED，限定下述精确隔离候选及随附的一处存量测试迁移。** 负责人已独立阅读实际差异、重放补丁、构建并运行必要测试和公开包消费者。结论不包含根目录采用、发布、完整 Host／IDE 或所有者最终 Semantic 验收。Clean 继续实施已派发的 Planning 运行入口整合，SRT Owner 负责采用，Minimal Core 负责独立复核。

**本次改变。** Agent 正式采用新观察 O2 后，旧观察 O1 的新调用、Binding 和 Ref 解析资格退出；同名 Ref 不会把旧调用指向新对象。单纯后台发布或诊断预览只准备数据，不切换当前资格。失败准备、无效采用不能冒充成功；跨 App 部分采用如实返回逐 App 结果，失败轮次不进入模型，仍按原 finally 释放。

旧快照不再当前且没有合法持有者时，框架立即释放其持有引用；另一 Scope、当前快照、准备或在途调用仍需要的数据继续保留。原操作收据和完整请求防重保留，重复读取旧收据不重新执行业务。释放当前观察不意味着回滚已经完成的操作。

按 [minimalist](../.agents/skills/minimalist/SKILL.md) 复用现有 Observation Registry、Scope、Snapshot lease、Context owner 和 Driver finally，没有新增管理器、依赖或调度器。8 个框架生产文件为 +70/-6 行，另有 CLI 消费接线及相应测试、说明。减少的是无人使用的旧 Ref 保留和模糊的调用资格；必要身份、来源、权限、容量及清理仍由现有内核负责。App 的 View／Tool 写法不增加观察交接职责；低层手写消费者需要显式采用，由标准 Driver 自动接线。

**交付身份。** 基于批准的 SRT-04 r02，869 件基线文件，最终 870 件，50 个变更路径：8 个框架生产文件、36 个消费者／测试文件、5 个文档和1个单列存量测试迁移。完整边界见 [交付](../.tmp/srt-05-clean-20261108/DELIVERY.json)及[实际差异](../.tmp/srt-05-clean-20261108/changes.patch)。同版本号不能替代下列本地包身份。

| 输入 | SHA-256 |
| --- | --- |
| 最终源码清单 | `78f7878dc00bb1c56fa93c39a842b996b4f51ef2f6d292797fad84b40f6a1649` |
| 最终补丁 | `2b5c28f0ebb59f56c431ca4f2628930ba2106ec9214dceeba10541dd12accadf` |
| Runtime | `e48d86e39be75b9b09f781d5ae6fb877cd98566cd07b4faf8b8d16e62c09824c` |
| SDK，原批准 r02 包 | `415c1d650f82502a862adc1654c02d8ce7a4751028c123afc365411a31ae0b50` |
| Driver | `c2dbd2912326e8a6a24429c5bbd563db1f3ec270577a4313310618416c5f7aca` |
| Adapter | `0afda2abebb8d1811a04262b32dba2bc37529021407c6acad66b520998d09fe1` |

负责人从基线实际应用最终补丁，870 件结果与候选、最终清单逐项一致；已测试的 Core、Driver 和公开消费者输入未漂移。Runtime 121、Driver 8、Adapter 4 件非测试源码与独立构建输入一致。最后两处修正仅为 IDE 说明中的 adopt 步骤和 CLI 命令帮助，四包未变化。[最终重放与输入核验](../review-evidence/srt-05-clean-owner-review-20261108/final-identity-check.json)、[编译输入核验](../review-evidence/srt-05-clean-owner-review-20261108/compiled-source-final-check.json)。

**验证依据。** 执行者的完整回归和负责人独立运行分开记录，不重复相加。

| 范围 | 实际结果与证明 |
| --- | --- |
| 负责人 Core／Snapshot Receiver | 32 文件、1159/1159；覆盖新旧资格、对象与数组 Ref、独立 holder、原来源／授权／防重／额度及关闭。 |
| 负责人 Driver 采用边界 | 3/3；实际 run 在模型前采用，部分失败不调用模型且释放，停止后迟到的准备不采用。模型调用为受控测试。 |
| 负责人独立构建 | Runtime、Driver、Adapter 均通过；351、16、12 件 dist 分别与实际 tar 一致。SDK 复用原 r02 已独立验证的原包。 |
| 负责人正常安装 | 独立私有目录中以锁定依赖图执行 frozen/offline 安装；四包482件安装文件与 tar 逐字一致，无源码替代安装。 |
| 负责人公开类型与普通 TS | TS 7.0.2，strict、exactOptionalPropertyTypes、skipLibCheck:false；Core 为 ES2022-only、types:[]。Core 与 Runtime／SDK 编译、纯 TS 实际调用通过，原对象值与新对象值有独立 witness；最终 scopes／bytes／leases／bindings 为0，持久数据仍可恢复。 |
| 负责人真实 Worker／Source | 真实 Worker 操作成功后下一次观察呈现已提交页面；投影错误不改写已成功业务收据。真实 Source 在预览期间读旧 Ref，采用后旧 Ref 与控制路由拒绝、新 Ref 读新值；两 App 准备后关闭其中一个，得到实际 PARTIAL 与逐 App 结果，健康 App 可恢复。关闭 ok、resourcesReleased 均为true，scopes／bytes／pool 为0。 |
| 执行者完整回归 | Runtime 默认128文件2040/2040（包含上述1159），SDK 19文件178/178，Adapter 2文件46/46，Driver 3/3；四包构建、SDK公共及静态类型通过。负责人审查命令、日志和对应实际输入，不冒称全部由负责人重跑。 |

独立入口：[Core 命令](../review-evidence/srt-05-clean-owner-review-20261108/core-regression-commands.json)、[Driver 命令](../review-evidence/srt-05-clean-owner-review-20261108/driver-commands.json)、[公开消费者命令](../review-evidence/srt-05-clean-owner-review-20261108/consumer-review-commands.json)、[四包安装核验](../review-evidence/srt-05-clean-owner-review-20261108/installed-package-verification.json)、[实际 Source 结果](../review-evidence/srt-05-clean-owner-review-20261108/public-source-facts.json)。执行者全量证据见其 [REPORT](../.tmp/srt-05-clean-20261108/REPORT.zh-CN.md)。

**复核中纠正的内容。** 原 source-binding 测试继续断言 TOOL_SOURCE_STALE、类型激活及实例边界，不以提前过期代替原保护；需要旧来源的用例显式持有并释放。Worker 中两个可调用旧观察的场景迁为一份当前完整观察或两个独立 Scope。C06 原 fixture 使用已退出的 view-instance Tool，基线也失败；单列迁为合法 view-type 与不匹配的 ViewType，继续检验 Producer 挂载拒绝，生产 Producer 未变。

公开 host.ts 原先第二次采用后继续用 first 调用，已改为使用真正当前的 unchanged 观察，保留无变化复用 snapshotId 的断言，独立重跑通过。IDE 操作说明和命令帮助漏写 adopt 已同步。首次完整 Runtime 的缺 fixture／未迁移调用失败、原 C06 失败、安装准备失败均保留。负责人首次安装遇到共享 store 不可写，改用私有 store；非冻结离线解析又因缓存版本不全失败，最终复用批准基线的锁定依赖图正常安装，不修改产品依赖。

**未覆盖与剩余边界。** 本片不解决已单列的 Driver 上游完整严格声明问题、原生 LSP 关闭问题；上述严格类型通过只限 Core／Runtime／SDK。没有真实模型、GUI、完整 Host／IDE 回归或 RSS／GC 承诺。外部调用者自己持有的不可变对象仍由其管理。既有 SRT-08 逐 App 隔离继续使用，没有重开该专项。

根目录 `./run.sh` 的 Planning 仍未纳入已批准 Ref 应用，这个已确认整合缺口不能用本片通过抵消。当前候选可作为下一片隔离开发父基线；根目录采用及用户重启后的可用结果仍须核验。

**下一片范围、准出与 Codex Prompt。** 已由 SRT Owner 派发 [Planning 根目录运行入口整合](../SRT/SRT-02_PLANNING_RUN_INTEGRATION_TASK_2026-11-08.zh-CN.md)，Clean 正在执行。复用批准的 Planning Ref 应用及前置 AppTools／bindings，接通根目录启动链中配对的 Host、Driver、Adapter、SDK、Runtime 与应用。10个选择已有对象的工具使用 Plan／Phase／Task Ref；创建内容等普通参数保持业务含义，文件路径继续直接使用，内部 ID 仍由 App 管理和校验。

准出以实际根目录入口为准：页面、Root 说明、Schema、恢复提示一致；重建后实际工具不再要求模型抄写目标业务 ID；真实 Worker 完成创建、打开、修改、关闭和业务守卫核验；先审查具体增量，再由 Owner 逐文件采用，最后核对根入口解析与合同。用户手动重启结果与工程验证分别记录。

> 以本报告精确 SRT-05 候选为父基线，复用已批准的 Planning Ref 实现和单一声明接线，完成既定根目录运行入口整合。保持现有业务服务、数据库、状态及权限职责，给出实际增量、配对包与路径、必要构建和真实调用证据、根目录采用步骤。不要再开 Core 项、不重做 SRT-08、不恢复已取消的 D3，不覆盖共享树或私人测试数据。由 Owner 安排采用，由 Minimal Core 独立复核，发布与最终 Semantic 另行验收。
