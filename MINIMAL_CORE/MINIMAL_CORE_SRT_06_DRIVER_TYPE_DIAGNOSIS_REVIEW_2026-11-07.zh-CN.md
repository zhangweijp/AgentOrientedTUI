# SRT-06 Driver 类型诊断独立复核

日期：2026-11-07。执行：SRT Owner。独立复核：Minimal Core 负责人。

**诊断交付 APPROVED；单点声明副本实验准入 APPROVED；正式完整集成准出仍为 CHANGES_REQUESTED。** 本次不修改 B r02 的既有签收，也不批准生产依赖补丁、支持政策变化、共享采用或发布。

本次查清了两个不同问题。现有依赖声明使用旧编译器不支持的能力；此外，完整工具类型在严格可选属性检查下有内部冲突。已经测试的版本组合都没有同时满足原门禁。下一步用一个可丢弃副本，确认第二个问题能否由一处声明差异解释。

## 1. 交付与独立验证

执行方交付为 [诊断报告](../review-evidence/srt-06-driver-type-diagnosis-20261107/REPORT.zh-CN.md)，输入由 [132 件清单](../review-evidence/srt-06-driver-type-diagnosis-20261107/submission-manifest.json)封存。负责人实际核对 132/132 件内容指纹、5 项固定输入，以及原 B r02 签收的 28/28 个证据引用，复验后仍一致。

负责人在执行方正常安装的三个消费者中，分别独立重跑两版编译器的 Driver-only 检查，共六次。每次诊断全文及加载文件清单均与原始记录相同；另核对同图集成检查的原始诊断全文完全相同。四个原公共试件和严格配置逐字保留，Driver-only 没有加载 Runtime、SDK 或适配包声明。

| 正常安装图 | TS 5.3.3 | TS 5.9.3 | 复核结论 |
| --- | ---: | ---: | --- |
| ai 6.0.324，zod 3.25.76 | 51 | 8 | 单独固定 Zod 3 仍失败；其包内 v4 声明仍被加载。 |
| ai 6.0.77，zod 3.25.76 | 42 | 8 | Driver 所声明的 AI 6 下界仍失败，完整 Tool 还缺少当前 metadata 字段。 |
| ai 7.0.164，zod 3.25.76 | 171 | 18 | 越界负对照仍失败，不能作为推荐升级候选。 |

负责人把三个最小模型复制到自己的复核目录，独立运行两编译器，共六次。原严格可选属性冲突在两版均复现 TS2344；加入 no-output 形状后的模型两版均通过，并保留具体输出错误的负向断言；编译器特性模型在 5.3.3 失败、5.9.3 通过。

完整命令、退出码和日志见 [独立执行审计](../review-evidence/srt-06-driver-type-diagnosis-20261107/owner-review/independent-diagnosis.json)。本次复核没有再次安装三个消费者；正常 npm install／ls 属执行方原始证据。没有重跑已通过且未受影响的 Runtime 大套件，也没有启动 Host、GUI 或模型。

## 2. 技术判断

`NoInfer` 在 TypeScript 5.4 引入；`Uint8Array` 等 TypedArray 的缓冲区泛型在 5.7 引入。旧编译器无法理解这些声明，和 Source 位于哪个包没有因果关系。参见 [TypeScript 5.4 官方说明](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-4.html)、[TypeScript 5.7 官方说明](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-7.html)。这些语言能力的引入版本不自动成为项目的新最低支持版本。

负责人已读取实际 provider-utils 4.0.64 的 `NeverOptional` 与 ai 6.0.324 的 `ToolSet`。never 分支允许显式 `outputSchema: undefined`，any 分支的对应可选属性却不接受该值。ToolSet 同时容纳二者，再将它们代入要求完整 Tool 的类型时出现冲突。缩小后的模型足以证明这条冲突可以独立存在，但还不能证明真实声明中的八条错误全部只有这一原因。

将 any 分支加入现有 never 形状，比删掉 ToolSet 的 never 分支、缩窄 Driver 公共 Tool、复制一套本地工具接口更适合作为下一步诊断：它保持输入范围，并把变量限制在一处。不过，这会改变第三方声明的可赋值关系，仍须完整公开类型和正负向反例验证；不能仅凭编译退出码就认定正式修复成立。

## 3. 下一批精确范围与准出条件

本次在原“只读第三方声明”的诊断范围之外，仅批准新的 **LOCAL_DECLARATION_EXPERIMENT**。原三组 trial、原发布 tar、B r02 和共享生产保持原样。

1. 只复制已记录的 ai 6.0.324／provider-utils 4.0.64／zod 3.25.76 安装图到全新物理目录，不使用指向原图的硬链接。复制前后记录文件清单及指纹，并先复现未修改的两版完整诊断。
2. 唯一第三方声明差异是实际加载的 `@ai-sdk/provider-utils/dist/index.d.ts` 中 `NeverOptional` 的 any 分支：`Partial<T>` 改为 `Partial<T> | Partial<Record<keyof T, undefined>>`。所有运行时 JS 不变。
3. 保留原 Driver-only 与集成试件、TS 5.3.3／5.9.3、strict、exactOptionalPropertyTypes:true、skipLibCheck:false；不加路径覆盖、全局 shim 或简化公共接口。
4. 补真实完整 Tool 的针对性试件，覆盖 never／any 四组合、显式 undefined、具体输入／输出错误、metadata、inputExamples 和现有回调。保留 ModelMessage／Context；属性名清单只作为辅助。
5. TS 5.9.3 原八条错误全部消失且正负向合同成立，才可批准这条限定根因结论。TS 5.3.3 的剩余错误逐项记录，不能因为另一版本通过就豁免。两版本原诊断数量不同，不能简单按数量相减解释原因。
6. 如需第二处声明改动、出现不同问题或额外收窄，保留失败并提交差异；本次不授权连续扩大补丁。

完成后交付精确 patch、改前改后身份、两版本完整日志、额外类型试件、公共声明清单及风险说明，由负责人独立复核。

可直接转交的 Codex Prompt：

> 在全新物理副本中执行上面限定的单点声明实验。以已封存 zod3 trial 为唯一安装图来源，先校验及复现未改基线，再只修改实际加载的 NeverOptional any 分支。保留完整公开类型、两编译器和严格检查；记录所有输入身份、唯一差异、完整诊断与正负向反例。不得修改原 trial、原发布包、B r02、共享生产、JS 或第二处声明，不运行 Host／GUI／真实模型。结果只能标 LOCAL_DECLARATION_EXPERIMENT，不能作为正常发布包消费通过。交付后提交正式可交付方案，分别解释严格类型缺陷与旧编译器兼容的处理、来源和维护成本，不自动采用第三方长期补丁或提高支持下限。

## 4. 未覆盖风险与保留结论

本次没有证明任意历史版本都不可用，没有证明全部公共类型语义等价，也没有验证生产 provider 工厂／streamText 的运行变化。AI 7 的负对照不构成大版本迁移授权。模型中的通过不构成实际第三方声明已修复；副本实验的通过也不构成正式发布包通过。

若最终需要上游修复、受维护的依赖补丁或改变 Driver 的编译器支持范围，应交付明确来源、修改清单、行为验证与长期成本，再做相应决策。现有 Runtime／SDK 独立消费的批准保持；完整集成、共享采用、发布、SRT-05 和最终 Semantic 验收均不因本次诊断而改变。
