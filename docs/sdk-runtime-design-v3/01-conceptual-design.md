# 01 · 概念设计（Conceptual Design）

本分册跟踪 SDK 与 Runtime 的核心交互概念边界。

---

<a id="con-01"></a>
## CON-01 · SDK 作者路径主次定位与 Preact 私有钩子风险治理

- **三维度状态**：问题证实度 `代码已证实` ｜ 理想态明确度 `已明确` ｜ 实现方案状态 `已实施待复核`

**已拍板结论（2026-11-25）**：选方案 C。`@aotui/sdk` 根入口提供纯 TypeScript，作为官方唯一的 App 开发方式；彻底移除 Preact 适配层、私有钩子劫持与 `linkedom` 依赖；页面正文使用 Markdown 字符串和普通函数，JSX 模板暂缓。

### 现行事实与选型依据
- 现行 `@aotui/sdk` 将 Preact 放在根入口 `.`，纯 TS 放在 `./app`，且将 `linkedom@0.18.12` 列为必装依赖（[sdk/package.json](../../sdk/package.json#L8-L41)）。Preact 路径需 444 行 [render-commit.ts](../../sdk/src/app-factory/render-commit.ts#L9-L285) 读写 Preact `10.29.1` 私有压缩字段（`__b`/`__r`/`__c`/`__e`/`__P`/`__h`/`__v`）并追踪异步渲染队列。
- 纯 TS 路径已能在一次同步提交里原子交付页面正文、Ref 与 Tool 绑定（[createApp.ts](../../sdk/src/app-factory/createApp.ts#L65)）。在重编后的真实 Worker 双文件验收中，纯 TS 在仅启 `ES2022` 类型、无 Preact、无 `linkedom` 的消费环境下已跑通完整开页、编辑、Ref 传递与容量拒绝路径（[verify-two-file-author.mjs](../../tests/fixtures/verify-two-file-author.mjs#L42)，另有 35 项提交与刷新测试通过）。
- 现有 4 个 Preact Demo App 的 `.tsx` 合计仅 1,328 行（其中 `aotui-ide` 本就将全部状态留在 `IDESession` 中、`terminal-app` 为绕开异步 state 维护了 `terminalsRef` + `useState` 双份同步），且当前尚无外部开发者，是彻底轻装的最后低成本窗口。

### 选定方案与迁移必须守住的细节

1. **唯一官方作者入口（`@aotui/sdk` 根入口 = 纯 TS）**：
   - 将原 `@aotui/sdk/app` 能力提升为 `@aotui/sdk` 根入口（不再维护 Preact 平行入口）；移除 `preact` peer 依赖、`linkedom` 依赖、`render-commit.ts`、假 DOM 转换器，以及最后一个 Preact 消费者迁走后即可退役的 Core 专用 `readPreparedProjection()` 和 Preact `restore` 恢复核对分支。`readPreparedViewId()` 继续保留，用于需要在收据中附上新页面 ID 的场景。
   - 页面正文直接使用 Markdown 字符串与普通函数，**JSX 模板暂缓**；复用重点放在易写错的小型纯函数格式化工具（如已有的 [formatRef](../../sdk/src/app-factory/refs.ts#L67) 与 [代码块围栏自适应](../../demo-apps/sqlite-work-items/src/index.ts#L69)），等多个 App 反复遇到同类痛点再按需提取；最外层 `<view>` XML 封装继续由呈现适配器统一负责。
2. **补齐纯 TS 动态页名能力**：
   - 核对发现 `planning-app` 打开计划时会把列表页名从 `Plan List` 更新为 `Plan List (Active Plan Open)`（[PlanningApp.tsx](../../demo-apps/planning-app/src/tui/PlanningApp.tsx#L309)），而当前 [createView](../../sdk/src/app-factory/createApp.ts#L44) 将 `name` 固定在创建期；若重新 `createView` 虽可改名却会更换 `viewInstanceId`。
   - 迁移时补齐纯 TS 同页改名能力（如允许 `render()` 返回动态 `name`），明确守住：**同页改名保留原 `viewInstanceId`，真正关闭重开才换实例**。
3. **迁移顺序与异步验证**：
   - 优先以 `terminal-app` 验证迁移（先确认开页成功再启子进程、异步追加输出、命令失败调 `requestAttention()`、关闭清理进程，见 [TerminalApp.tsx](../../demo-apps/terminal-app/src/tui/TerminalApp.tsx#L150-L195)），再完成 `aotui-ide`、`planning-app`、`lite-browser-app` 全部迁移。
4. **联动 `MEC-02`**：移除 Preact 双回调 `revert` 后，由 `MEC-02` 明确纯 TS 下的开页准入与无回滚写法。

### 验收标准（四 Demo 迁移 + 盲测完成后才记为 `已验证`）

| 验收维度 | 验收标准 |
| --- | --- |
| 依赖与发布包纯度 | `@aotui/sdk` 零 `preact`、零 `linkedom`、零 DOM 类型，仅启 `ES2022` 的独立消费项目干净编译运行。 |
| 迁移行为不回归 | 4 个 Demo App 迁至纯 TS 后，Agent 使用侧仍能看到正确页面、选择正确对象、收到诚实收据；同页动态改 `name` 保留原 `viewInstanceId`；`terminal-app` 异步输出与 `requestAttention()` 正常。 |
| Coding Agent 盲测 | 干净 Coding Agent 只读新发布包、公开 README 与 `.d.ts` 类型，从 `@aotui/sdk` 根入口独立写出通过真实 Worker 验收的双文件 App（共享 `edit`、点名 B 只改 B、容量拒开保留 A）。 |

---

<a id="con-02"></a>
## CON-02 · Ref（观察期常量）语义固化与表达简化

- **三维度状态**：问题证实度 `代码已证实` ｜ 理想态明确度 `已明确` ｜ 实现方案状态 `本地合同已实施待复核，真实模型指标暂缓`

**已拍板结论（2026-11-25）**：选方案 A。守住 Ref 作为“本次观察只读命名常量”的单一概念，保留 `$ref.` 统一地址语法、从 0 开始的数组下标 `people[2]` 与普通兼容参数的跨页/跨 App 引用；将顶层 `refId` 收紧为标准标识符 `[A-Za-z_][A-Za-z0-9_]*`（SDK 与 Core 统一校验）；**并将带内转义修正为无损规则“引用照写，原文多加一个 `$`”**（明确协议改动）。

### 现行事实与真实 Worker 实测发现
- Ref 表达的是本次观察中的只读命名常量，支持页面标注下标（`people[2]`）、固定角色对象键（`by_role.support.email`）以及 `run_code` 内计算下标再填入具体数字地址（地址中不支持变量下标 `[i]`，越界 `[20]` 被拒，见 [ref-parameters.ts](../../core/src/tool/ref-parameters.ts#L35)）。
- **两处实测证实的现行缺口**：
  1. **`refId` 命名过宽**：现行 [refs.ts](../../sdk/src/app-factory/refs.ts#L50) 允许顶层 `refId` 含 `.` / `[` `]`（如 `"items[0]"`），而即使照搬 `isInstanceName`（[types.ts](../../core/src/snapshot/types.ts#L10)）也会放行 `2fa`——仍不能直接写成 `.2fa`；
  2. **连续 `$` 转义不可逆（真实 Worker 写文件复现）**：在现行 [snapshot-value-arguments.ts](../../core/src/tool/snapshot-value-arguments.ts#L45) 中，传入 `$$ref.x` 写入 `$ref.x`，但传入 `$$$ref.x` 因不匹配 `startsWith('$$ref.')` 而原样保留三个 `$`——**没有任何直接字符串写法能写出字面量 `$$ref.x`**；且当无可见 Ref 时，Native 工具声明中的 `const: "$ref.x"`（[tool-projection.ts](../../runtime/src/adapters/tool-projection.ts#L68)）会阻挡模型传入实际需经解码的 `$$ref.x`。

### 选定方案与精确规则

1. **顶层 `refId` 统一收紧为标准标识符 `[A-Za-z_][A-Za-z0-9_]*`**：
   - 一句话规则：App 给常量起一个可以直接跟在点号后面的名字（页面显示标签照样可用中文如“小梅”，JSON 载荷内部的特殊字段名继续用 `["display.name"]`）。
   - SDK 发布期（[refs.ts](../../sdk/src/app-factory/refs.ts#L50)）与 Core 快照接收边界（[validate-snapshot.ts](../../core/src/snapshot/validate-snapshot.ts#L157)）使用同一条规则，在起名处即报错。
   - 保留数组从 0 开始的下标 `people[2]`，不引入第二套地址语法（如 JSON Pointer）。
2. **无损转义规则（明确协议改动）**：
   - 规则定为：**“引用照写，原文多加一个 `$`”**。
   - 仅在完整的顶层普通业务参数或其直接数组元素以连续 `$` 紧跟 `ref.` 开头时生效：
     - 单个 `$ref.` → 按 Ref 地址解析；
     - 两个及以上连续 `$` 紧跟 `ref.`（`/^\${2,}ref\./`）→ **去掉恰好一个 `$`**，其余原文交给 App（`$$ref.x` → `$ref.x`，`$$$ref.x` → `$$ref.x`，任意数量 `$` 加 `ref.` 均可无损还原）；
     - 正文中间出现的 `$ref.`、`$HOME`、`{"$ref": "#/defs/User"}` 及嵌套对象字段均原样透传。
   - 同步核对受限字符串参数投影（`const: "$ref.x"`、`enum`、`maxLength`）：例如原文 `$ref.x` 长 6 个字符、传输写法 `$$ref.x` 长 7 个字符，无可见 Ref 时 `maxLength: 6` 会挡住这段合法原文。投影须保证合法原文有可提交的传输写法（有限枚举可逐值映射传输写法，普通 `["open", "done"]` 保持原枚举不变），解码后的业务值仍按原约束校验；同时在评测中将 OpenAI / DeepSeek Strict 预检拒绝字符串 `const` 归类为 Host 兼容性问题，不计入模型误调率（[tool-projection.ts](../../runtime/src/adapters/tool-projection.ts#L69)、[provider-tool-schema.ts](../../agent-driver-v2/src/core/provider-tool-schema.ts#L87)）。
   - **同 App `protected` 字符串 Ref 导致 `enum` / `const` 退化问题（纳入 `CON-02` / `MEC-01` 验证）**：现行投影中，无可用 Ref 或仅有目标页无权使用的 `private` Ref 时，`mode: "fast" | "accurate"` 仍保留完整枚举约束；但一旦目标页获准使用同 App 含字符串字段的 `protected` Ref，现行 `addressSlot` 会把 `mode` 改写成裸 `{ type: 'string' }`，令模型失去本来能一次选对的两个选项。目标是在各 Provider 模式下评估能否同时保留合法枚举选项与受限引用地址提示，且不简单放行非法字面值（如 `"turbo"`）。

### 验收标准（待实施与真实模型评测验收）

| 验收维度 | 验收标准 |
| --- | --- |
| `refId` 双端校验 | 含 `.` / `[` `]` 或数字开头（如 `2fa`、`items[0]`）的 `refId` 在 SDK 与 Core 接收边界均明确拒绝；合法标识符 `people` 与载荷内部键 `["display.name"]`、中文标签正常工作。 |
| 任意 `$` 数量无损写入 | 真实 Worker 编辑工具分别写入 `$ref.x`（经 `$$ref.x`）、`$$ref.x`（经 `$$$ref.x`）、`$$$ref.x`（经 `$$$$ref.x`）与正文中间 `$ref.x`，磁盘读回全部字节级一致；同时覆盖 `const: "$ref.x"` 等受限字符串参数在无可见 Ref 时仍能合法传入并解码。 |
| 真实模型评测指标 | 后续真实模型评测分别统计三项结果：(1) 选错元素；(2) 漏写转义报错；(3) **工具返回成功但比对磁盘/最终内容错误**（防止漏转义误命中同名 Ref 时掩盖内容偏差）。 |

*(注：本轮 37 项现行 Ref 相关测试通过，另用真实 Worker 复现了 `$$$ref.` 写盘与 `run_code` 查下标用例；上述新标识符规则、无损剥离一个 `$` 改动及受限字符串投影待实施验收。)*

---

<a id="con-03"></a>
## CON-03 · `ViewRegion`（`static` / `dynamic`）［已确认保留］

- **三维度状态**：问题证实度 `已确认不改` ｜ 理想态明确度 `已明确` ｜ 实现方案状态 `已确认不改`

### 结论与依据
- **用户明确决定**：不修改 `ViewRegion`。
- **源码核对**：[view-type-tool.ts](../../sdk/src/tools/view-type-tool.ts#L233-L246) 允许 ViewType 声明默认 `region`，也允许在创建/挂载具体页面时指定或覆盖，并非强行写死。
- **核心理由**：`static` / `dynamic` 表达的是作者对“这页希望放在本轮消息哪个区域”的显式选择（静态区页面照样可更新）；改名为 `volatility` 会把问题偷换为“估计变化频率”，反而不准确。具体服务商如何做缓存命中仍归 Host 衡量。

---

<a id="con-04"></a>
## CON-04 · 长耗时任务（Job）与通用业务事件原语［已确认暂缓］

- **三维度状态**：问题证实度 `已确认暂缓` ｜ 理想态明确度 `已明确` ｜ 实现方案状态 `暂缓`

### 结论与依据
- **用户明确决定**：暂不在内核自造 Job / 通用业务事件轮子；LLM 看到的是冻结的世界，应用层可直接复用语言/Web 现有异步能力（如 `AbortController`、子进程、任务系统）。
- **现行可用路径**：Tool 可立即返回“已开始”收据，后台持续推进并将进度/结果写入对应 View，关键里程碑调用零参数 `requestAttention()`（[sdk/README.md](../../sdk/README.md#L241-L243)、[runtime/README.md](../../runtime/README.md#L223)），由 Host 决定何时发起下一轮正式观察。给通知塞大段业务数据和优先级并不能改变“本轮模型输入已冻结”的物理事实。
