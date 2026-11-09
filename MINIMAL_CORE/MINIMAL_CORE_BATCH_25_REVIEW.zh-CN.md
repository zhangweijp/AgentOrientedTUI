# Batch 25 独立复核：Ref 手测入口

2026-11-06。**本批整体结论：CHANGES_REQUESTED。** 真实 Ref 调用的工程证据、独立 Electron 路径探针和交接保护已通过复核；GUI 实际呈现尚未完成，当前不能将本批标记为完整验收。剩余要求是完成 GUI 门槛，不扩大核心协议范围。本文为负责人裁决，执行者报告与私有手测状态另由对应责任人维护。

**当前事实。** 隔离 Host、Planning 与模型配置已经准备。SDK/Runtime 核心未修改，共享代码未采用 B22 协议。Mac 锁屏阻止了实际界面观察。SRT Owner 已接管最终私有状态，自动验证不再启动、重置或归档这份状态；后续自动检查必须另建无真实凭据副本。真实模型理解与所有者最终 Semantic 验收仍未完成。

最终封存已核对：执行者 113 件证据、隔离环境 1,507 件静态文件全部匹配。执行者清单 SHA-256 为 `2196fdfa62cc8713e2eee210bb2ae1bd3f1e50575c5bcc1f899bd414889a5253`，报告 SHA-256 为 `45229f3a5d8c020c6a3205b7f0dd13815f80886564829cefb4948114850c41a0`。负责人目录独立维护，不纳入执行者自有清单形成循环。[最终机器复核记录](../review-evidence/minimal-core-batch-25/owner-review/final-verification.json)

## 代码与包的依据

隔离目录为 `.tmp/minimal-core-ref-acceptance-20261106/`。Host、Planning 与 Driver 从固定 SRT M4.3 Git `853495dd9954eb4f8a91998bcc59e19326765981` 提取。此处 Driver 的八个源码文件逐字等于原 Git，它不是当前共享 B09 Driver；不能把隔离组合的成绩移作共享组合成绩。

| 项目 | 独立核验结果 |
| --- | --- |
| SDK 原包 | SHA-256 `c5c750464c7151e230654fcf4ae5846df4d2a02f47876d558a4a1b48257391ff`，90 个载荷文件逐字相等。 |
| Runtime 原包 | SHA-256 `46c39d592ce11ec950ab10dbf15568b55278d0a5c3702366feb0c443e063a7e6`，388 个载荷文件逐字相等。 |
| 隔离补丁 | 从原始归档独立检验、应用，13 个修改/新增源码文件与实际隔离目录逐字相等。最终身份见下方机器记录。 |
| 共享代码 | 开工冻结的 604 个文件指纹未变，Git HEAD 与 index 未变。 |
| 原业务数据 | 再次只读核对原 `.agentina/config.json`、`.agentina/mcp.json`、Host `chat.db` 与 Planning `planning.sqlite`，指纹均等于本批开始。 |

Planning 只将 `open_plan` 改为显式必填 Plan Ref，业务仍按收到的 `plan.id` 验证当前对象是否存在，再执行打开操作。其他工具保留自己的业务 ID 参数。Root View 与错误恢复说明均同步为完整 Ref 名，避免一处要求引用、另一处又要求 ID。文件路径没有被包装成 Ref。

Host 的改动用于固定私有配置、数据库、缓存和 Electron profile 路径，采用现有 AppRegistry 选项并停用无关开发自动发现。GUI 加载隔离构建文件。已有的 Ref 解析、授权与 Worker 执行机制继续由签收包负责，没有新增内核抽象或状态管理器。局部 `RefValue`/Plan Schema 是已审试件，不是新的公共 SDK API。

独立文件验证及补丁重放记录：[independent-checks.json](../review-evidence/minimal-core-batch-25/owner-review/independent-checks.json)。其脚本只读代码和测试记录，不加载 Host、不读取最终私有配置。首次检查器误把 SHA 字符串与包含 SHA 的元数据对象比较；修正检查器字段后通过，此检查器错误不属于生产文件漂移。

`probe-ref.mjs`、`probe-driver.mjs` 与 `seed-ui.mjs` 均在交接标记存在时、导入 Host/DB 等有副作用模块之前拒绝运行。负责人将实际交付脚本原字节复制到没有应用或依赖的新临时目录，三项均产生自身的交接错误，不是缺模块错误；最终 state 没有被读取或写入。[负责人独立入口测试](../review-evidence/minimal-core-batch-25/owner-review/guard-entry-tests.json)

## 真实执行与独立复核

执行者使用真实 Planning、Node Worker、Source，验证创建、关闭详情、从 PlanList 取得 Ref、打开正确详情和删除后的业务拒绝。错误前缀、未知名字、直接上传对象三项均为零 Worker 业务派发。工具只返回操作收据，详情通过 View 呈现。

实际 SRT M4.3 Driver 的测试运行 `LLMClient.call` 与 `streamText`，仅替换 provider 边界：一次模型请求、一次捕获 Context 的执行、一次 V4 业务派发、一次收据、一次 Context 释放，最终资源释放成功。负责人读取了脚本与原始请求/执行记录并核对断言，没有把受控 provider 冒称真实模型测试，也没有冒称自己重跑了这段执行。[Driver 原始记录](../review-evidence/minimal-core-batch-25/m43-driver.json)

SRT Owner 在独立 Planning 副本实际执行了 10 次调用：创建有不同内容的 A/B；用 Ref 打开 A 并读取完整阶段/任务；删除 A；故意保留旧 Context，再用原名字调用，收到的仍是 A，由 App 返回 `PLAN_NOT_FOUND`；B 占据同一列表位置后，只有新 Context 的同名 Ref 指向 B。错误参数三项均零派发，最后资源关闭成功。Minimal Core 已逐项核对该独立脚本与原始结果，未重复宣称为自己的执行。[独立结果](../.tmp/planning-app-install-20261106/owner-ref-result.json)

## 保留的风险与未覆盖范围

1. GUI 已启动过进程，但因 Mac 锁屏未观察到 Planning 界面。编译通过和进程存活不能代替这一门槛；当前仍是 `ENVIRONMENT_BLOCKED`。
2. 首次离线 GUI 脚手架可能在 Main 设置路径前初始化默认 session。同期间原 Host 的 DIPS WAL、DawnGraphiteCache、GPUCache、DawnWebGPUCache 共四件文件指纹变化。原 Host 也在运行，但不能据此排除本批影响。原记录保留，未删除、恢复或覆盖用户缓存。Main 已显式设置 `sessionData`，脚手架改为先设置路径。随后无凭据 Electron 探针确认 `userData`、`sessionData`、`defaultSession.getStoragePath()` 均等于新私有目录，该次探针期间原缓存没有新增变化；这是配置生效证明，不能代替最终 Host GUI 观察，也不回写首次事实。[保护记录](../review-evidence/minimal-core-batch-25/protection.json) · [独立目录路径结果](../review-evidence/minimal-core-batch-25/profile-preflight.json)
3. 此包只验证普通工具的一个必填对象 Ref。数组整体、多选、可选/组合 Ref、同 App 多页重名规则，以及采用新观察后自动撤销旧 Context，均未借本批完成。
4. 保留旧 Context 的测试证明数据来源不被错误替换，不代表旧观察自动失效。删除后的已有结果分类是 `unknown + PLAN_NOT_FOUND`；本批没有改为框架执行前拒绝或其他分类。
5. B24 已确认候选与共享代码有冲突，并且旧基线缺少共享已具备的保护。隔离手测不授权覆盖共享代码，不等于集成或发布条件满足。
6. 最终模型设置由 SRT Owner 私下准备，证据仅保留非敏感就绪元数据；归档排除 state、聊天数据库、Planning 数据及凭据。未发出真实模型请求。

## 剩余准出与下一步 Prompt

先完成同一批的收尾，不另开核心改造批次。路径探针与交接入口保护已通过，代码与启动器已冻结；剩余准出条件为允许观察桌面后确认真实 Host 的 Planning 页面、工具 Input/Output 和关闭流程。保留首次失败/缓存变化，不把 GUI 缺项计为通过。真实模型手测结果和最终 Semantic 决策由所有者确认。

用户入口说明由 SRT Owner 独立维护：[Ref 人工验收步骤](../.tmp/planning-app-install-20261106/REF_ACCEPTANCE.zh-CN.md)。只使用其中的隔离 `launch.sh`；根目录 `run.sh` 的共享 Planning 仍采用业务 ID，不能用于本批新协议的验收。最终模型配置就绪不等于模型服务已连通，自动检查没有发起真实模型请求。

Codex Prompt：

> 继续 Batch 25 的 GUI 收尾。路径探针、交接入口保护已完成，不重复执行或扩展测试。保留已冻结的代码与启动器。只在另建的无凭据副本验证 GUI，不拥有 SRT Owner 已接管的最终 state；你不是唯一工作者，不覆盖他人修改。待桌面可观察后，实际确认 Planning 页面、完整 Ref、工具输入/收据和关闭流程。不要再启动或写入最终 profile，不打包数据库或配置。保留首次缓存变化与 GUI 锁屏事实。GUI 若仍不可观察，保持 GUI_GATE_PENDING，由负责人保留 CHANGES_REQUESTED，不自批。后续只整理 B24 已证实的采用依赖与必须保留的现有保证，不解决协议冲突、不修改共享 SDK/Runtime、不发布。
