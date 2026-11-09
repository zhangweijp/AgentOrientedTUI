# 下一批：SRT-04／05 具体 API 与迁移决策材料

2026-11-08，Asia/Shanghai。**范围：已授权只读设计的收尾与具体化；不授权生产实施、公开 API 采用、共享迁移、发布或最终 Semantic 验收。** 本任务承接 [只读复核的 CHANGES_REQUESTED](MINIMAL_CORE_SRT_04_05_READONLY_REVIEW_2026-11-08.zh-CN.md)，不另建产品目标或平行待办总账。

## 1. 要解决的问题

Agent 下一轮应能观察已提交的变化；正式采用新观察后旧资格失效，框架释放无用持有。方案必须继续使用现有 Context、Scope、注册和 lease 责任，保持调用防重、实际在途结算、单 App 故障隔离和现有容量保护。App 作者不增加手工 adopt、ACK 或内部生命周期编排。

当前草图还不能准出：跨轮 current 会让同一 Scope 的调用记录长期累计；逐个同步 adopt 不能证明多 App／来源整体切换失败后全部旧资格仍可用。本批将这些影响写成可选择、可审查的方案，再讨论实施。

## 2. 基线与编辑归属

- 技术基线继续使用 `.tmp/typescript-sdk-tooling-20261108/candidate-r01`。原 26 项 manifest、22 对 source-map、容量／raw 解析补充及负责人 audit 均复用；不得重写历史输入或把后补材料冒充原交付。
- 执行方只新增 `review-evidence/srt-04-05-api-decision-20261108/` 下的方案、说明用 diff、文件身份清单和 manifest；修改唯一 `deepseek_review.md` 总账时仅同步本批真实状态。原封存报告保持不变。
- 负责人维护 `MINIMAL_CORE/` 评审／任务／进度材料和自己的 `owner-review/`，独立复核；双方不并行编辑同一文档或生产文件。
- 可只读查看原 22 对源码及它们直接涉及的接口、调用方和契约测试。为查明真实提交边界，补充读取候选 `sdk/src/app-factory/createTUIApp.ts`、`sdk/src/components/AppTools.tsx`、`sdk/src/components/View.tsx`、`sdk/src/context/AppRuntimeContext.tsx`、`sdk/src/contexts/view-runtime-context.ts`、`runtime/src/spi/worker-protocol/messages.ts`、既有双 Producer fixture／提交测试；只记录新增实际依赖，不再复制全仓。若直接依赖要求其他文件，说明路径和用途，仍只读。
- 不改共享或候选生产，不运行 Host／GUI／真实模型，不读私人手测状态，不重跑 TS／LSP，不修改包版本或依赖。现有两项上游阻断保持独立身份。

## 3. 必交材料

### A. 用人话说明选择，再给准确接口

给一个推荐方案和至少一个真实备选。每个方案说明用户可观察行为、作者是否增加概念、维护成本、公开兼容变化及采用后代价。必须比较：

1. **显式 Core 采用，Driver 继续每轮释放。** 说明它如何支持直接 Core 的同 Scope 换代；一轮结束后没有 current 时如何表示；不能承诺跨轮捕获失败仍保留已经释放的旧资格。如果它不能满足某条已确认产品约束，指出具体约束和最小反例。
2. **显式采用，Driver 跨轮保留 current。** 说明持续持有的实际用途、Scope 寿命、调用条目／fingerprint／metadata 累计、收据过期与去重期限、容量耗尽时可操作的恢复方式。不得只讨论 Observation 容量，不得自动提高限额、删防重记录或轮换 Scope 绕过合同。

提供 Core 准备／采用／释放、Source Context、Driver 接入、Producer 刷新与 raw Snapshot 读取涉及的准确 TypeScript 签名和结果形状，标明哪些公开、哪些内部。讨论用方法名不是已获批准 API。非 AOTUI Source 不承担观察机制；AOTUI 也不能因可选方法缺席而静默跳过强制采用。

### B. 明确组合边界，移除未经证明的承诺

用状态表分别写单 Scope、同 Source 多 App、多个 Source。在 A 已采用、B 随后拒绝／抛错的情况下，写出每个参与者的 current、旧资格、prepared 持有、模型是否发出、错误结果及后续恢复。

若推荐按 App 隔离，只承诺实际拥有的原子性，说明健康 App、失败 App 和整轮组装失败如何区分。若推荐更强的整体原子性，必须给出在现有 owner 内可审查的控制流及不能失败的提交点，处理同步重入和关闭；不能只写“同步、无 await，所以原子”，不能默认引入通用事务层。已撤销的旧资格不得为了回滚而复活。

### C. 四个时点和生命周期表

列清业务完成、投影提交／Host 接受、捕获、采用。实际调用的参数校验、授权、执行及真实结算与之并列说明。

提交部分必须追到实际 SDK render／commit 接线。说明一次观察等的是哪一批已开始的提交、未发生 mutation 的 commit 如何结束、投影失败如何返回、Worker 发布如何对应 Host 接受。普通 TS 已同步提交与 SDK Worker 共用同一语义；不能固定 sleep、等待任意微任务次数、重读业务磁盘或等待所有后台任务静止。

生命周期表必须覆盖：inputs unchanged 提前退出；准备后放弃；准备／采用失败；模型请求失败；一轮多次串行 Tool；pause／stop／disable／dispose；App 关闭／同名重开；采用时实际调用未结算；晚响应；独立 GUI／CLI 预览；O1 准备、O2 准备并采用、再尝试采用 O1；旧准备迟到完成。每行写 owner、资格和真实引用分别发生什么。

### D. 容量与 raw 解析支持范围

列出 current／prepared／reservations、source／lease、字节额度和调用记录各自计费方式。Context／Observation 限额 1 和 2 必须单列：不足时返回什么、旧资格是否仍存在、怎样释放、是否还能恢复。不能通过改名漏计候选。

正式 Ref 调用与无 Scope 的 `SnapshotStore.resolveRef` 分开说明。另一合法 owner 持有旧 Snapshot 不延长原会话的调用资格。若取消无 owner retired payload 的 TTL 读取，明确 `getById`／`resolveRef` 的结果变化、迁移和文档；若让 raw API 也校验会话，明确额外签名及理由。不要把已交给外部的 JS 对象承诺为可撤回数据。

释放表覆盖：Snapshot retire 时已经没有 lease、最后显式 release、TTL lease 到期、实际调用最后结算、Source 数组／binding／闭包持有、当前已提交状态及 degraded last-good。只保留有说明的真实 owner，不新增无上限历史保留。

### E. 迁移 diff、文件清单及验证矩阵

交付只用于说明的差异文件，至少展示直接 Core 调用者、AOTUI Source／Driver、独立预览三个消费方式的前后用法。diff 存在本批 evidence 中，不应用到任何生产候选。不能把伪代码当作已经通过类型检查的实现。

未来实施清单必须精确到文件，标明其承担的合同和对应测试；不使用“必要协议文件”等开放白名单。分别列 SRT-04 提交刷新、SRT-05 资格交接、payload 释放能否独立实施；如果有依赖，明确顺序，不能让中间版本开放错误资格。

最小验证矩阵包含以下真实正负场景，当前只设计，不运行新实现：

| 场景 | 必须验证的结果 |
| --- | --- |
| 已提交更新／无变化／投影失败 | 下一轮读取兼容状态；无变化无需人为延迟；失败保留业务收据且不重做业务 |
| prepared → current → 退役 | 未采用不能调用；新采用撤销旧调用和 Ref；退役或过时候选不能错误复活 |
| 组合中后一个参与者拒绝 | 与选定的真实原子性边界一致，无虚假整体成功或恢复旧资格 |
| Context／Observation 限额 1／2、字节和 lease 临界 | 实际计费、可恢复拒绝、释放后无遗留 owner，原边界不放宽 |
| 小额调用条目上限下连续多轮 | 区分每轮清理和持续 Scope；收据 TTL 不冒充条目回收；重复请求防重、冲突和结果过期行为保留 |
| 另一合法 owner 与最后 owner 释放 | 一个会话切换不损坏另一使用者；最后持有退出后 retired payload 真正退出框架引用 |
| 在途真实工作、stop、晚响应 | 不提前释放实际工作持有，不声称副作用撤回，不恢复旧资格 |
| 正常包与两种 Producer | 纯 Core、普通 TS、SDK Worker 分别验证同一合同；源码 alias 不替代包消费，外部依赖失败单列 |

## 4. 准出条件

- R1／R2 逐项有明确选择或可比较的具体选项，没有把缺口改写成已解决。
- 方法签名、状态表、迁移示例与容量／失败结果相互一致；每种持有有现有 owner 和释放点。
- 推荐方案说明删什么重复职责、谁保留必要行为、怎样验证、是否降低作者负担。
- 公开兼容变化和真正需要所有者选择的条目可直接审阅；已确认的产品目标不重新征求同意。
- 新增文件有真实身份清单，历史输入保持封存；目标、提案、当前行为、未来测试明确区分。
- 负责人独立给出 APPROVED 或 CHANGES_REQUESTED；即便材料批准，也不等于实施或发布授权。

## 5. Codex Prompt

> 完成 SRT-04／05 API 决策材料，落实本任务 A–E。复用已封存 26 项输入、22 对源码及容量／raw 解析补充，不重做全量盘点。先比较显式采用＋Driver 每轮释放与跨轮 current 的 Scope／调用记录寿命，再明确单 Scope、多 App、多 Source 的采用失败边界。追到真实 SDK 提交接线，给准确签名、生命周期／容量表、说明用消费者迁移 diff、精确未来文件清单和正负测试矩阵。只写 evidence 方案材料并同步唯一总账；不改生产、不运行 Host／GUI／真实模型／TS／LSP，不删除防重记录、不扩大额度、不新建管理器、不重开 D3。原报告保持封存；交负责人独立复核后，再将具体重大公开合同选择交所有者决定。
