# SRT-02 多 Ref／可选 Ref：r02 实现与 r03 真实入口终审

2026-11-08（Asia/Shanghai），Minimal Core 技术负责人独立复核。

**APPROVED，限定下列精确隔离候选及本报告列明的行为。** 多个顶层对象／对象列表 Ref、可选 Ref 的完整调用已由普通 TypeScript 与 SDK Worker 两条实际路径证明；参数预算误拒绝已修复。没有共享采用、发布或项目所有者最终 Semantic 验收；SRT-02 整体与 TS 7 全链工具迁移仍未完成。

## 1. 交付身份

| 对象 | 精确身份 |
| --- | --- |
| 生产候选 | `.tmp/srt-02-multi-optional-ref-20261107/candidate-r02`，739 个源码输入 |
| r02 源码清单 | `ca870bcb8d01db8e5a2796f214f9814ff6848d62953ff97550b9dd5f6d737209` |
| r01 → r02 增量 patch | `ebd7c9b65bdec81c80691119fb8578373732798f04ac5449750d9a4fb82be022`；一个生产文件及一个回归文件 |
| r02 的 61 件提交清单 | `fc5cdf659b68d413f92384a1c669c7299b173e2c8d4ee8ae4683737ff2527f8b` |
| Runtime tar | `fe2bbfb0ced6e77f5eab85e09a6eedc9f9e7a6e3fe885c690ac56d4bb463552a`；367 件 |
| SDK tar | `9efc11eaaa0adece77f9cf3b9cc0218490e11615fbd1366508de269da7cee6fb`；78 件，精确复用 |
| r03 的 39 件入口清单 | `797bb3e0427d144ac7e164294eb6fc0a42e92fc3ca9fa1e939482d97b41dd1bc` |
| r03 原运行 preflight | `86a82b426d725a95c80cf968f68112e1f606007133d709ed5afa4ab22e937bf3` |

原 r01、r02、r03 分别保留原输入清单与失败／修订证据。终审重新核对 97／61／39 件封存清单与 r02 739 件源码均未变。包仍是未发布的本地审查工件，沿用此前 prerelease 字符串；以上 SHA 与 lock 身份识别具体版本，不把同一版本字符串当作正式兼容承诺。

## 2. 最终实现与必要职责

完整候选相对已签收 B 基线只改变三处 Runtime 行为：

1. 参数合同允许多个顶层 Ref，以及缺席的可选 Ref；保留对象／对象列表范围、普通参数验证与其他形状拒绝。
2. 参数准备逐项从调用绑定的原 Observation 解析 Ref，累积 payload，保持缺席字段缺席。完整 effectiveArgs 形成后再套用既有总预算；同 Ref 用于两个字段仍按两份结果计量，原始请求与最终 envelope 各自的预算也保留。
3. V4 参数核对按实际出现的字段匹配有序来源，拒绝给缺席字段注入值，保持 ordinary 参数一致、Schema 检查及现有来源绑定。

SDK 没有新增 API、执行路径或类型分支。App 继续使用同一 Tool 声明和 `refParam`，通过 `Type.Optional` 表达可选；来源、参数处理与释放仍由现有 Runtime 模块负责。当前支持文档同步，未要求 App 作者处理内部解析或生命周期对象。

本次没有增加管理器、兼容包装、依赖或业务权限规则。新观测替换旧观测的行为仍按 SRT-05 单独推进。

## 3. 独立验证结果

| 验证 | 负责人实际结果 |
| --- | --- |
| 源码重放 | r01 从冻结基线重放 739/739；r02 从 r01 物理复制并重放增量，739/739 一致 |
| 定向行为 | r02 九个测试文件 381/381；保留原 318 项合同，新增多／可选与预算组合回归 |
| 实际产物 | r02 Runtime 重建 351 个 dist 与 tar 逐字一致；SDK 执行／声明未变，Runtime 相对 r01 仅 resolver JS/map 两件变化 |
| 独立预算反例 | 原大对象先解析的误拒绝消失；相同最终用量的两种排列均准备成功；定向测试继续拒绝各项真实超限并证明 lease 清理 |
| 正常包消费 | 负责人另建仓库外正常 npm ci／ls 消费者；445 个实际安装文件等于 tar，单一 Runtime，无 Driver／AI、源码 alias 或手拼包目录 |
| TS 7 公共类型 | TypeScript 7.0.2，strict、exactOptionalPropertyTypes:true、skipLibCheck:false；公共类型与入口编译通过；移除九个负向注释后得到九个对应的真实类型错误 |
| 编译入口 | 新正常消费者重新编译，全部 15 个源码／配置／编译输入与对应 preflight 逐字一致 |
| 普通 TS 真调用 | 22 次：14 succeeded／entered-returned，8 指定 code 的 rejected／not-dispatched；每步完整 args、可选缺席、只读路径、View witness、短收据均核对 |
| SDK Worker 真调用 | 同样 22 次，14 成功、8 派发前拒绝；真实 AppTools、useDataRef/useArrayRef、Node Worker 与公开 Scope 调用 |
| 清理 | 普通 TS 的 scopes、observations、activeLeases、registry、retained bytes 归零；Runtime shutdown ok/resourcesReleased，App／Desktop settled，无 pendingTasks、存储 owner/IO、scope bytes 或 Worker pool 持有；无外围强杀 |

负责人实际执行的是一组独立的 44 次调用；执行方在另一正常消费者完成同样 44 次。两组按输入、结果、完整业务 witness 和关闭事实逐项比较一致。普通 TS 与 SDK Worker 也逐项一致。它们覆盖每种 Producer 的同一组 22 场景，不将重复复验计成新的独立场景。

主要证据：[独立源码／测试／构建](../review-evidence/srt-02-multi-optional-candidate-r02-20261108/owner-review/independent-candidate.json)、[独立正常消费与严格类型](../review-evidence/srt-02-multi-optional-candidate-r02-20261108/owner-review/independent-public-final.json)、[原预算反例在修复后的结果](../review-evidence/srt-02-multi-optional-candidate-r02-20261108/owner-review/intermediate-budget-result.json)、[独立真实运行](../review-evidence/srt-02-multi-optional-entry-r03-20261108/owner-review/independent-run-review.json)、[执行方与负责人逐项对照](../review-evidence/srt-02-multi-optional-entry-r03-20261108/owner-review/cross-run-comparison.json)。

## 4. 失败与修订不抹除

- **r01 生产缺陷**：中间参数同时携带已解析 payload 和未解析 Ref 名，导致合法最终参数受解析顺序影响。原 375 项通过仍成立，新增反例另证明缺陷。r02 只修一个生产文件并加六个边界回归；[原 CHANGES_REQUESTED](MINIMAL_CORE_SRT_02_MULTI_OPTIONAL_IMPLEMENTATION_REVIEW_2026-11-08.zh-CN.md)保持历史结论。
- **r02 合成入口错误**：手工普通 TS Producer 把列表 Ref 的真实元数据写成 Note[]／Task[]，但合同与 SDK useArrayRef 发布的是 Note／Task。两边首次实际执行均在第二个 mixed 调用前拒绝，第一调用成功；没有启动 Worker，无强杀，Core 清理归零。负责人静态入口审查也漏掉该值不一致，对此负责。r03 只修两处合成元数据，保留完整 ArrayRef 名、payload、合同与全部 22 场景断言；产品源码与包完全未变。[撤回及失败记录](../review-evidence/srt-02-multi-optional-candidate-r02-20261108/owner-review/run01-withdrawal.json)。
- **负责人验证脚本更正**：首次负向检查脚本沿用旧 tsc 的预期 exit 2，TS 7 实际以 exit 1 报出全部九个预期错误。原脚本／原日志保留，按实际诊断核对，不修改类型合同或重新安装来掩盖错误。[脚本更正](../review-evidence/srt-02-multi-optional-candidate-r02-20261108/owner-review/verification-harness-correction.json)。
- 执行方更正的 r01 core-r02/r03.command.json 耗时字段继续不作为证据；原记录不改，独立命令记录真实测量值。

## 5. 未覆盖的风险与边界

1. 本批覆盖多个顶层对象／对象列表 Ref 及可选组合；Ref 名数组、多选、嵌套 Ref 等剩余形状没有因此获得实现批准。
2. SRT-05 的新 Observation 自动撤销旧资格、旧专属引用释放及注册所有权专项没有在此完成。现有原观察绑定／显式释放合同保持。
3. Worker 参数校验维护 schema/raw/envelope 一致性；原快照 payload 与来源真实性由 Runtime 原 Observation 解析链承担。不得把此运行解释为 Worker 独立认证任意自洽伪造消息。
4. 合成 App 验证了框架参数传递、观察结果与关闭；真实业务权限、文件冲突、外部任务、真实模型与 Host 预览不在本批验证内。MC-HOST-PREVIEW-01 仍 OPEN。
5. r02 产品构建沿用精确基线工具链以隔离行为修复；新公共消费者已经使用 TS 7.0.2。全链源码、锁文件、lint、IDE 语言服务及其他开发工具统一迁移属于下一候选。正常完整 Driver 集成的第三方严格 Tool 声明问题仍未关闭。
6. 正式发布仍需独立版本身份、依赖配对与消费者准出；本次不合并、不推送、不发布、不替代最终 Semantic 验收。

## 6. 下一批具体范围与 Codex Prompt

所有者已经明确要求“统一升级到 TS 最新版本吧”。负责人直接核对原始人类消息，并核对官方 latest 为 7.0.2。当前进入独立工具链候选复核；SRT-02 的本次 r02 行为作为后续候选必须携带的基线，不重新混入已经修复的 r01 行为。

下一批准出必须分别证明：主编译器与声明版本／锁一致；正常安装和 frozen lock 可重现；保留支持的包能构建；公开消费者严格类型与负向约束成立；测试、lint 和 IDE 语言服务的实际入口可用；公开包的真实运行及正常清理保持。源码构建的 skipLibCheck:true 不能替代公共消费者 skipLibCheck:false。旧 Demo 作者接口与新 SDK 不匹配需用原编译器对照归因，不能伪装成 TS 7 回归或直接删掉功能。

> 以本报告批准的精确 r02 行为为基线，在独立 TS 7.0.2 候选中提交源码／配置／锁／脚本及实际产物的完整差异。复用现有工具和责任边界，保持严格类型门禁、行为断言与业务能力。把主编译器、使用编译器 JS API 的开发工具、IDE 语言服务后端和 Driver 上游 Tool 类型缺陷分别列证据；每一项提供正常安装后的实际命令、退出状态和必要行为验证。若生态工具仍依赖旧 API，先给出基于官方现有能力的最小可行方案、真实依赖图和维护成本；不通过静默降级、删除 lint/IDE 能力、放宽类型检查或新增自制兼容层完成表面升级。需要改变重大支持承诺或集成机制时，先形成可审查方案并升级，不自动扩大授权。保留已封存历史失败，提交精确候选供独立复核。继续维护 deepseek_review.md 的唯一待办状态；共享采用、发布及最终 Semantic 验收仍单独处理。
