# 已验收内核的完整减法清理：负责人验收与采用

2026-11-09。**APPROVED_ADOPTED：本轮完整交付通过集中复核，62 个路径已采用到实际根目录，无本轮阻断。** 开发：Clean；唯一负责人复核与采用：SRT Owner。依据[完整任务](SRT_POST_ACCEPTANCE_SUBTRACTION_CLEAN_TASK_2026-11-09.zh-CN.md)及项目所有者“旧／废弃、可删可不删的代码都删除”的追加指令执行，使用 minimalist；没有新增替代框架、依赖或兼容路径。

本结论针对本轮新增清理，接续此前 SRT-01～SRT-15 的验收，不改写历史证据。签发时 Minimal Core 的重复参数编译和 IDE 随包消费者迁移仍按[本线尾项任务](../MINIMAL_CORE/MINIMAL_CORE_REMAINING_WORK_2026-11-09.zh-CN.md)继续，本报告不替代其负责人验收。**后续更新：** MC 两项已获其 Owner 唯一批准，并[完成最终增量的根目录采用](MC_PLAN_CLOSURE_OWNER_ADOPTION_2026-11-09.zh-CN.md)；下方交接顺序保留为当时事实。

## 采用身份与实际结果

- 开工基线是已经采用 r02-combined 与 MC19／14 的实际工作树；没有从旧 HEAD 重建。采用前后 HEAD 均为 `8938449925ada2f92e072e1c0492af8f2428d14f`。
- [完整交付](../.tmp/post-acceptance-subtraction-20261109/REPORT.zh-CN.md)及 [62 路径清单](../.tmp/post-acceptance-subtraction-20261109/CHANGES.json)包含生产 27、测试 32、当前文档 3；删除 5 个生产文件，没有新增生产文件。
- 生产代码增加 47 行、删除 491 行，净减 **444 行**；测试净减 126 行、文档净增 12 行，总计净减 558 行。行数只描述变化，不代替正确性判断。
- Patch SHA-256：`9fa6f29d0fe368d3d8f867a8e489d9346a35971f132eaf3b9873f1f2bb4cf285`。Owner 核对全部 before／after、冻结候选及实际根目录，采用前冲突为 0，采用后 62 项全部匹配；全部 before 已备份。
- 5 个已删除源码及其 20 个可能的本地 dist 路径均不存在；正常 Runtime tar 原有的对应 15 件 js／声明／map 也已退出。两种数量的统计范围不同。
- 实际根目录的原 `run.sh` 九模块构建段与 Host 严格类型检查通过。本轮没有启动 Electron，也没有操作用户数据、重复人工 Planning 验收、提交、推送、合并或发布。

身份与采用原件：[identity.json](../review-evidence/post-srt-subtraction-owner-20261109/identity.json)、[adoption.json](../review-evidence/post-srt-subtraction-owner-20261109/adoption.json)、[冻结变更清单](../review-evidence/post-srt-subtraction-owner-20261109/adopted-changes.json)。

## 删除内容及保留职责

| 清理内容 | 保留的实际职责 |
| --- | --- |
| SDK View 单模式包装、重复 Context 读取、工厂元数据字段及初始化日志 | 显式 View 身份／type／kind、嵌套检查、挂载所有权、提交等待和卸载仍由唯一当前实现承担；View 返回类型明确为公开 JSX.Element |
| 四个仅供聚合的 DesktopManager 接口文件、无使用者的 has／安装转发方法及私有 AppKernel 转导出 | 接口方法直接归属 IDesktopManager；存在性使用 get，实际 Runtime／Desktop 安装、关闭中占用和实例隔离保持 |
| 只写不读的每 App 活动日志缓存、查询／统计／清理包装及 maxAppLogs 配置 | 保留有界 system log；collapse／show 接到该现行日志，Desktop 精确身份隔离和关闭后旧实例行为保持 |
| SignalBus 可关闭异常隔离的无用选项、按名字取消订阅及重复输出接口 | 始终逐订阅者隔离异常；保留捕获原订阅集合的取消闭包和实际 Desktop 输出合同 |
| AppContext 的旧 onRender／markDirty 接线、Worker OPEN 的旧排程状态与 reinitialize 空回调 | AppContext 只持有 App／Desktop 身份；SDK RuntimeContext.markDirty、Preact／ComponentRenderer、projection.recordMutation、提交与卸载链保持 |
| 无职责类型别名、重复配置导出、无效 AppConfigEntry.version 及不可能触发的解析分支 | CLI 使用实际 distribution.resolvedVersion；实际 EXTERNAL_EVENT、Worker reinitialize、公开低层入口及边界校验保持 |

相关公开导出、配置、直接消费者、测试夹具和当前迁移文档同步处理。废弃配置由既有未知字段检查拒绝；没有为其保留静默兼容。调用资格、Ref 来源和所有权、观察失效、结果 effects／partial／unknown 及资源释放未被本轮删除。

## 一次集中复核与质量证据

Owner 已阅读全部 27 个生产路径、32 个测试差异和 3 个文档差异，未发现阻断。测试调整主要为已退役 API 专属测试退出和夹具迁移；关闭后的 markDirty 改为断言实际投影 token 不变，Ref-only 更新继续验证 epoch 与通知，日志范围／容量及旧实例断言保留。没有用删除当前合同断言换取通过。

执行方已有有效结果直接复用，原始命令见[验证索引](../.tmp/post-acceptance-subtraction-20261109/evidence/validation-index.json)：

- SDK 默认 20 文件／188 项；Runtime core／kernel／config 19 文件／156 项，App／Worker 集成 55 文件／507 项；最后 CLI／安装夹具 2 文件／4 项通过，其中 3 项与前组重叠，不重复累计。
- Runtime、SDK、Driver、Adapter 构建，以及 SDK 严格公开类型／静态类型和 Runtime 原配置未使用变量／参数检查通过。
- 正常四包安装的 447 个载荷文件与 tar／候选一致；公共文档严格编译，两种 Producer、普通／Ref 调用、预期失败和资格拒绝，以及最终关闭与 scope／lease／bytes 归零通过。`/tools` 独立进程验证保留稳定目录和生命周期。

Owner 只补充与本次交付直接相关的检查：正常安装包的既有文档／真实 Worker 验证独立通过（2.137 秒），输出到单独目录，没有覆盖 Clean 原件；采用后原 `run.sh` 九模块构建段通过（6.897 秒），Host 严格类型通过（0.512 秒）。见[独立运行记录](../review-evidence/post-srt-subtraction-owner-20261109/installed-docs-run.json)、[实际结果](../review-evidence/post-srt-subtraction-owner-20261109/installed-docs-facts.json)、[根目录验证](../review-evidence/post-srt-subtraction-owner-20261109/root-validation.json)。没有重跑历史全套矩阵或追加人工门禁。

**已知非阻断限制：** 执行方额外强制整个 Runtime 源码依赖图使用 `skipLibCheck:false` 时，现有 linkedom@0.18.12 声明产生 131 条诊断，项目源码诊断为 0。该参数不是既有 Runtime 构建配置；本轮没有改动依赖或放宽配置。原配置构建、正常包公开示例与 SDK 公开类型的严格检查均通过。保留该额外失败事实，不称全部检查全绿，也不把本轮扩张为第三方声明治理。早期已修复的构建失败记录同样保留。

## 本地包身份

以下为本轮正常消费验证的未发布本地包；相同版本的其他历史 tar 不能替代这些哈希。Owner 已核对四份归档，载荷明细见[package-payload.json](../.tmp/post-acceptance-subtraction-20261109/evidence/package-payload.json)。

| 包 | 版本 | SHA-256 |
| --- | --- | --- |
| Runtime | 7.0.0-srt.1 | `fa48f8190c9e4bfc233fac5045f844924d59b4ba95e4031d8ca971b213c00f54` |
| SDK | 0.8.0-srt.1 | `a552b3ce907158b563d7c6edcf4f1f21052cf6ea043331b5ab08649490443efb` |
| Adapter | 0.4.0-srt.1 | `cf40c333401e1f3645a87f6f5a51e1b7a32519b8b4ba756db89af48c1e664c94` |
| Driver | 0.3.0 | `eea0fb06299519ad511f1f2cd29e82c31004b2e34c336de7b3c8211113689874` |

## 后续采用边界

本轮先交付并采用，MC 参数实现尚未包含在其中。MC 后续候选需要保留现在的 `worker-runtime/index.ts`、`app-kernel/AppKernel.ts` 和 `AppKernel.ordinary-v2.test.ts` 夹具变化，以及 AppContext 的身份类型；在此基线上叠加本线参数改动，不能整文件恢复旧回调或已删除转导出。准确 after 身份见冻结清单。已向 MC Owner 发送这项具体交集和新基线，消息发送成功；此处是共享文件组合责任，不要求 MC Owner 再审 Clean。

下一条执行指令：MC 按既有完整尾项任务完成参数编译减法与 IDE 随包消费者迁移，在新基线上交付给 MC Owner 一次集中验收；SRT Owner 按其结论协调采用与总进度。本轮 Clean 清理已结束，不等待用户再次签收。Ref 字段访问／数据作用域／基础类型、并发和资源策略重设计仍按原决定留待未来，不以本次删除宣称已经实现。
