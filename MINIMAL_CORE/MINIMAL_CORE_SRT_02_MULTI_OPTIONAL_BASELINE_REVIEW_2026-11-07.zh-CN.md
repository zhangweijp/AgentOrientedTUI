# SRT-02 多 Ref／可选 Ref 公共基线独立复核

2026-11-07。执行：SRT Owner。独立复核：Minimal Core 负责人。

**公共包、注册和类型基线 APPROVED；三处 Runtime 隔离实现准入 APPROVED。准备的 Worker 冒烟入口仍为 CHANGES_REQUESTED，尚未批准运行。** 这不是新能力实现签收，也不包含共享采用、发布或最终 Semantic 验收。

当前证据支持沿现有 Runtime 参数链补齐能力：SDK 已能表达多个对象／列表及可选字段，正式 Runtime 注册仍明确拒绝这些新组合。无需为本批新增作者 API 或参数抽象。

## 1. 独立证据

执行方 [正式报告](../review-evidence/srt-02-multi-optional-baseline-20261107/REPORT.zh-CN.md)和 [23 件清单](../review-evidence/srt-02-multi-optional-baseline-20261107/submission-manifest.json)已核对，清单 SHA256 为 `497b0c552a9e98af26cc6eefbb45e0d2b58562ed793b911aecb6566cc1e2c21f`。

负责人新建仓库外消费者 `/private/tmp/aotui-multi-optional-review-o96wu40m/consumer`，复制精确 manifest／lock，并使用独立缓存副本完成正常 npm ci --offline 和 npm ls；没有工作区链接、源码 alias 或 Driver／AI 依赖。Runtime 的 367 件安装文件及 SDK 的 78 件分别逐字等于封存 tar，原 manifest／lock 未变。

负责人实际复跑公开 SDK 捕获、正式 profile 编译及 `createViewOwnedTools.registerTypeTool`：9 个 SDK 声明全部捕获，单必填对象／单必填对象列表两项接受，其余七项多 Ref／optional 组合均明确 `PARAMETER_DECLARATION_UNSUPPORTED`。实际工具可见数、invoker factory 次数和各 registry 的 finally 释放与原输出逐字一致，handler 为零；没有创建 Runtime 或 Worker。

TS5.3.3／TS5.9.3 的原完整严格试件均通过。负责人又在自己的附加副本移除九条错误抑制注释，两编译器均实际得到九条预期类型错误，证明 readonly、可选缺席、逐字段形状与模型名字／handler payload 区分仍受约束。原试件没有改动。

完整安装、包校验、注册及四次编译命令见 [独立基线审计](../review-evidence/srt-02-multi-optional-baseline-20261107/owner-review/independent-baseline.json)。当前绿灯只证明现有基线与 SDK 类型；不代表多 Ref／optional 已能运行。

## 2. 允许实施的三处职责

只在 `.tmp/srt-02-multi-optional-ref-20261107` 下新的候选源码副本实施，原 baseline 和 B r02 不改；SRT Owner 独占生产候选，负责人只做独立复核。

1. `runtime/src/core/tool/ordinary-parameter-contract.ts`：取消已准入形状的数量及必填限制，保留对象／对象列表、顶层字段、Ref 名数组拒绝、普通 required 和原 Schema／预算语义。
2. `runtime/src/core/tool/snapshot-value-arguments.ts`：仅对通过模型校验且没有 own property 的可选字段跳过；累计已解析参数，以完整参数对象和 envelope 执行原预算；成功／失败的既有 release 责任保持。
3. `runtime/src/adapters/ordinary-invocation-v2.ts`：按实际出现的 Ref 字段检查对应来源，保留字段顺序、raw／schema／envelope 一致性、普通参数和缺席字段不得注入的检查。保持已查清的可信传输边界，不新增 Snapshot 真实性认证。

同步修改直接证明这些合同的 Core／参数准备／validator 测试，保存原“明确不支持”的基线记录，不能删除仍有价值的来源、预算或清理断言。允许构建新候选、运行纯 Core／SDK 类型测试、准备精确 tar 和当前支持文档；涉及包元数据的每项差异单列说明，不隐式混用旧 Runtime。

当前没有 SDK 行为源码变更的依据。若 SDK tar 没变，兼容矩阵合并重复列；若只有文档或准确依赖等元数据变化，按实际差异报告，不制造新的 SDK 功能版本。任何额外生产责任、协议形状或配置机制先提交必要性及精确影响。

## 3. Worker 入口仍须修订

已读准备的两份 mjs。它们目前只有语法检查，七成功三拒绝只是初始冒烟；完整预算、原观察、双 Producer 和兼容矩阵仍需后续实际执行。以下三处在运行准入前修正，原入口保留为准备历史：

- 成功后不能只检查 entered/name/frozen。必须逐调用深比较 handler 的完整 args，覆盖两个 Ref 都解析正确、列表元素和可选字段真正缺席；冻结检查应覆盖对象、列表及其元素，不能因原值仍为字符串就自动通过。
- 失败不能仅断言“不是 succeeded”。分别固定预期 rejected 状态和既有稳定错误码，并证明业务未进入；unknown、超时或其他无关失败不能被计为正确拒绝。
- 关闭 scope 的异常不能阻断 Runtime 关闭尝试；关闭异常和 Runtime 关闭结果都要保留事实，且在关闭失败时仍尝试写出运行记录。外围有限时终止只能记为异常，不算正常释放。

下一版还需提供最终候选 tar、普通 TypeScript 对照、实际入口文件身份、环境白名单、独立读写路径和有限时执行命令。直接 Kernel 安装、显式启动 config 与不导入 Host 的方向合理，但这些准备事实不替代最后运行环境核对。本次允许修订及语法检查入口，不允许提前启动 Runtime／Worker。

## 4. 下一批准出条件与 Codex Prompt

实现交付必须证明：正向多字段与 optional 组合；普通参数不变；第二个 Ref 失败不进入业务；原 Observation 逐项取值与实际来源；原总预算不被分字段重置；缺席字段不能被注入；仍不支持的 Ref 数组／嵌套形状继续拒绝；来源与资源释放的旧保证保留。真实 Worker 和双 Producer 的通过须以以后获准的实际运行补齐，不在本轮提前签收。

可直接转交的 Codex Prompt：

> 以已复核公共基线和 r03 范围，在新的独占候选中完成上述三处 Runtime 最小修改及直接相关测试。不要改原 baseline、B r02 或共享生产。复用现有 refParam／Type.Optional／ViewType Tool，不加作者 API、解析器、状态或信任机制。运行受影响纯 Core／SDK 类型与构建，保持两版严格检查；准备精确包、实际依赖解析和诚实的旧新矩阵。修订 Worker 入口的完整 args／深冻结、精确拒绝及可靠清理事实，补普通 TS 对照，准备环境与有限时命令但不执行 Runtime／Worker。提交精确 patch、源码／包清单、原始失败与覆盖映射，由 Minimal Core 独立复核实现并另行准入真实调用。任何额外生产文件或协议变化先给出必要性；Driver 兼容政策继续等待已有答复，不重复询问用户。

未覆盖风险包括真实 Worker 的新组合行为、累计预算边界、跨观察及兼容矩阵的实际结果。Driver 正常完整集成仍未通过；本批不处理 SRT-05 或最终 Semantic 验收。
