# SRT-02 下一批：多个必填 Ref 参数的限定范围

2026-11-07，SRT Owner。**保留方案，尚未实施、未获范围准入。当前优先执行旧 Snapshot Tool 的只读收尾范围审查。** 本文只展开全局 `deepseek_review.md` 的 SRT-02，不另建全局 TODO。[单个对象列表候选已获限定独立签收](MINIMAL_CORE/MINIMAL_CORE_SRT_02_LIST_IMPLEMENTATION_REVIEW_2026-11-07.zh-CN.md)。终审提出先核对现有消费者能否迁入普通 Tool 及可删除的专属职责；SRT Owner 采纳此收尾顺序。多必填 Ref 的产品 TODO 保留，是否紧接实施须结合真实消费者与明确承诺再做范围裁决。本批不会修改该冻结候选。

## 目标与边界

允许普通 ViewType Tool 在一份输入合同中声明多个**必填、顶层** Ref 参数；每个参数为对象或对象列表，普通参数保持原样。继续复用 `refParam`、`defineViewTypeTool`、`ArgsOf`、既有发布与同一 Observation 的解析路径。一个对象列表 Ref 与“Ref 名数组”是两种输入，本批只覆盖前者。

提议用法（未实现）：

```ts
const inputSchema = Type.Object({
  destination: refParam('Project', ProjectSchema),
  tasks: refParam('Task', Type.Array(TaskSchema)),
  title: Type.String(),
});
// 模型选择两个完整 Ref 名；handler 收到 Project 和 readonly Task[]。
```

不新增 descriptor、Tool 类别、全局类型注册中心、并发调度或业务事务。可选 Ref、Ref 名数组、嵌套 Ref、属性路径、观察自动采用/撤销、额度策略重设计、Planning 新业务及 Host/Driver 改动均不进入本批。应用继续校验对象存在、父子归属、业务权限和外部副作用；框架不推断 Project 与 Task 的业务关系。

## 固定基线与当前事实

拟以单列表交付的 Runtime `3a3a5832a85f3acd997849b28b34f305c5ab1cf3f11115f5c2d6072422f54a7c`、SDK `43259156c661f0e5b83b2e0fea0040c4ae46bb110bd7be88158de1ca3249be84` 为下一批基线，最终必须以其独立裁决核准身份。来源和逐件输入见该交付的 packages.json/source-final.json/final-submission.json；不以共享 dirty main 为源码输入。

该候选 tar 相比原 tar 恢复了源码中的 prepublishOnly/pnpm.overrides，本地 link 配置尚未经过普通包管理器消费者验证。[包元数据补充](review-evidence/srt-02-list-ref-candidate-20261107/PACKAGE_METADATA_ADDENDUM.zh-CN.md)作为基线边界继承；多 Ref 的隔离运行不能自动解除正式安装/共享采用条件。

静态核对位置是该精确候选中的：

- `runtime/src/core/tool/ordinary-parameter-contract.ts` 的 `finish`：formal profile 仍拒绝 `refs.length > 1`，并逐字段要求必填和对象/对象列表 payload。这是当前明确限制，不能只以 SDK capture 成功声称可执行。
- `runtime/src/core/tool/snapshot-value-arguments.ts` 的 `prepareViewTypeParameters`：已有逐槽解析、类型/可见来源校验与 `refSources.push`，但每轮从 rawArgs 组装 effectiveArgs。仅删除多 Ref 声明限制会使前面已解析的字段丢失，必须同时处理累积结果。
- `runtime/src/adapters/ordinary-invocation-v2.ts` 的 `validateTypeParameters`：已经对全部槽位逐一核对参数、refId、refType、snapshotId、owner 身份和 ordinary 字段不变，并检查来源数量/顺序及总 envelope。预计可复用，尚待多 Ref 的真实 Worker 验证。

当前 API 能描述多 Ref、V4 字段是数组，都不表示多 Ref 运行已经完成。保留这条事实，先建立真实 formal registration 的业务前拒绝基线。

## 状态与资源归属

App 拥有业务状态与 handler。Runtime 拥有调用绑定的 Observation、grant、源 Snapshot 的临时 lease、参数捕获、授权及派发。所有 Ref 必须在同一次调用绑定的原 Observation 内解析；不能把其中一个字段悄悄切换到当前新快照。

所有字段成功解析并通过整份合同与总预算后，才允许授权及进入 handler。第二个或后续字段失败时，前面已解析字段不会单独触发业务，也不能泄漏临时 lease。此保证只约束框架参数准备，不承诺业务多对象修改的事务性。

必须累计全部已解析字段，再按现有额度验证整个 effectiveArgs/envelope；不得按参数重置总额度。实现应先复用现有数据结构，避免引入解析会话、缓存或另一套来源模型；若需要改变复制顺序，须用既有总预算和不可变测试证明边界未变。每个参数保留自己的来源记录；同一可见 Ref 合法供两个参数引用时，按两个参数记录和计量，不去重掉合同要求的对应关系。

## 预期修改范围

仍限正式参数编译与 `prepareViewTypeParameters` 两处生产逻辑，SDK helper 的支持注释/文档和相关测试、类型与消费者夹具。旧 Snapshot 参数准备函数保持原合同。

若实际测试证明必须改变 Worker wire、capability、公共签名或其他生产文件，保留具体失败后交范围修订；不能以“未来多 Ref 需要”为由提前扩大。本批不改变 SRT-05 的旧观察采用及 Store 历史快照保留规则。

## 准出条件

| 维度 | 必须有的证据 |
| --- | --- |
| 有效基线 | SDK capture、formal 编译、真实 SDK commit→Core 注册分层记录；原 Runtime 对两个必填 Ref 在业务前明确拒绝，保存顶层及根因错误。 |
| 组合与类型 | 对象+对象、对象+列表、列表+列表、同一 Ref 供两个同型参数使用；普通 Ref 外观字符串保持普通参数。实际包在 TS 5.3.3/5.9.3 strict、exactOptionalPropertyTypes、skipLibCheck:false 下正确推导每个只读 handler 字段。 |
| 拒绝与业务零进入 | 第一/第二/后续参数缺席、空串、错类型、错形状、不可见、跨 App 和重名来源歧义；任何失败都不部分派发。可选、Ref 名数组、嵌套/属性路径保持拒绝。 |
| 原观察与授权 | O1 中两个 Ref 各自保留原值；随后只更新或重排其中一个字段，O1 仍取两份旧值、O2 取新值。释放 O1 或授权等待期间撤销后业务零进入；授权看到全部有效输入与对应来源。 |
| Worker与业务边界 | 两个 Ref 的 raw/effective/每项来源从授权、V4到handler一一对应；真实 mutating handler 一次执行，数据由 View 呈现。应用业务关系/权限失败自行表达；额外纯适配器测试拒绝来源缺失、错序、重复或篡改普通字段。 |
| 总预算与清理 | 每份 payload 各自合法但组合后超限必须拒绝；raw/effective/envelope 与来源元数据都计入既有总额。边界/+1、后续字段失败、拒绝或关闭期间的临时 lease、scope、在途计数及最终关闭完整记录；不能宣称 Store 历史快照已立即清空。 |
| 回归与兼容 | 保留一个对象、一个列表和无 Ref 工具的既有契约；普通 TS/Preact 使用同一参数模型。新旧 SDK×本批基线/新 Runtime 的四组合，提前固定多 Ref 的拒绝/成功阶段和精确包 SHA。不能靠版本字符串、specimen 或只跑handler代替。 |
| 独立签收 | 全新独占目录、可重放最小 patch、源码/包对应、原始失败与真实退出；入口先审查合成配置/资源归属，不使用 Host 默认实例或用户手测状态。实施者交 READY_FOR_REVIEW，Minimal Core Owner 独立终审。 |

## 下一条执行指令

单列表候选独立签收、且本范围包通过复核后，由 SRT Owner 创建新的候选目录，先固定精确基线与多 Ref 拒绝证据，再完成上述限定改动。Minimal Core Owner 负责独立终审；两条线不并发改同一生产目录。共享采用、发布及最终 Semantic 验收继续遵守原授权边界。本任务尚未建立运行入口、修改生产或通过新测试。
