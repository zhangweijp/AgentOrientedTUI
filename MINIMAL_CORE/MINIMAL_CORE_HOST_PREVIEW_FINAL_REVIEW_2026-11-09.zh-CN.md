# Host 预览 r02：完整独立验收

2026-11-09。**APPROVED，MC-HOST-PREVIEW-01 本次工程交付准出，批准精确七路径采用。** 执行 agent 完成整项修订后，负责人一次复核全部增量、重放实际补丁，并独立复验关联行为。首轮 R1/R2/R3 全部关闭，没有剩余已知阻断。签署时尚未采用，由 SRT Owner 接续根目录采用与构建。

本裁决依据[完整任务](MINIMAL_CORE_HOST_PREVIEW_DELIVERY_TASK_2026-11-09.zh-CN.md)、[首轮裁决](MINIMAL_CORE_HOST_PREVIEW_REVIEW_2026-11-09.zh-CN.md)、[r02完整交付](../review-evidence/host-preview-r02-20261109/REPORT.zh-CN.md)和实际源码。累计补丁 SHA-256：`c065dbd6d80efa129c781179f1ea871d4148151ff5ec1a702ba0e337df050dbc`；相对r01的四路径增量：`0d7a236711bad68357981995498c059c494ab4d6960a1aefabe521c8f3a31bc9`。候选位于 `.tmp/host-preview-r02-20261109/candidate`。

变化后的用户行为是：页面提交并发出既有更新通知后，停留中的预览会更新；首次查询与订阅交接不漏更新，迟到读取不能覆盖较新页面。同Topic的Session被后台回收后，正常再次激活能够恢复聊天和当前预览；其他Topic消息不改变本会话的空闲时间。关闭连接或订阅失败能释放监听，在途读取按原Scope责任结算并释放，不重新创建已关闭会话。预览错误通过现有日志/Toast可见，保留上一次有效页面。

R1/R2/R3 的关闭依据：

- **后台回收恢复：** Host 只在 ensureSession 返回的对象相对原对象确有替换时发既有 snapshot 事件，Router重新绑定当前Desktop并释放旧监听；聊天恢复原有的Topic路由合同。Bridge仍统一通过一个快照查询入口，替换通知使挂起旧读取失效。测试执行真实destroySession方法的资源端口，观察新消息、新页面及第二次更新，旧页面始终未回写。旧页面/失败连接迟到回调隔离不扩展成新的聊天消息身份协议。
- **无关消息过滤：** Router先检查topicId，后调用会更新lastAccessTime的真实getSession。其他Topic事件不再触碰目标空闲时间；30分钟空闲、5分钟清理及容量10等政策未变。
- **部分建立失败：** 首次订阅按资源取得顺序清理，Desktop拒绝或登记后抛错都不遗留Output/GUI listener。Bridge在subscribe前登记本连接handle，失败时释放并允许下次激活重试；旧失败流迟到data/error不影响继任流。已建立Topic流重绑失败时报告预览错误、继续聊天，替换失效通知仍能阻止旧读取回写。

独立验证与准确计数：

1. 七个共享目标仍等于原before，r02候选等于after；在负责人保留的r01副本实际应用增量，七路径逐字节等于r02。累计补丁可应用性通过。[身份与重放](../review-evidence/host-preview-owner-review-20261109/r02/identity.json)
2. 独立运行六个维护测试文件与负责人原反例文件，**80/80通过、0失败、0跳过**。其中77项为维护测试，另外3项是首轮独立失败反例的原样重放，不将重复验证计成80种独立业务场景。原三个失败均已转绿。[命令](../review-evidence/host-preview-owner-review-20261109/r02/test-command.json) · [完整输出](../review-evidence/host-preview-owner-review-20261109/r02/tests.json)
3. 核对499个相关源码路径，累计生产差异仅为任务中的五个Host文件，SDK/Runtime/Driver/Adapter无额外改动。SRT-11已采用输入保持。[范围与构建依据](../review-evidence/host-preview-owner-review-20261109/r02/scope-and-build-evidence.json)
4. r02测试语义类型、Host main/preload和GUI构建复用执行方有效证据，均退出0；负责人没有重复这三条构建或扩大到全量矩阵。采用后根入口构建由Owner负责。

此次删除了预览中的重复ensureSession责任，将预览当前值集中在Bridge现有查询/缓存路径；Router负责通知与监听释放，Host负责已有Session定位，原短期Source负责Context/Scope释放。App不需要补sleep、重复命令或手工切页，也不增加业务规则。必要连接状态留在原订阅闭包和原Map中，没有新管理器、轮询、第二通道、依赖或核心协议改造。

未覆盖边界保持诚实：验证是当前真实Host getter/Router/Bridge/Source/Core与happy-dom渲染，注入受控Session/Desktop/传输/资源端口；没有运行真实Electron IPC、完整用户GUI/模型、用户配置/数据库或完整Worker信号策略矩阵。有通知的提交自动刷新，无通知不另加轮询；未宣称实际GUI体验已在本轮验收。原事故/NOT_ADMITTED材料、既有人工签收及首轮失败均保留，不重新打开它们作为本次审批门槛。

下一项是本次交付的**根目录采用与入口构建**，不是新增功能。准出为七路径匹配批准after，原件可追溯，根Host main/preload与GUI构建通过，更新唯一索引。其余已通过行为直接复用本裁决，遇到新的实际冲突再协调；不重跑Runtime全量、Planning或性能矩阵，不自动发布。

Codex Prompt：

> 按r02 changes.json核对共享七目标仍为批准before，保留六份原件，采用累计七路径；确认after与本报告批准候选一致。构建根Host main/preload及GUI，记录实际结果，更新deepseek唯一索引。复用本次77维护项及三个独立原反例通过的结论，不追加第二轮行为矩阵。保留首轮失败和历史事故材料，不改SDK/Runtime/Driver、政策或公开入口，不提交/推送/发布。
