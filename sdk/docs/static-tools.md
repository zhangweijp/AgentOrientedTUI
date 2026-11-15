# 静态 ViewType 与工具目录

`defineViewType` 由 `@aotui/sdk/app` 和 Preact 根入口共享。类型名和工具名各声明一次，工具值只描述业务参数和说明。

```ts
import Type from 'typebox';
import { defineViewType, getToolCatalog, type ArgsOf } from '@aotui/sdk/app';

export const FileDetail = defineViewType({
  name: 'FileDetail',
  tools: {
    edit_file: {
      description: 'Edit the selected file and read its updated View.',
      inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
    },
  },
});
export type EditArgs = ArgsOf<typeof FileDetail.tools.edit_file>;
export const catalog = getToolCatalog([FileDetail]);
```

工厂在 `viewTypes` 中登记 descriptor。相同类型的多个页面复用它。不同类型可以使用相同工具名。SDK 捕获并冻结声明，构造目录时生成要求 `view_id` 的模型 Schema。同一 App 内的类型名必须唯一。

目录用于文档、Root 说明与类型检查。运行时的原生工具可用性由当前页面的绑定决定。Root 的 `ToolCatalog` 读取 descriptor 并只列出名称。[Preact 页面操作](app-tools.md)
