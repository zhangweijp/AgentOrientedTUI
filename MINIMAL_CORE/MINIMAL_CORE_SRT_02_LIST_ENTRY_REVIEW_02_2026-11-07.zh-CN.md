# SRT-02 修订入口 02 独立复核

2026-11-07。**APPROVED，仅准入 attempt-02 的两条首次基线命令。** 这是对分层探针的入口签收，不是整列表能力已实现，也尚未证明修订后的基线运行通过。

提交为 [修订报告](../review-evidence/srt-02-list-ref-baseline-20261107/attempt-02/REPORT.zh-CN.md)，SHA `bdde426449f9017e4196c5b58f0268375a00867e60c444f165a84a46db99d251`；[submission-02.json](../review-evidence/srt-02-list-ref-baseline-20261107/attempt-02/submission-02.json)，SHA `50c1d65593af14f2d46620f44d7e33ad94bba3a50fdde447424e90f8dbcd0999`。

负责人核对了 24 件修订证据、18 个实际入口文件、478 件包文件与 7 个依赖链接。原 67 件提交、原四组合预期及首次失败字节未变；18 个入口中只改 declaration-check.mjs。新的业务输出尚不存在，原 Worker 未运行。[核对脚本](../review-evidence/srt-02-list-ref-baseline-20261107/owner-review/verify-revised-entry.py) · [指纹结果](../review-evidence/srt-02-list-ref-baseline-20261107/owner-review/revised-entry-check.json)

修订确实经过 `createToolBindings.commit → 仅转发的 port → createViewOwnedTools.registerTypeTool`，没有用假校验器替代注册。六种参数形状分别记录 SDK 捕获、正式 profile 编译和真实 Core 注册；一项成功、五项失败的预期落实在正式编译／注册阶段。负向同时检查 `TOOL_BINDING_COMMIT_FAILED` 和 `diagnostics.original.code = PARAMETER_DECLARATION_UNSUPPORTED`。每项还检查注册调用次数、绑定数量、清理错误与 dispose 后资源归零。

该层没有调用 handler，“业务进入 0”只表示注册探针没有执行业务。它不替代 AppKernel／完整 Worker 的拒绝验证。Worker 脚本与 emitted App/data 未改，继续使用已审的显式合成 instruction、state 和本地 App。纯 Core 不创建 Runtime 或 Worker，现有资源和路径审查仍适用。

获准 cwd 为 `/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/.tmp/srt-02-list-ref-baseline-20261107/attempt-02/consumer`。按 [准确命令](../review-evidence/srt-02-list-ref-baseline-20261107/attempt-02/proposed-commands.json) 顺序执行，各首次一次：

```sh
python3 run-reviewed-entry.py declaration
python3 run-reviewed-entry.py worker
```

仅第一条达到全部分层预期后执行第二条。执行前确认已签输入不变且输出不存在；失败原件保留，不覆盖重跑。第二条仍要求六次真实调用、两次成功业务进入、四次派发前拒绝及真实资源关闭。

当前 Prompt：SRT Owner 执行这两条精确入口并封存原始结果；两条均达到预期后，按原范围在新候选目录实施一个必填整列表 Ref。后续 G-F 采用 [修订四组合预期](../review-evidence/srt-02-list-ref-baseline-20261107/attempt-02/expected-combinations-revision-02.json)，完整 Worker 与实际业务进入证据继续必需。原 scope 的 G-A 至 G-G、两处最小 Runtime 逻辑范围、独立终审与异常升级条件保持。不得修改共享生产或冻结材料，不恢复 Host 诊断，不扩大多 Ref／optional／协议／业务范围。

仍未覆盖新的整列表实现、完整 Worker 兼容矩阵、不可变性、预算和关闭边界。首次验收预期错误的 CHANGES_REQUESTED 保留为历史事实，只有修订的实际结果才能关闭当前基线问题；不把新入口批准反写成旧探针通过。
