# 转发给 Codex：Wave 2C — Ref 声明保留与误用拒绝（不实现 Ref 派发）

用户手动转发本 Prompt；Codex 实施，ChatGPT 独立验收。不要启动其他代理，不要自动进入后续批次。

## 0. 已签署的基线和本批目标

仓库：`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI`。

ChatGPT 已批准 **Wave 2B DESIGN GATE PASS，推荐方案 A**，证据在：

`Runtime Core Semantic Contract RFC/m4/independent-wave2b-review-20261023-01/`

独立重跑：Runtime 71 files / 648 passed / 3 skipped / 7 todo，SDK 10 files / 96 passed，IDE 6 suites / 27 passed；兼容性 5 files / 81 passed；原 R1 0/4、0/10。另以实际 SDK/Worker 证实 reference<File>/reference<Todo> 投影相同、RefType=unknown、caller JSON 不被解析、pin 可读不等于执行来源可重新 acquire。

先核对，不相符就识别差异，禁止 reset/restore：

```text
HEAD = 789ef07cb18084d97b0476c1ffc234ae0b9319f0
staged diff SHA-256 = 258d9b26c2ac0c01d9156553bd3bd775de08ba16330546d65b5bb53b896dcf54
worker-host.ts SHA-256 = 28ede7ca387b143e45cbb9df2da8c779ac9a82d5a22f75931d298a2cdfbbfeee
```

使用现有 Node v24.15.0 / pnpm 10.15.1。Node 24 路径为 `/Users/zhangwei/.local/share/fnm/node-versions/v24.15.0/installation/bin`；可在进程中前置 PATH，不改全局设置，不安装依赖。

**本批目标：声明能够无损进入可信 Snapshot，但尚未支持的 Ref 执行绝不能经旧入口运行。** 这不是通用 Ref 解析上线 Gate。

## 1. 首先读取与审查

先读 `.agents/skills/minimalist/SKILL.md`，再读 Wave 2B 的 CODE_FACTS.md / REF_CONTRACT_PROPOSAL.md / NEXT_MINIMAL_SLICE.md，以及负责人上述独立验收报告。实际代码和测试优先于旧文档。

至少核对 SDK ParamDef/defineParams、useViewTypeTool 的新旧签名、ViewRuntimeContext/View 的 port；Runtime AppKernel 注入的 IViewOwnedToolPort、paramsToJsonSchema、View-owned Registry、Snapshot V2 validator/Store；Host 只读入口、Worker/AppKernel/Registry 到 Handler 的现有链路。

在独立 `m4/wave2c-<时间戳>/` 先记录所有原文件/hash、HEAD/index、批准范围和风险，区分本批改动与用户此前工作树，保留原始日志。

## 2. 本批批准的唯一新业务声明

SDK ParamDef 可增加：

```ts
refSource?: 'snapshot-value-v1';
```

仅在 **View-local Tool、显式 isMutating:false、顶层单值 type:'reference' 参数**上允许。含新声明的 Legacy 五参数 Tool、mutating:true 或缺省 mutating Tool，必须明确拒绝新用法，不静默降级。普通未标注 string/reference、原 Legacy API 保持原语义。

新 opt-in 参数只允许 type/required/desc/refType/refSource。拒绝与 constraints/default/itemType/options 等首片不支持的组合；未知 refSource、空/非字符串 refType、错误字段类型拒绝。校验必须在 production 环境有效，不只依赖 TypeScript 或 defineParams 的 dev-only 检查。

参数投影必须保留为：

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

如 ParamDef 明确提供 refType，必须无损放入 x-aotui-ref 的可选 refType 字段。没有 refType 就不凭空填 File；它表示来源对象保证，不是业务 File 类型保证。

这是**显式版本化的语义子合同**，不是任意可忽略 JSON Schema annotation。ToolDescriptor/RefDescriptor 与 Snapshot V1/V2 根的 exact 字段集合保持不变，不新增平行 refParams，不提高 Snapshot 版本号来规避当前任务。

## 3. 纯 Core 负责语义；SDK/DOM 仅做投影和生命周期

语义校验不能只写进 DOM paramsToJsonSchema 或 SDK 的开发态校验。优先在已有纯 TypeScript Core/tool 模块中复用/增加一个小的内部函数，由 Registry、Producer/validator 与执行端按需复用。

不能让同一声明在四处各实现一份解析器，不引入 DOM/Preact/Worker/Node fs/Provider 到 Core，不建 Codec 平台或新的 Store。

保留关键字只在批准的顶层 property 声明位置有效，exact 校验 version/kind/owner/可选 refType。未知版本、错误位置/组合/额外字段必须被检测并拒绝，不忽略后按普通 string 继续。遇到更复杂 JSON Schema 组合，不增加通用 Schema 引擎：明确首片的支持语法/拒绝边界。不要扫描普通 caller JSON、description 文本或业务 payload 中的同名字串并赋予能力。

在不携带新保留声明的既有合法 Schema 上保持兼容，不整体改写现有 Schema 验证政策。对新声明的 getter/非法 JSON 使用已有 copyJson 数据边界，不执行 getter 后再“验证”。

## 4. 声明能力≠执行能力

允许在 IViewOwnedToolPort 及其现有 SDK Context 链路上传递**一个最小、版本化、仅代表声明保留能力**的可选标记，例如：

```ts
readonly refDeclarationSupport?: 'snapshot-value-v1';
```

可采用这个名字；如选更契合现有代码的名字，要在合同中写清楚，仍必须保持单一小字段，不建泛化 capability registry。缺字段/未知值视作不支持，不能按运行时包名或传入 TypeScript 类型猜支持。

新 SDK + 旧 Runtime（没有声明支持）：注册前拒绝启用新声明，不能在旧投影中丢掉 refSource 后注册成可执行 string Tool。新 Runtime 的直接注册边界也要检查新声明，不能依赖使用者一定通过新 SDK。

新 Runtime 可以保存声明并生成 V2，只代表“可以观察声明”。**不添加 refArguments 执行选项，不添加 VIEW_TOOL_INVOKE_REF_V1，不改变 INIT/Invocation 的公开 IPC Schema。** 不把声明能力标记写成执行支持。

## 5. 本批所有新声明必须不可执行

对携带本声明的 Tool：

- 已验收 Host 只读入口在派发前明确拒绝，不能把 caller 对象/字符串当已解析值；不调用业务授权去暗示已有有效参数，更不发送执行消息。
- 即使绕过 Host 前置拒绝，通过既有可信测试通道发送旧 VIEW_TOOL_INVOKE，Worker/AppKernel/Registry 的活态检查也必须在用户 Handler 前拒绝。
- Worker 的判断不能仅依赖消息中可被替换的 descriptor；新活态注册合同必须参与校验。剥掉旧消息里的 annotation 不能绕过当前 annotated Tool 的 canonical/binding 检查。
- 任何 optional Ref 参数未提供、caller 传入形似已解析对象、原始 Ref ID、Markdown 字符串等都不能把“未实现能力”变成成功执行。声明片一律 Handler=0。
- 未标注 Tool 的已有执行、参数验证和 business success:false 透传不变；默认 Agent 列表/Legacy Router 不增加该新能力或可调用假标记。

只需最小固定错误集合，如 REF_DECLARATION_INVALID、REF_CONTRACT_UNSUPPORTED。未知版本明确 unsupported；不一次加入完整提案的所有未实现错误码，也不读取任意异常的 message/getter 制作错误结果。

## 6. Canonical 合同必须真正包含语义

新声明从 SDK → Runtime Registry → ToolDescriptor.inputSchema → Snapshot V2 应完整保留。

以下情况应可区分且沿用既有冲突/失效机制，不新增身份系统：

- 未标注 string 与 opt-in snapshot-value reference。
- opt-in 无 refType / refType=File / refType=Todo。
- refSource/保留版本/owner/kind 不同（不支持的直接拒绝）。
- 同 ViewType+ToolName 下声明冲突应原子拒绝注册，不留半成品；等价键顺序不应导致无意义重注册。
- 有效声明变化应影响原绑定版本/规范化比较；旧来源不应自动获得新声明能力。

复用已有 ViewInstanceId、bindingVersion、canonicalJson、copyJson、Source Lease/Store，不新建 Ref 身份、第二份声明表或第二份 Snapshot Store。

## 7. 强制测试矩阵

先写能表现缺失声明/误执行风险的反例，再做最小修复，保留真正红绿日志。至少覆盖：

1. 新声明合法投影、可选 refType 完整保留、getter/类型/版本/组合/错误位置拒绝；production 校验仍有效。
2. 旧未标注 reference/string 的行为保持 Wave 2B 探针的现有事实，不为了新语义修改这些旧断言。
3. Registry 真实 canonical 聚合冲突与无部分注册、等价顺序、旧 binding 失效。
4. 新 SDK/真实 Preact + 支持标记 Runtime 可注册；无标记的旧 Runtime port 拒绝，cleanup 后没有残留 Tool。Legacy 五参数误用新 opt-in 明确拒绝。
5. 新 Host/Worker 的**真实** V2 Snapshot 保留声明；Host 拒绝且用户 Handler=0。
6. 旧 invocation 直接到新 Worker、新消息剥掉 annotation、旧来源注册变化等，用户 Handler=0；同时正常 unannotated Tool Handler 确实可执行。
7. 不修改 IPC 前提下的新旧能力组合：没有声明能力不能静默降级；旧 Host 即使忽略 annotation，新 Worker 仍拒绝旧执行模式。测试事实层次标清楚，mock port 不冒充完整旧 Worker 二进制实测。
8. 沿用既有 JSON/Schema 容量预算，不放宽限额；新增声明计入 Schema/Registry 的字节/节点限额，超限拒绝而非截断。32 bindings/合成 args/provenance 预算留待实际执行批次，不本批提前实现。
9. 已批准 Wave 2A 和 R1 所有回归、原两个 R1 独立脚本持续通过。

所有文件写入测试仅 mkdtemp。不得新增 skip/todo、下调 TypeScript/测试约束或偷偷改既有断言。真实 Worker 专项至少 3 轮，优先 Promise/event gate，不用 sleep 掩盖时序。

## 8. 全量命令与工作树保护

严格禁止 git add/commit/reset/restore/clean/stash/checkout/push/rebase，不启动其他代理，不安装依赖，不调用模型服务，不触碰 Mobile/Agent Driver/业务用户文件。

保存起始 HEAD/index/worktree 指纹及 tracked/nonignored 文件清单；保存用户此前 modified/staged/untracked 和所有旧审计材料。发现基线不同先报告，不自动恢复。

依次真实执行并保存原始输出/退出码：

```sh
pnpm --dir runtime exec tsc --pretty false
pnpm --dir sdk exec tsc --noEmit --pretty false
pnpm --dir demo-apps/aotui-ide exec tsc --noEmit --pretty false
pnpm --dir runtime exec vitest run --reporter=dot
pnpm --dir sdk exec vitest run --reporter=dot
pnpm --dir demo-apps/aotui-ide exec jest --runInBand
```

TypeScript 生产配置对测试文件的排除必须在证据中说明，不夸大为全部测试源码经过 tsc。未运行性能/覆盖率标 NOT_TESTED；不能用运行耗时当产品 p95。

## 9. 本批绝对不实施的内容

不调用 store.resolveRef 来展开 Tool 参数；不从 string/Markdown/URL/普通对象猜引用；不增加 effectiveArgs/provenance 的授权模式；不把 entity 当可读取资源；不扩展 typed useDataRef 注册 SPI；不新建 cross-View/array/nested Ref 解析；不批准新 IPC 模式；不切换默认 Agent Router；不开放写入；不改变 Shadow unverified/strictEligible:false。

未来真实执行的方向已经选定：固定来源历史 A→有效参数 A→授权 A→原来源复核→Handler A，不能偷偷换成最新 B。但那个执行合同必须另批，不能借此 Prompt 实现。

## 10. 交付和停止点

在新 `m4/wave2c-<时间戳>/` 交付：

- CONTRACT.md：实际声明/API/SPI、保留关键字语法、版本、默认值、兼容矩阵和所有拒绝路径。
- CODEX_WAVE2C_RESULTS.md：实际变更、原因、取舍、失败轨迹、尚未实现的执行能力。
- GATE_STATUS.json：每条真实命令、exitCode、测试统计、三轮结果、index 保护、NO-GO/NOT_TESTED。
- source-fingerprints.json、起始只读基线、相对本批起始工作树的增量 patch。
- 全部原始红绿/全量/稳定性日志；NEXT_MINIMAL_SLICE.md 只能建议下一步，不能批准执行。

结束仅申请“Wave 2C 声明保留与误用拒绝 LIMITED PASS，等待 ChatGPT 验收”。**停止；不得继续实现 Ref 解析派发或自行进入下一阶段。**
