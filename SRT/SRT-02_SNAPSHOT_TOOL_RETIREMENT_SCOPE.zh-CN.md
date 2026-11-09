# SRT-02：旧 Snapshot Tool 消费者迁移与退出范围

2026-11-07。状态：**SCOPE_READY_FOR_REVIEW**。本文件是只读范围审查；没有实施消费者迁移、删除生产代码或批准共享采用。下一批建议先做八个测试／消费者文件的迁移证明，再单独审查生产删除候选。范围与入口尚待 Minimal Core 独立复核。

## 1. 结论与顺序

旧 `useViewSnapshotTool` 的现存可执行消费者是框架试件、公共包消费者及直接 Core 测试。指定扫描范围内，没有发现产品 App 源码直接调用该 Hook；IDE 的示例和测试配置仍选择旧模式。已经独立签收的 Planning 使用普通 Tool：12 个操作中，10 个各使用一个必填对象 Ref，另两个分别接收创建内容和空参数。

因此，**目前没有发现迁移这些消费者必须先支持多个 Ref 的需求**。这不是取消多个 Ref、可选 Ref、Ref 数组等既有 TODO，也不是声称所有外部消费者都已查明。完整 SRT-02 目标仍按 `deepseek_review.md` 管理；[多必填 Ref 提案](SRT-02_MULTI_REQUIRED_REF_SCOPE.zh-CN.md)保持未准入。

建议次序：

1. 确认第 4 节两项实例绑定语义的迁移规则，准入八文件消费者迁移证明；生产 SDK／Runtime 使用已签收对象列表候选，不修改内核。
2. 证明完成后，按明确的旧断言→保留断言映射提交删除候选，移除旧 Hook、参数编译／解析、注册、协商与执行分支；不长期维护新旧双轨。
3. 审查正式包元数据与普通包管理器消费，再谈共享采用。其他 Ref 参数组合、SRT-05 观测采用及最终 Semantic 验收分别跟踪。

## 2. 精确基线与证据

共享 HEAD：`8938449925ada2f92e072e1c0492af8f2428d14f`，共享树仍有大量既存变更，不能作为已签收列表候选。此次静态审查以 `.tmp/srt-02-list-ref-candidate-20261107/source/` 为 SDK／Runtime 依据，逐件核验冻结 `source-final.json` 的 **418 文件，全部相符**。

| 对象 | 精确身份 |
| --- | --- |
| 已签收列表 SDK tar | `43259156c661f0e5b83b2e0fea0040c4ae46bb110bd7be88158de1ca3249be84` |
| 已签收列表 Runtime tar | `3a3a5832a85f3acd997849b28b34f305c5ab1cf3f11115f5c2d6072422f54a7c` |
| 列表候选源文件归档 | `e1399464b0cd182d91a9387d73e58ce68074d5898a2fab887271ed9a48257a9d` |
| 列表六文件 patch | `177720424ee236f5374722f82fa3ce691366c3f0a6689317e4ddce2d09b17fca` |
| Planning 已签收 tar | `ac41d296facd7503d5838a57dc0507aee3c1a32e9beba576505143d88e8140c1` |

列表独立裁决：[APPROVED](MINIMAL_CORE/MINIMAL_CORE_SRT_02_LIST_IMPLEMENTATION_REVIEW_2026-11-07.zh-CN.md)。其 28 Core、91 SDK、273 Runtime、两版严格类型及四包组合证据保持原封；本次没有重跑。这些历史结果不等于迁移或删除已经通过测试。

列表包相对旧包恢复了源码 `prepublishOnly` 与 `pnpm.overrides`，包括本地 link。既有消费者采用 tar 解包及显式依赖链接；普通 npm／pnpm 安装和发布没有验证。[元数据边界](review-evidence/srt-02-list-ref-candidate-20261107/PACKAGE_METADATA_ADDENDUM.zh-CN.md)继续有效。

本批证据在 [review-evidence/srt-02-retirement-scope-20261107](review-evidence/srt-02-retirement-scope-20261107/)：

- `identity.json`：Git 状态身份、418 文件核对、历史签收与清单指纹。
- `candidate-sdk-runtime.json`：329 个指定 SDK／Runtime 源码、测试、类型输入及文档文件，扩展旧符号扫描命中 **84 文件／518 行**。
- `shared-app-host-driver.json`：共享 `demo-apps`、`host/src`、`agent-driver-v2/src` 共 325 个文件，命中 **4 文件／5 行**，均为 IDE 文档／示例／测试配置。
- `execution-boundaries.json`：补充 View 实例执行、target selector、SafeRefInvoker 等交叉引用，命中 74 文件；与前一清单重叠，不能相加当作待删文件数。
- `planning-consumer.json`：核验原 Planning 63 个清单文件与 tar；记录 12 个 Tool 对应 Schema、10 个单 Ref 操作。只读原开发候选，不读取用户手测状态。
- `previous-inventory-comparison.json`：原 64 文件扫描仅 29 个与本次相应源相同；其余 35 个指纹不同，不能把旧扫描当作当前精确候选的删除清单。
- `proposed-file-scope.json`：八文件证明范围，以及后续 8 个整文件删除候选、27 个共享文件裁剪候选；后两组未准入。

扫描只覆盖上述显式路径的文本引用。动态加载来自外部的 App、外部包消费者、计算产生的属性访问没有被穷尽证明；不据零匹配声称公共兼容性不受影响。未扫描用户手测目录，未启动 Runtime、Host、Worker 或模型。

## 3. 实际消费者逐项处理

下表源码均相对已签收列表候选 `source/`；共享 IDE 和原 Planning 单列，不能混成同一源码身份。

| 消费者 | 实际职责与输入 | 普通 Tool 能否接替；必须证明什么 |
| --- | --- | --- |
| `runtime/tests/w10-package-consumer.mjs` | 公共类型消费者 `inspect_record`；真实包流程 `inspect_snapshot`。各一个必填对象 Ref；验证编辑后的最新 View。 | 可使用 `defineViewTypeTool`、`refParam`、`AppTools`，保持 `isMutating:false`。显式发布类型与完整 Ref 名；核对原 payload、类型只读与最新 View。该历史脚本还保留 `ordinary-v2`／v1 工厂协议字面量，须按精确基线同步并单列差异，不能称原脚本已适配当前候选。 |
| `runtime/tests/fixtures/dual-producer-app.mjs`、`dual-producer-business.mjs` 与 `worker-host.dual-producer-e2e.test.ts` 内普通 TS Producer | Preact 与普通 TS 的相同行为序列；旧 `read_ref` 单对象，普通字段有默认值／枚举／范围。旧路径按 View 分别注册。 | 两种 Producer 共用静态类型声明、App 绑定与 typed Ref；保留相同业务序列和实际次数。跨 View、仅一个实例关闭的旧断言不能机械照抄，依第 4 节拆开框架与 App 校验。 |
| `runtime/tests/fixtures/ref-v2-slice.mjs` 与 `worker-host.ref-v2.test.ts` | inspect、capacity、open_ref、typed、六个特殊参数名；每个 Tool 一次只有一个 Ref。大数据是对象内嵌列表，不是多个 Ref。 | 形状可由一个对象 Ref 表达；开放普通字段、字面 metadata、特殊 own key、动态 schema 变化、失败分类、冻结与预算必须逐项保留／验证。不能用 SDK capture 成功代替 Core 注册与实际执行。 |
| `runtime/src/e2e-test/fixtures/snapshot-value-sdk.mjs` 与 `worker-host.scoped-interaction-e2e.test.ts` | read／typed／diagnostics，各一个 Ref；授权暂停、原快照、重复调用、结果异常、终端丢失、池复用与关闭。 | 普通 Tool 可承载这些参数；保留真正的 Worker、受控 barrier、业务入口计数和资源结果。已有同 invocation 去重检查不扩展为新并发调度设计。 |
| SDK Hook 集成、公共导出与类型测试 | `read-only-ref-tools.test.ts`、`view-type-tool.integration.test.tsx`、`view-tool-types.test.ts`、`public-api-contract.test.tsx`、`type-tests/public-api.ts` 等。 | Hook 专属形状／兼容 port 检查在退出阶段删除；参数捕获、提交失败、handler 更新、旧 cleanup 不误删、只读类型等仍有价值的断言迁到普通 Tool 测试。不得整文件按名字删除。 |
| Runtime 直接注册、旧 codec／参数 profile 单元测试 | 旧 `registerSnapshotValueTool`、`snapshot-value-params-v1`、V3 Ref wire 的测试调用，不是产品 App 需求。 | 专属成功入口最终退出；拒绝未知合同、身份／来源、预算、授权后重验、结果终态和释放责任保留在普通 V4 路径。旧成功用例不能全部改成“失败即可”。 |
| 共享 IDE 四个命中文件 | `examples/local-scoped-ide.mjs`、`tests/ide-test-harness.mjs`、README、SCOPED_IDE；只是选择／说明旧模式，App src 无 Hook 调用。 | 后续移植到同一隔离采用基线后更新支持模式和文档。文件路径保持有业务含义的普通参数；本批不改共享 IDE。 |
| 已签收 Planning | 10 个对象操作各一个必填 Plan／Phase／Task Ref；create 普通内容、close 空参数。 | 已走普通路径，没有旧 Hook 迁移阻断；不用追加多个 Ref，也不修改 App 业务层。其签收基于固定 B23 Runtime，不能把本次静态核对说成已在新列表 Runtime 重跑 Planning。 |

旧 Hook 的类型注释写过 “one or more”，但 `compileSnapshotValueParams` 与 profile 编译器均要求 `refs.length === 1`。注释不构成已实现的多 Ref 消费者。

## 4. 必须明确的语义差异

**D1：Ref 的来源不是 Tool 的实例目标。** 旧 `prepareSnapshotValueArguments` 用执行 target 的 `viewId/viewInstanceId` 解析 Ref；新 `prepareViewTypeParameters` 从该 Observation 获准的 Ref 中选唯一匹配，再校验真实类型、来源与 payload。新 Tool 由 App＋ViewType 共享。

建议：另一个 View 发布的 Ref，只要在当前 Observation 中获准、名字唯一且类型／Schema 相符，不能仅因“来自另一个 View”就拒绝。这符合已确认的共享 Tool 模型。负向测试继续要求隐藏、未获准、歧义、外 App／实例、错误类型和伪造来源在业务派发前拒绝；业务父子关系、当前对象状态由 App 校验。**不能把旧“foreign View 即拒绝”的断言改名后假装语义不变。** 该断言变更须在独立范围裁决中明确接受。

**D2：同类其他 View 存在时，关闭一个 View 不等于撤销共享 Tool。** 当前普通路径检查 Tool activation；只关闭 A 而 B 仍存在，不应推导整个类型的 activation 已撤销。合法持有的旧 Observation 仍可能解析 A 当时发布的 payload；不会因当前名称重用自动改成新对象。旧 Snapshot Tool 的 A 实例绑定则会失效。

建议分开验证：

- 最后一个匹配 View 关闭、Tool 禁用／替换、App 执行实例变化：框架拒绝旧调用，业务入口为 0；重开后的新 activation 不接受旧绑定。
- 同类 B 仍存在，而 App 规则要求目标 A 当前必须打开：Ref payload 带 App 自有对象／会话身份，handler 用 App 状态检查存在与归属。拒绝属于 **1 次 Worker 派发／1 次 handler 进入后的 App guard**，业务副作用为 0。模型仍只输入 Ref，不手抄内部 ID。
- “采用 O2 后 O1 立即失效并释放专属 payload”仍是 SRT-05，不能偷偷加进本批或声称已完成；已有明确 release／scope close 的失效检查继续保留。

这不是把框架身份责任交给 App：Observation 授权、原始 Ref owner、AppInstance、当前 Tool activation、参数合同及调用终态仍由框架验证。App 只判断自己的对象和业务会话。

**D3：类型与破坏性入口退出。** 旧 Hook 可省略 refType，当前普通 Ref 要求显式类型。迁移试件须同步发布真实类型和 Schema，使用完整名字；不得从字符串前缀猜类型。旧 V3 Ref wire、`snapshot-value-v2` 和旧 profile 退出后应明确拒绝，不隐式回退到普通调用。历史证据留存不等于长期兼容旧入口。

**D4：范围准入与整个 Legacy 退出分开。** 本文件提出的是 SRT-02 已确认方向下的 Snapshot Tool 包装退出；没有据此宣布项目所有者最终 Semantic 验收或批准全部 Legacy 下线。公开契约／包文档需说明这次具体破坏性变更。

## 5. 最小下一批与后续删除位置

下一批建议只修改 `proposed-file-scope.json.nextCandidate.sourceChanges` 所列 **八文件**，即上表前四行的四个可执行消费者家族、共享业务输入及三个调用测试。使用全新隔离副本；SDK／Runtime 生产源码和原 tar 保持不变。编译所需的既有协议字面量、Ref 名、typed 发布、App 绑定及断言映射在这八文件内完成。需要增加其他源码文件或修改内核时，报告具体阻断并重新提交范围，不顺手扩展。

生产退出阶段的静态影响面为 **8 个可能整文件删除＋27 个只裁旧分支的共享文件**，共 35 个生产文件，详见带 SHA 的清单；这不是下一批修改授权，也不含其后必须对应处理的测试、文档、产物清单。

| 待删重复职责 | 精确位置与保留边界 |
| --- | --- |
| 独立 Hook、旧 ParamDef 方言、target helper | `sdk/src/hooks/useViewSnapshotTool.ts`、`sdk/src/tools/snapshot-parameters.ts`、`sdk/src/utils/tool-target.ts` 可在消费者迁移后整删；同步 root 导出。普通 schema 推导与 `refParam` 保留。 |
| 旧参数编译／元数据／selector | `runtime/src/core/tool/snapshot-value-parameter-contract.ts`、`ref-declarations.ts`、`target-selector.ts` 在旧调用与 fallback 全部移除后可整删。普通 profile 的严格验证、拒绝旧合同和用户普通字面数据不被误判的检查保留。 |
| 独立 Ref codec／Worker 执行器 | `runtime/src/adapters/ref-invocation-v2.ts`、`runtime/src/worker-runtime/ref-invocation-v2.ts` 可退出；同步 V3 消息 union、capability 协商、Worker RESET／请求／响应分类，保留 V4 身份、来源与终态验证。 |
| 双注册与解析路径 | 在 `view-owned-tools.ts` 删除 snapshot 注册 map／绑定与专属方法；在 `snapshot-value-arguments.ts` 只删旧 `prepareSnapshotValueArguments`。保留 `prepareViewTypeParameters`、`SnapshotValueRefSource`、预算常量与 finally release。不能凭文件名删掉这个共享模块。 |
| View 实例工具投影／选择器分支 | 在 snapshot types／validator、source-binding、observation-registry、scoped-interaction、DOM Producer、semantic adapter／capability policy、CLI 中移除旧执行分支。保留 View 实例身份及 Ref owner，它们仍服务当前快照和 Ref。 |
| SDK／AppKernel 的旧注册 port 字段 | 精简 `View`、两个 context、SPI port 与 AppKernel；**mount/unmount 必须保留**，普通 Tool 激活也依赖它们。`SafeOrdinaryInvoker` 目前是 `SafeRefInvoker` 的别名，不能删掉后者而破坏普通 invoker 的类型定义；先保留同一函数合同。 |

这一步不做 name/id 专项重命名、通用资源管理、包拆分、Host 自动刷新或新业务辅助层。动态加载的未知第三方 App 没有迁移证明；公开退出应报告不兼容，不为未知调用方无限保留兼容包。

## 6. 负向测试与准出矩阵

以下是下一候选的验收要求，**不是本次已经运行的结果**。旧测试文件保留在冻结基线中；新候选逐条记录旧测试／断言、新位置、改变理由及实际结果。不得只比较总测试数。

| 场景 | 必须可观察的结果 |
| --- | --- |
| 新声明／注册 | 单对象和单个对象列表按正式 profile 注册；多 Ref／optional／Ref 名数组仍明确拒绝，getter 不被执行；SDK capture 与正式注册分开记录。 |
| 完整 Ref 与普通字段 | handler 收到只读对象／列表；普通字符串即使像 Ref 也不解析；空、缺失、对象直传、错误类型／payload 拒绝。 |
| 可见性与来源 | 未获准／隐藏／名字歧义、外 AppInstance、伪造 snapshot、Ref owner、activation 或 source 字段均在业务前拒绝；同 App 其他 View 的合法可见 Ref 按 D1 处理。 |
| 生命周期 | 最后 View 关闭、禁用、重绑、App reset 拒绝旧绑定；只关闭一个实例按 D2 区分框架拒绝与 App guard；旧 cleanup 不删除后继注册。 |
| 原观察与数组重排 | 持有的 O1 只取 O1 payload；O2 的重排／重名不得把 O1 改指新对象；明确 release 后旧调用拒绝；不承诺 SRT-05 自动采用。 |
| 授权暂停后重验 | 受控 authorize／validate 等待期间撤销 scope、binding 或 grant，恢复后 handler 为 0；不以隐藏工具代替执行时授权。 |
| 参数与容量 | 开放字段、枚举／默认语义、特殊 own key、嵌套数据冻结、整体字节／节点／envelope 上界及边界两侧；不能调大限额或弱化断言来过测。 |
| 执行与收据 | 正常结果、业务失败、抛错、非法／超大结果、进入后丢终端分开分类；未知结果不自动重试。保留同 invocation 去重和冲突拒绝，不新增调度能力。 |
| 真实边界 | Preact 与普通 TS 都走真实 SDK／Core 提交；Worker 用实际包并记录调用数、Worker 派发数、handler 数、App guard 数，不能把框架拒绝也记成业务执行。V4 codec 变异另列。 |
| 释放 | 每个拒绝／成功／失败路径释放临时 lease；显式 close 检查 scope、交互、池与 Worker 状态；分别报告 Store 仍保留的历史快照，不宣称强制 GC／RSS 下降。 |
| 生产删除阶段补充 | 旧 Hook／类型不再导出，旧配置／wire／profile 明确拒绝；包内容不残留已删 js/d.ts/map；普通路径及原持久化／关闭／协议身份检查继续通过。 |

两版 TypeScript 的严格公共包消费、原有 scalar/list Core 与真实 Worker 基线应在生产删除候选重新验证；消费者迁移证明阶段只跑与八文件变化对应的检查，不重跑封存证据目录或以一次 Demo 代替这些门槛。现存 SDK／Runtime 测试若混用已退出协议，修订须与真正回归分别记录。

## 7. 未决事项、责任与下一条执行 Prompt

待 Minimal Core 裁决 D1、D2 的具体测试迁移规则，以及八文件证明是否为下一最小实施范围。需要生产删除时，补齐逐断言映射及文档／包条目后再提交精确删除范围。正常包安装与共享采用、SRT-05 和最终 Semantic 验收仍未完成；这些边界没有因本次只读审查解除。

SRT Owner 负责消费者清单、隔离迁移证明、范围与证据交付；Minimal Core 负责独立审查内核保证与执行入口。涉及内核缺口必须给出具体反例，由两位负责人收敛到单一实施责任，不并行改同一生产模块。

**下一条可执行 Prompt（范围准入后使用）：**

> 以 SRT-02 已签收列表 SDK `43259156…`、Runtime `3a3a5832…` 和 source-final 418 文件为不可变基线，在全新隔离目录制作旧 Snapshot Tool 消费者迁移证明。只允许修改 `proposed-file-scope.json.nextCandidate.sourceChanges` 中八个文件，不改 SDK／Runtime 生产源码，不删除公共入口，不新增 Ref 参数形状。按独立裁决采用 D1/D2：Tool 按 App＋ViewType 共享；来源资格由框架判断，目标当前存在及业务会话由 App 判断。同步真实 refType、完整 Ref 名、静态声明和 App 绑定，提供逐条旧断言→新断言映射；框架拒绝与 App guard 的进入次数分开记录。先提交准确的运行入口、依赖／产物身份、状态目录及副作用边界供复核，再运行迁移后的真实 Worker、普通 TS／Preact 对照及公共包消费者。不得启动 GUI Host 或模型，不读取用户手测状态，不复用原证据输出目录，不安装／发布／推送／合并。发现需要第九个源码文件或内核修复，提交具体阻断与限定修订，不静默扩围。你不是唯一执行者，不覆盖他人修改。交付状态 READY_FOR_REVIEW，附证据清单与下一批生产删除的精确提案；由 Minimal Core 独立复核。

本批当前可执行动作是将这份范围与静态证据交给 Minimal Core 复核；没有把这段 Prompt 当作已经获准实施。
