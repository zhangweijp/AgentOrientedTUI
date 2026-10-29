# RFC-0004：Wave 2C 后的 Ref 执行技术路线与架构决策

> 状态：**G0 设计已签署；W01 可转交；G1–G4 尚未通过；实际 Ref 执行仍 NO_GO**  
> 日期：2026-10-24  
> 影响范围：Runtime Semantic Core、Worker IPC、SDK View-local Tool、可信 Controller 接口  
> 明确排除：Mobile、Agent Driver、默认 Tool Router 切换、写入 Tool 开放、完整 M4/Strict  
> 先决裁决：**Wave 2C LIMITED PASS；C1 CLOSED；Actual Ref Execution NO-GO；Full M4/Strict NO-GO**  
> 推荐：**R2 — 在既有 Snapshot V2 上建立纯 Core 来源绑定解析，使用双端协商的版本化执行 IPC，以只读实验开关分批迁移。**

## 0. 证据、基线与本 RFC 的地位

**2026-10-24 负责人更新**：[G0 设计决定](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/rfcs/sdk-runtime-delivery/w00-review-20261024T143800Z/G0-decision.zh-CN.md) 已固定协议名称、错误分类、Ref 类型语义、工程容量及兼容起点。下文保留路线论证与原候选设计；涉及“拟议/候选/待签署”的条款以该决定为当前规范，不能理解为已实现。原交付包内的历史版本不改写。

本 RFC 基于当前工作树的真实实现和下列签署记录：

1. `Runtime Core Semantic Contract RFC/m4/independent-c1-review-20261024T035909Z/CHATGPT_C1_ACCEPTANCE.md`
2. `Runtime Core Semantic Contract RFC/m4/independent-c1-review-20261024T035909Z/INDEPENDENT_C1_GATE.json`
3. `Runtime Core Semantic Contract RFC/m4/wave2c-20261024T005534Z/CONTRACT.md`
4. `Runtime Core Semantic Contract RFC/m4/wave2b-20261023T144207Z/REF_CONTRACT_PROPOSAL.md`
5. `Runtime Core Semantic Contract RFC/m4/wave2c-20261024T005534Z/NEXT_MINIMAL_SLICE.md`
6. `Runtime Core Semantic Contract RFC/07-view-owned-tool-identity-proposal.md`
7. `rfcs/0002-semantic-core-consolidation.zh-CN.md`
8. `rfcs/0003-sdk-runtime-architecture-route.zh-CN.md`（更一般的 SDK/Runtime 演进路线，本 RFC 是 Wave 2C 的限定执行子合同）

**编号裁决**：保留现有 `0003-sdk-runtime-architecture-route.zh-CN.md`，本 Ref 执行提案由原冲突的 RFC-0003 顺延为 **RFC-0004**；C1 与旧交付包引用保持原样，不改写历史证据。此文与 RFC-0003 互为不同层次：前者讨论整体应用框架演进，本 RFC 仅约束 Wave 2C Ref 执行。发生冲突时，现行签署的 C1 及 M4 限定合同优先于未签署的设计建议。

当前工作树 HEAD 为 `789ef07`，并包含大量原有 staged/unstaged/untracked 工作。**仅从 HEAD 检出不能重现 C1 与现有 M4 代码**。本 RFC 新增文件本身不是实施许可，不覆盖任何旧验收包。

C1 已证实：新声明能够进入 SDK/Registry/Snapshot V2；非法位置拒绝；`dependencies`、`dependentRequired` 中的属性名称和 `default/const/enum/examples` 字面值被正确区分。**不允许借 Ref 执行阶段回退、放宽或重写 C1 的 Schema 遍历合同**。

目前 `refDeclarationSupport:'snapshot-value-v1'` **只代表声明保留**。现有 Host `executeReadOnlyViewTool` 检测到声明就返回 `REF_CONTRACT_UNSUPPORTED`；Worker/Registry 旧调用同样拒绝。当前没有 `effectiveArgs` 解析、可信 provenance 授权、新 IPC 或生产可用 Ref 执行路径。

此前新增的内部 `runtime/src/core/invocation/bound-action-executor.ts` 是 **V2 source-bound Invocation / versioned Entity** 技术切片，不是 `snapshot-value-v1` 声明的解析器；不得以其通过测试为由提升 Wave 2C Gate。

## 1. 产品与架构目标

AOTUI 的长期核心不是 DOM/桌面 Tool Router，而是 **Agent-Native Application 的可信交互语义**。Ref 执行必须证明：

- 模型/调用方选择的 Ref 来自它实际看过的**原始** AppSnapshot V2；
- 同一 ViewInstance 的 Tool 声明和 Ref owner 被严格绑定；
- 可信 Controller 在派发**之前**看到最终参数 `effectiveArgs` 与可审计的 `refSources`；
- 执行收到的业务参数等于 Controller 批准的那份有效参数，不会被最新 Snapshot 悄悄替换；
- 声明/版本/来源/权限/预算不满足时 fail closed，Handler=0；
- 仍保留已有普通 Tool 与 Legacy 语义，并以版本化协议避免老 Worker 误执行；
- 所有依赖 DOM、Preact、Node Worker、IPC 的内容只出现在 Adapter，**Ref 绑定规则留在纯 Runtime Core**。

**非目标**：不设计通用 JSONPath、任意嵌套/数组 Ref、跨 View/App Ref、entity Ref 读取、资源写入、typed Ref 元数据注册、不新建 Snapshot Store、不启用默认 Router。声明 `isMutating:false` 是应用声明而非操作系统级只读沙箱。

## 2. 四条技术路线（R0–R3）

下表的路线编号仅用于本 RFC；**不改变 Wave 2B 对“声明位置 + 原始 Ref ID”输入方案 A 的既有选择**。

### R0：Legacy IndexMap / Dispatcher 原位补丁

沿用旧 `VIEW_OPERATION` / `APP_OPERATION`、`IndexMap`，根据字符串是否像 Ref 自动展开，或在当前 ViewType Registry 中直接查找。

优点：表面改动最少、短期 Demo 快。缺点：旧快照/最新 Registry 混用，ViewType 与具体 ViewInstance 不等价，无法证明 Controller 对哪个值授权；很难防止错误对象和隐式展开。**拒绝**。

### R1：Controller 侧预展开，复用旧 VIEW_TOOL_INVOKE

Controller 使用 V2 Store 解析 Ref，构造 `effectiveArgs` 并授权，再直接把 JSON 对象塞入旧 Worker 消息。Worker 只看到普通对象。

优点：不新增 IPC 变体，较易做出 Host 侧 PoC。缺点：旧 Worker 无法区分“授权后的 Ref 展开”与普通调用；不能协商能力，不能确保 SDK wrapper 不泄露 payload；来源证明停留在 Controller 约定中。可用于明确声明为**非通用/非保证**的私有集成，但不能成为 AOTUI 框架合同。**不选**。

### R2：Snapshot V2 来源绑定 + 版本化 Ref 执行 IPC（推荐）

保留 C1 的 opt-in Schema 和原始 Ref ID 输入；在纯 Core 中只解析被声明的顶层槽位，取得**受信 Store 发布的原始 Snapshot**里的 Ref 值；Controller 审阅冻结的有效参数与 provenance；Host/Worker 显式协商新协议能力，且 Worker 必须针对**当前 Tool Binding**核验 SDK Wrapper 真正支持安全 Ref 调用模式；新 Worker 消息单独命名，Worker 复核活态 Tool/View/声明及参数协议；SDK 的框架错误不回显展开 payload。

优点：复用现有 V2 Store、lease、View-owned registry、source-binding、copyJson；与未来 Observation/Invocation 内核一致，不污染默认路径；有清晰失败 Gate。缺点：需要跨 Core、Worker、SPI、SDK 和策略接口协作，真实版本组合和时序测试成本较高。**选择作为近期主线**。

### R3：立即重建 V3 Observation / ActionBinding / IPC / SDK

将独立 `experiments/semantic-kernel` 全面接管现有应用，删除旧协议，让所有 Ref 都通过全新 API。

优点：理论模型最整齐，长期删旧代码的机会大。缺点：需要同时替换快照、应用挂载、SDK Tool、Worker 和现有 IDE，无法在当前有大量未提交工作和 Gate 未闭合时独立判定问题。**作为未来目标，不作为本批实施路径**。

### 对比矩阵

| 标准 | R0 原位补丁 | R1 Controller 展开 | R2 版本化来源绑定 | R3 全量重写 |
|---|---|---|---|---|
| 原始观测可证明 | 差 | 中（仅 Host） | **强（Core + Host + Worker 分层）** | 理论上强，尚待实现 |
| 老 Worker 的错误执行风险 | 高 | **高：旧 IPC 歧义** | **低：无能力确认就不派发** | 高：迁移期大面积不兼容 |
| 保持 C1/旧路径兼容 | 差 | 中 | **高** | 低 |
| Runtime Core 无 Host/DOM | 差 | 中 | **高** | 高 |
| 首次实现改动 | 小 | 较小 | **中，分片可控** | 很大 |
| 独立失败验收 | 弱 | 中 | **强** | 难定位 |
| DX 与长期维护 | 差 | 业务 Controller 重复映射 | **SDK 声明一处，Runtime 统一执行** | 潜力高，迁移昂贵 |
| 本轮裁决 | NO | NO | **RECOMMENDED，实施待批准** | DEFER |

**选择 R2 不等于授权执行。** 此 RFC 是决策建议，独立设计 Gate 与用户后续实施授权必须另行明确。

## 3. R2 的核心不变量

**INV-01 原始来源**：只能由 Runtime 的 V2 Store + `acquireToolSource` 取得 Tool、目标和 lease；不能信任 caller 提供的 Tool JSON、随意字符串、当前 Ref Registry 或最新同名 View。

**INV-02 Scope**：Ref selector 的 `snapshotId/appId/instanceId/viewId/viewInstanceId` 从受信 Tool selection 派生；只有 `refId` 来自已声明参数位置的原始字符串。不得接受 caller 指定第二个 owner、snapshotId 或 ViewInstanceId。

**INV-03 历史值**：S1 里的 Ref=A，S2 仅 Ref 更改为 B（或将 Ref 从最新投影移除），如果原 S1 仍可 acquire、同一 ViewInstance 和 Tool Binding 仍有效、Controller 批准历史 A，则 Handler 必须得到 **A**；绝不在执行时换成 B。策略可以明确拒绝过旧观察。

**INV-04 生命周期和三级能力**：Tool 当前 disabled、改 Schema、bindingVersion 变化、View 卸载重挂、App RESET、Store degraded 等必须 fail closed。能力按三个彼此独立的事实判断：声明保留 `refDeclarationSupport`、Host/Worker 同版本协议 ACK、**当前实例绑定上的 SDK Wrapper 安全模式支持**。前者不能推导后两者；只有 Worker ACK 但当前 Binding 仍是旧 Wrapper 时，拒绝执行且 Handler=0。

**INV-04A TTL 来源**：授权后必须用**原封不动的 sourceRequest** 再次执行 `acquireToolSource` 并验证当前 App/View/Tool，不能仅查看先前 pin、`getById` 或 lease.expiresAt。单个 lease 过期不必使**仍为 current** 的 Snapshot 失效：重新 acquire 成功即可。**已退休的历史 Snapshot 超过 history TTL**，即使旧 lease 仍 pin 住数据、`getById` 能读取，也不得作为新的执行来源；再次 acquire 必须拒绝。跨 Worker 队列及 Handler 入口不宣称具有原子的 deadline。

**INV-05 已批准参数**：`effectiveArgs` 由 Core 从 `rawArgs` 的**声明槽位**展开、严格复制并冻结；Controller 授权后禁止再重新展开或修改它。不同步的新 Ref 不能改变已批准的业务参数。

**INV-06 独立权限**：Snapshot 有效、Ref 类型匹配、`isMutating:false` 都不等于业务授权。Controller 负责用户/租户/资源/内容访问审批；Worker Handler 作为可信应用代码，不能被 JS “只读声明”硬隔离。

**INV-07 容量**：原始 args、Ref 展开、provenance、合成 envelope 和 IPC 数据分别限额。超限整个调用拒绝，不截断、不过滤、多次引用同一对象不能抵扣预算。

**INV-08 错误与结果**：Framework 错误不得包含已展开 Ref payload 或原始 `receivedArgs`；Handler 主动返回的业务 `success:false` 必须保真。**只要请求可能已派发、没有受信终态且无法证明 Handler 未开始，Host 就保守报告 `unknown`**，不依赖它是否收到 Handler-start ACK；禁止盲目重试与虚构 exactly-once。

**INV-09 双参数校验语义**：原始声明位置在 `rawArgs` 中只能是完整非空 Ref ID 字符串；展开后的同一位置在 `effectiveArgs` 中必须是非 null JSON object。对外输入 Schema 的 `type:'string'` **不能原样再次校验展开对象**；Worker 校验两组参数的结构对应，SDK 在受信安全模式下按有效值规则验证 Ref 对象与其他普通参数。

## 4. 公开 SDK / Schema 契约：沿用 C1，不新增输入语言

现有、已通过 C1 的声明形式：

```tsx
useViewTypeTool('describe_file', {
  description: 'Read one file summary from the observed View',
  isMutating: false,
  params: defineParams({
    file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' },
    question: { type: 'string', required: true }
  })
}, async ({ file, question }) => ({ success: true, data: { file, question } }));
```

该示例**当前仍不可执行**。R2 首个执行试点进一步要求 **每个 Tool 的 Schema 恰好声明一个 `required:true` 的顶层单值 Ref 槽位**，如 `file`；含零个、两个及以上声明槽位或声明为 optional 的 Tool 仍可依 C1 正常注册，但**不能通过本试点的新 Ref 执行模式调用**（固定 `REF_CONTRACT_UNSUPPORTED`、authorize=0、Handler=0），待后续 Gate 扩展。**不含新声明的旧 Tool 仍走原有普通调用，不受此试点限制。**Agent 向 `file` 提交完整原始 Ref ID 字符串（如 `"file"`），不是 Markdown、JSONPath、`$aotuiRef` marker、caller 构造的对象或新 Selector。

受信 Schema 仍采用：

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string",
      "x-aotui-ref": { "version": 1, "kind": "snapshot-value", "owner": "tool-target" }
    }
  },
  "required": ["file"]
}
```

若声明 `refType`，必须与 Snapshot RefDescriptor.refType **严格相等**。`unknown` 不可因 Tool 期待 `File`、ID 以 `File:` 开头、payload 有 `type` 字段而升级为 `File`。第一批建议使用无业务 `refType` 的 snapshot-value object；typed Ref 注册单独设计。合法 C1 optional slots 即使未传值，旧执行模式依旧拒绝。

不改根级 V2 exact Schema、不新增第三种 Ref Target、不重写 C1 递归检测器。未来如支持嵌套/数组/marker，必须单独升级子合同版本。

## 5. Core / Controller / Worker 的精确执行链

```text
Trusted caller request {snapshotId, toolId, viewId, args(raw)}
       │
       ▼
[Host execution adapter] 冻结完整请求（await 前）+ 原始请求预算
       │
       ▼
[Core] acquireToolSource(V2 Store) → tool / target / historical lease
       │
       ├─ 检查 readonly、受信 Schema 声明、View/Tool 当前绑定
       ├─ 只读取原始 Snapshot Ref（同 owner 的 snapshot-value object）
       ├─ 从 rawArgs 生成 detached effectiveArgs
       ├─ 生成 detached refSources（不包含 payload）
       └─ 有效参数、provenance、envelope 预算
       │
       ▼
[Trusted Controller policy]
  authorize({source, rawArgs, effectiveArgs, refSources})
       │
       ├─ 非 true / throw → 拒绝，Worker=0
       ▼
[Core + Host] 再次 acquire 原始 sourceRequest + TTL + live state
       │
       ├─ S1 payload 保持 A，不换 S2 B
       ▼
[Host] 检查本 AppInstance 的版本化协议 ACK 与显式开关
       │
       ▼
VIEW_TOOL_INVOKE_REF_V1 （新 IPC；仅可信 Host）
       │
       ▼
[Worker] 协议/实例/活态 Binding / 参数结构复核
       ├─ 当前 Binding 注册的 SDK Wrapper 必须支持安全 Ref 执行模式
       ├─ 缺少 Wrapper 支持 → 前置拒绝，Handler=0
       │
       ▼
[SDK Wrapper] 用有效参数校验；Framework 错误只输出安全的参数路径/代码
       │
       ▼
[Trusted App Handler] 执行业务 readonly 处理，保留真实 OperationResult
       │
       ▼
[Host] 区分 transport ACK / Handler success / unknown outcome；释放 lease
```

其中 Core 只处理无环境依赖的 JSON、Store/Ref/Tool 身份和构造，不得 import DOM、Preact、Worker、Host 或模型 SDK。新逻辑应以类似 `prepareSnapshotValueArguments(store, selection, rawArgs)` 的内部纯函数/模块承载，复用 `copyJson`、`validateToolRefDeclarations`、`resolveRef`；不创建第二个 Store、全局 RefMap 或身份体系。

## 6. `effectiveArgs` 与 provenance：不可模糊的授权范围

推荐可信 Controller 唯一授权输入（概念 API，未实现）：

```ts
type RefSource = Readonly<{
  param: string;        // 来自受信 Tool Schema 的声明槽位
  refId: string;        // 已在原 Snapshot 中精确匹配的完整 ID
  kind: 'snapshot-value';
  refType: string;      // 实际 RefDescriptor.refType，不从 caller 推断
  snapshotId: string;   // Runtime selection 派生
  viewId: string;
  viewInstanceId: string;
}>;

type AuthorizedRefScope = Readonly<{
  source: {
    snapshotId: string; appId: string; appInstanceId: string;
    toolId: string; viewId: string; viewInstanceId: string;
    bindingVersion: number;
  };
  rawArgs: Readonly<Record<string, unknown>>;
  effectiveArgs: Readonly<Record<string, unknown>>;
  refSources: readonly RefSource[];
}>;
```

字段仅作语义说明；正式 TypeScript 类型必须使用 Runtime 当前真实字段与精确的只读 JSON 类型，**不能把模型/caller 提供的 provenance 当真**。来源字段由 Runtime Store selection 填入，Controller 不可修改。Controller 返回**严格 true** 才授权；传入未验证对象或新的文件路径还需要业务层检查。

`effectiveArgs` 内：普通参数原样保留完整 JSON 值，仅声明位置替换成原 Snapshot 的 JSON object。若引用不存在、kind 为 entity、owner 不匹配、值为 null/scalar/array、refType 不匹配，全部拒绝，不从最新 Snapshot 或其他 View 查找。没有声明的位置，即使字符串形似 Ref 也不得解析。

### 6.1 rawArgs / effectiveArgs 的双阶段、非同构校验

对外 Schema 的 Ref 位置是 `type:"string"`，表达**调用方输入的是 Ref ID**；展开之后，同一个位置成为 JSON object，表达**Handler 获得的是历史值**。这是两个不同阶段的合同，**绝不使用同一输入 Schema 对展开前后整体参数各校验一遍**，也不因此引入通用 JSON Schema 引擎。

| 验证所有者 | `rawArgs`（展开前） | `effectiveArgs`（展开后） |
|---|---|---|
| **Core** | 对复制后的可信 Tool Schema 找到**唯一必填**声明槽位，要求对应输入为非空完整 Ref ID 字符串；精确 Ref ID 比较，不 trim、更不解码 Markdown/路径；普通字段只做严格 JSON/原请求预算 | 从原 Snapshot 解析同一 owner 的 `snapshot-value` 非 null JSON object；仅替换声明槽位；严格执行 refType/预算/冻结/provenance 合同 |
| **Worker** | 验证版本模式、同一实例的活态 Tool/Binding 与声明槽位，Ref 槽仍为原始字符串 | 验证有效 Ref 槽为 object、`refSources` 与已声明槽位、`rawArgs` ID/来源元数据一致；**所有非声明槽位的键、存在性和规范化 JSON 值必须与 `rawArgs` 相同**；不能声称能独立复算历史 payload |
| **SDK 安全 Wrapper** | 不把原始 Ref 字符串当作业务 Handler 的 Reference 对象，不走旧的单一路径 | 在可信内部调用模式下，Ref 槽位严格为已展开 object；其余普通参数按现有 ParamSchema 规则校验 required/type/constraints；失败只返回安全 Framework 错误，无 `receivedArgs` |

其他普通字段的业务校验仍交由 SDK，不能用 Core “只校验 Ref ID”冒充整份参数已获业务 shape 验证。Worker 对未声明位置不仅检查值，还检查**缺失/多余键**；防止授权后的字段被悄悄添加、删除或修改。对于声明位置，Worker 核对的是受信 Host 所提供的来源元数据、raw ID 与 payload 的结构和预算；它没有 Store，因此不能独立证明 payload 字节内容与历史 Snapshot 一致。

Controller 审核的有效值必须是**同一个语义值**，Worker/SDK Handler 初始接收的也是这份值的受信 structured-clone 副本。不能宣称 Worker 内对象在 Handler 执行期间仍被冻结；可信应用可改变自己的本地变量，但来源事实不因此重写。

## 7. 版本化 IPC 与双端能力协商

选用新、不可被旧 Worker 误解释的消息变体：

`VIEW_TOOL_INVOKE_REF_V1`（**拟议，当前不存在**）。

示意：

```ts
type ViewToolInvokeRefV1 = {
  type: 'VIEW_TOOL_INVOKE_REF_V1';
  requestId: RequestID;
  appId: AppID;
  instanceId: string;                // Runtime 分配的 App 执行实例
  snapshotId: string;                // 原始 Runtime Store-issued source
  tool: ToolDescriptorV2;            // 来自 pinned V2，不来自 caller
  target: ToolTargetV2;              // viewInstanceId + bindingVersion
  argumentMode: 'snapshot-value-v1';
  rawArgs: JsonObject;                // 已复制且限额的模型输入
  effectiveArgs: JsonObject;          // Host 已解析且 Controller 已审核
  refSources: readonly RefSource[];   // 受信 provenance 事实，无 payload
};
```

这**不是第二个业务执行器**：Worker 最终仍复用既有 View-owned Tool/SDK Handler 注册表，但必须走一条能识别 Ref 模式的入口，而不是放宽旧 `invoke()` 的阻断条件。**Ref 执行必须走受信 Wrapper 模式**，不能把未识别的第二参数塞给旧 Wrapper 并期待它自动忽略 `receivedArgs`。

**协议协商（Host ↔ Worker）**：Host 的 `INIT` 请求中增加 `requestedCapabilities: ['view-tool-ref-invoke/v1']`（名称拟议）；新 Worker 的 `INIT_RESPONSE` 必须显式返回实际启用的 `acceptedCapabilities`。Host 只接受精确版本匹配、同一 AppInstance/INIT 周期、双方 opt-in 的 ACK；没有该字段的旧 Worker **必定不支持**。能力在 RESET/回收/重新 INIT 时清空，拒绝错误实例或意外旧响应。

**SDK Wrapper 能力（每个 Tool Binding，而非全 Worker）**：即使 Host 与 Worker 双端 ACK，仍必须确认当前 `(appInstanceId, viewInstanceId, toolName, bindingVersion)` 所属的**实际 SDK Wrapper 实现**支持 `snapshot-value-v1` 的安全有效参数校验和无 payload 错误回显。未来由 SDK 注册的**受信内部 Wrapper 元数据**（候选 `safeRefInvocationMode: 'snapshot-value-v1'`，不加入 Agent args、不作为 AppSnapshot 的 caller 标记、不增加公开身份）向 View-owned Registry 提供这一事实；Runtime 仅保留可与**当前绑定和真实注册 Wrapper**关联的验证信息，禁止调用方或普通 Tool Schema 自行宣称。解绑、禁用、重注册、同名重挂时必须重新核验或自然失效。没有元数据、只有声明保留旧 Wrapper、未知模式/版本时，一律拒绝且 Handler=0；不得回退旧 SDK Wrapper 或旧 `VIEW_TOOL_INVOKE`。Host 可选用受信的 Worker 预检提前拒绝；**Worker 必须在入口再次复核**，不能仅相信 Host 上一次查询结果。

因此必须区分：① SDK/Runtime Port 的 `refDeclarationSupport`（**只声明**）；② Host/Worker `view-tool-ref-invoke/v1` ACK（**只懂 wire 协议**）；③ 目标当前 Binding 的安全 SDK Wrapper mode（**能够安全校验并进入 Handler**）；④ Controller 当次 `authorize===true`（**业务授权**）。四者缺一不可，且不能相互推导。

新的 Host opt-in 建议命名 `experimentalSnapshotValueRefExecution`，默认 false，且必须满足现有 Shadow + ReadOnly View Tool 实验依赖。能力支持只是“可以解析协议”，不是业务授权；每次调用仍需 Controller 策略审批。

Worker 对新消息须验证：模式精确匹配、协议能力有效、当前 AppInstance、只读 Tool、tool/target canonical + bindingVersion、**当前注册的 SDK Wrapper 安全模式元数据**、Ref 声明位置与 refSources 名称/数目/refType/kind/raw ID 一致、rawArgs 与 effectiveArgs 未声明位置**键集合和规范化值一致**、扩展后总预算和 Result 约定；失败必须在 SDK Handler 前拒绝。Worker 对来源真实性依赖受信 Host IPC，不能自行“重新展开最新 Ref”来比较。

**信任边界**：Worker 不持有 Host 的历史 Snapshot Store，故无法独立复算 payload=A 的真实性；该事实来自可信 Host IPC 与来源选取。Worker 只能复核活态本地状态和协议自洽性。禁止用仅由 caller 可构造的 marker、hash 或声明自证来源。跨 Worker 队列的原子 TTL/事务性未获证明，不能借新 IPC 冒充 Strict。

### 7.1 Host 可实际判断的派发结果与 OperationResult 映射

当前 `OperationResult` 只有 `success:boolean / data? / error?`，**它本身不表达“业务一定未开始”和“结果未知”之间的区别**。建议新 Ref IPC 的可信终态响应（字段名均为候选，G2 应冻结）额外包含一个**终态阶段标记**，而**不**新增 Worker Handler-start ACK 或第二套执行器：

```ts
type RefV1Terminal =
  | { phase: 'not-entered'; result: OperationResult }  // 明确前置拒绝，Handler=0
  | { phase: 'entered-returned'; result: OperationResult }; // Handler 进入并返回
// 该标记由受信 Worker/安全 SDK Wrapper 产生；Host 不采信 caller 所填 phase。
```

| Host 可观察事实 | 对外兼容 OperationResult | 是否可以断言 Handler=0 |
|---|---|---|
| Host 在尝试派发前明确拒绝（参数、来源、TTL、权限、capability） | `{success:false,error:{code:<固定拒绝码>,message:<安全文案>}}` | **可以** |
| Worker 以正确 requestId/AppInstance/version 返回可信 `not-entered` 终态（含 SDK 安全校验拒绝） | 原样传递**安全的前置拒绝 OperationResult** | **可以** |
| Worker 返回可信 `entered-returned` 终态 | 保留业务 Handler 的真实 `OperationResult`，包括 `success:false` | **不可以** |
| Host 已开始派发或交付可能发生，但超时、Worker 退出、连接中断、响应丢失、版本不符，**没有可信终态，也不能证明未执行** | `{success:false,error:{code:'TOOL_OUTCOME_UNKNOWN',message:'Execution outcome unknown; inspect state before retrying'}}` | **不可以** |

这里的 `TOOL_OUTCOME_UNKNOWN` 是**候选新增稳定错误码**；`success:false` 只是现有 `OperationResult` 的类型兼容包装，**不表示已知业务失败、没有副作用或允许安全重试**。任何消费适配器必须将该码识别为“需查询事实后处理”；不能把它归并成普通可重试异常。未来统一五态 `ToolOutcome` 时，对应 `unknown`。如果阶段标记缺失或未能认证属于这次请求，Host 不得将其当作 `not-entered` 的证明。

**判定规则以“是否可能进入执行”为边界，而不是“是否观察到 Handler start”为边界。** 当无法证实 `postMessage` 未发生时，从第一次可能派发起就保守转入未知区间；本地能够确定尚未派发的异常仍可按前置失败处理。Worker 的 `not-entered` 必须由实际控制 Handler 进入点的安全路径确认；不能因为 SDK wrapper 返回 `success:false` 就倒推没有进入 Handler。取消与派发竞态也遵循这一规则。

G2 必须在真实 IPC 层冻结这套 terminal envelope → `OperationResult` 的转换，并验证丢包、乱序、伪造终态、Worker 退出、取消和业务 `success:false` 等场景。只靠 `OPERATION_RESPONSE.success:true`（transport success）不能证明业务已成功，也不能证明 Handler 未执行。

## 8. 预算合同：先限额，再创建大对象

所有数字是**候选实现阈值**，来自现有受限执行与 Wave 2B 建议；未进行 Ref 展开性能或产品 SLA 验证。实施时需对边界和总 IPC 负载独立测量，并在 Gate 中确认。

| 阶段 | 候选上限 | 执行原则 |
|---|---|---|
| 原始完整请求 | depth 25、10,004 nodes、136 KiB approx | before-await copyJson；不读取原对象第二次 |
| `rawArgs` | depth 24、10,000 nodes、128 KiB approx | 只接受有界普通 JSON object |
| Ref 数量 | 初次执行试点 **1 个顶层单值槽位**；扩展上限候选 **32** | 多 Ref 阶段须单独批准；不能接受半截展开 |
| `effectiveArgs` | depth 24、10,000 nodes、128 KiB approx，canonical UTF-8 ≤128 KiB | **从最终根对象重新计费**；重复 Ref 每次完整计数 |
| 来源 + effective envelope | depth 26、11,000 nodes、136 KiB approx 与 canonical ≤136 KiB | RefSources 元数据也计入；不含 payload 重复存储 |
| 新 IPC 完整消息 | 初步候选 canonical UTF-8 ≤512 KiB（含 raw/effective/tool/provenance），另设节点上限 | 不以“有效 args 通过”代替 IPC 边界校验 |
| Snapshot payload 本身 | 已有 Store 上限（单 Ref 可达 512 KiB） | **不**因此放宽调用参数 128 KiB 上限 |

大 Ref 如果无法在有效参数预算内展开，则拒绝整个请求；不会静默截断为“部分成功”。候选 512 KiB 不是平台吞吐保证，测量成本需包括深复制、canonical、结构化克隆、Worker IPC、峰值堆内存。重复 Ref 指向相同对象不抵扣 nodes/bytes。未通过预算验收，不批准新 IPC 调用。

## 9. SDK `receivedArgs` 错误回显必须在执行前解决

当前 `sdk/src/hooks/useViewTypeTool.ts` 的 SDK 校验错误包含：

```ts
error: {
  code: 'E_INVALID_ARGS',
  message: formatValidationErrors(errors),
  context: { errors, receivedArgs: args }
}
```

当 `args` 已是 Ref 展开后的 `effectiveArgs`，只要另一个普通参数校验失败，SDK 就可能回显完整 Ref payload。某些枚举错误消息还可能包含输入字面值。因此**仅在 Host 返回前脱敏远远不够**，中间日志/IPC 也可能已经泄漏。

推荐：Ref 新模式通过**受信的内部调用上下文**通知 SDK wrapper（例如 Registry 调用 Handler 的第二个内部参数/封装入口，而非 caller args 中的 magic field）。**SDK Wrapper 必须在注册时通过受信内部能力元数据声明自己实现了这条安全分支，且与当前 Binding 关联；仅 C1 声明保留的旧 Wrapper 无资格进入此模式，即使 Host 和 Worker 均已 ACK 新 IPC。** Worker 需在 SDK wrapper 调用前检查其能力，缺少则前置拒绝，Handler=0。不得通过调用参数中的私有标记替代此元数据。

在该安全模式下，SDK 的有效参数校验区别于对外 string Schema：已声明 Ref 位置必须收到已展开的 object，普通位置保持原有 ParamSchema 校验。Framework 生成的 `E_INVALID_ARGS` 仅包含稳定错误码、受信参数名/位置和安全原因类别；不包含 `receivedArgs`、`effectiveArgs`、Ref payload、原始非法值、可被恶意对象覆写的 message/toString。还应限制错误列表数量与文本长度。旧无标注模式保持原行为。

业务 Handler 主动返回的 `success:false`、受信 Controller 自己记录的业务结果和其业务输出策略，是**另一条明确的边界**，不承诺泛化为自动脱敏服务。

必须通过实际 SDK/Worker sentinel 测试：Ref payload 包含独特敏感字符串；另一个普通参数故意触发校验失败；最终响应及 Framework 日志/错误上下文都不能出现该字符串，Handler=0，同时确保普通业务 `success:false` 仍保真。

## 10. 错误分类与拒绝顺序

复用现有稳定错误码优先；**下列新码均为候选，不得在本 RFC 中写成已经实现**。

| 条件 | 期望 code / 语义 | Handler |
|---|---|---|
| 原请求无效、getter、超过原预算 | 既有 `OPERATION_INVALID_ARGS` | 0 |
| 无 V2 来源、过期、App/View/Tool 失效 | 现有 `SNAPSHOT_EXPIRED / APP_INSTANCE_MISMATCH / VIEW_INSTANCE_REVOKED / TOOL_SOURCE_STALE` 等 | 0 |
| Schema 声明非法 / 未支持 | `REF_DECLARATION_INVALID / REF_CONTRACT_UNSUPPORTED`（C1 已有） | 0 |
| 旧调用模式请求声明 Tool | 保持 `REF_CONTRACT_UNSUPPORTED` 或新增 `REF_ARGUMENT_MODE_REQUIRED`（实施时固定一个） | 0 |
| Host/Worker 任一方未 ACK 新版本，或当前 Binding 只有声明保留旧 SDK Wrapper | 建议 `REF_EXECUTION_UNAVAILABLE`，不得回退旧 IPC / Wrapper | 0 |
| 位置输入缺失/非字符串/空 ID | 既有 `OPERATION_INVALID_ARGS`（安全参数名） | 0 |
| 原 Snapshot 缺 Ref / owner 不匹配 | `REF_NOT_FOUND` / `REF_SCOPE_DENIED` | 0 |
| payload kind/type/shape 不支持 | `REF_TARGET_UNSUPPORTED / REF_TYPE_MISMATCH / REF_VALUE_UNSUPPORTED` | 0 |
| 展开或 envelope 预算超限 | `REF_ARGUMENT_BUDGET_EXCEEDED` | 0 |
| Controller 拒绝 / 抛错 | `TOOL_PERMISSION_DENIED` / 可信策略失败固定码 | 0 |
| Worker 当前 binding 变化 | `VIEW_INSTANCE_REVOKED / TOOL_SOURCE_STALE` | 0 |
| SDK 参数校验错误 | `E_INVALID_ARGS`，**不带 payload 回显** | 0 |
| Handler 返回业务 `success:false` | 原样保留真实业务结果 | 1 |
| **请求可能已派发且无可信终态、也不能证明未开始**（超时/IPC 丢包/Worker 退出） | `TOOL_OUTCOME_UNKNOWN`（候选），映射兼容 `OperationResult.success:false`，但语义为 unknown、禁止自动重试 | **未知，不能断言 0** |

不得通过 `catch(error) → String(error)` 把不可信请求或业务 payload 写入 Framework 错误文案。正确分类 transport success:true 与业务 success:false；不自动重试不确定的结果。

## 11. G0–G5 六个独立 Gate（各需单独授权）

### G0 — 设计签署：**已由原设计会话签署，见第 0 节决定**

- 原则上推荐 R2，但需**独立签署**，逐项确认现为候选的错误码、预算、`INIT` 协商字段、`VIEW_TOOL_INVOKE_REF_V1`、终态响应阶段字段及 `OperationResult` 映射；在签署之前不宣称是发布协议。
- 明确批准首批只允许**Tool Schema 恰好一个必填顶层 snapshot-value object Ref**、只读 View-local Tool；已有合法 optional/multi-slot C1 声明仅保留、不开放执行，也不涉及数据写入。
- 冻结**三级能力条件**：声明保留、Host/Worker 同版本协议 ACK、当前 View-owned Tool Binding 所登记的安全 SDK Wrapper；**旧 Wrapper 不可以因为新 Worker ACK 而自动获得执行资格**。
- 冻结 rawArgs 与 effectiveArgs 两套**不同阶段**的校验职责；Controller 审核的是最终有效参数和来源事实，Worker 不重新解释历史 Ref。
- 冻结 `not-entered / entered-returned` 受信终态、无法证明未执行时的 `TOOL_OUTCOME_UNKNOWN`、以及绝不盲目重试的兼容 `OperationResult` 解释。
- 冻结**原 sourceRequest 授权后重新 acquire** 的 TTL 条件（历史 pin 不等于可再授权；当前 Snapshot 可重新 acquire），保留 Worker IPC 非原子 deadline 声明。
- 记录受信 Controller 的身份/资源授权边界、可信 Worker 通道及 SDK Wrapper 元数据发行者的信任假设。
- **G0 已签署；用户转交 W01 时才实施 G1，不自动触发后续工单。**

### G1 — 纯 Core 解析 + 预算 + provenance（默认拒绝状态保持）

- **仅在 G0 签署且本 Gate 单独获得实施授权后**，在纯 Core 增加原始 V2 Snapshot Ref 的精确 owner 解析，产出有界、冻结且脱离外部输入的 `effectiveArgs / refSources`。不引入 Worker IPC、Wrapper 调用、Host 业务逻辑或新 Store。
- 只处理一个受信 Tool Schema 中的**唯一必填顶层声明**：原 `rawArgs` 槽位必须是完整非空 Ref ID string，展开后为 non-null JSON object；普通槽位保留不变。Core 不冒充完整 JSON Schema Validator。
- C1 26-case、旧 Schema 普通成员对照、字面数据跳过与 V1/V2 exact 校验回归不变。
- 覆盖 A→B、最新 Ref 删除仍取历史 A、fd_A/fd_B 同名 Ref、未知 refType、错误 owner、伪造对象、null/scalar/array、数据预算、getter/Proxy 边界。
- **两个 TTL 对照必须分别证明**：①当前 Snapshot 的某个 lease 到期，原 sourceRequest 再 acquire 仍可成功；②已退休历史 Snapshot 超过 history TTL，即使旧 lease pin 住、可从 `getById` 读取，原 sourceRequest 再 acquire 必须失败。且每次复核当前 App/View/Tool，而非以旧 pin 为授权。
- **无新 Worker 执行路径**；旧 Host/Worker 含声明 Tool 的 Handler=0 防线必须保持。本 Gate 独立验收不能被叙述为 Ref 执行 PASS。

### G2 — 版本化 IPC + 三级能力识别 + 结果映射（**尚未打开调用权限**）

- SDK 的声明保留支持、Host/Worker Wire ACK、**当前 Tool Binding 的 SDK Wrapper 安全调用能力**是独立的三项条件；Host/Worker 双端 ACK 不足以开放 Tool。
- Worker 必须能从**受信 Registry 注册信息**核实当前 Wrapper 安全 Ref mode；旧 SDK Wrapper 即使在新 Host + 新 Worker 双端 ACK 情况下仍前置拒绝，Handler=0。未知 Wrapper metadata、旧绑定重挂、失效 bindingVersion 不得降级为旧 Wrapper 或根据 Tool Schema 自证能力。
- 旧 Worker + 新 Host、新 Worker + 旧 Host、**新 Host + 新 Worker + 声明保留旧 SDK Wrapper**、丢失 ACK、未知版本、RESET/Pool 重用、消息重排和直接调用旧 `VIEW_TOOL_INVOKE` 必须 fail closed。
- 真实旧二进制/新二进制/旧 Wrapper 组合另做独立矩阵，不能把字段删去的模拟测试冒充完整旧二进制兼容。
- Worker 验证 Tool/Target/Schema/Provenance 自洽、rawArgs 声明槽位类型、effectiveArgs object 类型、其他槽位值和键集合不变；不重新解析最新 Ref，不开放 Legacy。
- **冻结并实证新的 Ref IPC 可信终态 `not-entered / entered-returned` 向现有 `OperationResult` 的映射**：仅 Host 派发前拒绝或 Worker 明确 `not-entered` 可报告 Handler=0；一旦可能派发、无可信终态且无法证明未进入，则 `success:false + TOOL_OUTCOME_UNKNOWN`（语义 unknown，禁止自动重试）。包括丢响应、超时、Worker 崩溃、错误阶段标记；不新增 Handler-start ACK。
- 没有 G3 SDK 安全回显 Gate 前不得允许 Handler 执行。

### G3 — Controller 审权 + SDK 安全错误边界

- Controller 实际收到的是与 Worker Handler 初始值一致的 `effectiveArgs`，并能审计 `refSources`。
- Async authorize 之后对**相同原 sourceRequest** 重新 acquire，重新确认 TTL/current App/View/Tool；不能仅看已持有的 lease 或 getById。拒绝 Handler=0；Controller throw 固定安全错误；历史 A 绝不替换 B。
- 真正的 SDK Wrapper 必须在受信内部安全模式下验证**展开 object Ref 与普通参数**，不能对 effectiveArgs 重用预展开 string Schema；当前 Binding 必须持有正确的安全模式元数据。
- sentinel + 另一参数非法的 SDK 错误回显测试：响应、framework 自动日志、错误上下文无展开 payload；受信 `not-entered` 证明 Handler=0。
- 保存业务 `success:false`；取消/派发中断依 G2 的可信终态判断，可能进入且无终态时映射 unknown、不得盲目重试。

### G4 — 一条真实 SDK + Node Worker 只读 Ref 端到端准出

- 在临时隔离的真实 App 环境中运行 `View-local Tool + useDataRef + V2 Producer + Store + Controller + 新 IPC + **受信安全 SDK Wrapper** + Handler`。
- 证据区分真实 Worker、受控 transport、纯 Core，不得把 mock 当真实执行。
- 对 S1/A → S2/B、Ref 删除、旧 viewId 重挂、多个同类型 View、**当前安全 Wrapper vs 仅声明保留旧 Wrapper**、TTL/pin 两种边界、Schema 修改、raw/effective 双阶段校验、错误模式、授权取消、派发后丢终态 → unknown 和 all Handler=0 的可信前置拒绝进行可控屏障测试。
- 每次更改后按顺序跑六项现有检查：Runtime/SDK/IDE 各 tsc、Runtime/SDK Vitest、IDE Jest。运行最少 3 次定向稳定性复验。
- 分别统计展开、授权、IPC、SDK Handler 的 p50/p95、峰值 RSS/堆/快照/消息大小；未设或未达预算不宣称产品性能准出。
- 独立验收只可签署 **LIMITED READ-ONLY REF EXECUTION PASS**，不代表 Full M4 / Strict。

### G5 — 后续扩展需另行 RFC

仅在 G4 验证后评估多槽（最多 32）、typed Ref 注册、跨 View/App、entity/写入、Observer Issuer、统一五态 Invocation 和默认 Router 切换。它们属于新的授权范围，不能随 G4 自动开放。

## 12. 兼容性矩阵与历史证据保护

| SDK / 目标 Wrapper | Host / Worker | 新 Ref 执行行为 | 未标注旧 Tool |
|---|---|---|---|
| 旧 SDK / 旧 Wrapper | 旧 Host / 旧 Worker | 不支持新声明 / 新执行模式 | 维持原合同 |
| 新声明 SDK / **仅 C1 声明保留 Wrapper** | **新 Host + 新 Worker，IPC 双端 ACK 成功** | **必须拒绝：当前 Binding 没有安全 Wrapper mode；Handler=0**。此组合是关键新增 Gate | 维持原合同 |
| 新安全 Wrapper | 新 Host + **旧 Worker** | 没有新 Worker 版本 ACK，Host 必须拒绝，无旧 IPC 回退 | 维持原合同 |
| 新安全 Wrapper | **旧 Host** + 新 Worker / 旧消息 | Worker 拒绝含声明 Tool 的旧执行模式；Handler=0 | 维持原合同 |
| 新安全 Wrapper | 新 Host + 新 Worker，但 ACK 缺失 / 版本不一致 / RESET 后失效 | 必须拒绝，不能依赖历史 ACK | 维持原合同 |
| 新安全 Wrapper（绑定到当前 Tool 实例） | 新 Host + 新 Worker，双端 ACK + 新 IPC + Controller 授权 | **仅 G4 独立通过后**可限定开放一个必填顶层 readonly snapshot-value object Ref | 不受影响 |
| SDK/Host/Worker 任意支持组合 | 已派发但无可信终态 | 报告 `TOOL_OUTCOME_UNKNOWN`，不得报告 Handler=0 或自动重试 | 原语义另行保持 |

矩阵验证应区分真实旧 SDK Wrapper / Worker 二进制与模拟缺字段。**新 Host＋新 Worker ACK＋旧 Wrapper** 的拒绝是强制验收项，不是可选兼容测试。

保留已有 C1 `LIMITED_PASS` 和 `NO_GO` 审计事实；原交付证据包不可被新轮次写回覆盖。任何后续实现必须先记录 HEAD、staged/unstaged/untracked 清单、独立指纹；只修改事先批准的文件，不能 `git add/commit/reset/restore/checkout/clean/stash` 或把先前未跟踪源码算作本轮新增成果。

## 13. 风险与未决决策

- **真实二进制协商**：INIT ACK 字段和 feature flag 的最终名称是候选，须验证旧 Worker 的实际响应，不以“新 TS Union 可编译”替代协议兼容。
- **SDK Wrapper 实例级能力**：必须证明 `refExecutionMode` 来自真正执行安全参数校验的受信 SDK Wrapper 注册信息，与当前 Tool Binding、bindingVersion 和 ViewInstance 生命周期绑定；新 Worker 的全局能力 ACK 不能代表每个 Tool Wrapper 已安全。不要增加公开身份，也不能允许 caller/Tool Schema 伪造此事实。
- **Snapshot 到 Worker 的时序和 TTL**：Host 授权后必须对相同原始 sourceRequest 重新 acquire；历史 pin 只能保留数据，不能绕过 history TTL，当前 Snapshot 的过期 lease 不妨碍重新 acquire。Host re-acquire 与 Worker Handler 开始之间仍有 IPC 间隙；只能保证 Worker 活态绑定复核，不得宣称原子 TTL deadline。
- **多源 Snapshot 组合**：首批只选择一份 AppSnapshot V2 和一个 Tool Target，不能假定全 Desktop 跨 App 原子。
- **双参数校验**：rawArgs Ref ID string 是外部输入协议；effectiveArgs Ref object 是内部有效值，不能用同一份 type:string 输入 Schema 再校验对象。Worker 必须证实普通字段的键和值未变，SDK Wrapper 验证有效值并限制 Framework 错误内容。
- **结果范围**：`OperationResult.success:false` 不足以判定业务是否执行；G2 必须冻结受信 `not-entered / entered-returned` 终态及 `TOOL_OUTCOME_UNKNOWN` 映射，派发后无终态只能保守 unknown，不为此新增 Handler-start ACK。与未来 `ActionOutcome` 的五态转换由统一 Core RFC 演进；首批不得用 false success 包装业务失败。
- **日志与隐私**：安全回显 Gate 包括 SDK/Worker/Host 的 Framework 自动日志，不能只测最终返回值。
- **预算阈值**：Wave 2B 的建议值和本 RFC 的 wire cap 为候选工程限制；最终阈值需测量并独立签署，不能称已实测通过。
- **M5 与 Wave 2C 的区别**：之前 `BoundActionExecutor` 处理 versioned Entity source，不能跳过本 RFC 的 snapshot-value 原始历史解析、版本 IPC、SDK 回显 Gate；后续可以复用通用 Invocation 协调机制，但不能同时维护两套权威执行结果规则。

## 14. 本次架构结论

选择 **R2：纯 Core 来源绑定 + 版本化 Ref 执行 IPC + 双端能力协商 + 前置有效参数授权 + 最小 readonly 试点**。

理由不是它代码最少，而是它让 AOTUI 的交互正确性附着在**可独立测试的语义合同**上，而不是某一个 Host、DOM、Worker 消息的偶然行为。

当前决定：**R2 ACCEPTED；G0_DESIGN_ACCEPTED；W01_READY_FOR_HANDOFF；REF EXECUTION / FULL M4 / STRICT 仍 NO-GO。** 本次负责人签署不执行 G1，实施按单独 W01 提示词转交。
