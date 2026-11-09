# 公共消费者类型兼容：独立范围裁决

2026-11-07。**静态兼容范围及两份补充合并审查 APPROVED；兼容修复与完整退出仍为 CHANGES_REQUESTED。** 接受的是已验证的错误归属、支持范围边界和下一任务要求，没有改变 TypeScript 支持政策、生产依赖或公共 API，也没有新增编译或产品执行。

审查对象包括 [原范围报告](MINIMAL_CORE_CONSUMER_TYPE_COMPAT_SCOPE_2026-11-07.zh-CN.md)、48 件原产物，以及后续 [边界对齐补充](../review-evidence/minimal-core-consumer-type-compat-scope-20261107/ALIGNMENT_ADDENDUM.zh-CN.md) 和 [公共类型门禁补充](../review-evidence/minimal-core-consumer-type-compat-scope-20261107/PUBLIC_TYPE_GATE_ADDENDUM.zh-CN.md)。原报告中的迁址说明、下一步顺序和遗漏的类型选项按这两份补充阅读；原件保持不变。仅原报告单独使用不足以表达本裁决。

## 已核实的事实

负责人核对 48 件原产物、883 个读取输入、21 份原件副本和两组补充指纹，共 938 个去重文件，未发现内容漂移。另从原始 stdout 独立重新提取并比较诊断，Driver-only 与 r05 adapter 的 36 个文件／行／列／code／完整消息元组一致；只去掉已知文件系统前缀。[独立静态审计](../review-evidence/minimal-core-consumer-type-compat-scope-20261107/owner-review/scope-audit.json) · [审计脚本](../review-evidence/minimal-core-consumer-type-compat-scope-20261107/owner-review/audit-static.py)

| 问题 | 实际结论 | 不能推导出的结论 |
| --- | --- | --- |
| TS 5.3 adapter 的 36 条错误 | 冻结 Driver-only ESM 对照也能复现；30 条 NoInfer、6 条泛型 Uint8Array，来自 AI／provider-utils／Zod 声明 | 不能归为本批 Ref 消费者迁移导致；也不能因此豁免准出 |
| TS 5.9.3 通过 | 既定样本、配置和冻结依赖图通过；r05 公共链已由负责人实际复跑 | 不是所有编译器版本、完整作者 API 或最低版本已验证 |
| json-schema 声明查找 | r05 夹具的精确完整声明 paths 解决了当时的 TS7016 | 不是普通安装通过，也不能要求所有 App 自行配置绝对路径 |
| 最低支持版本 | 限定 30 份公共文档及补充的 SRT 文档未给出统一数字下限；devDependency 不是消费者承诺 | 不能自行提高下限，也不能取消已下发的 5.3.3／5.9.3 门禁 |
| Runtime 依赖具体 Driver | 当前 Source 和公共声明经过 Driver 的完整 Context／Tool 类型，引入其 AI 声明图 | type-only、optional peer 或另一个仍引用 AI 类型的入口不会自动解耦 |

既有实际结果保持原限定：r05 四个外层命令为 0／0／0／2；TS 5.9 三入口、TS 5.3 Core／SDK 通过，TS 5.3 adapter 失败。负责人先前独立执行的 Driver 对照、公共四调用和三文件 70 项原件继续保留，本次只是静态复核，没有把旧运行计作新增测试。

负责人审计脚本首次用错归档配置文件的命名筛选条件，停在配置数量断言；改为实际 `*-tsconfig.json` 后通过。原脚本及[纠正记录](../review-evidence/minimal-core-consumer-type-compat-scope-20261107/owner-review/reviewer-script-correction.json)保留。这是审计脚本问题，不是项目测试失败或产品回归。

## 对齐后的两项硬边界

**Runtime 去具体 Driver 依赖的方向已经确认，应继续推进。** `deepseek_review.md` 3.1 要求把现有 Driver 专属 Source、转换及 jsonSchema 包装迁到 Runtime 外，保留 Runtime 的 Snapshot／Observation／Scope／Ref 责任和 SDK 复用同一参数编译能力。已有集成目录是候选落点；全面拆包、新协议包、重写 Context 或缩减 Tool 不在授权内。两份 SRT 文档目前位于 `SRT/`，旧根路径缺失属于迁址，不是证据遗失。

原报告 A／B 只是 Driver 自身 TS 5.3 兼容专项的选择，不得替代或暂停上述边界迁移。迁移可以使 Runtime 的消费不再受具体 Driver 牵连；Driver／集成的 36 条错误仍需独立解决。两个门禁分别记账，不能用一项通过抵消另一项失败。

**公共类型的完整门禁必须恢复为原要求。** 原 [QUALITY_GATE_PLAYBOOK](../.tmp/worktrees/srt-01-owner-handoff-20261105/docs/handoffs/srt-01/QUALITY_GATE_PLAYBOOK.zh-CN.md) 第 82–83 行要求真实 tar 全新安装，并在 TS 5.3.3／5.9.3 使用 strict、`exactOptionalPropertyTypes:true`、`skipLibCheck:false`，正例和逐一负例分开。负责人核对了三份 r05 原配置：没有 extends，也未启用 exactOptionalPropertyTypes；当时使用 tar 提取和链接，未做普通安装。故完整门禁尚未覆盖，启用遗漏选项后是否另有诊断未知。原门禁文件 SHA 为 `540bd6075e9fdf77f92636d6953f534b8331a018b4370e2dfba82376273dee2f`。

## 未覆盖风险

目前没有经过完整门禁验证的替代依赖组合，也没有证明升级下限是唯一选择。普通安装解析、其他 TS 版本、SDK 全部作者 API、CJS 和独立入口的全面兼容仍未验证。降级依赖可能改变模型元数据、Schema 与单次执行合同，不能以消除诊断条数为唯一标准。

SRT-02 的 Source 裁剪与 SRT-06 的 Source 迁出有文件交集。下一步必须以一份明确基线顺序实施，保留原观察绑定、调用来源、短收据、最新 View 与 Context 释放，不启动并行生产修改。当前没有任何发布、共享采用、正常安装或 Host／模型运行授权从本裁决自动产生。

## 下一批范围、准出条件与 Codex Prompt

下一批先产出可审查的 **SRT-06 现有适配器迁移提案**。指定执行线独占提案与证据；SRT Owner 保持已签收退出范围冻结。只读核对现有 Host／Driver 集成落点、正式包边界和真实消费者，给出一个优先方案及必要的取舍，不发明替代协议。无需重新讨论已经确认的去依赖目标。

提案须列明：现有文件到拟议文件的映射、旧公开导入到新导入的示例、真实调用方、可保留的验证、manifest／锁／声明／文档影响、与 SRT-02 的实施顺序，以及后续允许改动的精确白名单。必须回答正式 Runtime 包能否在不安装具体 Driver 时消费，适配器如何保留完整 Driver 合同；若现有目录无法形成合理的公开分发边界，应把具体原因交上级决定，不自动新建包。

后续验收分开保留：① Runtime 不安装 Driver 的真实包消费；② Driver／集成的完整类型与运行语义。两者都使用原公共类型要求，正常安装、执行与资源释放另提供精确入口。当前只允许静态提案，不运行编译、构建、安装、产品、GUI 或模型，不改依赖及最低版本。

> **Codex Prompt：** 接续本裁决和两份补充，以 r05 固定 Source／Core／SDK 及具名当前集成文件为依据，准备 SRT-06 最小迁移提案。你与 SRT Owner 共用项目，不得改其封存证据、共享生产或私有手测状态。查明现有 Source／转换／jsonSchema 职责、Host／Driver 已有集成目录及公开包消费者，提出具体落点与旧→新入口映射；保留完整 Context／Tool／Schema、SDK 共用编译器和 Runtime 身份／授权／生命周期。列出与 SRT-02 交集及单一实施顺序，两项真实包门禁各自独立，保留两版 TS 与 exactOptionalPropertyTypes 等原要求。只写指定新提案和证据，不修改源码、依赖、最低版本，不执行新行为或安装，不引入新协议包、兼容层、状态管理器、可选 peer 或旧 re-export。先交最小具体方案、准出矩阵、精确后续文件白名单与 Prompt，供负责人独立复核和必要公开入口决策。

本裁决的机器引用见 [最终签收](../review-evidence/minimal-core-consumer-type-compat-scope-20261107/owner-review/final-signoff.json)。APPROVED 限于静态范围包，完整兼容问题仍 OPEN。
