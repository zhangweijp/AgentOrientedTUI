# @aotui/sdk

用 Preact 或普通 TypeScript 构建面向 Agent 的应用。App 管理业务状态，View 呈现当前状态，Tool 发起操作并返回简短收据；SDK/Runtime 维护提交、身份、调用资格和资源释放。

普通 TypeScript 和 Preact 的完整可运行示例见 [App 作者指南](docs/app-authoring.md)。

## 从这里开始

1. 读 [作者指南](docs/view-type-tools.md)，了解单一 Tool 声明、App 绑定和动态可用性。
2. 运行 [文件 App](docs/examples/file-app.tsx)：打开 a.txt/b.txt，编辑后读最新 FileDetail，最后关闭页面。它只操作内存，不访问磁盘。
3. 对已展示的业务对象，读 [Ref 参数与完整示例](docs/readonly-ref-v2.md)：类型提示留在页面，调用用 `view_id.local_ref`。
4. 读 [View 合同](docs/views.md)：显式 id/type/kind、独立页面、原样正文和唯一包装。
5. 普通 TS 使用 [createApp 与 publish](docs/app-authoring.md)；迁移旧应用看 [迁移说明](docs/migration.md)。

[API 参考](docs/api-status.md)、[参数规则](docs/ordinary-v2.md)、[生命周期](docs/tool-lifecycle.md)和[持久化](docs/persistence.md)用于查阅。匹配包与安装、构建、验证命令统一见 [包使用说明](docs/runtime-compatibility.md)。当前工作树的能力已采用；这不表示同版本的旧文件或 registry 包自动具备这些能力，也不表示已经发布。

## 最小组件应用

```tsx
import { createTUIApp, View } from '@aotui/sdk';

function App() {
  return <View id="root" type="Root" kind="instruction">
    <h1>Example Application Instruction</h1>
    <p>Read this page. This application has no domain tools.</p>
  </View>;
}

export default createTUIApp({ app_name: 'example', component: App });
```

应用模块 default 导出唯一托管工厂。`app_name` 匹配 `/^[a-z0-9_]+$/`；View id 在 App 内唯一，使用2–15位字母、数字或下划线。View 必须显式提供 type 和 kind（instruction/state），多个实例可共享 type，页面不能嵌套。

## 开发时记住的合同

- 用 TypeBox 和 `defineViewTypeTool` 声明一次 viewType/name/description/inputSchema，用 `defineToolSet` 组织；handler 放入 AppTools 的 bindings 或普通 TS 的 `publish({ views, bindings })`。没有 isMutating 分类。
- 完整说明与参数 Schema 由上下文的 Tools 提供。Root 用 `ToolCatalog` 从同一声明按 ViewType 列出名称；数据 View 呈现业务状态和 Ref，不复制完整工具定义。目录、可见性和 enabled 都不能代替授权与业务检查。
- Tool 按 App + ViewType 共享。打开匹配页面后能力出现，最后一个匹配页面关闭后失效；Tool 不隐式选择某个实例。
- 文件路径、编辑内容、标题等保留普通参数。已发布对象用 Ref 选择：页面中 `Note:notes[0]` 位于 View `detail`，调用写 `detail.notes[0]`，不带展示类型前缀、不抄业务 ID。对象、整列表、元素、多个/可选字段和多选均使用同一个 refParam。
- 参数递归只读，不自动 coercion/default/trim。App 检查对象是否仍存在、归属、状态与权限，并自行执行业务变更。Tool 收据与当前业务数据分别通过结果和 View 呈现；unknown 写入不自动重试。
- 框架生成外层 XML，App 不拼接外壳或预转义。文件/代码/日志使用 pre/code，保留空白及 CR/LF；普通说明按 HTML→Markdown 规则排版。
- 宿主准备 Context 后显式 adopt，再调用。新采用撤销旧资格，释放无人持有的旧来源；诊断预览不采用。App 通过 SDK 声明 Ref 与 Tool，Runtime 处理调用绑定与 Ref 解析。

## 源码开发

在已准备依赖的仓库中：

```sh
pnpm -C runtime run build
pnpm -C sdk run build
pnpm -C sdk run typecheck:static
pnpm -C sdk exec vitest run
```

构建和严格类型门禁使用原生 TypeScript 7.0.2。SDK 的 TypeScript ESLint 开发图暂用 Microsoft 的旧 Compiler API 兼容包；它不属于 App 运行依赖，也不是应用作者的额外配置。lint、完整 Driver 第三方声明和原生 LSP 的已知限制分别记录，不能从示例运行通过推导整个工具链全绿。
