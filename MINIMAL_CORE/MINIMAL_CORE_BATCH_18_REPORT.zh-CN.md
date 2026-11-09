# Minimal Core Batch 18 交付报告

**READY_FOR_REVIEW，仅提交只读取证。** 同一个真实 Driver 在一段连续会话中完成两次实际 `streamText` 模型请求：第一轮同名引用读到 A，原工具重排列表；第二轮同名引用读到 B。在第二次请求实际抵达受控 HTTP 传输函数时，第一轮原 Context 的执行入口已失效，返回 `SEMANTIC_CONTEXT_RELEASED`，业务、执行授权及 Core 调用均为 0。当前 Driver 在上一轮执行结束时释放旧 Context，之后才捕获下一轮；这是一条实测顺序，不把它宣布为新的“采纳”定义。

Scope、Observation、调用记录和 lease 释放，不等于历史快照立即清除。本次短会话在 Source 释放后仍保留一份历史快照；Runtime 关闭后归零。负责人另用公开 Core、受控时钟验证了默认期限的清除行为，详见第 4 节。没有为这些发现修改生产或历史保留策略。

## 1. 基线、构建与执行边界

任务书 SHA-256 为 `d314736571af396e81d75201f89a717b90829ebe0e4b882428bbed3cf2a3c7e5`。开工保存实际工作树 **9,971 个既有路径**、Git 状态、HEAD/index；包含 B17 交付、独立复核及本批已有的两份负责人手动预览材料。原基线没有被 HEAD 替代或因后续证据增加而重写。最终保护核对见 `protection.json`。

运行输入全部从固定历史原件取得：

- SDK/Runtime：B12 的 294 份冻结输入，顺序应用已签收 B14 R1、B15 R1、B16 patch，在私有目录构建。没有读取今天的 SRT 生产源码来决定本次行为。
- 实际创建会话的 Driver：B13 `build-inputs.tar.gz` 内的 **10 份 Driver 源码/配置输入**，逐份校验后私有构建；开工时也与共享主树对应十份内容匹配。
- App：B16 原有 Planning 夹具、B12 原 PlanListView 与类型、原 plans 数据。App 源码**只替换一处列表顺序表达式**：`stage==='updated'?updated:` → `stage==='updated'?[...updated].reverse():`。没有改名字、业务 ID、工具、Scope 或真实 App。派生源码与指纹在 `fixture-inputs.json` 和 `derived-app.tsx`。

Node v24.15.0、pnpm 10.15.1、TypeScript 5.9.3；实际 Driver 使用 AI SDK 6.0.86、OpenAI-compatible 2.0.30。没有安装依赖或改锁文件。`build-origin.json` 记录逐层解析路径、版本、manifest 指纹、源码及 Driver 产物指纹。SRT Runtime 仍按原依赖导入其缓存 Driver 包的 `jsonSchema` helper；**构造 AgentDriverV2 的代码来自本次 B13 重建包，每个场景仅构造一次**，不能把 helper 包导入计为第二个 Driver 实例。

主链是实际 Driver → 实际 LLMClient/`streamText`/provider → 受控 `fetch` HTTP 响应 → 实际 Driver 路由 → 默认 Semantic Source 的本轮 Context → Core → Node Worker/SDK → 业务。没有 mock 掉风险链，也没有改写参数、Schema、授权或解析。控制点沿用 B13：拦截 provider 发往 `.invalid` 地址的实际请求，返回 SSE/HTTP 响应；**没有外部模型、计费调用或 TCP 服务端**。“请求抵达”指实际 SDK 进入受控 fetch 传输边界。

Source/Scope/policy 包装只转发和记录原操作。资源取证使用现有 WorkerHost 报告与 SnapshotStore `inspect/getById`，通过私有对象路径定位，仅供本批诊断，不新增公共 API，不查询或解析最新 AppKernel Map。保存的请求、消息、工具 Schema、参数、观察/绑定、授权、业务完整值和收据未经归一化。证据本身保留 JSON 副本与旧入口，所以本批不据此声称 JavaScript 对象已 GC。

## 2. 同一实例的连续请求与交接顺序

正常场景为**同一 PID、同一个 Driver ID、一次构造、仅初始一次 `trigger()`**。续轮来自重排提交触发的真实 Runtime/Source 更新信号。Assistant、Tool Result、状态回调只记录，不补通知、补 trigger 或手工续轮；没有第二个 Driver 或两段孤立 Source 代替连续会话。

原始正常轨迹的单调事件序号如下。业务 JSONL 来自 Worker 内原 handler；它的执行处于对应工具入口开始与完成之间，本批没有给旧 Worker 日志补造跨线程时间戳。

| 事件 | seq | 事实 |
| --- | ---: | --- |
| 第一次实际模型请求抵达 | 8 | 页面显示 A；实际模型动作是读取 `Plan:unfinished_plans[0]`，随后调用现有重排工具 |
| 读取 A 完成 | 17 | 一次 Worker 读取，完整值与授权 effectiveInput、Ref 来源、收据一致 |
| Source 发布信号 | 21 | 处于工具执行阶段，投影 revision 2；这是续轮来源 |
| 重排完成 | 24 | Core `entered-returned / succeeded`，控制命令只返回一次 |
| Driver 发出 idle 状态回调 | 26 | 此时还未进入 Context release；不能把 idle 通知当资源已释放 |
| 第一轮释放开始／完成 | 27 / 30 | 原 observation 释放，最后 owner 关闭 Scope；之后才能捕获新 Context |
| 第二轮捕获开始／完成 | 32 / 36 | 同一个 App 与 PlanList View instance，新的 Snapshot/Observation/Binding |
| 第二次实际模型请求抵达 | 37 | 真实请求页面已经重排，第一项显示 B |
| 用第一轮原入口尝试同名读取 | 38 / 39 | 调用的是原 Source Context #1 的闭包，也就是第一轮 Driver 转发的那个实际执行入口；没有改取新 Context。结果 `SEMANTIC_CONTEXT_RELEASED`，业务/授权/Core 调用均为 0 |
| 第二次模型响应后，新入口读取 B | 48 完成 | 模型再次提交逐字相同的 `{"value":"Plan:unfinished_plans[0]"}`；经第二轮绑定读取完整 B，一次业务进入 |
| 第二轮释放开始／完成 | 51 / 54 | 本轮 Context 同样释放一次 |

两次 HTTP 请求的读取参数字符串逐字相同，业务 ID 则分别为 `plan_a`、`plan_b`。第二轮是**新 Context 重新提交同一拼写**，不是旧入口被悄悄重解释成新对象。实际 `ViewInstanceId` 保持，`SnapshotId` 改变；每次成功都核对完整业务对象、递归冻结、授权输入、RefSource 与观察绑定，而非只比 status 或 ID。

顺序通过实际请求进入、实际 release 完成的信号划分。100 ms（配置防抖 10 ms）的末尾安静窗口只用于检查在途工作结清后没有额外请求、重排或读取；未用它决定何时调用旧入口。正常场景最终仍为两次请求、两份 Context，均只 release 一次。

## 3. 正常、失败与手动预览的分层计数

三个场景分别启动私有 Runtime/Worker。表中每一行的连续模型请求都来自该场景**同一个 Driver 实例**，不同场景的实例没有拼成一段会话。保留每条记录的 PID/Driver ID 供核对。

| 实测场景 | 模型传输请求 | Context／release | 原读取 handler 进入 | 控制命令返回 | Core invoke／执行授权／结果读取授权 | Driver 错误回调 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 正常两轮 | 2 | 2 / 2 | 2（A、B） | 1 | 3 / 3 / 3 | 0 |
| 首次请求返回动作前 HTTP 400 | 1 | 1 / 1 | 0 | 0 | 0 / 0 / 0 | 1 |
| 第一轮完成重排，第二次请求返回动作前 HTTP 400 | 2 | 2 / 2 | 1（A） | 1 | 2 / 2 / 2 | 1 |

这些是 **5 次模型传输请求、5 次 Context 捕获/释放、3 次原读取 handler、2 次控制命令返回**，不是把一个“业务次数”混用到所有层。原夹具没有控制工具的 JSONL 计数器；控制执行次数以真实 Driver 路由和 Core `entered-returned` 收据为证据，未伪造 handler 日志。旧入口额外探针单列，不计模型动作或 Driver 业务执行，两个第二轮场景均零授权、零 Core、零业务。

两个失败场景固定返回**动作前、不可重试的 HTTP 400**，Driver 实际收到 `AI_NoOutputGeneratedError: No output generated. Check the stream for errors.`。错误不是工具失败或 unknown 收据；没有动作进入时便没有工具收据。失败后 release 均执行，第二场景没有重复读取 A 或再次重排。完整预期错误及 stderr 原样保存，命令退出 0 表示这些错误断言成立；不把它概括成“没有发生模型错误”。未覆盖 429/500、流中断或所有 SDK 重试策略。

本批还使用原负责人脚本，在本次新构建上重跑手动对照：旧 Context 看见 A，提交重排后手工保留它，再预览新 Context；旧入口仍读 A、新入口读 B；显式释放旧 Context 后，它被拒绝，新入口仍读 B。原始 `manual-preview.json` 为 4 次读取、1 次控制返回、1 次旧入口拒绝，**与上表分开**。这说明“手工获得一个新 Context”本身不撤销另一个仍持有的 Context；不能把手动预览等同于 Driver 的逐轮释放。

## 4. 调用资格、观察、历史与 App 数据

本次三场景在 Driver 实际释放完毕、**全局关闭之前**均核对：Scope、closing Scope、Observation、reservation、调用 Entry、在途调用/读取及交互逻辑字节为 0，SnapshotStore activeLeases 为 0。Source.dispose 后仍是这些数值，没有靠 Runtime 关闭掩盖本轮释放。

正常与第二轮模型失败场景，此时 Store 仍 active，currentSnapshots=1、historicalSnapshots=1、historicalBytes=**14,352**。在第二次请求到达时，旧 snapshot ID 的诊断查询仍能取得完整原 A，但旧 Context 调用已被拒绝；新 Context 持有自己的 lease。本次短会话最后关闭 Runtime 后，Store disposed、当前/历史快照及字节/lease 均为 0，Worker pool total、pendingTasks 也为 0，关闭报告确认受管资源释放。

这证明**短会话内历史源未随 Context release 立即消失**；不证明它只能靠 Runtime 关闭清除，也不证明旧 Agent 仍有执行资格。A 也继续作为列表第二项和其他当前数据存在，不能要求删除 App 仍需要的业务数据。没有用 heap/RSS 或测试自己的 JSON 副本推断专属对象是否 GC。

负责人在开工后补充了公开 Core 的独立受控时钟对照，原件为 `owner-review/history-window.{json,mjs}`：用其新建连续会话的两份真实 Worker 快照复放，完整值核对 A/B；无 owner lease 时，退休后 **599,999 ms** 仍可查 A，到默认 **600,000 ms** 的下一次查询为 `SNAPSHOT_EXPIRED`，Core 保持 active、当前 B 可读。持有 owner lease 跨过期限，释放最后 owner 后的下一次查询才清除旧历史。它验证的是查询/清理入口触发的现行保留规则，**不是后台定时回收，也不是实际等待十分钟的 Driver 会话或调用授权验证**。这是负责人执行证据，固定指纹引用并列为外部新增，没有计入本次开发者 15 条命令或表中次数；其中字节量也不与本次 14,352 混写。

已确认目标是采用新观察后旧资格失效、旧观察专属持有释放，继续使用的共享数据和 App 业务状态不删除。本次能够证明第二轮请求抵达时旧资格已失效；不能把“请求抵达”改写成正式已读/采纳 ACK。需要上级决定的交接点是：是否维持现有的**上一轮终结先 release，再捕获下一轮**；以及旧观察专属持有与现行 Snapshot 历史合同如何划界。本次模型失败不会恢复旧资格，现有历史期限也未删除。历史合同影响盘点由负责人另定，本批不提出或实施新状态管理器、协议、资源策略或 API。

## 5. 验证、交付与限制

在根目录运行：

```sh
python3 review-evidence/minimal-core-batch-18/reproduce.py
```

首轮完整执行 **15 条命令均退出 0**：六条签收 patch 检查/应用，Driver/Runtime/SDK 三个私有构建，`strict: true / skipLibCheck: false` 夹具编译，手动预览，三个真实连续 Driver/失败场景及完整记录验证。没有新增或弱化永久测试，没有 skip。`runs/01` 保存这一首次完整运行的脚本、日志、全部原始请求/收据/值和逐项验证，未回写。重跑只从固定原件取输入、使用已记录的本机离线依赖，输出至新的私有临时目录；不依赖今天 App/Driver/SRT 源码相等，不自动纳入后续负责人文件。

准备阶段的一次引用列表组装误读了不存在的 B12 PlanDetailView 原件，退出 1。B16 夹具实际只使用原 PlanListView 与类型；保留开工清单后改为记录实际存在的两份输入，未恢复不存在文件。原因在 `baseline.json`，原工具错误摘录在 `logs/baseline-setup-failure.txt`，不作为合同先红。三场景预期模型错误的首次原件均在命令及各自 JSON 内；没有待修复的执行失败。

没有运行真实 LLM、真实 Host/IM 会话、所有模型错误类型、正式新观察采纳策略、Snapshot 历史迁移、跨页命名或公共包/API 迁移。回调只记录，第二轮没有会话历史 Source 回灌 assistant/tool 消息；本次证明的是同一真实 Driver 与默认 Runtime Source 的连续调用，不扩大为完整 Host 的历史恢复或配对验收。没有源码修改，因此本批未重跑无关全仓回归或把历史测试通过数计入本次。

生产补丁 [MINIMAL_CORE_BATCH_18.patch](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/MINIMAL_CORE_BATCH_18.patch) 为 0 字节，SHA-256：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。报告、证据索引、保护记录与 `final-delivery.json` 一并提交独立复核；不自行宣布 APPROVED、Semantic 验收或 Legacy 退出，不创建提交、push、merge 或发布。
