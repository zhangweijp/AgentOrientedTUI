# SRT-14 新上下文作者试用：独立验收

2026-11-09。裁决：**APPROVED／NO_CHANGE**。本次一个作者、一个小 App 的限定作者试用完成，无待修订项；无需修改生产、公共指南、示例或 skill，也没有生产补丁需要采用。试验 App 保留为验证产物，不加入正式产品清单，不追加人工验收。

## 批准对象

[完整任务](MINIMAL_CORE_AGENT_AUTHOR_DELIVERY_TASK_2026-11-09.zh-CN.md)、[执行报告](../review-evidence/srt-14-agent-author-20261109/REPORT.zh-CN.md)、[最终 App](../review-evidence/srt-14-agent-author-20261109/final/src/app.tsx)。

- 报告 SHA-256：`edb6cf91a433e7a9c503365dcaabbe58a2abbe077538788f649b30c80c057cba`。
- 首次完整源码／初稿／最终源码共同 SHA-256：`2940f692bb0c6122b730b4f64ddf5e24d2ff15a937c8ebb941b83e8615ceb686`。
- 独立重编 App 与原产物共同 SHA-256：`efc20b64ed736d49063e311882309d2cf247ea4d051a461aee5e469590edef03`。
- 固定输入仍是批准的 SRT-13 Runtime／SDK tar；本评测不追随并行 SRT-15 的根目录采用。

## 作者边界与代码复核

执行方通过 `fork_turns:none` 创建新作者，提供 18 份公共资料、业务任务和匹配安装包。负责人除核对保存的创建／查阅记录外，还读取了作者子聊天 `01a1bdfe-5b73-7ee2-93c0-6402fc11bb95` 的两轮实际活动：首轮查阅限定指南、示例及已安装声明，写完 App 后保存首次原件并执行一次成功构建；反馈轮只新增确认记录，没有代码修正。可见活动与报告一致。材料范围依靠任务指令限定，不把它解释为访问控制沙箱或完整文件访问审计。

负责人实际阅读全部 App。它只从 `@aotui/sdk`、`typebox` 导入，使用公开 Preact JSX 入口；单份 ToolSet 与 AppTools 绑定、useArrayRef／useDataRef 发布、refParam 消费均属于现有公开作者合同。内部 ID 保留在业务状态和 Ref payload，模型通过已展示 Ref 选择目标。handler 校验对象存在与当前打开对象，普通标题／正文仍用普通参数。页面保存业务数据，Tool 仅返回简短收据；Scope、Observation、Ref 解析和最终资源释放由公共 Host／Runtime 承担。

因此，**零私有 API 依赖、首次构建通过、作者修复 0 轮**可以作为这次样本事实。公共材料未暴露具体阻碍，不构成必须修改文档的理由；不以新抽象、helper、状态管理器或更多样例制造表面交付。

## 负责人独立验证

负责人在 `.tmp/srt-14-minimal-core-review-20261109` 复制冻结 App 和已审查的公共 Host 脚本，使用经核对的原正常安装依赖，分别严格重编两者后运行真实 Node Worker。没有修改原稿或执行方证据，没有再运行安装器或历史包矩阵。

| 检查 | 独立结果 |
| --- | --- |
| 输入 | 18 份材料原件指纹一致；Runtime 372／SDK 86 件安装文件与批准 tar 逐字节一致。 |
| 类型与产物 | App、Host 的 strict／exactOptionalPropertyTypes／skipLibCheck:false 检查均退出 0；重编 App JS 与原初稿产物逐字节相同。 |
| 真实行为 | **10 个状态帧、11 次调用**通过，全部经过公共 Runtime Host → Node Worker → SDK App。 |
| 正常结果 | 8 次 succeeded，覆盖两对象打开、各自编辑、关闭与重开读取保留内容。 |
| 业务拒绝 | 1 次 entered-returned／failed，effects:none，业务错误为 BOOKMARK_NOT_OPEN；另一对象未被误改。 |
| 旧观察拒绝 | 2 次 not-dispatched／rejected，错误为 OBSERVATION_UNAVAILABLE；未发生业务执行或未知结果重试。 |
| 页面与能力 | 每帧观察页面集合与完整 App source 一致；最新正文替换旧正文，详情关闭后页面及 edit／close 能力退出，Root 静态说明保持。 |
| 结果对照 | 10 帧完整 View 消息、11 次输入和完整 outcome／executionPhase 与执行方一致；未仅比较 success 标签。动态运行身份与时间仍保存在各自原始输出，未声称这些运行元数据逐字一致。 |
| 关闭 | 完整关闭报告与执行方相同，ok=true、resourcesReleased=true；Scope／字节／存储 owners／IO／pendingTasks／WorkerPool 计数为 0。 |

证据：[独立输入与构建身份](../review-evidence/srt-14-minimal-core-review-20261109/identity.json)、[实际命令](../review-evidence/srt-14-minimal-core-review-20261109/commands.json)、[完整行为输出](../review-evidence/srt-14-minimal-core-review-20261109/behavior.json)、[逐调用语义核对](../review-evidence/srt-14-minimal-core-review-20261109/verified-call-results.json)、[作者实际活动复核](../review-evidence/srt-14-minimal-core-review-20261109/author-activity-review.json)、[机器裁决](../review-evidence/srt-14-minimal-core-review-20261109/verdict.json)。

协调者原宿主类型错误、错误选取尚未存在的 detail 和原超时均已检查并保留；两个失败运行的业务调用数为 0，关闭成功。最终夹具会核对完整 source 页面集合，不能靠只挑两页而假装详情已消失。归因为验证夹具错误成立，不计作者修复；也不能把本轮整个协调过程描述为从未失败。

## 结论边界与剩余风险

批准的是固定材料和版本下，一个新上下文作者完成限定小 App 的事实，不是普遍成功率、完整模型使用评测或所有 SDK 场景的保证。本次没有迁移任务、外部业务副作用、后台任务、所有 Ref 组合或模型成本测量，不报告相应指标。

未调用真实 Driver／LLM 业务服务，未访问用户 Host、配置或数据库；没有重跑 GUI、Planning、四包／双 Producer 历史矩阵或 TS／LSP 调查。SRT-15 的独立清理及采用是另一项已批准工作，不将根目录后来变化混入作者输入，也不由此循环重验作者样本。

四项原则在此的应用是：没有新缺口就不增加实现；业务选择仍归 App，观察与释放仍归现有内核；真实公共调用证明该样本正确；作者能凭公开材料完成任务，但一个样本不足以宣称认知负担已被普遍量化降低。

## 下一步与准出

下一步只需 SRT Owner 接受这一限定结论、更新唯一索引并关闭本轮作者试用；无生产采用或重新构建任务。准出是索引明确当前样本 APPROVED／NO_CHANGE，保留一个样本、固定 SRT-13 输入及零修复的边界，与已采用的 SRT-13／15 状态一致。

> 记录并接受本次 SRT-14 作者试用裁决：一个新上下文作者、一份原稿、零修复、零私有 API，负责人独立严格构建及真实 10 帧／11 调用通过。生产和公共材料为 NO_CHANGE，不采用试验 App、不再跑矩阵或追加人工验收。更新唯一索引，区分已完成的本轮清理与验证、已有外部工具链问题、待产品／架构决定的未来事项和发布条件；不为填充下一批自动启动新协议或框架。

SRT-13 当前协议整理和 SRT-15 有依据的剩余清理均已批准并采用。本轮作者试用不再派修订批次；后续只有具体缺陷、明确产品决定或发布任务出现时，再组织对应的完整工作，不将历史笼统验收标签变成当前停工门槛。
