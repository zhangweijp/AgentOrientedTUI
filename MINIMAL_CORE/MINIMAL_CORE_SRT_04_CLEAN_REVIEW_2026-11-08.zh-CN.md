# SRT-04 提交后刷新：r01 独立复核

2026-11-08。**CHANGES_REQUESTED：修复一处已经复现的 SDK 完成等待问题，再复核本片。** 代码由 Clean 负责，SRT Owner 管理交付，Minimal Core 负责人独立审查。此次依据实际补丁和运行结果判断；此前 API 方案中的未定细节不作为开工或验收的额外门槛。

本片要解决的问题很具体：应用已经提交一次更新后，Agent 下一次查看页面，应拿到相容的新 View、Ref 和 Tool。操作自身成功而页面更新失败时，应报告观察失败，保留原操作结果，不再次执行业务。

**审查对象与实际改动**

- 候选：[candidate-r01](../.tmp/srt-04-clean-20261108/candidate-r01)。共 13 个变更路径，其中 8 个生产文件净增 153 行。
- 补丁 SHA-256：`c00022345621b4cbcbd4a8ca7a82684860ecf29897d7c33d44c2a4841c14a38a`。
- 最终源码清单 SHA-256：`56ae6b11628990636e63879c22bd36c2717bdf5d0629ce3628047f418a436af6`。
- 交付清单 SHA-256：`c76bc3b5a8cc1a3f92e92cbf58ace7cc1eed838480a2769f8bcc9c83fe0ef1d3`。

负责人审查了全部生产差异，并在新临时目录从原文件重放 13 路径补丁，结果逐项匹配候选。整份基线、交付包的完整核对沿用 SRT Owner 已完成的记录，不再重复全树盘点。[本轮身份与重放记录](../review-evidence/srt-04-clean-review-20261108/identity-and-replay.json)。

实现复用现有 projection coordinator、Snapshot Receiver 和 Scope.observe。SDK 提供实际渲染完成信号；Host 在 observe 前请求 Worker 刷新，确认快照通过既有接收校验后才观察。工具返回前原来固定等待一次微任务的做法已退出，业务终态与后续投影等待分开。没有引入第二套业务状态管理器，也没有让 App 作者自行拼接 View、Ref 和 Tool 的一致性。

**需要修复的实际问题：在 act 中初始化后，完成等待会漏掉已排队渲染。**

相关位置是候选 `sdk/src/app-factory/createTUIApp.ts:133` 和 `sdk/src/app-factory/render-commit.ts:7`、`:26`。初始化时安装的调度包装会被 Preact `act()` 结束时恢复的原钩子覆盖；之后的更新进入原调度队列，却没有进入新代码的 `scheduled` 记录。于是 `whenProjectionCommitted()` 可以在渲染仍未执行时成功返回。现有 M4 作者验证 `sdk/tests/srt01-m4/author-eval/check.mjs:56` 就使用在 act 内初始化的方式。

负责人用相同的受控调度器做了两个对照；只改变是否在 act 内初始化。随后更新状态、开始等待，明确保持渲染回调未释放：

| 初始化方式 | 队列中未执行回调 | 完成等待是否已返回 | 当时 View / Ref / Tool |
| --- | --- | --- | --- |
| 普通初始化 | 1 | 否，符合预期 | 旧正文、旧 Ref、工具未激活 |
| act 内初始化 | 1 | **是，错误** | 旧正文、旧 Ref、工具未激活 |

这证明当前信号不能在该现有作者路径上代表提交完成；不是依靠猜测延迟推导的问题。[复现代码](../review-evidence/srt-04-clean-review-20261108/sdk-act-refresh-repro.test.tsx)、[实际状态](../review-evidence/srt-04-clean-review-20261108/sdk-act-refresh-facts.json)、[原始测试日志](../review-evidence/srt-04-clean-review-20261108/sdk-probes.log)。本轮没有证明普通初始化的真实 Worker 同样失败，也不将此结果扩大为全部运行路径失效。

**独立验证结果**

在新的 `/private/tmp/aotui-srt04-replay-r14e6p9m` 中实际运行交付的复跑入口，11 个步骤全部退出 0：Runtime / SDK 正常冻结安装与构建、17 项刷新测试、12 项 SDK 投影测试、TS7 严格公共类型、正式安装包的严格编译和两种 Producer 消费。[命令与退出码](../review-evidence/srt-04-clean-review-20261108/replay/commands.json)。普通 TS 完成实际 Ref 调用并释放资源；真实 SDK Worker 使用两个 App，完成 3 次业务调用，Runtime 正常关闭且资源释放。[普通 TS 事实](../review-evidence/srt-04-clean-review-20261108/replay/public-plain-facts.json)、[Worker 事实](../review-evidence/srt-04-clean-review-20261108/replay/public-worker-facts.json)。

另外独立运行现有 Worker 资源、发布、Scope 交互回归，共 25 项通过。Scope 文件首次因缺少测试要求的隔离目录环境变量在 beforeAll 失败，16 项当时未执行；补齐仅属于复核环境的目录后，该文件 16/16 通过，测试源码和断言均未修改。[首轮日志](../review-evidence/srt-04-clean-review-20261108/related-worker.log)、[补齐环境后的命令与退出码](../review-evidence/srt-04-clean-review-20261108/related-scoped-command.json)、[16 项结果](../review-evidence/srt-04-clean-review-20261108/related-scoped.log)。

另有一项 SDK 旧断言单独登记：`sdk/src/view-type-tool.integration.test.tsx:482` 仍要求多个／可选 Ref 注册失败，与已经接受的 SRT-02 支持范围冲突。负责人确认原基线和 r01 的该文件字节一致，并定向复现同一失败。执行方封存的默认全量结果是基线 171 通过 / 1 失败、候选 173 通过 / 1 失败；负责人没有重新运行默认全量。这项不能归因为本片新回归，也不能据此声称 SDK 全绿。SRT Owner 已交 Clean 作为单独可识别的测试迁移增量处理。

**范围与剩余风险**

上述运行证据支持本片普通路径、无变化、观察失败保留成功收据、超时和关闭处理；act 路径尚需修复。自定义异步 renderer 仍须按文档提供完成信号，当前正式包证据针对本轮配对的 Runtime / SDK。SRT-05 的新观察采用与旧资格释放、Driver 上游严格类型问题、原生 LSP 退出问题、共享采用及最终 Semantic 验收均不在本轮完成范围内。未运行完整 Runtime 默认全量、GUI 或真实模型。

**下一批范围、准出条件与执行 Prompt**

下一批只修本次漏等问题并加入能复现旧失败的回归；旧 Ref 断言迁移保持独立可审查差异。保留 r01，交付 r02 的实际差异和匹配的新包。准出条件是：受控回调未释放时等待不返回，释放后 View / Ref / Tool 同步更新；关闭仍可结束等待；相关构建、刷新和作者路径测试通过；重新打包后两种公开 Producer 消费通过。只对本次实际影响补充验证，不重开无关工具链或历史盘点。

> Clean：请在现有 SRT-04 隔离候选上修复 SDK 在 act 内初始化后漏跟踪后续排队渲染的问题。复现代码和事实见本报告链接；自行选择最小实现，不以固定延迟掩盖完成条件，也不要求 App 作者承担框架等待职责。保留 r01，新增回归并复验受影响路径；按 SRT Owner 已下发的范围，另行迁移那条与多个／可选 Ref 现状冲突的 SDK 断言，保留原失败证据。交付 r02 的 patch、必要测试结果、匹配的包和未解决问题，由负责人独立复核。不要修改其他执行者拥有的文件，不应用到共享生产或发布。

本轮没有修改生产代码、原候选或封存交付。实际修复已通过 SRT Owner 交给 Clean；不重复派给另一执行者。
