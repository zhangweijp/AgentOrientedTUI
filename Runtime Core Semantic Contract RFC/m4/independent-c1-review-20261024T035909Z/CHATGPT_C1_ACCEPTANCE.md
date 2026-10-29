# ChatGPT 独立架构再验收 — Wave 2C C1

**决定：Wave 2C LIMITED PASS；C1 CLOSED。**

日期：2026-10-24。验收对象：`m4/wave2c-c1-20261024T033523Z/`。本轮仅核对前次退回的 C1 Schema 节点／成员名映射／字面数据遍历缺陷，不批准后续 Ref 实际执行。

## 一、独立检查的代码

唯一修改的生产文件 `runtime/src/core/tool/ref-declarations.ts`：将 `dependencies` 作为成员名到数组/Schema 的映射处理，数组作为属性依赖数据不递归，Schema 成员继续检查错误位置的 Ref 声明；`dependentRequired` 成员列表不再被当作 Schema 节点；`default`、`const`、`enum`、`examples` 的真实字面数据仍跳过解析。增量 patch 中生产改动共 +5/-3 行（含注释），另新增 26 个 C1 测试用例。未修改其他生产文件、原有测试或旧执行协议。

正常顶层 Ref 声明仍被识别和保留到 V2；在旧 Tool 执行路径中返回 `REF_CONTRACT_UNSUPPORTED`，Handler=0。

## 二、本轮独立重跑的验证

六项回归按原顺序逐条等待退出后执行：

| 测项 | 实际结果 |
|---|---|
| Runtime tsc | exit 0 |
| SDK tsc | exit 0 |
| IDE tsc | exit 0 |
| Runtime Vitest | 74 files / 723 passed / 3 skipped / 7 todo，exit 0 |
| SDK Vitest | 11 files / 110 passed，exit 0 |
| IDE Jest | 6 suites / 27 passed，exit 0 |

还实际运行了原封不动的上次独立 v3 探针：**10/10 符合预期、0 违规，exit 0**，相比上次 6/10 违规确认修复有效。

原普通 Schema 起点对照也原样执行：`dependencies` 和 `dependentRequired` 的普通属性名 `x-aotui-ref` 均可注册；起点和当前 Registry 的合成 Handler 都成功执行。这个对照只在已保存起点 Registry 模块和当前未修改 JSON codec 下运行，并非旧 Host/Worker 二进制兼容测试。

定向稳定性三轮均为 **13 files / 200 passed**，exit 0。原始 R1 真实 Worker 脚本 **0/4** 违规、受控传输脚本 **0/10** 违规，均 exit 0。日志详见本目录 `independent-commands.json` 和对应 .log。

## 三、来源保护与真实性

独立复算 C1 交付起点的 1368 条路径记录，包含 22 条起点已缺失路径：唯一发生变化的既有文件为获准修改的 `runtime/src/core/tool/ref-declarations.ts`。起点全部 586 条既有 RFC 目录路径均未变化。源码与新增测试的 SHA-256 均匹配 C1 交付指纹。

本轮独立审查开始时记录的 1408 条路径在审查结束时也均未变化；新的文件只写入此独立审查目录。HEAD、暂存差异输出指纹、.git/index 原始字节指纹、未暂存差异输出指纹均与本轮审查起点一致：

- HEAD: `789ef07cb18084d97b0476c1ffc234ae0b9319f0`
- SHA-256(git diff --cached --binary 输出): `258d9b26c2ac0c01d9156553bd3bd775de08ba16330546d65b5bb53b896dcf54`
- SHA-256(.git/index 原始字节): `8ed3a27a94f2a4f13caa9afb06e52923139484f882e83999ce836c6834a34162`

本轮未执行 Git 写入或生产源码修改。按现有忽略规则产生的构建产物与缓存不纳入上述源文件保护清单。原始 C1 证据包未被覆盖。

## 四、正式准出边界

**签署 Wave 2C LIMITED PASS，关闭 C1。** 批准的是：受信任 View-local snapshot-value Ref 参数声明可被 SDK/Runtime/V2 保留，但不能在旧入口执行，非法声明和滥用须 fail closed。

**未批准**：Ref 值展开、effectiveArgs/provenance 授权、新执行 IPC、完整 M4、Strict、默认 Agent Router 切换、新增写入 Tool 开放。性能、coverage、完整历史二进制矩阵和 C1 异常 Schema 的真实 SDK/Worker E2E 仍为 NOT_TESTED，不因为本次通过而视为完成。

后续若申请实际 Ref 执行，需先审定 IPC/能力协商、授权 Scope、展开后预算与 SDK `receivedArgs` 的框架错误 payload 回显边界。历史 Snapshot A 的授权语义保留，不允许默换最新 B。

**本次独立复验已完成并停止；不自动启动下一批实现。**

机器裁决：`INDEPENDENT_C1_GATE.json`。独立工作树核验：`review-start.json`、`independent-gate.json`、`batch-baseline-audit.json`。