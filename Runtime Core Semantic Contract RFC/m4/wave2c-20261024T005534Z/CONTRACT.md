# Wave 2C — Ref 声明保留与误用拒绝

本批已实现声明保留和拒绝误用，**没有实现 Ref 参数解析或派发**。依据 `independent-wave2b-review-20261023-01/CODEX_WAVE2C_DECLARATION_PROMPT.md` 及用户补充验收意见；方案 A 的历史取值／授权方向保持批准状态，实际执行继续 NO-GO。

## 1. 实际 SDK / SPI

唯一新增的业务声明是：

```ts
refSource?: 'snapshot-value-v1';
```

只允许 View-local `useViewTypeTool`、显式 `isMutating:false`、顶层单值 `type:'reference'` 参数使用。新参数允许的字段仅为 type/required/desc/refType/refSource：required 若提供必须 boolean，desc 若提供必须 string，refType 若提供必须非空 string。constraints/default/itemType/options/额外字段拒绝；数组 Ref、其他 refSource 和非 reference 类型拒绝。

```ts
// 当前已实现的声明写法；它只可观察，不能调用。
useViewTypeTool('inspect', {
  description: 'Inspect the observed summary',
  isMutating: false,
  params: defineParams({
    file: { type: 'reference', refSource: 'snapshot-value-v1', refType: 'File' }
  })
}, async args => ({ success: true, data: { args } }));
```

Legacy 五参数 Hook 使用新声明在注册 effect 前拒绝；直接 AppKernel Legacy 注册也在建立 Registry 项前拒绝。显式 mutating:true 或缺省 mutating 的新声明都拒绝。普通未标注 reference/string、既有 Legacy Tool 保持原语义；不自动迁移已有 reference。

Runtime port 新增一个可选标记：

```ts
readonly refDeclarationSupport?: 'snapshot-value-v1';
```

AppKernel → 已有 AppRuntimeContext → View → ViewRuntimeContext.viewTools 保留该标记。它只说明 Runtime 能验证和保留声明，不说明能执行、不授予权限，也不表示一定有 ready/Strict Snapshot。缺字段／未知值时，新 SDK 在注册前拒绝新用法；未标注用法继续工作。

SDK 没有静态导入旧 Runtime 不存在的新 SPI 值导出，避免所有旧用法在模块加载阶段失效。SDK 的 descriptor 检查只识别声明存在与注册资格；声明的版本／字段／Schema 语义统一由纯 Core 模块验证，不是 SDK 的 dev-only 校验。即使不调用 defineParams，production 注册仍验证。

## 2. 受信任投影与 Schema 子合同

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string",
      "x-aotui-ref": {
        "version": 1,
        "kind": "snapshot-value",
        "owner": "tool-target",
        "refType": "File"
      }
    }
  },
  "required": []
}
```

refType 未提供时，该子合同中不生成 refType。它是参数期望的声明标签，不是 Ref 已匹配的证明。本批没有改 useDataRef/useEntityRef/Ref 注册 SPI，真实 SDK 的 RefDescriptor.refType 仍为 unknown；绝不从参数标签或 Ref ID 前缀补写成 File。

新语义在 `runtime/src/core/tool/ref-declarations.ts`，只依赖已有 JSON 错误类型和 Core 类型，没有 DOM/Preact/Worker/fs/模型依赖。它复用于：

- AppKernel 参数 fingerprint、直接／Legacy 注册边界。
- DOM 适配器的 SDK 参数投影及 Legacy V1 capture 拒绝。
- Core View-owned Registry 登记、活态 invocation。
- V1/V2 Snapshot validator 及 Host 派发前检查。

V1/V2 根、ToolDescriptor/RefDescriptor 的 exact 字段集合和版本号未变化；**inputSchema 新增了明确的版本化语义子合同**，不能说所有 Schema 语义未变。SnapshotIssueCode 只增加 REF_DECLARATION_INVALID / REF_CONTRACT_UNSUPPORTED 两项。V1 不支持该 View-owned 声明；V2 的严格内部验证 proxy 明确传递资格，不把 V1 当作 V2 执行来源。

## 3. 支持语法与拒绝边界

| 位置 | 当前规则 |
| --- | --- |
| SDK opt-in ParamDef | 只支持前述五字段；`refSource` 必须 snapshot-value-v1，不能直接塞 x-aotui-ref |
| 新声明的 Schema 根 | type 必须 object，properties 必须对象；允许 required、description、boolean additionalProperties；拒绝根级 allOf/$ref/$defs 等其他组合 |
| Ref property | 只能在根 properties 的单个内联 property；仅 type:string、可选 string description、x-aotui-ref |
| x-aotui-ref | exact 必需 version/kind/owner，可选非空 refType；version 必须 number 1、kind=snapshot-value、owner=tool-target |
| 错误位置 | Schema 根、嵌套 properties、items、allOf/anyOf、$defs 等位置的保留声明拒绝，不降级为普通 string |
| 普通 Schema | 不带保留声明时，不新增通用 JSON Schema 验证政策，不改既有 root/object/JSON/容量规则；普通 property 的其他语法不被本模块当成完整 Schema 引擎验证 |
| 字面数据 | description 等文本不解析；default/const/enum/examples 的值是数据，不扫描其中同名 key；properties 的 key 是参数名，名字为 x-aotui-ref 不等于声明 |
| caller args／业务 payload | 完全不由声明模块扫描，不因形似链接／Ref ID／标记对象获得能力 |

新子合同是保留语义，旧自定义 Schema 若曾将同名关键字用作其他 Schema 注解，会得到确定性拒绝；这不能被当成“未知关键字可以忽略”。普通字面数据不受这项规则影响。没有增加 JSONPath、通用 Schema 库或 Codec 平台。

## 4. 数据边界、预算与 canonical

新 opt-in 参数投影先用既有 copyJson 严格复制，预算沿用 View-local fingerprint 的 depth 24 /nodes 5000 /approx 64 KiB；不会先读 getter 再校验。SDK options 的 description/params/isMutating 与直接 View-local definition 同样要求自有可枚举数据属性，避免外层 params getter 在复制前运行。SDK 预检保留既有 `Accessors/hidden properties are forbidden` 文案。普通业务 Handler 是回调，未被冻结或改造成 JSON。

Registry 仍严格复制 spec，预算 depth 48 /nodes 10000 /approx 128 KiB；Snapshot 单 Tool Schema 仍为 canonical UTF-8 64 KiB，总 Snapshot/JSON/历史保留额度未放宽。新增 marker/refType 自身消耗预算，超限拒绝，不截断。对于不含新声明的旧参数投影，不强制新增整份参数复制；原有转换行为与未标注 reference 的信息丢失事实保持兼容。

Canonical spec 包含 inputSchema，因此普通 string、opt-in 无 refType、File、Todo 可区分。同 ViewType+ToolName 的冲突在绑定写入前拒绝，没有半注册；等价对象键顺序不会改变 SDK fingerprint。新 opt-in 投影还对自己生成的 required 列表排序，避免仅参数键顺序不同就引发聚合误冲突；未标注旧投影的 required 输出保持原样。这不是对任意直接输入 Schema 做通用语义等价推理。注册／声明变化沿用 bindingVersion；旧来源由已有 source-binding 的 canonical 与 binding 检查失效。

Proxy 反射仍可能执行 trap；这不是恶意 JavaScript 沙箱。元数据要求自有 JSON 数据属性，不承诺支持继承 getter/非 JSON 元数据。没有冻结闭包、任意应用状态或第三方 Hook，没有跨 Worker 原子 deadline 或 Strict 新证明。

## 5. 所有新声明保持不可执行

**Host：** 仍先固定四字段请求、获取同一 Runtime Store 的来源及 lease。取得有效 readonly Tool 后，若其受信任 Schema 包含新声明，就返回 REF_CONTRACT_UNSUPPORTED；不调用 authorize，不发送 invocation。finally 释放 lease。声明可选且 args 中未提供该参数时，也拒绝整个 Tool。

**Worker / AppKernel / Registry：** IPC 未变化。旧 VIEW_TOOL_INVOKE 到达真实 Worker 后，沿原 AppInstance → AppKernel → Registry 检查。Registry 先验证当前 ViewInstance、bindingVersion 和 canonical spec，然后检查**当前注册项**的声明，返回 REF_CONTRACT_UNSUPPORTED，早于 SDK wrapper 和业务 Handler。剥去消息 annotation 不能匹配当前 canonical spec，返回 TOOL_SOURCE_STALE；旧绑定同样拒绝。

所以 raw Ref ID、Markdown、caller 自带对象、空 args 都不能调用新声明 Handler。未标注 Tool 的 Handler 确实继续可执行，SDK 参数失败与 business success:false 保持原语义。没有改变默认 Agent 列表／Legacy Router，View-local UI 的既有 null 行为不变，不新增可调用假标记。

| 路径 | 结果 |
| --- | --- |
| 新 SDK＋无／未知声明标记 port | 注册前 REF_CONTRACT_UNSUPPORTED |
| Legacy Hook／直接 Legacy 注册使用新声明 | REF_CONTRACT_UNSUPPORTED，无注册残留 |
| 新声明配 mutating／default-mutating | REF_DECLARATION_INVALID，无注册残留 |
| 未知版本／kind／owner | REF_CONTRACT_UNSUPPORTED |
| 非法字段／位置／组合／类型 | REF_DECLARATION_INVALID |
| getter／非 JSON／容量超限 | 既有严格 JSON/预算失败；不执行 getter，不截断 |
| 已登记新声明，经 Host 旧入口调用 | REF_CONTRACT_UNSUPPORTED；authorize=0、dispatch=0、Handler=0 |
| 旧 invocation 直接到新 Worker | 活态 Registry 拒绝；Handler=0 |
| annotation 被剥去／旧绑定 | TOOL_SOURCE_STALE 等已有失效码；Handler=0 |
| 普通未标注 Tool | 原 JSON/SDK 参数验证/业务结果语义 |

SDK 注册预检抛固定 Error 文案；Core 使用既有 SnapshotDataError 与上述稳定 code，调用结果用既有 OperationResult。没有读取任意异常的 message/getter 来生成新拒绝文案，也没有增加完整未来执行错误码集合。

## 6. 兼容证据和明确限制

真实 SDK/Worker 测试覆盖支持标记的新 Runtime、V2 保留、Host 拒绝、旧消息直接送新 Worker、剥 annotation、旧来源、普通 Handler 与业务失败。SDK 无／未知 marker 的测试使用真实 Preact/AppKernel，把 port 字段移除／替换来模拟旧 port 合同；**没有运行旧 Worker/Host 版本二进制的完整组合**。直接旧消息试验是旧 invocation 形状的兼容防线，不冒充旧二进制实测。

Ref 解析、effectiveArgs/provenance 授权、Ref 执行 IPC/INIT 扩展、typed Ref 注册、32 bindings／合成 args 预算、跨 View/App/entity/数组/嵌套 Ref 都未实现。Snapshot shadow 保持 unverified /strictEligible:false；只读实验默认关闭。性能、CPU/heap、p50/p95、coverage 均 NOT_TESTED。

未来实际执行前必须闭合用户补充的错误合同：当前 SDK validation error 的 receivedArgs 可能在展开后回显 payload。要用可识别的合成 Ref payload + 另一参数校验失败验证框架错误不回显该 payload，同时保留业务 success:false；应用主动返回的结果另按业务合同处理。本批所有新声明在 SDK wrapper 前拒绝，因此未提前修改 receivedArgs 或建立错误框架。
