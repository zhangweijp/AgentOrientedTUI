# Batch 25：隔离 Host 与真实 Planning Ref 手测入口

**READY_FOR_REVIEW。** 已交可启动的隔离代码、指定包原件、真实 Planning/Worker/Source 与实际 M4.3 Driver 的正反例。**GUI 可见性仍为环境阻塞，未计为通过**：Mac 锁屏，两次 native UI 发现均失败，已请求用户解锁。负责人已要求将最终 state 交 SRT Owner；本线已停止验收 Electron 并交接，不再自动启动或写最终配置。此状态是代码与准备材料送审，不表示所有 GUI 准出已满足、正式采用或 Semantic 验收。

## 入口及所有权

持久目录：`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/.tmp/minimal-core-ref-acceptance-20261106/`。

正常手测启动：

```sh
/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/.tmp/minimal-core-ref-acceptance-20261106/launch.sh
```

仅关闭这个验收 Host：同目录 `stop.sh`，按本 launcher 写入的 PID 和完整隔离 Electron 命令核对后发 SIGTERM，拒绝其他进程。没有执行 pkill、killall 或停止用户当前 Host。当前本线验收实例已退出。

最终模型与只启用 Planning 的验收 Agent 配置由 SRT Owner 准备。启动会话及 Source 更新本身可能触发推理，不能以“没点击发送”判断没有请求；本线的自动验证没有真实凭据，并在发出请求前阻断网络。用户正常启动不加载该阻断脚手架，属于用户手测；是否完成最终模型配置以 SRT Owner 的独立说明为准，本报告不读取或归档最终配置。

用户操作沿用已有界面：选择验收 Agent/主题，在现有 `TUI view` 查看 Planning。创建一条计划并关闭详情，让 PlanList 展示完整名字（本批实际为 `Plan:unfinished_plans[0]`）；让 Agent 使用 `open_plan` 的 **plan** 参数复制完整 Ref 打开它。其他工具继续使用各自 Schema 中的业务 ID。应看到一个配对调用/收据和新的 PlanDetail，收据只说“Plan opened.”，正文在 View。坏前缀、猜名字和上传对象应拒绝；删除后的旧 Ref 不应打开已删除计划。

GUI 侧最终独立复核与用户说明由 SRT Owner 负责。自动 launcher `launch-offline-check.sh` 在 `STATE_HANDED_OFF` 存在后拒绝启动；以后若还需要自动 GUI 检查，必须新建无真实凭据的隔离副本，不能复用现有最终 state。

## 精确输入与改动

从 Git `853495dd9954eb4f8a91998bcc59e19326765981` 提取真实 Host、Planning 和配套 Driver，359 件原始文件与压缩/原件身份可核对。没有把共享工作树当作该历史版本，也没有将共享五 Source 迁移和当前 Driver 行为套到旧版本上。配套 Driver 源码未改，原样编译；针对它另做了实际调用证明。

| 包 | SHA-256 | 原包载荷 |
| --- | --- | ---: |
| B22 SDK | `c5c750464c7151e230654fcf4ae5846df4d2a02f47876d558a4a1b48257391ff` | 90 件逐一相同 |
| B23 Runtime | `46c39d592ce11ec950ab10dbf15568b55278d0a5c3702366feb0c443e063a7e6` | 388 件逐一相同 |

SDK/Runtime 包未编辑、未重打、未从源码链接回落共享旧包。Host、Planning、SDK、Runtime 四个消费位置的实际模块解析均在独占目录内，指向这两个安装原件和配套 Driver。第三方依赖通过明确的已安装目标链接复用，记录于 dependency-links.json；没有运行 install、升级依赖或修改锁文件。

实际源码差异只有隔离副本内的 11 个既有文件与 2 个样件：

- `planning-tools.ts` 只把 open_plan 改为必填 `plan: RefValue('Plan', PlanSchema)`，删除该入口不再使用的 planOnlyInput。业务仍按收到 Plan 中的 ID 调用原 shownPlan 与 actions.openPlan；不存在恢复为 ID 参数、手工按 Ref 名查询或绕过业务前置条件的分支。只在此绑定打印验收输入作实际业务证据，PLAN_NOT_FOUND 的恢复提示改为刷新/选择当前完整 Plan Ref。其他工具的参数、实现和错误保持。
- `RootView.tsx` 按负责人/SRT 早审意见，只纠正“一律传 Plan ID”和 open_plan 的提示，明确其他参数继续按 Schema 用 ID；静态目录仍由 ToolCatalog 生成。
- `ref-value.ts`、`ref-plan-schema.ts` 复用 B23 已审样件，后者仅将真实 Planning type 的导入定位到本 App。没有公共 helper、新协议、Core 功能或 SDK 导出。
- 九个 Host 文件只处理必要隔离位置：config 三个全局文件、AppRegistry configPath 与关闭开发自动发现、runtime data、MCP/skills/config/cache、Electron profile 和本地已构建 GUI。移除启动时无关的模型目录预加载；没有改 Host 的模型/工具路由或增加面板。
- Native userData 与 Chromium sessionData 均显式指向独立 profile；普通 launcher 走打包 GUI，不连接共享 localhost:5173。

变更理由与逐路径指纹在 source-adjustments.json、patch-proof.json。补丁 `review-evidence/minimal-core-batch-25/isolation-adjustments.patch` 只适用于**提取的 M4.3 目录**，不能对共享 root 应用。当前 SHA 为 `6a1b2acb88eb7614b7b9ec9d6fd420897ceae414779a7563ee4c4ceff3cb4cba`；检查、正向重放、反向检查、反向恢复均退出 0。348 件未改的原始路径保持；Driver 源码未改。

## 真实执行证据

**Source 最终九调用**使用实际 Host DesktopManager、真实 Planning、Node Worker、SemanticAOTUIDrivenSource 与 Scope，没有假 executor 或业务代填：

1. create_plan 创建原 Plan；close_plan 关闭详情；从实际 PlanList 取得完整 Ref。
2. 错前缀、未知名字、直接对象分别拒绝，三次均无 V4 派发、无业务进入。
3. 完整 Ref 一次派发并成功，Worker 的 rawArgs 保持字符串，effectiveArgs 与绑定打印的原 Plan 逐字段相同；后续观察为 PlanDetail，收据不含描述正文。
4. 再关闭详情并按原 ID 合同删除计划。保留的旧观察仍能解析原 Plan，因此这次是 **1 次派发、1 次应用进入、unknown / PLAN_NOT_FOUND**，由当前业务数据拒绝。刷新后无已删除计划/详情。它不是 Core 在业务前拒绝、不是 failed，也不证明 SRT-05。
5. Context/Source 释放及 Kernel 关闭后 `close.ok/resourcesReleased=true`。

原始第一版六调用、Root 说明修订后的九调用、恢复提示修订后的九调用均保留。最终报告引用恢复提示版本，不把多次执行当成额外覆盖数量。原始终态、全部输入、上下文和传输记录在 worker-source.json；business-input-proof.json 对照完整 Worker 参数与实际绑定日志，不只比较 status。

**实际 M4.3 Driver**另跑一轮：真实 AgentDriverV2 → 真实 LLMClient.call → 真实 ai streamText，只在原 createProvider 方法替换为已有 MockLanguageModelV3；未 mock call/streamText、未修改 Driver 文件。

- 1 次受控 provider 请求，模型原参数为完整 Ref 字符串。
- 捕获本轮 Context 的原 executeTool 后只有 1 次路由调用，只有 1 条 open_plan V4、1 次真实业务进入。
- Worker/绑定收到原观察中的完整 Plan；收据与 call ID 配对，不重复描述；下一次真实 Source 观察是 PlanDetail。
- 1 次对应 release，关闭资源归零，没有外部模型请求。

见 m43-driver.json 与完整 stdout/stderr。本证据针对旧 SRT Driver，不挪用 B23 当前共享 Driver 的成绩。它也不宣称旧 Driver 已具备共享 B03/B09 的所有修复；无关 MCP/IM 不在本次业务入口内。

## 构建、环境失败与保护

commands.json 记录 22 条实际构建/类型/探针命令，均退出 0。包含原样 Driver 编译、Planning 编译、Host 原 tsconfig 的完整语义检查、Host tsc、真实 main/preload/GUI Vite 构建及上述探针。Host 是 strict=true、skipLibCheck=true 的原配置，不能写成 skipLibCheck=false 的全面严格库验收。GUI 保留既有 chunk 大小及动态/静态混合导入警告，没有借此优化或升级依赖。

另有明确的环境失败与修正，不算有效先红：默认 sandbox 下 ps 为 EPERM，Native Electron 首次退出 134；只读进程检查及只启动独占实例的升级执行随后成功。cua 首次超时，随后两次明确报告 Mac locked，未绕过锁屏或换技术操作 UI，未取得可见 Planning 截图。Native Host 核心初始化实际成功，不能据此冒充 GUI View 已核验。

保护核对发现两个中间问题，均保留原记录：

- 最初复制依赖链接也带入 `.vite-temp`，早期 Vite 可能使用共享临时配置缓存；已仅在本线目录拆掉链接、建立私有缓存并重跑构建。未重建或编辑共享依赖载荷。不能声称最早所有临时缓存都已经独立。
- 初次离线脚手架先注册 whenReady/defaultSession，再异步加载 Main。20,177 件原用户文件核对中，原 profile 的 DIPS-wal 与三个 GPU 缓存变化；原配置、聊天和 Planning 数据文件未变。不能把这四项无依据地归给别人，也没有恢复或删除这些活动缓存。脚手架已改成同步先设 userData/sessionData 再碰 defaultSession，Main 也显式设 sessionData；修正后重新构建。交接后用**另一份全新 /private/tmp profile**运行 Native Electron 路径预检，实际 userData/sessionData/defaultSession storagePath 三者一致，原四项缓存在这次预检期间未变。该预检不加载 Host、不访问最终 state，不等同于完整 Host GUI 复验。

GUI 的最终可见性，以及完整 Host 在修正 session 路径后重启的 GUI 复验，仍待解锁与独立复核。它们没有写通过。initial GUI session 原件、四项漂移、时序修正及 profile preflight 分别留证。

本轮记录的 600 余共享源/配置路径没有差异，HEAD/index 不变。SRT Owner 对共享启动/安装/说明的并行工作不在本批 patch 中，不回滚、不认领。实际数据目录分开：聊天在独占 state/electron-profile，配置在独占 state/.agentina 与 state/.aotui，Runtime 在 state/runtime，Planning sqlite 在提取 App 自身 data。最终 state 已于 state-handoff.json 时间交 SRT Owner；该目录及数据库不列为交付归档，后续实际模型配置不由本线读取或重写。

## 剩余边界与移交

源码、独立补丁、原件、构建和真实执行链已交审；GUI 锁屏阻塞与首次 profile 缓存影响明确保留，交负责人/SRT 独立裁决。本线没有创建 commit、push、merge、发布，也没有对共享树采用 B22。

未执行真实模型理解/外部推理、完整 App 回归、全仓测试或最终 Semantic 验收。数组整体、多个/可选 Ref、Ref 数组、重名及 SRT-05 自动观测采纳均不属于本批完成内容。B24 的共享采用风险继续有效，特别是候选旧基线的配置 getter、重复规则/响应捕获和共享 WorkerError 诊断差异，不能用本次手测替代正式整合。

交接后的三个直接 Node 入口另加导入前保护：原执行字节另存，所有 Host/DB/Runtime/Driver 导入均移到检查之后。在全新且没有应用依赖的临时目录中，三项均以自身 B25_STATE_HANDED_OFF 错误拒绝，而非缺依赖失败；未在最终目录执行。对应证据 entry-guard-proof.json。Normal launch/stop 和生产副本已冻结，最终清单不包括负责人目录或私有 state。
