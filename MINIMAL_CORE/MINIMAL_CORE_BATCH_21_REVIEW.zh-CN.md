# Batch 21 独立复核 · 普通工具读取一份计划

**Revision 1 的结论为 APPROVED。** 签收的是可执行的作者验收和可供裁决的协议提案。现行包依然在注册普通工具时拒绝这条 Plan 声明。新 SDK、Host 和 Worker 接通后，才可能给这项作者能力记为通过。[修订交付](review-evidence/minimal-core-batch-21/revision-1/final-delivery.json) · [首轮退回原因](MINIMAL_CORE_BATCH_21_REVIEW_01.zh-CN.md)

## 作者会看到什么

原作者只声明一次 `read_plan` 需要一份 Plan。Agent 应当能传页面上的名字，程序收到完整计划并返回编号。实际装入 Batch 20 签收的 SDK 和 Runtime 后，这份 App 严格编译成功，真实 Worker 注册时抛出 `PARAMETER_DECLARATION_UNSUPPORTED`，SDK 报工具绑定失败。外层安装接口只给 `INSTALL_FAILED`，默认 Source 未取得该工具，业务进入 0 次。同一组包里，按页面实例绑定的旧工具实际读到 A，普通数字工具实际把 2 加到 3，两项业务各进入一次。[现状与协议原始证据](MINIMAL_CORE_BATCH_21_REPORT.zh-CN.md) · [Host 和 Worker 各自给出的诊断](review-evidence/minimal-core-batch-21/owner-review/install-diagnostics.json)

## 为什么这次可以签收验收程序

我保留了原作者源码、编译后的 App、Worker 记录器和原业务断言，使用两个一次性 SDK 副本。两种错误实现都让唯一一次业务收到完整 A，最终返回 `plan_a`。和修订前相比，修订后能查清 A 怎么抵达业务。

| 实际执行的路径 | 首版验收 | 修订验收 |
| --- | --- | --- |
| 把普通 `read_plan` 暗中交给旧的页面实例工具 | 通过 | 拒绝。被选中的绑定和描述都是单页身份，普通工具应由同类页面共享。 |
| 用普通工具传一个字符串，再由 SDK 填入碰巧正确的 A | 通过 | 拒绝。这次授权和 Worker 请求里都没有交付 A 的引用来源。 |
| 原包正常的旧单引用工具、普通数字工具 | 两条合法业务都通过 | 两条业务都通过，各自的观察、授权、Worker 请求与响应、业务输入和收据能对上。 |

我在自己最初保留的两份故障副本上分别实跑了两版验收，又从签收包全新构建、运行完整修订入口。修订期间发现复跑脚本初稿曾依赖负责人一次性的 `/private/tmp` 路径，封版脚本改为从首版封存文件重建作者与消费目录。每次回放得到独立安装的两个包、真实 Worker 和新生成的请求与观察编号。首版全部 138 件原件和修订开工时 11,289 个既有路径均逐项核对。修订前后的业务成功断言逐字节相同。[修订复跑入口](review-evidence/minimal-core-batch-21/revision-1/reproduce.py) · [独立核验结果](review-evidence/minimal-core-batch-21/owner-review/revision-1-verification.json)

我还把真实 Worker 的两个合法请求分别和同一线程初始化时对 App 实例确认的能力对应，区别 Core 调用号与传输请求号。改坏证据副本中的授权、快照、引用授权、发给 Worker 的值、响应请求号、业务所见值或共享工具激活身份，七项均按对应原因失败。这组检查只检验验收程序的辨别力。前表的两种错误实现则都经过真实的安装、分派和业务。[额外验收检查](review-evidence/minimal-core-batch-21/owner-review/route-controls.json)

送审清单指纹为 `eedbb48460e8f56d64b8ce7e314151781e90fc57bd412ace871c5e525da13b92`，报告指纹为 `cc2c9a0ef7cfe61c342f427b7ab945d5d0419f9d78eaf854c5d89e42479626cd`。清单列了 75 件文件，另有一份 `dist` 下的编译 App 未列入逐文件表。我用独立编译结果和清单内分别记录的两个故障输入核对，三者字节一致，已另存该原件。验收增量补丁正向、反向重放也分别得到修订版和首版的原始字节。[核对后的编译 App](review-evidence/minimal-core-batch-21/owner-review/compiled-author-checked.js.txt)

## 哪一层对计划来源负责

在原包的真实对照中，Host 准许读取 A 时，一次授权、一次 Worker 请求、一次业务得到 A。Host 拒绝执行、模型直接提交 B 对象、页面引用被隐藏三种情况下，Worker 业务请求和业务执行均为零。我还在隔离副本手工使用受信 Host 专有的 Worker 连接，保留正确的来源字段却把有效值换成 B。旧 Worker 执行 B。这一试验绕过了 Source 和 Scope，只有持有该连接的 Host 能做。它说明未来样机必须检验 **Host 从原观察授权的数据取值，Worker 检查收到的合同和当前执行身份**。只看结果编号或一组来源字段都不足以证明这一点。[修订验收如何关联调用](review-evidence/minimal-core-batch-21/revision-1/route-gate.mjs) · [独立实测及受信连接对照](review-evidence/minimal-core-batch-21/owner-review/lead-authorization.json)

## 减法、剩余风险与下一批

本批共享生产补丁为 0 字节。修订消除了把“业务碰巧答对”误判成“普通工具合同已接通”的验收漏洞。原有 Scope 和注册模块继续负责授权与身份，App 作者继续只声明参数、处理业务数据。普通工具新路径、版本错配时的诊断、多个引用和真实 App 迁移仍需各自验证。当前可信 Host 的公开安装失败会遮蔽较具体的 Worker 原因。新旧端实际如何组合，须在候选包上分别观察。作者试验与最终 Semantic 验收另计。

**Batch 22 待所有者授权做隔离样机。** 准出条件是同一作者 App 在新组合上通过、旧包保留真实失败、两个错误实现继续被拒绝，且同名数据真实更新后仍按当次观察读对，版本错配不进入业务。提案涉及 SDK、Host 与 Worker 共同认可的协议，工作树采用与发布需另外裁决。[Batch 22 具体范围、准出与 Codex Prompt](MINIMAL_CORE_BATCH_22_TASK.zh-CN.md)
