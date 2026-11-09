# Minimal Core 原计划尾项：负责人独立复核

**APPROVED。** 2026-11-09。批准指定Minimal Core执行Agent的A／B整项交付，以及在Clean已采用基线上的最终组合。没有阻断性发现。此结论批准当前候选的工程实现；签发时尚未采用到共享根目录，不宣称已经发布或替代项目所有者的产品验收。

**采用与结案补记（2026-11-09 21:37）：APPROVED_ADOPTED。** SRT Owner已按本裁决选择性采用19路径，实际根Runtime／SDK／IDE构建全部exit 0。MC Owner随后再次核对根目录19项与批准after全部一致，Clean62项在组合后完整保留，HEAD未变；没有追加代码审查或测试矩阵。本线原计划、后续已承接任务及追加清理至此完成开发、独立批准和实际采用，无剩余工程任务或新增人工确认项。证据见[实际采用报告](../SRT/MC_PLAN_CLOSURE_OWNER_ADOPTION_2026-11-09.zh-CN.md)、[根目录构建](../review-evidence/minimal-core-plan-closure-owner-adoption-20261109/root-validation.json)及[本线采用状态核对](../review-evidence/minimal-core-plan-closure-20261109/owner-review/adoption-confirmation.json)。下文保留批准时的复核过程和采用指令，它们已执行完成；正式发布及未来专项仍按原分工另行决定。

批准的最终patch为[combined-r01/closure.patch](../review-evidence/minimal-core-plan-closure-20261109/combined-r01/closure.patch)，SHA-256：`50575be4591e42a15ac6f0c56f298b1b50129d63b8a890a684bf95136a510d25`。候选为`.tmp/minimal-core-plan-closure-combined-20261109/candidate`。19路径：生产7路径净减131行，测试10路径净增132行，文档2路径净减14行。没有新增依赖、版本变化或生产配置变化。

范围依据[原计划对应与完整尾项任务](MINIMAL_CORE_REMAINING_WORK_2026-11-09.zh-CN.md)。M5／R4重复编译和M8／R6随包消费者遗漏至此完成开发及本线独立复核；M9最终组合验证满足本次影响范围。其他事项沿用该任务中的逐项完成依据，未将SRT整体结论冒认为MC交付，也不重新打开已取消的D3或未来Ref／资源／并发专项。

## 实际改动与保留责任

| 改动 | 删除的重复工作 | 必要行为由谁承担 | 作者与消费者的影响 |
| --- | --- | --- | --- |
| 注册合同复用 | Worker不再在每次调用时从inputSchema重新编译合同 | 原view-owned-tools注册记录持有同一不可变compiled contract，AppKernel桥接，原Worker验证入口使用它 | App无须维护缓存或新增接线；同一声明继续负责参数合同 |
| IDE当前消费者迁移 | 旧interactionModes、view-instance投影分支及失效的143行启动包装退出 | 原Runtime安装／Scope／调用路径与IDE随包local-scoped-ide入口 | 使用正常安装的匹配包直接启动；文件仍以路径选择，无新增Ref包装或终端框架 |

复核实际源码确认：Worker仍先检查协商、App实例和完整注册绑定，再验证raw／effective参数、Ref来源顺序及对应关系、消息预算；进入handler前仍执行最终live绑定检查。Core授权前检查和SDK helper自身有效性检查仍保留。公开低层trusted factory的原有直调行为没有被偷偷改成强制参数校验。注册合同随原注册所有者释放；最后一个对应View关闭后不能通过旧activation取回合同，重新激活不使旧调用复活，替换注册使用新合同，App关闭后不可用。

Runtime有4个生成声明文件变化，包括Core注册表推导返回类型增加取合同方法，不能称Runtime声明逐字节不变。该方法不授予调用资格；MC没有改变SDK作者参数写法、公开协议版本或包边界。

终端实际支持的命令原本没有独立receipt操作。本次文档和测试改为按现有Core合同重发同一完整调用请求读取收据，未增加第二套收据存储。测试同时核对完整receipt相等和文件mtimeNs不变，证明不会重复写入。包身份断言采用真实解析路径，仍核对准确的Runtime／IDE文件，没有放宽成任意模块都算通过。

## 独立复核与验证依据

Owner已读19路径差异及实际注册、接收、调用、终端源码，没有仅依据执行报告批准。原始实现复核与最终组合核对属于同一次完整复核，组合没有引入额外生产逻辑。

- 原交付：Owner独立运行8文件109项参数／绑定／AppKernel相关测试，通过；独立运行正常安装包的终端9场景，通过，包含观察／采用、打开和写入、最新View、相同收据回读、真实LSP、恢复与实际关闭。核对537件安装文件与原tar一致。
- 最终组合：Owner独立运行注册合同测试及两个真实Node Worker ordinary／Ref测试文件，**3文件74项全部通过**，0失败／跳过；另核对**522件**当前正常安装文件与匹配三包tar一致。
- 执行方当前组合已有有效的Runtime／SDK／IDE构建、12文件255项相关测试，以及新安装包终端9场景；Owner核对原始JSON与命令，直接复用。原Runtime2098／SDK188全量结果仅作为原交付的有效证据引用，不冒称新组合再次执行过全量。
- 独立正向重放、反向恢复及whitespace检查通过。19个根目录目标在批准时均匹配新before，候选与after一致。对新before应用原patch后，唯一额外差异是新增测试的AppContext夹具移除两个已退役回调字段；生产逻辑没有额外变化。

先红证据也已核对：同一注册四次handler调用，旧实现普通／Ref各编译5次，候选各编译1次；失败是计数断言，不是缺依赖。该计数在真实dispatch函数与AppKernel同进程执行，未声称给独立Worker进程安装了编译spy；实际Worker测试负责验证进程接线。旧随包终端因Invalid interaction modes无法ready，随后正常释放；当前随包入口完成真实操作和关闭。

精确证据：[原实现独立测试](../review-evidence/minimal-core-plan-closure-20261109/owner-review/parameter-test-run.json)、[独立随包终端](../review-evidence/minimal-core-plan-closure-20261109/owner-review/local-entry-run.json)、[最终组合独立Worker测试](../review-evidence/minimal-core-plan-closure-20261109/owner-review/combined-worker-test-run.json)、[组合重放和差异](../review-evidence/minimal-core-plan-closure-20261109/owner-review/combined-verification.json)、[当前包与并行改动保留](../review-evidence/minimal-core-plan-closure-20261109/owner-review/combined-package-preservation.json)、[执行方最终交付](../review-evidence/minimal-core-plan-closure-20261109/combined-r01/final-delivery.json)。

## 并行工作与未覆盖范围

Clean的62路径已采用事实按其Owner结论接收，不追加代码复审。Owner只核对组合保留：60个非交集路径在候选中保持其after，两个交集文件仅叠加本线参数接线；AppKernel直接导入、旧OPEN排程／回调、reinitialize空回调及旧markDirty转发的删除全部保留，未恢复已删除的私有index。

没有本次阻断风险。原完整IDE工作流在受限环境的基线／候选均出现LSP后代进程关闭失败，正常本地权限候选通过；原失败仍保留，不把它们计为通过。本次原生LSP验证只适用于已测环境，不扩展到未测平台。GUI、真实模型、用户私有项目及正式发布未执行。组合时首次消费安装的旧tar路径锁冲突已在新隔离消费者离线更新锁后解决，生产锁和依赖未动；该失败不是业务回归红灯。

## 下一步范围、准出与执行指令

**不新增开发批次。** 本线已授权实现至此完成并获批准，下一步仅协调采用这份最终增量、核对根目录实际结果并更新本线结案状态。SRT Owner按既定分工接收MC结论和协调采用，不做第二轮代码审查；MC负责确认采用状态，不接管Clean开发线。

准出：19路径按批准的新before／patch精确采用；保留Clean已采用内容，两个交集文件以组合after为准；实际根目录按影响完成Runtime／SDK／IDE构建，记录采用前后身份与结果。没有实际新冲突时直接复用上述调用和包验证，不重复历史全量矩阵，不追加人工门禁。

Codex Prompt：

> MC Owner已批准上述combined-r01 patch。请按既定采用职责，在实际共享目录核对19个新before后选择性应用该patch，保留Clean全部已采用减法及其他人的修改。使用当前组合after核对结果，运行受影响的Runtime／SDK／IDE构建并记录；不再审查本线代码，不覆盖整棵候选，不提交、推送或发布。仅遇到真实内容冲突时处理精确交集。完成采用后主动报告，负责人不轮询聊天。
