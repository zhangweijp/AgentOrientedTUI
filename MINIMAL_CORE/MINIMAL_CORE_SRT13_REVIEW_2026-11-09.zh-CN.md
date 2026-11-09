# SRT-13 当前协议与兼容合同：独立验收

2026-11-09。裁决：**APPROVED**。批准本次七路径隔离补丁，由 SRT Owner 选择性采用；本裁决记录时共享生产尚未采用。执行者为项目所有者指定的 Minimal Core 执行 agent，复核者为 Minimal Core 负责人。没有待修订项，不追加人工验收前置。

## 批准对象与实际范围

- 唯一任务：[SRT-13 完整任务](../SRT/SRT-13_CURRENT_PROTOCOLS_CLEAN_TASK_2026-11-09.zh-CN.md)。
- 执行交付：[报告](../review-evidence/srt-13-current-protocols-20261109/REPORT.zh-CN.md)、[七路径 patch](../review-evidence/srt-13-current-protocols-20261109/srt-13.patch)。patch SHA-256：`06b952091d815e491ca95ca9a2ebacb858fdb870cd8714a6416843b38a191f49`；报告 SHA-256：`2d0b8bd32cf007f17bab26ad9e01331faccef4ba92c253b7004bfc47f7b29376`。
- 执行候选：`.tmp/srt-13-protocol-delivery-20261109/candidate`。负责人独立重放：`.tmp/srt-13-minimal-core-review-20261109`；[独立证据](../review-evidence/srt-13-minimal-core-review-20261109/identity.json)。

七路径是三个现有 Runtime 生产文件、三个现有测试和 `sdk/docs/runtime-compatibility.md`。负责人核对全部实际差异，423 个输入均匹配当前共享前像及执行候选；重放后与候选逐文件一致。生产仅八行替换，其中三行增加已有模块的 import specifier，五行将同一个 `state-session-v1` 构造值改成既有 `STATE_SESSION_PROTOCOL`。

## 代码与合同判断

1. **删除的重复责任：** `worker-host.ts` 的持久化 offer、`worker-runtime/index.ts` 的 ACK、`state-persistence.ts` 的 App 端口及初始／关闭报告，不再各自填写同一个协议值。
2. **保留责任的现有模块：** `adapters/storage/state-storage-protocol.ts` 已定义该常量和收件校验。三个调用模块此前已运行时导入它，因此没有新依赖方向、初始化层、状态或公开导出。版本、实例、预算、收据捕获、flush／seal／dispose、业务调用和失败处理均未改变。
3. **真实验证：** 新拒绝断言继续使用外部协议字面值，能够检验错误协议、旧工厂和 getter 拒绝；没有把期望值直接取自被测常量。ACK／offer 各自有合法外壳的 getter 用例；旧工厂不执行初始化，失败 INIT 不走 RESET 或转交旧 Worker。负责人独立通过相关测试与真实 Worker 链路，见下表。
4. **作者负担：** App／View／Tool／Ref 的概念和写法保持不变，本项不声称减少了作者 API 数量。现有兼容文档减少集成者对版本和错误阶段的猜测，且没有把协议管理转嫁给 App。

兼容表的九类合同已对照实际声明、收发入口及拒绝逻辑：工厂声明与注册端口责任不同；Snapshot schema、Host mode、Worker capability、参数 profile、生命周期、状态传输和记录编码独立。当前 Snapshot 无 INIT 版本协商，文档未声称存在。`ordinary-v2` 可信 ABI／纯 Core 模式及 `ordinary-params-v1` 仍支持；退役 Worker RPC 的拒绝不能外推成所有同名代码均可删除。SDK 工厂和 SPI 的类型声明没有为了去重增加公共协议入口，Core 没有反向依赖 adapter。

## 独立验证与复用证据

| 验证 | 结果及边界 |
| --- | --- |
| 实际补丁重放 | 七路径 after 与交付一致；其他已记录输入一致，共享生产仍为 before。 |
| 负责人 Runtime → SDK 重建 | 两项 build 退出 0；Runtime 354、SDK 68 件产物与执行者候选逐字节一致。 |
| 负责人相关测试 | 13 个文件 **136 passed、0 failed、0 skipped**：10 个局部／公开入口文件 78 项，3 个真实 Node Worker 文件 58 项。包含最终 getter 修订；受控 EventEmitter 用例不冒充真实 Worker。 |
| 负责人协议探针 | 在独立重建产物上运行已审查的同一探针，44 条完整输出与执行者原生产／候选两份输出逐字节相同；SHA-256 为 `1fd748885e98ccdce3de07c3e65d6572670fb0dbe89c9c79f44af81b289e82e2`。 |
| 声明 | 负责人核对原生产／候选的 135 对完整声明原件，无差异；不只比较导出名称。 |
| 正常包消费 | 负责人核对新 tar 及安装文件：Runtime 372、SDK 86 件逐字节一致，并审查真实命令、严格类型配置及两次调用／关闭结果。复用执行者本轮正常安装、SDK／Host 严格类型、纯 Core ES2022-only 严格类型和真实 Worker 消费证据；负责人没有另装一份消费者重复跑这套矩阵。 |

独立命令和完整结果见 [run-review.py](../review-evidence/srt-13-minimal-core-review-20261109/run-review.py)、[测试结果](../review-evidence/srt-13-minimal-core-review-20261109/tests-summary.json)、[产物与安装物核对](../review-evidence/srt-13-minimal-core-review-20261109/build-and-package-audit.json)、[协议输出](../review-evidence/srt-13-minimal-core-review-20261109/protocol-output.json)、[机器裁决](../review-evidence/srt-13-minimal-core-review-20261109/verdict.json)。执行方的基线 136 项和补跑 23 项不另行累加为新测试数量。

首次负责人准备副本时，嵌套工作目录的 `git apply` 因路径前缀跳过补丁，逐字节检查立即发现；随后在仓库外临时目录重放并核对七路径，再复制到独立测试副本。原输出见 `initial-nested-apply.log`。这是已解决的复核夹具问题，不是生产红测试；未覆盖共享或执行方证据。执行方的其他中间失败保持原记录。

## 未覆盖范围

本项证明的是当前匹配版本及列明合同，不承诺其他版本自动兼容。没有重跑全仓、GUI、Planning、真实模型作者评测或 Driver／Adapter 历史矩阵；已有签收保持。正常安装使用离线 store 和 ignore-scripts，不是 registry 发布验收。既有 Driver 第三方严格声明和 LSP 问题未在本项处理；不由本次批准推导全项目、全面 Legacy 退出或发布完成。

## 下一步：七路径采用与进度收口

范围仅为本次已批准 patch。SRT Owner 按现有 before 备份和逐路径身份采用，重建根 Runtime → SDK，确认七个 after 与批准对象一致；复用本次独立行为验证，不再新增测试矩阵或人工门槛。更新唯一索引，将“当前协议事实与支持／拒绝边界收口”记为完成，未来版本协商、其他未定稿治理与发布条件继续分别保留。

准出：七路径采用无覆盖他人改动，根构建通过，实际采用记录与唯一索引一致。下一项开发按唯一索引剩余授权单独组织，不为消除所有相同字符串而新建公共协议体系。

给 SRT Owner 的执行 Prompt：

> 采用已独立 APPROVED 的 SRT-13 七路径补丁，身份以本裁决的 patch SHA-256 和 changes.json 为准。使用已核对的 before 备份，逐路径应用，不复制整树；如实际前像变化，先保留差异并协调。完成根 Runtime／SDK 必要构建和 after 核对，保存简明采用记录，更新 deepseek 的当前完成范围并回传。无需重跑本批 136 项或已有人工流程；不提交、推送、发布，不顺带升级版本或启动未来协议设计。
