# @aotui/sdk

为 Agent 编写 AOTUI App。App 持有业务状态，View 展示当前状态，Tool 发起操作并返回结果。一次完整提交同时交付页面、Ref 和工具能力。

## 构建第一个 App

在新的 Node ESM 项目里写一个便笺 App。示例从 `@aotui/sdk` 导入，使用 TypeScript 和普通 JSON Schema。

### 初始化作者项目

```sh
npm init -y
npm pkg set name=aotui-notes type=module aotui.app_name=notes
npm install --save-dev --save-exact typescript@7.0.2
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

## 声明页面与工具

将代码存为 `src/app.ts`。

```ts
import { createApp, createView, defineViewType } from '@aotui/sdk';

const Note = defineViewType<{ edit(text: string): void }>()({
  name: 'Note',
  multiplicity: 'single',
  region: 'dynamic',
  tools: {
    edit: {
      description: 'Replace the note, then read the current page.',
      inputSchema: {
        type: 'object', properties: { text: { type: 'string' } },
        required: ['text'], additionalProperties: false,
      },
      execute({ input, context }) {
        context.edit(input.text);
        return { success: true };
      },
    },
  },
});

export default createApp({
  app_name: 'notes', viewTypes: [Note],
  initialize({ prepareProjection }) {
    let text = 'Draft';
    const page = createView(Note, { id: 'note', render: () => ({
      body: text,
      context: { edit(next) { text = next; publish(); } },
    }) });
    function publish() { prepareProjection({ views: [page] }); }
    publish();
  },
});
```

将下方配置存为 `tsconfig.json`。

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "lib": ["ES2022"], "types": [],
    "strict": true, "exactOptionalPropertyTypes": true, "skipLibCheck": false,
    "declaration": true, "rootDir": "src", "outDir": "dist"
  },
  "files": ["src/app.ts"]
}
```

### 生成制品

```sh
npm exec -- tsc -p tsconfig.json
npm pkg set main=./dist/app.js types=./dist/app.d.ts 'files[0]=dist' 'files[1]=aoapp.json'
npm exec -- generate-aoapp .
npm pack
```

`generate-aoapp <app-dir>` 从 `package.json` 的 `aotui` 读取 `app_name` 和可选的 `whatItIs`、`whenToUse`，从包顶层读取 `version`、`description`、`main` 和 `types`。它检查入口文件并静态生成 `aoapp.json`。传给 `createApp` 的 `app_name` 须与清单一致，Worker 在启动业务前核对。将 `npm pack` 生成的压缩包交给宿主，例如在接收方运行 `npm install ./aotui-notes-1.0.0.tgz`。用工具 `edit` 传入 `{"text":"Reviewed"}`，下一次观察会显示新正文。宿主调用示例随 `@aotui/runtime` 的 README 提供。

## 页面、实例和工具

`defineViewType` 一次声明类型、实例数和工具。页面各自提供 `context`。`createView` 可指定 `static` 或 `dynamic` 区域，也可沿用类型的默认区域。类型和页面中至少有一处指定区域。

单实例默认用类型名作 ID，挂载可传 `id`，调用只填业务参数。多实例共享一组工具，调用必须填接收页面的 XML `view_id`。多实例由框架从 1 开始按 `<prefix>_1`、`<prefix>_2` 顺序编号，挂载可传 `idPrefix`，同一挂载更新或重排时沿用原 ID，同名页关闭后重开会获得新的内部实例标识。`view_type` 区分大小写，仅使用 ASCII 字母、数字或下划线且至少包含一个 ASCII 字母（如 `x_y`、`x_4`）；`id`、`idPrefix` 仅使用 ASCII 字母、数字或下划线且至少包含一个非数字字符。

收据需要引用新页面时，先成功完成 `prepareOpeningProjection`，再用初始化上下文的 `readViewId(handle)` 取得该页面在最近健康提交中的 ID。

打开且满足 `enabled(context)` 的页面让工具进入观察。页面的 `render()` 返回业务 Markdown，正文由 Runtime 的呈现入口统一包装。Root 说明业务流程。当轮 Tools 提供当前可用的工具名称、说明与 Schema。

`createView` 可声明 `onClose?: () => ToolResult | Promise<ToolResult>`。由 App 检查业务约束并提交移除该页的新投影。Runtime 分别报告回调已接受与原挂载已移除。宿主收起窗口或替换预算提示时，App 继续持有页面。

## Markdown 正文

`render()` 返回 `{ body: markdown }`。框架保留原文的缩进、换行和空白，并在模型消息边界包装 View XML。作者在正文中直接写 Markdown 表格、代码围栏和 Mermaid。

## 声明业务参数和 Ref 值

用 `ref`、`arrayRef` 和 `formatRef` 发布只读 JSON。每项都要给出 `schema`，SDK 在发布时校验实际值。`private` 只供发布页使用，`protected` 可供同一 App 实例的页面使用，`public` 还允许同一轮模型请求中可见的其他 App 取值。比如通讯录发布 `public` 邮箱数组后，邮件草稿的普通 `string[]` 参数可接收 `"$ref.contacts.list.emails"`。Runtime 按原观察取值。ArrayRef 的整体和元素共用一个登记。`refType` 标记整份业务值，`itemType` 标记数组元素。

| 页面 `app_id="notes"` `view_id="detail"` 中的标记 | 调用参数 |
| --- | --- |
| `[列表](protected items: Note[])` | `"$ref.notes.detail.items"` |
| `[首项](items[0])` | `"$ref.notes.detail.items[0]"` |

每个具名业务参数接受字面值或兼容的 Ref 地址。参数最外层或直接数组元素可以混用字面值和引用。如果字面值以一个或多个 `$` 紧跟 `ref.` 开头，就在前面再加一个 `$`。字面量 `$ref.x` 发送为 `$$ref.x`，字面量 `$$ref.x` 发送为 `$$$ref.x`。`$HOME`、`$$HOME` 和嵌套 JSON 原样交付。`refParam(refType, schema)` 适用于必须选真实已发布值的参数。handler 始终接收校验后的业务值。Runtime 绑定原观察，App 检查当前对象及外部变更。

工具的 `inputSchema` 根是参数对象。业务字段可用 `{}` 接收任意有界 JSON，也可用于数组元素和嵌套字段。Tool 对象的必填项、额外键策略和调用容量仍参与校验。为 Ref 或 `refParam` 声明值结构时，用 `type`、`enum` 或 `const` 约束根形状。如果根形状完全由 `anyOf` 给出，每个备选都要有明确形状，这条规则也适用于嵌套的备选。`{ type: 'object' }` 表示开放对象。Host 根据模型供应商的编码能力判断哪些参数能进入原生 Tools。

地址可以沿已授权的对象键和数组下标取值。以下是普通 TypeScript 通讯录的 `contacts.list` 页使用的 Ref。把 `body` 和 `refs` 随页面 `context` 一起交给 `render()` 的返回值。

```ts
import { formatRef, ref } from '@aotui/sdk';

const people = ref('people', [{ email: 'reader@example.test' }], {
  scope: 'public',
  schema: { type: 'array', items: {
    type: 'object', properties: { email: { type: 'string' } }, required: ['email'],
  } },
});
const body = formatRef('联系人', people);
const refs = [people];
```

邮件工具把 `to` 声明为字符串属性。该 Ref 对本轮可见且允许草稿页使用时，模型可传入 `{ "to": "$ref.contacts.list.people[0].email" }`，handler 收到实际邮箱字符串。`["0"]` 选择对象自有键，`[0]` 选择数组元素，`["display.name"]` 选择带点号的键。普通字段通过业务 Schema 验型。`refParam` 的来源资格限于整项 Ref 和已标记的 ArrayRef 元素。

可以直接编写 JSON Schema、使用可导出 draft-2020-12 的 Standard JSON Schema v1，或在作者项目中按需安装 TypeBox。SDK 都按 JSON Schema 2020-12 的支持子集处理，包含类型、对象、数组、固定长度的元组、`enum`、`const`、`anyOf` 和常用范围约束。工具最外层 `inputSchema` 省略 `additionalProperties` 时由 SDK 默认导出 `false`，显式传 `true` 可放行额外字段。嵌套对象遵守各自声明。框架从同一份登记派生原生 Tool 与 Console 参数。Console 与原生工具使用同样的地址和转义。模型可通过 `system-inspect_ref` 查询可见 Ref 的声明结构，并读取可见 `public` Ref 在原观察中的值。

固定位置由 `prefixItems` 表达，`items: false` 禁止尾项，`minItems` 与固定元素数量一致。原生工具可以填写完整元组或选择一份获准的完整 Ref。普通数组可以在直接元素位置混合兼容的引用和字面值。缺席的可选键在调用中仍然缺席。

## 投影与资源

用 `prepareProjection({ views })` 提交全部打开的页面。只需交付业务结果时，工具直接返回 `ToolResult`。业务已写入而投影失败时，保留真实写入结果，再从当前业务状态修复页面。

开新页时用 `prepareOpeningProjection({ views })` 提交候选。若超出本地容量，结果为 `{ status: 'rejected', issue }`，上一份健康投影仍可用。App 可以提示先关闭一页，并在成功后提交业务侧的导航变更。用 `registerCleanup({ close })` 登记关闭时的清理或显式保存。登记绑定本次 App 实例，返回 `void`。 [SDK 声明](dist/index.d.ts)

### 同一个双文件 App

目录页列出 Host 指定目录里的普通文件。可以放入 `A.txt` 和 `B.txt` 练习，打开两页后共用一个 `edit` Tool，`view_id` 选中 B 时只编辑 B。各文件页都可独立关闭。 [完整双文件 App](examples/files/author-plain.ts) · [工具声明和业务校验](examples/files/files.ts)

### 提醒 Host 关注后台事件

从初始化上下文取 `requestAttention()`。先更新业务状态并提交页面，再调用一次零参数方法。例如后台命令失败时，把退出码写入终端页，然后提醒 Host。Host 决定何时再观察。
