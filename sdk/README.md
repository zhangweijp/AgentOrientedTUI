# @aotui/sdk

为 Agent 构建 AOTUI App。App 持有业务状态，View 呈现当前状态，Tool 发起操作并返回收据。SDK 将准备好的页面、Ref 和操作一起交给 Runtime。

## 构建第一个 App

使用同一交付的 SDK 0.9.0 和 Runtime 8.0.0，以及 `typebox@1.4.3`。升级时用同批 SDK 重编 App，并重新生成 `aoapp.json`。默认作者入口是 `@aotui/sdk`，使用 `preact@10.29.1`。App 与 SDK 必须解析到同一个 Preact 模块实例。打包时将 Preact 及其子路径设为 external。

将两个 tar 的绝对路径分别设为 `aotui_runtime_tar` 和 `aotui_sdk_tar`。在新的 App 目录安装依赖，使用 Node ESM。

```sh
npm init -y
npm pkg set type=module
npm install "$aotui_runtime_tar" "$aotui_sdk_tar" typebox@1.4.3 preact@10.29.1
npm install -D typescript@7.0.2
```

保存为 `app.tsx`。调用 `add` 时传入 `{ "view_id": "counter", "by": 1 }`。收据只报告操作结果，下一次成功观察显示新的计数。

```tsx
import Type from 'typebox';
import { useState } from 'preact/hooks';
import { createTUIApp, defineViewType, View } from '@aotui/sdk';

const Counter = defineViewType<{ add(by: number): void }>()({
  name: 'Counter',
  tools: {
    add: {
      description: 'Increase the counter, then read its View.',
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
  return <View id="counter" kind="state" type={Counter}
    context={{ add: by => setCount(value => value + by) }}>
    <p>Count: {count}</p>
  </View>;
}

export default createTUIApp({ app_name: 'counter', component: App, viewTypes: [Counter] });
```

```sh
npx tsc --module NodeNext --target ES2022 --strict --jsx react-jsx --jsxImportSource preact --outDir dist app.tsx
```

按照 `@aotui/runtime` 包内 README 运行 `dist/app.js`。App 分发时可用 `AppRegistry` 安装带 `aoapp.json` 的目录。仓库中的 `scripts/generate-aoapp.mjs <app-dir>` 从编译后的默认工厂与包元数据生成清单。

## 页面与实例工具

每页显式声明 `id`、`type` 和 `kind`（`instruction` 或 `state`）。View id 在同一个 App 内唯一，使用 ASCII 字母、数字或下划线。页面并列声明，正文不带框架的 XML 外壳；最终呈现边界负责包装和转义一次。Preact 的 `pre` 和 `code` 可呈现需要保留空白的内容。

用 `defineViewType<Context>()` 将工具名称、说明、业务参数和实现声明一次。每个 View 实例提供自己的 `context`，handler 通过 `execute({ input, context })` 使用所选页的业务状态、函数和服务。框架自动向模型 Schema 加入必填 `view_id`，消费它并校验接收页；作者不重复声明，业务 `input` 不包含该路由字段。

至少有一个页面打开且满足 `enabled(context)` 时，对应共享 Tool 才激活。同类型页面共用 Schema，但各有执行上下文；共享 Tool 仍存在，不代表已关闭的页面还能调用。Root 可用 `<ToolCatalog />` 简列名称和流程，完整说明与参数 Schema 进入当轮请求的 Tools。静态名称目录不能代替实际工具可用性。声明与类型见 [ViewType 实现](src/tools/view-type-tool.ts)。

## Ref 与参数

Preact 用 `useDataRef`、`useArrayRef` 发布数据；普通 TypeScript 用 `ref`、`arrayRef` 和 `formatRef`。Tool 用 `refParam` 声明接受的业务类型和目标值 Schema，handler 收到已解析的深只读值，无须让模型抄写内部业务 ID。

把 Ref hook 放在 `<View>` 渲染的内容子组件里。返回 `<View>` 的函数自身无法读取它提供的作用域。

```tsx
const FilesType = defineViewType({ name: 'Files' });
type File = { path: string };

function FilesPage({ files }: { files: readonly File[] }) {
  return <View id="files" type={FilesType} kind="state"><FilesContent files={files} /></View>;
}

function FilesContent({ files }: { files: readonly File[] }) {
  const [allFiles] = useArrayRef('items', files, { itemType: 'File' });
  return <p>{allFiles('全部文件')}</p>;
}
```

| `id="detail"` 页面内的展示 | 显式 Ref 参数中的调用地址 |
| --- | --- |
| `[First note](Note:notes[0])` | `detail.notes[0]` |
| `[All notes](Note[]:notes)` | `detail.notes` |

展示标记带类型和局部名称，调用地址不带 `Note:`。顶层 `view_id` 选择执行页面，Ref 前缀选择数据来源页；可以从同一 App 运行实例、同一原 Observation 的另一页取 Ref。View id 和 Ref 局部名称禁止点号 `.`，普通文件路径和业务文本不受这条地址规则限制。Runtime 保持原观察值；对象是否仍存在、归属、权限及外部冲突由 App 判断。数据为只读观察值，App 仍可通过合法操作发布新值。[Ref 格式与捕获](src/app-factory/refs.ts)负责具体命名和展示校验。

业务参数使用 TypeBox 对象 Schema，无参数时可省略声明。值域为 JSON：null、布尔、有限数字、字符串、数组和普通对象；循环引用、类实例等不能作为 Ref payload。普通路径、标题和内容按原有参数输入。显式 Ref 支持顶层单值、数组多选及可选参数，整数组与元素按声明的目标值校验；没有通用嵌套 Ref 表达式或字段访问语法。

工具参数说明在固定字节内提示声明的 Ref 类型和可确认的值形状。例如，指向整组文件的参数仍填一个地址，选择多个文件的参数填地址数组。

TypeBox 可表达的范围大于当前支持子集。常用类型、对象属性、数组、`enum`、`const`、`anyOf` 及部分范围约束可用；不支持的关键词在声明期给出 code 和路径。当前拒绝 Schema 的 `pattern` 关键词，业务参数名仍可叫 `pattern`。`default` 是注释，不自动填值，也不自动转换输入类型。精确子集见仓库的 [TypeBox 导出](src/tools/typebox-schema.ts)与 [Runtime 参数编译器](../runtime/src/core/tool/tool-parameters.ts)。业务格式检查在副作用前由 App 完成。

## 准备完整投影

默认 Preact 入口中，`useAppRuntimeContext().prepareProjection(update)` 接收同步状态更新回调，等待本次实际渲染准备完成。可撤回的开页使用 `prepareOpeningProjection(update, revert)`，两个回调都同步，保留原页面挂载，开页容量拒绝时恢复导航。这是明确的导航恢复合同，业务事务和已经发生的外部写入由 App 负责。

常规准备需要该 App 产生一次真实提交。同步回调把状态设成当前值时，Preact 可能跳过提交，此时准备调用以 `SNAPSHOT_INVALID` 拒绝并给出排查提示。已记录的提交故障优先返回原诊断。准备结果和业务操作结果各自独立。

普通 TypeScript 入口 `@aotui/sdk/app` 无需 Preact。用 `createApp`、`createView` 和 `defineViewType`，保留稳定页面 handle，在 `render` 返回 Markdown、`context` 和 Ref 描述。`prepareProjection({ views })` 提供全部打开页面；`prepareOpeningProjection({ views })` 准备可放弃的开页候选，成功后再确认 App 自己的导航状态。

两种入口都只承诺本地准备，返回 `PreparedProjection`。Host 的下一次成功观察才确认新数据可观察。作者只读取得 Host 固定的 `projectionLimits`，用于选择内容和分页大小；是否容纳取决于完整候选，模型总 token 预算另由 Host 检查。一般业务更新若已写入却准备失败，收据保留真实结果和呈现恢复提示，再从当前业务数据修复 View，不能重做写入来伪装恢复。

## 持久化与清理

需要框架保存小型 JSON 状态时，在工厂中显式设 `persistence: true`；未启用的 App 不创建存储会话。暂存状态与落盘分开：收据若承诺已保存，先等待并检查 `persistence.flush()`。默认 SQLite 的原生驱动由 Host 安装，App 负责业务数据含义与迁移。

Preact 用 `useAppLifecycle`，普通 TypeScript 用 `registerCleanup`，登记 App 自己的停止与关闭清理。后台任务的进度、取消和业务恢复由 App 定义，Runtime 负责其托管调用与资源的实际结束。

## 入口与可执行例子

| 作者入口 | 仓库源码 | 仓库中的可执行例子 |
| --- | --- | --- |
| `@aotui/sdk`（默认 Preact） | [公开导出](src/index.ts) | [工作项 App](tests/fixtures/work-items-preact.tsx) |
| `@aotui/sdk/app`（普通 TypeScript） | [公开导出](src/app.ts) | [同语义工作项 App](tests/fixtures/work-items-plain.ts) |

表中链接用于阅读本仓库。安装包通过上述包入口导入，声明分别在 `dist/index.d.ts` 与 `dist/app.d.ts`；无需导入仓库源码或内部 Worker 协议。
