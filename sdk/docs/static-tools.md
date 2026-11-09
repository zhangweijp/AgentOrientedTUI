# 静态 Tool 声明与实例绑定

`@aotui/sdk/tools` 提供静态定义、类型推导、ToolSet、目录数据和 `createToolBindings`。总入口复用相同实现与私有品牌；纯入口运行时不加载 Preact、DOM 或 Worker。

```ts
import Type from 'typebox';
import { defineViewTypeTool, defineToolSet, getToolCatalog } from '@aotui/sdk/tools';
import type { ArgsOf, SchemaOf } from '@aotui/sdk/tools';

const input = Type.Object({
  filePath: Type.String(),
  content: Type.String(),
}, { additionalProperties: false });
const editFile = defineViewTypeTool({
  viewType: 'FileDetail',
  name: 'edit_file',
  description: 'Edit an opened file and read its updated View.',
  inputSchema: input,
});
const tools = defineToolSet({ editFile });
const catalog = getToolCatalog(tools);
type EditArgs = ArgsOf<typeof editFile>;
type EditSchema = SchemaOf<typeof editFile>;
```

`EditArgs` 是从原始 TypeBox Schema 推导的递归只读参数；`EditSchema` 保留原始 Schema 的具体类型。definition 的运行时 `inputSchema` 是 Runtime 规范化的深冻结 JSON，和输入 Schema 分离。声明不划分工具读写类别；业务权限与副作用由 App/Host 校验。

静态声明只接受 viewType、name、description、inputSchema。旧 execute 在编译期通过 `execute?: never` 拒绝，在运行时也由字段检查拒绝。definition 和 ToolSet 不读取 App、不持有业务 handler、不注册工具。输入及 Schema 的 getter 不会在捕获中执行。

ToolSet 的本地键只关联定义，不是第二个公开工具名。结构化 `(viewType, name)` 必须唯一；不同 ViewType 可使用相同名称。集合捕获并冻结输入，要求 definition 来自当前 SDK 构造器；复制或伪造对象不能替代它。

catalog 是按 viewType/name 稳定排序、冻结的纯 JSON 列表，每项只有 viewType、name、description、inputSchema。它描述“已定义能力”，不表示当前存在匹配 View 或已经获得调用资格。

旧 `useViewTypeTool` 已退出。普通 TypeScript 绑定见 [binding-tools.md](binding-tools.md)，AppTools、ToolRef 和 ToolCatalog 见[组件指南](app-tools.md)。Ref、观察和执行资格遵循既有 Runtime 合同。配套包与当前安装步骤统一见 [包使用说明](runtime-compatibility.md)。

纯入口的运行时依赖隔离不等于安装 SDK 无需 Preact，也不表示声明文件已脱离 DOM ambient 类型。


Root 可用 ToolCatalog 呈现按 ViewType 分组的工具名称；组件不呈现 description、inputSchema 或输入输出结构。getToolCatalog 仍返回冻结的四字段静态数据，供程序复用，不应将其 JSON 写入 View。完整说明与参数合同只由 Context Tools 提供。数据 View 只呈现业务状态及 Ref，避免重复列工具表。
