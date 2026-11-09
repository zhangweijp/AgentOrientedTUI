# SRT-02 列表 Worker：收据断言修订复核

2026-11-07。**APPROVED_ENTRY_ONLY**：批准 worker-entry-02 的四条新目录命令；完整列表实现尚未签收。

第一轮按原入口执行至第七条 bc/list，第一次列表调用已经 succeeded，授权、V4 派发和业务进入各一次，数组及元素不可变检查通过。随后 `deepStrictEqual` 把无原型 JSON 收据与普通对象字面量进行比较，因原型差异失败。Node／外层退出均为 1；终于块实际完成关闭，Runtime ok/resourcesReleased=true、Worker 池 total=0、交互持有字节=0。原结果不能算完整列表通过，也不构成列表业务失败。bb/cb/bc 的六条声明／标量入口已执行，原 cc 三条未执行。

负责人独立核对了新 **43 件输入**、两个消费者 **956 件包文件**与原包一致、依赖链接不变及结果路径未占用；原 **84 件入口证据**和第一轮产物均保留。唯一脚本变化是在比较收据前调用 `structuredClone`，仍严格要求仅有相同的 message 字段和值，未更改业务、Ref、不可变性或关闭断言。无生产或包变化。提交 SHA-256 为 `fbb77b5e56d2eafe20ca208cfd47b6872762e81a33655edd1a96e2f51cbb0761`。[独立核对结果](../review-evidence/srt-02-list-ref-candidate-20261107/owner-review/worker-entry-check-02.json)

执行 Prompt：按 `worker-entry-02/commands.json` 顺序，在 matrix-attempt-02 的新 bc 仅跑 list，在新 cc 跑 declaration、worker、list，共四条首次运行；不重复六条已经成功的命令，不覆盖第一轮失败。意外失败继续停下封存；完整成功后补齐既定双 Producer、wire、类型、容量与回归证据，交 READY_FOR_REVIEW。第一轮与本次修订必须一起进入最终清单。

原入口复核中的状态目录、非空 instruction、禁止 Host／模型／私有手测状态、完整关闭及范围约束继续有效。本裁决不批准共享采用、发布或 SRT-05。
