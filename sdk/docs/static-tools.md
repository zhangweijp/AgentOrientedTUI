# 静态 ViewType 与工具目录

`defineViewType` 由 `@aotui/sdk/app` 和 Preact 根入口共享。静态元数据在声明时就可用于工具目录。工具执行时收到接收页已提交的 `context`。

```ts
import Type from 'typebox';
import { defineViewType, getToolCatalog, type ArgsOf } from '@aotui/sdk/app';

type FileContext = { replace(text: string): void };
export const FileDetail = defineViewType<FileContext>()({
  name: 'FileDetail',
  tools: {
    edit_file: {
      description: 'Edit the selected file and read its updated View.',
      inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
      execute({ input: { text }, context: { replace } }) {
        replace(text);
        return { success: true };
      },
    },
  },
});
export type EditArgs = ArgsOf<typeof FileDetail.tools.edit_file>;
export const catalog = getToolCatalog([FileDetail]);
```

工厂在 `viewTypes` 中登记 descriptor。相同类型的多个页面复用它。不同类型可以使用相同工具名。SDK 捕获并冻结声明，构造目录时生成要求 `view_id` 的模型 Schema。同一 App 内的类型名必须唯一。

目录用于文档、Root 说明与类型检查。托管 Preact App 内的 `<ToolCatalog />` 从工厂注册的 `viewTypes` 列出名称，在该类型暂时没有打开的页面时也会列出。也可以传 `<ToolCatalog viewTypes={selection} />` 指定列表，在托管 App 外使用时必须传该列表。运行时的原生工具可用性由当前页面的绑定决定。

无业务参数的工具可以省略 `inputSchema`。没有工具的页面类型用 `defineViewType({ name })`。 [Preact 页面操作](app-tools.md)
