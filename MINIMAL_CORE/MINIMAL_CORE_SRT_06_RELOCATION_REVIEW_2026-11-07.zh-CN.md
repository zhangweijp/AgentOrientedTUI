# SRT-06 具体迁移提案：独立复核

2026-11-07。**技术提案 APPROVED；公开入口选择待项目所有者决定，尚未批准实施或共享采用。** 本轮只读分析到此收口，不再为同一事项追加泛化范围报告。

推荐接受[提案](MINIMAL_CORE_SRT_06_RELOCATION_PROPOSAL_2026-11-07.zh-CN.md)中的现有 Driver `./aotui` 方案。Source、结果转换、jsonSchema 包装及专属格式化代码迁到现有 Driver 包；Runtime 删除具体 Driver 依赖，保留 Snapshot／Observation／Scope／Ref、参数编译、身份、授权和资源责任。完整 Context／Tool／Schema 和调用行为保留，没有新协议、兼容层、状态管理器或第二套 Source。

负责人逐项核对 18 件交付、75 个具名输入、42 个命中文件的原行引用及 4 个已知不存在路径；未发现漂移。[独立核对](../review-evidence/minimal-core-srt06-relocation-proposal-20261107/owner-review/scope-audit.json)。另直接阅读 Runtime Source、Core 公共出口、默认指令 loader、共享工具名／View 包装函数和三包 manifest，确认以下边界：

- Host 未声明 private，但其入口和构建面向 Electron，没有现成的第三方 Source 分发合同。将公共能力直接塞入 Host 不构成完整替代。
- Driver 当前没有 Runtime 生产依赖；同一候选移除 Runtime→Driver 并建立 Driver→Runtime 后图可以无环。这是安装成本的转移，独立子入口只能隔离加载／声明，不能消除 Driver 新增的安装负担。
- `buildPublicToolName` 仍由 AppKernel 调用，必须保留唯一实现。拟从现有 Runtime adapters 中立出口公开它及 `buildViewMessageMarkup`，供迁出的 Source 复用；不公开 Receiver、注册器或内部状态检查接口。
- 默认指令正文及当前公开常量留在 Runtime。只有加载函数迁出，instruction／path／env／fallback 优先级及失败行为不改。Host 的默认指令消费不必绕回 Driver。
- 新 Source 的 Runtime 类型可从已有 Core／SPI 入口取得。测试中的私有 Receiver 责任必须留在 Runtime；Source 组合验证改用公共能力，并逐断言映射，不能以迁移为由删掉保证或开放私有检查口。

**所有者只需决定一个完整的分包方案**：使用 `@aotui/agent-driver-v2/aotui` 替代原 `@aotui/runtime/adapters` 的 Source 入口，接受 Driver 安装时带 Runtime，并允许两个现有纯函数成为中立出口。类名、构造和使用方式保持，App 工具声明不因此新增步骤。选择这一方案意味着旧 Source 导入退出；不能保留旧 re-export 又宣称 Runtime 已去依赖。根据最初交接分工，重大公开 API 与架构选择由上级决定，本次技术 APPROVED 不代替这项决定。

候选版本及依赖范围由负责人在隔离批次固定为精确匹配的未发布产物，不把旧 `^3.0.0` 当成包含新增出口的保证。正式发布版本与发布继续另决。Driver 新 exports map 对旧深路径的影响必须在 Breaking 说明中明确：不得宣称所有旧深路径仍兼容，也不自动增加通配兼容层。上述工程细节不需要拆成多轮泛化审批。

**决定后的一个集中批次**：由同一执行者拥有 SRT-02 与 SRT-06 交集，按已签收退出清单形成组 A，冻结其精确内容，再按提案白名单形成组 B；随后集中构建匹配包和验证真实消费者。正式实施白名单为 SRT-02 已核对项目与本提案清单的明确并集；其中 Host 生产仅改五处 Source 导入，不能顺手改调度、通知、预览或业务。

准出分别记账：R 为不安装具体 Driver 的 Runtime 正常 tar 消费；I 为安装 Driver 后的完整集成消费与调用语义。两项保留 TS 5.3.3／5.9.3、strict、exactOptionalPropertyTypes、skipLibCheck:false 及实际安装证据。已知 Driver 36 错不阻止先形成隔离实现和取得 R 的事实，但 I 未过就不能把整体兼容写成通过。任何版本支持政策变更单列决定，不以本次迁移默示豁免。

仍未验证正常安装闭包、完整类型选项下的新增诊断、Receiver 测试拆分及迁移后的真实调用／关闭。实施前把实际可写目录、包身份和运行命令一次固定；同一白名单内的修复以 attempt 保存原失败和增量，只复验受影响内容，超出边界才定点升级。独立最终复核继续保留。

提案的 2–4 个有效工程日仅是组 A 已就绪等假设下的组 B 与验证粗估，**不是整个 Minimal Core 的剩余工期**；它排除了尚未实施的旧路径退出、未知 Driver 兼容修复及最终 Semantic 验收。不能给项目整体套用该时间或宣称已接近发布。

> **下一批 Codex Prompt（所有者接受上述分包方案后生效）**：以 r05 固定输入和具名 Host／Driver 当前内容建立一个新隔离候选。你独占两组的共用生产文件，不覆盖共享树或其他执行者内容。按已批准 SRT-02 清单完成组 A，再从其精确内容按 SRT-06 白名单迁移 Source 和真实消费者，移除反向依赖，复用同一参数、工具名和 View 包装实现。保留完整数据／授权／身份／生命周期、原断言及已记录 D1／D2 差量，交分组 patch、精确产物和一次集中运行入口。验证 R／I 两项真实安装、完整类型和必要调用／释放；已知兼容失败独立记账，不扩展 Driver 执行主链、Host 预览或新 API。白名单内小修保存 attempt，不反复重写范围；越界携具体证据升级。交付由 Minimal Core 独立终审，执行者不得自行批准，不采用共享代码、不发布、不替代所有者最终 Semantic 验收。

原提案及交付保持 READY_FOR_REVIEW 历史状态，本次独立裁决见 [机器签收](../review-evidence/minimal-core-srt06-relocation-proposal-20261107/owner-review/final-signoff.json)。
