# SRT-02 整列表候选：Worker 入口独立复核

2026-11-07。**APPROVED，仅批准本次已冻结消费者的十条运行入口。** 新列表实现仍待完整结果与独立技术签收；本裁决不批准共享采用、发布或最终 Semantic 验收。

## 已核对的实际输入

候选目录为 `.tmp/srt-02-list-ref-candidate-20261107`；提交入口在 `review-evidence/srt-02-list-ref-candidate-20261107/worker-entry`。Minimal Core 负责人独立检查了两处 Runtime 生产 diff、SDK 支持注释、全部新增 Worker/App/runner 源码，以及声明注册探针。

- `ordinary-parameter-contract.ts` 允许一个必填顶层对象 Ref 或对象列表 Ref，继续拒绝多个、可选、Ref 名数组、原始值列表及列表套列表。
- `snapshot-value-arguments.ts` 根据声明区分对象与对象列表；显式类型、原 Observation 来源、完整参数验证、总容量及 lease 释放仍走已有代码。
- SDK `view-type-tool.ts` 只有支持范围注释变化；没有新 helper、公开签名或 wire 修改。

独立核对脚本验证了 **84 件入口证据**与实际脚本一致、**8 份安装包共 1,912 件文件**与精确 tar 一致、候选 **SDK 76／Runtime 372 件 dist**与包一致。四个消费者的七个依赖链接均与已批准基线相同；旧六调用 Worker 入口逐字不变。新脚本通过语法检查。检查时所有计划结果路径均不存在，没有把既有结果当作首次运行。

候选 SDK tar SHA-256 为 `43259156c661f0e5b83b2e0fea0040c4ae46bb110bd7be88158de1ca3249be84`；Runtime 为 `3a3a5832a85f3acd997849b28b34f305c5ab1cf3f11115f5c2d6072422f54a7c`。基线沿用已签 typed SDK `7573cc0b…` 与 B23 Runtime `46c39d59…`，不以共享 SDK 0.3 替换。完整身份见 [packages.json](../review-evidence/srt-02-list-ref-candidate-20261107/packages.json)。[独立脚本](../review-evidence/srt-02-list-ref-candidate-20261107/owner-review/verify-worker-entry.py) · [核对结果](../review-evidence/srt-02-list-ref-candidate-20261107/owner-review/worker-entry-check.json)

## 具体运行范围

严格按已冻结 [commands.json](../review-evidence/srt-02-list-ref-candidate-20261107/worker-entry/commands.json) 顺序，在 bb、cb、bc、cc 四个新消费者中各跑声明注册与原标量 Worker；仅 bc、cc 再跑新增 list Worker。首字母为 SDK、次字母为 Runtime，b 为基线、c 为候选。每条一次；意外失败后保留输入、stdout/stderr、真实退出及已有结果，不覆盖重跑。

旧 Runtime 的列表拒绝位于真实 SDK commit→Core 注册；SDK 捕获成功不算 Runtime 接受。新 Runtime 的声明注册须接受对象列表，随后以真实 Worker 验证。历史 `matrix.mjs` 不在本次运行入口内，其中旧断言不能充当新矩阵。旧 `expected-combinations` 的历史身份文字保留；本次实际身份以已核对的 packages 清单为准。

新增 App 使用现有 `useArrayRef`、`AppTools`、合成 Task 状态，计划执行 16 次调用：合法列表／单项／空列表、九种派发前拒绝、列表替换后的 O1/O2、业务前置拒绝。逐次记录授权、原始参数、解析参数、V4 派发与 handler；mutating 操作只改本 App 合成状态。完整数据进入 View，结果只返回短收据。尝试修改数组／元素必须失败，后续 O1 读取仍须保留原数据。O1/O2 同时持有是原来源解析测试，不冒称实现了 SRT-05 自动观察替换。

运行沿已审 Runtime/Source 初始化链，非空 instruction 避免默认指令文件读取；显式 AOTUI_DATA_DIR 与业务日志均在各消费者目录。没有 Host singleton、AppRegistry 实例或模型调用；不改变 HOME、不接触已交接手测状态。Runtime 根导出仍加载既有导出模块，不能写成“从未加载 Registry 代码”。这是经源码核对的限定执行，不是 OS 沙箱证明。

正常及失败路径释放 Context/Source，并等待 Runtime close；外层 45 秒超时记录 UNKNOWN，不可当作成功关闭。释放 Context 后 store 可能仍持有当前快照，最终资源结算以 Runtime 关闭报告为据。

## 待完成的审查与下一步 Prompt

当前还没有这十条命令的实际运行成绩。Core 扩展、双 Producer、严格类型、wire 变异、总预算、授权期间撤销和回归结果均须在最终交付独立复核。四项历史生命周期容量夹具失败尚待基线对照；已看到的测试改动仅把空 schema 编译到实际正式 profile，边界断言未更改，但本入口裁决不提前签收其结论。最初 Core 夹具漏传 now 的失败也须保留。

SRT Owner 独占候选生产文件，Minimal Core 只写复核证据与裁决。原 G-A 至 G-G 全部准出条件继续适用。下一步执行 Prompt：

> 运行已冻结 commands.json 的十条命令，逐条保留真实输入、产物、stdout/stderr 与退出码，失败即停并封存，不覆盖原件。完成实际包四组合、标量回归和两组新 Runtime 列表 Worker。继续补齐双 Producer、严格 readonly、总预算、撤销、wire 与关闭证据，准确区分 Core 和完整 Worker 覆盖。四项容量失败先在原 B23 同命令复现，测试夹具修订保留 ±1 边界和释放断言。完成后提交精确 patch、源码／dist／包对应关系、全部原始失败、最终 G-A–G-G 对照及 READY_FOR_REVIEW；不得自行签收、共享采用或扩生产范围。

MC-HOST-PREVIEW-01 仍 OPEN，第三轮 Host 仍未准入；本次入口批准不改变该状态。
