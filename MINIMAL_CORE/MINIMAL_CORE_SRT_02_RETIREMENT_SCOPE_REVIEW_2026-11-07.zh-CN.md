# SRT-02 旧 Snapshot Tool 收尾范围：独立复核

2026-11-07。**APPROVED，限定静态范围及八文件隔离迁移证明的准备。** 可以在全新副本迁移指定测试／消费者、准备断言映射和实际运行入口；首次项目行为运行仍须由 Minimal Core 核对具体入口。没有批准修改内核、删除生产路径、共享采用或最终 Semantic 验收。

## 独立依据

原 [范围文档](../SRT-02_SNAPSHOT_TOOL_RETIREMENT_SCOPE.zh-CN.md) SHA-256 为 `85c1e52ffe67c9e40498b033c806062a7b3b5ddfb073d18a43ed7603086fb999`；[submission.json](../review-evidence/srt-02-retirement-scope-20261107/submission.json) 为 `b9f0bad3c48f1393bd1a8269560cd5f2da52d33bb18649bc9ef44152440d1dd2`。原 14 件证据未改写；入口注意、D1/D2 澄清和 w10 修订要求以三份追加索引封存并纳入本裁决。

负责人独立核对了：

- 已签列表候选 418 件源码、两份精确 tar、原 patch 与签收引用。
- SDK／Runtime 指定扫描的 329 件输入、84 个命中文件及 518 行；另外 74 个边界文件及 336 行。重新执行相同只读搜索并逐行比较，没有把文本匹配当作删除许可。
- 共享 App／Host／Driver 指定扫描的 325 件输入及全部 4 文件／5 行命中，均为 IDE 文档或配置；这不证明未知外部或动态消费者不存在。
- 原开发候选 Planning 63 件文件与精确 tar，以及实际声明中的 12 个工具：10 个各含一个必填 Ref，2 个没有 Ref。未访问用户手测状态。
- 八个拟迁移文件和后续 35 个生产影响面文件的当前指纹。旧 64 文件清单仅 29 件相同，其余 35 件变化，不能直接沿用作删除清单。

本轮没有启动 Runtime、Worker、Host、IDE、LSP 或模型，没有新增行为测试成绩。[核对脚本](../review-evidence/srt-02-retirement-scope-20261107/owner-review/verify-scope.py) · [独立结果](../review-evidence/srt-02-retirement-scope-20261107/owner-review/static-verification.json) · [18 条源码事实](../review-evidence/srt-02-retirement-scope-20261107/owner-review/semantic-source-facts.json)

## 技术判断与 D1／D2 限定

普通 Tool 已支持现有消费者需要的单对象和单个对象列表。当前没有找到必须先扩展多必填 Ref 才能迁移的真实消费者。下一步优先验证旧 Hook、旧参数方言和旧执行分支的职责能否由现有声明、参数准备、授权、普通 Worker 调用及关闭机制接替。多 Ref 等 TODO 保留，不以补齐参数形状为理由增加新接口。

**D1：同意验证明确获准的跨页面 Ref；原隐藏／未获准负向必须保留。**

AGENTS.md 第 2.3 节确认 Tool 按 App＋ViewType 共享，业务对象可由 Ref 选择。当前 `prepareViewTypeParameters` 从 Observation 获准引用中找唯一项，再校验真实 owner、类型和 payload，并没有一个隐含的 Tool 页面实例目标。这个机制可以承载同 App 的另一页面所发布、明确获准且不歧义的 Ref。

但原 `foreign-ref` 场景只观察 aa，policy 也只授予 aa 的 Ref；`private-bb` 实际未获准。它迁移后必须继续 **0 派发／0 handler**，不能改成成功。另加两页都明确获准且名字唯一的正向，并单列“两页同名且都获准”的歧义负向。隐藏、外 App／执行实例、伪造来源、错误类型及 Schema 的拒绝责任继续在框架。

**D2：同意制作关闭后的差异证明；不据此永久决定旧 Ref 的关闭生命周期。**

当前 `unmount` 只有在同类型 View 数量归零时才撤销类型 activation；`acquireToolSource` 对普通 Tool 校验该 activation，对旧实例 Tool 则额外校验其具体 View 绑定。原旧 Ref 场景的 0 派发保证与普通 Tool 的业务 guard 是不同保证，迁移报告必须公开这个差异。

试件已经有 App 自有的 `order/mounts/enabled`，可复用为业务对象与业务会话检查，并放入 Ref payload，模型继续只传 Ref。不得新增 View／Ref 资格管理器，不让 App 管 Runtime 的 viewInstanceId、原始 Ref owner、grant 或 Observation 生命周期。仅 A 关闭而同类 B 仍存在时，若业务要求 A 当前会话仍打开，应真实记录 **1 派发／1 handler／1 guard 拒绝／0 业务副作用**；普通 TS 路径没有 Worker，不填写虚假的 Worker 派发数。

原 `actor.calls` 与 `DUAL_HANDLER_ENTER` 在 guard 之后才增加，只能表示通过 guard 后的业务进入。迁移必须在真实 handler 第一行记录独立入口，并把派发、handler、guard、业务执行及效果分开。最后匹配 View 关闭、整个 Tool 禁用／重绑、App 重置、显式 Observation／scope release 后，原有框架拒绝仍须保留。单个业务对象的 enabled 与整个 Tool 的 enabled 不能混写。

本次准入的是对照证据制作，不把“仍可解析旧 payload”升级为永久产品规则，也不把 guard 的零副作用写成旧框架保证等价保留。SRT-05 的自动观察交接和旧数据立即释放仍未完成。生产删除范围审查必须再次列出保留保证、实际变化及尚需上级负责人决定的产品语义；不能由实施者自行消除这些未决项。

## 八文件范围与入口要求

只允许修改原 `proposed-file-scope.json.nextCandidate.sourceChanges` 的八个文件，在新隔离副本中实施：

1. `runtime/tests/w10-package-consumer.mjs`
2. `runtime/tests/fixtures/dual-producer-app.mjs`
3. `runtime/tests/fixtures/dual-producer-business.mjs`
4. `runtime/tests/fixtures/ref-v2-slice.mjs`
5. `runtime/src/e2e-test/fixtures/snapshot-value-sdk.mjs`
6. `runtime/src/engine/app/worker-host.dual-producer-e2e.test.ts`
7. `runtime/src/engine/app/worker-host.ref-v2.test.ts`
8. `runtime/src/engine/app/worker-host.scoped-interaction-e2e.test.ts`

源码基线与 tar 保持只读；SDK／Runtime 生产逻辑和公开入口不变。可以新增本次证据及限定测试运行脚手架，不新增产品模块。需要第九个源码文件、协议或内核修改时，先交具体阻断与限定范围修订。

入口准备必须包含以下已发现事项：

- **w10 只跑 SDK／Runtime Ref 子集。** 前段生成的 SDK 类型文件也导入 IDE，须连同后段真实 IDE／LSP 一起隔开；原 IDE 类型、工厂协议及运行断言保留在未执行的完整流程中。不安装身份未知的 IDE 包，不宣称完整 w10 通过。
- **真实 Source 使用非空 instruction。** `includeInstruction:false` 不能证明没有加载默认指令。父进程与 Worker 均使用明确的新 AOTUI_DATA_DIR，写入与读取路径逐项列明，不改变 HOME。
- **公共示例返回短收据。** 原 inspect_snapshot 的正文结果改由测试专用见证验证 payload／原观察来源，最新业务正文通过 View 呈现。原数据一致性断言必须迁移；私有 Core／协议测试中的受控数据结果另标测试用途，不据此改整个结果协议。
- **旧字面量修正单列。** w10 仍有旧 mode／工厂协议字面量；修订要对应精确候选公开合同，不能把旧脚本描述成已经适配。正常包管理器安装仍未验证，不能临时改安装方式补齐依赖。
- **保留真实退出和清理。** 列明创建、状态目录、输出、barrier 及关闭责任；超时或终端丢失不能当作成功关闭。所有首次运行与修订使用新输出路径，失败保留，不覆盖历史目录。

这些准备可继续开展，无需所有者重复确认日常技术工作。首次运行入口由 Minimal Core 独立审查；本次不直接准入尚未写出的命令。

## 准出、风险与下一条 Prompt

下一交付为 PREPARATION_READY_FOR_REVIEW：八文件 patch、精确 preimage、逐条旧断言→新位置／新断言／变化理由、实际入口命令、依赖解析、包／生产文件未变证明、合成状态路径和完整关闭责任。随后真实验证必须覆盖原数据、双 Producer、四类计数、受控授权撤销、重复调用／冲突、结果失败与未知、整体容量及资源清理；具体测试映射须先于执行提交。

后续 8 个整文件删除候选及 27 个局部裁剪文件只是静态影响面。SDK public export、共享 `snapshot-value-arguments`、View mount/unmount、Ref owner、普通 invoker 类型及协议拒绝等不能按旧符号一起删除。未知第三方、普通安装、共享采用和最终 Semantic 均未覆盖。MC-HOST-PREVIEW-01 仍 OPEN、第三轮 Host 仍 NOT_ADMITTED，私有手测环境不操作。

**Codex Prompt：**

> 你负责 SRT-02 八文件旧消费者迁移证明的准备，按本独立裁决和三份追加澄清执行。以已签列表 source-final 418 文件及 SDK 43259156…／Runtime 3a3a5832… 为只读输入，在新独占副本仅修改清单八文件；生产内核、公共入口和原 tar 不改。D1 保留原未获准 foreign-ref 负向，另加明确获准跨 View 正向与歧义负向。D2 复用 App 已有业务会话，在 handler 第一行记 entry，分别记录派发／guard／业务效果；公开 0→1 派发的语义差异，不宣称旧生命周期等价或 SRT-05 完成。w10 同时隔开 IDE 类型及运行段，公共正文回归 View、短收据和测试见证分离。先交八文件 patch、逐断言映射、精确输入与依赖、实际非空 instruction、父／Worker 新状态路径、限定命令及创建／关闭责任，状态 PREPARATION_READY_FOR_REVIEW；经入口复核再运行。需要第九个源码或内核变化先报具体阻断。你不是唯一执行者，不覆盖他人修改，不触碰手测状态，不启动 Host／模型、不安装／发布／推送／合并，不重跑封存输出目录。
