# SRT-01：单一 Tool 声明与 App 实例绑定——技术方案及交付计划

> 状态：**拟议方案，尚未实施、尚未通过准出**。本次任务只编写设计与计划。
>
> 关联工作：deepseek_review.md 的 **SRT-01**，详见 [SDK authoring](deepseek_review.md#sdk-authoring)。该文件继续作为唯一全局待办索引；本文只是 SRT-01 的实施规格，不创建另一份全局路线图。
>
> 编写日期：2026-11-03（Asia/Shanghai）。
>
> 基线：当前远端工作区；Git HEAD 为 **8938449925ada2f92e072e1c0492af8f2428d14f**，包含大量未提交修改，不能用 HEAD 文件代替当前源码。关键文件摘要见附录 A。
>
> 项目路径：/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI

## 1. 决策：优先收敛作者合同，复用现有 Runtime

**本方案选择 SRT-01 作为当前最高优先级的结构性改造：Tool 的类型归属、名称、说明和参数只声明一次；每个 App 实例集中绑定自己的 handler 与 enabled；ToolRef 和静态目录从声明派生。**

它直接服务两个目标：让 Agent 更容易编写语义正确的 AOTUI App；让共同的应用交互合同能够跨 Preact、普通 TypeScript 和未来调用前端复用。

当前 Runtime 的 IAppTypeToolPort 已经区分静态 definition 和实例 invoker options。因此本项主要重组 SDK 作者层，复用快照、参数验证、activation、Observation 来源检查与生命周期保证，不重写内核。[C1][C3]

### 1.1 为什么先选这一项

SRT 编号不是执行顺序。本次选择依据是收益、依赖关系、可独立交付性与影响可控性。

| 候选 | 价值与依赖 | 本次判断 |
|---|---|---|
| SRT-01：声明、实例绑定、目录 | 直接减少 Agent 作者的接线负担；给 Ref 参数统一、显式 ViewType、CLI 提供稳定定义入口；当前 Runtime port 可复用 | 选为本批主项 |
| SRT-02：Ref / ArrayRef 统一 | 核心能力缺口，但需另行定稿寻址、类型、raw/resolved 输入与 owner 生命周期 | 下一项可复用本方案的声明与绑定边界，不并入本批 |
| SRT-04/05：串行刷新、观察采用与释放 | 属于必要的运行语义收敛；涉及 Producer、观察 owner、历史保留与 Scope 寿命 | 保持高优先级独立专项；本项不阻塞其并行设计，也不谎称已解决 |
| SRT-07/08：文本保真、App 失败隔离 | 当前缺陷应按实际严重性修复，部分旧问题已修 | 可独立处理，不把它们包装成 SRT-01 的附属重构 |
| SRT-10/11：通用错误、性能治理 | 原记录列低优先级 | 不加入本批；只提供本项新增 API 必要的诊断 |

本次“优先”指选择哪一个结构性改造先形成可交付方案，不表示暂停明确的正确性缺陷修复。

### 1.2 本批成功的可观察结果

1. IDE 不再为传播 Hook 返回的 ToolUI 自建注册组件、effect 回传和 UIContext。
2. 一份静态定义可被两个 App 实例共享，handler 和 enabled 相互隔离。
3. 十个 FileDetail 实例仍共用一个 edit_file 声明与类型级执行绑定。
4. 目录由同一声明生成，打开、编辑、关闭文件不会改变静态目录。
5. Preact 与普通 TS 使用同一个绑定 controller；普通 TS 的包入口不加载 Preact。
6. 当前 ordinary-v2、Snapshot V3、Observation、Scope 和 Ref 路径的合同不因本项改变。

这些是计划中的验收目标，尚无本批实现或测试通过记录。

## 2. 当前事实、问题与职责边界

### 2.1 源码已确认的现状

| 现状 | 具体依据 | 影响 |
|---|---|---|
| defineViewTypeTool 同时保存静态 metadata/schema 和 execute | view-type-tool.ts 的声明与返回类型 | 定义容易捕获 App 实例，schema 与 handler 生命周期混在一起 |
| useViewTypeTool 用静态 fingerprint 保持注册，用 layout effect 更新 committedExecute | useViewTypeTool.ts | 内部已经区分两类变化，公共 API 尚未清楚表达 |
| 普通 Tool 按 App + ViewType + name 唯一注册 | view-owned-tools.ts 的 registerTypeTool | 在每个 FileDetail 内注册同名 Tool 会重复；不应改成每实例复制 |
| Runtime port 已分离 definition 与 invoker factory | app-type-tools.interface.ts | SDK 可重组，不必新增 Worker 调用协议 |
| IDE 用 ToolRegistration / IDEToolUIProvider / receiveUI / ToolRef 连接注册与呈现 | ScopedIDEApp.tsx | 存在与 IDE 业务无关的 SDK 接线成本 |
| 当前 SDK 只有总入口，普通 TS 用总入口会关联 Preact 模块 | sdk/package.json、sdk/src/index.ts | 需要一个轻量的纯工具子入口 |
| 当前泛型 S 主要通过 execute 保留；inputSchema 已被归一化为普通 readonly JSON | DefinedViewTypeTool<S> | 直接移除 execute 会让参数类型关联消失，必须补类型见证 |

依据：[C1][C2][C3][C4]。此处“已确认”表示静态源码事实，不表示已执行本方案测试。

### 2.2 必须保留的产品约束

| 约束 | 本项维护方式 | 框架不接管的内容 |
|---|---|---|
| App 为 Agent 提供 XML + Markdown View，投影为 User Message | 保留既有 View / Snapshot / Source 管线 | 不增加任意 Messages CRUD |
| 操作与主要业务数据分离 | handler 继续返回回执；例子和迁移保留数据进入 View 的做法 | 不推断任意 JSON 是否属于业务正文 |
| 同类型 View 共享 Tool | App 级集合绑定一次；实例增减仍由 Runtime activation 管理 | 不自动选择“当前文件” |
| 工具随状态逐渐暴露 | enabled 与 ViewType activation 共同影响现有注册/观察 | 不把隐藏当作业务授权 |
| 公开声明只有一份 | 注册、类型、参数校验、ToolRef、目录引用同一 definition | 不自动生成业务 handler |
| 小而稳定的内核 | 复用 Runtime port、参数 compiler、所有权和校验 | 不引入业务状态机、任务平台、事务引擎或新调度器 |

### 2.3 范围边界

**本批包含：**

- 普通 ViewType Tool 的静态定义与实例实现分离。
- 类型化 ToolSet、无 Preact 绑定 controller、一个 Preact 集合绑定组件。
- 只呈现的 ToolRef、由声明派生的静态目录。
- SDK 纯工具子入口。
- 四个真实 Tool App、相关 fixtures、公开类型、正式文档的迁移。
- 本项必要的定义、绑定、所有权与呈现诊断。

**本批不改变：**

- Ref / ArrayRef 的发布与解析协议；useViewSnapshotTool 的退出归 SRT-02。
- ordinary-v2 的 Schema 支持集合、默认值和 coercion 行为。
- ViewType / instruction / state 的新元数据 API；归 SRT-03。
- Observation 刷新、替换、旧 Ref 释放、Scope 轮换；归 SRT-04/05。
- Driver 依赖迁移、native alias 规则、CLI、collapse、资源预算。
- createTUIApp 的工厂生命周期、持久化和 App 业务 owner 创建方式。
- 普通 TS managed Worker App 的完整高层启动入口。

SRT-01 完成后仍有独立 Ref Tool 路径，这是一项明确的阶段边界，不能宣布“所有工具参数模型已统一”。后续 SRT-02 应接入本项的单一声明/绑定链，而非建立第三套作者 API。

## 3. 推荐架构：三个生命周期，共用一条运行路径

~~~mermaid
flowchart TB
    D["静态 ToolSet：metadata 与参数合同"] --> C["静态目录"]
    D --> P["AppTools：Preact 适配"]
    D --> T["普通 TS Producer"]
    P --> B["共同 binding controller"]
    T --> B
    B --> R["现有 IAppTypeToolPort 与 Runtime Core"]
    P --> V["View 与 ToolRef 呈现"]
~~~

| 对象 | 所有者 | 可变化内容 | 释放边界 |
|---|---|---|---|
| Tool definition / ToolSet | 应用代码模块或一次固定配置构造 | 构造后不可变；不持有 handler/业务 owner | 普通 JS 对象可达性 |
| binding controller | 一个 App 实例的一个明确 binding owner | 已提交 handler frame、enabled、自己的 release handles | dispose、AppTools 卸载、提交阶段失败 |
| View / Ref / activation / Observation | 既有 App/SDK/Runtime 对应 owner | 遵循当前已提交投影与调用合同 | 继续遵循既有 Runtime 规则 |
| 静态目录 | 由 ToolSet 派生 | 不读实例状态 | 与 ToolSet 或呈现对象一起释放 |

ToolSet 不是 AppDefinition，不登记文件、权限、业务服务、路由或生命周期回调。

## 4. SDK 目标 API 与具体使用方式

本节 API 为**本方案拟定的目标 API**，当前包尚不支持。命名可以在 M0 类型原型阶段微调，但不得改变本节语义或以“待定”跳过类型与生命周期验证。

### 4.1 保留 defineViewTypeTool，删除 execute 字段

~~~ts
declare const toolSchemaType: unique symbol;

export interface ViewTypeToolDeclaration<S extends Type.TObject> {
  readonly viewType: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly isMutating?: boolean;
}

export interface DefinedViewTypeTool<S extends Type.TObject> {
  readonly viewType: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly isMutating: boolean;

  // 类型见证；不进入 descriptor、catalog、IPC 或 Snapshot。
  readonly [toolSchemaType]: S;
}

export function defineViewTypeTool<const S extends Type.TObject>(
  declaration: ViewTypeToolDeclaration<S>,
): DefinedViewTypeTool<S>;
~~~

具体要求：

- 保留现有 TypeBox 导出、Runtime normalized schema 捕获、深冻结和不支持字段诊断。
- 静态定义不得含 execute、enabled、业务 owner 或资源对象；旧 execute 字段在 TypeScript 与运行时都明确拒绝，不能静默忽略。
- unique symbol 是类型声明中的 phantom witness，不要求在运行时对象上添加 symbol 数据。
- 继续使用 SDK 私有 WeakSet/WeakMap 校验构造来源；不接受 JSON clone 或类型断言冒充真实 SDK definition。
- 传 Runtime 时显式构造既有五字段 AppTypeToolDefinition，不能把品牌、集合或函数 spread 进去。
- Tool 声明中的默认 isMutating=true 保持不变；它不代表业务授权。

**类型是硬约束：** SchemaOf<T> / ArgsOf<T> 必须从 definition 的见证推导。移除 execute 后不得让 handler args 退化成 any 或 unknown。工具子入口、SDK 总入口和真实安装包必须保留这一关联。

### 4.2 defineToolSet 只做类型化聚合

~~~ts
export const ideTools = defineToolSet({
  openFile: defineViewTypeTool({
    viewType: 'Workspace',
    name: 'read_file',
    description: 'Open a file and show its current content in a FileDetail View.',
    inputSchema: Type.Object(
      { filePath: Type.String() },
      { additionalProperties: false },
    ),
  }),

  editFile: defineViewTypeTool({
    viewType: 'FileDetail',
    name: 'edit_file',
    description: 'Edit a currently opened file and read the updated View.',
    inputSchema: Type.Object(
      {
        filePath: Type.String(),
        oldString: Type.String(),
        newString: Type.String(),
        replaceAll: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
  }),
});
~~~

openFile / editFile 只是 TypeScript 属性键，用于关联实现；不成为第二个公开 Tool 名称、不进入协议、不参与 activation 或 native alias。实际 viewType/name 只在 definition 中声明一次。

ToolSet 构造必须：

1. 验证 plain data-property 映射，不执行 getter 或业务函数。
2. 捕获映射并冻结，原输入对象后来修改不能影响 ToolSet。
3. 校验每项是受支持的 definition。
4. 按结构化 (viewType, name) 检查重复；不同 ViewType 的同名 Tool 合法。
5. 不读取 App、不挂载 View、不注册 Tool。
6. 允许某个 Tool 的 ViewType 当前没有实例。
7. 为目录提供同源、稳定的 descriptor 列表。

该映射不包含方法或保留字符串字段，避免与应用属性键冲突；集合品牌与内部索引留在类型层/私有表中。

### 4.3 绑定类型必须完整、精确

~~~ts
type SchemaOf<T> =
  T extends DefinedViewTypeTool<infer S> ? S : never;

type ArgsOf<T> =
  DeepReadonly<Type.Static<SchemaOf<T>>>;

type ImplementationOf<T> = Readonly<{
  execute(args: ArgsOf<T>): ToolResult | Promise<ToolResult>;
  enabled?: boolean;
}>;

// M 是 ToolSet 捕获的原始静态映射，不含内部品牌字段。
type BindingsOf<M> = {
  readonly [K in keyof M]: ImplementationOf<M[K]>;
};

interface ToolBindingsController<M> {
  commit(bindings: BindingsOf<M>): void;
  dispose(): void;
}
~~~

以上是语义签名示意。M0 必须将完整约束、Preact props 推导和最低支持的 TypeScript 版本编译验证，不能靠 public any、宽化函数参数或 skipLibCheck 掩盖问题。

规则：

- 泛型只能由 definition 决定，错误 handler 不得反向把 definition 的类型放宽。
- 全部成员都必须有 handler，包括 disabled 的 Tool。
- 缺项、多项、错参数类型，在类型层与可实现的运行时形状检查中拒绝。
- enabled 省略等价于 true；提供时必须是 boolean。
- 不接受 enabled predicate，SDK 不替 App 计算业务可用性。
- 输入对象/条目先按 own descriptors 捕获，不在验证时执行 getter。
- 捕获的是 handler 函数引用，不冻结其闭包中的业务 owner；SDK 不拥有该业务对象。
- 实际 args 继续通过 Runtime 捕获的 ordinary 参数合同验证，并保持既有 readonly/JSON 语义。

### 4.4 唯一推荐的 Preact 注册入口：AppTools

~~~tsx
import { defineToolSet, defineViewTypeTool } from '@aotui/sdk/tools';
import { AppTools, ToolRef, ToolCatalog, View } from '@aotui/sdk';

function IDEApp() {
  const owner = useExistingIDEOwner(); // 代表应用既有 owner；不是新增 SDK API。

  return (
    <AppTools
      definition={ideTools}
      bindings={{
        openFile: {
          execute: args => owner.openFile(args.filePath),
        },
        editFile: {
          execute: args => owner.editFile(args),
          enabled: owner.ready && owner.hasOpenedFiles,
        },
      }}
    >
      <View id="root" type="Root" name="IDE instruction">
        <section data-role="application-instruction">
          <ToolCatalog definition={ideTools} />
        </section>
      </View>

      <View id="workspace" type="Workspace" name="Workspace">
        <ToolRef tool={ideTools.openFile} />
      </View>

      {owner.files.map(file => (
        <View key={file.viewId} id={file.viewId} type="FileDetail">
          <pre>{file.content}</pre>
          <ToolRef tool={ideTools.editFile} />
        </View>
      ))}
    </AppTools>
  );
}
~~~

这段代码说明作者形状，owner 方法不是对当前 IDESession 的改名要求。实际迁移保留现有 invoke、receipt、fileReceipt 和业务验证。

AppTools 的实现：

- 一个 App 实例使用一个集合绑定入口，放在共同祖先位置；不能在每个 FileDetail 内重复创建它。
- render 只捕获候选 bindings、生成呈现 context，不写 Runtime registry，不替换已提交 handler，不获取注册 owner。
- layout commit 调用共享 controller；内部使用普通循环，不在循环中调用 Hook，不为每个 Tool 创建隐藏注册组件。
- 用已有 context.projection.beginCommit/endCommit 包围同步绑定更新，finally 保证平衡。
- unmount 精确 dispose 自身 controller。
- controller 可以在 render 中无副作用构造；首次成功进入 commit 才获取 owner。
- 同一 Runtime App 端口的第二个 AppTools owner 被拒绝；SDK 私有 owner token 辅助诊断，Runtime 的逐 Tool 唯一注册仍是最终防线。
- 本批不新增公开的 useAppTools + Provider 双入口，避免形成两套推荐接线方式。

**ToolSet 身份固定：** AppTools/controller 存续期间只更新 handler 与 enabled。换另一 ToolSet 必须显式卸载并重新绑定，例如更改绑定组件 key 或重启 App。直接替换 definition prop 在修改 registry 前报错。显式重挂必须先释放旧 owner，再接纳新 owner。

同样，不支持存续期间无声更换 appTypeTools 端口；App 实例/端口切换走既有卸载与重新初始化边界，避免一个 controller 迁移资源归属。

### 4.5 ToolRef 与 ToolCatalog 的不同职责

**ToolRef：动态呈现引用。**

- 通过 definition 对象取名称和说明，不再由 Hook 返回组件。
- 从 AppTools 本次 render 的候选 frame 读取 enabled；首次 render 不等 effect 回传 UI，不额外触发一次 render。
- disabled 时可返回 null；enabled 时输出现有 tool-ref 表达。
- 不注册、不执行、不选择业务对象，也不增减权限。
- 当前 ViewType 与 Tool 所属类型不一致时可给本项开发诊断；诊断不改变 Runtime 的调用资格。
- 没有渲染 ToolRef，不表示 Runtime 应禁用该 Tool。
- 引用了不属于当前 ToolSet 的 definition，或缺少 AppTools context，给明确作者错误。

**getToolCatalog / ToolCatalog：静态能力目录。**

- 从 ToolSet 导出冻结的纯 JSON descriptor 列表：viewType、name、description、inputSchema、isMutating。
- 不读取 handler、enabled、活跃 View、文件数量或 App 业务状态。
- 顺序确定，以 viewType/name 的稳定比较排序；不受 render 次数或 enabled 切换影响。
- 文案标明“已定义能力”，不能把目录存在表述为当前即可调用。
- ToolCatalog 只在作者选择的位置呈现，不自动创建 View，不决定整个 instruction 页面。
- 使用常规节点文本与现有代码块呈现 Schema，避免新增隐含 HTML/Markdown 混合协议。
- 不把静态目录反向当作执行授权或 tools 列表来源。

IDE 原有目录中随 owner.files.size 过滤 batch_edit 的逻辑移出静态目录；对应 enabled 业务条件保留。其他动态 warnings/初始化状态和全局 instruction 分类问题仍归其应用调整/SRT-03，不能声称本批已保证整个 instruction View 永远不变。

### 4.6 普通 TypeScript 入口与包边界

新增 SDK 子路径 **@aotui/sdk/tools**，导出定义、ToolSet、catalog、绑定 controller 及相关类型。SDK 总入口可再导出这些公共定义函数；两入口必须指向同一实现，不能各有一套品牌表。

~~~ts
const bindings = createToolBindings({
  definition: ideTools,
  appTypeTools, // 受支持的 IAppTypeToolPort
});

bindings.commit({
  openFile: { execute: openFile },
  editFile: { execute: editFile, enabled: true },
});

// 既有 TS Producer 在同一同步流程更新 Views/Refs，
// 然后将当前 views、refs 和 registry.listTools() 一起发布。
publishExistingSnapshot();

bindings.dispose();
~~~

controller 不接受 projection，不 import Preact、DOM、Worker 或 AppKernel 私有实现。纯 TS 可用公开 createViewOwnedTools 构造薄的 IAppTypeToolPort。

Preact 使用现有 context.projection 包围 commit；普通 TS Producer 使用自己的既有同步提交/发布边界。controller 只是 binding 子步骤，不承诺独自完成整个 View/Ref/Tool 事务。

本项不为此导出内部 SemanticProjectionCoordinator，不要求应用 deep import，也不新增第二个 Runtime。纯入口的模块图必须不加载 Preact；是否移除/调整 SDK 的 Preact peer dependency 属于包依赖专项，本批不宣称“安装 SDK 已不需要 Preact”。

## 5. 提交、身份和失败语义

### 5.1 controller 状态

~~~mermaid
stateDiagram-v2
    [*] --> Created
    Created --> Active: 首次 commit 成功
    Created --> Created: 前置验证失败
    Active --> Active: 更新 commit 成功
    Active --> Active: 前置验证失败
    Created --> Failed: 注册或清理失败
    Active --> Failed: 注册或清理失败
    Created --> Disposed: dispose 清理完成
    Active --> Disposed: dispose 清理完成
    Failed --> Disposed: 剩余清理完成
    Disposed --> [*]
~~~

图中展示稳定状态；实现还需要 committing/closing 的同步保护状态。Failed/Disposed 不可恢复提交；正常清理完成后，重试需要 App 显式创建新的绑定 owner。只有全部自身注册清理完成且没有尚未返回的注册调用，才可报告 Disposed；清理不完整时保持 Failed/closing，不声称已释放。失败后的清理不重新执行任何业务 handler。

### 5.2 一次 commit 的具体算法

1. **Prepare：**验证 definition 身份、绑定完整性、函数与 enabled 类型，捕获下一份不可变 frame；不调用业务代码、不修改 registry。
2. **Owner：**首次提交尝试取得该 App 端口的 binding owner；重复 owner 只拒绝自己，不触碰已有 owner。
3. **Guard：**设置 controller 为 committing，并分配本次提交 token。commit 在 committing/closing/failed/disposed 时拒绝重入；通过该 owner 同步重入业务 handler 也必须拒绝。
4. **Reconcile：**同步释放本次禁用的注册，再注册新启用的成员；未变成员保持现有 release handle 和 activation。
5. **Commit：**全部成功后一次替换 committed handler frame，恢复 active。
6. **Failure：**一旦 registry 更新阶段失败，先禁止新的 handler 进入，再释放本 owner 持有的全部注册，清空已提交/候选 handler 引用，标记 failed，抛出有界诊断。全部清理正常完成且没有尚未返回的注册调用后，按 token 释放 SDK owner 占位，允许新的 controller 显式绑定；失败 controller 本身仍不可复用。
7. **Adapter finally：**Preact 的 projection.endCommit 必须执行；普通 TS 在失败时不得发布伪装为成功的候选 snapshot。

算法中不 await。Runtime invoker factory 由 SDK 自己创建，只构造安全包装，不执行 App handler。

**控制器自身的同步重入也必须收口：**端口的 registerTypeTool 返回前可能同步调用 dispose。dispose 此时立即使 controller 不可执行并标记 closing，但不能在仍有未返回的注册调用时释放 owner 占位。每一次 register 返回后，先检查状态和本次提交 token；若已关闭或失效，立即释放刚返回的 handle，再清理其他已取得的 handle，终止提交，不得重新设置 active。只有检查通过后才接纳该 handle。嵌套 commit 明确拒绝；cleanup 中重复 dispose 不递归启动另一轮清理。

safe invoker 保留现有参数验证，并在业务入口前检查 controller active 状态。处于 committing/failed/disposed 时返回既有 not-entered 终态与 TOOL_UNAVAILABLE，不把资格拒绝写成“handler 已进入后的业务失败”。

一次业务调用在进入时取出当前已提交 handler 的局部引用；后续 handler 更新不把正在 await 的旧调用切换成另一函数。dispose 禁止新调用，但不撤销已经发生的业务副作用。

### 5.3 身份变化表

| 变化 | 注册/activation | 调用语义 |
|---|---|---|
| 仅 handler 变化，enabled=true | 保持注册与 activation | 后续进入使用最新已提交 handler |
| true → false | 精确 release，旧资格撤销 | 旧调用不得进入 |
| false → true | 新注册；有匹配 View 时新 activation | 不复活旧 activation |
| enabled=true，暂无该类型 View | 可登记声明，无有效 activation | 目录可存在，实际不可调用 |
| 首个同类型 View 打开 | 现注册激活 | 获得新的有效资格 |
| 1 个变为 10 个同类型 View | 不复制注册 | 共享一组 Tool |
| 关闭部分实例，仍有一个 | activation 保持 | 业务对象仍由 App 校验 |
| 最后一个 View 关闭，再打开 | 旧 activation 撤销，重开分配新身份 | 旧调用不恢复 |
| ToolSet/静态合同更换 | 显式重挂、重新注册 | 旧合同资格失效 |
| App 重启 | 新 App 实例与注册 | 不继承旧资格 |
| registry 阶段失败 | 本 owner 整体关闭 | 不留下半套可调用工具 |

### 5.4 原子性的准确边界

承诺的是：正常适配路径只有提交后的完整 binding frame 可执行；失败后的本 owner 整体不可用。

**不承诺 ACID 回滚。** 当前 registerTypeTool 是逐项接口；release 不回退 activationSequence 或 projection epoch。失败批次允许留下身份序列空洞，绝不复用旧身份。极紧的 retained-byte 配额可能受新 ID 长度影响，不能宣称失败没有任何身份/预算效果。

projection.beginCommit/endCommit 只是 ready/通知边界，不是 registry rollback 或 invoke mutex。SDK 自己的 controller guard 处理本 owner 的同步重入；既有 Producer 负责完整快照捕获。

如果需求变成“更新失败后恢复完全相同的旧 registrations、activation 和预算状态”，应另行设计 Runtime staged batch 合同；本批明确选择失败关闭，不借此引入事务引擎。[C3][C5]

### 5.5 所有权与清理

- controller 只保存自身 register 返回的 release handles，按 owner token 校验。
- dispose 幂等；旧清理回调不能删除后继 owner，也不能清空后继 owner 的 frame。
- Runtime handles 全部清理成功且没有未返回的注册调用后，以 token 比较并释放 SDK owner 占位。新的 controller 可取得该端口；旧 Failed controller 随后的 dispose 不能释放这个新占位。
- 若 cleanup 异常，保留尚未确认释放的 handle 和失败占位以便显式完成清理，保持不可执行，不承诺原 App 端口可以立即重绑。只有确认完成自身清理才能释放占位或报告 Disposed。
- 前置验证失败保留上一提交；第二 owner 被拒绝时不影响第一 owner。
- registry 阶段失败需尝试清理所有自身 handle，不能在第一次 cleanup 异常后中断后续清理；原错误与清理错误分别保留有界诊断。
- 对既有受支持 Runtime，正常 release 应同步、幂等并返还对应 count/bytes。若出现违反端口合同的 cleanup 异常，保持 controller 非 active，不声称资源已全部释放。
- framework 清空的是自己的 handler/frame 引用；不承诺撤回在途调用、释放 App 自有对象、强制 GC 或立即降低 RSS。

## 6. 影响面与兼容策略

### 6.1 模块级影响

| 范围 | 拟修改内容 | 风险/边界 |
|---|---|---|
| SDK tools | 静态定义去 execute；ToolSet、类型见证、catalog、controller | 类型推导与严格捕获是主要风险 |
| SDK Preact | 新 AppTools/ToolRef/ToolCatalog，退出普通 useViewTypeTool 返回组件模式 | commit 与首次呈现必须一致 |
| SDK exports/package | 增加 /tools 子入口，更新公开类型 allowlist、构建与类型导出 | 不能经总入口间接加载 Preact |
| Runtime 实现 | 目标是不改核心/协议；必要时只调整已证实的窄适配缺口 | 新需求若要求批量事务或新 wire，应退出本批范围 |
| Runtime tests/fixtures | 迁移嵌入的旧 SDK 作者代码，保留原不变量断言 | 不得用删测试掩盖调用/生命周期回归 |
| 四个 Tool App | 静态声明、实例 bindings、ToolRef/catalog 接线迁移 | 业务服务、校验、回执语义保持 |
| 文档与 app-builder skill | 更新唯一推荐作者路径、迁移说明、可执行例子 | 防止 Agent 按旧文档继续生成旧 API |
| 其他 SDK 依赖者 | Host、Token Monitor 等构建/依赖范围验证 | 即使未使用 Tool，也要检查包入口 Breaking |

### 6.2 四个真实 App 的迁移

| App | 主要文件 | 允许改变 | 需要原样保留的业务合同 |
|---|---|---|---|
| IDE | ide-tool-contracts.ts、ScopedIDEApp.tsx、WorkspaceCreateView.tsx | 提取静态声明；建立实例 bindings；删除 UI 回传链 | IDESession、路径/版本检查、receipt/fileReceipt、View ID、partial/unknown 结果 |
| Terminal | TerminalTools.tsx、TerminalApp.tsx、RootView.tsx | 静态定义、handler/enabled 绑定、目录 | 当前 terminal 选择、运行中操作约束、关闭行为 |
| Planning | planning-tools.ts、PlanningApp.tsx | 静态定义、实例实现与呈现 | plan/phase/task 关系、activePlan、业务前置条件 |
| Lite Browser | BrowserTools.tsx、LiteBrowserApp.tsx、RootView.tsx | 声明与实例状态分离、目录 | URL/当前结果选择、Search/Page View 生命周期 |

IDE 必须删除通用桥接：IDEToolUIContext、ToolRegistration、IDEToolUIProvider、receiveUI effect，以及以 ViewTypeToolUI 传递创建操作的 prop。应用仍可保留普通展示组件和业务分组函数。

只搜 defineViewTypeTool/useViewTypeTool 不够：相关 App 测试还会直接调用旧 factory 结果的 .execute，必须迁移为测试实例 bindings，不能将 execute 偷放回静态定义。

### 6.3 Breaking 的层次

**确实 Breaking：**

- defineViewTypeTool 不再接受 execute。
- 普通 useViewTypeTool 及其返回 ToolUI 模式退出公共入口。
- ViewTypeToolUI、ViewTypeToolUIProps、UseViewTypeToolResult 等普通 ToolUI 类型退出。
- definition 存续期固定；更换静态合同要显式重挂。
- 当前 API 和示例全部迁移，不永久维护普通工具的两套推荐写法。

**本项保持：**

- IAppTypeToolPort / view-type-tools-v1。
- ordinary-v2 与 view-tool-ordinary-invoke/v3。
- Snapshot V3、Observation/Scope、Ref transport。
- createTUIApp、现有 lifecycle/persistence 协议。
- 当前 native alias 合法性规则。

具体 SDK 发布版本应依项目发布策略选定，不能仅为了数字同步而升级 Runtime major 或改所有协议。准出必须提供“新 SDK 作者 API × 当前受支持 Runtime 包”的真实包证据；若接口事实变了，必须重新评估兼容声明。

旧 useViewSnapshotTool 本项保留，标明独立迁移归 SRT-02。这不是永久双轨承诺。本文也不授权执行仓库另行约定、需要已有验收依据的全局 Legacy 清理。

### 6.4 回退与迁移中间态

- 在实现分支可短暂保留迁移桥，但最终候选包不导出旧普通 Hook 兼容壳，不把旧 execute 字段静默转换。
- 每一阶段提交应可回退；回退采用整组 SDK/App/docs/依赖锁变更回退，不做运行中的双路径 fallback。
- 业务持久化格式、文件内容格式和数据库不因本项迁移；没有数据回填。
- 稳定版发布前更新 IDE、Terminal、Planning、Browser、Token Monitor、Host 的 SDK 依赖范围/锁文件。
- 旧评审和历史验收记录允许保留旧名称；应标清历史状态，不为 grep 清零篡改历史。

## 7. 可行性、替代方案和风险

### 7.1 可行性结论

**有条件可行，主要成本在 SDK 类型/生命周期与消费者迁移，Runtime 核心改动预计很小。**

支撑依据：

- Runtime port 已分离静态声明和 callable factory。[C3]
- 现有 Hook 已证明 committed handler 更新可与注册身份分离。[C1]
- Runtime 已有重复注册拒绝、token-aware release、activation 失效与参数校验。[C3]
- IDE 等应用的 handler 已通过 owner/actions 访问业务，不需把业务状态搬进 SDK。[C4]
- 已有类型测试、真实 Worker 测试和 tarball consumer 框架可扩展。[C6][C7]

“可行”不是已完成验证：M0 必须先证明泛型与包入口；M2/M4 必须覆盖失败关闭和真实产物。

### 7.2 方案比较

| 方案 | 优点 | 代价 | 结论 |
|---|---|---|---|
| 只给原 Hook 加一个 execute 参数，仍返回 ToolUI | 迁移较小 | App 仍需传播动态 ToolUI；声明集合与目录没有自然入口 | 不选 |
| ToolSet + AppTools + 共同 controller | 明确三种生命周期，删除 UI 回传链；纯 TS 可复用；Runtime port 不变 | 需要 SDK Breaking 与四 App 迁移 | 推荐 |
| 重写 createTUIApp，新增 createInstance / AppDefinition 总工厂 | 可集中更多作者元数据 | 顺带重做 owner、订阅、异步初始化与生命周期，范围明显扩大 | 留给独立作者入口设计，不纳入本项 |
| Runtime 新增事务型 batch register | 可追求更强回滚 | 涉及身份、容量、重入和恢复协议 | 本项失败关闭已足够，不选 |

### 7.3 主要风险及验证办法

| 风险 | 处置 | 验证 |
|---|---|---|
| 移除 execute 导致类型关联丢失 | phantom witness；泛型由 definition 单向决定 | 跨模块、真实包 strict tsc；IsAny 反向断言 |
| render 候选 handler 提前生效 | render 无写入；layout commit 一次替换 frame | 未 commit/失败 render 仍执行旧 handler |
| enabled 更新留下半套工具 | 全量预校验；注册阶段失败整 owner 关闭 | 第 N 个 register 失败与容量注入 |
| 第二 owner 或 stale cleanup 破坏已有注册 | 私有 owner token + Runtime 原有 token/重复校验 | 两实例、重复 owner、重挂后旧 dispose |
| ToolRef 与 bindings 首次呈现错位 | 同一候选 frame 驱动呈现；无 effect 回传 | 首次 commit 即正确，无补一轮 render |
| 静态目录误读业务状态 | catalog 只取定义；明确“已定义能力” | 打开/编辑/关闭/disable 后逐字相同 |
| 新 API 又出现大量样板 | 一个 AppTools，直接 definition 引用 | 四 App 迁移与 Agent 作者任务 |
| 内核范围扩张 | 公共协议保持；业务层变更需说明因果 | diff 审查与准出范围门 |
| 旧构件/源码 alias 造成假通过 | 独立 tarball、摘要、无 paths/symlink consumer | 精确产物验收记录 |

## 8. 开发计划：按可验证增量交付

以下仅为 SRT-01 内部分解，不替代 deepseek_review.md 的全局 TODO。

工作量估计：**单个熟悉仓库的工程师约 9–14 个有效工程日**，以现有依赖和测试环境可用为前提；不是日历承诺。主要不确定性是 TypeScript 泛型、Preact 重挂顺序和实际 fixture 迁移量。M0 结束后应依据证据修正估算。

| 里程碑 | 工作与产出 | 依赖 | 预计工程日 |
|---|---|---|---|
| M0：类型与接口原型 | 固化目标签名；跨模块正反类型试件；静态目录与 controller 依赖图；确认无需新 wire | 当前源码盘点 | 1–2 |
| M1：静态定义与纯入口 | definition 去 execute；ToolSet/品牌/捕获/catalog；/tools exports；新增定义诊断 | M0 | 1–2 |
| M2：共同 binding controller | prepare/commit/dispose、owner、fail-closed、身份表；纯 TS 对照试件 | M1 | 2–3 |
| M3：Preact 与真实 App 迁移 | AppTools/ToolRef/ToolCatalog；IDE 移除回传链；其余三个 App；间接 .execute 测试迁移 | M2 | 2–3 |
| M4：发布消费者与文档收敛 | 修改 fixtures、type tests、公开文档/skill；独立 tarball gate；Agent 作者试验；退出旧普通入口 | M3 | 3–4 |

建议提交边界与上述里程碑对应，避免一次提交混入 Ref、Observation 或业务逻辑调整。M1–M3 内的暂时编译过渡不能作为可发布版本。

### 8.1 M0 必须先解决的具体问题

- definition witness 在当前最低支持的 TS 版本下是否能保留 TypeBox 推导。
- AppTools 泛型是否会被错误 bindings 反向放宽；若需要提高 TS 最低版本，明确记录额外 Breaking。
- /tools 从真实产物导入是否不触发 Preact/DOM。
- controller 通过当前 port 是否能完成 handler-only 更新和 enabled 失效。
- fail-closed 的错误边界是否足以服务四个 App；不要以追求透明 rollback 为由悄悄扩成 Runtime 事务工程。

若这些结论不成立，先修订本设计及影响评估，再继续后续实现。不能用 any、deep import 或隐藏兼容分支绕过验证。

## 9. 测试计划：覆盖合同，不镜像实现细节

### 9.1 必测矩阵

| ID | 场景 | 必须观察到的结果 |
|---|---|---|
| T01 | 声明跨模块传给 handler | string/enum/optional/readonly 精确推导，无 any/unknown 退化 |
| T02 | 旧 execute、缺 handler、多 handler、错误参数类型 | 编译拒绝；可运行的形状错误在修改 registry 前拒绝 |
| T03 | 伪造/clone definition、重复 tuple、修改原集合输入 | 拒绝伪造/重复；已捕获集合不变 |
| T04 | 两 App 共用一个 ToolSet | handler、enabled、释放互不串扰 |
| T05 | 无匹配 View → 1 个 → 10 个 → 0 个 → 重开 | 只有一组 Tool；activation 按既有规则生效/撤销/重建 |
| T06 | 仅更新 handler | 注册次数与 activation 不变；执行最新 committed handler |
| T07 | render 未提交或失败 | 候选 handler 不可执行；上一 committed frame 保持 |
| T08 | enabled true/false/true | 关闭立即失去资格；重开不能复活旧 activation |
| T09 | 第二 owner，包含全 disabled 集合 | 第二 owner 被拒绝；第一 owner 无变化 |
| T10 | 初次第 N 项 register 失败 | 本 owner 已成功项被释放；后续项不继续；正常清理后新 controller 可绑定，旧 failed.dispose 不伤新 owner |
| T11 | 更新时 capacity/duplicate 错误 | 本 owner 进入 failed；其他 owner/App 正常；成功清理后占位释放，清理异常时禁止冒充已释放；不恢复旧身份 |
| T12 | dispose 重复、重挂后旧 cleanup、handler 在途 | 幂等；新 owner 不受旧清理影响；不宣称撤销已有副作用 |
| T13 | committing 中重入 handler、commit，以及 register 返回前重入 dispose | handler 未进入；嵌套 commit 被拒；dispose 后不复活 controller，迟到 handle 被释放，其他 owner 不受影响 |
| T14 | 正常 projection 通知 | 只捕获完整提交或失败关闭后的状态，不发布半套 binding |
| T15 | ToolRef 首次 render/disabled/省略/错配 | 无回传 render；显示不影响注册授权；错配有作者诊断 |
| T16 | 静态目录前后比较 | 打开/编辑/关闭/enable 切换不改变目录；不含函数/owner |
| T17 | Preact 与纯 TS 对照 | 同一定义和事件序列得到同样 descriptor、调用、失效和清理结果 |
| T18 | IDE 打开/编辑/关闭两个文件 | type tool 去重；主要数据在 View；receipt/业务失败语义保留 |
| T19 | 当前 Runtime 与新 SDK 的真实 tarball | 公开 exports/types/Worker/Source 可用；无源码 alias 或旧 dist |
| T20 | Ref 及原运行语义回归 | 现有 Ref、Snapshot、Observation、Scope 合同未被本项改写 |

T07 只承诺“绑定提交前不使用候选 handler”；AppTools layout commit 成功不等于 Host 已收到新 Snapshot，更不等于 Observation 已采用。后两者不借本测试宣称完成。

T10/T11 应断言 binding count 和属于本 owner 的 retained bytes 正确回收，但不要求 activationSequence 回退；不能用 GC/RSS 作为 handler 引用已清理的唯一证据。

### 9.2 测试分层

1. **类型与定义层：**跨模块 TypeScript 正反例、Schema 捕获、ToolSet/catalog，无需启动 Worker。
2. **binding 与 Preact 层：**真实 Runtime registry 配合最小 App；注入明确的第 N 次注册失败、重入、disabled 和卸载。
3. **Worker 与真实应用层：**迁移既有 fixtures，保留 lifecycle、ordinary/Ref、结果和投影断言。
4. **正式包与 Agent 作者层：**独立安装 tarball，验证公开消费和实际作者体验。

只为确切风险扩展测试。局部迭代先跑相关集合；最终因跨 SDK API 与多 fixtures 迁移，需要执行受影响包的完整测试，避免遗漏间接旧签名消费者。

### 9.3 实施阶段命令

以下为当前仓库已存在的命令入口；新增测试文件须接入对应脚本。**编写本文时未执行这些构建、测试或打包命令。**

所有相对命令都以**本次实现 checkout 的仓库根目录**为工作目录。delivery-directory 只是已生成交付产物的输入目录，不是工作目录；prepare 与 verify 必须调用同一实现 checkout 中的 scripts/scoped-ide.mjs。该 runner 根据自身位置选择安装环境与 w10/IDE 测试，不能从旧 checkout 调用旧测试去验收新包。交付证据同时记录验收 checkout 的 commit/tree 标识与未提交差异摘要。

在隔离实现/交付 checkout 中准备匹配构件。当前 Runtime 依赖 Driver；干净本地 link 环境需要先准备其构件，SRT-01 不修改该 Driver。

~~~bash
pnpm -C runtime run build
pnpm -C sdk run build
pnpm -C sdk exec tsc -p tsconfig.public-api-types.json
pnpm -C sdk run test:run
pnpm -C runtime run test:run
~~~

SDK 本地 type tsconfig 仍可能使用 runtime/dist 的 paths，因此该 tsc 不能代替独立安装包验收。Vitest 仅转译 TS 也不能代替 type-check。

四个真实应用：

~~~bash
pnpm -C demo-apps/aotui-ide run build
pnpm -C demo-apps/aotui-ide run test:view-type-tools
pnpm -C demo-apps/aotui-ide run test:workspace-create-lifecycle
pnpm -C demo-apps/aotui-ide run test:integration
pnpm -C demo-apps/terminal-app run build
pnpm -C demo-apps/terminal-app run test:run
pnpm -C demo-apps/planning-app run build
pnpm -C demo-apps/planning-app run test:run
pnpm -C demo-apps/lite-browser-app run build
pnpm -C demo-apps/lite-browser-app run test:run
~~~

Host 与 Token Monitor 另做最小依赖/编译验证，使用本次候选 SDK 与匹配构件，不启动 GUI 或生成 Electron 安装包：

~~~bash
pnpm -C host exec tsc -p tsconfig.json --noEmit
pnpm -C demo-apps/token-monitor-app run build
~~~

若基线已存在无关编译失败，应记录同一环境的前后对比，证明没有新增 SDK 相关错误，并单列未满足项；不能将失败日志改称通过。候选 SDK 的依赖解析路径与版本需要记录。

真实包消费者使用既有交付 runner：

~~~bash
node scripts/scoped-ide.mjs prepare /absolute/delivery-directory
node scripts/scoped-ide.mjs verify
~~~

prepare 不负责打包。delivery 必须先包含 artifacts/local-dev.json、Runtime/SDK/IDE 三个 tarball、consumer-package.json、consumer-package-lock.json 及对应摘要；可用 --offline，但缺失离线依赖不能当作通过。

最低正式包验证：

- SDK 公共作者：strict、skipLibCheck:false、无源码 paths；模块 A 定义、模块 B 绑定；包含负向类型用例。
- 普通 TS：从 /tools 与 Runtime 正式公开入口运行，不通过 deep import，不初始化 Preact。
- Node Worker App：至少两个 App 实例、多个同类型 View、handler/enabled 更新。
- 真实 IDE 包：打开、编辑、关闭与目录稳定。
- 继续通过现有 w10 consumer 的 Core 文档、Source 和 ordinary/Ref 共存验证。

独立 w10 入口：

~~~bash
node runtime/tests/w10-package-consumer.mjs /absolute/installed-consumer /absolute/evidence/public-package.json
~~~

候选产物必须记录 SDK/Runtime/IDE 版本与 tarball SHA-256。不得用复制 workspace dist、symlink、本地 alias 或缺构件导致的 skip 代替通过。

### 9.4 Agent 作者验证

固定模型/配置、公开文档版本、任务输入与最大修复轮次；不授予私有 Runtime 源码。至少三类任务：

1. 多个同类型 View，共享一个工具，通过显式参数选择对象。
2. 同一 ToolSet 在两个 App 实例中使用，动态 enabled 与静态目录分开。
3. 故意的缺 handler / 错 Schema / 重复 Tool 声明，依据公开诊断修复。

建议每类独立运行三次，每次最多两轮修复，记录成功率、修复轮次、私有 API 使用数和人工介入。九次至少八次完成；所有完成结果的关键语义检查必须通过，不能以多数成功抵消一次框架权限/身份错误。

这是本版作者契约的验收样本，不足以宣称对全部 LLM 都有统计意义的提升。不设置未经基线测量的 token 节省百分比。若尚未执行，作者验证项保持未通过，不能用人类手写示例冒充 Agent 结果。

## 10. 准出条件：全部有证据后才能关闭 SRT-01

以下复选框在本次文档交付时全部未勾选。

### G1：公开合同与类型成立

- [ ] 静态 definition 不接受/不持有 execute；ToolSet 不持有业务 owner。
- [ ] 模块间与真实包类型推导精确；错误 handler、缺项、多项与旧 API 使用被拒绝。
- [ ] /tools 的运行时依赖图不加载 Preact/DOM/Worker 私有实现。
- [ ] 只有一个推荐 Preact 集合绑定入口，没有普通旧 Hook 兼容壳。

### G2：运行正确性成立

- [ ] T04–T14 全部通过，覆盖双 App、十个同类 View、committed handler、禁用/重开、重复 owner、失败关闭与 stale cleanup。
- [ ] 失败后不留下半集合可执行；其他 App/owner 不受误清理。
- [ ] identity 不复用、参数验证、业务结果/投影失败分离等既有断言保留。
- [ ] 本批没有改变 Observation 采用、旧 Ref 版本语义和 Scope 寿命。

### G3：作者收益与迁移完整

- [ ] IDE 的 ToolUI 注册回传链已删除；业务 owner 与 receipt 逻辑没有被搬入 SDK。
- [ ] 四个 Tool App、直接与间接 .execute 测试、Runtime 内嵌 fixtures 全部迁移。
- [ ] 生产工具的名称、说明、Schema、ViewType 在注册与目录中只有一份声明来源；公开文档示例由可执行试件同步或验证。
- [ ] catalog 的逐字稳定检查通过；ToolRef 不参与授权或业务目标选择。
- [ ] Agent 作者验证达到本方案记录的门槛，附原始任务与结果。

### G4：真实产物、文档与范围可信

- [ ] 精确候选 tarball 的 strict type-check、纯 TS、Worker、IDE 验收通过，版本/摘要可追溯。
- [ ] 需要的测试无意外 skip；构件来源不是旧 dist、source alias 或 workspace link。
- [ ] SDK exports、README、API 状态、迁移、生命周期、兼容矩阵与 app-builder skill 同步。
- [ ] Host 与 Token Monitor 的 SDK 依赖解析及编译验证完成；不以本项要求全量 Host GUI/e2e 测试。
- [ ] SDK Breaking 发布号与消费者依赖范围已按项目策略处理；协议未变化却升版本的行为不存在。
- [ ] diff 审查确认没有业务状态机、自动授权、Ref 重写、观察管理器、资源预算平台或新 Runtime 核心。
- [ ] 最终交付记录区分实际执行结果、未执行项与已知限制；不把本文计划当作测试报告。

即使局部测试通过，只要 G1–G4 存在未满足项，就不能将 SRT-01 标记为“已完成”。该条件针对本项的交付质量，不表示本文已经授权代码实施、发布或提交远端仓库。

## 11. 文档与迁移文件清单

### 11.1 当前正式作者文档

- sdk/README.md
- sdk/docs/view-type-tools.md
- sdk/docs/api-status.md
- sdk/docs/migration.md
- sdk/docs/ordinary-v2.md
- sdk/docs/tool-lifecycle.md
- sdk/docs/runtime-compatibility.md
- sdk/docs/readonly-ref-v2.md 中普通 Tool 的对照部分
- runtime/docs/tool-lifecycle.md
- runtime/docs/runtime-app-interaction.md
- runtime/README.md 中普通 Tool 的范围说明
- demo-apps/aotui-ide/SCOPED_IDE.md

Agent 实际读取的指导需要同步：

- .agents/skills/aotui-app-builder/SKILL.md
- .agents/skills/aotui-app-builder/references/sdk_api.md
- .agents/skills/aotui-app-builder/references/AOTUI_APP_LLM_FRIENDLY_GUIDELINES.md

当前工作只有本文与 deepseek_review.md 的方案链接更新；上述源码/正式文档/skill 的修改属于未来实施，不是本次已完成工作。

### 11.2 代码与测试的重点迁移入口

SDK：

- sdk/src/tools/view-type-tool.ts
- sdk/src/hooks/useViewTypeTool.ts
- sdk/src/index.ts、sdk/package.json
- sdk/src/view-type-tool.test.tsx、sdk/src/view-type-tool.integration.test.tsx
- sdk/src/public-api-contract.test.tsx、sdk/src/view-tool-types.test.ts
- sdk/type-tests/view-type-tool.ts、sdk/type-tests/public-api.ts
- sdk/tsconfig.public-api-types.json

应用与测试：

- demo-apps/aotui-ide/src/tui/ide-tool-contracts.ts
- demo-apps/aotui-ide/src/tui/ScopedIDEApp.tsx
- demo-apps/aotui-ide/src/tui/WorkspaceCreateView.tsx
- demo-apps/aotui-ide/tests/view-type-tools.mjs
- demo-apps/terminal-app/src/tui/TerminalTools.tsx 与 test/terminal-tools.test.ts
- demo-apps/planning-app/src/tui/planning-tools.ts 与 test/planning-tools.test.ts
- demo-apps/lite-browser-app/src/tui/BrowserTools.tsx 与 test/browser-tools.test.ts

Runtime fixtures/验收：

- runtime/tests/fixtures/ordinary-v2-slice.mjs
- runtime/tests/fixtures/ref-v2-slice.mjs 中普通 Tool 部分
- runtime/tests/fixtures/dual-producer-app.mjs
- runtime/src/e2e-test/fixtures/tool-lifecycle.mjs
- runtime/src/engine/app 下嵌入旧作者 API 的 Worker e2e tests
- runtime/src/kernel/close-reporting-e2e.test.ts
- runtime/tests/w10-package-consumer.mjs

实施开始与结束均应使用 rg 重新盘点 definition、Hook、ToolUI 类型和 .execute 消费者；清单不是静态搜索的替代。历史评审允许旧名称，当前入口和新产物不允许遗漏旧作者路径。

## 12. 本次方案的验证边界

已经完成：

- 重读 AGENTS.md 与 deepseek_review.md 的 SRT-01 及相邻合同。
- 核对 SDK 定义、Hook、AppTools port、Runtime register/release、projection coordinator。
- 盘点四个真实 Tool App、间接测试消费者、公开类型、文档与真实包 runner。
- 对类型、批次失败边界、最小 Runtime 影响和迁移半径做独立交叉审阅。

尚未完成：

- 本方案代码实现。
- 目标 API 的真实 TypeScript 编译原型。
- 新测试、完整测试、构建、打包、真实模型作者验证。
- 版本发布、git commit 或项目所有者的实现验收。

因此，本文给出的是基于当前源码的可实施设计与验证标准，不是实现完成或性能提升的证明。

## 附录 A：基线与可追溯证据

### A.1 关键文件 SHA-256

以下摘要在本次给 deepseek_review.md 增加方案链接前计算；该文档后续仅增加关联链接会使其摘要改变。实现源文件未因本次任务修改。

| 文件 | SHA-256 |
|---|---|
| deepseek_review.md | 24e7a78b7bc06d5149d66cc772da7326a5776efda2270e9aaab682a72afeacb2 |
| sdk/src/tools/view-type-tool.ts | e96aca1aa3a258167c1ae7e3a019e0dc91f3fcde27abe6d2252a2e0298d949e3 |
| sdk/src/hooks/useViewTypeTool.ts | b0d5c5dd49c1ccbd580b7e1a3edfbb9061eb8bf61a256f6bfbbb8bdbeaa1a4c3 |
| runtime/src/spi/runtime/app-type-tools.interface.ts | 3987aafb4653797ab6a58b7446c0e4f419198611af086f8b757c40f8b377e34e |
| runtime/src/core/tool/view-owned-tools.ts | 221eacdd233aed0488da4ea195a683c9dfe8d3b265d10065d25db0a505d12630 |
| sdk/package.json | 7f3af3a7c3f2f60cd322ae97d4f39ab6101bc0464e213d64647d684c9f5cc4c2 |

### A.2 源码与合同依据

- **[C1] SDK 当前声明与 committed handler：**[view-type-tool.ts](sdk/src/tools/view-type-tool.ts)、[useViewTypeTool.ts](sdk/src/hooks/useViewTypeTool.ts)。
- **[C2] 当前工厂、Context 与包入口：**[createTUIApp.ts](sdk/src/app-factory/createTUIApp.ts)、[AppRuntimeContext.tsx](sdk/src/context/AppRuntimeContext.tsx)、[SDK package](sdk/package.json)、[SDK exports](sdk/src/index.ts)。
- **[C3] Runtime 已有 definition/invoker 分离、重复检查与释放：**[app-type-tools.interface.ts](runtime/src/spi/runtime/app-type-tools.interface.ts)、[view-owned-tools.ts](runtime/src/core/tool/view-owned-tools.ts)、[AppKernel.ts](runtime/src/worker-runtime/app-kernel/AppKernel.ts)。
- **[C4] IDE 的连接负担与业务边界：**[ScopedIDEApp.tsx](demo-apps/aotui-ide/src/tui/ScopedIDEApp.tsx)、[ide-tool-contracts.ts](demo-apps/aotui-ide/src/tui/ide-tool-contracts.ts)、[WorkspaceCreateView.tsx](demo-apps/aotui-ide/src/tui/WorkspaceCreateView.tsx)。
- **[C5] 提交标记与核心资格保证：**[coordinator.ts](runtime/src/core/projection/coordinator.ts)、[view-type-tools.v3.test.ts](runtime/src/core/tool/view-type-tools.v3.test.ts)、[source-binding.ts](runtime/src/core/tool/source-binding.ts)。
- **[C6] 当前类型/SDK 验证：**[type-tests](sdk/type-tests/view-type-tool.ts)、[SDK behavior tests](sdk/src/view-type-tool.test.tsx)、[public API tests](sdk/src/public-api-contract.test.tsx)。
- **[C7] 正式包与普通 TS 依据：**[core-public-entry.md](runtime/docs/core-public-entry.md)、[w10-package-consumer.mjs](runtime/tests/w10-package-consumer.mjs)、[scoped-ide.mjs](scripts/scoped-ide.mjs)。
- **[C8] 产品目标与本项来源：**[AGENTS.md](AGENTS.md)、[deepseek_review.md](deepseek_review.md#sdk-authoring)。

这些测试文件作为现有合同依据被阅读；不表示本次执行了它们，也不表示现有通过记录能为新 API 直接背书。
