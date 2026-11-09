# Host 预览完整交付：首轮独立验收

2026-11-09。**CHANGES_REQUESTED，三项生命周期问题一次汇总，当前候选不得采用。** 指定执行 agent 完整交付七路径后，负责人审查了全部补丁及实际调用方，在独立副本运行六文件原有验证并补充生命周期反例。不是分片审批；下面三项作为同一完整任务的一次修订连续完成。

本裁决针对[交付报告](../review-evidence/host-preview-delivery-20261109/REPORT.zh-CN.md)及补丁 `aeb232ddc1a51863e757f4f280fa3c7f691847e3490c3f781dc454156a9f3cf8`。候选 `.tmp/host-preview-delivery-20261109/candidate`，独立副本 `.tmp/host-preview-owner-review-20261109`。共享七目标仍匹配 before，候选与 after 一致，可应用性通过；[独立身份](../review-evidence/host-preview-owner-review-20261109/identity.json)。未写共享生产代码。

**R1／P1：后台回收后重新激活同一 Topic，事件流仍绑定已销毁的 Session。** Router 在订阅时捕获 Session，随后 `current()` 要求它一直是当前对象；Bridge 在 `ensureSessionSubscription` 见到旧 subscription 就返回。正常 SessionManager 已有空闲清理和容量驱逐，销毁后不会让 Bridge 清除这个连接。用户随后重新激活会创建新 Session，但 Router 继续拒绝该 Topic 的新聊天事件，预览仍监听旧 Desktop。受影响的是正常聊天恢复，不只是预览文本。

位置：候选 `host/src/trpc/router.ts:215`、`:223` 与 `host/src/gui/ChatBridge.ts:1023`。现有真实触发链见 `host/src/core/session-manager-v3.ts` 的 `destroySession`、`evictOldestSession`、`startCleanupTask`；默认空闲30分钟、每5分钟清理、容量10，不需要新增场景或政策。

独立反例使用真实 Host/Router/Bridge 和原受控 Session 端口：建立预览，后台移除原 Session，`activateDesktop` 重建相同 Topic，再经真实 Host emitter 发送 assistant 消息。新 Session 已存在，Bridge 却收不到消息。相同用例在原五生产文件上通过、候选失败。修订须让正常重新激活恢复当前 Session 的聊天和预览，释放旧监听，并继续拒绝旧实例的迟到结果；不要简单移除所有身份校验。

**R2／P2：无关 Topic 的消息会重置其他 Session 的空闲时间。** Router 的 GUI 回调先执行 `current()`，再比较 `event.topicId`。`current()` 调用的真实 `SessionManagerV3.getSession` 并非无副作用读取：它更新 `lastAccessTime`。因此只要任一聊天持续发事件，所有已订阅且仍存活的 Session 都被记为刚访问，改变现有空闲回收行为。

位置：候选 `host/src/trpc/router.ts:217`、`:223`；实际触碰在 `host/src/core/session-manager-v3.ts:117`。独立用例将 fixture lookup 接到真实 `getSession` 方法，把目标时间设为1，发另一 Topic 的消息；候选把时间改为当前时间，原代码保持1。修订应让过滤无关事件不改变 Session 活跃状态，不重设计回收策略。

**R3／P2：Desktop 订阅失败时，已取得的 Host GUI listener 没有释放。** Router 先注册 `onGuiUpdate`，再调用 `desktop.output.subscribe`；后者抛错时，observable 的 cleanup 还没有返回。真实 Desktop 的订阅入口会 `assertActive()`，关闭过程确实可能拒绝新订阅；SessionManager 又是在等待 Desktop 关闭后才标记 destroyed，不能只靠前面的状态字段排除这个窗口。

位置：候选 `host/src/trpc/router.ts:222`、`:227`，实际拒绝入口为 `runtime/src/engine/core/desktop.ts:116`。受控 Desktop subscribe 抛错后，真实 Host emitter 的 listener 数仍为1。该反例验证候选新增的部分订阅失败路径，没有将它包装为原代码上的新失败对照。修订须在建立连接失败时释放已取得的资源，并让错误通过现有入口可见；不增加通用资源管理器。

验证记录与边界：

- 独立六文件 **70/70 通过**，与执行方相符；第一次带R1的运行共71项，70通过/1失败。见[candidate-tests.json](../review-evidence/host-preview-owner-review-20261109/candidate-tests.json)。已证明的持续更新、同一连接合并读取、前端主动关闭重开、独立 Agent Context、在途读释放和 Toast 行为保留。
- 完整独立生命周期补充为 **3项、3失败**；见[原反例源码](../review-evidence/host-preview-owner-review-20261109/owner-preview-lifecycle.test.tsx)、[候选结果](../review-evidence/host-preview-owner-review-20261109/candidate-lifecycle.json)。R1/R2使用原生产文件的对照为2/2通过；第三项被命令名过滤，仅针对候选失败路径，不列为基线通过或维护测试跳过。见[基线对照](../review-evidence/host-preview-owner-review-20261109/baseline-lifecycle.json)。全部命令、日志保存在同目录；对照结束已恢复独立副本为候选 after。
- 阅读真实 Worker 刷新及发布通知边界：当前 unchanged 不触发新输出通知；没有据相似调用推断一定存在自刷新循环。Scope 释放和未采用 Agent Observation 的实现保持不变。
- 构建、GUI构建和新增测试类型检查复用执行方已完成证据；本轮已发现明确阻断，未重复整套构建。没有运行真实 Electron/IPC、完整 SessionManager 建模循环、用户 Host/数据/模型或 Runtime 全量。反例使用当前目标模块和受控生命周期端口，未启动30分钟计时器。

整体方向符合 Minimalist：删除预览重复 ensureSession，现有事件仅传失效通知，Bridge 复用一个读取入口，App 不再为刷新补额外命令。三项修订集中在已有连接、过滤和释放职责，不改变 SDK/Runtime、产品语义、公开 API、信号或资源政策。其他未覆盖风险沿用交付报告；历史事故材料与旧人工签收保持原结论。

下一次准出：R1/R2的原对照保留，三项反例在修订候选转绿；正常重新激活的新消息及新预览可见，旧消息/迟到查询不能串入；无关 Topic 不刷新空闲时间，部分订阅失败不遗留监听。复跑受影响的原70项与必要构建，保留全部已有失败，形成一份新的完整 patch 与 before/after，负责人集中复核增量及关联行为后统一裁决，不重新开启无关矩阵。

Codex Prompt：

> 连续完成本报告R1/R2/R3，仍属MC-HOST-PREVIEW-01完整任务。复用负责人反例确认问题，自主选择最小实现并补入维护测试；保留现有单读取路径、旧实例隔离、错误反馈和Scope释放。只修现有Host连接生命周期、事件过滤和部分失败清理，不变更SDK/Runtime/Driver或回收政策。保留r01材料，整项修好、相关回归及构建完成后一次提交r02 READY_FOR_REVIEW。普通选择不逐点申请批准，不修改全局索引或共享生产文件。
