# Minimal Core Batch 21 交付报告

状态：**READY_FOR_REVIEW**。本批完成普通作者入口的当前失败验收、已有合法路径和真实协议接收端对照，以及可编译的最小协议提案；目标新功能仍未实现，等待负责人独立复核与协议裁决。

生产 patch：**0 字节**，SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。没有修改共享产品、其他工作树或已封存材料，没有提交、发布、全局安装或新模型试验。

## A. 基线与输入

任务书 SHA 为 `096307591453e02d92fd9b57d224a9b9206d6951a2cbadce8106f17458a470f7`；B20 负责人复核 SHA 为 `37e959f53ae2d92e1a1d7328fd8c3c3fbf8125c8bfd7742d8869248f5123803f`。本批重新记录实际工作树的 11,146 个文件或 symlink、Git status/index/HEAD、13 项固定引用。不用 HEAD 代替当前基线。

B20 的清单 `78f088fb7a9a39658215e8462d01a2381da8b4962f1842a5357f914e218ba665` 原样引用，未重新复制那批 tar、源码 archive 或 429 份包声明。直接使用其中签收的组合 SDK tar `881cd00af0b01d546ff6e27d17366043e5a3570274cda98c0f26ba0e00d48995` 与 Runtime tar `f10708895d3c7157fffd534bc6881936787ae2f74e9c7928daba916e27b39d78`。

在每个新临时目录执行离线 pnpm install，SDK/Runtime 的 90/388 个包内文件分别与对应 tar 逐字节核对，实际落点位于该消费目录的 `.pnpm` tar 安装副本。没有指回共享生产、B20 私有源码或旧 dist。本批没有重新构建产品包；实际安装的包是本批测试对象。

环境沿用 Node v24.15.0、pnpm 10.15.1、TypeScript 5.9.3，及 B20 指定的既有本地依赖。store/cache/state/锁文件与 App 数据都在新 `/private/tmp/aotui-b21-*` 中。依赖位置、包指纹和安装文件清单保存在新证据，不升级或写共享依赖。

## B. 普通作者验收：有效红灯

`samples/ordinary-app.tsx` 使用公开 `createTUIApp`、`AppTools`、`defineToolSet`、`defineViewTypeTool`、View 与 Ref 发布。`RefValue` 复用 B14 的本地 TypeBox 样例；未新增公共 helper。只有一个必填输入 `plan`，只读一份完整 Plan，成功收据为 `{id:'plan_a'}`。页面只发布一项 Plan，业务函数只使用实际参数，不从闭包、全局 Map 或当前 App 状态补取 Plan。

普通 App 中没有 `useViewSnapshotTool`，没有额外 Registry、实例绑定、协议调用或 executor fallback。一个公开 Preact error boundary 只记录并重抛同一个错误，便于保留 Worker 中的原始 SDK 诊断；没有恢复或改写业务路径。

实际结果依次为：

1. 安装包上的严格语义编译退出 0：`strict: true`、`skipLibCheck: false`、NodeNext/ES2022，没有 paths 映射、ignore 或 skip。
2. 真实 Worker 进入 AppTools commit，公开 boundary 捕获 `TOOL_BINDING_COMMIT_FAILED`；其 `diagnostics.original` 保留 `ViewToolContractError / PARAMETER_DECLARATION_UNSUPPORTED`。完整堆栈指向安装包的 controller/AppTools 调用。公开摘要不保留内层 path；B20 内层 Registry 的参数路径证据仍按签收指纹引用，没有伪称本批公开边界新观测到了它。
3. Worker 的首个失败生命周期响应是 `PERSISTENCE_CLOSE_FAILED`；Host install 对调用者表现为 `INSTALL_FAILED`。完整请求/响应保留，未将外层码当作业务或真实存储操作失败的根因。
4. 默认 Source 实际返回 desktop 和 `system-open_app`，没有 Plan View 或 read_plan Tool。因此本轮没有发出业务 Tool IPC，业务 0 次，也没有手工重开/续跑。
5. 独立的成功测试仍断言“普通声明必须业务成功、恰好进入一次、收到完整 Plan、收据正确”。它在当前包上退出 **1**，失败消息为 `An ordinary author declaration requiring one observed Plan must reach business and succeed`。这条断言未被反转，未来实现应让同一断言转绿。

编排脚本只将这次明确的产品缺口记为 expected red；并同时核对生产绑定错误和业务 0，依赖、导入、编译、mock 或工具名配置错误不能顶替它。

## C. 正向对照与接收端事实

`control-app.tsx` 独立使用当前合法单引用 Hook 作对照，并提供一个普通数字工具。它们经默认 Source、真实 Core/Host/Node Worker 执行：

- 从页面的实际 `Available references` 选择 `Plan:plans[0]`，旧单引用业务进入 1 次，收到与封存 Plan A 相同的完整嵌套字段，Source 收据为 `{id:'plan_a'}`。
- 普通数字工具经同一 App 的普通声明和绑定进入 1 次，接收 2、返回 3。
- 所有后续协议故障总计没有增加这两种业务的进入次数；最终业务日志仍只有这两条。

`worker-tap.mjs` 是唯一 wire 记录点，使用安装包中原样的 Worker runtime，记录原始双向消息，不替换处理器、不修改消息、不补 handler。请求监听在真实处理器之后安装；日志行顺序是观察者回调顺序，不冒充 admission 时序。requestId、App instance、Snapshot、工具和 provenance 用于关联 I/O。

| 真实接收端对照 | 结果 | 新增业务 |
| --- | --- | --- |
| ordinary 带 instance execution；ordinary 混入 raw/effective/refSources | `not-entered / E_INVALID_ARGS` | 0 |
| Ref 带 view-type execution；Ref 混入 ordinary args | `not-entered / TOOL_INVALID_ARGS` | 0 |
| descriptor 与 execution 同时改为旧 activation | `not-entered / TOOL_UNAVAILABLE` | 0 |
| Ref 来源的 View instance 或 Snapshot 与原请求不一致 | `not-entered / TOOL_INVALID_ARGS` | 0 |
| 未知 argumentMode | 以旧 snapshot-value-v2 模式返回 `TOOL_INVALID_ARGS` | 0 |
| 缺少 ordinary / Ref capability 的真实新 Worker | 分别 `TOOL_EXECUTION_UNAVAILABLE` / `REF_EXECUTION_UNAVAILABLE` | 各 0 |
| 后续 V3 屏障请求中的非法数字 | `not-entered / E_INVALID_ARGS` | 0 |

上表共 **11 条**实际 V3 失败终态。普通与 Ref 的合法原始请求、完整 Plan 实收，以及每条坏请求、响应和业务增量均保存在 `control.json`。

另有两个兼容探针：

- 新 capability `view-tool-parameters-invoke/v4` 在当前 Worker INIT 上得到 `WORKER_CAPABILITY_UNSUPPORTED`，业务 0。缺少全部 capability 的 App 虽有 View，默认 Source 不暴露它的工具。
- 跳过协商投递未知 `VIEW_TOOL_INVOKE_V4` 类型，当前 Worker 没有响应。已用其后一个有响应的 V3 请求作为屏障，并在关闭前再次核对，期间业务 0。它只是未知 type dispatch 探针，body 仍来自旧普通请求，不宣称是一个合法、已协商的新协议调用。这支持提案中的“握手失败立即结束”，不能用超时或旧模式重试绕开。

正常成功来自 Source 的公开执行入口；坏请求刻意从受控 Worker transport 直接送入现有接收端，以定位 Worker 自己的检查。不能把后者当作已经证明全部 Host policy、授权或新普通 Ref 链路可用。Host/Core 从真实获准 Observation 解析的责任不会被 wire 中自带的 Plan 或字符串证明替代。

所有已取得的 Context 最终 release、Source dispose 和 Runtime shutdown 均完成，retainedScopes、retainedBytes、Worker pool total 与 pendingTasks 为 0。没有自动业务重试。

## D. 待裁决的最小协议提案

完整提案位于 `review-evidence/minimal-core-batch-21/proposal/PROTOCOL_PROPOSAL.zh-CN.md`，可编译字段合同在 `protocol.ts`，源码归属指纹在 `source-references.json`。

建议上级一次决定这个小范围：

1. 工具 execution 保持 view-type activation；raw 名字、resolved Plan 和七字段 Ref provenance 分开表达，Ref owner 不变成工具 target。
2. 复用 Observation grant、同一 Snapshot lease、Core 的参数准备/异步重查/authorize、Worker 的当前注册与 activation 检查。授权看到的冻结 effectiveInput 原样用于 dispatch；跨线程承诺 JSON 内容一致，不承诺同一个 JS 对象。
3. 用明确的 authoring/profile/capability/wire revision 区分新旧语义。样例候选为 `view-type-tools-v2`、`view-type-parameters-v1`、`view-tool-parameters-invoke/v4`、V4 request/response；本案 Ref 索引和命名不变，Snapshot schemaVersion 保持 3。新旧端必须明确拒绝，不能按字段猜测降级。这些字面值未成为正式 API。
4. 下一次只在获准的隔离实现中接通单个必填 Plan，并让本批同一作者成功断言转绿；公共 helper、列表/多选、命名、历史期限和发布另行裁决。

源码核对不止发现 Registry gate：Snapshot V3 validator 当前也拒绝普通 Ref；ordinary binding 的 visibleRefIds 当前为空；Core Ref 准备只处理 instance 模式；Host/Worker ordinary envelope 没有 provenance；SDK safe invoker 不能对 resolved Plan 再做名字校验。提案逐层列出实际文件和可复用方法，不能只放开注册就宣称接通。25 份签收源的指纹引用中，23 份列为后续候选责任、2 份明确复用不改；不是本批生产白名单或已经批准的实现差异。

提案类型样例严格编译成功，另外七个真实编译负例都得到预期 TS2322/TS2739/TS2741，涵盖身份错配、raw payload、effective 名字、旧 request、旧 ack 与旧 Tool profile。没有用缺依赖或编译配置错误充当类型拒绝。声明原件已保存；类型可表达不等于协议能执行。新 SDK/Host/Worker 尚不存在，新旧组合表逐项标注待实现，不借用 B20 的四组当前协议包组合充数。

## E. 命令、原件与中间失败

最终一键命令：

```sh
python3 review-evidence/minimal-core-batch-21/reproduce.py
```

最终目录 `/private/tmp/aotui-b21-os_734yd`，必要原件复制到 `runs/01/evidence/`。主脚本 **6 条**命令记录：离线安装、作者语义编译、目标成功测试的预期红灯、合法路径与真实接收端验证、协议类型门禁、完整输出核对。协议类型脚本另有 **8 条**命令（1 个正例、7 个类型负例）。每条 argv、cwd、退出码、stdout、stderr 原样保存；这些记录不是全仓测试项数。

物理保存了 6 份作者/fixture 完整声明和 3 份正例协议及其依赖声明。两个安装包的声明、tar 和历史完整核验通过 B20 指纹引用，不声称再次产生那些原件。

`attempts/01/` 保留首轮有效普通作者红灯，以及正向对照测试误把 Core 的 null-prototype 结果字典与普通对象做 deepStrictEqual 的失败。产品值实际是正确的 `{id:'plan_a'}` / `{incremented:3}`。本批只改测试预期为显式 null-prototype 字典，并保存原始断言、原始输出与诊断；没有 JSON 归一化或弱化字段断言，也没有把这项试件错误作为业务红灯。之后两轮过程结果分别保存在 `attempts/02/`、`attempts/03/`，最终从全新消费目录完成整次一键运行。

本批没有执行仓库全量 Vitest、重新构建/发布 SDK/Runtime、其他 App 迁移或新模型作者试验。SRT 6/9 与门槛 8/9 仍是历史结果，不是本批进展。没有宣称最终 Semantic 验收或 Legacy 退出。

## F. 交付与剩余边界

共享变更仅为本报告、空生产 patch 和 Batch 21 证据。原有生产修改不属于本批。实际工作树及历史引用的最终保护、whitespace 与清单核验见 `delivery-audit.json`、`final-delivery.json`；B20 原清单与所有既有材料保持原样。空 patch 通过零字节和实际内容保护验证，不伪称 `git apply` 处理了一个空 diff。

当前普通 Plan App 仍然红灯，这是本批准出要保留的产品缺口。接通它涉及已明确的身份、来源、授权和最终参数验证责任；协议具体版本与隔离实施范围等待负责人/上级裁决，本批不自行代签。
