# 四、机制设计（MEC-01 ~ MEC-07）

返回 [设计索引](00-index.md)。

---

<a id="mec-01"></a>
## MEC-01：Preact 私有钩子依赖与开页超容恢复机制

- **问题证实度**：已复现
- **理想态明确度**：部分明确（待定边界）
- **实现方案状态**：**暂缓**

### 现状事实
- `sdk/src/app-factory/render-commit.ts` 依赖 `preact@10.29.1` 内部私有字段以捕捉真实渲染提交。
- `prepareOpeningProjection(update, revert)` 在开页触发 `OBSERVATION_CAPACITY` 时执行 `revert`，并对恢复后的整帧 `canonicalJson` 做全等比对；若期间无关状态（如计数器）发生变化，恢复比对会报错。
- 实测证实：**恢复报错不会导致 App 永久损坏**——下一次有效提交成功后，错误态清除，页面重新正常发布。

### 已确认共识
- 私有钩子抬高了依赖升级成本；候选帧预检方向值得研究，但框架依然不能自动撤销 App 已经执行的外部业务写入。
- 本项改造暂缓，保留现状事实与候选记录，不从其他改动中顺带固定新方案。

---

<a id="mec-02"></a>
## MEC-02：高频流式变更下的整帧成本与版本号封装（已选定待验证）

- **问题证实度**：**已复现**（已完成现行实现 vs 按需拉帧对照实测）
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**

### 1. 现状事实与对照实测数据（真实 Node Worker + 现行构建产物）
在不改仓库代码的前提下，对比“现行 16ms 主动推帧”与“无人预览、保留首帧、末尾按需读一次 + 健康首帧作基线”的临时对照（200 tick × 5 行 = 1,000 行，本地提交 201 次，两边最终均读到 `DONE` 与 1,000 行计数；字节按整帧 JSON 统计，未调用模型、未测端到端 CPU 节省比例）：

| 实测场景 | 现行实现 | 临时对照（1A 方向） |
| :--- | ---: | ---: |
| **空闲 500 ms，随后首次预览** | 2 个整帧（含 1 帧重复） | 1 个整帧 + 1 个 `PROJECTION_CURRENT` 短确认 |
| **1,000 行日志，附两页 25 KiB 静态正文** | 54–56 个整帧，约 2.86–2.97 MiB | **2 个整帧，约 105 KiB** |

- 另核实现行快照判重实现：主线程通过规范化内容比对判重（[store.ts](../../core/src/snapshot/store.ts#L218)），诊断摘要使用 **FNV-1a 64**（[json.ts](../../core/src/snapshot/json.ts#L163)），未计算 SHA-256。

### 2. 已修正/撤回意见
- 撤回早先“空闲时也按 60fps 全量推帧”的误判。
- 纠正初稿“主线程计算 SHA-256 摘要”的笔误：实际为规范化内容判重 + FNV-1a 64 诊断摘要。

### 3. 已确认决策
1. **选定 1A：打开时发首帧，之后正文按需传整帧（不做跨线程 View Diff）**：
   - **无人看预览时**：App 照常本地提交，Worker 可将连续变化合成为轻量“有更新”通知，不主动向主线程推送整帧；后台刷日志不叫醒模型，值得 Agent 关注的事走 `requestAttention()`；**Agent 常驻监听唤醒建议不算作“有人看预览”**。
   - **有人打开预览时**：界面先立即读一次；持续滚动时由 Host 控制界面刷新策略（如 100–200 ms 合并刷新，且必须保证最终态如 `DONE` 显示出来）。
   - **Agent 正式观察时**：直走 `FLUSH_PROJECTION` 等待已安排提交完成并读取最新完整页面，不等待界面刷新定时器。
   - **必守权限底线**：**没人看预览，权限变化也必须即时生效**（例如通讯录将邮箱从 `public` 改为 `private`，无人看预览时 `run_code` 再读值仍须拒绝，见 [console-inputs.ts](../../core/src/invocation/console-inputs.ts#L45)）。凡依赖“现在还能不能用”的操作必须向实时来源核对当前资格；有资格时，数据值仍取自原 Observation，绝不能让开关预览改变权限行为。
2. **保留三个版本号职责并将同步序号封入内部协议，健康首帧作基线**：
   - `sourceEpoch`（App 本地成功提交次数）与 `producerSeq`（Worker 发送发布次数，重发亦递增）收进 Worker 与 Store 的内部同步协议；普通 Host 使用 `snapshotId` 标识快照，需要判断内容变化时看 `revision`（主线程接收内容实际变化版本）。
   - **健康首帧基线条件**：仅当首帧来自当前 Worker、当前 App 实例且 Store 成功接收并处于健康状态时，方可作为后续 `FLUSH_PROJECTION` 基线；首次 `preview()` 仍向 Worker 确认一次，双方一致仅回短确认；遇到投影故障、实例重开或迟到旧回复，按真实状态报故障或重新取帧（保住既有 26 项刷新测试边界，见 [worker-host.ts](../../runtime/src/engine/app/worker-host.ts#L834)）。

### 4. 决策记录
- **2026-11-24（已确认）**：选定 1A（打开首帧 + 按需传整帧 + 预览刷新归 Host 策略 + 守死无人预览下实时权限核对底线）；保留三版本号分工并将 `sourceEpoch / producerSeq` 封入内部协议，健康首帧可作基线。
---

<a id="mec-03"></a>
## MEC-03：Ref 与普通字面值的无歧义表达（已选定待验证，2026-11-24 修订为统一 `$ref.`）

- **问题证实度**：代码已证实
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**（三家 Provider 严格模式兼容性记为**待真实接口验证**）

### 1. 现状事实（代码证实）
- 当前 Native Tool 路径对普通参数（[tool-parameters.ts](../../core/src/tool/tool-parameters.ts#L375-L393)）在 JSON 字符串通道上使用单 `$` 前缀（`$app_id.view_id.ref`），导致所有以 `$` 开头的普通字面文本（如 `$HOME`、`$100`、Shell/代码变量）必须双写转义为 `$$HOME`、`$$100`。
- 当前 Console（`run_code`）路径普通参数直传 JS/JSON 值（`encodeProgramArguments` 自动转义 `$` 前缀），仅 `refParam` 字段接受 `$app_id.view_id.ref` 字符串，两端规则不统一。

### 2. 已修正/撤回意见
- **撤回初版方案 B（`{"$aotui_ref": ...}` + `{"$aotui_literal_json": ...}` + `run_code` 的 `ref(...)`）**：Native 嵌套大括号与长键名对模型过于啰嗦，且会使所有 `string` 参数被迫拆成 `anyOf` 联合类型；同时 `run_code` 与 Native 格式不统一，增加认知与跨进程编码复杂度。
- **排除 `$.` 前缀方案（如 `$.contacts.list...`）**：与 JSONPath（如 `$.items[0].name`、SQLite `json_extract`、AOTUI 诊断路径 `$.views`）及 jQuery（`$.ajax(opts)`）高频冲突。

### 3. 已确认决策（全链路统一 `$ref.`）
1. **双端统一扁平格式**：Ref 表达规则只存在于 `[模型 / 入口适配器] ↔ [Runtime]` 之间，App 业务代码始终直接接收 Runtime 解析好的只读值。Native Tool、Console（`run_code`）与 `system-inspect_ref`（[CON-04](01-conceptual-design.md#con-04)）**全部统一使用同一种扁平字符串写法**（普通参数与 `refParam` 写法一致）：
   - 完整格式：**`"$ref.<app_id>.<view_id>.<ref_id>[...path]"`**（必须包含 `app_id` 以区分跨 App 同名页面），例如 `"$ref.contacts.list.people[0].email"`，带点号的键写成 `"$ref.contacts.list.people[0][\"display.name\"]"`。
   - **混用示例**：
     - Native Tool：`{ "to": ["boss@co.com", "$ref.contacts.list.people[0].email"] }`
     - Console（`run_code`）：`tools.mail.send({ to: ["boss@co.com", "$ref.contacts.list.people[0].email"] })`
   - 普通参数可以直接填业务字面值或兼容的 `$ref.` 地址；`refParam` 必须选一个真实发布、类型匹配的 Ref，手抄一模一样的值也不能充当该 Ref。
2. **极低撞车与最小转义规则**：
   - 普通字符串 `"$HOME"`、`"$100"`、`"$$HOME"`、JSONPath `"$.items[0].name"`、jQuery `"$.ajax(opts)"` 以及普通对象 `{"$ref": "#/defs/User"}` 一律原样保留，**无需任何转义**。
   - **识别位置限定**：引用**只在顶层参数槽位或直接数组元素位置**且字符串以 `$ref.` 开头时识别，不深入文件正文中间或嵌套对象内部扫描。
   - **罕见撞前缀转义**：只有当整个参数值或直接数组元素字面本身以 `$ref.` 开头时，才双写为 `"$$ref...."`（去掉一个前导 `$` 后按原文交付）。
3. **Console（`run_code`）语义分工**：
   - 保持两个动作清晰分离：`refs` 供脚本直接读取本轮可见的 `public` 值进变量参与计算/循环；传入 `"$ref.contacts.list.people[0].email"` 字符串则请 Runtime 把引用转交给目标页面（即使脚本无权读 `private`/`protected` 值也可安全转交，且循环拼接索引如 `` `$ref.contacts.list.people[${i}].email` `` 天然无 Proxy 陷阱）。Runtime 在真正调用时按本轮名单与目标页核对权限，猜中地址也拿不到值。
4. **Native Schema 按需展示（B-按需，大幅减少联合类型）**：
   - 按需改变的是展示给模型的工具说明，引用本身的语义固定。
   - **`string` 类型参数天然兼容 `"$ref...."`，无需再拆成 `anyOf` 联合类型**（显著规避 Claude 严格模式整次请求最多 16 个联合类型参数的上限）；仅对**非字符串参数**（如对象、整数、元组），当本轮存在获准交给该类型页面且类型可能匹配的 Ref 时，才在工具说明中按需加入引用字符串分支。同类型多页仍共享一份工具说明，执行时按实际选中的接收页核对权限。

### 4. 必过验收测试（看 App 最终实际收到什么）
| 要测的事 | 通过标准 |
| :--- | :--- |
| 原文有没有被改 | `$HOME`、`$100`、`$$HOME`、`$.items[0].name`、`$.ajax(opts)` 及对象 `{"$ref": "#/defs/User"}` 都逐字原样保留；整个槽位传 `"$$ref.contacts.list.x"` 时准确还原为字面文本 `"$ref.contacts.list.x"`；文件正文中间包含 `$ref.xxx` 不触发解析。 |
| 隐藏字段/跨页 Ref 能不能正确转交 | Native 和 `run_code` 都能把“手填值 + `$ref....` 引用”按原顺序交给获准页面；对 `private`/`protected` Ref 直接读值、换一个未获准页面、把整条不匹配对象当成字符串字段传入，均应在业务函数执行前被拒绝。 |
| 旧引用会不会指错人 | 通讯录更新后，同一轮的有效引用仍取当轮选中的邮箱；原页关闭后同名重开，或切到下一轮再使用旧 `$ref....` 地址，均明确拒绝。 |
| 三家严格模式能不能真用 | **（当前状态：待真实接口验证）** 将实际生成的整组 Native 工具（含字符串参数与按需联合的非字符串参数）分别发给 OpenAI、DeepSeek、Claude 并开启严格模式，验证服务端接受、模型能写对、App 收到正确值。 |

### 5. 决策记录
- **2026-11-23（初版，已被下方替代）**：曾暂定 `run_code` 用 `ref(地址)`、Native 用 `{"$aotui_ref": ...}` + `{"$aotui_literal_json": ...}`。
- **2026-11-24（修订确认）**：撤回 `{"$aotui_ref": ...}` 与 `ref(...)`，排除与 JSONPath/jQuery 冲突的 `$.`；正式定为 Native Tool、Console（`run_code`）与 `system-inspect_ref` 全链路统一扁平字符串 **`"$ref.<app_id>.<view_id>.<ref_id>[...path]"`**（仅整槽位字面以 `$ref.` 开头时用 `$$ref.` 转义），确认 4 项验收标准。

---

<a id="mec-04"></a>
## MEC-04：多 App 观察半采纳与请求级原子切换（已选定方案 B 待实现验证）

- **问题证实度**：**已复现**（高优先级）
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**

### 1. 现状事实（代码证实与复现）
- 当前每个 App 的 `ObservationState` 各自独立持有一个 `adoptedObservationId`（[observation-registry.ts](../../core/src/invocation/observation-registry.ts#L316)）。
- 一轮多 App 请求在呈现适配层（[semantic-aotui-driven-source.ts](../../agent-driver-adapter/src/semantic-aotui-driven-source.ts#L548-L585)）先循环逐个调用 `item.client.adoptObservation(...)`，再调用 `desktop.bindRequestSources({ apps })`（[request-sources.ts](../../core/src/invocation/request-sources.ts#L57-L79)）。
- **已复现缺陷**：当 App A 采纳成功（旧观察已立即被吊销）、App B 因候选窗口刚关闭或状态变更而采纳失败时，**A 的旧观察资格已失效，而 B 的旧观察仍有效**；且若 `bindRequestSources` 随后失败，A、B 旧资格同样已被不可逆销毁。

### 2. 已确认行为合同（选定方案 B）
> **核心决定**：Runtime 一次采用一轮请求的完整来源名单。成功时，新调用和 Ref 取值一起切到新名单；失败时，本次采用不改变旧名单。页面关闭和撤权始终即时有效，已分发调用继续按原来源结算。

具体行为约束（内部类名、计数器与数据结构由实现自定）：
1. **单一有效完整名单与原子生效**：一轮请求先完成所有参与 App 及跨 App Ref 绑定的校验与准备，全部通过后在单一权威点一次切换生效；任一校验或绑定失败，整张新名单不生效、候选请求不发送给模型。
2. **切换失败不让已关闭页面复活**：切换失败只保证“这次切换本身没有撤销旧资格”；若检查期间某旧页确实被关闭或撤权，该页仍须立即拒绝调用。反之，页面仅更新正文而原挂载与授权仍有效时，不应仅因正文变化一律拒绝。
3. **省略即撤销**：新名单是完整名单。从 `{A1, B1, C1}` 成功切到 `{A2, B2}` 后，C 仍可在后台运行，但不能再用 C1 发起新调用或作为跨 App Ref 来源；失败时本次尝试不撤销 C1。
4. **复用观察 ≠ 复用旧轮入口**：新一轮显式提交 `{A2, B1}` 可以继续展示和使用 B1，但持有上一轮调用入口的调用方不能因新名单里恰好仍有 B1 而继续发起调用——执行须同时核对页面/观察与所属轮次身份。
5. **入口边界**：
   - 单独使用 `@aotui/core` 时，保留单 App 的 `adoptObservation()`（等价提交只含 1 个 App 的完整名单）；
   - 在 `Desktop` 中，统一走请求级入口（只想采用 A 就明确提交 `{A}`，禁止一个看似只改 A 的单 App 方法暗中撤掉 B、C）。
6. **在途调用与延迟释放**：
   - 已发往 App 的写入继续按原来源完成，并可用原编号查询收据；还在等待授权、尚未发出的旧调用须在发出前复查并拒绝；
   - 切换生效后释放旧资源时若某 App 释放报错，不得阻断释放其余 App，且该释放故障必须如实报告，不能宣称资源已释放。

### 3. 必过验收测试（5 项对抗场景）
| 场景 | 必须看到的结果 |
| :--- | :--- |
| 检查 B 时，A 的候选观察被释放 | 新名单整组失败；原来仍有效的页面继续可用，真正关闭或撤权的页面继续拒绝调用。 |
| 新名单生效后，释放 A 的旧资源时报错 | A、B 都已切到新一轮；仍继续释放 B；A 的释放故障如实报告，不能宣称资源已释放。 |
| 新名单省略 C | 成功时，C1 的新调用和 Ref 取值立即失效；失败时，这次尝试本身不撤销 C1。 |
| 切换时，旧轮已有一次写入发往 App | 已发出的写入按原来源完成，能用原编号查收据；还在等授权、尚未发出的旧调用在发出前复查并拒绝。 |
| A、B 各自都有效，但整组 Ref 绑定失败 | 整组不切换，候选请求不发送（覆盖当前“先采纳、后绑定”的第二处缺口）。 |

### 4. 决策记录
- **2026-11-23（已确认）**：选定方案 B（单一有效完整来源名单，合并采用与跨 App 绑定）；明确省略即撤销、复用观察须区分轮次入口、Desktop 统一走请求级入口，以及上述 5 项必过验收用例。

---

<a id="mec-05"></a>
## MEC-05：配额记账简化与活跃责任持有分离（已选定待验证）

- **问题证实度**：代码已证实
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**

### 1. 现状事实（代码证实）
- 现行 Core 在 [store.ts](../../core/src/snapshot/store.ts#L69-L84)、[observation-registry.ts](../../core/src/invocation/observation-registry.ts#L20-L28) 与 [app-interaction.ts](../../core/src/invocation/app-interaction.ts#L19-L29) 维护了 3 本重叠字节账本与 15 个配额桶，对同一份不可变快照反复拷贝算字节，并含固定 `WORK = 1 MiB` 虚拟工费预扣/退款；关闭释放则靠 `retainedBytes === 0` 推断。
- 现有单 App 收据默认上限为 `maxReceipts = 1024`、单条 `560 KiB`（[app-interaction.ts](../../core/src/invocation/app-interaction.ts#L24)），若直接去掉总字节账，收据正文理论上界高达 **560 MiB**。

### 2. 已修正/撤回意见
- 撤回初稿推荐的 3A（`maxReceiptBytes` 后置总字节上限）：存在“仅剩 1 KiB 空间时接受编辑、文件写入成功却放不下合法 2 KiB 收据”的接单后溢盘难题；若要在接单前校验剩余空间装得下最大收据，又会退回预扣账本复杂度。

### 3. 已确认决策
1. **谁还在用就继续持有，关闭直接核对实际持有者释放**：
   - 例如 `edit_file` 开始写盘后等待 2 秒超时：Agent 可结束等待，Runtime 仍记住该笔调用及其旧快照，直到收到回执或确认 Worker 退出记为“未知”。
   - 关闭时直接核对是否还有未结束的调用、读取、观察以及借给其他 App 的快照（[app-interaction.ts](../../core/src/invocation/app-interaction.ts#L158)），由实际持有者确认释放，**删掉靠 `retainedBytes === 0` 推断释放的逻辑**。
2. **同一份快照大小只算一次，借用各自归还，新生成数据各自查上限**：
   - 快照由 `SnapshotStore` 保存并统一算一次大小（[validate-snapshot.ts](../../core/src/snapshot/validate-snapshot.ts#L235)）；观察与工具调用各自借用、各自归还，最后一个借用者归还后旧快照即可释放。
   - 删掉另外两层对同一份快照重复拷贝算字节的逻辑，以及每次调用固定预扣 `1 MiB` 再退款的虚拟工费和 6 桶 `fees` 账本。
   - **保留边界**：新生成的数据仍须在生成时检查自身上限（如短 Ref 地址展开后的大正文、观察新增的工具说明与授权信息，见 [observation-registry.ts](../../core/src/invocation/observation-registry.ts#L219)）。
3. **收据选定 3B：先占名额再干活，并同步收紧默认 `maxReceipts`**：
   - 收到调用先查编号：相同请求沿用原记录，防止同一笔编辑重复执行；
   - 确为新调用时先占 1 个收据名额：满了当场拒绝（此时文件尚未动）；每张收据已有单条上限，占名额无需提前分配内存；
   - 收据正文到期可清，只要原观察仍有效就继续保留该编号，再遇同一请求时返回“收据已过期”避免重做；
   - **收紧默认条数**：实现时先定单 App 可留存收据数据的合理内存上界，再倒推合理 `maxReceipts`（替代现行 `1024 × 560 KiB ≈ 560 MiB` 过高理论上界），不再新增 `maxReceiptBytes`。
   - 保住既有 14 项 Core/Runtime 针对性测试覆盖的全部行为（超时持快照、最后归还才释放、过期仍防重、满额保旧收据）。

### 4. 决策记录
- **2026-11-24（已确认）**：确立关闭直查真实持有者释放（删 `retainedBytes === 0`）；快照大小仅 `SnapshotStore` 算一次、删重复算字节与 `1 MiB` 预扣退款、新生成数据生成期各自查上限；收据选 3B（先查编号→新调用占名额→过期留号防重→同步收紧默认 `maxReceipts`，不加 `maxReceiptBytes`）。
---

<a id="mec-06"></a>
## MEC-06：Schema 合同独立于 TypeBox 与多库映射边界（已选定待验证）

- **问题证实度**：代码已证实（现行 Core `compileValueSchema` 放行空声明 `{}`，工具根省略 `additionalProperties` 时默认允许额外字段）
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**

### 1. 现状事实（代码证实）
- [typebox-schema.ts](../../sdk/src/tools/typebox-schema.ts) 位于 SDK 侧导出纯 JSON Schema，[tool-parameters.ts](../../core/src/tool/tool-parameters.ts) 编译纯 JSON Schema；但目前缺少独立公开的子集规范与测试向量，`refParam` 仍假装 `type: 'string', minLength: 1`，`{}` 可通过 `compileValueSchema` 且匹配任意类型值，且 Native / Console 投影逻辑混在共享编译模块内。

### 2. 已确认决策
1. **工具参数与 Ref 共用同一套公开 JSON Schema 2020-12 支持子集，并去掉 `refParam` 假字符串**：
   - `refParam('Contact', ContactSchema)` 同时声明“来源必须是本轮已发布、允许当前页使用的 `Contact` Ref（手抄相同对象不通过）”与“解引用后的值必须符合 `ContactSchema`”；保留真实值 Schema 与 `refParam` 来源标记，删除仅为旧字符串线格式添加的 `type: 'string', minLength: 1`；Native 与 `run_code` 共用这两道检查。
   - **配合 `CON-04` 挡住空声明 `{}`**：Ref 必带 Schema 必须拒绝无约束空对象 `{}`（至少声明明确类型/结构）；SDK 在发布时指出缺失或不匹配位置，Runtime 在接收发布数据时按同一规则把关。工具参数最外层必为 `object`（顶层 `view_id` 留给框架），Ref 根可为任意合法基础或复合类型。
2. **SDK 工具根默认拒绝额外字段，Runtime 保留标准 JSON Schema 读法**：
   - **SDK 作者入口行为变更**：SDK 导出工具最外层参数对象时，未显式指定 `additionalProperties` 则默认导出 `additionalProperties: false`（拼错参数名如 `subejct` 当场报错；确实需要自由加键的作者显式写 `true`）；嵌套对象（如 `metadata`）尊重其自身声明。
   - **Runtime 标准读法**：对直接提交的标准 JSON Schema，省略 `additionalProperties` 仍按标准 JSON Schema 视为允许额外字段，保证 Python Host 与 TS Host 对同一份 JSON Schema 得出一致判定。
   - `default` 维持现有行为：声明期校验其符合声明，调用时缺省可选字段保持缺席不自动回填。
3. **继续禁用作者 Schema 的 `pattern` 关键字**：
   - 业务格式检查（如邮箱格式）归 App 代码；搜索工具等仍可声明名为 `pattern` 的普通字符串参数；作者若写成 Schema `pattern` 关键字，SDK 声明期直接报错定位。
4. **现阶段继续用 TypeBox，公开合同只认纯 JSON Schema，三家严格模式另行验收**：
   - **未来多库准入红线**：把作者用的库拿走、只看导出的纯 JSON Schema，仍能对同一批数据得出完全相同的通过/拒绝判定才予支持；依赖 JS 函数、查库或类型转换的逻辑留在 App 代码。
   - 公开合同配同一组通过/拒绝的语言无关测试向量供 SDK 与 Runtime 共用（内部可继续复用现有校验器实现）；OpenAI / DeepSeek / Claude 严格模式是否接受适配器生成的工具声明，另以各自真实接口结果为准。
   - **为 `MOD-01` 划清切分刀口**：纯 JSON Schema 子集校验器归共享合同层；TypeBox 导出归 SDK；Native / `run_code` 投影与三家严格模式检查归 Runtime/入口适配层。

### 3. 决策记录
- **2026-11-23（已确认）**：确立公开 JSON Schema 2020-12 支持子集与共享测试向量；去 `refParam` 假字符串；Ref 必带结构须拒绝 `{}`；SDK 工具根默认 `additionalProperties: false`、嵌套与直接标准 JSON 守标准读法；`default` 不回填；禁作者 `pattern` 关键字；现阶段沿用 TypeBox，三家严格模式另行实测。

---

<a id="mec-07"></a>
## MEC-07：生命周期内部动词精简与关闭阶段事实保留（已选定待验证）

- **问题证实度**：代码已证实
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**

### 1. 现状事实（代码与实测证实）
- Worker 内部消息含 `APP_OPEN`、`APP_STOP`、`APP_SHUTDOWN`、`APP_CLOSE`、`APP_DELETE`、`APP_REINITIALIZE`（[messages.ts](../../runtime/src/spi/worker-protocol/messages.ts#L63)），其中 `APP_SHUTDOWN` 在 `APP_CLOSE` 前构成空转往返——临时副本跳过发送 `APP_SHUTDOWN` 后，9 项关闭端到端测试（[close-reporting-e2e.test.ts](../../runtime/src/kernel/close-reporting-e2e.test.ts#L113)）两边均 **9/9 通过**，另有 5 项在途调用/迟到注册/重开测试（[worker-host.tool-lifecycle-e2e.test.ts](../../runtime/src/engine/app/worker-host.tool-lifecycle-e2e.test.ts#L200)）通过。
- Host 侧关 Desktop 存在 6 个同义入口，而 `host/` 实际全部只调 `desktop.beginClose().completion` 与 `runtime.beginShutdown().completion`；`reinitialize`（历史为上下文压缩引入，配套的 `usePersistentState` 与 `rehydrateOnReinitialize` 已退出）与 `deleteDesktop` 在 `host/` 中均零调用。

### 2. 已修正/撤回意见
- 修正初稿第 2 阶段命名：由“在途工作已终结”改为**“等待已接单的工作”**——宽限期耗尽只能说明 Runtime 等到这里，不能证明最后一次写入已经完成。
- 补正 `report.ok` 判据：必须包含现行 [close-handle.ts](../../runtime/src/engine/core/close-handle.ts#L139) 的 `verification === 'managed'`，而非漏掉校验维度。

### 3. 已确认决策
1. **关闭四阶段客观事实与唯一责任人**：
   - **① 停接新任务**：开始关闭瞬间，主线程立即关闭该实例调用入口（拒绝后续编辑），Worker 收到 `APP_STOP` 后通知 App 停止产生新工作，已有已发出编辑仍按原调用跟踪。
   - **② 等待已接单的工作**：主线程负责等与记录，App/外部服务掌握实际写入结果。若返回“写入成功”则认回执；若已派发且宽限期耗尽仍无可信回执，可强制退出并将写入结果记为**“未知”**；只有确认未派发或未进入 handler 才可记“未执行”。
   - **③ 清理 App**：正常路径先让 App 关子进程、写最后一笔草稿，再停接存储写入并等后端确认；强制退出跳过了哪一步，报告如实反映哪一步缺少确认。Worker 执行清理，存储后端确认保存，主线程核对各自回执。
   - **④ 确认释放**：Worker 真正退出即归还 **Worker 名额**（[worker-host.ts](../../runtime/src/engine/app/worker-host.ts#L1054)），但若存储仍在写，整个 App 的 `resourcesReleased` 仍为 `false`。各资源拥有者确认自己已释放，主线程汇总。
   - **判断口径**：Host 判断“这次关闭是否全部成功”直接看 `report.ok`（即 `state === 'settled' && resourcesReleased && verification === 'managed' && !hasFailures`）；`resourcesReleased` 独立回答资源是否收回（允许“资源已收回但最后一次保存失败”）；`handle.wait({ timeoutMs })` 仅限制该调用方等待时长，不中止关闭。
2. **精简关闭 IPC：只留 `APP_STOP` 与 `APP_CLOSE`**：
   - 删除多余的 `APP_SHUTDOWN` 往返；`APP_STOP` 立即发，`APP_CLOSE` 在正常路径等在途工作收尾后再发。
   - **必保边界**：App 仍在启动过程中关闭即到达时，稍后登记的资源仍须收到停止通知并清理一次（[app-lifecycle.ts](../../runtime/src/worker-runtime/app-lifecycle.ts#L36)），迟到的“启动成功”回包绝不能重新打开旧实例。
3. **Host 公开关闭入口选定 3A：三级统一 `beginClose()`**：
   - `RunningApp`、`Desktop`、`Runtime` 统一提供 `beginClose()` 返回 `CloseHandle`（最常见写法 `const report = await app.beginClose().completion`，需进度/限时等用 `inspect()` / `wait()`），移除仅换名的同义词入口（`dispose`、`destroyDesktop`、`beginDesktopShutdown`、`shutdown`）。
   - 同一实例关闭中重复请求共用本次关闭；结束后若仍有资源未释放，下次调用只补做释放、保留第一次错误，绝不重跑业务编辑或 App 清理回调。`system-close_app` 路由至对应实例句柄。
4. **移除 `reinitialize` 并选定 4B（撤掉关闭态 `delete`）**：
   - **移除 `reinitialize` / `onReinitialize` / `APP_REINITIALIZE`**（明确接口变更）：重启由 Host 显式“关旧实例（检视关闭报告并处理保存失败/未知）→ 按安装 ID 重开新实例（获新 `instanceId`，旧句柄与迟到编辑不可命中）”。
   - **撤掉 `intent: 'delete'`、`APP_DELETE`、`delete()` / `deleteDesktop()` 与 `onDelete`**：永久删除业务数据归明确业务操作（如 [PlanningApp.tsx](../../demo-apps/planning-app/src/tui/PlanningApp.tsx#L376) 的 `planningService.clearDesktop()` 迁移至显式删除操作，普通关闭始终保留计划），不依赖删除话题时该 App 是否恰好处于运行态；Host 仅清理自己拥有的数据，共享 SQLite 目录内其他话题保持可用。
   - **衔接 `MOD-03` 的收口准则**：**App 报告业务和清理结果，资源拥有者确认释放，外层汇总；四个阶段不需要四层各判一遍。**

### 4. 决策记录
- **2026-11-23（已确认）**：保留四阶段并将第 2 阶段正名为“等待已接单的工作”，补正 `report.ok` 含 `verification === 'managed'`；删 `APP_SHUTDOWN` 只留 `APP_STOP` + `APP_CLOSE` 并保住启动中途关闭边界；Host 选 3A 三级统一 `beginClose()`；移除 `reinitialize` 并选 4B 撤掉关闭态 `delete` / `onDelete`。
