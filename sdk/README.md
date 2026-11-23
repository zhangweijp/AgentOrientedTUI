# @aotui/sdk

为 Agent 编写 AOTUI App。App 持有业务状态，View 展示当前状态，Tool 发起操作并返回结果。一次完整提交同时交付页面、Ref 和工具能力。

## 构建第一个 App

在新的 Node ESM 项目里写一个计数器。普通 TypeScript 使用 `@aotui/sdk/app`。写 JSX 时还要安装 Preact，再从 `@aotui/sdk` 导入。

### 初始化作者项目

```sh
npm init -y
npm pkg set type=module
npm install --save-exact typebox@1.4.3
npm install --save-dev --save-exact typescript@7.0.2
```

### JSX 所需的 Preact

普通 TypeScript 跳过这一步。App 和 SDK 使用同一个 Preact 模块实例。使用 bundler 时将 Preact 及其子路径设为 external。

```sh
npm install --save-exact preact@10.29.1
```

### 从 npm registry 安装 SDK

在此步骤和下方的本地待发包步骤中选一种。npm 会把精确版本写入 App 的 `package.json`。

```sh
npm install --save-exact @aotui/sdk@0.9.0
```

### 使用本地待发包

在初始化并装好其余依赖后，将 `aotui_sdk_tar` 和 `aotui_core_tar` 设为同批 SDK 和 Core 包的绝对路径。tarball 供作者本机编译，App 的 `dependencies` 记录 SDK 的版本号。接收方配置的 npm registry 须提供该版本的 SDK 及其依赖。待发版本也可以由内部 registry 按版本提供。

```sh
npm install --no-save --package-lock=false "$aotui_sdk_tar" "$aotui_core_tar"
npm pkg set "dependencies.@aotui/sdk=$(node -p "require('./node_modules/@aotui/sdk/package.json').version")"
```

registry 可以解析该版本后，作者可用 `npm install` 将 SDK 写入项目的 lockfile。

### 普通 TypeScript 计数器

将代码存为 `app.ts`。

```ts
import Type from 'typebox';
import { createApp, createView, defineViewType, ViewMultiplicity, ViewRegion } from '@aotui/sdk/app';

const Counter = defineViewType<{ add(by: number): void }>()({
  name: 'counter',
  multiplicity: ViewMultiplicity.Single,
  region: ViewRegion.Dynamic,
  tools: {
    add: {
      description: 'Increase the counter, then read the current page.',
      inputSchema: Type.Object({ by: Type.Integer() }, { additionalProperties: false }),
      execute({ input, context }) {
        context.add(input.by);
        return { success: true };
      },
    },
  },
});

export default createApp({ app_name: 'counter', viewTypes: [Counter], initialize({ prepareProjection }) {
  let count = 0;
  const page = createView(Counter, { render: () => ({
    body: `Count ${count}`,
    context: { add(by) { count += by; publish(); } },
  }) });
  function publish() { prepareProjection({ views: [page] }); }
  publish();
} });
```

将下方配置存为 `tsconfig.json`。

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "lib": ["ES2022"], "types": [],
    "strict": true, "exactOptionalPropertyTypes": true, "skipLibCheck": false,
    "declaration": true, "outDir": "dist"
  },
  "files": ["app.ts"]
}
```

### JSX 计数器

将代码存为 `app.tsx`。

```tsx
import Type from 'typebox';
import { useState } from 'preact/hooks';
import { createTUIApp, defineViewType, ViewMultiplicity, ViewRegion } from '@aotui/sdk';

const Counter = defineViewType<{ add(by: number): void }>()({
  name: 'counter',
  multiplicity: ViewMultiplicity.Single,
  region: ViewRegion.Dynamic,
  tools: {
    add: {
      description: 'Increase the counter, then read the current page.',
      inputSchema: Type.Object({ by: Type.Integer() }, { additionalProperties: false }),
      execute({ input, context }) {
        context.add(input.by);
        return { success: true };
      },
    },
  },
});

function App() {
  const [count, setCount] = useState(0);
  return <Counter context={{ add: by => setCount(value => value + by) }}>
    <p>Count {count}</p>
  </Counter>;
}

export default createTUIApp({ app_name: 'counter', component: App, viewTypes: [Counter] });
```

将下方配置存为 `tsconfig.json`。

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "lib": ["ES2022", "DOM"], "types": [],
    "strict": true, "exactOptionalPropertyTypes": true, "skipLibCheck": false,
    "jsx": "react-jsx", "jsxImportSource": "preact", "declaration": true, "outDir": "dist"
  },
  "files": ["app.tsx"]
}
```

### 生成制品

两种计数器使用同一组构建命令。

```sh
npm exec -- tsc -p tsconfig.json
npm pkg set main=./dist/app.js types=./dist/app.d.ts 'files[0]=dist' 'files[1]=aoapp.json'
npm exec -- generate-aoapp .
npm pack
```

`generate-aoapp <app-dir>` 读取 `package.json` 指定的已编译入口，校验默认导出的 App 工厂并生成 `aoapp.json`。将 `npm pack` 生成的压缩包交给宿主，例如在接收方项目中运行 `npm install ./counter-plain-1.0.0.tgz`。工具 `add` 接收 `{"by":1}`，下一次观察会显示新的计数。宿主调用示例随 `@aotui/runtime` 的 README 提供。

## 页面、实例和工具

`defineViewType` 一次声明类型、实例数和工具。页面各自提供 `context`。`ViewRegion.Static` 和 `ViewRegion.Dynamic` 决定消息位置。直接 JSX 与 `createView` 可覆盖类型的默认区域，缺省时必须在挂载时指定。共享的普通 TypeScript 声明可通过 `<StaticView type={Definition}>` 或 `<DynamicView type={Definition}>` 挂载。

单实例默认用类型名作 ID，挂载可传 `id`，调用只填业务参数。多实例共享一组工具，调用必须填接收页面的 XML `view_id`。默认编号从 1 开始，挂载可传 `idPrefix`，类型上可用同步 `createId({ prefix, sequence, context })` 指定完整 ID。同一挂载更新或重排时沿用 ID。声明名、前缀和最终实例 ID 区分大小写，使用 ASCII 字母、数字或下划线，至少有一个非数字字符。

打开且满足 `enabled(context)` 的页面让工具进入观察。页面组件写业务 Markdown 或相应的语义标签，正文由 Runtime 的呈现入口统一包装。Root 说明业务流程。当轮 Tools 提供当前可用的工具名称、说明与 Schema。

直接 JSX、`StaticView`、`DynamicView` 和 `createView` 都可在挂载处声明 `onClose?: () => ToolResult | Promise<ToolResult>`。由 App 检查业务约束并提交移除该页的新投影。Runtime 分别报告回调已接受与原挂载已移除。宿主收起窗口或替换预算提示时，App 继续持有页面。

## Markdown 正文

直接将 Markdown 字符串作为 View 的子节点，或从普通 TypeScript 的 `render()` 返回 `{ body: markdown }`。框架保留原文的缩进、换行和空白，并在模型消息边界包装 View XML。用 JSX 写行内内容时，在词之间明确写出空格，例如 `<p>库存 <strong>充足</strong>。</p>`。代码和 Mermaid 可以使用 `<pre><code class="language-mermaid">{source}</code></pre>`。

用 JSX 写表格时，第一行全部使用 `th`，其余各行使用相同列数的 `td`。行可以直接放在 `table` 下，也可以放在 `thead` 或 `tbody` 中。空格子用 `<td />`。`<td>{filename}</td>` 按字面值呈现文件名，包括 `__init__.py`、方括号和 `|`。用 `<strong>`、`<em>`、`<a>` 或 `<code>` 表达明确的行内格式。相对链接可以直接在 `href` 中使用带空格的路径。

```tsx
<table>
  <thead><tr><th>文件</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>{'__init__.py'}</td><td><code>A|B</code></td></tr>
    <tr><td><a href="docs/stock list.md">库存清单</a></td><td>12</td></tr>
  </tbody>
</table>
```

合并格、嵌套表格、行宽不符和格内换行会使这次投影返回 `SNAPSHOT_INVALID`，诊断会指出对应的 View、表格及可确定的行列。用简单表格或分组列表表达这些内容。直接传入的 Markdown 字符串按原文交付。

## 发布 Ref 与传业务参数

用 `useDataRef`、`useArrayRef` 或普通 TypeScript 的 `ref`、`arrayRef` 和 `formatRef` 发布只读 JSON。`private` 只供发布页使用，`protected` 可供同一 App 实例的页面使用，`public` 还允许同一轮模型请求中可见的其他 App 取值。比如通讯录发布 `public` 邮箱数组后，邮件草稿的普通 `string[]` 参数可接收 `"$contacts.list.emails"`。Runtime 按原观察取值。ArrayRef 的整体和元素共用一个登记。

| 页面 `app_id="notes"` `view_id="detail"` 中的标记 | 调用参数 |
| --- | --- |
| `[列表](protected items: Note[])` | `"$notes.detail.items"` |
| `[首项](items[0])` | `"$notes.detail.items[0]"` |
| 字面名为 `items[0]` 的单独 Ref | `'$notes.detail["items[0]"]'` |

每个具名业务参数接受字面值或兼容的 Ref 地址。直接同类数组还可以逐项混用。前缀 `$$` 去掉一个 `$` 并按原文交付。已有的 `refParam(refType, schema)` 适用于必须选真实已发布值的参数。handler 始终接收校验后的业务值。Runtime 绑定原观察，App 检查当前对象及外部变更。

地址可以沿已授权的对象键和数组下标取值。以下是普通 TypeScript 通讯录的 `contacts.list` 页使用的 Ref。把 `body` 和 `refs` 随页面 `context` 一起交给 `render()` 的返回值。

```ts
import Type from 'typebox';
import { formatRef, ref } from '@aotui/sdk/app';

const people = ref('people', [{ email: 'reader@example.test' }], {
  scope: 'public', schema: Type.Array(Type.Object({ email: Type.String() })),
});
const body = formatRef('联系人', people);
const refs = [people];
```

邮件工具用 `inputSchema: Type.Object({ to: Type.String() })` 声明参数。Host 授权这个字段后，模型可传入 `{ "to": "$contacts.list.people[0].email" }`，handler 收到实际邮箱字符串。`["0"]` 选择对象自有键，`[0]` 选择数组元素，`["display.name"]` 选择带点号的键。普通字段通过业务 Schema 验型。`refParam` 的来源资格限于整项 Ref 和已标记的 ArrayRef 元素。

参数使用 TypeBox 支持子集，类型、对象、数组、固定长度的 `Type.Tuple`、`enum`、`const`、`anyOf` 和常用范围约束可用。作者 Schema 的 `pattern` 在声明期拒绝，业务字段可叫 `pattern`。框架从同一份登记派生原生 Tool 与 Console 参数。Console 的普通参数直接接收 JSON，`refParam` 仍要求已发布的地址。

用 `Type.Tuple([Type.String(), Type.Integer({ minimum: 1 })])` 声明影院座位时，handler 收到只读的 `[string, number]`。原生工具可以填 `['A', 12]` 或选择一份获准的完整座位 Ref。固定位置由 JSON Schema 2020-12 的 `prefixItems` 表达，`items: false` 禁止尾项。元组位置直接按业务值检查。同类数组仍允许逐项混合引用和字面值。默认值只用于说明和声明校验，缺席的可选键在调用中仍然缺席。

## 投影与资源

Preact 用 `prepareProjection(update)` 等待同步回调排入的渲染。实际提交会更新完整页面、Ref 和工具绑定。设置相同值等更新若跳过本 App 的渲染，已有健康帧时返回该帧的 `sourceEpoch`，无需发布页面。首次没有成功帧、仍有投影故障或 App 已关闭时会返回对应错误。只需交付业务结果的工具直接返回 `ToolResult`。

新开页用 `prepareOpeningProjection(update, revert)`，成功需要本 App 真正产生提交。新增页被本地容量限制拒绝时，框架调用一次 `revert` 并核对是否恢复原投影。恢复也失败时，`AggregateError.errors` 依次保留容量拒绝和恢复错误。普通 TypeScript 用稳定的 `createView` handle，在 `render` 返回正文、Ref 和 context，提交时提供全部打开页。下一次成功观察确认模型可见。业务已写入而投影失败时，保留真实写入结果，从当前业务状态修复页面。

App 可用 `useAppLifecycle` 或 `registerCleanup` 登记清理。 [Preact 声明](dist/index.d.ts) · [普通 TypeScript 声明](dist/app.d.ts)

## 由 App 主动保存和读取

在 App 配置中设置 `persistence: true`。普通 TypeScript 从初始化上下文取 `persistence`，Preact 从 `useAppRuntimeContext()` 取得。下例的 `store` 就是该端口。在两个独立的业务动作里使用它。

```ts
await store.save('draft', draftText);
const previous = await store.load('draft');
```

`await save` 在后端确认成功后返回。保存时捕获 JSON，之后修改原对象需要另一次保存。`load` 只在确认缺键时返回 `undefined`，`null`、`false`、`0` 和空字符串原样返回。App 决定是否采用读回的值，用自己的状态更新入口刷新 View。`remove(key)` 明确删除一个键。三个方法都可用最后一个参数 `{ storageKey }` 选择独立空间。失败时 Promise 拒绝并给出 `code`，包括无法确认已发出写入的 `UNKNOWN_OUTCOME`。

需要等待批量提交时调用 `flush()`，它捕获当时已受理的操作并返回各键和版本的结果。单次已确认的 `save` 或 `remove` 即已完成。页面打开、重画和结束只处理 App 主动发起的存取。App 也可以选择在既有异步清理回调中等待一次保存。
