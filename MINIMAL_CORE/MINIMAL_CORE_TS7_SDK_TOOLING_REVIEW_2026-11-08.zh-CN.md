# TS7 SDK 开发工具增量：独立复核结论

2026-11-08。**SDK 四文件增量、四包正常开发安装与构建、M4 原生编译器身份采集，以及 Jest 合成诊断分别限定 APPROVED。整个 TS7 工具链与完整集成仍为 CHANGES_REQUESTED。** IDE 原生 LSP 方案和运行入口另行裁决，不由本报告自动准入。共享生产采用、发布、Host／GUI、真实模型与最终 Semantic 验收不在本次结论内。

## 1. 精确交付与改动意义

候选为 `.tmp/typescript-sdk-tooling-20261108/candidate-r01`。负责人核对 266 件封存输入，从前批 864 件源码基线物理重放四文件补丁，结果与候选逐字一致；签署前再次核对全部输入和候选指纹。

| 文件 | 最终改变及其边界 |
| --- | --- |
| `sdk/package.json` | 构建和静态检查显式执行原生 TS 7.0.2；仅开发工具通过官方 alias 使用旧 JavaScript Compiler API。parser/plugin 固定为 8.72.1，原 lint 命令保留。 |
| `sdk/pnpm-lock.yaml` | 锁定上述开发依赖组合。新增或替换项限定在 parser 家族、API6 和相应工具依赖；共同 package 元数据没有漂移。 |
| `sdk/README.md` | 解释构建编译器与开发 API 的区别；修正与已批准实现相矛盾的旧 Ref 范围说明，明确多个顶层对象／对象列表及可选组合、普通文件路径和 SRT-05 未完成边界。 |
| `sdk/tests/srt01-m4/freeze-author-capsule.py` | 沿用现有封存脚本，通过安装包自己的解析器识别平台原生程序，记录实际可执行文件、版本与指纹；错误 API 包或缺少原生实现不能冒充编译器身份。 |

这批修复的是 TS7 迁移后的开发工具可运行性和证据身份，不重写产品调用行为。SDK 没有新增运行依赖或作者概念；Runtime／SDK 仍使用前批的行为实现。开发环境同时维护原生编译器和旧 API 实现，是明确的兼容成本，后续工具原生支持成熟时应重新评估移除。

精确身份：

- `submission-manifest.json`：266 项，SHA256 `6e4b9703ce35ce59d618a26919655fbf1544c3b89197b3638e327e701a5da7ef`。
- `source-final.json`：864 项，SHA256 `15149ff1064d8ab71be93646b15b5a251bbf167fdf672bd7d1fa94142eb5c3d4`。
- `candidate.patch`：SHA256 `7fd77aad571de5a83ffc993974b88d8b198593bf2bd72bd2c1e661f2a0f88dd3`。
- 新 SDK tar：SHA256 `44eb997ac53dcdcd898ce0f2dce4dffbb628742a59d6e02a26790d32c854703e`。

## 2. 负责人独立验证

### 正常开发安装与构建：APPROVED

负责人使用自己的仓库外重放副本 `/private/tmp/aotui-sdk-tooling-review-source-c5fxdu5y` 和独立 pnpm store，正常执行 Runtime、Driver、适配包、SDK 的 frozen 安装及各自 build。四包共 443 份 dist 与封存产物逐字一致：Runtime 351、SDK 64、Driver 16、适配包 12。SDK static typecheck 通过。

SDK 和适配包都使用各自正常安装的 Node 类型，未依赖仓库上层 node_modules。上一批适配包缺本地类型的首次 TS2688 记录保留；本次安装闭合证明不改写那次失败。负责人首次受限网络安装报 ENOTFOUND，保留原始日志，随后通过工具级网络授权以同一脚本完成正常安装；没有将失败报作成功。

### 全量 lint 恢复及无新增诊断：APPROVED；lint 本身仍非全绿

实际执行原命令 `ESLINT_USE_FLAT_CONFIG=false eslint src`，覆盖全部 33 个源码文件。结果为 **3693 errors、110 warnings、0 fatal，退出码 1**。负责人逐文件核对实际源码指纹和完整诊断对象，与旧可运行 TS5.9 基线及最终交付相同。

因此批准的是 parser 恢复工作、规则与覆盖保持、无新增 lint 回归。现有代码诊断未清理，本批没有删除规则、机械格式化或隐藏退出码。初版尝试的 `--ext` 已在冻结前撤回，最终命令未改变。

### 正常公共包消费与严格类型：APPROVED

负责人另建 `/private/tmp/aotui-sdk-tooling-review-public-y5clqsri`，通过正常 npm ci／ls，核对实际 Runtime 367 件及新 SDK 78 件包文件。公开消费者直接使用 TypeScript 7.0.2，安装图没有 API6；strict、exactOptionalPropertyTypes、skipLibCheck:false 保持。

Core／SDK 公共正例、作者正例和 31 个独立负例通过。另删除九处类型错误抑制注释，编译确实拒绝对应错误用法，诊断依次为 2540、2339、2540、18048、2540、2339、2322、2322、2375；没有仅凭注释存在来认定负例有效。

新 SDK tar 与前批相比只有 README 和 package.json 改变；64 个 dist、运行依赖、peer 和 exports 保持一致。因此本次不重复启动 Worker 来为未改变的运行文件制造新的成绩，前批真实双 Producer 证据继续按其精确范围引用。

### M4 实际编译器身份：限定 APPROVED

负责人直接执行精确新增函数，验证普通 npm 与 pnpm native alias 两种布局，得到相同平台包和原生文件指纹；API6 与缺少平台实现两项错误输入均被拒绝。脚本 SHA256 为 `14381192e4ddf7ccf372aab50b02c7a0e294abc2d2cf628cd47ec417a94baeff`。

实际平台为 Darwin arm64、Node 24.15.0。原生程序为 7.0.2，SHA256 `a82f731365ad69d5c4c15f5e18fba4584bf3b7b839960172a76c3462b5114bf2`。执行方另有完整离线 capsule 的三正包／十负向边界通过记录；负责人独立新增验证限定于本次变化的身份函数和冻结输入核对，不声称重新完成作者模型验收或其他操作系统验证。新模型调用为零。

### Jest 合成诊断：限定 APPROVED

负责人在 `/private/tmp/aotui-sdk-tooling-review-jest-p5urzaka` 正常安装，使用与冻结 IDE 逐字相同的 Jest 配置和编译选项。Jest 29.7.0、ts-jest 29.4.9、官方 API6 alias 的实际 API 6.0.3：两个合成正例通过；错误赋值分别被原生 TS7 和 ts-jest 以 TS2322 拒绝，错误测试没有进入执行。

这证明所测兼容组合能执行和诊断合成样例，不代表 IDE 原测试、语言服务或生产 App 通过。执行方首次冷缓存准备未完成的事实保留。负责人也没有关闭 diagnostics、降低严格选项或运行应用初始化。

## 3. 未覆盖风险与整体阻断

1. Driver 正常发布依赖图的八条上游 Tool 严格声明错误仍阻断完整集成。本批未修复、补丁覆盖或豁免第三方声明。
2. SDK 既存的 3693 个 lint error 仍存在；本批只关闭迁移引起的工具不可运行问题。
3. Jest 验证为合成场景，IDE 原测试仍需随真实后端迁移验证。原生 LSP 仅准备，实际能力、ScopedLSP 的 root／document／generation 保护及健康关闭均不能由本报告代签。
4. 四个旧 Demo 的 SDK API 编译问题和全链其余开发入口仍须按各自消费者收口。
5. M4 原生实现只在 Darwin arm64 运行验证。正常关闭、SRT-05、共享采用、发布及最终 Semantic 验收没有因开发工具通过而完成。

## 4. 下一批范围、准出条件与 Codex Prompt

SDK 四文件保持封存，不等待 IDE 探针才记结论，也不再扩大成全仓 lint 整理。接下来独立审查现有 IDE 原生 LSP 方案和精确有限入口：先证明固定原生版本的 diagnostics、hover、definition、references、symbols、双向调用层次、编辑后更新、协议错误恢复与正常子进程关闭，再决定生产迁移范围。

入口实际运行须有单独的负责人准入记录。即使原生探针通过，ScopedLSP 的旧响应拒绝、队列和容量、超时、root 退役与进程所有权也必须在实际生产实现中验证；不通过扩大版本白名单宣称健康。

> 冻结本批 266 项输入、864 件候选和新 SDK tar，按本报告分别记录 SDK／开发安装／M4／Jest 的限定 APPROVED，整体工具链继续 CHANGES_REQUESTED。不要把原 lint 错误写成已解决，也不要把合成 Jest 写成 IDE 原测试通过。后续 LSP 仅按负责人另发的精确入口裁决执行；保留原准备失败，不启动 Host、GUI、真实模型、用户项目或私人手测状态。完成获准探针后，提交真实 capabilities、请求／响应、编辑前后诊断、退出与进程组事实；原生能力证据和实际 ScopedLSP 保护分开。Driver 类型问题与旧 Demo 保持独立，不并入这四文件候选，不自行签收或共享采用。

## 5. 证据入口

- [266 输入、864 源码重放与包差异](../review-evidence/typescript-sdk-tooling-20261108/owner-review/frozen-input-audit.json)
- [签署前再次核对](../review-evidence/typescript-sdk-tooling-20261108/owner-review/final-input-recheck.json)
- [正常 frozen 开发安装、构建和完整 lint 比对](../review-evidence/typescript-sdk-tooling-20261108/owner-review/independent-development.json)
- [独立公共消费者与正负类型](../review-evidence/typescript-sdk-tooling-20261108/owner-review/public-consumer/review.json)
- [独立 M4 身份函数验证](../review-evidence/typescript-sdk-tooling-20261108/owner-review/independent-m4/review.json)
- [独立 Jest 合成诊断](../review-evidence/typescript-sdk-tooling-20261108/owner-review/independent-jest/review.json)
- [机器签署与不可变证据指纹](../review-evidence/typescript-sdk-tooling-20261108/owner-review/review-signoff.json)
