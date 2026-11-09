# Batch 21 首轮独立复核

**CHANGES_REQUESTED。业务成功断言会放过本批明确禁止的旧执行路径。** 送审清单 SHA-256 为 `cd17a0f0d81d73486767e7f9c80fa8887d33d3232cabaf4ed89f3ed2a14ca350`，报告为 `00a03d309fceadc135bc8ee7cecd616cf74093281c88c49c5c875ebb6863db9a`。共享生产补丁为空，SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。

## 已核实的部分

我在新目录实际装入 B20 签收的两个包，重跑六条主命令和八条提案类型命令。普通 App 严格编译成功。真实 Worker 注册普通参数中的 Plan 引用时，原异常是 `PARAMETER_DECLARATION_UNSUPPORTED`，AppTools 报绑定失败，Host 最终报告安装失败。默认 Source 看不到这项工具，业务执行 0 次。正常对照通过现有页面实例工具读到了完整 A，普通数字工具把 2 算成 3；十一条明确拒绝的旧协议请求没有增加业务调用。现有 Worker 明确拒绝拟议的 V4 能力。提案目前仅有类型与设计证据。[送审报告](MINIMAL_CORE_BATCH_21_REPORT.zh-CN.md)

## 必须修复的验收缺口

送审验收的第 143–150 行只要求得到成功收据、完整计划、业务一次和成功关闭。它没有核对成功的业务使用哪种工具身份。我用一个新的独立安装目录，保留原作者源码、编译后的 App、Worker 记录器和验收脚本的全部字节。只给这套私有 SDK 注入一种刻意错误的转接：把看起来是普通工具的 `read_plan` 委托给旧的页面实例引用工具，再把结果传给原作者的同一个 handler。

原包退出 1。故障副本的真实 Worker 收到 `VIEW_TOOL_INVOKE_V3 / snapshot-value-v2 / view-instance`，业务收到完整 A 一次，收据正确；**首版验收却退出 0**。它没有证明同类页面共享一个普通工具，开发者即使把旧路径藏在 SDK 里也能过关。该副本只用于测试验收的敏感性，补丁未进入任何产品包。[原始验收](review-evidence/minimal-core-batch-21/samples/acceptance.mjs) · [故障注入复现](review-evidence/minimal-core-batch-21/owner-review/probe-acceptance-routing.py) · [原始收据与执行身份](review-evidence/minimal-core-batch-21/owner-review/wrong-route-trace.json)

## Revision 1 范围、准出和 Codex Prompt

只修验收和相关证据，放在本批独立修订目录，首版清单和原始失败原样保留。复用真实 Scope 观察、原绑定、Host 到 Worker 的分派与返回的收据。普通工具的 descriptor、所选 binding、真实业务请求必须指向同一 App 的同一普通工具和 `view-type` 激活，Ref 使用已获准快照中的单独页面来源。将原始名字、有效值及来源关联到这次请求和业务实收。对旧路径、缺失/多次分派以及仅有相同收据的情况给出可定位的拒绝；保留现有普通无实现版本的真实红灯和两条合法对照。拟议的字面值仍待裁决，按实际测得的身份断言，不模拟已经存在的新 Worker。

**给执行 Codex 的 Prompt**

在首轮误通过的精确故障副本上用修订后的验收再跑一次。要同时看到“计划和收据本来都正确”和“因为实际用的是旧实例工具，验收明确退出非零”。原作者源码及业务成功断言不变，正常普通工具和现有实例引用工具各自按真实合同通过，未接通的原包仍按原原因报错。把修订、新旧对照、独立复跑入口和清单交负责人复核，不动生产和公共协议。
