# MC-HOST-PREVIEW-01 静态交付独立复核

2026-11-06。裁决：**APPROVED，仅批准本轮静态分析、失败证据封存和后续任务建议的交付。** 不批准修复采用或恢复 Host 运行。预览缺陷仍为 **OPEN**，未取得有效的新行为复现；事故与隔离预检的 **CHANGES_REQUESTED / NOT_ADMITTED** 保持。

本次由 Minimal Core 负责人独立复核执行 Codex 的交付。执行者没有自行批准代码；本轮没有生产 patch。已交给用户的手测状态、SDK/Planning 候选和既有 GUI 签收均未因本次裁决改变。

## 核对对象与依据

- [执行者报告](../review-evidence/minimal-core-host-preview-20261106/REPORT.zh-CN.md)，SHA-256 `5dcf5f475409314df783b81341af49397f4a4e6a554a55463b42e1d64bc6ae50`。
- [最终交付清单](../review-evidence/minimal-core-host-preview-20261106/final-delivery.json)，SHA-256 `e418dad9110a245f0fd2e4c6f317f509e3c26af83954cdde5ad3eb2182f84b14`。负责人逐项核对全部 **82 件**执行者文件的字节数、SHA 和目录集合，清单没有纳入 owner-review。
- 固定源码为 Git `853495dd9954eb4f8a91998bcc59e19326765981`。负责人将全部 **341 件**基线文件与 Git blob 身份及保存的 archive 逐字核对；**24 处引用、14 个不同文件**的原件及位置核对通过。
- 本阶段此前已独立核对 Runtime B23 tar `46c39d59…` 的 **388 件**载荷、SDK 候选 tar `7573cc0b…` 的 **90 件**载荷与实际解包文件相同。本轮复核保存的原包指纹和既有审查记录，不将其说成再次行为运行。
- 当前诊断入口与第二轮封存原脚本之差，确实仅为顶端无条件暂停异常。核对只读取源码，不执行该脚本。四份被引用的负责人历史裁决指纹保持。

可重跑的核对脚本为 [verify-static-delivery.py](../review-evidence/minimal-core-host-preview-20261106/owner-review/verify-static-delivery.py)，结果为 [static-delivery-check.json](../review-evidence/minimal-core-host-preview-20261106/owner-review/static-delivery-check.json)。它只做静态文件、Git 和 tar 核对，不导入项目模块、不读用户私有状态、不启动 Host/Runtime/GUI。

## 独立技术判断

源码支持以下事实：

1. `App.tsx:429` 在进入 TUI 或切换 Topic 时请求快照；`ChatBridge.ts:346` 执行查询并写缓存，而 `:486` 的 getter 只读缓存。普通消息通知触发 renderer 重读缓存，不能使缓存自行变新。
2. 当前 `session.events` 只转发 Host GUI 事件，未把 Desktop 输出通知接到独立预览查询上。Bridge 已有 snapshot 接收分支，正式 GUI 事件类型尚未覆盖它。旧 WebSocket PushService 不能作为本条 Electron tRPC 链已经接通的依据。
3. `router.ts:210–226` 丢弃了 `onGuiUpdate` 的取消函数；`HostManagerV2.ts:287` 实际已提供该函数。接入刷新时必须同时补齐订阅清理，不能只证明前端 Map 被删除。
4. `readSemanticDesktopSnapshot` 自己创建短期 Source/Context，并在 finally 中 release/dispose。这是 GUI 独立读取的现有责任，必须保留；不能借用或撤销 Agent 正在使用的 Context。
5. Runtime 在特定 SNAPSHOT_PREPARED 路径接受快照后才通知，但 Desktop 输出不是所有提交的通用回执。`never` 可发布而不发该信号，`manual` 的未发布变化不在 Store 中。仅复用此通知源不能承诺所有策略下持续同步。

上述位置均指交付中保存的固定源码。当前共享树与固定基线存在差异；后续不能直接覆盖共享文件，也不能把这些静态事实当作当前共享树的完整行为验收。

“首次查询早于异步发布，后续缓存未被更新”是与源码相符的候选解释。原 GUI 症状没有查询与提交的完整共同时间线，两轮新探针又未到达目标断言，因此仍不能称为已证实的完整根因。报告正确保留了这一边界。

## Minimalist 与行为保证

- 本轮没有删除生产实现，不虚报代码减量。建议复用现有 tRPC 事件、Bridge 缓存和预览读取，避免恢复第二套推送通道或增加通用管理器。
- SessionManager 继续拥有 Session/Desktop 生命周期；订阅创建者负责取消；短期预览 Source 负责自己的观察释放；App 保有业务状态和校验，Agent Context 保有既有调用资格。
- 本轮真实新验证是静态交付的完整性。此前权限反例及失败运行按原裁决保留，均不证明预览已修复；真实 Host→tRPC→Bridge 行为验证仍缺失。
- 预期简化是让页面自动反映已提交状态，应用作者无需添加 sleep、轮询或重复提交。它尚未实现，不能提前计入作者接口收益。

## 未覆盖风险

尚未验证修复有效性、初次订阅窗口、持续更新、查询返回乱序、同 Topic 关闭重开、Driver 暂停、完整取消和在途读取结算。预览错误如何沿现有入口呈现也须在实施时核对，不能以正常空页面掩盖错误。

首轮配置读取和四个模块的顶层执行已确认，额外副作用因没有事前指纹或完整 I/O 审计而保持未知。静态指纹和后续权限检查不能补出用户私有状态未变的证明。事故与预检分别见 [事故裁决](MINIMAL_CORE_HOST_PREVIEW_INCIDENT_REVIEW_2026-11-06.zh-CN.md)、[准入裁决](MINIMAL_CORE_HOST_PREVIEW_PREFLIGHT_REVIEW_2026-11-06.zh-CN.md)。不为追补证明而扫描私有目录。

## 下一批范围、准出条件与 Prompt

Host 后续任务为有界复现及最小刷新接线，**当前尚未开工**。先满足运行环境准入，再由负责人固定当轮基线和实际文件范围。当前没有合格环境；不启动新 Docker、不下载镜像、不扩权，也不恢复第三轮 Host。Host 内部事件类型的补齐本身属于日常技术判断，不自动升级为 SDK/Runtime 公共 API 审批。

建议生产范围仅为 `host/src/trpc/router.ts`、`host/src/types/session.ts`、`host/src/gui/ChatBridge.ts`。测试可复用现有 chat-bridge、semantic-desktop-preview，并增加一个有界真实链用例。实际失败若证明还需其他文件，必须先给出依据再调整，不能预先扩展到 SDK、Runtime、Driver 或 App。

准出必须同时满足：

1. 在不挂载个人数据、没有真实凭据且进程禁网的合格环境中，基于真实目标源码和精确包建立有效失败；缺依赖、实例 ID 错误和日志包装 exit 0 均不算复现。
2. 首次预加载正确；异步提交后无需业务命令、模型调用或切 tab 即更新；持续停留至少两次提交均更新。以 Host 实际接受快照为依据，不靠固定 sleep。
3. Driver 暂停时预览独立；按 auto/never/manual 现有合同说明支持边界，不借此改信号策略。
4. 乱序查询不恢复旧页，切 Topic 不串页，同 ID 重开不接收旧实例结果；GUI 不改变 Agent 原 Context 的资格。
5. renderer→Bridge→tRPC→Host→Desktop 的订阅均按所有权清理；已进入的读取实际结算，关闭后不再 emit 或重建 Session。预览失败可见且不破坏聊天流。
6. 保存失败原件、真实修复前后对照、当轮独立 patch、类型/构建/包消费与关闭证据，状态 READY_FOR_REVIEW，交负责人独立裁决。

完整可下发草案为 [NEXT_IMPLEMENTATION_PROMPT.zh-CN.md](../review-evidence/minimal-core-host-preview-20261106/NEXT_IMPLEMENTATION_PROMPT.zh-CN.md)，SHA-256 `45a1a186726c5c84585a3be0dad741dcb499d2ba9790b38cc8cff5887df399b9`。该文件是待满足准入条件的任务包，当前不是运行许可。

执行 Codex 本轮交付冻结。SRT Owner 另负责 SRT-02 剩余范围的静态核查和任务包；本线复核其范围，不另启动重叠实现。共享采用、发布及最终 Semantic 验收未因本次静态 APPROVED 获得授权。
