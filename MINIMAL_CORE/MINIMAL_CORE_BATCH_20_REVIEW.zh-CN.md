# Batch 20 独立复核 · Planning 的引用和 App 关闭修复可以一起使用

**APPROVED。签收对象是同一套实际装入的 SDK、Runtime 和可复跑的组合验证。** 我在两个新目录从固定 Git 对象和三份签收补丁重建，核对打包文件、实际安装的每个包文件和 Worker 加载位置。Planning 能按页面上看到的名字读到完整计划；App 自己清理时报错，预先拿到的旧工具失去执行资格。普通工具读取一个 Ref 仍缺一段正式执行能力，已定位到具体边界。[送审报告](MINIMAL_CORE_BATCH_20_REPORT.zh-CN.md) · [独立核验记录](review-evidence/minimal-core-batch-20/owner-review/final-verification.json)

## 同一套包的三个实际结果

| 情况 | 我核对到的结果 |
| --- | --- |
| App 的关闭回调主动抛错，再调用已捕获的旧工具 | 在较早的 M4.2 组合上，旧业务执行 1 次，旧测试以业务断言失败。在原始 M4.3 和本次组合上，旧业务执行 0 次，返回 `TOOL_UNAVAILABLE`。另一个健康 App 能执行，同一位置重新打开的 App 也能执行。最后卸载后有 0 页、0 个绑定，Registry 仍占初始的 46 个逻辑字节；释放 Registry 后为 0。 |
| 从真实 Planning 页面选择 `Plan:unfinished_plans[0]`，用当前按页面实例绑定的工具读取 | 原始 M4.3 将其发布为“未知”。组合包保留了页面原先写出的 `Plan`，Worker 收到冻结的完整计划 A。一次真实更新后又读到更新后的 A。内容完全相同的订单、整份列表、另一页的数据和已释放的旧入口都没有进入该读取业务。原始/组合分别有 13/14 次 Source 调用和 5/7 次引用读取业务。 |
| 作者改用普通工具的声明，要求输入一份计划 | TypeScript 严格编译通过，组合 SDK 接受声明。Runtime 注册时返回 `PARAMETER_DECLARATION_UNSUPPORTED`，定位到 `$.properties.plan["x-aotui-ref-kind"]`。执行器创建 0 次，业务进入 0 次。普通数字工具从同一个注册入口接受 2、返回 3，注册、工厂、业务各进入 1 次。 |

我把两轮页面的工具绑定和观察来源，与每条业务输入、拒绝结果及收据逐项关联。这里的关闭故障在 Preact + SDK + Core Registry 上执行；Planning 的读取通过默认 Source 和真实 Node Worker 执行，两者加载同一对安装包。另在原始 M4.3 和组合上各补了初始化抛错、关闭中重入、旧工具已禁用时重入三项签收探针。组合源码的 SDK 两个既有文件 35 项、Runtime 三个既有文件 73 项全部通过，没有跳过。[关闭探针补测](review-evidence/minimal-core-batch-20/owner-review/extra-cleanup.json) · [真实 Planning 调用与收据](review-evidence/minimal-core-batch-20/runs/01/evidence/checks/01/candidate-planning.json) · [注册处原始错误](review-evidence/minimal-core-batch-20/runs/01/evidence/checks/01/candidate-ordinary.json.first-rejection.json) · [SDK 回归](review-evidence/minimal-core-batch-20/owner-review/sdk-tests.json) · [Runtime 回归](review-evidence/minimal-core-batch-20/owner-review/runtime-tests.json)

## 两个包单独更换会怎样

我另外建了四个空消费目录，各自离线装包、严格编译 Planning 并启动 Worker。原始 M4.3 和三补丁组合使用相同的包版本名，因此每次还核对 tar 指纹。

| SDK / Runtime | 页面记录的业务类型 | 要求输入 Plan 的现行单引用工具 | 普通工具收到新声明 |
| --- | --- | --- | --- |
| 原始 / 原始 | 未知 | 拒绝，业务 0 次 | SDK 拒绝 |
| 原始 / 组合 | 未知 | 拒绝，业务 0 次 | SDK 拒绝 |
| 组合 / 原始 | 未知 | 拒绝，业务 0 次 | SDK 拒绝 |
| 组合 / 组合 | Plan | 成功，业务 1 次，收到完整 A | Runtime 注册时拒绝 |

四组中，允许读取任意业务类型的旧工具都能读到相同的完整 A。这区分了“数据确实存在”“两包传递了正确类型”和“普通工具能够执行”三件事。组合 SDK tar SHA-256 为 `881cd00af0b01d546ff6e27d17366043e5a3570274cda98c0f26ba0e00d48995`，Runtime 为 `f10708895d3c7157fffd534bc6881936787ae2f74e9c7928daba916e27b39d78`。[四组包与实收参数](review-evidence/minimal-core-batch-20/owner-review/package-pairs.json) · [四组复跑入口](review-evidence/minimal-core-batch-20/owner-review/check-package-pairs.py)

## 原件核对与准出范围

送审的一键复跑只比对了上游签收的 SDK 原包。我从签收 ZIP 的 `final/artifacts/` 取出对应的 Runtime 原包，核实来源并补入负责人复跑。原始 M4.3 的 SDK 与 Runtime 重建后，gzip 压缩字节各自不同，解压得到的整份 tar 分别与各自的签收原件逐字节相同，含 90 和 388 个文件。两次新构建也独立复现了本批六个压缩包的指纹。签收原包、原始版本重建和叠加补丁后的候选分别记账。[Runtime 原件来源](review-evidence/minimal-core-batch-20/owner-review/runtime-origin.json) · [两包完整比较与组合核验](review-evidence/minimal-core-batch-20/owner-review/final-verification.json)

执行者封存的清单 SHA-256 为 `78f088fb7a9a39658215e8462d01a2381da8b4962f1842a5357f914e218ba665`，报告为 `f94b383e7df7455c173ba053fcc83b6f3040ab6baca8a829c069700ad30efe73`。本批共享生产补丁为 0 字节，SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。核对了开工 10,052 个既有路径、1,080 份交付原件、16 项历史引用、2,812 个本地直接依赖文件和三个版本共 429 份包声明。负责人首次核对 A/B 时用了上批更新后的 B 作初版对照，改用本批严格编译的原始 Plan 数据后，两次新构建的全部业务实收都吻合。[执行者封存清单](review-evidence/minimal-core-batch-20/final-delivery.json)

包含两份上游原包核对的完整独立复跑命令如下。只在新临时目录构建和安装。

```sh
python3 review-evidence/minimal-core-batch-20/owner-review/check-delivery.py
```

本批沿用 SDK 的工具绑定释放责任、Runtime 的页面引用发布与运行时检查。App 作者继续只在原有位置标注一次列表业务类型。本批没有删除新的生产职责；确认了两条开发线的改动在同一套包中是否保住这些行为。当前证据覆盖 Planning 单引用、所列关闭故障与指定回归。其他 App 全量迁移、全仓组合回归、真实模型作者试验与所有者最终 Semantic 验收仍分开准出。SRT 作者公开材料合规成绩仍为 6/9，门槛 8/9；此次没有新模型试验。[上游工程签收](.tmp/worktrees/srt-01-owner-verdict-20261106/SRT-01_M4_REPORT.2026-11-05.zh-CN.md)

## 下一步

现行 Worker 消息把两种身份分开。普通工具属于一类页面；旧引用工具拿的是那一个页面实例的绑定。编译同一套安装包的实际协议声明，两种合法消息都通过，把两种身份互换分别得到类型错误。直接放开注册时的检查，不能证明执行时取的是 Agent 看见的那份计划。[已安装协议的严格编译对照](review-evidence/minimal-core-batch-20/owner-review/wire-ownership.json)

**Batch 21 只做一份计划的普通工具验收与最小协议提案。** 交一个实际 App 的成功断言，在今天的包上保留它的真实失败；用现有接收端确认不支持或错配的请求怎样处理，再列出接通所需的字段、责任和旧端行为。正式协议和产品代码的变更留待该提案裁决。[Batch 21 白名单、准出条件与 Codex Prompt](MINIMAL_CORE_BATCH_21_TASK.zh-CN.md)
