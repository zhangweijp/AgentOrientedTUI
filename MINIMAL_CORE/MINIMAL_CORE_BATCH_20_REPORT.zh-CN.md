# Minimal Core Batch 20 交付报告

状态：**READY_FOR_REVIEW**。本批独立完成了从实际安装的同一套 SDK/Runtime 验证 Planning 引用与 App 关闭故障；等待负责人独立复核。没有修改共享生产代码，没有提交、发布或启动模型作者试验。

## 1. 结论与边界

组合包同时满足两项已签收行为：真实 Planning 页面给出的单项引用，经默认 Source 和 Node Worker 得到正确、完整的计划；App 自己的 cleanup 抛错后，先前捕获的工具返回 `TOOL_UNAVAILABLE`，业务零进入。旧 M4.2 组合的同一关闭探针确实进入旧业务一次并触发原始断言，红灯不是环境或编译故障。

普通工具仍存在一个明确边界。`defineViewTypeTool → defineToolSet → createToolBindings → Registry.registerTypeTool` 能执行普通数字参数；同一条注册链收到 B14 已签收的本地 Ref 声明时，在 Runtime 的普通 Schema 编译处拒绝。第一次错误是 `PARAMETER_DECLARATION_UNSUPPORTED`，路径 `$.properties.plan["x-aotui-ref-kind"]`；注册入口进入 1 次，trusted invoker 工厂与业务均进入 0 次。SDK 外层保留 `TOOL_BINDING_COMMIT_FAILED`，两层原始错误和堆栈都已保存。本批不绕过这条边界。

## 2. 实际基线与保护

- 任务书 SHA-256：`6e196d411cb8356709ebfdc90f5dd0f2bf02014ff1c1112a70cbae039be67b0c`。
- 开工 UTC：`2026-11-05T20:56:14.298206+00:00`；当时 HEAD 为 `8938449925ada2f92e072e1c0492af8f2428d14f`。HEAD 只作记录，不充当行为基线。
- 开工实际工作树保存了 10,052 个文件或 symlink 的内容指纹，Git 状态有 2,411 行。状态、index、HEAD、必要引用及预期已有 Owner 材料均保存在本批证据目录。最终逐项核对这些路径，没有修改或缺失；index 与 HEAD 未变。历史缺失材料按开工现状保留，没有恢复。
- 精确旧提交 `b10dabf57e6d084633a5f213e65a48395184d09c` 与 B12 的 294 个冻结输入全部匹配。精确新提交为 `853495dd9954eb4f8a91998bcc59e19326765981`，tree 为 `536258867bae50258fd2a067bf47455790eb06b0`。签收记录来自 `51e0b900b19caca962583129a8824933354fe385`。
- 全量 `git archive <commit> sdk runtime` 实际提供旧版 410、新版 415 个源码/文档/配置文件；两个完整 archive 原件另存于 `inputs/`，不是只有 294 个编译输入。旧、新 archive 解压 tar SHA 分别为 `fba2ae6640ea2c4be3d59cb0c70143bd0c00a474803df970575b0eda0b286b98`、`49fdd69789b7e646424364ab5f965f29a3f3c58b4714defe4692f9ad9f59e6d2`。
- 原有 `owner-review/opening-compatibility.json` 是负责人开工前的 dist 对照，单独归类为既有外部材料；本报告的结果来自本批 tar 消费实跑，不把该对照或 B19 历史测试算作本批执行。

新上游在原 294 个输入中改变五个文件：`sdk/src/app-tools.test.tsx`、`sdk/src/app-factory/createTUIApp.ts`、`sdk/src/components/AppTools.tsx`、`sdk/src/context/AppRuntimeContext.tsx`、`sdk/package.json`。B14 R1、B15 R1、B16 按任务顺序叠加，分别核对任务指定的三份 SHA，没有与这五个路径重叠。九个补丁路径有实际 preimage、前后指纹和正反向重放结果；没有从共享当前源码补文件，没有采用 B13 两页补丁。

## 3. 构建、装包与身份

最终一键运行目录为 `/private/tmp/aotui-b20-215nm3ue`，完整证据副本在 `review-evidence/minimal-core-batch-20/runs/01/`。预备及中间失败目录为 `/private/tmp/aotui-b20-2gq5sztg`，证据副本在 `attempts/01/`。

环境为 Node `v24.15.0`、pnpm `10.15.1`、TypeScript `5.9.3`。复用既有本地 Preact `10.29.1`、TypeBox `1.4.3`、jsdom `27.4.0`、linkedom `0.18.12`、Driver `0.3.0`、Node types `20.19.35` 和 JSON Schema types `7.0.15`。构建依赖沿用封存的 B12 依赖定位。消费端把 SDK/Runtime 作为 `file:<tar>` 依赖，执行真实 `pnpm install --offline --ignore-scripts`，store、cache、state 都在自己的临时目录；第三方与既有 Driver 依赖通过显式 override 定位到现有本地版本，不下载、不升级、不写共享锁文件。不是新建自包含的第三方依赖发行包。

| 私有版本 | SDK tar SHA-256 | Runtime tar SHA-256 |
| --- | --- | --- |
| 旧 M4.2 + 三补丁 | `2fb60d6fc68bab2f5bf125874acb1e02300f8c4c91a561fa8d0a3e61596445f3` | `f10708895d3c7157fffd534bc6881936787ae2f74e9c7928daba916e27b39d78` |
| 原始 M4.3 | `9673ffa3e7a75177dc72c3ec03cc4d6d131d5ddde949dbc530c20a98db6b0eb0` | `96849f16ffbd101188d737c9ccff20b59f3e740eaab4f7ad7fd7484cc9dd2413` |
| 新 M4.3 + 三补丁 | `881cd00af0b01d546ff6e27d17366043e5a3570274cda98c0f26ba0e00d48995` | `f10708895d3c7157fffd534bc6881936787ae2f74e9c7928daba916e27b39d78` |

六个 tar 原件及逐条清单已保存，SDK 每包 90 个条目、Runtime 每包 388 个条目，包含声明、运行文件、README 和 docs。SDK 有 12 个 docs 条目，Runtime 有 14 个。预备与最终独立构建的六个 tar SHA 全部一致。包版本没有为实验重写；应以提交、补丁、源码指纹和 tar SHA 区分同名组合。

找到了签收 SDK tar，并校验、保存了 SHA 为 `16c2fa3555c0f9beefc82156fb5d4397ee5ac789b9a0fc5d1bf86913eec96b88` 的实际原件。它与重建原始 M4.3 的 90 个文件、顺序、tar 元数据乃至完整解压 tar 字节均相同，解压 tar SHA 是 `b8e47aaa86deec6b920f249f1464139b5be7f960a54cf1918f1ddb00c4c4efc4`。差别仅在 gzip 压缩字节，未将它归因于未经证明的时间或 Node 版本因素。

消费端公开导入、SDK 内部 Runtime 导入、Node Worker 内 SDK/Runtime 导入和 Worker 脚本均记录实际落点。SDK/Runtime 都位于该消费目录的 `node_modules/.pnpm/...` tar 安装路径；没有指回私有源码或共享 dist。Worker 记录了真实 `threadId > 0`，使用消费端严格编译出的 App。`local-dependency-files.json` 另保存现有直接定位依赖的文件指纹，最终重新检查未变。

## 4. 本批实跑结果

最终 `python3 review-evidence/minimal-core-batch-20/reproduce.py` 退出 0。构建与打包阶段有 28 条命令记录（包含下游消费检查的包装命令），消费检查有 36 条记录。它们不是 64 个测试用例；原始 argv、cwd、stdout、stderr、预期及实际退出码都在两个 `commands.json` 中。

| 验证 | 实际结果 |
| --- | --- |
| 三版本 Runtime/SDK 各自 `pnpm run build` | 6 次通过，退出 0 |
| 三版本两包 `pnpm --config.ignore-scripts=true pack` | 6 次通过，tar 已保存 |
| 三个独立消费目录离线装入 tar | 3 次通过，退出 0 |
| 实际公开导入与 SDK→Runtime 身份核对 | 3 组通过 |
| 原样签收关闭探针 `close` | 旧组合预期退出 1；原始 M4.3、新组合退出 0 |
| 安装包上的 Planning、fixture、普通工具严格语义编译 | 原始 M4.3、新组合各退出 0；`strict: true`、`skipLibCheck: false`，没有 paths 映射或类型绕过 |
| 默认 Source + Node Worker Planning | 原始 13 次调用、新组合 14 次调用通过，完整输出保存 |
| 普通注册入口的正例与新 Ref 反例 | 正例业务 1 次；反例工厂/业务 0 次，预期拒绝通过 |
| 两个组合的三补丁逆向恢复、正向重放 | 每个步骤先 check 再 apply；两个组合共 24 条命令通过，九路径逐字节复原/重放一致 |
| 完整结果、包原件、声明、历史与 whitespace 核对 | 见 `verification.json`、`delivery-audit.json`，通过 |

关闭使用 Git 原样的 `sdk/tests/srt01-m4/repair-probes/probe-app-cleanup.mjs`，SHA 为 `2d8a4124083c0bdc711c7802c7e950c2cd6b1072251649a50244e6c6885de246`。没有修改断言或模拟框架关闭错误：App cleanup 主动抛出 `application cleanup callback failed once`，探针核对的正是该 Error 对象。

| 关闭后的行为 | 旧组合 | 原始 M4.3 | 新组合 |
| --- | --- | --- | --- |
| 旧工具业务进入 | 1 | 0 | 0 |
| 旧工具结果 | `entered-returned / old` | `not-entered / TOOL_UNAVAILABLE` | `not-entered / TOOL_UNAVAILABLE` |
| 健康 App 与同位置 successor | 都成功 | 都成功 | 都成功 |
| 再清理 former 后 successor | 仍成功 | 仍成功 | 仍成功 |
| 最后 unmount 的 views / bindings | 0 / 0 | 0 / 0 | 0 / 0 |
| unmount 后 retainedBytes | 回到初始 46 | 回到初始 46 | 回到初始 46 |
| Registry dispose 后 retainedBytes | 0 | 0 | 0 |

关闭探针是实际 SDK + Preact + Core Registry 组合；Planning 是默认 Source + 真实 Node Worker 组合。两者消费同一对已装 tar，但没有把前者表述为 Worker 内 cleanup 故障的全面 E2E。

Planning 从实际页面的 `Available references` 选取 `Plan:unfinished_plans[0]`，分别核对完整计划 A、B 的嵌套字段及冻结事实。原始 M4.3 将该项发布为 `unknown`，带 `Plan` 约束的读取得到 `REF_TYPE_MISMATCH`；新组合发布为 `Plan`，正确进入业务一次。两个版本都保留：同形 Order 和仅伪装名称的项被 typed Tool 拒绝；整表不能当单对象；跨 View 得到 `REF_NOT_VISIBLE`；已释放 Context 得到 `SEMANTIC_CONTEXT_RELEASED`，这些拒绝的业务进入数均为 0。新组合整表的 typed 拒绝为 `REF_VALUE_UNSUPPORTED`；原始版先因 kind 不匹配而拒绝，错误顺序原样保存。

原始/新组合的 Ref Inspector 进入次数分别为 5/7，每次完整值都与预期 Plan 对象比较。试件的普通 `fixture_stage` 另通过真实 Worker 发布更新；它不写 Ref Inspector 日志，不能把该条日志增量 0 解释为普通业务没执行。普通数字工具独立记录了真实注册 1、工厂 1、业务 1。两个 Context 最终释放后，global shutdown 之前 Core 及 observation 的全部计数和逻辑字节已为 0，authority 仍未关闭；shutdown 最终也无保留 Scope、字节、Worker pool 成员和 pending task。

## 5. 声明与原始失败

每个版本真实 build 产出的 SDK 19 份、Runtime 124 份完整 `.d.ts` 均已保存，共 429 份包声明原件；两个严格消费编译的完整 fixture 声明另存。原始 M4.3 与新组合没有增删声明文件，差异只有 SDK 的 `hooks/useArrayRef.d.ts` 和 Runtime 的五份既有补丁相关声明。逐字节差异在 `runs/01/declaration-diff.patch`，不是新的生产补丁。没有新增公共 Ref helper、协议或导出。

中间失败全部保留于 `attempts/01/evidence/checks/`：

1. `01`：真实关闭红绿已成立后，新 `ordinary.ts` 严格编译报 TS2345（需先将 descriptor.execution 收窄为 view-type）及 TS2339（错误字典返回类型缺少动态诊断字段）。这是本批测试试件问题；保存原 TS、诊断和命令后，补显式判别与诊断字典类型，未改生产。
2. `02`：普通 Ref 已实际在 Registry 拒绝，但测试对诊断 path 假定了点号写法。保存首次失败原件，再用单独标识的诊断重跑读出实际 `$.properties.plan["x-aotui-ref-kind"]`；改为精确断言现有路径。诊断重跑不计作验收。
3. `03`：修正后的消费验证通过。随后在全新目录从 Git、补丁、构建、打包、装包开始完成 `runs/01`，没有把前两项失败冒充业务红灯，也没有删除其日志。真正业务红灯始终是旧组合关闭探针的旧业务进入 1 次。
4. `attempts/delivery-audit-01`：最后审计最初将 `git diff --no-index --check` 的所有非零码当作失败。受控正反例确认当前 Git 对干净新增文件返回 1、没有诊断；尾随空格文件返回 3 并输出诊断。审计改为接受 0/1 且必须无诊断，仍拒绝空白错误。原脚本、失败命令和两个受控输出均保留；不是产品回归。

## 6. 下一项最小作者任务与未执行项

当前在线可用的是已有 `useViewSnapshotTool` 单引用读取路径，底层为 `snapshot-value-v2`。B14/B15 已签收的单项、整表和多选参数合同仍是隔离 specimen 能力；本批没有把它们描述成普通注册链已接通。普通链目前通过本批证据证明的是普通参数成功与新 Ref 声明明确拒绝。

建议负责人下一项只收敛一个最小作者闭环：让同一普通工具声明里的单个 Plan Ref，经过当前注册、来源校验、解析和有效参数校验后进入业务，并保持 ordinary invoker 所属责任、错误顺序及释放资格。先针对本批这个 Registry 首次拒绝建立业务合同，再单独授权实现范围；不要一并推进列表/多选、公共名字选择或资源历史策略。本报告只是交付该具体缺口，不提前批准方案。

未执行新 LLM 作者试验、仓库全量 Vitest、B13 两页采纳、SDK/Runtime 对外发布、Worker 内所有 cleanup 错误变体、性能或外部 App 兼容性评测。既有 SRT 作者合规结果仍为 6/9、门槛 8/9，没有被本批改变。命名、历史保留、公开作者接口和最终 Semantic 验收保持原归属，Legacy 没有退出。

独立生产 patch 为 0 字节，SHA-256：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。空 patch 不伪称通过 `git apply`；本批保护核对证明共享实际基线未变，引用的三个签收补丁另有真实正反向重放。交付清单在 `review-evidence/minimal-core-batch-20/final-delivery.json`，自身指纹在发送给负责人的交付消息中提供。
