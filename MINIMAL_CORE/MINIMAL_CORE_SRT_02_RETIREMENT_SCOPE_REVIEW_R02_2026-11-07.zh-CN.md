# SRT-02 退出范围 r02：独立复核

2026-11-07。**只读退出范围 APPROVED；生产退出整体仍为 CHANGES_REQUESTED。** 本裁决接受可审查的删除边界、保留职责和验证义务，没有实施或批准八个文件的删除。r05 的隔离消费者迁移行为批准继续有效，兼容、正常安装和最终 Semantic 验收边界不变。

审查对象是 [r02 范围](../review-evidence/srt-02-retirement-scope-r02-20261107/RETIREMENT_SCOPE.zh-CN.md) 和其 14 件产物，submission SHA-256 为 `cb0e1565226ae4983692899b4d60081946b3f998ce35892c1fa186761e5fccc1`。代码基线是 r05 的 418 件固定源码，不能用当前脏共享树替代。负责人没有修改生产、运行新行为测试或操作私有手测状态。

## 独立核对与结论

负责人逐项核对提交及其引用指纹、418 件固定源码、128 个具名源码／外部输入、1187 行引用内容和 27 件现有包产物，未发现引用或内容漂移。[机器审计](../review-evidence/srt-02-retirement-scope-r02-20261107/owner-review/scope-audit.json) 记录精确数量；它们是静态核对数，不是测试通过数。

原 35 个生产输入现已分成 8 个整文件退出提案、25 个分支裁剪提案、2 个保留项。59 个测试文件是审查输入，不意味着全部删除或全部修改。17 份当前文档、3 份可执行教程、容量脚本、两个 SRT-01 stub 和 w10 full 分支均已列出义务。额外 10 个共享文件单独记录身份，其中 IDE／App 作者指南的 7 个文件需未来在新集成基线处理，不能直接覆盖共享树。

关键职责已结合实际代码确认：

| 可删除的重复职责 | 必须保留的现有职责 | 实施后必须证明什么 |
| --- | --- | --- |
| 独立 Snapshot Tool Hook、旧参数方言、实例 selector 与 Ref V3 成功路径 | 普通 ViewType Tool、现有参数编译与 V4 派发；Ref／ArrayRef 继续提供数据 | 普通参数、对象／对象列表 Ref 的真实声明、Worker 调用和错误拒绝；旧入口缺席且旧报文明示失败 |
| SDK View 传给旧 Hook 的注册包装 | `View.tsx:136–147` 的 DOM attach mount／detach unmount、页面实例身份与类型工具启用 | 同类型多页共享能力，最后一页关闭后失活，旧 cleanup 不误删新身份 |
| Registry 的旧实例注册表与专属费用 | typeTools、activation、注册 token、重入／容量保护、dispose；`AppRuntimeContext.viewTools` 和 component-factory 挂载端口 | 新路径身份、容量、生命周期及释放；不能按旧名字整体移除端口 |
| 旧 snapshot 参数 preparation | `prepareViewTypeParameters`、`SnapshotValueRefSource`、观察来源、完整参数／envelope 预算与 finally release | 原观察数据被冻结，越权／错类型／超限调用零业务效果，失败与关闭释放资源 |
| 旧 Tool 的 `execution.kind='view-instance'` 分支 | View／Ref 自身的实例身份、授权后复核和调用记录 | D1 原未授权负向与 D2 业务 guard 差量分别成立；不能把业务拒绝说成框架派发前拒绝 |

`invocation-terminal.ts` 当前仍整体保留：`SafeOrdinaryInvoker` 复用了 `SafeRefInvoker` 的通用签名。`ordinary-invocation-v2.ts` 的实际协议为 V4；保留与否按职责判断，不按 V2／Ref／snapshot 字符串判断。[逐文件职责和源码 SHA](../review-evidence/srt-02-retirement-scope-r02-20261107/per-file-obligations.json) 是下一补丁的检查依据。

这次范围准备没有减少生产代码。拟实施的减法是让作者使用一套普通工具声明和参数合同，退出另一套 Hook、注册、参数解释与派发链；必要的一致性、来源验证和资源责任继续由 SDK／Runtime 承担，不转交 App，也不新增兼容层或状态管理器。

## 仍未覆盖的风险与完整准出

1. 词法与引用闭包不能证明未知外部消费者不存在。旧 API 退出属于 Breaking 边界，当前范围不是发布许可；不为未知消费者恢复长期双轨。
2. 生产将变化，r03 的 70 项与 r05 的四次公共调用需要在最终新包重验。旧 295→352 运行断言／24→26 类型负向映射只覆盖八个已迁移文件，不能代替剩余测试家族的逐断言归属。
3. 旧报文、profile 和 factory marker 必须明确拒绝；移除解析器后超时、悬挂请求或落入普通调用均不准出。新参数预算、入途终态、关闭和持久化义务保留。
4. 新干净 dist／tar 必须排除当前已核对的 27 个旧输出。三个当前教程使用正式新包验证，Core 教程逐字提取并执行 StateSession 与关闭；ref-only 通过不能代表 w10 full 或 IDE／LSP 通过。
5. TS 5.3 adapter 的 36 条错误仍阻断对应完整准出。公共类型按原质量门禁使用 TS 5.3.3／5.9.3、strict、`exactOptionalPropertyTypes:true`、`skipLibCheck:false`，并从实际 tar 全新安装。r05 的链接消费者和未启用 exactOptionalPropertyTypes 的配置不满足这组完整要求。原门禁见 `.tmp/worktrees/srt-01-owner-handoff-20261105/docs/handoffs/srt-01/QUALITY_GATE_PLAYBOOK.zh-CN.md:82–83`，SHA `540bd6075e9fdf77f92636d6953f534b8331a018b4370e2dfba82376273dee2f`。
6. SRT-06 的 Runtime 去具体 Driver 依赖方向已确认。它与旧 Tool 退出都可能修改 Source 和公开出口，必须先确定一个顺序和基线，不能让两条执行线并行修改同一文件。移动适配器不能自动修好 Driver 自身的 36 条声明错误。

SRT-03／04／05、多／可选 Ref、资源额度重设计、Host 预览、共享采用、发布和最终 Semantic 均不属于本裁决。D3 历史消息迁移继续取消。

## 下一批具体范围与 Codex Prompt

先完成公共类型范围的独立复核，并把已确认的 SRT-06 方向整理成具体的迁移落点、正式入口与消费者影响提案；SRT Owner 保持本包冻结，只同步现有任务状态。去依赖方向不重新等待批准；具体公开入口和版本政策须形成可审查方案后交有权负责人决定。当前不执行本范围包第八节的生产删除 Prompt。

后续生产实施准入须同时具备：唯一隔离源码基线及文件所有权、两批交集的先后顺序、完整逐断言映射、精确新包与消费者安装计划、允许的执行入口和输出目录。对应兼容门禁继续保留，未运行事项明确列出。清理实施只能复用现有普通工具路径，不引入替代框架。

> **下一可执行 Prompt（静态提案）：** 以 r05 的固定 Source／Core／SDK 接口、此退出范围和公共类型独立裁决为输入，核对把现有 Driver 专属 Source、转换和 jsonSchema 包装迁出 Runtime 的最小落点。优先检查已有集成目录能否承担职责，列出旧入口→拟议入口、真实生产／测试／文档消费者、manifest／锁／生成声明义务和与 SRT-02 的文件交集；保持完整 Context／Tool／Schema 与 Runtime 的 Snapshot／Observation／Scope／Ref 责任。分别给出不安装 Driver 的 Runtime 消费门禁及保留 Driver 的集成门禁，两者均沿用原公共类型要求。只写提案与证据，不改生产、依赖或版本政策，不构建／安装／启动产品，不读取私有状态。不要新建协议包或以 type-only／optional peer／旧 re-export 冒充去依赖。交可逐项审批的最小迁移方案、未决选择、精确后续 Prompt，由负责人独立复核。

本次判定及引用由 [负责人最终签收](../review-evidence/srt-02-retirement-scope-r02-20261107/owner-review/final-signoff.json) 封存；执行者的 READY_FOR_REVIEW 文件保留原状态，不由其自行批准。
