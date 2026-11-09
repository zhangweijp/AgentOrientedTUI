# TS7 首轮独立复核与下一批范围

2026-11-08。**新产物的限定构建、Core／SDK 严格消费和双 Producer 运行 APPROVED；整个 TypeScript 工具链迁移仍为 CHANGES_REQUESTED。** 官方开发工具兼容方案的最小 lint 诊断已独立 APPROVED，可以进入下述隔离实施。共享采用、发布、真实模型、Host／GUI 和最终 Semantic 验收不包含在本次结论内。

## 1. 本次确实验证了什么

负责人重新核对 279 件交付输入与 864 件源码来源，在 `/private/tmp/aotui-ts7-review-source-hv8ep5ba` 物理重放 40 文件补丁；864 件结果与候选逐字相同，已批准的 r02 参数预算修复没有变化。候选仍为 `.tmp/typescript-unified-latest-20261108/candidate-r01`，原始输入不改写。

独立重建 Runtime、SDK、Driver、适配包和 Host，四个分发包共 443 份 dist 与提交 tar 逐字相同；386 项 Core／CLI 测试通过。源码构建明确复用了已有开发依赖，不是正常 frozen 开发安装证明，也没有把源码的 skipLibCheck:true 当作公共严格门禁。

重建时还发现一个实际环境缺口：执行方适配包没有自己的 `@types/node`，依赖了仓库上层的 25.5.2。仓库外重放首次因此产生 TS2688。负责人为自己的副本显式提供符合该包 `^20.0.0` 声明的 20.19.35 后，适配包通过，生成的全部 dist 与交付相同。首次失败和补齐后的依赖来源分别保留；下一批必须让开发依赖闭合，不依靠上层目录。未修改执行方候选。

负责人另在 `/private/tmp/aotui-multi-optional-candidate-5zp2awnu` 正常 npm ci／ls，使用新 Runtime／SDK tar。实际 445 件包文件一致；编译器精确为 7.0.2，Core／SDK strict、exactOptionalPropertyTypes、skipLibCheck:false 和入口重新编译通过，15 件入口输入与获准版本一致。

负责人还在 `/private/tmp/aotui-ts7-review-integration-vf4sw8yr` 正常安装四包并核对 477 件实际文件。TS7 严格完整集成和仅导入 Driver 的对照都产生同样的 8 条 TS2344，逐字匹配执行方诊断。因此这项失败已独立复现，既不由适配器迁移消除，也不能被 Core／SDK 的通过抵消。

| 实际运行 | 普通 TypeScript | SDK Worker |
| --- | --- | --- |
| 执行方新消费者 | 22 次：14 成功、8 指定拒绝 | 22 次：14 成功、8 指定拒绝 |
| 负责人新消费者 | 22 次：14 成功、8 指定拒绝 | 22 次：14 成功、8 指定拒绝 |
| 复核结果 | 完整参数、缺席字段、只读路径、业务 witness、收据一致 | 与普通 TS 及原 r03 一致 |
| 清理 | Scope、观察、调用、注册和 Store 保留计数归零 | 正常 shutdown，资源释放、Worker 池归零，无失败 |

两方退出码均为 0，stderr 均为空，无强制终止。八个拒绝均发生在派发前，原业务 witness 不变。双方重复运行不计作新增场景，也不代表 SRT-02 全部参数形状已完成。

复核结果脚本自身有两次读取格式错误：首次把新增输出清单的相对根目录多拼了一层，随后误按嵌套 error.code 读取拒绝收据。已保留 attempt01／attempt02，修正为实际清单根目录和公开 outcome.code 后，核对原始运行文件通过；产品和入口没有因此重跑、修改或豁免断言。

## 2. 官方兼容方案的独立判断

Microsoft 明确说明 TS7 暂不提供旧 JavaScript Compiler API，并提供官方 TypeScript 6 API 兼容包与 TS7 原生编译器的 npm alias 组合。[官方发布说明](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0)

当前 typescript-eslint 的支持上限仍为 `<6.1.0`，不能通过简单升级 parser 就宣称它原生支持 TS7。[官方支持范围](https://typescript-eslint.io/users/dependency-versions/)

负责人核对附录全部 28 件输入，并在另一个新消费者 `/private/tmp/aotui-ts7-review-tool-option-86631af2` 正常安装和独立运行：

- `@typescript/native = npm:typescript@7.0.2`，实际 `tsc` 指向它，版本断言为 7.0.2。
- `typescript = npm:@typescript/typescript6@6.0.2`，正常解析的 API 实现为 6.0.3；另有独立的 `tsc6`。
- SDK 原 `.eslintrc.json` 逐字保持，parser/plugin 为 8.72.1。
- 正例没有问题；未使用变量仍为 error，显式 any 仍为 warning；与执行方诊断逐项相同。

**判断：可以将该官方方案用于确有旧 API 需求的开发工具，先完成 SDK lint 的隔离实施。** 构建和公开类型验证继续固定 TS7，不需要重新询问已明确的主编译器政策。这个方案增加一个开发依赖实现及其锁身份，不增加 App 作者步骤、内核兼容分支或运行时状态管理。代价是开发环境存在两个引擎、约 24.3 MB 的旧 API 文件和入口误用风险，必须明示并验证；不能称为所有工具均已原生 TS7。上游原生支持成熟后应重新评估移除旧 API 依赖。

该诊断只覆盖最小 lint 正反例，尚未证明全量源码 lint、ts-jest 或 IDE 语言服务通过。旧语言服务是 tsserver 的 LSP 包装，IDE 目前还使用专用 `typescript.tsserverRequest`；不能把编译器启动命令改掉就宣称迁移成功。[语言服务项目说明](https://github.com/typescript-language-server/typescript-language-server)

## 3. 未覆盖风险和整体阻断

1. SDK 原开发图的 lint 已实际失败；上述修复尚未应用到新的完整开发候选。全量 lint 的既存诊断与迁移新增问题必须分别记录。
2. IDE ts-jest 尚无实际修复验证；其默认语言服务、诊断请求和正常关闭合同需要专项迁移。`server.ts` 当前健康清理判定限定 5.1.3／5.9.3 组合，不能为了新版本通过而直接修改白名单。
3. Driver 正常集成仍有 8 条第三方 Tool 严格声明错误，独立于 lint；本轮有限批准未修复或豁免它。
4. 四个旧 Demo 的既有 SDK API 编译失败仍保留；源码能构建的主包不能替这些消费者签收。
5. 11 份锁、全部开发工具入口、作者验证准备脚本和正常开发安装尚须完成全链迁移收口。M4 编译器封存脚本仍只记录 package／JS 启动文件；TS7 的实际平台原生可执行文件身份也应明确记录。无需为该元数据修正重跑真实模型。
6. 没有运行 Host／GUI／真实模型，未更改私人手测状态。SRT-05、新观察接替后的旧引用失效，以及整体 Semantic 验收仍在原待办范围。

## 4. 下一批执行范围与准出

执行方仍独占生产候选；负责人只修改复核副本、证据和本目录文档。原 279 项和官方 28 项输入保持封存，在新目录准备增量。

| 子项 | 本次允许的工作 | 准出条件 |
| --- | --- | --- |
| SDK lint 最小实施 | SDK 开发依赖、相应锁、现有 build／typecheck／lint 入口的必要修改及当前说明；只在需要 JS API 的开发环境使用官方 aliases | 正常 frozen 安装；原规则不删；全量 lint 的前后诊断可比，无 parser crash；实际构建和公共严格类型始终为 TS7，SDK 正向／31 负例保留；实际发布依赖图不引入兼容 API |
| 开发依赖与编译器身份 | 补齐适配包正常开发安装的实际依赖记录；更新现有 M4 编译器身份采集以覆盖 TS7 原生实现 | 仓库外可重建；编译器入口、平台包、可执行文件与版本身份明确；不借用上层 node_modules；不启动模型 |
| ts-jest 兼容诊断 | 新隔离消费者中正常安装官方组合，使用有限、合成、无应用副作用的测试验证 transform 与既有测试选项 | 记录实际 API/编译器、通过与失败的断言、原生 TS7 类型检查；不删除测试、放宽 diagnostics 或伪称 IDE 原测试已通过 |
| IDE 原生 LSP 后续准备 | 只读盘点现有请求、结果映射、缓存和进程所有权，提出用官方原生 LSP 保持已有能力的精确补丁范围及有限运行入口 | 覆盖 diagnostics、hover、definition、references、symbols、incoming／outgoing 调用层次、编辑后更新、旧响应拒绝、错误恢复、shutdown 和子进程释放；真实能力和现有支持范围有证据，不直接放宽健康关闭判定 |

不因 SDK lint 方案向全部包机械加入双引擎。Driver 的严格类型问题继续按独立缺陷处理；旧 Demo 迁移不混入这批工具兼容 patch。IDE 后端改造先形成具体可审查方案，当前不启动 Host 或用户项目，也不自动批准生产 LSP 替换。

### Codex Prompt

> 继续 TS7 收尾，主编译器政策已确定。冻结原 candidate-r01／279 项输入和官方方案 28 项附录，在新隔离副本只实施 SDK lint 所需的官方 aliases、对应锁及必要脚本。原 lint 规则、strict、exactOptionalPropertyTypes、skipLibCheck:false 与作者负例不变；构建及公共消费者必须明确执行原生 7.0.2。独立公共消费者继续直接安装 TS7，不机械修改成 API6。正常 frozen 安装后运行全量 lint，并区分既存代码诊断与新故障；比较实际发布包依赖和 dist，兼容 API 不进入产品运行依赖。补齐 adapter 开发依赖闭合证据，保留负责人首次 TS2688 事实；更新 M4 封存工具的实际原生编译器身份采集。另在新合成消费者做 ts-jest 最小诊断，IDE 只读提交原生 LSP 的能力／清理映射和有限入口，不运行 Host、GUI、模型或私人项目。交付精确增量、正常安装图、原始失败和通过记录、源码及输出清单；不要自行签收。下一步由 Minimal Core 负责人独立复核。

## 5. 证据入口

- [输入与源码重放](../review-evidence/typescript-unified-latest-20261108/owner-review/entry-input-audit.json)
- [独立构建、首次缺依赖及补齐记录](../review-evidence/typescript-unified-latest-20261108/owner-review/independent-builds.json)
- [386 项实际测试](../review-evidence/typescript-unified-latest-20261108/owner-review/independent-core-cli.vitest.json)
- [正常安装与入口重编译](../review-evidence/typescript-unified-latest-20261108/owner-review/independent-entry-preparation.json)
- [双方实际调用、完整 witness 与关闭复核](../review-evidence/typescript-unified-latest-20261108/owner-review/independent-entry-result-review.json)
- [官方方案独立正常安装与 lint 诊断](../review-evidence/typescript-unified-latest-20261108/owner-review/official-tool-option/review.json)
- [新正常集成图的 Driver 严格失败对照](../review-evidence/typescript-unified-latest-20261108/owner-review/driver-strict/review.json)
- [TS7 原生编译器身份采集缺口](../review-evidence/typescript-unified-latest-20261108/owner-review/native-compiler-identity-gap.json)
