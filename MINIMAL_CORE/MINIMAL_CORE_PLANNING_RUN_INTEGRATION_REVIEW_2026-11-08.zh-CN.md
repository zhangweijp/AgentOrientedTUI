# Planning Ref 根目录运行入口整合：独立复核

2026-11-08。**APPROVED：精确候选已采用，真实根目录入口验证通过，本片工程交付关闭。** 实现由 Clean 完成；Minimal Core 负责人独立审查实际差异、重放、构建及运行必要测试。后续本聊天的新代码任务交项目所有者指定的 Minimal Core 执行agent，当前已完成实现不重复派发。

本轮解决的是一个实际整合遗漏：用户从根目录运行 `./run.sh` 时，Planning 仍要求模型提供 plan_id、phase_id、task_id；已批准的 Ref 应用与单一工具声明接线没有进入统一运行基线。现在候选中的页面展示对象说明与完整 Ref 名，10 个选择已有对象的工具接收 Ref，由 Runtime 解析为对象，App 使用内部 ID 并检查对象存在、归属和业务状态。创建内容仍是普通参数，关闭计划仍关闭唯一活动计划；文件路径不包装为 Ref。

**范围与 Minimalist 判断。** 相对已批准 SRT-05 只有30个路径：复用批准的 Planning Ref 实现，以及使另外三个 App 能使用当前 SDK 的既有作者接线；更新四 App 的本地依赖声明；保留原根目录 HTML；迁移三份存量集成测试。消除旧工具声明／调用接线与当前 SDK 的分歧，工具定义和实例绑定由现有 AppTools／bindings 承担，Ref 解析继续由现有 Runtime 承担。业务服务、数据模型、数据库没有变化，也没有新增内核机制或第三方依赖。模型不再抄写内部 ID，应用作者不增加一套解析与状态管理。

实际代码见候选 [Planning 工具](../.tmp/planning-run-ref-integration-20261108/candidate-r01/demo-apps/planning-app/src/tui/planning-tools.ts)、[App 接线](../.tmp/planning-run-ref-integration-20261108/candidate-r01/demo-apps/planning-app/src/tui/PlanningApp.tsx)、[Root 说明](../.tmp/planning-run-ref-integration-20261108/candidate-r01/demo-apps/planning-app/src/tui/RootView.tsx)及[完整增量](../.tmp/planning-run-ref-integration-20261108/integration.patch)。21份沿用源码／测试已核对与原批准输入逐字一致。四个内核包的447份重新构建产物与 SRT-05 精确包一致。

**精确身份。** 最终候选872文件；本轮30路径，根目录累计采用334路径。累计差异包含此前已经批准的内核和包边界改动，不能称为本轮新写334份实现。

| 工件 | SHA-256 |
| --- | --- |
| 最终源码清单 | `cf2de089f16686b81df2a992be33d7bf16b8fa10c409dcebba64dd5cfda79a3b` |
| 本轮 integration.patch | `4a8a09aa4833ba6d10b75008ae27fd7c3bd523432b9d95b24441c9d03a50cf9c` |
| 累计 root-adoption.patch | `7ae79f4fc93d57fb0c5132091469158fd1359d5d30867231a069858f8f667dfd` |
| 执行方 DELIVERY.json | `688afdc3bf089f2fab15ff0a717843d6a7449803cc50b7a747f709a2657de399` |
| Planning tar | `a1c2e9f2704e0c823a50c8d61e633df481a2639256a1f16b50808ee98e228630` |

负责人从 SRT-05 的870份精确输入实际重放最终补丁，872份结果逐项一致，无额外或缺失文件。最后修改只涉及三份集成测试；生产源码、原27路径及包未漂移，因此继续使用已完成的构建和真实调用证据，不重复无关矩阵。[最终身份](../review-evidence/planning-run-ref-owner-review-20261108/final-input-identity.json) · [独立重放](../review-evidence/planning-run-ref-owner-review-20261108/integration-patch-replay-r03.json)。

**独立验证。** 执行目录为 `/private/tmp/aotui-planning-run-owner-3y6verxh`，依赖正常 frozen/offline 安装，使用私有包缓存。构建直接取原 `run.sh` 到启动 Electron 前的完整前缀，保留原构建命令。

| 验证 | 负责人实际结果 |
| --- | --- |
| 完整构建链 | Driver、Runtime、SDK、Adapter、四 App、Host，共9项通过 |
| App 现有测试 | Planning 15/15，Terminal 8/8，Browser 3/3，IDE 两项既有验证脚本通过 |
| 三份 adapter 集成 | 原命令 `pnpm test:adapter-integration`，30/30，零跳过 |
| 实际模块解析 | Host→四包、Adapter→Runtime／Driver、SDK→Runtime、Planning→SDK／Runtime，9条 ESM 解析均进入同一构建树 |
| 内核构建身份 | SDK68、Runtime351、Driver16、Adapter12，共447份 dist 与批准包一致 |
| Planning 真实 Worker／Source | 27次：15次成功覆盖全部12工具；6次错误输入在派发前拒绝；6次业务守卫实际派发一次后返回既有错误 |
| 页面与工具合同 | 10个对象工具使用必填完整 Ref；模型可见目标参数、Root 和页面不要求业务 ID |
| 关闭 | Source Scope、保留字节和 Worker pool 均归零；ok、resourcesReleased 均为 true |

真实调用覆盖创建、打开、修改、完成、删除、关闭，以及数组移位、删除对象、切换计划时不会误操作另一对象。需要旧观察的业务守卫使用独立 Source／Scope 合法持有，避免以资格过期掩盖业务检查。证据：[命令与退出码](../review-evidence/planning-run-ref-owner-review-20261108/commands.json)、[Worker 摘要](../review-evidence/planning-run-ref-owner-review-20261108/planning-worker-summary.json)、[集成复跑](../review-evidence/planning-run-ref-owner-review-20261108/adapter-integration-after-migration.json)、[模块解析](../review-evidence/planning-run-ref-owner-review-20261108/module-resolution.json)、[产物核对](../review-evidence/planning-run-ref-owner-review-20261108/core-dist-verification.json)。

**复核纠正。** 原三份集成测试没有同步显式 adopt，且 lifecycle 脚手架假设 Runtime 仍有 `node_modules/@aotui`，正常独立依赖图因此在初始化失败，28项没有执行。失败证据保留。修正只补采用步骤、以独立消费会话保留旧实例检查、删除过时依赖枚举；APP_INSTANCE_CHANGED、SCOPE_UNAVAILABLE 及原业务、隔离、关闭断言保持。负责人亲自应用三文件补丁后，原命令30项全部通过。

**剩余边界。** 根目录已经采用并完成下述入口核验。真实模型、Electron窗口、用户私人数据库及最终 Semantic 验收未运行；既有 Driver 严格声明和原生 LSP 关闭问题仍单列。6次业务守卫继续沿用既有 unknown＋error.code 映射，不声称本轮修复结果分类。本轮不扩展 SRT-08 或新 Core 专项。

**已完成的采用任务。** Owner 逐文件采用334路径，保留未列文件和他人改动；执行方已完成必要依赖、原构建链、实际模块与真实调用验证，负责人完成最终核对。下列原执行 Prompt 保留为该步骤的范围记录；用户自行重启后的结果独立记录。

> 使用本报告批准的精确候选及 root-adoption.json，由 Owner 按最新 before 哈希采用累计差异。沿现有 run.sh 构建和链接方式，验证真实根目录消费配对的包，10个对象目标使用 Ref，已有创建／打开／修改／关闭和业务守卫正确。复用现有探针，将测试数据放独立目录；不改私人配置和数据库，不启动真实模型或用户 Host。遇到真实失败提交最小差异，由负责人按文件归属安排实现。无需新增方案层或重复审批，不启动其他 Core 改造。

**真实根目录收口补充。** 已独立核对334路径全部匹配；17条实际模块解析指向根目录，四核心包447份产物与负责人独立构建逐字一致。执行方在真实根目录完成10处 frozen/offline 安装、原 run.sh 全部9模块构建、GUI bundle及27次原探针调用，均成功。探针只改变源码和私有测试数据基址，业务断言保持；12工具成功覆盖，10对象目标使用Ref，模型可见业务ID为0，关闭Scope／字节／pool归零。负责人核对原命令、退出码、实际输入和结果，不再重复候选矩阵。

根构建第一轮发现两份未跟踪、已按SRT-02批准退出的旧文件 useViewSnapshotTool.ts／snapshot-parameters.ts 残留；备份后限定删除，原失败保留。负责人确认备份指纹、实际删除和批准候选中的缺席一致，补丁SHA为 `97b9aabd03bebbc0fb1c6892cb638522ae0d6945eed1028a8ec7ac28f694e560`；没有恢复旧依赖或新增内核。三份额外Runtime旧位置测试未在本轮处理，不据此宣称全仓测试通过。[最终根核验](../review-evidence/planning-run-ref-owner-review-20261108/root-closure-verification.json) · [真实根执行报告](../.tmp/planning-run-ref-root-verification-20261108/REPORT.zh-CN.md)。

**后续完整开发任务。** 按所有者新指令，下一项统一交给指定Minimal Core执行agent，连续完成 [View声明、发布与上下文呈现整合](MINIMAL_CORE_VIEW_PIPELINE_DELIVERY_TASK_2026-11-08.zh-CN.md)，包含SRT-03／SRT-07及相关App、文档、测试和构建交付；不逐字段、逐测试交审。执行者完整交付后，由负责人一次独立验收。
