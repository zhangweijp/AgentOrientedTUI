# Minimal Core Batch 22 交付报告

**READY_FOR_REVIEW。** 完成的是经授权的隔离样机，尚待负责人独立复核；没有将候选应用到共享生产代码，没有发布、提交、push 或 merge，也不代表正式采用、Semantic 验收或 Legacy 退出。

同一份 Batch 21 作者程序现在能通过普通 `defineViewTypeTool → defineToolSet → AppTools` 路径读取获准的 Plan。模型仍传 `Plan:plans[0]`；Core 从原 Observation 授予的原 Snapshot 解析完整对象，授权、V4 Worker 请求与业务函数得到内容一致的计划。业务只进入一次，返回 `plan_a` 收据。工具继续按 ViewType 激活，Ref 来源单独保留原页面的身份，没有改为实例工具或从当前页面重新查值。

## 1. 授权、基线与文件保护

任务依据是 [Batch 22 任务书](MINIMAL_CORE_BATCH_22_TASK.zh-CN.md)，SHA-256 `c58cac80cb976f6e0b69201985d374dc9e35de4b3ea4fff7a316dbaba407f2d7`，状态 `AUTHORIZED_FOR_ISOLATED_IMPLEMENTATION`。已阅读 AGENTS、minimalist、Batch 21 签收及负责人提醒的 Batch 11 R4；工厂自行决定低层直调校验的合同保留。

开工时保存了实际共享工作树 **11,382 个路径**的内容记录、Git 状态、HEAD、index，以及任务/输入指纹。HEAD 没有被当成当前工作树的替代基线。共享生产、其他工作树和历史文件没有被覆盖。所有者迁移的 55 份文档按核验表读取；原 B22 待授权稿及当前授权稿分别保留，没有恢复失效的共享根目录别名。[开工基线](../review-evidence/minimal-core-batch-22/baseline.json) · [实际工作树指纹](../review-evidence/minimal-core-batch-22/workspace-before.json)

按任务要求，隔离源码从 Git `853495dd9954eb4f8a91998bcc59e19326765981` 的 SDK/Runtime，加签收的 B14 R1、B15 R1、B16 三补丁重建，415 个既有路径逐一核对。两份重新打出的基线包匹配签收值：

| 包 | 基线 SHA-256 |
| --- | --- |
| SDK | `881cd00af0b01d546ff6e27d17366043e5a3570274cda98c0f26ba0e00d48995` |
| Runtime | `f10708895d3c7157fffd534bc6881936787ae2f74e9c7928daba916e27b39d78` |

开发目录为 `/private/tmp/aotui-b22-ec9foppq`；最终干净复跑目录为 `/private/tmp/aotui-b22-replay-p3hj42se`，与负责人自己的目录分开。最终源码在后者的 `candidate/`。必要原件、包和日志已复制进项目，不依赖这些临时目录继续存在。

最终整轮实际运行 Node **v24.15.0 / darwin arm64**、TypeScript **5.9.3**、Vitest **3.2.4**。部分早期直接在临时目录启动的 shell 使用 Node v23.11.0，早期日志与最终执行分开保存。根目录 pnpm 选择为 10.15.1；Corepack 在未固定的私有目录自动选择并写入 **pnpm 10.33.2**。这两份生成 manifest 与基线打包行为一致。入口保存了构建前原件和生成件，只接受 `packageManager` 这一差别，随后恢复源码原字节；它们不是生产 patch 的内容。没有升级依赖、修改共享配置或锁文件。[最终执行命令](../review-evidence/minimal-core-batch-22/runs/01/evidence/reproduce-commands.json) · [构建 manifest 记录](../review-evidence/minimal-core-batch-22/runs/01/evidence/build-manifest-mutations.json)

## 2. 独立 patch 与最终包装

[MINIMAL_CORE_BATCH_22.patch](MINIMAL_CORE_BATCH_22.patch) 仅包含 23 项候选职责白名单中的 **22 个现有生产文件**，相对于上述签收源码的实际内容生成：

```text
0b59acc9823c868c928e68def85d1fe9ad10c64e82d7401dc3b53cdf5671b22a
```

[preimage 原件](../review-evidence/minimal-core-batch-22/preimage/) 和 [候选源码](../review-evidence/minimal-core-batch-22/candidate-source/) 均保留。一次全新重建对 patch 做了正向检查、精确重放、反向检查、恢复到原字节及 `--whitespace=error-all` 检查。最终 415 个路径中只有这 22 个生产差异；另有明确分开的隔离测试试件。共享工作树保护核对见交付清单所引用的 `protection.json`。[源码差异指纹](../review-evidence/minimal-core-batch-22/source-changes.json) · [重放证据](../review-evidence/minimal-core-batch-22/runs/01/evidence/patch-replay.json) · [最终源码审计](../review-evidence/minimal-core-batch-22/runs/01/evidence/source-integrity.json)

最终消费者实际安装 `file:` tar，使用独立 store，禁用脚本、工作区链接和硬链接导入。SDK 的 **90 个**、Runtime 的 **388 个**包内文件逐字节与 tar 核对。包路径位于消费者自己的 `.pnpm`，没有把源码 symlink 伪装成包消费。

| 最终包 | SHA-256 |
| --- | --- |
| [SDK tar](../review-evidence/minimal-core-batch-22/runs/01/artifacts/aotui-sdk-0.4.0-srt01-m4.3.tgz) | `c5c750464c7151e230654fcf4ae5846df4d2a02f47876d558a4a1b48257391ff` |
| [Runtime tar](../review-evidence/minimal-core-batch-22/runs/01/artifacts/aotui-runtime-3.0.0.tgz) | `0f0896237ec113c65fcd91b4e3697229fd7b647a811eae10f8b4dbb2f4f7573b` |

[实际安装来源](../review-evidence/minimal-core-batch-22/runs/01/evidence/candidate-installed-origin.json) · [SDK 包内核对](../review-evidence/minimal-core-batch-22/runs/01/evidence/sdk-installed-files.json) · [Runtime 包内核对](../review-evidence/minimal-core-batch-22/runs/01/evidence/runtime-installed-files.json)

## 3. 每个生产文件为何修改

本批复用已有编译合同、Observation 元数据、SnapshotStore、Scope/ledger、绑定、授权、Worker 捕获和 SDK safe invoker。没有新增 owner、Map、队列、缓存、管理器、公共 SDK Ref helper 或依赖。生产文件路径均相对于隔离源码根。

| 文件 | 必要差异与剩余职责 |
| --- | --- |
| `runtime/src/core/tool/ordinary-parameter-contract.ts` | 在原编译器内增加明确的目标 profile；同一 Schema 派生模型名字与 resolved 对象检查。本批只支持零 Ref 或一个必填顶层对象 Ref，拒绝可选、列表及多 Ref；未知编译模式不开放 Ref。 |
| `runtime/src/core/tool/ordinary-parameter-profile.ts` | 严格比较两个受支持的字符串版本，再重编译完整 Schema；数组/对象不经字符串转换接纳。 |
| `runtime/src/core/tool/versioned-ref-declarations.ts` | 新 profile 复用同一编译器识别 Ref 字段；旧单页 Ref 声明检查保留。 |
| `runtime/src/core/tool/view-owned-tools.ts` | 普通注册使用新编译 profile，并升级 port 版本。现有 activation、完整 definition、预算、token cleanup、工厂重入与低层直调资格继续由 Registry 承担；没有全局强制校验低层 invoke。 |
| `runtime/src/core/tool/snapshot-value-arguments.ts` | 在已有解析模块中加入新模式的同步准备：匹配原 grant 的完整 owner triples，再从原 Snapshot 取值。复用原参数/包络上限和 lease 释放；包络只计 source、effective、sources，raw 独立有界。旧实例 helper 不变。 |
| `runtime/src/core/invocation/observation-registry.ts` | 将同一 Observation 已捕获的完整 Ref identities 交给调用准备，不新增来源状态或镜像。旧 `visibleRefIds` 行为保留。 |
| `runtime/src/core/invocation/scoped-interaction.ts` | 在原执行流程中接入新准备、验证后及授权后的重新校验；比较 effective 值与来源。原 owner、ledger、读取授权及真实结算继续负责生命周期。无 Ref 输入仍守原 ordinaryInput 上限。 |
| `runtime/src/core/invocation/scoped-interaction-types.ts` | 增加新 binding mode；保留纯 Core 的旧 ordinary/snapshot binding 合同。 |
| `runtime/src/spi/worker-protocol/messages.ts` | 增加成对 V4 消息，显式分开 ViewType execution 与 raw/effective/七字段 Ref 来源。旧单页消息仍在。 |
| `runtime/src/spi/runtime/app-interaction.interface.ts` | Host 支持的新普通模式与原单页 Ref 模式明确列出，默认同时启用；不暗中降级 ordinary V3。 |
| `runtime/src/spi/runtime/app-type-tools.interface.ts` | 普通 authoring port 版本协调为 v2。 |
| `runtime/src/spi/app/app-factory.interface.ts` | 工厂 marker 类型协调为 v2。 |
| `runtime/src/adapters/worker-message-capture.ts` | 增加并协商 V4 capability，保留原 Ref V3 capability；原完整 JSON 捕获与终态规则不变。 |
| `runtime/src/adapters/ordinary-invocation-v2.ts` | 现有普通 adapter 收敛为 V4 精确外壳与参数/来源一致性检查，复用已捕获对象及原预算。没有复制另一套生命周期。 |
| `runtime/src/adapters/app-authoring-protocol.ts` | 现有 getter-safe 工厂检查使用 v2 字面值。 |
| `runtime/src/engine/app/worker-host.ts` | 新普通 binding 消费原 InvocationContext，发送 V4，并按当前 Worker/instance/版本关联终态；旧 Ref V3、超时与关闭记录沿用原路径。 |
| `runtime/src/worker-runtime/index.ts` | V4 使用普通 Registry；原 Ref V3 继续用原 receiver。两者都沿用 flush 后发布终态、INIT 和撤销门禁。普通 V3 明确拒绝，不回退。 |
| `runtime/src/worker-runtime/ordinary-invocation-v2.ts` | 在真实当前 binding 比较后验证新参数，再把同一 effective 值交给现有 callable；异常后不伪造未进入。 |
| `runtime/src/worker-runtime/app-kernel/AppKernel.ts` | 现有 authoring port 改为 v2，其他调用及释放合同保留。 |
| `sdk/src/app-factory/createTUIApp.ts` | 工厂发出协调的 v2 marker。 |
| `sdk/src/tools/view-type-tool.ts` | 复用现有声明、类型推导、AppTools 和绑定生命周期，只对齐 port v2。声明仍使用已有本地 RefValue 样例，不让作者增加步骤。 |
| `sdk/src/utils/ordinary-parameter-tool.ts` | 使用同一 Runtime 编译合同的 resolved validator；原 handler 异常、effects 与最终 canEnter 门禁不变。 |

白名单里的 `v3-validator.ts` 无须修改：它调用的 `compileOrdinaryProfile` 与声明检查已经识别新 profile，真实 commit 和原 R1 验收证明该入口工作。两项标明直接复用的 `source-binding.ts`、`semantic-capability-policy.ts` 保持原字节。Snapshot schemaVersion 仍为 3，七字段 Ref 来源、保留策略、lease、额度和 receipt 合同没有重设计。

简化的是目标普通工具在各层的解释：参数声明是一份；工具的 ViewType 激活与数据的原页面来源不再混为一种身份；新普通 IPC 只有一种明确包络。旧单页工具尚未迁移，因此其既有路径保留，不把本批当成旧入口退出。

## 4. 行为与有效红绿

### 原作者程序没有修改

原作者 TSX SHA-256 为 `d9ce510d93b9a03cf648d63e9d2acdf6c6d807943ff3c0178a4c5656d378e944`；编译后的 `ordinary-app.js` 为 `76839780661ae89f2151411d75258275f4fa1da535f37ef3848cf44cc1ca762f`。原件真实保存在 [frozen-author](../review-evidence/minimal-core-batch-22/frozen-author/)，包括 `dist`，均列入最终清单。

基线以真实签收包、默认 Source、真实 Node Worker 执行，严格编译已通过后才在生产注册处拒绝：`TOOL_BINDING_COMMIT_FAILED` / `PARAMETER_DECLARATION_UNSUPPORTED`，公开 install 为 `INSTALL_FAILED`，业务 0 次。缺依赖、类型或测试设置错误没有被算作有效红灯。[本轮重新执行的原包输出](../review-evidence/minimal-core-batch-22/runs/01/signed-original-replay/ordinary.json)

候选用同一作者程序和未改的 R1 acceptance/route gate 成功：原观察 binding 是 `view-type`、activation 与 descriptor 一致，Ref 的 viewId/viewInstanceId/snapshotId 与观察授予来源逐字段匹配，授权/dispatch/业务得到同一份 A，只有一次真实业务与一次响应，收据为 `plan_a`，关闭释放成功。作者新增解析、二次声明、自行授权步骤均为 **0**。[完整绿灯与身份链](../review-evidence/minimal-core-batch-22/runs/01/evidence/candidate-author.json)

两份精确的 B21 错误 AppTools 副本也分别在原包和候选包重新运行。旧业务成功断言仍误过，修订门禁分别以 `ROUTE_EXPECTED_VIEW_TYPE` 和 `ROUTE_REF_SOURCE_COUNT` 拒绝；两种错误没有被候选实现掩盖。这是验收敏感性实验，改动仅在各自一次性 SDK 消费副本中。[候选错误捷径结果](../review-evidence/minimal-core-batch-22/runs/01/evidence/candidate-adversaries.json) · [原包错误捷径重跑](../review-evidence/minimal-core-batch-22/runs/01/signed-r1-replay/result.json)

### 原来源、门禁与资源

真实补充 App 从 A 更新到 B，同名 Ref 每次只授予一个页面。仍持有的原 Context 读 A，新 Context 读 B；这三条调用再次经过同一 R1 身份检查，业务得到冻结的完整 JSON。两个 PlanPage 只暴露一组 read/add_one；普通数字 2→3。

| 路径 | 结果 |
| --- | --- |
| 直接上传 Plan 对象 | `TOOL_INVALID_ARGS`，业务/业务请求 0 |
| 猜未授权名字 | `REF_NOT_VISIBLE`，业务/业务请求 0 |
| 选择 Other 业务种类 | `REF_TYPE_MISMATCH`，业务/业务请求 0 |
| 观察有效、执行 policy 拒绝 | `TOOL_PERMISSION_DENIED`，业务/业务请求 0 |
| 释放旧 Context 后调用 | `SEMANTIC_CONTEXT_RELEASED`，业务 0 |
| authorize 屏障内释放原 Context，再恢复 authorize | `OBSERVATION_UNAVAILABLE`，业务/业务请求 0；挂起时真实 activeInvocations、activeReads 和 lease 仍保留 |
| 最后匹配页面关闭 | `TOOL_UNAVAILABLE`，业务 0 |
| 关闭再重开后调用旧 activation | `TOOL_SOURCE_STALE`，业务 0 |

直接发给真实 Worker 的 15 个坏 V4 请求覆盖对象 raw、缺 provenance、param/name/snapshot/kind/refType 不符、空 owner、坏 payload、完整 Tool 合同不符、实例 execution、旧 activation、错 App instance、多余字段、过大展开值；均在业务前拒绝。Worker 核对捕获、合同、字段和当前注册，**它不能独立证明 Host 曾授予某个历史 payload**；原 Observation 授予和从原 Snapshot 解析仍由 Host/Core 证明，测试没有把可伪造的来源字符串当成授权证明。[全部调用、授权、wire 与资源](../review-evidence/minimal-core-batch-22/runs/01/evidence/update.json)

最后一个本地 Context 释放后、全局 shutdown 之前：Scope、Observation、reservation、Entry、在途调用/读取、全部 Scope 逻辑字节及 activeLeases 都为 0，此时 Core `closed=false`。SnapshotStore 仍有当前快照和历史数据，这是未改变的历史策略；没有把它写成数据全部清空。最终 Runtime close 的 `ok/resourcesReleased` 均为 true。

### 旧单页路径、预算与严格版本

原 control 在候选上确实执行了一次旧单页 Ref 和一次普通数字业务，但其后固定旧普通 V3 wire 的断言失败，原件与失败输出保留。另建仅适配版本、字段和未来未知版本值的隔离 harness；业务断言及身份断言不降低，旧 Ref V3 与新普通 V4 的两条 gate 均通过。每处改动有独立 diff，未改写历史原件。[原 control 的版本断言失败](../review-evidence/minimal-core-batch-22/runs/01/evidence/control-original-wire-version.json) · [适配后完整 control](../review-evidence/minimal-core-batch-22/runs/01/evidence/control-v4.json) · [wire 适配 diff](../review-evidence/minimal-core-batch-22/runs/01/evidence/control-wire-adaptation.patch)

负责人原始预算 App/runner 在基线和最终包上得到完整相同的 cases/business：64、80、120 KiB 成功，140 KiB 按既有预算拒绝。Ref 加同等大普通附加参数也成功，完整计划、文本、授权与 wire 内容一致；140 KiB 拒绝。没有抬高任何上限，完整传输仍受原 512 KiB ceiling 保护。[原预算基线](../review-evidence/minimal-core-batch-22/runs/01/evidence/baseline-budget.json) · [最终普通预算](../review-evidence/minimal-core-batch-22/runs/01/evidence/candidate-budget.json) · [Ref 与大附加参数](../review-evidence/minimal-core-batch-22/runs/01/evidence/candidate-ref-budget.json)

版本 marker 必须是精确字符串；数组、对象、空值、过大值及 getter 均拒绝，getter 读取 0 次。`compileOrdinarySchema` 的 `v999 / false / null` 等未知 profile 与基线完整拒绝输出一致；没有借新 profile 扩大旧 Core 输入面。单个必填对象、可选/多项/列表拒绝及 model/resolved 两种表示另有明确边界测试。[marker](../review-evidence/minimal-core-batch-22/runs/01/evidence/candidate-profile-marker.json) · [未知 profile 前后对照](../review-evidence/minimal-core-batch-22/runs/01/evidence/candidate-unknown-profile.json) · [单项合同](../review-evidence/minimal-core-batch-22/runs/01/evidence/qualified-profile.json)

## 5. 实际新旧组合

每组都安装真实 tar，并分别执行同一份 Plan 作者程序和数字 App；交叉 Host/Worker 使用两个真实包的 Worker entry，没有只改常量模拟。

| SDK / Runtime 或端点 | 实际结果 |
| --- | --- |
| 旧 SDK + 旧 Runtime | 原 Plan App 在注册处红灯；合法数字与原单页 Ref 对照通过 |
| 新 SDK + 新 Runtime | 原 Plan App 普通路径成功一次，数字 2→3，原单页 Ref 保留 |
| 旧 SDK + 新 Runtime | Worker `APP_AUTHORING_PROTOCOL_UNSUPPORTED`，公开 Host `INSTALL_FAILED`，目标业务 0；同 Desktop 健康新版 App 可执行 |
| 新 SDK + 旧 Runtime | Worker `APP_AUTHORING_PROTOCOL_UNSUPPORTED`，公开 Host `INSTALL_FAILED`，目标业务 0；健康旧版 App 可执行 |
| 新 Host + 旧 Worker | INIT `WORKER_CAPABILITY_UNSUPPORTED`，公开 Host `INSTALL_FAILED`，业务请求/业务 0 |
| 旧 Host + 新 Worker | INIT `WORKER_CAPABILITY_UNSUPPORTED`，公开 Host `INSTALL_FAILED`，业务请求/业务 0 |

receiver 错误和公开 Host 错误分别保存在完整 JSON。两个纯端点错配没有降级、重绑定或重试。[矩阵命令](../review-evidence/minimal-core-batch-22/runs/01/evidence/matrix-commands.json) · [结果索引](../review-evidence/minimal-core-batch-22/runs/01/evidence/matrix-result.json) · [每包安装来源](../review-evidence/minimal-core-batch-22/runs/01/evidence/matrix-installed-origin.json)

## 6. 现有回归、类型与声明

最终整轮来自 patch 重建的新 dist，测试命令、cwd、退出码、原始输出完整保存。去重后的既有合同覆盖为：

| 执行组 | 文件 / 项目 | 结果 |
| --- | --- | --- |
| 未改的基线 Runtime | 19 / 722 | 通过 |
| 未改的基线 SDK | 4 / 51 | 通过 |
| 候选未改的 Core 等 | 15 / 665 | 通过 |
| 候选未改的 SDK helper/static/真实绑定 | 3 / 35 | 通过 |
| 候选 SDK：只迁移 port 字面值的隔离副本 | 1 / 16 | 通过 |
| 候选 Runtime：只迁移传输/内部接收函数的隔离副本 | 4 / 57 | 通过 |

候选合计 **773 项**，与基线同一组语义断言对应；不把早期重复执行另加进总数，没有新 skip。迁移的五个测试保留原件、全部断言及逐行 diff，原源码中的测试未修改。Runtime 57 项包含 **15 条真实 Worker** 场景：去重、逐次读取权限、旧 A/新 B、已进入的工作关闭、超时晚响应、未知结果不重试、池化及大 Ref。该既有 Worker 文件的业务主体是旧单页 Ref；新 V4 的真实同步、异步授权撤销及发布链在专项 Node 探针验证，不能把这一组扩大解释为所有新 V4 异步情形。[完整回归命令](../review-evidence/minimal-core-batch-22/runs/01/evidence/regression-commands.json) · [隔离测试迁移原件与 diff](../review-evidence/minimal-core-batch-22/runs/01/evidence/migrated-tests/)

低层公开 Registry 的两种工厂再次通过包名消费：不自行验证的受信工厂仍能收到坏值，自行验证的工厂仍拒绝，撤销后均拒绝旧调用，前后完整业务结果一致。没有将新路径的校验强行加给全部 `invokeTypeTool`。[原低层直调](../review-evidence/minimal-core-batch-22/runs/01/evidence/baseline-public-registry.json) · [候选低层直调](../review-evidence/minimal-core-batch-22/runs/01/evidence/candidate-public-registry.json)

已保存 **286 份真实声明原件**：基线/候选各 124 Runtime、19 SDK，不是仅存哈希。14 份发生必要变化，包含新版本、V4 消息、Ref 准备返回类型、内部函数与 resolved validator；完整 diff 可审阅。公共 Core 导出清单前后一致，准备 helper 没有被公共 entry 导出。严格 ES2022-only、`strict=true / skipLibCheck=false` 的旧/新纯 Core 包消费、实际运行均通过；作者及四组包的真实语义编译通过。[声明结果](../review-evidence/minimal-core-batch-22/runs/01/evidence/types-result.json) · [完整声明原件](../review-evidence/minimal-core-batch-22/runs/01/evidence/declarations/) · [类型命令](../review-evidence/minimal-core-batch-22/runs/01/evidence/types-commands.json)

**既存失败：**将整个 Runtime 的库检查改为 `skipLibCheck=false`，基线与候选均退出 2，出现同样 **130 项 linkedom DOM 声明错误**。两份完整诊断逐字节一致，SHA-256 `9010658721e270b218e6ad3190d1b3738604caf075e2c46ed177bcdf560b8e4e`。未改依赖或绕过类型，未将失败命令算作严格检查通过；生成于失败编译的声明没有冒充语义通过证据。[既存类型失败记录](../review-evidence/minimal-core-batch-22/runs/01/evidence/existing-strict-dependency-failure.json)

## 7. 中间失败、修正与边界

所有可用的中间输出与负责人独立发现的原始回归均在 `intermediate/`，不与最终通过证据混写。

- 早期实现曾移除新组合中的旧单页 Ref 协商；负责人复现后恢复原模式、capability 与 receiver。未恢复旧普通 V3 回退。
- 早期 `String(marker)` 和 `profile !== undefined` 放松了版本选择；均改回精确判断，并补前后负例。
- 早期 raw/effective 在 136 KiB envelope 中重复计数；改回原 source/effective/sources 责任，原参数与 wire 预算保留。
- 开发时出现过类型导入/联合类型错误、私有 `.bin` 没有 vitest、补充试件非法 app_name、测试旧版本字面值，以及新 Core 消费试件的 Promise/清理 API 写法错误。完整可用日志保留；这些均不作为有效红灯。最初一次未重定向的构建工具输出未完整封存，保留随后有日志的构建错误及最终干净重建作为验证依据，不补造日志。
- 第一轮干净重建在最后源码核对发现 Corepack 自动写入两个 packageManager 字段；保存失败并修正复跑入口的记录/恢复步骤。第二轮完整重建通过，源码 patch 没有引入这两个文件。

没有运行模型作者评测、真实 LLM、真实 Planning/IDE/Terminal/Browser 全量采用、GUI、实网或整仓全量套件。没有验证或改变重名策略、列表/多选、旧数据寿命、旧入口退出及所有者的最终 Semantic 验收。Worker 只验证受信 Host 提供的已解析内容的一致性，历史授权真实性仍由 Host 证明。此样机不是跨信任 Host 的授权协议。

## 8. 复跑与提交复核

在项目根目录运行：

```bash
python3 review-evidence/minimal-core-batch-22/reproduce.py
```

入口在全新 `/private/tmp/aotui-b22-replay-*` 重建签收基线、重放 patch、构建并装包，运行原作者红绿、负例/矩阵/回归/类型/声明及精确恢复门禁；不引用旧临时工作树作为源码输入，不写共享生产。它依赖开工已存在并记录解析路径的本地第三方依赖和 Git 对象，不承诺无依赖安装环境或联网复现。最终本轮重建日志及全部底层命令已保存。

交付索引：[README](../review-evidence/minimal-core-batch-22/README.zh-CN.md)。最终精确文件清单、来源分类、保护核对和本报告指纹见 [final-delivery.json](../review-evidence/minimal-core-batch-22/final-delivery.json)。状态停在 **READY_FOR_REVIEW**，由负责人独立复验和决定是否采用。
