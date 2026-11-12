# Semantic Host 接入契约

默认 Host 通过通用 `SemanticAOTUIDrivenSource` 接入 Semantic Core。应用统一经 AppRegistry 安装，Agent 使用 Observation 中的 View 和 Tool Binding 发起 Invocation，并接收完成状态、必要提示与恢复信息；完整 Receipt 保留在 Core 内部。

本文记录当前支持的 Semantic 接入合同。项目所有者已验收 Semantic 路径，Legacy 下线按已授权的清理任务推进；旧验收记录仍保留其当时的状态和日期。当前消费文档只描述 Semantic 入口。

## 1. 应用、Runtime 和 Host 分别承担明确职责

| 层 | 职责 | 边界 |
| --- | --- | --- |
| App / SDK | 声明 View、Ref 和 View 所属的 Tool；处理业务状态与副作用；把最新业务数据和后台进度投影到 View | 应用决定业务授权、事务、任务完成和业务幂等；无需编写专属 DrivenSource，也无需了解模型供应商 |
| Runtime / Semantic Core | 管理 App、Worker、View 实例；发布 Semantic Snapshot；校验 App 实例、Observation、Binding 和执行时有效性；分发调用并记录 Receipt | 提供有界内存与生命周期管理；不承诺外部业务事务、跨进程恢复或持久任务调度 |
| Host / Agent Driver | 安装应用、配置可信策略和能力协商；通过通用 Source 聚合多个 App；组织 Messages / Tools，调用模型并释放本轮 Context | 模型只能使用本轮暴露的工具；Host 不硬编码 IDE 的 View 类型或业务工具名单 |

普通 Tool 属于 App + ViewType，不属于某一个 View 实例。同类型的多个 View 共用一份 Tool 声明、注册和 Handler；App 用有业务意义的普通参数或显式 Ref 选择对象，并自行验证该对象当前是否可操作。至少一个匹配 View 存在时，对应类型的 Tool 才激活；最后一个匹配 View 关闭后，该类型的能力退出观察。旧 Observation 的 Binding 不能继续执行。工具在投影时还必须符合 Worker 实际协商的能力与 Host 策略。展示时可用不替代执行前校验：状态在模型思考期间变化时，Runtime 仍会拒绝失效调用。

`refParam` 是同一 ViewType Tool 的显式参数取值方式，不再注册实例 Tool。SDK 允许每个 Tool 声明多个显式顶层 Ref 参数，并通过 required 区分必填与可选，可与普通参数并用。缺席可选字段不产生 payload 或来源；有值但无效的字段拒绝整次调用。Runtime 从调用绑定的原 Observation 解析完整 Ref 名、校验真实业务类型和 payload Schema，授权与执行使用同一份冻结 effectiveInput。View/Ref 的实例身份仍保留；数据只读不要求 Tool 必须只读。App 用 payload 内部 ID 检查当前业务对象，不让模型另抄该 ID；文件路径、标题和编辑内容等有意义的普通字段保留。

相关实现：[通用 Source](../../agent-driver-adapter/src/semantic-aotui-driven-source.ts)、[能力过滤](../src/adapters/semantic-capability-policy.ts)、[Worker 接入](../src/engine/app/worker-host.ts)。

## 2. 一次 Context 固定本轮消息、工具和调用目标

标准流程如下：

1. Host 从 Desktop 读取安装的应用，按 App ID 和当前执行 instance ID 取得交互入口。尚未打开的应用通过通用应用控制工具打开。
2. Source 对每个 App 调用 `observe({ all: true })`，从该 App 当前 Semantic Snapshot 选择 View。准备完成但没有 View 的 App 可以返回空 Observation。
3. Source 把观察到的 View 编排为单层 XML + Markdown User Messages，并从同一 Observation 构造模型可见工具。instruction View 放入 static 区，业务状态放入 dynamic 区；两者都是应用数据，不提升为新的用户指令。
4. Driver 完成请求编排、能力过滤及整轮输入预算校验后，调用 Context 的 `adopt()`。Source 同步调用各 App 的 `adoptObservation(id)`，成功后旧 Observation／Binding 退出。仅准备或诊断预览不采用，也不能调用其工具。
5. 模型选择工具后，Source 使用本轮保存的 AppInteraction、Observation ID 和 Binding ID 调用 `invoke()`。模型不负责构造内部身份。
6. Driver 等待模型调用和本批 Tool 调用结束，在 `finally` 中释放 Context。后续轮次重新读取最新 View。

同一 Context 的 `messages`、`tools`、`executeTool` 是一组。不能分别获取新旧版本后混用，也不能在执行旧调用时悄悄换成最新 Binding。旧 Context 释放后继续调用会被拒绝。

当前隔离候选的公开接入方式：Host 安装同批实际 tar 中的 `@aotui/agent-driver-adapter@0.4.0-srt.1`、`@aotui/runtime@7.0.0-srt.1` 与 `@aotui/agent-driver-v2@0.3.0`。适配包将 Runtime／Driver 声明为必需 peer；Runtime 和 SDK 不依赖具体 Driver。这些候选版本尚未发布。SRT-06 已通过实际 Host 集成和严格公开类型检查；外部 Host 必须沿用已验收的精确 AI SDK 版本及 pnpm 声明补丁，见[适配包说明](../../agent-driver-adapter/README.md)。

```ts
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';

// desktop 和 kernel 已由 Host 创建。
const source = new SemanticAOTUIDrivenSource(desktop, kernel, {
    includeInstruction: true,
});

// 将 source 加入 AgentDriverV2 配置的 sources 数组。
// 标准 Driver 准备 Context、在实际 run 内 adopt，并在 finally release。
```

自定义 Driver 在实际消费前也必须调用 `context.adopt()`，并成对调用 `getContext()` / `release()`，并在模型生成及该轮工具执行全部结束后释放。Context 释放其观察，实例继续持有需要结算的执行与有限收据。自定义 Host 需要诊断预览时使用 `preview()`。

### 模型可见呈现与内部身份分离

Producer 输出不带框架 `<view>` 外壳的正文。Source 按已知的 View 元数据在 User Message 边界只包装一次；正文中恰好出现字面 `<view>` 字符串时也按正文保留，不猜测或拆除它。外壳使用 `id`、`type`、`kind`、`name`、`app_id`、`app_name`。`viewInstanceId`、Observation/Binding ID 和 App revision 留在执行通道，不注入正文。未变化内容保持其展示时间戳；缓存仅保存当前投影的内容摘要和时间，不保留历史 View 或执行权限。

### DOM Producer 的 View 边界

每个 DOM View 根节点都必须是独立的 `[data-view-id]` 元素；一个 View 根节点不能成为另一个 View 根节点的祖先或后代。若 DOM 中出现此类关系，Worker 会在提取任何片段或更新摘要缓存前拒绝整份投影，并发送 `SNAPSHOT_PREPARE_FAILED`：现有健康码保持 `SNAPSHOT_INVALID`，消息以 `NESTED_VIEW_UNSUPPORTED` 标明父、子 View ID，并提示 `Declare independent Views.`。不会部分发布父 View、子 View或旁边的 View。有效普通 DOM 容器仍可在 View 内任意嵌套。

把原本想表达的父/子页面分别声明为并列的独立 View，并在各自内容中清楚说明关联；不要把一个 SDK `View` 放进另一个 `View`，也不能通过手写 `data-view-id` 绕过 SDK 检查。嵌套内容修正后，下一份有效 Snapshot 会让 Semantic 健康恢复为 ready；auto、never、manual 的唤醒策略仍按原合同工作。

普通工具别名严格为 `appName-ViewType-toolName`，例如 `system_ide-FileDetail-edit_file`。三个组成段各自只接受 ASCII 字母、数字和下划线；连字符 `-` 只用于分隔三段，不能出现在段内。组合后总长不得超过 64 个字符。不同 ViewType 的同名操作属于不同 Tool；同一 ViewType 的多个 View 实例共用一个逻辑 Tool。SDK 经 AppKernel 注册时校验，Source 发布前复核。非法名称报 `AOTUI_TOOL_NAME_INVALID`，组合后冲突报 `AOTUI_TOOL_NAME_COLLISION`，由开发者修正声明。不截断、不清洗字符、不追加摘要或 App ID。此格式只约束原生 Tool 别名，纯 Core 身份不受限制。

普通 ViewType Tool 使用应用声明的原始 Schema 和显式业务参数。Runtime 不读取 `target` 元数据、不依据 View 实例选择 Binding，也不猜测或解析 `filePath`；App Handler 负责业务对象选择及其有效性。多个同类型 View 共用 Tool，不会为每个实例生成新的别名或 Schema。对象关闭、过期或不具备业务授权时，由应用 Handler 按业务合同拒绝操作。

Desktop 保留应用用途、状态、App ID 和最近 5 条系统日志。日志不提供时显示无近期活动；存在被 Source 禁用的应用时，不投影可能包含该应用信息的 Desktop 全局日志。系统控制工具使用 `system-open_app`、`system-close_app`、`system-collapse_app`、`system-show_app`，仅在当前状态可用时出现。close、collapse、show 绑定到生成该 Context 时的 App 执行实例；Runtime 在生命周期入口同步核对实例身份，实例变化或身份不可用时返回 `APP_INSTANCE_CHANGED`，不会操作同 App ID 的后继实例。当前实例身份缺失时不发布这些活动实例控制工具。open_app 面向已安装的逻辑应用，用于启动 pending/closed 应用，不绑定某个已运行实例。

说明覆盖优先级为非空 `instruction` → `instructionPath` → 环境变量 `AOTUI_SYSTEM_INSTRUCTION_PATH` → Runtime 内置的 `DEFAULT_AOTUI_SYSTEM_INSTRUCTION`。指定文件不可读时记录诊断并使用内置说明；`includeInstruction: false` 不注入全局说明。应用自己的 instruction View 仍由应用声明。

## 3. 所有权决定观察生命周期，容量限制仍然有效

每个 App 实例保有当前采用观察及至多一个候选。观察持有原始 Snapshot，直到释放、被替换或实例关闭。新发布可以产生新的候选；原观察中仍挂载的 Ref 继续按冻结值读取。同名 View 重新挂载后，旧显式 Ref 拒绝新调用并返回参数路径。

标准 Source 请求完整 View。Runtime 的单 View 内容限额为 512 KiB，完整观察留出 View、Tool schema 与额外元数据空间。App 聚合内容仍可超额。Host 对最终模型消息、线路工具和输出预留进行整轮额度检查，通过后才采用候选观察。模型缺少可信额度时，Host 可用 `modelInputLimits` 配置提供 `contextWindow` 和 `maxOutputTokens`。

相关实现：[Observation 生命周期](../src/core/invocation/observation-registry.ts)、[Snapshot Store](../src/core/snapshot/store.ts)。

## 4. Receipt 描述调用事实，不承诺持久查询或跨轮 exactly-once

| Outcome | 含义 | 接入方应如何理解 |
| --- | --- | --- |
| `succeeded` | 工具定义的操作已成功 | 具体业务数据读 View；“启动命令成功”不等于该命令已经运行完毕 |
| `rejected` | 调用被拒绝 | 结合 `executionPhase` 与错误码判断拒绝发生在哪一层；不计为成功 |
| `failed` | 已进入的操作报告失败，并声明副作用为 `none` 或 `partial` | 保留副作用信息；不能统一当作未执行 |
| `unknown` | 无法确认最终结果或副作用 | 保持未知，不自动重放；View 没有显示结果也不能单独证明操作未执行 |

`executionPhase` 和 `outcome` 分别回答“进入了哪个阶段”和“已知什么结果”。Core 内部保留完整 Receipt。Source 将成功 `ToolResult.data` 作为 Driver 工具结果，并将业务错误映射为可行动的错误；内部 `outcomeStatus` 供 Driver 区分终态，模型结果不包含 Receipt 或 `outcomeStatus` 包装，不能仅以有没有普通 result 字段判断成功。

实例内相同 Invocation ID、Observation、Binding 和请求指纹匹配原记录。不同指纹报告 `INVOCATION_ID_CONFLICT`。原观察已退出时，新调用会拒绝，可信 Host 仍可用 `readReceipt(originalRequest)` 读取原调用。首次返回及每次读取均通过 `AppInteractionPolicy.canReadReceipt`。

每个实例最多一个真实执行。调用方等待截止后，原 handler 仍由实例跟踪，直到有效 terminal 或真实 Worker 退出。终态后的可读结果默认保留 60 秒，当前观察的防重指纹在采用期间继续保留。退出观察的结果按 TTL 释放，实例关闭撤销读取。标准 Source 将收据转换为 Driver 操作结果，模型从 View 获取业务数据。长期审计或业务任务进度分别由 Host 与 App 持有。

相关实现见 [实例调用与防重](../src/core/invocation/app-interaction.ts) 和 [公共交互](runtime-app-interaction.md)。

## 5. 验收需要同时检查调用链与可见行为

以下命令从仓库根目录执行，要求项目依赖已准备好。它们是建议的定向回归命令；本轮实际执行结果由集成验收记录补充。

```bash
pnpm -C runtime exec vitest run \
  src/core/invocation/observation-registry.test.ts \
  src/core/invocation/scoped-interaction.test.ts \
  src/core/snapshot/snapshot.test.ts \
  src/core/snapshot/retention-lifecycle.test.ts \
  src/adapters/semantic-capability-policy.test.ts \
  src/engine/app/registry.test.ts

pnpm -C agent-driver-adapter test:run
pnpm test:adapter-integration

pnpm -C agent-driver-v2 exec vitest run \
  tests/core/semantic-context.test.ts \
  tests/core/agent-driver-v2.test.ts \
  tests/core/state-machine.test.ts

./run.sh
```

真实模型验收应覆盖这些可观察结果：

- 普通 `./run.sh` 启动后，IDE、Terminal、Browser 通过同一 AppRegistry / Semantic Source 接入，无需 Semantic 开发环境变量。
- 打开文件后出现 FileDetail View 和相应工具；编辑后下一轮看到最新 View；默认调用链没有 Legacy `acquireSnapshot()` / `execute()` 回退。
- 模型思考超过 30 秒仍可调用未变更的 Binding；关闭最后一个匹配 View、禁用工具或替换 App 实例后，旧 activation 调用被拒绝；单个业务对象关闭但同类型仍活跃时，App guard 校验该对象。
- 失败、拒绝和未知结果没有被统计成成功；后台任务启动成功不等于任务完成；未知写入不被自动重试；不暴露当前能力无法执行的工具。
- Context 正常结束、异常结束和会话停止均释放观察；多轮采用和结果过期会回收不再使用的记录；后台命令的进度继续由应用 View 展示。

Semantic 的正式接入和清理以代码、当前 API 类型及定向验证共同确认；任何旧代码尚未删除的事实都不等于默认流程仍受支持。默认路径不通过回退掩盖 Semantic 接入缺口。

本轮实际构建、定向回归与真实模型结果见 [2026-10-28 验证记录](./semantic-host-validation-2026-10-28.zh-CN.md)。这些自动化结果不替代项目所有者的最终验收。

## 参数 Schema 与公共别名

SDK 将 TypeBox 声明编译为有界的 `view-type-parameters-v1` 参数合同。支持的 Schema 词汇贯通声明、模型参数和解引用校验。其他词汇会在 Tool 定义期带路径拒绝。完整支持范围见 SDK 的[`view-type-parameters-v1` 参数合同](../../sdk/docs/ordinary-v2.md)。Native Tool 的公共别名约束见上文；这不限制纯 Core 内部身份。

本候选的工厂作者标记为 `view-type-tools-v4`，Host/Worker mode 为 `view-type-parameters-v1`；旧 Hook、实例 Tool 执行、专属 profile 和旧 wire 成功路径退出。View/Ref owner、授权后重验、预算及释放保持。观察的准备与采用分开，显式采用新观察会撤销旧资格，规则见下节。历史验收记录保留各自日期和适用产物，未执行的新候选测试不能标成已通过。

### 串行采用与失败

`AppInteraction.observe()` 只准备观察；`adoptObservation(id)` 同步返回 adopted 或 rejected。未采用的绑定返回 OBSERVATION_NOT_ADOPTED，采用新观察后旧 ID 返回 OBSERVATION_UNAVAILABLE，不会按 Ref 名重定向。失败 adopt 不撤销尚有效的当前观察，已释放 ID 不可恢复。独立 App 实例分别持有观察。

Source 按 App 准备和诊断；后台通知、getContext 预览不换当前。若采用时跨 App 部分成功，错误 code 为 SEMANTIC_ADOPTION_PARTIAL，并保留逐 App 结果；不宣称整体回滚。Driver 不进入模型，仍在 finally 释放本轮资源。所有 App 采用失败时为 SEMANTIC_ADOPTION_FAILED。Source 不持有跨轮常驻 current。必要操作收据及完整请求防重不随旧观察撤销而删除。


View.type 与 View.kind 必须显式声明，DOM Producer 不扫描正文分类。Snapshot 保存未转义 Markdown；消息边界将正文及 Ref 提示编码为 XML 文本，Host 预览识别外壳后解码一次，保留字面标签、实体文本和首尾空白。原样多行内容通过 pre/code 投影；完整合同见 [View](../../sdk/docs/views.md)。

Ref 调用按 View 定位：View 内显示 `[设计阶段](Phase:completed_phases[0])`，所在 XML id 为 plan_b 时输入 `plan_b.completed_phases[0]`；整列表输入 `plan_b.completed_phases`。类型提示不进入地址，业务类型仍由 Ref 元数据和参数合同检查。Host 不猜当前 View，不将 ViewType/name 当作 View id。此规则只适用于声明为 Ref 的参数。
