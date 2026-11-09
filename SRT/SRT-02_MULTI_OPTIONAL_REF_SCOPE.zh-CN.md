# SRT-02：多 Ref 与可选 Ref 的隔离范围准备

2026-11-07，SRT Owner。**READY_FOR_SCOPE_REVIEW_R03；范围准备及无 Worker 的既有验证器反例，未实施新能力。** 全局任务状态仍由 `deepseek_review.md` 维护。

## 目的与固定基线

下一批建议一起完成多个顶层 Ref 和可选顶层 Ref，避免对同一声明、参数准备、Worker 验证链重复分批。沿用 `refParam`、`Type.Optional`、普通 ViewType Tool 与已接受的对象／对象列表载荷，不新增工具类别、解析器、注册中心或业务规则。

基线为 B r02 已封存 SDK／Runtime，源码位于 `.tmp/srt-06-adapter-package-20261107/source-r02`。其 `source-final.json` 身份为 `ca0390b397a49498f5ce668dbb3b997b20213e33c11e6e70ee156e50e1658f67`，逐文件身份见本批 [基线审计](../review-evidence/srt-02-multi-optional-scope-20261107/baseline-audit.json)。基线已包含单必填对象、单必填对象列表、旧 Snapshot Tool 退出和 B 包迁移的限定候选；不从历史 2026-11-06 单对象范围重新开始。

Runtime／SDK 不安装 Driver 的正常包消费、两版严格类型和列明的 Worker 行为已有独立通过证据。完整 Driver 集成仍未批准；本批使用无 Driver 的公共 Core／Runtime／SDK 入口推进，不宣称这一红灯已经解除，也不启动 Host、模型或 GUI。

## 目标行为与不扩展的范围

示例为拟验证的下一批能力，不是当前已实现支持：

```ts
Type.Object({
  source: refParam('Task', TaskSchema),
  destination: refParam('Plan', PlanSchema),
  related: Type.Optional(refParam('Task', Type.Array(TaskSchema))),
  title: Type.String(),
});
```

模型按完整 Ref 名选对象；handler 获得不可变的已解析 payload 和普通 title，不要求抄写内部业务 ID。多个对象、对象与列表、多个列表应在同一有效参数对象中保留。

可选字段缺席时不解析、不填造对象、不产生该字段的 provenance。字段出现时必须是有效完整 Ref 名；空字符串、null、显式 undefined、直接对象／数组、不可见名称、错类型或错形状均按既有合同拒绝，不视为缺省。全为可选 Ref 且本次均缺席时，仍沿用该工具的正式参数调用和来源绑定路径，不偷换为另一类 Tool。

同一 Ref 名用于两个兼容参数可以作为候选正向场景：按字段分别表达来源，整个 effectiveArgs 计入既有总预算；是否允许两个业务角色指向同一对象由 App 判断。若现有协议存在实际冲突，先给出证据，不能静默引入框架业务限制。

本批继续拒绝 Ref 名数组、多选、嵌套 Ref、属性路径及未支持的载荷形状。普通参数、对象／对象列表的既有 Schema 规则与全部额度保持。Observation 采用与旧观测自动撤销属于 SRT-05，能力激活、业务权限和应用功能也不在本批改变。

## 三个实际实现落点

| 文件 | 当前实际限制 | 下一批须验证的最小责任 |
| --- | --- | --- |
| `runtime/src/core/tool/ordinary-parameter-contract.ts` | 正式 profile 拒绝多于一个 Ref 和非必填 Ref | 允许限定的顶层组合，保留其他形状拒绝及完整模型／有效输入校验 |
| `runtime/src/core/tool/snapshot-value-arguments.ts` | 循环每次从 rawArgs 重建 effectiveArgs；缺席 Ref 也无条件要求字符串 | 正确累计已经解析的字段；跳过缺席可选字段；复用原 Observation、逐来源检查、总预算与现有一次调用的 release |
| `runtime/src/adapters/ordinary-invocation-v2.ts` | refSources 数量必须等于全部声明 Ref 字段数 | 只允许实际提供的字段具有相对 Schema／raw／envelope 一致的来源字段；拒绝数量、字段结构、对应关系或普通参数不符，不声称独立认证来源是否真实属于 Snapshot |

SDK 的 `sdk/src/tools/view-type-tool.ts` 已有 Schema witness 与 ArgsOf，不预设需要新增签名。下一批先验证公共类型对多字段与 optional 的推导，再按证据决定是否需要限定实现修正；支持说明应与实际运行同时更新。任何额外生产文件、协议形状、新配置或第二套状态必须先解释必要性并提交范围修订。

保留已有 `view-type-parameters-v1`／V4 能否表达扩展，需要由旧／新组合证明。现有数组形式 refSources 可以表示多个字段只是静态依据，不能提前写成兼容性已通过。

## Runtime 与 Worker 的可信传输边界

初版误把“payload 篡改均拒绝”写成现有 Worker 保证；r02 又遗漏了 viewId／viewInstanceId 只有格式检查的边界。两个原件分别保存在本批 `SCOPE.r01.zh-CN.md`、`SCOPE.r02.zh-CN.md`，对应修订要求保留。本版按实际字段逐一说明，没有增加签名、摘要、独立来源认证或另一套授权机制。

现有 Runtime 准备器从绑定 Snapshot 和本次 Observation 获准的 Ref 解析原值，负责 Ref 的可见性、真实 view／instance 来源及不可变 payload。Worker 的参数验证器不持有原 Snapshot，职责是相对声明和收到的消息做检查：

- param 与该 Schema 字段对应，refId 与该 raw 参数相同，refType 与字段声明相同，kind 是既有固定值，source.snapshotId 与 envelope.snapshotId 相同；来源字段结构和数量必须符合要求。
- viewId／viewInstanceId 是非空字符串。换成另一个非空字符串，本层不能证明它不是真实来源。
- ordinary 参数在 raw／effective 间不变，payload 满足 Schema，整体满足既有预算。仍符合 Schema 的 Ref payload 改值也不能由本层独立识别。

“相对消息一致”不等于“相对原 Observation 真实”。例如 raw Ref 名与 source.refId 同时改为另一个匹配名称，形式检查仍可能通过；是否存在、是否可见、是否属于当前 App 和原 Snapshot，由可信 Runtime 的准备／授权／绑定链证明。真实 Worker 入口另外保留 App 实例、能力协商与当前 Tool 绑定检查，不能用只调参数验证器代替完整调用验收。

原六场景结果保留在[首个无 Worker 反例](../review-evidence/srt-02-multi-optional-scope-20261107/payload-boundary-result.json)。新的 [r03 合成 Note 反例](../review-evidence/srt-02-multi-optional-scope-20261107/payload-boundary-r03-result.json)共有 21 个预设场景：原 envelope、合法 payload 改值、另一个非空 viewId／viewInstanceId、raw/source 同时改名均被接受；非法标识类型／空标识、schema/raw/envelope 不一致、来源数量／结构错误、普通参数改值、不合法载荷及超预算则在预期层拒绝。全部结果与现有实现一致，没有新 Runtime／Worker、handler 调用或 Snapshot 查找。七模块指纹保持并匹配封存 Runtime tar，静态依赖核查不被描述成通用安全沙箱。

后续真实调用测试分别证明：可信 Runtime 确实从原 Observation 解析每个 Ref 的原值和真实来源；Worker 按上述职责检查请求。对任意传输攻击者伪造但形式自洽的值或来源提供密码学完整性，不属于本批，也不把这些反例强行改为拒绝。

## 必要验收

| 项目 | 准出证据 |
| --- | --- |
| 有效基线 | 在新目录用正式注册／调用入口证明旧基线明确拒绝多 Ref 和可选 Ref；SDK 能捕获声明不等于正式 Runtime 接受 |
| 公共类型 | TS5.3.3／5.9.3，strict、exactOptionalPropertyTypes:true、skipLibCheck:false；各字段得到自己的 readonly payload，可选缺席类型保留；错误字段类型、数组写入和对象写入负向有效 |
| 正向组合 | 对象＋对象、对象＋列表、列表＋列表、必填＋可选、全可选全缺席／部分出现，以及普通参数；模型名与 handler 值逐字段对应，不能只验证最后一个 Ref |
| 失败与作用次数 | 第二个 Ref 无效、一个不可见／跨 App／错类型／错形状时均在业务前拒绝；失败不能留下部分调用或额外持有；同名来源歧义继续拒绝 |
| 原观察来源 | 使用原已绑定 Observation 的每个 Ref，后续重排或同名替换不改变已绑定目标；旧 Context 释放后拒绝；不冒称 SRT-05 自动采用已经完成 |
| Worker envelope 校验 | 来源数量／结构错误，以及 param、refId、refType、kind、snapshotId 相对 Schema／raw／envelope 不一致时拒绝；viewId／viewInstanceId 格式无效时拒绝。缺席字段注入、普通字段改值、不符 Schema／超预算 payload 也应拒绝。合法形状 payload 和形式自洽来源的真实性由 Runtime 原 Observation 链证明，不声称 Worker 独立认证 |
| 累计预算 | 多 payload 合计达到或超过既有 argument/envelope/node/depth 边界；不按参数重置额度，也不因同一 Ref 被两字段使用就绕过总量 |
| 双 Producer 与真实调用 | Preact 和普通 TypeScript 使用同一公共合同；合成 App 真实 Worker 至少验证多对象、列表组合、可选缺席／有效、失败不进业务及正常关闭；不得只调 handler |
| 正常包与兼容 | 精确 SDK／Runtime tar 在仓库外正常安装，不借 Driver 图；基线／新 SDK × 基线／新 Runtime 明确列预期，旧 Runtime 在业务前拒绝新声明；最终运行图的实际入口与源码身份可追溯 |
| 收尾 | 必要 Core／SDK／Worker 回归、最新 View／短收据与既有资源释放；支持文档同步；冻结源码、patch、包与原始失败，独立复核后才签收 |

合并准备两个相关参数特性不意味着取消负向、来源或关闭验证。既有回归不因每次文档更新重复全跑；只在实现或失败提出新疑问时增补。

## 所有权与下一条指令

SRT Owner 负责在新的独占目录实施和提供证据；Minimal Core Owner 独立审查范围、关键输入与实现。共享 main、所有已签候选、Planning、Driver、Host 和用户运行状态均不由该范围直接修改。

当前完成源码阅读、身份审计、首轮六场景及 r03 的 21 场景纯验证器边界反例和本范围文档，没有新生产实现、类型通过数或真实 Worker 行为结论。下一条指令是独立复核本范围，确认三处责任、组合矩阵与真实 Worker 入口边界；获准后先建立有效失败基线，再实施最小修复。若需要用户选择 Driver 编译器政策，范围准备可以继续，不能以等待该选择为由让所有清理停住。
