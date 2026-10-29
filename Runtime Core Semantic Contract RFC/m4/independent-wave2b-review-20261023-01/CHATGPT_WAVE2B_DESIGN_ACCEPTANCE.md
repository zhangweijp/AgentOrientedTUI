# ChatGPT 独立架构验收 — Wave 2B Ref 参数设计

日期：2026-10-23。验收对象：`m4/wave2b-20261023T144207Z`。验收负责人：ChatGPT；执行实现者：Codex；用户手动转发下一批 Prompt。

## 1. 签署结论

**Wave 2B DESIGN GATE PASS。推荐方案 A 获得架构批准；Stage 8 R1 保持 CLOSED，Wave 2A limited PASS 保持有效。**

批准的是设计决策与下一批“声明保留 + 误用拒绝”的最小实现范围，**不是批准真实 Ref 参数解析和派发**。当前没有任何新的 Ref 执行模式、provenance 授权或版本化 invocation 被实现或准出。完整 M4、Strict、默认 Agent 路由切换、可写 Tool 开放均继续 NO-GO。

本次没有启动 Codex 或其他代理，没有修改生产源码、原测试、旧交付包或 Git index；仅在本独立审计目录写入审计材料，运行测试会产生仓库既有忽略规则覆盖的构建产物。

## 2. 独立核验结果

### 2.1 交付及工作树完整性

核对了 1204 个交付前基线路径（其中 22 个在基线时已缺失），没有发现内容或缺失状态改变；2 个新增测试文件、18 个生产源码锚点、31 个附件指纹和 15 份运行日志均与交付匹配。200 个旧 Stage 8/R1/Wave 2A 及独立审计证据路径未变。

HEAD：`789ef07cb18084d97b0476c1ffc234ae0b9319f0`。

暂存区 SHA-256：`258d9b26c2ac0c01d9156553bd3bd775de08ba16330546d65b5bb53b896dcf54`。

已验收 Host SHA-256：`28ede7ca387b143e45cbb9df2da8c779ac9a82d5a22f75931d298a2cdfbbfeee`。

生产差异为零。增量 patch 只包含新增 Runtime/SDK 测试与本批设计文档，没有偷偷修改已验收执行链。最初 Runtime 探针的 51/52 字节错误属于新测试编写错误，原失败日志保留；它不是产品代码修复的红绿证据。

### 2.2 我实际重跑的验证

临时使用已安装 Node v24.15.0 / pnpm 10.15.1，不更改全局环境。六项全量按顺序执行，再执行兼容性和两个原始 R1 脚本。

| 检查 | 独立实际结果 |
| --- | --- |
| Runtime TypeScript emit | exit 0 |
| SDK TypeScript noEmit | exit 0 |
| IDE TypeScript noEmit | exit 0 |
| Runtime Vitest | 71 files，648 passed / 3 skipped / 7 todo |
| SDK Vitest | 10 files，96 passed |
| IDE Jest | 6 suites，27 passed |
| 定向兼容性 | 5 files，81 passed，exit 0 |
| 原真实 Worker R1 脚本 | 0/4 违规，exit 0 |
| 原受控 transport R1 脚本 | 0/10 违规，exit 0 |
| 独立实际 SDK/Worker Ref 元数据探针 | exit 0，见下一节 |

共 10 次独立验证命令，全部取得完整输出且 exit 0。没有将此前日志计为本次运行结果；没有额外声称本次做了三轮稳定性、性能或覆盖率测量。

### 2.3 额外的真实 SDK/Worker 验证

新增审计脚本 `ref-projection-observation.mjs` 使用临时应用、真实 SDK 挂载、真实 Worker、现有 Core Store 和受控时钟；不向生产目录写测试，不实现提案解析器。

它直接证实：

- fd_A 的 `reference<File>` 与 fd_B 的 `reference<Todo>` 可以聚合成同一个公开 Tool，因为两者最终的参数 property 都只剩 `{type:'string'}`。
- 两个真实 SDK Ref 的 V2 `refType` 都是 `unknown`，但 owner/viewInstanceId 正确区分 A 和 B。
- 原始 `file` 字符串或 caller 自带对象仍原样进入已选择的 Handler，不自动变成有出处的业务对象。
- Ref-only 更新前的旧 Snapshot 保留 version 0，新 Snapshot 为 version 1；Tool binding 保持不变。
- 已 pin 的历史 Ref 到期后仍可读取；新的 acquire 和只读执行请求返回 SNAPSHOT_EXPIRED，没有增加 Handler 调用；释放后 activeLeases 为 0。

这提高了“现有信息不足”和“历史值/执行资格分离”的事实证据层次，但**不是新 Ref 解析的端到端实现证明**。

## 3. 架构决策：批准 A 的理由及长期含义

选择 A：**受信任声明决定参数位置，原始 Ref ID 决定来源 Snapshot 内的确切条目，Runtime 生成有效参数和来源事实，Controller 批准同一份有效值。**

B 的显式输入标记不能替代参数声明，它只在同一位置未来确实需要 literal/ref 联合输入时提供额外价值。当前没有必要让 Agent 学习第二套对象语法。C 适合少量可信专用适配器，但不宜成为框架默认语义，否则 Handler 作者与 Controller 长期维护两份参数映射。

`viewId / viewType / viewInstanceId` 和已有 bindingVersion 保持原角色，不新增 Ref owner identity、独立引用 Store、JSONPath 系统或通用 Codec 平台。Ref 参数合同不能仅由 DOM adapter 定义：声明的语义校验应为可被 Registry、Host、Worker 复用的纯 TypeScript 逻辑，SDK/DOM 负责投影和生命周期。

## 4. 本次明确批准的设计约束

### 4.1 历史值 A 不悄悄改成最新 B

若来源 S1/目标 vi_A 中 file=A，之后同一 View 的 S2/file=B：只要 S1 仍可 acquire、当前 View/Tool binding 合法、Controller 批准 A，未来的新模式应传 A。Controller 可以拒绝历史值，但不能批准 A 后把实际执行参数换成 B。

最新 Ref 被移除不会自动抹除已保留的历史值；撤销需要通过 policy、Tool/View 生命周期或明确的数据撤销合同。历史查询能力不等于执行授权。授权后仍须 acquire 同一个来源，pin 不能延期。

### 4.2 首片范围保持明确

仅支持目标 View 自有的 snapshot-value，参数位于顶层，输入为原始 Ref ID，payload 为非 null JSON object。新 opt-in 首片只面向明确 `isMutating:false` 的 View-local Tool；Legacy 五参数或 mutating/default Tool 使用新声明应明确拒绝，避免本批触碰写入执行合同。先不支持 entity、跨 View/App、嵌套/数组引用或 primitive payload。多个顶层槽位的组合上限另行确定，不将“单值参数”误写为只能有一个参数。

Ref ID 按完整字面值比较；不解析 Markdown、URL、前缀、索引或 JSONPath。未知业务类型不得从名称、label、payload.id 或 entityType 猜出。

### 4.3 批准显式声明子合同，而非偷加 V2 字段

批准 `ParamDef.refSource?: 'snapshot-value-v1'` 作为 View-local 的显式 opt-in。批准 inputSchema 顶层 property 上的保留关键字：

```json
{
  "type": "string",
  "x-aotui-ref": {
    "version": 1,
    "kind": "snapshot-value",
    "owner": "tool-target"
  }
}
```

可选非空 `refType` 必须留在该子合同内，参与 canonical 聚合比较、失效和冲突判定；`unknown` 不能满足 `File`。不写 refType 时只保证来源 JSON 对象，不伪装成类型正确的业务 File。

V1/V2 exact envelope、ToolDescriptor/RefDescriptor 字段集合不变。能存任意 JSON 不表示已经理解保留关键字；必须严格校验版本、键集合、位置与字段组合，未知能力不得作为可忽略 annotation 执行。旧 unannotated string/reference 保持旧行为。

### 4.4 声明支持与执行支持必须分开

下一片允许新 Runtime 保存并观察新声明，但所有现有执行入口对这种 Tool 都必须明确拒绝；即使可选 Ref 参数未提供，也不得误解为已支持新模式。Worker 必须根据当前注册合同防御，不能只信 Host 传来的 descriptor。SDK 在缺少声明支持信息的旧 Runtime 下不得静默注册；Legacy 五参数形式不接收新 opt-in，不能先降级再执行。

只允许一个最小声明能力标记，不批准通用 capability registry。该标记不表示 execution supported。新的执行 IPC、能力协商和 authorize scope 变体需要下一道独立执行 Gate。

### 4.5 有效值、provenance 和预算仍须下一次执行验收

未来执行顺序必须是固定请求→来源获取→声明位置解析→合成 args/来源事实并预算→授权→原来源重新检查→Worker 活态检查→Handler。普通参数和额外字段只是 caller JSON，不因长得像引用就得到能力。

原始请求预算保持 Wave 2A。展开后的 args、重复 payload、来源事实必须重新计费；32 条、合成 envelope、canonical 字节阈值是候选政策，不是本批已测能力或性能结论。本次仅批准声明片沿用既有 Schema/JSON 预算，不提前实现整个展开预算框架。

## 5. 下一批只允许做什么

建议 Wave 2C：**保留权威声明，并证明旧模式无法执行它**。

必须证明：合法声明进入真实 SDK→Registry→V2；不同 refSource/refType/owner/version 不能被相同 string 投影吞掉；新旧 Runtime/SDK 组合不会静默降级；Host 和 Worker 的现有只读路径均拒绝新声明，Handler 调用次数为 0；原 unannotated 行为与全部回归保持一致。

不批准：实际 Ref 解析、新的 invocation IPC、Controller 的 provenance 授权 scope、entity 资源读取、默认 Agent Router 切换、可写 Tool 或 Strict。由用户手动转发 Wave 2C Prompt 后启动 Codex；完成限定任务后停止并交回验收。

## 6. 最终状态

- Wave 2B：DESIGN_GATE_PASS，方案 A APPROVED。
- Wave 2C：仅声明保留/防误用切片可进入实施，必须由用户手动交给 Codex。
- Generic Ref execution / 完整 M4 / Strict / 默认 Router 切换 / 可写开放：NO-GO。
- 本审计未进行性能、coverage 或新 Ref 派发全链路测试，不将现有普通 JSON Handler 证据冒充新功能。

原始完整性、命令退出码及日志见同目录 `integrity-before.json`、`independent-reruns.json`、`independent-ref-probe.json`、`ref-projection-observation.log`；最终保护核验另存 `integrity-after.json` 和 `INDEPENDENT_WAVE2B_GATE.json`。
