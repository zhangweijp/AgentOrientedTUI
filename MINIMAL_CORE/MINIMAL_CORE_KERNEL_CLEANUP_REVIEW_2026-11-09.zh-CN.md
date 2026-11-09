# 内核第二轮减法：独立复核

2026-11-09。裁决：**APPROVED**。指定MC执行Agent已完整交付，MC Owner独立审查实际源码、补丁、测试迁移和运行证据，未发现需要修订的问题。批准本报告对应的14路径候选；本裁决写入时尚未采用共享生产。

## 批准对象与实际范围

- 任务：[内核第二轮减法](MINIMAL_CORE_KERNEL_CLEANUP_TASK_2026-11-09.zh-CN.md)。
- 候选：`.tmp/minimal-core-kernel-cleanup-20261109/candidate`。
- [执行报告与补丁](../review-evidence/minimal-core-kernel-cleanup-20261109/REPORT.zh-CN.md)；patch SHA-256：`3e56735d3bae609d9911caffb191bd5803a171bcf52baa18b236326fd2e41e3f`。
- 报告 SHA-256：`e894eef54a089336b63a8cb481275fd9c8cd8504c6c84ce03f02e64ce224162b`。
- 共14路径：11个生产路径新增126、删除437，净减311行，其中5个文件退出；3个测试文件净减42行。配置、依赖和当前文档无变更。

负责人逐项核对14份before、after、实际共享内容及候选，并在临时目录独立重放patch，全部一致且whitespace检查通过。进一步比较实际Runtime／SDK源码和相关包／构建配置，候选差异恰好为这14路径，没有额外改动或Clean占用文件交集。两份tarball与正常安装位置的431个文件逐字核对一致。依据见[身份与差异核对](../review-evidence/minimal-core-kernel-cleanup-owner-20261109/identity.json)。

## 删除为什么成立

**ArrayRef不再维护重复的初次登记数组。** 初次登记按数组整体、各元素依次生成互不相同的局部名称；现有Map按同一顺序保存每个成功取得的句柄。失败时从Map反向释放，与原数组的释放对象和次序相同。更新阶段的added列表继续保留，因为它区分本次新取得的绑定与既有绑定。真实部分注册失败、重命名、旧所有者清理、更新及卸载断言保留，Ref责任没有交给App。

**LLM事件监听直接调用当前回调。** 删除的handler只转发给callbackRef.current，未增加校验、绑定或生命周期责任。DOM listener、事件映射、最新回调引用、提交时订阅和同一listener注销均保留。负责人运行的真实Worker输出测试和SDK订阅测试覆盖最新回调、内容／reasoning／usage及关闭后不再接收。

**SignalBus退出没有生产使用者的Desktop Mirror DOM观察器。** 实际observeDOM没有生产调用者，stopObserving仅来自旧suspend／cleanup路径；Desktop已无对应Mirror DOM。Worker自己的DOM提交、投影及MutationObserver没有删除。剩余状态直接由Desktop ID映射到订阅者Set，取消闭包仍捕获原Set，旧Desktop取消不会误删同ID新Desktop订阅。异常策略、通知、统计、共享服务隔离、重入关闭和清理保留。仅删除3项退休observer方法专属测试，未弱化仍有效的信号与关闭断言。

**固定规则的页面转换退出visitor框架。** 原traverse是私有函数，默认数组始终只有View与HTML两个规则，HTML匹配恒真，生产始终传入递归函数。现实现沿用文本／非Element／hidden检查，再处理显式View根，最后调用原HTML算法；注册、优先级排序、可选递归参数及不可达fallback因此无必要职责。忽略缩进后，HTML算法差异仅是对象方法改为函数、移除包装和改为直接使用必有的递归函数；列表、代码围栏、链接、参数隐藏与正文格式均保留。五个旧模块未从受支持包入口导出，实际唯一生产消费者仍是Worker的view-fragment-extractor。

14项格式用例迁到实际transformElement入口，负责人核对了执行方在原生产上先通过的记录及失败修订：首次fixture因HTML实体被拆成多个Text节点而失败，随后使用单Text节点赋值，原完整字符串预期保留；生产未因fixture失败而修改。没有将这次fixture问题包装为产品缺陷先红。

四项原则均满足：删除重复记录与无职责的框架层；现有Map、订阅Set和Worker转换／提交链承接行为；实际合同及真实调用证明保留；作者接口不增加，维护者少理解一套visitor注册与排序机制、一套Desktop DOM观察器和重复句柄记录。

## 验证与证据

| 验证 | 实际结果 |
| --- | --- |
| MC Owner独立运行Runtime相关合同 | 8文件54项通过：完整转换用例、SignalBus、Desktop及订阅／关闭生命周期、真实Worker LLM输出。 |
| MC Owner独立运行SDK相关合同 | 3文件28项通过：Ref所有权、类型／更新／清理、公共组件与当前事件订阅。 |
| MC Owner独立运行正常安装包Worker | 普通参数与Ref两次实际调用成功；关闭ok且resourcesReleased=true，Scope／bytes归零，池中Worker归零。 |
| 执行方默认完整回归，负责人检查原始全部断言 | Runtime131文件2089项，SDK20文件187项；0失败／跳过／todo。Runtime比前轮少3项，均为退出observer的专属测试。未重复跑全量矩阵。 |
| 执行方构建、严格类型与正常包消费 | 两包构建、SDK两个严格项目、正常tarball安装、纯Core及公共SDK／Host严格类型、Core真实调用均成功；负责人核对19条必要命令记录均退出0。 |
| 负责人独立声明核对 | SDK17份声明逐字相同；七个公开入口声明相同。Runtime五个旧模块声明退出、三个内部声明随实际减法变化，无新增声明。 |

负责人原始记录统一在[本轮独立证据目录](../review-evidence/minimal-core-kernel-cleanup-owner-20261109/review-facts.json)，包含运行结果、命令日志、原始断言与Worker资源结算。执行方有效检查直接复用，没有追加历史完整矩阵。

## 剩余范围与验证边界

本候选没有未解决的代码问题。真实GUI／模型、无关IDE／LSP资格和人工Planning流程未重跑；本轮没有修改这些入口，也没有新增人工验收对象。未提交、合并、推送或发布；整份SRT尚在进行的合同任务不属于本批准结论。

另有一个具体减法项：`runtime/src/facades/index.ts`只作转导出，但删除需要同时迁移Clean已占用的CLI及根导出消费者。本轮正确避开交叉写入。后续在Clean当前完整合同交付中合并处理：CLI直连`facades/facades.ts`，根入口分别导出既有工厂／配置，两个内部集成测试改为直接来源；保留公开符号及行为。这是实际已识别的后续清理项，不把它列为当前14路径的失败，也不另设一次细碎review。

## 下一步范围、准出与执行Prompt

下一步直接采用批准的14路径。SRT Owner接收MC唯一审查结论，选择性应用，不做第二轮代码审查；Clean继续其完整合同任务并吸收本轮基线。采用准出为：before匹配及必要原件保留，9个after匹配、5个源码及对应旧产物退出，实际根Runtime→SDK构建通过，更新准确的采用记录。依赖未改，无需安装或重复82项与全量测试。

> 采用本报告批准的kernel-cleanup.patch，先逐项核对14个before，选择性应用并保留原件；不要整树覆盖。重建实际根Runtime和SDK，核对9个修改文件与5个删除文件及对应旧产物。沿用MC完整裁决和已有有效测试，不重复审查或矩阵。将facades/index退出并入Clean当前涉及CLI／入口的整项任务，由该线一次验收；不要为此停下14路径采用。完成后主动提交采用事实，负责人不轮询聊天，不新增人工确认，不提交或发布。
