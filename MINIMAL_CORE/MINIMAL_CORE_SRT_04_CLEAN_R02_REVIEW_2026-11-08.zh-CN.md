# SRT-04 r02：修复后独立复核

2026-11-08。**APPROVED：本报告标识的 SRT-04 r02 隔离实现，以及单独列出的旧 Ref 测试迁移增量。** 原 r01 提前结束等待的问题已由同一个反例独立验证修复。原 r01 的 CHANGES_REQUESTED 和失败记录继续保留；本次不代表共享采用、发布或最终 Semantic 验收。

**这次实际修了什么**

上一版只在组件初始化时包装 Preact 调度函数。现有作者写法用 `act()` 包住初始化，而 act 结束时会恢复此前保存的调度函数，导致后续更新漏出跟踪。r02 在创建 App 工厂时就建立跟踪，并识别已经包装过的调度函数。这样，act 恢复的仍是能记录完成状态的函数，后续渲染也能被等待。

生产增量只有 `sdk/src/app-factory/createTUIApp.ts` 与 `sdk/src/app-factory/render-commit.ts`，合计新增 8 行、删除 3 行；另修改一份刷新回归测试。Runtime、Scope / Source / Driver API 与 Worker 协议均未进一步变化，没有增加 App 作者必须手写的步骤。既有调度器负责渲染，现有 coordinator 和 Host 刷新路径负责后续观察。

独立的第四个文件是 `sdk/src/view-type-tool.integration.test.tsx`：将“多个／可选 Ref 必须拒绝”的旧断言迁移为已批准能力的实际行为验证。保留 mutating 默认值、错误输入不得进入 handler、只读参数与 App 自有数据区别、未支持形状拒绝和注册释放检查。这份增量不修改生产，也没有将 SDK effective 参数测试冒充完整 Observation Ref 解析证明。

**精确对象**

| 输入 | 身份 |
| --- | --- |
| 候选 | `.tmp/srt-04-clean-r02-20261108/candidate-r02` |
| 最终源码清单 | `824abeb012ab2a54f3b8a2996737e13a11ac4956fa12a31684f6f7d31100880d` |
| r01 → r02 四文件补丁 | `a3bc04057d0e349574a06a4efd94f268f13bae78ac7e997535eeaeae7ab99773` |
| 刷新修复三文件补丁 | `15afc5f97f1cdebb313ba24beaa5694086fb6dd9872fc855b402e1e229743374` |
| 单文件 Ref 测试补丁 | `cf76a55afcc6a26ad652248e17483f89e3e027acbf51cb63c18c818da77e3a5c` |
| 新 SDK tar | `415c1d650f82502a862adc1654c02d8ce7a4751028c123afc365411a31ae0b50` |
| 沿用的 Runtime tar | `4d60eafa8cf7ba4cc17b44dfb4d911075e769b1cf9608c170f05f17c6f4cdf40` |

负责人独立重放四文件补丁，核对结果等于最终候选，也等于本次已运行的源码；15 份公开消费者输入与最终交付逐字一致。[增量和输入核对](../review-evidence/srt-04-clean-r02-review-20261108/final-delta-identity.json)。单文件旧测试补丁另在原基线重放通过，与组合候选中的文件相同。[测试迁移核对](../review-evidence/srt-04-clean-r02-review-20261108/test-migration-patch-review.json)。

**独立运行结果**

所有运行在负责人自己的 `/private/tmp/aotui-srt04-r02-owner-sgeqsrgo` 中进行，生产代码未由负责人修改。原 Owner 反例只调整了事实记录的输出路径，断言保持原样。

| 验证 | 实际结果 |
| --- | --- |
| 原 Owner 受控反例 | 普通初始化与 act 初始化两组均通过；回调未释放时等待均不返回，释放后 View / Ref / Tool 更新 |
| SDK 默认全量 | **19 文件，178/178，零失败／跳过**；包含迁移后的 20 项工具集成测试及 3 项刷新测试 |
| Runtime 刷新相关 | **3 文件，17/17**，包含真实 SDK Worker |
| 构建和类型 | Runtime / SDK 正常 frozen 安装与构建、SDK 公开严格类型及静态类型通过 |
| 产物 | 独立重建 Runtime 351 份、SDK 68 份 dist 与 tar 逐字一致；新 SDK 包只改变这两个生产文件对应的 JS 和 source map，公开声明未变 |
| 正式包消费 | 另一个正常 frozen 安装目录中，450 份包载荷与 tar 一致；严格类型、纯 TS 及真实 Worker 均通过 |
| 受影响的作者路径 | 两个现有 JSX 作者程序与验证器保持原样，重新严格编译及运行均通过；包含 act 初始化、调用、更新和卸载 |
| 释放 | 纯 TS 持有量归零；两个 Worker App 的 Runtime 正常关闭且资源释放；两个作者样例的 View、binding 和保留字节归零 |

[源码命令及退出码](../review-evidence/srt-04-clean-r02-review-20261108/source-commands.json)、[原反例修复后的事实](../review-evidence/srt-04-clean-r02-review-20261108/sdk-act-refresh-facts.json)、[公开包及作者路径命令](../review-evidence/srt-04-clean-r02-review-20261108/public-commands.json)、[产物一致性](../review-evidence/srt-04-clean-r02-review-20261108/packages-build-match.json)、[实际安装载荷](../review-evidence/srt-04-clean-r02-review-20261108/installed-packages.json)。

旧测试增量的最终文件 SHA 为 `01a0d495bd5b277d412d5ef89957ee80a50e5ceb8344dffe0414eb82d7abfbe7`。本次用组合候选 178 项全量直接验证它，不重复安装那份 175 项的独立候选。原基线和 r01 的过时断言失败没有被抹除。

**必要边界**

当前批准建立在配对的 Runtime / SDK 和列明的执行路径上。自定义异步 renderer 仍需提供实际完成信号；本次未运行完整 Runtime 默认全量、GUI 或真实模型。SRT-05 的新观察替换旧资格、第三方工具链阻断、共享采用与最终 Semantic 验收仍分别处理。没有因本次限定通过重跑无关矩阵，也没有替其宣布完成。

**下一片及执行 Prompt**

下一片是 SRT-08 当前失败隔离核对，已交所有者指定的 Minimal Core 执行agent。当前 adapter 已有逐 App 处理，先确认现有实现和测试是否足以满足目标，避免照旧文档重复开发。该目录的 10 份文件在 r01 与 r02 完全相同，可直接基于封存 r01开展。准出条件是清楚证明：失败 App 有诊断且准备资源释放，健康 App 仍可观察和调用；如有实际缺口，给出最小反例和受影响路径，再协调代码修复。

> 按 [SRT-08 任务](MINIMAL_CORE_SRT_08_CURRENT_CHECK_TASK_2026-11-08.zh-CN.md)核对当前 adapter 与已有相关测试。以实际候选为准，不重新全仓盘点、不新建容错框架；没有缺口就交证据收口，有缺口就交具体复现。当前先做事实核对和既有测试，不与 Clean 修改同一批生产文件。负责人独立审查后继续推进。
