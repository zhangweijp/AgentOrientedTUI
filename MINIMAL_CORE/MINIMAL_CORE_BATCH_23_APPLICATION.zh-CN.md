# Batch 23 共享应用结果

**APPLIED_VERIFIED_PENDING_OWNER_FINAL_REVIEW。** 已按负责人的 `APPROVED_FOR_SHARED_APPLICATION` 应用精确单文件差异，并完成共享复验；等待负责人最终独立签收，没有自行宣布 APPROVED 或发布。

授权原件：[application-approval.json](../review-evidence/minimal-core-batch-23/owner-review/application-approval.json)。生产范围只有 `runtime/src/adapters/system-instruction.ts`：

| 身份 | SHA-256 |
| --- | --- |
| 批准 patch | `112e2a594ee119e23f15428b85e46445ffe9f9c654a4e60aa08f7dd5e7dac80c` |
| 应用前实际共享 preimage | `1a491f3509ad6aae8bba62a5b4cee659af59e67440915794ec5f98ab82c92c36` |
| 应用后共享源码 | `5aa85eab652e8867d372f6e2d5c68430dd57d099c7d2eacfaa0f061eab7de778` |

应用前重新核对 preimage，保存共享原件，先执行 `git apply --check --whitespace=error-all`，再应用原 patch。应用后源码逐字节匹配批准候选，反向 patch 检查退出0。开工12,189个路径只有此源码改变，没有缺失，其他既有工作、HEAD 和 index 保持；没有提交、push、merge 或发布。[应用命令及身份](../review-evidence/minimal-core-batch-23/shared-application/application.json) · [保护和最终核对](../review-evidence/minimal-core-batch-23/shared-application/verification.json)

隔离 READY 原交付保留不变：报告 SHA `ab5f982dc6ae5303740347cb6a713d44a2bc13324c25f435737d9495ad8d2370`，清单 SHA `0801e72a153d98fe13eac29a2643cb215fc0aedc5acab6262ffbe96cccfe8449`。原件另复制进 shared-application，未用共享结果改写隔离成绩。封存清单修正了负责人并行证据的归属，历史输入副本及证据 dist 均实际列入。

## 共享复验

共享应用前后分别在项目 `runtime/` 执行 `pnpm run build`，均退出0；分别运行两个已有 Source 测试文件，均为 **2文件42项通过**，没有改测试或新增skip。两次测试的数量分别记录，不累计成84条独立合同。

```bash
node node_modules/vitest/vitest.mjs run \
  src/adapters/semantic-aotui-driven-source.test.ts \
  src/adapters/semantic-aotui-driven-source.real-core.integration.test.ts \
  --reporter=dot
```

实际 Source 探针从以下 **共享新构建 dist** 加载，未使用隔离B22包替代：

- `/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/dist/index.js`
- `/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/dist/adapters/semantic-aotui-driven-source.js`
- `/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/dist/adapters/system-instruction.js`

它创建真实共享 Runtime 和空 Desktop，调用共享 Source 的 getContext。默认 User Message 与批准的新说明逐字相同；直接instruction、instructionPath、环境变量优先级、缺文件fallback及opt-out六种情况通过。自定义文件故意保留旧格式文字，读取后仍原样，不自动重写。环境变量恢复，临时文件清理，Runtime关闭 `ok/resourcesReleased=true`。fallback 的 ENOENT日志是刻意覆盖的既有行为，不是未处理失败。[探针源码](../review-evidence/minimal-core-batch-23/shared-application/source-probe.mjs) · [实际消息/模块路径/构建指纹](../review-evidence/minimal-core-batch-23/shared-application/source.json)

构建前后完整输出文件集相同，仅 `adapters/system-instruction.js`、同名`.js.map`、`.d.ts`改变。共享默认模式仍为 `ordinary-v2 / snapshot-value-v2`，没有V4/B22协议采用；其他SDK/Runtime生产源码未改。

## 证据边界

共享验证的是现有版本的默认说明、覆盖优先级与相关Source合同。三类参数经过真实Worker/Driver/受控provider的证明属于[原隔离报告](MINIMAL_CORE_BATCH_23_REPORT.zh-CN.md)，不能据此宣称共享已有B22普通Ref能力。本次未运行真实模型、GUI、真实IDE业务或SRT作者评测，也未改变观察采用/释放或最终Legacy条件。

应用材料索引和精确文件指纹见 [shared-application/final-application.json](../review-evidence/minimal-core-batch-23/shared-application/final-application.json)。下一步按单独授权的B24任务做只读盘点，不继续修改生产。
