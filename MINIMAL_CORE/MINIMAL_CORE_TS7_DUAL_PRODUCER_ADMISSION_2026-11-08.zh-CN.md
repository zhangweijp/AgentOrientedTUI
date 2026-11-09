# TS7 新产物双 Producer 有限运行准入

2026-11-08。**APPROVED：仅批准指定新包消费者执行既有 22 场景的普通 TypeScript 与 SDK Worker 验证。** 这不是运行结果签收，也不是全工具链、共享采用、发布或最终 Semantic 验收。

负责人独立验证 279 件交付输入，读取 864 件原始源码并在新的物理目录重放 40 文件补丁；864 件结果与交付候选逐字一致。两件 r02 参数预算修复源码与已批准版本一致。重放目录为 `/private/tmp/aotui-ts7-review-source-hv8ep5ba`。

指定消费者为 `/private/tmp/aotui-multi-optional-candidate-_p4pq8zo`。15 件入口输入已核对；相对已签收 r03，只有 package.json 和安装锁改变，其余 13 件源码、类型试件和编译入口逐字不变，runner 也逐字相同。实际安装的 Runtime 367 件与 SDK 78 件文件和指定 tar 全部一致；只有一份 Runtime，安装图未引入 Driver/AI SDK。

负责人逐项比较四个新旧 tar：可执行 JavaScript 没有变化。Runtime 13 份和 SDK 1 份声明差异已人工阅读，差异为字符串字面量引号、属性顺序与联合成员顺序；其余变化为 source map、包元数据和适配包说明。此比较不替代新产物真实执行及完整严格消费者门禁。

准入身份：

- preflight：`1a9ae8e6304b17f2d034266243f27ff45fc5aa21e75b9afc3dc8da1013e1a5d1`。
- runner：`0b382a1d1b621039616ff9c378364e7ebb8954d1eae2a486f63e221de9cdb046`。
- Runtime tar：`c3774ae59bef8892bce3d364f4a0615e15bb5ed6b17d95f7d8829897c2be4aca`。
- SDK tar：`772f38f18758c9b04fee92d4082a717d6dcf98c1faaeb496d47e791fac9c6f25`。

执行保持原有六项环境白名单，数据和配置都指向该消费者。只运行合成 Notes 应用，不进入 Host、GUI、真实模型或私人手测状态。普通 TypeScript 先执行，成功后再启动 Worker；每项 45 秒上限，强制终止属于失败。保留首次事实、stdout/stderr 和正常关闭报告；失败后停止，不覆盖记录或自行修入口后续跑。

执行方下一条指令：

```sh
python3 review-evidence/typescript-unified-latest-20261108/dual-producer/run-reviewed.py --run-reviewed-candidate
```

负责人另建正常安装消费者，重编译相同入口并独立复验。双方各自应得到每个 Producer 22 次调用，其中 14 次成功、8 次指定的派发前拒绝；完整参数、可选字段缺席、只读路径、页面业务 witness 和短收据匹配；Runtime 正常关闭并释放资源。

全工具链仍为 **CHANGES_REQUESTED**：lint 的实际失败、IDE/Jest 兼容、Driver 第三方严格 Tool 声明，以及完整迁移复核仍未关闭。有限运行不依赖这些独立项先通过，也不能抵消它们。

独立输入审计：[entry-input-audit.json](../review-evidence/typescript-unified-latest-20261108/owner-review/entry-input-audit.json)。原候选、历史失败、原签收保持不变。
