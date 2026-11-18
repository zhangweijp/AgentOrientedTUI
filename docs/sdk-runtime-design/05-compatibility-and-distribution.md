# 05｜用窄应用合同解除成套升级，明确兼容承诺

| 项目 | 内容 |
| --- | --- |
| 文档 ID | AOTUI-D05 |
| 状态 | **收窄兼容承诺的方向已确认。已建立同版本产物基线，稳定面、发行与支持周期待讨论** |
| 修订 | 0.8 · 2026-11-18（Asia/Shanghai） |
| 代码观察基线 | `90449dc2d` 加本批工作树，SDK 0.9.0 / Runtime 8.0.0 |
| 关联 | [03 装配](03-core-assembly.md)、[04 后端](04-execution-backend.md)、[06 Preact 桥](06-preact-semantic-bridge.md)、[09 Schema 与命名](09-schema-and-tool-naming.md) |

## 有条件的结论

**若目标是让第三方 App 经得起 Runtime 的长期内部升级，应立即设计可明确判定、可用旧产物验证的窄 AppContract；当前可继续成套发布，独立 `@aotui/contracts` 包与更细的合同版本字段则按实际收益选择。**

“需要明确合同”是必要的设计方向；包名、版本字段、支持周期和公开导出的具体形式仍是 **proposal**。单独发包不是成功标准，Agent 能否正确开发、旧 App 能否在承诺范围内持续运行才是。

## 一、先看一次不该迫使 IDE 重写的升级

用户要求：

> “成套发布可以继续，但应开始收窄兼容承诺” 认同，但我需要明确的方案

沿用前两篇的 IDE 例子：Agent 用 SDK 构建应用，Files 是 `view_id=files`、`type=FileList`，展示文件数组与 refs；Editor 未打开时不暴露编辑工具，打开后成为 `view_id=editor`、`type=FileDetail`。多个同类型页面共享工具定义，同一 Editor 可从 `test.txt` 切到 `notes.txt`，不需要强制 remount。

Files 显示 `[测试文件](File:results[0])`；当 Editor 接收这个文件对象时，调用地址是 `files.results[0]`，接收页面是 `view_id=editor`。工具给回执，数据走 View。模型输入冻结后仍依据那次观察生成；有效调用的 Ref 取自 `originalObservation`，handler 使用当前执行闭包，业务冲突由 App 负责。Messages 兼有事实与记忆，当前页面区域每页一个最新快照。

现在只把 Runtime 内部 Snapshot Store 的数据结构换掉。**如果上述行为和公开合同都没变，已构建 IDE 理应无需重编。** 相反，若改了 Ref 地址规则、页面身份或执行结果含义，即使 TypeScript 仍能编译，也可能已经破坏兼容。本文保持地址分离，不提议这类语义变化。

当前同批 SDK / Runtime 的要求适合快速迭代，但长期把它作为唯一兼容规则，就会把“内核内部如何实现”传导成“所有应用必须跟着升级”。解决这个问题，首先要限定承诺的行为，而不是先创建一个新 npm 包。

## 二、当前证据：包依赖与稳定边界尚未完全分开

| 已核对事实 | 对问题的意义 |
| --- | --- |
| [sdk/package.json](../../sdk/package.json) 精确依赖 `@aotui/runtime: 8.0.0`；[SDK README](../../sdk/README.md) 要求同批 SDK 0.9.0 / Runtime 8.0.0，重编应用并重生成清单 | 当前采用成套验证，不是独立产物兼容承诺 |
| [Runtime exports](../../runtime/package.json) 有托管、`/core`、`/spi` 和 adapters；[SPI](../../runtime/src/spi/index.ts) 同时汇集作者、宿主、生命周期及 Worker 协议内容 | “已经导出”与“值得长期稳定”需要逐项区分 |
| [工厂合同](../../runtime/src/spi/app/app-factory.interface.ts) 有 `view-type-tools-v6`、lifecycle 和可选 persistence 标记；[Runtime README](../../runtime/README.md) 明确它们用于边界检查，不是跨版本协商 | 已有显式检查基础，无需从零建设协商平台 |

SDK 还使用 Runtime 中的参数编译、Ref 捕获与 DOM adapter；具体归属分别见 [06](06-preact-semantic-bridge.md)、[07](07-dom-adapter-boundary.md)、[09](09-schema-and-tool-naming.md)、[12](12-snapshot-performance.md)。只搬 `.d.ts` 或把精确依赖换成宽泛 peer range，都不能证明真实运行依赖已经解除。

### 一个已核实的收窄候选：公开的 entity 分支

公开 [Observation 类型](../../runtime/src/core/invocation/observation-types.ts)允许 `refs[].kind` 为 `snapshot-value | entity`，但同一实现的 [RefTarget](../../runtime/src/core/snapshot/types.ts)只有 `snapshot-value`，[快照校验](../../runtime/src/core/snapshot/validate-snapshot.ts)明确拒绝其他 kind；[观察生成](../../runtime/src/core/invocation/observation-registry.ts)直接使用已验证 Ref 的 kind。这是具体的类型与实现不一致，适合在首次收窄时列入候选。

仓内已检查的正常 adapter 与公开消费 fixture 未使用 entity 分支；这不证明外部无人依赖。删除它可能影响外部 mock、switch 或自建类型，仍需清点受支持消费者并明确迁移。非法 entity 输入的拒绝校验及负面测试则应保留：收窄类型承诺不等于取消数据边界检查。此处仅更新设计候选，尚未修改类型。

## 三、概念与系统：先分清兼容对象，再分清版本域

| 兼容对象 | 需要证明什么 |
| --- | --- |
| 作者源码 | 旧 App 源码用新 SDK 编译后，约定行为仍正确 |
| App 构建产物 | 旧 App 保持原产物，不重编也能在承诺的新 Runtime 上运行 |
| Host 集成 | 公开的观察、采用、调用、收据与关闭合同保持 |

运行环境另算：Node API、模块格式、受支持的 Preact 和可选原生依赖仍须满足要求。AppContract 兼容不能让任意构建产物自动运行在任意环境；默认作者方式继续是 Preact。

也不能用一个版本号回答所有问题：

| 版本域 | 说明哪种变化 | 谁负责 |
| --- | --- | --- |
| SDK 包版本 | 作者 API、helper 和适配层变化 | SDK 维护者 |
| Runtime 包版本 | 实现及公开集成 API 变化 | Runtime 维护者 |
| AppContract 标识 / 版本（proposal） | 已构建 App 要求的应用语义基线 | SDK 生产、Runtime 验证 |
| Worker 内部消息版本 | 同批 Runtime 内两端如何通信 | 默认执行 backend；不自动公开 |
| App 持久化数据版本 | 业务数据如何解释与迁移 | App；不由合同包兜底 |

若独立发布 contracts，它也有包版本，但不应再造一份与 AppContract 随意漂移的语义真相。合同包变化应映射到明确的合同描述与支持表。Runtime 8.x、SDK 0.x 与未来合同 1.x 可以并存，不需要把所有包号重置一致。

## 四、首版可做的具体方案：窄清单、明确标识、支持表、旧产物

以下是推荐的首版设计工作，均为 proposal；不是把整个 `/spi` 或 `/core` 冻结成标准。

### 1. 明确两类公共合同，排除内部装配

作者侧以现有[工厂合同](../../runtime/src/spi/app/app-factory.interface.ts)和[实例合同](../../runtime/src/spi/app/app-instance.interface.ts)为起点逐字段收窄，不把所在文件的全部内容自动冻结。

| 边界 | 首版应逐字段确认的内容 | 留在内部 |
| --- | --- | --- |
| App 作者合同 | 现有 `TUIAppFactory.initialize`、必要 `RuntimeContext` 能力、`AppInstance.close` 与可选 `whenCommitted` 的含义；完整 frame、类型工具声明、Ref 捕获及结果语义 | registry / coordinator 的构造、绑定计数器、内部 owner 对象 |
| Host 集成合同 | 安装/取得实例、观察、采用、调用、收据、停止与关闭报告的必要能力 | snapshot receiver 的接线、Worker 请求表、物理线程实现 |
| 可选能力 | lifecycle、persistence 等已有端口的支持与失败规则 | 通用插件发现、无限能力协商、App 业务迁移 |

执行端的实例与提交归 AppKernel 及其组件，调用端 interaction 负责观察与收据，Worker Host 负责物理资源。若将来支持第三方托管 factory，再从这些边界选择需要承诺的行为。[装配所有权](03-core-assembly.md) · [执行环境](04-execution-backend.md)

首版同时明确稳定错误语义及对应机器可读诊断：不支持合同、清单/工厂不一致、提交数据无效、业务已执行但投影失败、无足够证据确认执行终态。这些情况不得被压成一个可盲目重试的 `failed`。具体 error code 优先整理已有代码，再冻结公开清单，不要求为提包重新命名全部错误。

### 2. 使用一个可判定的最低标识，不先建设协商

只有一个稳定基线时，精确合同 ID 已足够。以下是**拟议字段与示例值**，不是当前 `aoapp.json` 已支持的功能：

```json
{ "appContract": "aotui-app-v1" }
```

SDK 工厂与清单生成器从同一处元数据生成该要求；Runtime 的支持表把它映射到明确的作者、生命周期和必要能力合同。不能把当前 `view-type-tools-v6` 单独当成覆盖所有语义的证明；已有边界校验继续承担各自职责。

| 输入 | 首版推荐处理 |
| --- | --- |
| 清单和工厂同为受支持 ID | 允许继续初始化，并校验实际数据和环境 |
| ID 不在明确支持表内 | 明确拒绝，报告所需与已支持合同；不猜测兼容 |
| 清单与工厂不一致 | 定位声明冲突；不任选其中一个 |
| 产物没有新标识 | 新合同路径明确拒绝，不猜测兼容；首次切换时一次迁移当前消费者，不增设长期 legacy 路径或自动 fallback |

正式切换前，项目仍按当前已声明的成套合同运行；切换是一次明确迁移，不是在新 Runtime 中长期维护两套自动选择的合同。新路径先检查清单，再加载模块核对工厂，之后持续校验输入数据。清单检查不是安全沙箱，也不能消除受信 App 模块顶层代码已执行这一事实。

### 3. 为承诺范围留下可验证证据

首版冻结后保留真实已构建 App、原清单、既定依赖组合及环境要求，建立“App 产物 × Runtime 实现”的小型支持表。后来只改 Runtime 内部时，直接运行保留产物；不能先重编、改清单或用源码别名替换依赖，再声称产物兼容。源码兼容与 Host 类型检查另行覆盖。

记录 App 与 Host 两侧实际解析到的 SDK / Runtime / 适配层版本及模块位置，而不只记录预期 package.json；同时核对 App 与作者适配共享受支持的 Preact 实例。如果旧 App 仍加载旧 Runtime helper，单独存在一个合同包也不足以证明依赖已解除。验证既走开页、跨页 Ref、编辑的成功路，也保留原观察，在接收页面关闭后调用，证明原有失效规则仍生效，不被悄悄重定向。

### 首批保留的产物与一次真实消费结果

Work Items 的 Preact 入口和共享业务声明已用 TypeScript 7.0.2 编译一次，生成原始 `aoapp.json` 后按 npm 包归档。归档为 2,382 字节，内含两份 JavaScript、应用清单和带精确依赖的 `package.json`。完整 SHA-256 为 `01e700d0db0394a247e7f97683ade6453605ea31d3cd9e0b466660f71a0c07b1`。下次验收先核对归档摘要再解包，同一路径中的入口同时提供给本地工厂和 Worker 加载器。重新编译 README 与作者 fixture 属于另一项源码验收。[保留的 App 产物](../../sdk/tests/package-consumer/baselines/work-items-sdk-0.9.0.tgz) · [原始作者入口](../../sdk/tests/fixtures/work-items-preact.tsx) · [业务实现](../../sdk/tests/fixtures/work-items.ts)

| 消费边界 | 本轮实际结果与以后如何比较 |
| --- | --- |
| 安装 | 构建阶段复用本机现有开发依赖，从本批源码重建 Runtime 8.0.0、SDK 0.9.0、Driver 0.3.2、adapter 0.5.0 四个本地 tar。在仓库外干净目录离线严格安装 peers，贯通脚本只从包 exports 加载。类型检查使用 NodeNext、`strict`、`exactOptionalPropertyTypes`、`skipLibCheck: false` |
| 解析 | 消费运行使用 Darwin arm64、Node 24.15.0、pnpm 10.15.1、TypeBox 1.4.3、Preact 10.29.1、AI SDK 6.0.326。脚本从 App、SDK、adapter 各自的 ESM 父模块解析并比对实际路径，App 与 SDK 共用同一 Preact，SDK 与 adapter 指向宿主安装的 Runtime，adapter 与 Host 解析到同一 Driver。实际路径随请求事实一并写入报告 |
| 正反两路 | 原样归档既能在 Worker 打开并操作，也能交给独立装配执行。在两条路径关闭重开同名页后，旧观察对该页的调用均被拒绝。两边使用相同业务代码，成功收据与下一次呈现各有清楚的结果 |
| 可复验入口 | 现有 full 安装包检查新增 `assembly-provider-execution`。对已按 Host 配置干净安装四个包的目录，运行下述命令，查看报告的 `assembly.turns` 中的请求与观察、`assembly.receipts` 中的路由与终态、`assembly.release` 中的实测计数。模块位置和归档摘要在 `assembly.resolutions`、`assembly.archiveSHA256`。常规本地发行检查已调用同一入口 |

```sh
node sdk/tests/package-consumer/verify-package-consumer.mjs "$CONSUMER_DIR" "$EVIDENCE_JSON" full
```

本次实际运行的是 full 消费检查的七个步骤，包含当前包 README 编译/执行、Worker、Source、provider 与 Preact 提交验证。纯 Core 的 strict fixture 另行执行并读取其见证值。离线首次安装缺少 TypeScript 在 Darwin arm64 的本地编译器，用同版本已装编译器打包补齐临时测试依赖后通过。探针初版把 Core 无原型 JSON 与普通对象做深相等比较，还曾把显式传入指令的去尾空白当作默认指令路径。已分别改为核对实际字段与走默认指令加载，首轮失败日志和最终报告分别保留。工程验证没有涉及其他 Runtime 版本、跨平台发行或真实 Agent 生成任务。[安装包检查](../../sdk/tests/package-consumer/verify-package-consumer.mjs) · [现有发行脚本](../../scripts/release-local.mjs)

本轮验证的组合是 Work Items 0.1.0 原始产物与本批 Runtime 8.0.0。归档解在已安装精确依赖的 Host 目录下，ESM 从该消费树解析。升级 Runtime 后复用归档时仍须记录 SDK 实际加载的 Runtime，才能区分“旧 SDK 仍使用旧 helper”和“相同产物已在新实现上运行”。未来决定更换应用合同或支持周期时，需要写明哪些组合继续支持、哪些需要迁移。

第五批复用同一归档、SDK 0.9.0、Runtime 8.0.0 和 adapter 0.5.0，用旧包、退回首版和修正版的实际 Driver 0.3.2 tar 区分构建。原样 Work Items 跑通暂停后迟到回包、新输入恢复和关闭。修正版再用这份归档走托管 Worker 与独立 Core 两路，核对 11 张收据并验证资源释放。App 清单、Tool Schema、收据查询和调用入口按现有合同消费。[双路径消费](../../sdk/tests/fixtures/assembly-consumer.mjs)

模型传输有独立的兼容边界。首版在通用 Chat Completions 路径误拒缺少 `finish_reason` 但带独立 `[DONE]` 的旧输入，在内置 DeepSeek 路径又放过提前 EOF。负责人独立复跑了旧包、首版及修正版。修正版在两条路径都保留显式结束的旧输入并阻止裸 EOF 分派。Driver 将锁文件中已有的 `eventsource-parser` 3.1.1 声明为直接依赖，应用作者沿用原来的清单和 SDK 入口。这项包消费验收覆盖本地已安装的依赖组合，跨版本支持周期另行决定。[轮次与收据实测](01-messages-facts-and-memory.md#已发送的轮次如何收尾) · [Driver 包清单](../../agent-driver-v2/package.json) · [provider 选择](../../agent-driver-v2/src/core/provider-factory.ts)

## 五、三个发行方案：合同可以先清楚，包可以后拆

统一按语义、owner / 公共组合、Agent 开发成本、长期移植成本和当前收益判断，不给抽象架构打分。这里的 **Minimalist** 是先固定必要合同与证明方式，只有能减少真实依赖和协调责任时，才增加独立包或更细的版本字段。

| 方案 | 收益与作者 / Host 责任 | 即时成本与长期成本 | 使用条件 |
| --- | --- | --- | --- |
| A. 成套发布，先收窄 exports 与承诺 | 现有开发流程稳定，Agent 只需选受支持组合；Host 暂时协调整套升级 | 现在最小；第三方 App 增长后协调成本仍在 | 合同尚在收敛，单一发行节奏足够 |
| B. 窄合同先留在 Runtime 的纯子入口（proposal） | 作者与 Runtime 内部模块解耦；Host 仍消费 Runtime 包 | 无新包治理；SDK 的安装/版本依赖仍可能落在完整 Runtime 上 | 先验证公共边界，尚未证明独立发包有收益 |
| C. 独立 `@aotui/contracts`（proposal） | SDK 与 Runtime 依赖同一窄合同，有机会独立发布 | 增加一个包的构建、版本映射和支持检查；可减少实现升级对 App 的传导 | SDK 运行时依赖已真正归位，并出现独立升级需求 |

**当前推荐先做 A 下的合同清单与验证，必要时用 B 落实纯模块边界；满足条件后采用 C。** 这不是把合同推迟，而是避免用新增包掩盖未拆开的依赖。

若采用 C，合同包只包含必要 DTO、初始化/清理端口、合同描述以及确需共享的纯校验/规范化；不依赖 Node、DOM、Preact、TypeBox 或 Runtime 状态。SDK 保留作者体验与 TypeBox 转换，Preact/DOM 适配按 06/07 归位；Runtime 保留状态、执行与托管。Snapshot Store、持有计数、Worker codec、renderer scheduler、诊断哈希与缓存布局不进入合同包。

拆包的具体触发证据是：SDK 的运行时 import 已只需窄合同和作者侧能力；至少一个真实发布需要 SDK / Runtime 独立升级；独立安装与旧产物验证能通过。此时新包减少了依赖和协调责任，而不仅仅增加一个名字。

## 六、之后怎样扩展合同，又不制造第二套版本平台

出现多个向后兼容能力基线时，可将精确标识演进为下列**候选表达**：

```json
{ "appContract": { "major": 1, "minimumMinor": 0 } }
```

规则需明确：1.0 产物在实现至 1.2 的 Runtime 可进入初始化；要求 1.2 而 Runtime 仅支持 1.0 则拒绝；1.x 对仅支持 2.x 不能自动降级；清单与工厂始终必须一致。最低要求由 SDK 受支持的生成路径声明，初期可由每个 SDK release 固定实际生成基线，不分析任意业务代码猜测它使用了什么。

版本变化仍按行为判断：Runtime 私有存储优化不改变 AppContract；新 SDK helper 若输出同一合同，仅改变 SDK；新增可选能力只有在保持旧产物行为时才可能是合同 minor；Ref 地址、页面身份、旧观察调用或公开必填字段改变属于 breaking 候选。新增 union 分支也可能破坏旧消费者穷尽匹配，不能一概算兼容增加。Worker DTO 随同一个 Runtime 交付的变化，原则上留在内部消息版本域。

具体支持周期另作有限承诺；不引入自动 fallback、多版本解析器注册中心或远程能力协商。

## 七、成熟实践与实施顺序

[SemVer](https://semver.org/) 要求先声明公共 API，再表达兼容变化；[Node package exports](https://nodejs.org/api/packages.html#package-entry-points) 帮助明确可导入入口，但不是安全隔离；[VS Code Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest) 展示显式声明宿主要求的做法。这里只借鉴原则，不照搬 Marketplace 或声称它们已定义 AOTUI 合同。

首轮按顺序完成：列出真实消费者和上述公开合同清单；确定一个精确合同 ID 及支持表；从单一元数据生成清单/工厂声明；保留旧产物验证；在同一迁移批次更新必要消费者。默认 Preact 不变，开页准入与 rollback 暂缓；不以其重新设计为前提。

之后按证据拆除 SDK 到 Runtime 实现的 import，再决定 contracts 独立发行；出现第二能力基线时，才决定更细版本字段。一次版本范围修改不等于已完成这些步骤。

## 验收与跨文档依赖

- 保留的 IDE 产物、原清单和既定依赖组合在承诺的新 Runtime 上执行，记录两侧实际依赖解析；验证页面切换、类型工具共享、原观察 Ref、资格撤销、在途持有与关闭结果，并覆盖关闭接收页后的失败调用。
- 不支持的合同及清单冲突在适当边界明确失败；业务完成、投影失败、执行未知仍有不同事实。
- 新 SDK 声明的最低基线必须用真实产物在对应 Runtime 验证，不能只测最新版。
- 对外类型通过真实安装包检查；同一应用的 Preact 解析要求及模块环境单独验证，不用源码路径注入或 `skipLibCheck` 掩盖问题。

首批复用了既有 full 安装包检查。后续公开合同如果变化，再按风险增加对应的安装组合。当前沿用已确认的页面语义与 Ref 两种地址，也保留 `entity` 的公开类型分支等待正式迁移决定。[公共合同检查](../../runtime/tests/verify-installed-contracts.mjs) · [Ref 地址](11-ref-address-contract.md)

修订 0.3 的证据与限定保存在原始评审和回复中。修订 0.4 增加了可直接复用的同版数据点，拆包、合同 ID、外部类型收窄与版本范围仍需独立决策。[评审原文](REVIEW-2026-11-18.md) · [评审回复](REVIEW-RESPONSE-2026-11-18.md)

## 待讨论的四个决定

1. 首个稳定基线具体纳入哪些公开类型、错误 code 和现有可选能力？以真实消费者与合同清单决定。
2. 首版精确合同 ID 的实际值、清单位置和唯一生成元数据放在哪里？本篇给出的是 proposal。
3. 哪个实际独立发布需求足以触发 `@aotui/contracts` 拆包，哪些低层 `/core` 入口仍有外部稳定价值？
4. 首个基线承诺多长支持周期；出现第二兼容基线时是否采用 major + minimumMinor？不承诺无限历史兼容。

## 决策与讨论记录

| 日期 | 记录 | 状态 |
| --- | --- | --- |
| 2026-11-18 | 用户认同成套发布可继续、兼容承诺应收窄，并要求明确方案 | **方向已确认** |
| 2026-11-18 | 提议窄 AppContract、纯合同层、静态要求与旧产物验收 | **待讨论** |
| 2026-11-18 | 不把修改版本范围、类型搬家或增加包号等同于已经实现兼容 | **方案约束** |
| 2026-11-18 | 未改依赖、公开 API、清单、构建或实现代码 | **实施状态：未开始** |
| 2026-11-18 | 修订 0.2：增加 IDE 升级例子、版本域和三个真实发行方案；给出首版窄清单、精确 ID、支持表、旧产物验证；拆包与更细版本字段按证据推进 | **文档修订；具体方案仍待讨论** |
| 2026-11-18 | 修订 0.3：核实 entity 公开分支与实现不一致，列为待迁移候选；增加原产物实际依赖解析和失败路验证，保留外部消费者影响边界 | **评审采纳为设计更新；未批准实现** |
| 2026-11-18 | 修订 0.4，保留首份真实编译产物，接入既有 full 包消费，记录两侧实际模块解析及关闭重开失败结果 | **同版本产物基线已建立，跨版本支持范围待定** |
| 2026-11-18 | 修订 0.5，原样归档验证 Driver 缺终止原因修复。分别记录模型响应兼容边界和实际 App 包组合 | **验证同一 App 归档的两套 Driver 构建** |
| 2026-11-18 | 修订 0.6。安装包复验保留原样 App 的兼容证据。首版在两种结束方式和两条内置 provider 路径上分别有拒绝和误执行，传输修正退回 | **保留 App 产物证据，收紧 provider 兼容的建议未采纳** |
| 2026-11-18 | 修订 0.7。三份真实 Driver 包与同一原样 Work Items 对照两种结束方式，复验修正版托管与独立 Core 消费 | **保留已验证的 provider 输入与同版 App 基线，跨版本支持范围待定** |
| 2026-11-18 | 修订 0.8。负责人逐文件核对三套安装目录与 tar，确认修正版 16 个 Driver 产物来自受验源码，原 Work Items 归档在两路取得 11 张收据并释放持有。补充接入说明后另用 npm pack 核对 19 个发行文件，唯一内容变化为 [Driver README](../../agent-driver-v2/README.md) | **第五批同版本包消费验收通过** |
