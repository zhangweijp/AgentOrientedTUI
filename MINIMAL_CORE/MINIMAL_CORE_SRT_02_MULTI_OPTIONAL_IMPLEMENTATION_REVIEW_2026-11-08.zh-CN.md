# SRT-02 多 Ref／可选 Ref：r01 独立实现复核

2026-11-08（Asia/Shanghai），Minimal Core 技术负责人。

**CHANGES_REQUESTED。** 三处生产修改、375 项定向测试和实际包身份已独立核对；发现新增多 Ref 路径存在参数顺序相关的容量误拒绝，当前候选不能准出。原双 Producer 入口的三项问题已在静态审查中修正，但真实运行准入仍等待新候选，不得把此结论写成 Worker 已通过。

## 1. 精确对象与独立验证

- 候选：`.tmp/srt-02-multi-optional-ref-20261107/candidate-r01`。
- 97 件提交清单 SHA256：`fcb8291094ef20a307e97ca2107c80080a45d5a466fbec337fbed8548a0b43c7`，逐件核对字节数和内容指纹一致。
- patch SHA256：`ec9c87e579b92e080aa5a326d07a884464a3d2c4b46c0921baa6906a90510038`。
- source-final SHA256：`555994ffe8b1c506efe7b3e862c3f3dd76e1ac998b0acedd69d9dc2ad8a09774`。
- 原 B r02 和本批 baseline 各 738 个源码输入均未漂移。负责人将 baseline 物理复制到仓库外，再应用 patch；739 个最终源文件逐字一致，变更仍为三处生产、三份测试及十二份文档。
- 在该独立重放源码中，九个定向测试文件 **375/375** 通过。重新编译 Runtime，**351 个 dist 文件**与提交 tar 逐字一致。命令、真实耗时和结果保存在[独立验证记录](../review-evidence/srt-02-multi-optional-candidate-20261107/owner-review/independent-candidate.json)。
- 15 个准备入口／消费者输入逐项核对；实际安装的 Runtime 367 件、SDK 78 件等于两份候选 tar。安装图只有一个 Runtime，无 Driver／AI；本次核对没有冒称另做正常安装。两份运行事实文件尚不存在，真实 Runtime／App Worker 未启动。见[入口身份核对](../review-evidence/srt-02-multi-optional-candidate-20261107/owner-review/preflight-identity.json)。

SDK 可执行代码与公共声明未变。两版类型检查和正常安装由执行方记录，本次复核没有把它们写成负责人新重跑；旧公共基线的独立类型证据保持原范围。

## 2. 阻断发现：临时混合参数导致合法最终参数被误拒绝

**[P2] `runtime/src/core/tool/snapshot-value-arguments.ts` 循环内的 `bounded({ ...effectiveArgs, [param]: payload }, ARGUMENTS)`。**

循环刚解析第一项时，另一项仍是原始 Ref 名。该临时对象把“已解析 payload”和“尚待替换的引用字符串”合在一起，并立刻套用最终参数预算。因此，最终参数完全合法的一次调用，可能仅因为大 payload 排在前面而被拒绝。

负责人新增[纯 Core 反例](../review-evidence/srt-02-multi-optional-candidate-20261107/owner-review/intermediate-budget-probe.mjs)，从真实 Registry、已提交 Snapshot 和原来源进入参数准备；没有 Runtime／Worker、业务 handler 或私有用户数据。两个排列使用相同 Schema、相同两个 payload、相同 Ref 名集合，最终用量完全相同：

| 计量项 | 大对象先解析 | 小对象先解析 |
| --- | ---: | ---: |
| 原始参数 approximate bytes | 149 | 149 |
| 完整最终参数 approximate bytes | 131072（等于上限） | 131072 |
| 完整最终参数 canonical bytes | 131070 | 131070 |
| 完整 envelope approximate bytes | 131753（小于 139264） | 131753 |
| 第一项解析后的临时 approximate bytes | 131200 | 21 |
| 实际结果 | `REF_ARGUMENT_BUDGET_EXCEEDED` | `prepared` |

原始参数和最终参数均通过真实合同验证；完整参数与 envelope 均通过现有 copyJson／字节边界。两次结束后 activeLeases 均为零。完整数字与状态在[反例结果](../review-evidence/srt-02-multi-optional-candidate-20261107/owner-review/intermediate-budget-result.json)。

这是本批新增多字段组合的真实缺陷。现有 375 项测试使用的 Ref 名与载荷组合没有暴露该临时峰值。应修正组合过程，不能扩大预算、取消原始输入检查、弱化超限断言，或要求 App 作者调整参数名称以改变解析顺序。

## 3. 入口与其他审查结论

原入口三项问题均已静态修正：

1. 成功调用深比较完整 args、可选字段缺席及递归只读路径；未解析的字符串无法通过预期对象比较。
2. 失败要求指定的 `rejected/code`；unknown、超时或无关失败不计成功。完整业务 witness 必须保持不变。
3. scope close 和 Runtime shutdown 分别尝试并记录错误，前者抛错不跳过后者；异常进程终止不计正常资源释放。

普通 TypeScript 使用公开 Core、createToolBindings、scope.invoke 和 Registry；SDK 入口使用 AppTools、typed Ref hooks 与真实 Node Worker。共享 22 个场景的预期为每种 Producer 14 次成功、8 次拒绝。环境白名单、绝对合成数据／配置路径、包文件与入口指纹均由外围 runner 在执行前核对；只运行当前合成 App，未调用 Host、AppRegistry 或真实模型。

这些是代码审查和身份核对结论，尚无这批真实双 Producer 执行结果。**r01 不获得运行准入；r02 必须绑定新的实际包、消费者和输入身份后再裁决。**

## 4. 证据更正与政策变化

执行方补充的 [TIMING_METADATA_ADDENDUM.json](../review-evidence/srt-02-multi-optional-candidate-20261107/TIMING_METADATA_ADDENDUM.json)明确：core-r02／r03.command.json 的 seconds 是复制残留。本复核不使用这两个字段，也不推算重跑耗时。原 97 件提交不改；负责人独立命令另记真实测量值。

项目所有者最新答复“统一升级到 TS 最新版本吧”已由负责人直接核对[原始人类消息](../review-evidence/typescript-unified-latest-20261108/owner-review/owner-authorization.json)。它授权下一批统一工具链，不追溯改写本批旧编译器证据，也不豁免第三方严格类型缺陷。精确最新稳定版本及其实际迁移由独立工具链候选验证。

## 5. 下一批范围、准出条件与执行 Prompt

本次后续是同一 SRT-02 范围内的 r02 修订；实现归 SRT Owner，负责人只修改独立复核材料。保留原 r01 与本反例，不覆盖执行证据。

> 从已封存 r01 建立新 r02，仅修正 snapshot-value-arguments.ts 的中间形态预算误拒绝，并增加相应回归；同步必要包、入口和交付身份。复用已有 bounded 与来源／释放机制，不新增预算器、状态管理器或兼容分支。完整 raw、最终 effectiveArgs 与 envelope 继续遵守原预算；可通过完整参数组装后统一检查，或保证逐步检查只累计最终参数的组成项。证明相同最终用量的两种解析顺序均接受，最终超一仍拒绝，同 Ref 计入两份、可选缺席、来源绑定和 lease 清理不变。重跑受影响的九文件测试，重建 Runtime 并核对新 tar；SDK 行为及类型无变化时保留精确复用证据。提交新 patch、源码清单、测试结果和正常消费者／预检身份，等待负责人独立裁决后，执行有限时双 Producer 验证。失败保留原件并定位，不扩大到 SRT-05、Ref 名数组、嵌套 Ref 或业务权限。

准出要求：本条反例修复、既有定向合同通过、包与源码可重建、真实双 Producer 各项结果及正常清理通过独立复核。共享采用、发布和最终 Semantic 验收仍不在本批批准范围。
