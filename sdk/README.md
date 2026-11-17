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

## View、Tool 和 Ref

- 每页显式声明 `id`、`type` 和 `kind`（`instruction` 或 `state`）。View id 在同一个 App 内唯一，使用 ASCII 字母、数字或下划线。声明并列页面，提供原始内容，由 Host 包装 XML 并转义。Preact 的 `pre` 和 `code` 可呈现要求保留空白的内容。
- Tool 在 ViewType 中声明一次，每个实例交自己的 `context`。至少有一个实例打开且启用时，共享 Tool 才进入可调用目录。可用 `enabled(context)` 提供实例条件。框架在模型 Schema 中加入必填 `view_id`，handler 收到选中页的 context 和业务输入。Root 可用 `<ToolCatalog />` 简列名称，完整定义由模型请求的 Tools 提供。
- 用 `useDataRef` 或 `useArrayRef` 发布模型可选的业务数据，Tool 用 `refParam` 声明目标。例如在 `detail` 页展示 `[First note](Note:notes[0])`，调用传 `detail.notes[0]`。地址可选同一 App 实例的原 Observation 中另一页的 Ref。Runtime 解析为深只读 JSON 值，App 判断对象是否仍存在、归属是否正确、业务条件与权限是否满足。
- 业务参数用 TypeBox 对象 Schema。无参数时可以省略声明。Runtime 支持有界的 JSON 参数和顶层 Ref 参数，声明期会指出不支持的关键词位置，例如 `pattern`。业务格式校验和外部副作用由 App 处理。

## 准备页面与保存

`useAppRuntimeContext()` 的 `prepareProjection(update)` 等待本次实际渲染完成。对可撤回的开页，用 `prepareOpeningProjection(update, revert)`，保留原页面挂载，容量拒绝时恢复导航。Host 提供 `projectionLimits` 帮助选择初始内容和分页大小，是否容纳取决于完整候选的准备结果。准备成功描述 App 的本地投影，Host 的下一次成功观察确认可见性。若业务已写入但投影失败，收据应保留真实的写入结果并提示呈现故障，再用当前业务数据修复 View。

普通 TypeScript 用 `@aotui/sdk/app`，可省去 Preact。用 `createApp`、`createView` 和 `defineViewType`，保留稳定的页面 handle。在 `render` 返回 Markdown、`context` 和 Ref 描述。通过 `prepareProjection({ views })` 提交全部打开页面，或用 `prepareOpeningProjection({ views })` 准备可放弃的开页，成功后确认导航。用 `ref`、`arrayRef` 和 `formatRef` 发布并呈现 Ref。

需要框架保存小型 JSON 状态时，在工厂中设 `persistence: true`。若收据承诺数据已保存，先等待并检查 `persistence.flush()`。用 `useAppLifecycle` 或普通 TypeScript 的 `registerCleanup` 登记 App 自己的资源清理。

已安装包的声明入口为 `dist/index.d.ts` 与 `dist/app.d.ts`。在仓库中可查看 [Preact 作者入口](src/index.ts)、[普通 TypeScript 作者入口](src/app.ts)和[可执行 App 试件](tests/fixtures)。
