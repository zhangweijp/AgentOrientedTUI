# Minimal Core Batch 09 — 统一真实 Source 的上下文捕获与执行入口

- 日期：2026-11-05（Asia/Shanghai）
- 状态：**AUTHORIZED_FOR_IMPLEMENTATION**
- 范围修订（2026-11-05）：项目所有者明确取消 D3 历史消息迁移；不延期、不另包、不计剩余工作或准出条件。D1 的 Source 统一与身份修复继续执行。
- 白名单补充（2026-11-05）：授权 host/src/im/types.ts 仅删除 IMDrivenSourceLike.getMessages 的必填声明，解除 IM Source 退出旧方法后的遗留结构约束；其余成员、类型和导出保持。
- 测试白名单补充（2026-11-05）：授权 host/test/session-manager-v3.compaction.integration.test.ts 仅在后两个既有 Host Source fixture 中各添加 notifyNewMessage: vi.fn()；全部原断言、消息、调用顺序、清理和其他 mock 保持。
- MCP 工厂白名单补充（2026-11-05）：授权 host/src/mcp/index.ts 仅对齐现有 Driver 公开的 Tool/jsonSchema 类型来源，并在 convertMcpTool 中用等价普通对象保留 type: 'dynamic'；不改 MCP schema 数据、执行闭包、客户端/配置/获取/调用/超时逻辑，不升级依赖、不新增强转或兼容层。证据：review-evidence/minimal-core-batch-09/sdk-boundary-proof.json。
- 负责人：本会话负责人；执行者：Codex。
- 前置：Batch 08 已 APPROVED，批准 patch 为 `67b91075776dbc99caefda16166231adc9d17bbede4a5e0dc6c59b1cd412966f`。
- 本批交付目标：五个真实 Host Source 全部采用既有 getContext 合同；Driver 只采集和执行本轮 Context；旧 split API 与两处 Source executor fallback 退出。

## 1. 给 Codex 的执行指令

直接完成本任务书范围内的实现、必要验证、迁移说明和独立 patch，提交 **READY_FOR_REVIEW**。由负责人独立审阅，执行者不能自行改为 APPROVED。

项目：`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI`。

先读 AGENTS.md、.agents/skills/minimalist/SKILL.md、本任务、Batch 08 负责人复核，以及 MINIMAL_CORE_REFACTOR_PLAN.zh-CN.md 的 D1，以及 D3 的取消决定与既有行为保持要求。deepseek_review.md 仍是已有全局 TODO 来源；本文件只限定 D1 的本批实施，不另建平行总任务清单。

按开工时实际工作树建立新基线，保全既有修改、前八批材料和负责人进度快照。不得以 HEAD、旧 planning 或旧 dist 代替实际基线。Batch 08 独立审计后发现 28 个历史根目录文档/patch 在原路径不存在，详见其复核第 7 节；开工记录实际存在状态，不擅自恢复这些并行变化，也不得混入本批 patch。不得 reset/checkout/clean 覆盖用户修改，不创建提交、push、merge 或发布。

本批是一个完整的 Source 接入合同包，包含两项明确的身份修复；不是纯机械改名，也不要求正常行为全部产生差异。先刻画保持项，对身份修复取得有效先红，再迁移生产代码。

## 2. 唯一 Source 合同与删除目标

复用当前类型，不建立新协议：

```ts
interface DrivenSourceContext {
  messages: MessageWithTimestamp[];
  tools: Record<string, Tool>;
  executeTool?: (
    toolName: string,
    args: unknown,
    toolCallId: string,
  ) => Promise<ToolResult | undefined>;
  release?: () => void | Promise<void>;
}

interface ContextDrivenSource {
  readonly name: string;
  getContext(): Promise<DrivenSourceContext>;
  onUpdate(callback: () => void): () => void;
}

type DrivenSource = ContextDrivenSource;
```

保留现有 DrivenSourceContext、ContextDrivenSource 名称；DrivenSource 仅作为同一形状的既有名称，不再是双轨 union。删除 IDrivenSource 及其公开导出，删除 ContextDrivenSource 的三个 `?: never` 负字段。getContext 必需，split-only 对象不能再作为合法 Source。

Driver 只调用 getContext；只从本轮 context.executeTool 建立执行路由。删除 getMessages/getTools 捕获分支，以及 run 和 executeToolCalls 中的 Source 级 executor fallback。调用 context executor 时保持现有 this 语义。

五个迁移 Source 删除用于旧协议的 getMessages/getTools/executeTool 公共入口。业务函数可以按职责保留为 private 方法或局部闭包，不保留同功能兼容包装。无工具 Source 不再实现假 executor；无保留资源 Context 不必制造空 release。

Host 本地临时 IDrivenSource、ToolResult 重复定义退出，复用 Driver 现有公共类型。Host/IM/Skill 工具中的占位 execute 可删除；真实业务由 Context 执行器进入。LLMClient 现有移除 execute 的防重复执行边界保持。

## 3. 已确定的行为合同

### 3.1 捕获与释放

- 每个活跃 Source 每轮顺序调用一次 getContext，不拆成多个读取入口。
- 保持 Driver 对当前 Context Source 的失败策略：getContext 抛错终止本轮，后续 Source 不继续捕获；finally 释放此前已捕获的 Context。
- 五个原 split Source 原来在 Driver 中发生捕获失败时会被记录并省略。迁移后，这项宿主降级策略由对应 Source 自己负责：捕获失败记录真实错误，返回完整空 Context `{ messages: [], tools: {} }`，健康 Source 继续；不得返回半份消息或半份工具，不得悄悄使用旧 cache。消息捕获失败后不继续采集该 Source 的工具，下一轮可以重新捕获，不缓存空结果为永久成功。
- 上一条只适用于这五个迁移 Source，不能变成 Driver 对所有 getContext 异常的通用吞错策略。SystemPrompt 正常读取不新增无必要的异常框架。
- IM 继续共用 historyLoading Promise；失败 reset、并发等待、下一次显式捕获重试和加载期间消息合并保持。不做自动重试循环，不把加载失败缓存为永久成功。
- 保持既有逆序 release、释放失败后继续释放其余 Context、模型或执行失败时清理，以及真实 handler 完成后才释放的时序。

### 3.2 MCP：执行器属于当轮 Context

删除跨轮 toolsCache，用当轮局部捕获保存实际 Tool 对象及其 execute 函数。模型等待期间再获取工具或修改后来缓存，不得使旧 Context 改投后继工具。

实际调用使用捕获的函数和原 Tool 的 this，继续传递原有 `{ toolCallId, messages: [] }`。不能在执行时重新读取可能被替换的 tool.execute，也不能再查询 MCP.tools()/clients() 来重新定位执行器。

执行前复核已有 sourceEnabled 和 isToolAllowed（工具、服务器禁用控制）。已禁用的调用返回 `outcomeStatus: 'rejected'`、`error.code: 'E_SOURCE_UNAVAILABLE'`，真实业务零进入；这类未进入业务的拒绝不触发执行成功/失败后的 MCP 通知。Driver 自身的 stop/Source 门禁仍保留，不能用这一检查替代它。

保留当前 MCP 成功字符串、对象 JSON 序列化、`Error: …` 结果映射及已进入操作的一次更新通知。原客户端失效后按现有失败映射结束，不自动重试或改投新客户端；不借本批重做失败分类。未知工具仍返回 undefined，由 Driver 保持原 E_TOOL_NOT_FOUND 区分。

### 3.3 Host：捕获 topic，拒绝跨 topic 的迟到操作

getContext 开始时保存 topicId。消息读取与 compaction 执行闭包使用该 ID，不能在 await 之后重新读取 this.topicId 作为本轮目标。

实际执行前，若 current topicId 与 captured topicId 不同，返回 `outcomeStatus: 'rejected'`、`error.code: 'E_SOURCE_UNAVAILABLE'`；在解析业务参数和调用服务前拒绝，messageService.compactContext 零进入，也不发 compaction 更新通知。即使旧调用给出空 summary，也优先返回该身份拒绝。新 Context 正常作用于当前 topic。

该合同是执行时的 topicId 相等检查，不承诺 A→B→A 后永久撤销旧 Context；本批不新增 epoch、generation 或会话身份系统。保留空 summary、force、阈值、正常 compaction 结果、通知和 hard fallback 业务算法。

### 3.4 SystemPrompt、Skill 与 IM

- SystemPrompt 保留 system/static、timestamp 0、setSystemPrompt 通知；旧 Context 的正文不被后续更新改写，新 Context 读取新值。
- Skill 使用当轮 catalog 对应的执行入口，保留现有启用/禁用、缺参、未知技能、读取失败、通知与结果语义；不建立技能正文版本锁或另一个缓存层。
- IM 仍属于原 sessionKey，保留历史合并、去重、timestamp/region、compaction、replaceHistory、triggerAgent:false，以及 Batch 06/07 已批准行为。

### 3.5 Driver 保持项

- 同名工具仍由后一个 Source 覆盖；工具描述、Schema、provider metadata 和非 execute 回调保持。
- 保留 toolToSourceMap、公开 getToolSource 及其更新时间：成功捕获后的 Map 更新仍在 unchanged-input skip 之前；捕获失败时不顺手改变原 Map 状态。
- 保留无 executor 与未知工具的结果区别、每次调用前的 stop/Source 禁用门禁，以及同轮第二个工具的门禁。
- 保留串行执行、pending、debounce、输入签名、状态机、collectMessages 规范化、region 排序和消息协议整理。
- 保留 Batch 07 的 IM 工具结果通知与安静窗口行为，不通过手工追加 trigger 掩盖回归。

## 4. 修改白名单

所有路径相对于项目根目录；只修改本合同直接需要的部分。

### 4.1 生产文件

| 文件 | 允许范围 |
| --- | --- |
| agent-driver-v2/src/core/interfaces.ts | 单一原子 Source 形状和旧接口退出；其他配置/结果类型保持 |
| agent-driver-v2/src/index.ts | 删除 IDrivenSource 导出，保留其余实际公共入口 |
| agent-driver-v2/src/core/agent-driver-v2.ts | 单捕获、Context 执行器路由、删除 split/fallback；保持第 3.5 节 |
| host/src/adapters/system-prompt-source.ts | 原子捕获、删除空工具/假执行协议方法 |
| host/src/adapters/host-driven-source.ts | 原子捕获、topic 绑定及守卫、重复类型退出 |
| host/src/mcp/source.ts | 当轮工具/执行器捕获、现有 enable 复核、删除 toolsCache |
| host/src/mcp/index.ts | 仅修改 convertMcpTool 所需的 Tool/jsonSchema 类型来源和 dynamicTool 等价对象构造，显式保留 type: 'dynamic'；其他 MCP 逻辑保持 |
| host/src/skills/skill-driven-source.ts | 原子捕获与当轮 catalog 执行入口 |
| host/src/im/im-driven-source.ts | 原子捕获、共享历史加载接入、业务执行迁移到 Context |
| host/src/im/types.ts | 仅删除 IMDrivenSourceLike.getMessages 的必填声明；其余成员、类型和导出保持 |
| host/src/core/session-manager-v3.ts | 仅真实 Source 装配类型迁移及去掉 mcpDrivenSource as any |
| host/src/core/host-manager-v2.ts | 仅同上；不得改 callbacks、调度和 Batch 07 通知 |

无需新增生产文件、基类、通用适配器、策略开关或依赖。Runtime 当前已接入 ContextDrivenSource，本批不改其生产代码。

**MCP 工厂附加授权：** 当前 Host 自己解析的 AI SDK Tool/jsonSchema 与 Driver 已公开的 Tool/jsonSchema 来自不同 Zod 类型环境（TS2322 / TS2589），只在 Source 侧强转不能作为修复。仅允许将 convertMcpTool 所用 Tool 和 jsonSchema 引到现有 @aotui/agent-driver-v2 公共入口；JSONSchema7 可保留原类型来源；移除该处 dynamicTool 工厂，按原字段顺序返回同内容对象，末尾显式 type: 'dynamic'。保留原 Schema 生成字段、execute 函数体、client.callTool 参数、CallToolResultSchema、timeout 和 resetTimeoutOnProgress；原工具 key 和 MCP.tools() 遍历保持。不新建 tool 工厂、工具包装、类型断言、依赖或导出。MCP.tools() 声明所用 Tool 类型来源的必要变化单列为允许差异，公共结果语义及运行对象不变。Codex 在本批严格语义检查中保留此项前后的 TS2322/TS2589 -> 0 证据，运行既有 MCP 回归，并用受控工具检查 dynamic 标记、描述/Schema、调用次数/目标/参数和结果。原开工 baseline 不回写；按 scope-revision-04/revision.json 核对新增授权。

IM 类型补充的依据：IMSessionManager 将真实 IMDrivenSource 赋给 IMSession.source；旧方法退出后，IMDrivenSourceLike 中无生产消费者的 getMessages 必填字段导致 TS2741。仅删除该字段，不改成可选、不恢复旧方法、不添加兼容包装或类型绕过，也不向该窄管理接口新增无人消费的 getContext。Codex 重跑原先暴露 TS2741 的真实语义检查和本任务既定 IM 回归，无需为字段删除新增永久测试。原开工基线及失败证据保持；任务书变化以 scope-revision-02/revision.json 的负责人授权增量核对，不回写旧基线。

### 4.2 永久测试

允许迁移以下现有测试中的旧 Source fixture/直接调用，并保留有效行为断言：

- agent-driver-v2/tests/core/agent-driver-v2.test.ts
- agent-driver-v2/tests/core/state-machine.test.ts
- agent-driver-v2/tests/core/semantic-context.test.ts
- agent-driver-v2/tests/core/tool-execution-owner.test.ts
- agent-driver-v2/tests/core/context-regions.test.ts
- host/test/host-driven-source.test.ts
- host/test/adapters/system-prompt-source.test.ts
- host/test/mcp-driven-source.test.ts
- host/test/im/im-driven-source.test.ts
- host/test/im/im-session-manager.test.ts
- host/test/im/im-tool-result-continuation.test.ts
- host/test/session-manager-v3.integration.test.ts
- host/test/session-manager-v3.compaction.integration.test.ts（仅下述两处 fixture 补齐）

该 compaction 测试文件仅授权在“marks compaction anchor only when context_compact succeeds”和“does not mark compaction anchor when context_compact is skipped/failed”两个既有 Host Source fixture 中各添加 `notifyNewMessage: vi.fn()`。这用于补齐生产 handleMessage 已调用的依赖；不得改原断言、消息内容、调用顺序、清理或其他 mock，不改生产通知代码，不手工 trigger/emit 或模拟新调度。先保留原基线失败与补齐前文件，再用相同生产版本重跑该文件，单独记为基线 fixture 修复；它不计为本批身份问题的有效先红，也不证明真实通知链或续轮。随后继续本批既定 Host 回归。开工基线不回写，额外文件和任务书修订按 scope-revision-03/revision.json 核对。

允许新增一个 host/test/skill-driven-source.test.ts，补齐真实 Skill Source 的合同。只证明退出 split API 的断言可以删除；同一测试内仍有价值的排序、门禁、释放、失败与通知断言必须迁移，不能整体丢掉。

### 4.3 文档与证据

当前使用文档仅修改 agent-driver-v2/README.md，以及上述源码中与接口直接相邻的 JSDoc。README 改为唯一 getContext 接入，说明执行/释放持有期、失败策略和旧 split 迁移；示例使用当前 SemanticAOTUIDrivenSource，不保留已退出路径。

本批交付使用根目录 MINIMAL_CORE_BATCH_09_REPORT.zh-CN.md、MINIMAL_CORE_BATCH_09.patch 及 review-evidence/minimal-core-batch-09/。任务书本身、前八批、AGENTS、skills、旧 planning 和负责人材料均为保护项。

如果发现白名单外有不可绕过的真实生产消费者，先保留证据并提交具体阻断，不用 any、禁用检查或删除测试绕过；也不泛化扩大到整仓重构。

## 5. 开发与验证计划

### A. 实际基线与保持项刻画

保存改动文件 preimage、已有 diff、HEAD/index、相关依赖配置和历史保护指纹。建立一次本包基线，不为每个 Source 重复建独立批次。

先运行当前 Driver 全量和现有 Host 相关回归。新增的保持项刻画应先在旧生产上通过。保存实际公共声明原件和必要输入指纹，不只保存哈希，不用 isolated/transpileDeclaration 代替语义检查。

### B. 身份修复取得有效先红

针对 MCP 当轮执行器/禁用门禁、Host topic 切换，先证明原实现实际选择了错误目标或进入了本应拒绝的业务。用真实 Driver 公共 trigger 主链与受控模型/外部边界，或仅保存在本批证据中的最小旧调用适配完成。

基线缺少 getContext、新类型无法导入、测试夹具报错、超时等都不算有效红灯。基线适配不进入生产，也不保留为兼容框架。候选正式测试只使用新公开合同。

### C. 一次完成生产与调用方迁移

先改类型与五个 Source，再删除 Driver 双轨。MCP/Host 身份修复与原结果映射分别验证。迁移既有直接调用测试和真实装配，去掉无效接口/JSDoc/占位 execute；保留仍有业务职责的方法。

### D. 必须证明的场景

| 场景 | 断言重点 |
| --- | --- |
| Driver 单路径 | 每源每轮一次 getContext；即使对象另有会抛错的旧方法也不调用；只用当轮 executor；this 保持 |
| 失败与清理 | 原 atomic 抛错终止、后续不采集、先前逆序释放；迁移 Source 受控失败空 Context、健康来源继续；释放失败不阻断其他释放 |
| 路由与门禁 | 同名覆盖、Map 更新时间、无 executor/unknown 区别；stop、禁用及同轮后续调用零业务进入 |
| MCP 身份 | 先捕获 A、再捕获同名 B；旧调用只进 A，新调用进 B；替换原 tool.execute 后旧调用仍使用原函数及正确 this |
| MCP 实时控制 | 捕获期间/模型等待期间/首个工具后禁用 Source、server、tool，后续业务零进入；新合法 Context 能正常执行 |
| MCP 结果 | 成功字符串/对象、效果后抛错、原映射和通知次数；真实 SDK 自动执行 0 次、Driver 执行 1 次 |
| Host topic | A 捕获后切 B，旧调用 E_SOURCE_UNAVAILABLE 且 service 零进入；读取等待时切换也不混合 A 消息/B 执行器；新 Context 正常 compact B |
| Host 业务 | 空 summary、force、阈值、结果和通知保持；hard fallback 算法不变 |
| IM 历史 | 多捕获共用加载；加载时追加不丢失；失败诊断、空 Context、下一次共享重试；持久化与 compaction 等待保持 |
| IM 续跑 | 真实 Host→IM Session→IM Source→当前 Driver；pending 前提、第二轮最终 assistant、在途结束后 600 ms 安静窗口继续成立 |
| SystemPrompt/Skill | 旧/新 prompt 捕获各自稳定；Skill enable/disabled、当轮目录、缺参/未知/失败/通知保持 |
| 公共类型与 Runtime | 原子 Source 正向可编译；split-only 不可接入；既有 Runtime adapter 正向兼容 |

以上是行为范围，不是要求机械新增同样数量的测试。优先扩展能证明真实风险的现有用例，无新增 skip 或长期 sleep。

### E. 实际执行入口

Driver 目录：

```sh
pnpm exec vitest run --no-cache --reporter=dot
pnpm exec tsc --noEmit --project tsconfig.json
pnpm build
```

Host 回归必须解析到本次构建 Driver，记录真实解析路径及产物指纹。Host 目录：

```sh
pnpm exec vitest run \
  test/host-driven-source.test.ts \
  test/adapters/system-prompt-source.test.ts \
  test/mcp-driven-source.test.ts \
  test/im/im-driven-source.test.ts \
  test/im/im-session-manager.test.ts \
  test/im/im-tool-result-continuation.test.ts \
  test/session-manager-v3.integration.test.ts \
  test/session-manager-v3.compaction.integration.test.ts \
  test/session-manager-v3.tool-receipts.test.ts \
  test/source-controls.test.ts \
  test/session-manager-v3.agent-source-controls.test.ts \
  test/skill-driven-source.test.ts \
  --no-cache --reporter=dot
```

新增 Skill 文件不应出现在尚未创建它的基线命令中。严格检查所有受影响 Host 入口和改动测试；若全项目原有错误存在，保存事实并建立保持原严格选项的实际语义 Program，不能修改 tsconfig、跳过声明或新增 any 来制造通过。

Runtime 目录验证其既有原子 adapter：

```sh
pnpm exec vitest run \
  src/adapters/semantic-aotui-driven-source.test.ts \
  src/adapters/semantic-aotui-driven-source.real-core.integration.test.ts \
  --no-cache --reporter=dot
```

用当前 Driver 实际打包内容做最小公开类型/运行消费，证明 Context 正向接入及 split-only 类型退出；复用已有第三方依赖，不要求 registry 安装、发布或全仓包矩阵。Runtime/SDK/Host 全量、GUI/实网/性能矩阵不默认加入；只有具体风险或基线要求才扩展。

### F. 输出、声明和 patch 比较

正常保持场景比较完整模型输入、工具描述、执行次数、结果及释放/通知次序；不得删业务字段或归一化错误来制造相等。身份修复场景按本任务明确的新预期逐项列差异。

本批有批准的接口退出，声明不要求全部字节一致。保存 Driver 公共入口/接口、五个 Source 及 host/src/im/types.ts 的完整基线、候选声明，审计差异只来自：IDrivenSource/split API 退出、union→alias、never 字段退出、getContext 与必要私有执行承接，以及 IMDrivenSourceLike.getMessages 的单字段删除。其余结果、配置和 Runtime 公共合同保持。Host 重复临时类型退出可体现在对应声明差异中；host/src/mcp/index.ts 的 MCP.tools()/convertMcpTool 所用 Tool 声明来源可从 Host-local AI SDK 转为既有 Driver 的公开 Tool，但不得改变模型工具描述、Schema、动态类型或执行结果。

从实际 preimage 生成独立 patch，在本批隔离目录重放并反向恢复；不回滚当前用户工作树。核对原生产/测试/配置范围、历史保护、HEAD/index 和依赖保持。

## 6. 明确排除的工作

**D3 历史消息迁移已由项目所有者取消，不安排后续批次。** 不统一历史消息生产格式，不迁移 result/output 或 assistant JSON string 的读取边界，也不为此删除 Driver 的现有转换。保持消息格式、compaction anchor、collectMessages 的现有读取/恢复/整理行为，不改 message-service-v2.ts。已有 historyLoading 修复及与 Source 改动直接相关的恢复回归继续保留；它们不构成历史迁移工作包。取消项不计剩余工作、工期或准出条件。

本批不实施 R4 最终参数校验迁移、SDK author API、Ref 统一、View 元数据、Observation adoption、新调度/并发/配额框架或 Legacy 大清理。历史已验收事实不重开；未来候选按其变化判断验收覆盖。

## 7. 准出与交付

全部满足后提交 READY_FOR_REVIEW：

1. 五个真实 Source 迁移完成，Driver 只有 getContext/context executor 路径；没有新旧双轨或藏在 helper 中的兼容分支。
2. 两项身份修复有真实先红和正向恢复证明；正常执行、错误映射、捕获失败与释放行为符合第 3 节。
3. Driver 全量、指定 Host 回归、两个 Runtime adapter、严格类型与最小真实包消费通过；原有失败/skip/未执行项分别记录。
4. 公共声明和调用方迁移完整，差异位于明确批准范围；没有用 any、skip、mock 整个主链或手工触发续跑隐藏问题。
5. patch 可重放/恢复，既有修改及前八批证据保持；本批新增、既有引用、负责人并行材料分类准确。
6. 报告写清已删除的旧入口、两项行为修复、实际测试、类型变化、失败与恢复，以及未执行范围。

交付文件：MINIMAL_CORE_BATCH_09_REPORT.zh-CN.md、MINIMAL_CORE_BATCH_09.patch、review-evidence/minimal-core-batch-09/README.zh-CN.md、final-delivery.json。

证据以必要、完整、可复核为准：保留实际原件、原始日志、执行输入和指纹；允许运行元数据集中在一份 JSON，不为每个成功步骤复制多套摘要。不覆盖旧材料，不把负责人文件列为执行者新增，也不为文件数量设指标。

完成后停在 READY_FOR_REVIEW。若出现白名单外必要变更或无法保持的核心行为，报告具体阻断，不自行放宽合同。
