# Wave 2B — 只读 snapshot-value 参数合同提案

**状态：仅供架构验收，以下新增字段、模式、错误码和 API 都未实现。** 本批没有改变任何生产执行链。推荐以受信任声明确定可解析位置，以固定来源 Snapshot 提供历史值；不根据字符串样式或业务对象猜测引用。

## 1. 要解决的问题与范围

Wave 2A 已固定“调用哪个 View 的哪个 Tool”。这里补的是“这个参数的值从哪里来，Controller 批准了什么”。目标是：Agent 在已观察的 View 中选择 Ref，Runtime 传递**那次观察的 JSON 值**，Controller 能在派发前看到值和可审计的来源。

首个可执行合同只包含目标 View 自己的 `snapshot-value`，先支持顶层、单值 reference 参数，payload 限非 null JSON object，以匹配当前 SDK reference 的对象推断和验证。拒绝数组／嵌套 Ref 绑定、scalar/null/array payload、entity、跨 View/App 以及读当前资源的解释。普通 object/string 参数不受 Ref 解析影响。这是明确缩小的首片，不宣称已经支持 Core 中所有合法 JsonValue。

## 2. 三种最小技术选择

| 维度 | A. 声明限定位置 + 原始 Ref ID（推荐） | B. 声明限定位置 + 显式 Ref 输入标记 | C. Controller 提供已解析值和来源事实 |
| --- | --- | --- | --- |
| Agent 输入 | 已声明位置填 `"file"`，精确 Ref ID | 已声明位置填版本化对象，如 `{"$aotuiRef":{"version":1,"id":"file"}}` | Agent JSON 先交给 Controller；Controller 构造值及 provenance |
| 权威信息 | Runtime Store 中 Tool 的版本化参数声明 + 同 Snapshot 的 RefDescriptor；live Registry 复核公开合同 | 同 A；**caller 标记本身没有权威性** | Controller 的可信配置／代码成为参数位置和来源映射的权威；若 Runtime 不复核，它只能是 Controller assertion |
| 当前信息是否足够 | 不够。reference/refType 在 Tool 投影处丢失，须补声明 | 同样不够，不能靠 marker 跳过权威声明 | 可写专用 Controller 读取现有 Store，但它必须自备位置定义、校验和 provenance，不能称现有通用能力 |
| DX | Agent 提取链接目的 Ref ID；开发者在已有参数定义加一个显式 opt-in；不增加 selector 对象 | 输入更显式，适合将来 literal/ref 二选一；但要教 Agent 一套对象格式和版本 | 业务适配快；应用作者与 Controller 维护两份映射，易漂移，通用框架体验较差 |
| Schema／API | 新参数声明和版本化 inputSchema 子合同；新调用模式与授权 scope，原四字段请求不变 | A 的变更外，还需标记的 exact shape、预算及错误定义；不放进未声明字段 | 需要独立可信输入接口和明确类型；可不改 SDK，但把长期框架语义放到每个 Controller |
| IPC／兼容 | 执行阶段须显式版本化模式和双方支持检查；现有 unannotated 调用继续原样 | 同 A，标记只在 Host 解析，不让 Worker 再按最新值解码 | 若只是 Controller 自己授权后发送普通值，可沿用现有 IPC，但 Handler 无法据此声称通用 Ref provenance；若要 Runtime 保证，仍需要版本化事实和复核 |
| 授权时点 | 固定请求 → 获取来源 → 解析并预算 → Controller 看有效值与来源 → 同来源再检查 → Worker live check | 同 A，严格 marker 解析在授权前 | 必须在 Controller 最终值确定后授权；Runtime 若接收 claims，须再次从 Store 验证，不能只信传入的 snapshotId 字符串 |
| 预算／错误 | 对原请求、有效 args、provenance 分层计费，缺声明/Ref/owner/type/kind/预算等确定性拒绝 | 同 A，加标记对象节点、未知字段/版本错误；不支持任意 JSONPath | Controller 输入和输出仍要限额；重复解析与比对成本更高。无法验证的来源应拒绝或明确降为普通已授权 JSON |
| 主要改动位置 | SDK ParamDef/投影；Host 来源与 policy；Worker/AppKernel 模式防误用；版本化 IPC。复用 Store/Registry/copyJson | 同 A + 输入标记解码；无须新 Codec 平台 | Controller 适配器 + 可信接口/预算/审计；要提升为 Runtime 合同最终仍会接近 A |
| 优点 | 最少输入概念，声明和 Handler 同属 View，现有 identity/lease/canonical Schema 检查可复用 | 明确区分 literal 与 reference，未来扩展输入表达更容易 | 适合少量专用 Host，授权业务逻辑集中，暂不依赖 SDK 元数据演进 |
| 缺点 | 不能从现有普通 string Schema 自动恢复；新增模式必须版本化；现有 SDK unknown 不能伪装成 File 类型 | 比 A 多一种对象语法，当前仅 Ref 输入时没有额外收益；marker 也不能解决声明缺失 | 重复声明，信任面移到 Controller；Handler 作者难以仅凭 SDK 声明理解合同 |

选择 A：首片不需要同时支持 literal/reference 的联合输入，原始 Ref ID 足够。B 的区分能力可以等真实需求出现再提案；C 保留为专用 Controller 的做法，不把它冒充 Runtime 已验证来源。三者都不需要新 Store、身份体系、注册平台或通用 JSONPath/Codec 框架。

## 3. 推荐的最小声明演进（提案）

在现有 ParamDef 增加 **`refSource?: 'snapshot-value-v1'`**。只有 `type:'reference'` 且明确写该值，才声明本合同的位置；旧 reference 声明保持 Wave 2A 普通 JSON 语义。首片仅顶层单值，不支持数组 itemType reference，不递归扫描 object 或额外字段。

该 opt-in 参数允许 type/required/desc/refType/refSource；首片不接受 constraints/default/itemType/options，避免把 Ref ID 的字符串约束错误套到展开的对象上，或隐含填入未授权默认值。普通参数继续现有规则。

**提案 Schema** 在该 property 的 inputSchema 中使用封闭、带版本的保留关键字：

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string",
      "x-aotui-ref": {
        "version": 1,
        "kind": "snapshot-value",
        "owner": "tool-target"
      }
    }
  },
  "required": ["file"]
}
```

`type:'string'` 描述 Agent 的输入 Ref ID；Handler 的值经过授权前的解析。`x-aotui-ref` **是需要批准的新语义子合同**，不是目前已经生效的 JSON Schema 关键字。必须 exact 校验其字段/版本、合法位置和组合；未知版本或未支持能力 fail closed，不交给某个 JSON Schema 库默认忽略。

如声明写了 refType，将非空 refType 同样纳入该关键字并作精确相等检查：source Ref 的 unknown 不能满足 File；名字前缀、payload.id 或 entityType 不得填补未知类型。即使 tag 相等也只是声明分类，不能替代 payload 业务形状校验或权限。

**首片建议不要求业务 refType**，而是明确提供“来自该 View 的快照 JSON 对象”这一保证。当前 useDataRef 无类型注册信息，所以示例不写 File 类型约束。需要 typed File 的应用应在这一片明确拒绝 unknown，等单独批准 Ref 注册 SPI/SDK 元数据演进，不能偷偷从 `File:file` 字符串解析类型。

V1/V2 顶层、ToolDescriptor 和 RefDescriptor 的 exact 字段集合保持不变。本方案利用 inputSchema 已有的 JSON 容器提出一个**显式带版本的子合同**，不是往 V2 exact envelope 塞 refParams。当前 validator 对 inputSchema 只检查 JSON/object/预算；能保存扩展 JSON 不代表已经验证或执行该扩展。架构负责人若不接受 Schema 内的保留关键字，应另批 Snapshot 新版本；本批不会擅自选择或放宽 exact 校验。RefDescriptor.refType 已有字段，无须为首片另造 Ref 身份。

## 4. 完整调用合同（提案，未实现）

1. **模式明确。** 可信 Controller 显式选择 `snapshot-value-v1`；默认不开。现有四字段请求保持不变，不让 Agent 多传内部 viewInstanceId 或任意来源对象。声明本合同的 Tool 在模式未提供或能力不支持时拒绝执行，避免 Handler 收到 caller 对象却以为有来源证明。旧 unannotated Tool 继续原调用路径。
2. **固定请求。** 使用现有 copyJson 在 await 前固定完整 snapshotId/toolId/viewId/args；既有 getter、JSON、selector 和预算规则保持。此后不读 caller 对象。
3. **取得原来源。** 复用 acquireToolSource，必须是同一个 Runtime Store、V2、当前 AppInstance、确切 Tool target；持有该 selection lease。不能信 caller Tool JSON，不能选“最新同名 Ref”。
4. **只解析声明位置。** 从来源 Tool inputSchema 读取受信任版本化声明。必填缺少、null、已解析对象或非字符串输入拒绝；可选字段缺少则不绑定。Ref ID 必须非空字符串，作为**完整 ID 原样比较**，不 trim/拆前缀/解析 Markdown/URL/索引表达式/JSONPath。`[File](file)` 本身不是 ID `file`；除非它真是该 View 注册的完整 ID，否则 REF_NOT_FOUND。
5. **锁定 owner。** 每个 selector 的 snapshotId/appId/instanceId 来自固定 selection，viewId/viewInstanceId 来自 selection.target；仅 refId 取该声明位置的输入。Agent 不提供 owner。`resolveRef` 之后必须要求 kind snapshot-value、精确 owner，以及可选 refType 匹配；entity 一律拒绝，不读取磁盘或其他资源。
6. **形成有效参数。** 每个绑定位置用该来源 snapshot-value payload 替换；首片 payload 必须为非 null JSON object。普通字段与额外字段保留为固定的 caller JSON，完全不扫描 marker。对合成的整体 args 重新执行现有严格 copyJson/预算，得到一份脱离来源、深冻结的有效参数。不要冻结 Registry/业务闭包。
7. **形成来源事实。** 在 args 外建立冻结的 refSources 列表，记录 param/refId/refType/kind；全局 scope 记录 snapshotId/appId/appInstanceId/toolId/viewId/viewInstanceId/bindingVersion。全部由 Store selection 派生，不从 caller 的同名字段采纳。一个调用只有一个来源 Snapshot 和目标 View，不允许 bindings 自带第二个 snapshotId/owner。
8. **授权。** Controller 一次看到最终 `scope.args` 和 `scope.refSources`，连同目标及来源实例；只有 true 放行。Handler 初始接收的 JSON 值必须与这份 args 一致，不可授权后再做资源对象替换。Controller 仍需审查业务 shape、数据访问权限和普通 args 中的路径/id；快照有效、类型匹配、isMutating:false 都不授予业务资源读取权。
9. **授权后再检查。** 沿用 Wave 2A 的 Host 状态检查，重新 acquire **原** sourceRequest；失败即不派发。历史 snapshot-value 仍取之前确定的历史值，不因新 Snapshot 替换。App close/error/RESET、Tool/View 当前失效不能被旧 pin 洗白。所有 lease 在 finally 释放。
10. **Worker 活态防线。** 执行模式必须在 IPC 中可识别，Worker 验证其支持、当前 App 实例、只读 opt-in、Tool/target/binding/声明，以及声明位置与 refSources 一致，才调用现有 Registry/SDK wrapper/Handler。不得再访问 Worker 的最新 Ref Registry 解码。只有 Host 拥有原 Store；Worker 对 provenance 的信任来自已建立的可信 Host 通道，不是假装自己持有另一份可信 Snapshot Store。跨 Worker 只保证 Handler 入口初始 JSON 值与授权值一致；structured clone 不保留冻结标志，不能把可信 Handler 对其本地副本的修改说成被禁止。
11. **结果。** 保留 SDK 参数验证与业务 OperationResult；transport success 不代表业务成功。前述拒绝路径 Handler 调用次数须为零。Handler 开始后通信失败、异常或取消不证明“没执行”，不自动重试，不承诺 exactly-once／回滚。

### 历史值决策

推荐 **Ref-only A→B 更新后仍传历史 A**，条件是来源仍可 acquire、目标 View/Tool 当前仍合法、Controller 明确批准 A。Ref 从最新投影移除也不会抹掉历史 A；撤销执行能力应通过 Tool/View 生命周期或 policy，而非用最新 Ref 偷换输入。

理由：snapshot-value 描述一次观察值，Core 已提供不可变历史；Ref-only/展示更新不应与 Tool-only 更新混为一谈。若操作需要“当前对象”，它属于另一种有资源版本/读取权限的合同；不能悄悄把 snapshot-value 升级成 latest entity。Controller 可以因业务需要拒绝历史观察，但只能明确拒绝，不能替换成 B 后沿用对 A 的批准。

### TTL 不变

数据读到 ≠ 执行来源有效。即使最初 pin 未释放，历史保留 TTL 到期后，授权后重新 acquire 也必须失败；resolveRef 能读到 A 不能替代这一步。当前 Snapshot 在一个 lease 到期后仍可能重新 acquire，按现有 Store 合同处理。检查发生在 Host 派发前，不声称跨 Worker 队列或 Handler 开始时的原子 deadline；此提案不能因此得到 Strict。

## 5. 预算与确定性错误（提案）

预算必须分三层，不能凭 refId 很短就允许任意展开：

| 阶段 | 规则 |
| --- | --- |
| 原始请求 | 保留现有完整请求 25/10004/136 KiB approx；原 args 24/10000/128 KiB approx，拒绝在授权前 |
| 有效 args | 从**合成 args 根**计 depth/nodes/每次出现的字节；复用 24/10000/128 KiB approx，再检查 canonical UTF-8 不超过 128 KiB。Snapshot 单 payload 512 KiB 不是 Tool 参数额度；多 Ref 指同一值必须逐次计费并复制，不用对象 identity 去重抵扣 |
| 来源事实 | 一个参数至多一条，数量不超过已声明且实际提供的顶层 slots；建议首片显式上限 32 条（提议，非性能实测结论）。有效 args 与 provenance/来源 scope 合计另限 136 KiB canonical UTF-8，元数据也计节点/深度；建议整体 copy 上限 depth 26/nodes 11000/approx 136 KiB。任何一项不足整体拒绝，不截断绑定、不只授权前 N 个 |

上述新增 32 条、合成 envelope 以及 canonical args 阈值需要实施前批准和边界测试，**本批没有宣称已执行这些限制**。这不是总 IPC 包的内存或产品 SLA：Tool Schema/targets、JSON 反射、canonical 编码、structured clone 及返回值还有自己的成本，性能尚未验证。先复用已经有界的来源 refs 和原请求构造浅层候选 args，再让 copyJson 有界复制；不要先复制所有大 payload、分配巨大中间字符串后才检查预算。

| 拒绝点 | 提议结果；已存在的沿用原码 |
| --- | --- |
| 入场关闭／非 running、输入非 JSON／getter／超原预算 | 保留 TOOL_UNAVAILABLE / OPERATION_INVALID_ARGS |
| 来源不可 acquire、App/View/Tool 已失效 | 保留 SNAPSHOT_EXPIRED / SNAPSHOT_UNREADY / APP_INSTANCE_MISMATCH / VIEW_INSTANCE_REVOKED / TOOL_UNAVAILABLE / TOOL_SOURCE_STALE 等 |
| 未支持版本、声明未知字段或不合法组合 | 新 REF_CONTRACT_UNSUPPORTED / REF_DECLARATION_INVALID；注册/调用拒绝，不能降级猜测 |
| 新声明 Tool 被旧参数模式调用 | 新 REF_ARGUMENT_MODE_REQUIRED；不接受 caller 对象冒充已解析值 |
| 声明位置输入缺失／对象／空 ID／数组等 | OPERATION_INVALID_ARGS，指出参数名而不输出 payload |
| 来源无 Ref | 保留 REF_NOT_FOUND；不回退 B/ViewType/global/latest |
| 错 owner、跨 View/App 选择 | 保留实例错误或新 REF_SCOPE_DENIED；首片没有跨域 selector 输入 |
| target 为 entity、未知业务类型不匹配、payload 形态不支持 | 新 REF_TARGET_UNSUPPORTED / REF_TYPE_MISMATCH / REF_VALUE_UNSUPPORTED；不把这些说成现有 resolveRef 已执行的判断 |
| 展开或 provenance 超预算 | 新 REF_ARGUMENT_BUDGET_EXCEEDED；拒绝整个调用且不运行 Handler |
| Controller 非 true／throw | 沿用 TOOL_PERMISSION_DENIED / VIEW_TOOL_DISPATCH_FAILED 的固定错误边界，不读任意 throw 值的 message |
| SDK/业务失败 | 保持 E_INVALID_ARGS／业务原 OperationResult，不包装成成功 |

错误不输出业务 payload 或文件内容，不把输入对象的 message/toString 当安全错误文案。JSON 反射仍可能执行 Proxy trap，不宣称 JS 沙箱。Handler 和闭包是可信应用代码；只读声明不能阻止它自行 I/O。

## 6. 理想 SDK 与端到端示例（全部为提案 API）

```tsx
// 提案 API：refSource 尚不存在；其余写法用于展示理想 DX。
// 本组件在 <View id="fd_A" type="FileDetail"> 内使用。
function FileDetailContent({ summary }) {
  const file = useDataRef('file', summary);
  useViewTypeTool('describe_file', {
    description: 'Describe the file summary from the observed View',
    isMutating: false,
    params: defineParams({
      file: { type: 'reference', required: true,
              refSource: 'snapshot-value-v1' },
      question: { type: 'string' }
    })
  }, async ({ file, question }) => {
    // file 是已批准来源中的 JSON object 历史值；没有读取磁盘的能力。
    return { success: true, data: { summary: file, question } };
  });
  return <p>{file('File summary')}</p>;
}
```

```ts
// 提案 API：第三个选项和扩展 scope 尚不存在。
// Agent 从已观察的 Snapshot 选择 App/View/Tool，参数只写 Ref ID。
await host.executeReadOnlyViewTool({
  snapshotId: observedSnapshotId,
  toolId: observedToolId,
  viewId: 'fd_A',
  args: { file: 'file', question: 'What changed?' }
}, scope => {
  // args.file 是来源的历史 payload，不是原始 'file' 字符串。
  // scope 全局含来源 Snapshot/AppInstance/Tool binding，refSources 指出参数来源。
  return controllerAllowsSnapshotSummary(scope.args, scope.refSources, {
    snapshotId: scope.snapshotId, appInstanceId: scope.appInstanceId,
    viewInstanceId: scope.viewInstanceId, bindingVersion: scope.bindingVersion
  }) === true;
}, { refArguments: 'snapshot-value-v1' });
```

例：来源 S1/目标 fd_A/内部 vi_A 中 file={name:'A'}；fd_B 自己也有 file={name:'B'}。Runtime 只为 fd_A 从 S1 取 A，scope.refSources 是 `[{param:'file',refId:'file',refType:'unknown',kind:'snapshot-value'}]`，scope 的公共来源字段指定 S1/vi_A。授权后 Ref-only 更新为 A2，只要同一 Tool 来源仍有效，派发的 args.file 仍为 A。fd_A 卸载重建为 vi_A2、TTL 到期或 Controller 拒绝，则 Handler 不执行。Agent 无须知道 vi_A。

## 7. API／Schema／IPC 兼容计划

不能仅在旧消息里塞一个可被忽略的字段，然后声称旧 Worker 已理解新模式。完整执行阶段推荐单一、版本化的新消息变体 **`VIEW_TOOL_INVOKE_REF_V1`（提案）**，复用现有 invocation 实现，携带既有 tool/target/args，附 snapshotId/refSources。它不是第二个执行器，不持有第二份 Snapshot，不产生新身份。双方需明确支持该模式；未支持时在派发前拒绝，不能自动退回旧 VIEW_TOOL_INVOKE。

支持信息应由可信 Runtime 在初始化/既有 View Tool port 明确提供（版本化能力字段，名称待接口审阅）。新 SDK 在 Runtime 不支持时拒绝启用 refSource 声明；Worker 在旧消息调用含该声明的 Tool 时拒绝；Host 旧模式也拒绝新的声明。这样普通 caller object 不会被误当有来源值。**这涉及 SDK/SPI、IPC 初始化和 invocation 的变更，必须另批；本批均未实现。** 不以 worker 生命周期内部序号充当 Ref 身份或授权 token。

若负责人选择不新增 IPC，需要另证明：模式不会被旧 Worker 忽略、旧入口不能把新声明当普通 reference、且 Controller/Handler 的 provenance 边界仍成立。在证明前，执行 Gate 为 NO-GO；仅“现有 args 能装对象”不足以批准无版本演进。

Legacy 五参数 API 与 unannotated 新 Hook 保留旧行为；不改变默认 Agent Router、既有只读 opt-in 默认值、mutating Tool 阻断或 Shadow unverified/strictEligible:false。已存在的 reference 声明不自动获得新能力，也不被全仓迁移。

## 8. 下一批最小可实施切片及批准项

推荐下一批先做**声明保留 + 明确拒绝误用**，仍不开放 Ref 执行，避免把声明、授权扩展和 IPC 同时混在一个 Gate：

1. 批准 SDK ParamDef 的 refSource opt-in 与 inputSchema 中 `x-aotui-ref` V1 exact 子合同；投影保留类别/可选 refType，做 canonical 聚合冲突及 unknown version/组合/预算测试。原 string/reference 投影保持原行为。
2. 新声明暂不派发：建议在已支持新声明的 Runtime 中保留声明供 Snapshot 观测，同时明确“不支持执行”；Host/Worker 现有只读路径对新声明返回 REF_CONTRACT_UNSUPPORTED/REF_ARGUMENT_MODE_REQUIRED。旧 Runtime 没有声明支持信息时，新 SDK 在注册前拒绝启用 refSource。原 unannotated 行为不变。用现有 SDK/Worker 验证拒绝路径 Handler 次数为零，不做静默降级。
3. 预计最小触碰范围：`sdk/src/operation/types.ts`、`useViewTypeTool.ts`（能力检查）、`runtime/src/spi/runtime/view-owned-tools.interface.ts`（能力声明）、`AppKernel.ts`（注入能力/注册）、`dom-snapshot-producer.ts`（投影）、Host/Worker 的新声明误用拒绝、必要测试。复用现有 Schema/Registry/Store；不改 Snapshot exact envelope，不增加实体资源解析。

下一批需要批准的是**声明子合同/API/SPI 和拒绝新能力误用**；IPC 仍不变，也不增加可执行模式。之后才可独立审批上节版本化 IPC/能力协商、扩展 authorize scope 和单个顶层 Ref 的实际解析。若负责人希望合并执行切片，也应先批准完整版本化接口，再实施；本包不替负责人决定批准。

完整执行批准前至少还需：真实 SDK+双 View Worker 的来源取值/历史更新/重挂载/TTL/授权等待测试；所有拒绝 Handler=0；有效参数与授权值一致；重复 payload/深度/节点/metadata 预算边界；旧协议拒绝、新协议协商、错误不重试及六项回归。性能、完整 M4、Strict、默认 Router 切换和可写开放继续未准出。
