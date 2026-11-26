# 03 · 模块设计（Module Design）

本分册跟踪 `core`、`sdk`、`runtime` 与跨语言 Host 之间的模块切分与职责归位。

---

<a id="mod-01"></a>
## MOD-01 · 跨语言 Host 共用页面呈现原语（消除 XML / Ref 漂移）

- **三维度状态**：问题证实度 `已复现` ｜ 理想态明确度 `已明确` ｜ 实现方案状态 `已实施待复核`

**已拍板结论（2026-11-25）**：选方案 A，将标准 `<view>`（含 `region`）、`<desktop>` 应用目录、投影后业务 Tools、可选标准 `system-*` 控制工具声明、默认指令以及可直接交给 `adoptTurn()` 的页面名单统一收口到 `@aotui/runtime/adapters` 与 `aotui-stdio` 的无状态共享呈现出口。**同时修正核心窗口资格规则**：正文因预算省略（`hint`）的页面同样暂停业务 Tool 与 Ref 资格，Core 将 `{ receiverViews, refViews }` 合一为单一的 `activeViews`。

### 现行事实与已复现漂移
- TypeScript 侧呈现位于 [view-message.ts](../../runtime/src/adapters/view-message.ts#L4-L33)，对 `\r` 明确转义为 `&#13;`，并按统一格式拼接 `<view ...>` 属性、`Available references` 与折叠文案（`Collapsed · Agent note\n\n...`），页面消息携带 `view.region`。
- `runtime/src/stdio.ts` 仅暴露了 `projectNativeTools`，未暴露 View 与 `<desktop>` 呈现，导致 [python-host.py](../../runtime/examples/python-host.py#L55-L128) 手写全套逻辑并已出现三处真实漂移：
  1. **XML 回车转义漂移（已实测复现）**：正文 `A\rB` 经 TS 包装再解析保留 `\r`，Python 端变成 `\n`；
  2. **折叠文案与消息字段漂移**：Python 端写成 `Window collapsed.\n\nNote: ...` 且页面输出缺少 `region`；
  3. **重复手写脆弱规则**：Python 端手写正则版 `formatRefPath` 以及 `system-inspect_ref` 与窗口控制工具 Schema。
- 此外，TS 侧预算提示当前把正文 UTF-8 字节数直接写成 `input tokens`（[semantic-aotui-driven-source.ts](../../agent-driver-adapter/src/semantic-aotui-driven-source.ts#L526)、[window-budget.ts](../../agent-driver-adapter/src/window-budget.ts#L29)），需一并修正。

### 选定方案与边界细节

1. **统一无状态呈现出口（单点选择，零状态矛盾）**：
   - Host 对每个页面**只选一次展示方式**（`body` / `hint` / `collapsed` + 可选折叠备注），并传入按当前会话筛好的应用目录与支持的控制能力；
   - `@aotui/runtime/adapters` 提供无状态纯函数，`aotui-stdio` 直接复用同一实现，从同一份选择同步生成：
     - 标准 `<view>` 消息列表（含 `region`、唯一权威 XML 转义与 `Available references`）；
     - 标准 `<desktop>` 应用目录消息（统一表达 `installation_id`、`app_id`、窗口状态与可用动作）；
     - 投影后的业务 Tools 列表与按能力/状态生成的可选 `system-*` 控制工具声明（标准 Apps Source 启用时，即使目录为空，`system-open_app` / `system-close_app` 仍按固定契约提供）；
     - 默认 AOTUI 指令文本（提到 `run_code` 等可选入口时明确仅在本轮出现时可用）；
     - **可直接交给 `adoptTurn()` 的 `activeViews` 名单**（消除 Host 既选展示又另拼名单导致不一致的可能）。
   - 格式化纯函数**不改变当前轮次**，Host 可反复试算多种预算布局；正式折叠时仍由 Host 调 Runtime 撤销当前资格，发模型前显式采用最终选定名单。
   - 公共预算提示文案只表达“本轮省略正文”，不再把 UTF-8 字节数误标为 `input tokens`；需展示 token 估算时由 Host 用实测或明确标注的估算值填充。
2. **修正核心窗口资格规则（合一为 `activeViews`）**：
   - Core 将原来的 `{ receiverViews, refViews }` 两张名单合一为单一的 **`activeViews`**（绑定到具体页面实例 `{ viewId, viewInstanceId }`）。
   - **唯一资格铁律**：只有**本轮实际展示正文（`body`）、且该轮已成功采用**的页面，才有资格接收业务 Tool 调用或作为 Ref 来源（具体工具仍须已启用，Ref 仍按作用域与授权检查）。
   - 两种非正文展示方式在执行资格上一致暂停，区别仅在于恢复方式：
     - **`hint`（预算提示）**：页面逻辑上仍处于展开态，支持 `system-collapse_view` /（若 `canClose`）`system-close_view`；**预算允许、正文重新被采用后自动恢复资格**，无需手动 `expand`。
     - **`collapsed`（主动折叠）**：带可选备注，支持（若 `canClose`）`system-close_view`，**需 Agent 先显式 `expand` 并在下一轮采用后恢复资格**。
   - **归属边界**：这里管的是“调用落在哪个页面实例”；若 `Workspace` 等其他可见页面提供批量操作，涉及哪些文件以及文件是否被外部修改仍由 App 自己判断。对支持独立关闭的页面，鼓励作者声明 `onClose` 以便在 `hint`/`collapsed` 下直接关闭。
   - *(落地时需同步更新 `AGENTS.md` 第 28 行关于预算提示页工具资格的既有表述。)*
3. **Host 保留的自主权**：哪些 App 对当前会话可见（被过滤 App 的名称、备注与诊断不得出现在目录中）、折叠状态与备注保存、预算降级策略、附加日志/诊断、最终消息分区顺序、Provider 适配与发送时机。
4. **统一多实例工具入参路由与 `view_id` 拆包**：`@aotui/runtime/adapters` 与 `aotui-stdio` 按**本轮实际提供给模型的工具表**提供统一调用路由/拆包入口，依据 `multiplicity` 自动校验并剥离多实例顶层 `view_id`（单实例拒绝传入 `view_id`），严格沿用原 `appId`、`instanceId`、`observationId`、`toolId` 与 `invocationId`，避免关闭重开同名页后迟到调用误落新页；折叠状态、备注与展开策略仍由 Host 自主管理。
5. **`aotui-stdio` 并发多路复用与 `desktop.output` 异步事件推送（不新增单 App 排队）**：去掉 [stdio.ts](../../runtime/src/stdio.ts#L216) 外层串行 `await respond(line)` 队头阻塞，按请求 `id` 并发分发并串行写出响应，订阅 `desktop.output` 以无 `id` 服务端事件帧推送 `attention_requested` 等信号；同步更新 [python-host.py](../../runtime/examples/python-host.py#L35) 使其按 `id` 匹配回复并与异步事件分流，**保持单 App 串行执行语义，不新增单 App 调用队列**。

### 验收标准（待实现后验证）

| 验收场景 | 应看到的结果 |
| --- | --- |
| 同一份目录、观察、展示选择与工具模式，对比 TS 直调与 Python 经 `stdio` 输出 | 两端生成的 `<view>` XML、`region`、`<desktop>` 目录、工具名与 Schema 完全一致；覆盖 `\r`、`\r\n`、特殊属性字符、带点号 Ref 键和折叠备注，XML 解码还原原文。 |
| 双文件验证：`A.txt` 展示 `hint`（预算提示），`B.txt` 展示正文 | 共享 `edit` 工具仍可编辑 B；指定 A 为接收页或引用 A 页发布的 Ref 均被拒绝；腾出预算后下一轮采用 A 正文，A 自动恢复编辑与 Ref 资格（无需 `expand`）；`collapsed` 页仍需先 `expand`。 |
| 空目录、仅管理模式、被过滤 App | 空目录时 `system-open_app` / `system-close_app` 按固定契约可用；被过滤 App 的名称、备注与诊断不出现在 `<desktop>` 与任何输出中。 |
| 预算试算隔离 | 对同一候选连续试算多个布局，旧轮次仍可按原资格工作；最终采用选定布局对应的 `activeViews`，工具路由仍绑定原观察与原页面实例。 |
| 多实例工具统一拆包路由 | TS 与 Python 共用统一拆包/路由入口（不再各自手写 `pop("view_id")`），关闭重开同名页后迟到调用不误落新页。 |
| 跨语言异步提醒（1B 留后；Batch 3 实测通过，待复核） | Python 空闲时可及时收到已订阅 App 的 `requestAttention()`，自主决定是否观察，且不会把提醒误认作普通 RPC 回复。 |
| 慢调用不阻塞跨 App 撤权（1B 留后；Batch 3 实测通过，待复核） | App A 的慢调用尚未返回时，Host 仍可经同一 `stdio` 连接及时撤销 App B 的页面资格，所有回复按请求 `id` 准确归位。 |

---

<a id="mod-02"></a>
## MOD-02 · 缩短纯转发调用链、将 Console 包装移出 Core、收口校验边界

- **三维度状态**：问题证实度 `代码已证实` ｜ 理想态明确度 `已明确` ｜ 实现方案状态 `已实施待复核`

**已拍板结论（2026-11-25）**：采纳全部三项减法，并采用**保留 `SemanticSnapshotReceiver` 为内部可独立测试部件**的版本。不削弱任何随时间变化的资格复查。

### 现行事实与核心问题
1. `@aotui/core` 的 `ActiveTurn` 内嵌了服务于 `run_code` 的 `readConsoleInputs`、`ConsoleInputs` 与 `CONSOLE_INPUT_CAPACITY`（[console-inputs.ts](../../core/src/invocation/console-inputs.ts#L54-L125)、[request-sources.ts](../../core/src/invocation/request-sources.ts#L169-L182)）。
2. 主线程单 App 托管叠套了 `ManagedApp`、`AppWorkerHost`、`WorkerInteraction` 与 `SemanticSnapshotReceiver` 四层；其中 [WorkerInteraction](../../runtime/src/engine/app/worker-interaction.ts#L30-L63) 的外壳迫使 `@aotui/core/host` 专门暴露只被它一处调用的 `forwardRequestSource` 转发钩子，而 `ManagedApp` 与 `AppWorkerHost` 又各自持有半套关闭状态。
3. 多个文件重复手写了 `Object.getOwnPropertyDescriptors` / `dataProperties` 校验辅助，且部分已由框架捕获冻结的内部数据在层间重复盘查。

### 选定方案与必须保留的行为细则

1. **Core 只负责读公开 Ref，Console 负责把值摆成 JS 对象**：
   - Core 的 `ActiveTurn` 移除 `readConsoleInputs`、`ConsoleInputs` 与 `CONSOLE_INPUT_CAPACITY`，改为提供适配器无关的通用原语 **`ActiveTurn.readPublicRefs(addresses?)`**（按 App 合并持有与并发刷新，返回扁平的地址与值列表及通用容量错误码）。
   - 核心语义：值取自 Agent 本轮看到的原快照，读取时确认该页面仍在 `activeViews` 且仍保持 `public` 权限（例如本轮看到 `30`、后台改 `35` 但仍公开则读 `30`；批次中任意一项转为私有或不可见则整批拒绝；各 App 分别刷新，提供整批成功或失败保证，不承诺跨 App 业务状态同瞬冻结）。
   - 嵌套 `refs` 树组装、父子路径去重与 `CONSOLE_INPUT_CAPACITY` 移回 `agent-driver-adapter/src/console/`。保留三个细节：(a) 省略地址读本轮全部可见 `public` Ref，传 `[]` 一个也不读；(b) 数量与大小上限保留；(c) **所有请求路径先逐一校验，再去重**（确保同时请求有效父路径和非法/不存在子路径时仍能报错），且 Console 在用户代码真正执行前继续做一次读取资格复查（[console-tool.ts](../../agent-driver-adapter/src/console/console-tool.ts#L64)）。
2. **删除 `WorkerInteraction` 与 `forwardRequestSource`，保留 `SemanticSnapshotReceiver`**：
   - 纠正关键实现约束：Core 的 `observe()` 直接从主线程已有快照准备候选，不调用 `refreshProjection`（[app-interaction.ts](../../core/src/invocation/app-interaction.ts#L610)）。因此**观察前等待 Worker 刷新并确认 App 仍运行、并发观察拦截（`OBSERVATION_BUSY`）与默认超时**交给单 App 控制器，由其直接持有并暴露同一个 `InstanceInteraction` 给采用、调用与撤权使用，从而彻底删除 `WorkerInteraction` 与 `@aotui/core/host` 中的 `forwardRequestSource`。
   - 配合 `SYS-03` 移出持久化后，由单 App 控制器统一拥有 App 的关闭流程，Worker 通道负责报告真实退出；**保留 `SemanticSnapshotReceiver` 作为内部可独立测试部件**，守住“旧 App 实例迟到的快照不能把新实例的健康页面打成故障页”的隔离职责（[receiver.ts](../../runtime/src/adapters/snapshot/receiver.ts#L83)）。最终按“每项职责有唯一负责人”验收，不强行规定类数量。
3. **收口边界捕获，保留全部实时资格复查**：
   - 在**公开 API 入口、IPC 收包边界、以及 Host/App 回调把结果交回框架时**（如 [observation-registry.ts](../../core/src/invocation/observation-registry.ts#L372)）集中捕获并固定输入；框架内部传递的已捕获不可变对象不再层层重复盘查；仅在字段读取规则完全相同处共用 helper，保留特化规则（如 SDK 声明对特定 `Symbol` 的放行、快照接收器对实例归属的先行判断）。
   - **必须保留的实时复查**：授权前后复查（[app-interaction.ts](../../core/src/invocation/app-interaction.ts#L394)）与进入 handler 前的实时挂载/激活/本地 Ref 复查（[tool-invocation.ts](../../runtime/src/worker-runtime/tool-invocation.ts#L22)）。明确区分两条作用域规则：业务传参校验“当前作用域是否仍允许该接收页”（`public` 收为 `protected` 后跨 App 失效、同 App 内原获准页仍可用，见 [ref-path.ts](../../core/src/tool/ref-path.ts#L62)）；直接读取公开值（`inspectRef(value)` / `readPublicRefs`）必须仍为 `public`。

### 验收标准（待实现后验证）

| 验收维度 | 验收标准 |
| --- | --- |
| 接口清洁度与回归 | Core / Runtime / Adapter 交互、关闭与 Console 回归全部通过；Core 公开 API、类型与错误码零 Console 专属符号；`forwardRequestSource` 移除。 |
| 页面与重开资格 | 双文件 `A.txt` 为 `hint`、`B.txt` 为 `body` 时，共享 `edit` 可改 B，编辑 A、读 A 的 Ref 或在授权等待期间关闭重开目标页均被拒绝。 |
| 刷新与关闭诚实性 | 预览能等到刷新且不占正式观察槽；重复 `beginClose()` 返回同一进行中句柄；已启动 Worker 真正退出且在途工作与快照持有均结清后，才报告 `resourcesReleased: true`。 |
| 独立发布包消费 | 用实际打包安装的制品跑通 `readPublicRefs` 与 Console，同步迁移旧公开 Host 示例（如 [batch-eight-public-host.mjs](../../tests/fixtures/batch-eight-public-host.mjs#L110)），核对发布的 JS 与 `.d.ts` 类型声明。 |

*(注：本轮重构前已针对 Core 轮次、Runtime 刷新与关闭、SDK 声明与 Adapter 集成定向运行 118 项现行测试全部通过，作为行为基线；新接口与 `activeViews` 验收待实施阶段完成。)*

---

<a id="mod-03"></a>
## MOD-03 · 稳定外部参数 Schema 合同并逐步松绑 `typebox@1.4.3` 强绑定

- **三维度状态**：问题证实度 `代码已证实` ｜ 理想态明确度 `已明确` ｜ 实现方案状态 `已实施待复核`

**已拍板结论（2026-11-25）**：选方案 A，且 `refParam` 选做法 1（直接在现有纯 JSON Schema `properties` 中与普通字段组合，暂缓 `objectSchema()` 及逐字段第三方库识别）。固化跨语言可读的 JSON Schema 2020-12 受支持子集与随包测试向量，`@aotui/sdk` 实现零第三方必装 `peerDependencies`，平等支持纯 JSON Schema、`StandardJSONSchemaV1`（如 Zod v4.2+ / Valibot 转换器）与可选 TypeBox（逐步放宽单一补丁锁死）。

### 现行事实与实测基线
- Core 已只消费纯 JSON Schema 2020-12 受支持子集（[tool-parameters.ts](../../core/src/tool/tool-parameters.ts)），并维护了 15 组工具向量与 14 组值向量（[schema-contract-vectors.json](../../core/src/tool/schema-contract-vectors.json)），但该向量文件目前尚未列入 [core/package.json](../../core/package.json) 打包清单。
- 锁死集中在 SDK：[sdk/package.json](../../sdk/package.json#L29-L32) 将 `typebox@1.4.3` 设为必装精确 peer，[typebox-schema.ts](../../sdk/src/tools/typebox-schema.ts#L234) 拒绝非 TypeBox `~unsafe` 见证的 `refParam`，[view-type-tool.ts](../../sdk/src/tools/view-type-tool.ts#L23) 类型绑定写死 TypeBox。
- **Zod 4.6.7 实测基线**（调用标准 `jsonSchema.input()` 导出并交 Core 校验）：
  - `z.string().regex(/^abc/)` → 导出含 `pattern`，Core 准确定位 `$.properties.v.pattern` 不受支持，SDK 可在声明期报 `TOOL_SCHEMA_UNSUPPORTED`；
  - `z.string().refine(...)` → 导出退化为普通 `{ type: 'string' }`，第三方导出器未写进 JSON 的业务判断由 App 在执行前自行检查；
  - `z.string().transform(...)` → 输入声明仍为 `string`，Core 交付原始输入字符串而不执行转换；
  - Zod 导出结果附带不可枚举的 `~standard` 属性，直接送进 Core 会被拒绝，必须在 SDK 标准导出边界取出纯净 JSON。
- 本轮 179 项 Core 测试与 80 项 SDK 测试通过；真实 Worker 下手动导出的 Zod 声明与纯 JSON、TypeBox 产出一致工具参数（真实 Ref 均成功，手写同形对象均报 `REF_TYPE_MISMATCH`）；TypeBox 1.4.2 与 1.4.3 均通过类型检查与 Worker 验证。

### 选定方案与精确承诺边界

1. **只在 SDK 作者入口做转换，三路归一到同一份纯 JSON 声明**：
   - **纯 JSON Schema 对象**：零第三方依赖原生支持；
   - **`StandardJSONSchemaV1`**：按 `draft-2020-12` 调用标准 `jsonSchema.input()` 导出，核对并剥离顶层匹配的 `$schema`（其他方言明确报错）与不可枚举 `~standard`，同时保留名为 `pattern`、`$schema` 的普通业务字段；
   - **可选 TypeBox**：取消必装精确锁死，逐步放宽兼容范围（Core 可继续在自身内部依赖树使用 TypeBox 编译器，不泄露给 App 作者的公共 `.d.ts`）。
   - **精确承诺**：AOTUI 执行的是导出后的输入 JSON 规则；SDK 遇到导出结果里的未知关键字时带路径报错；第三方未写入 JSON 的判断（`refine`/`transform` 等）归 App 自检；handler 参数类型跟随标准 `InferInput`，默认值保持现行语义（缺席的可选字段保持缺席）；工具根、`ref`、`arrayRef`、`refParam` 的类型均从转换后的声明读取（[refs.ts](../../sdk/src/app-factory/refs.ts#L30)）。
2. **`refParam` 采用极简组合（做法 1）**：
   - `refParam(refType, valueSchema)` 的 `valueSchema` 接受上述任意三种 Schema；工具同时含普通字段与 `refParam` 时，直接使用现有纯 JSON Schema `properties` 组合（如 `properties: { item: refParam('Note', note), title: { type: 'string' } }`），暂缓 `objectSchema()` 与逐字段识别第三方库对象。
3. **跨语言公共合同与随包测试向量**：
   - 将 [schema-contract-vectors.json](../../core/src/tool/schema-contract-vectors.json)（15 组工具向量 + 14 组值向量）纳入发布包并面向跨语言作者公开；
   - 三路作者路径在交付时均显式写明工具根的 `additionalProperties` 策略（SDK 默认为 `false`，显式 `true` 保留，嵌套对象遵守各自声明）。

### 验收标准（待实现后验证）

| 验收维度 | 验收标准 |
| --- | --- |
| 零必装 peer 独立消费 | 纯 JSON 独立项目仅声明 `@aotui/sdk`，在 `ES2022`、`skipLibCheck: false` 下编译通过（验证 `.d.ts` 不意外要求安装任何第三方 Schema 库）并跑通真实 Worker。 |
| Zod / Standard JSON Schema 真实消费 | 独立项目直传 Zod v4.2+ 声明普通参数与 `ref` / `refParam` 值 Schema，验证 `InferInput` 只读类型、必填/可选/元组、`refParam` 拒绝手写同形对象（`REF_TYPE_MISMATCH`），以及顶层 `$schema`/`~standard` 剥离、普通 `pattern`/`$schema` 字段保留、导出 `pattern` 关键字声明期带路径报错。 |
| TypeBox 兼容与跨语言向量 | 独立 TypeBox 项目回归全部通过且不再锁死单补丁号；三路路径导出结果全部符合随包发布的 `schema-contract-vectors.json` 及根 `additionalProperties` 显式写明规则。 |
