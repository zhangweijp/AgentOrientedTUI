# Minimal Core Batch 11 · Runtime 普通工具参数校验盘点

**本批授权只读盘点与隔离验证。** 目标是回答 R4 中哪一处参数校验可以安全删除、哪一处由 Runtime 或跨进程边界负责。共享生产、永久测试和公开 API 的修改授权为零。盘点可与 Batch 10 结果语义裁决独立进行。

## 取样范围

1. 从一次公开 Core 调用、一次真实 Worker 调用分别往下追。记录原始参数首次捕获、生成 effectiveInput、授权、进入 handler 各自使用哪份值。每次校验注明谁调用、校验什么、如果跳过会发生什么。
2. 重点读取现有 [Core 调用](runtime/src/core/invocation/scoped-interaction.ts)、[普通工具注册表](runtime/src/core/tool/view-owned-tools.ts)、[Worker 接收边界](runtime/src/adapters/ordinary-invocation-v2.ts)、[Worker 调用](runtime/src/worker-runtime/ordinary-invocation-v2.ts) 和 [SDK 调用封装](sdk/src/utils/ordinary-parameter-tool.ts)。只跟随实际依赖。把主工作树与并行 SRT-01 的代码身份分开，记录差异会影响哪条判断。两条工作线都只读。
3. 对照合法输入、非法输入、可信 validator 显式转换输入三个案例。后者复用现有测试中 `{line:'7',surplus:true}` 转成 `{line:7,defaulted:true}` 的例子，核对授权与执行收到同一个冻结对象。单独检查坏的 wire 输入在接收端被拒绝和 handler 零进入。需要实验时仅在临时副本加探针，用真实路径及受控业务 handler。

## 准出

- 保存精确输入文件指纹、实际加载路径、命令及原始输出。至少有一条公开 Core 和一条真实 Worker 的运行记录。区分源码推断与实际观察。
- 对可能重复的一处校验给出前后对照。若去掉它会让独立 Core 接受原先拒绝的输入、丢失可信转换，或改变授权后复查，记录反例并保留。若可以等价删除，交付下一轮最小文件范围和要保留的断言。找不到可等价删除的检查也可以结项。
- 输出一份短报告及必要证据，报 READY_FOR_REVIEW。没有可解释的运行结果不进入生产派单。不要迁移 Ref、调整限制、改变公开结果或重写 SDK。D3 已取消。

## 给 Codex 的 Prompt

> 执行 Batch 11 的 R4 只读盘点。锁定当前实际工作树，只走公开 Core 与真实 Worker 的普通工具调用，记录每个输入捕获、校验、授权与 handler 的责任。以三个代表输入和一个坏 wire 证明哪些检查能删、哪些必须保留。在隔离副本验证，交回最小代码范围、可重放的原始证据与明确结论。共享生产和测试保持只读，不实施 R4，不提交或发布。
