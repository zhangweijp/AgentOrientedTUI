# Preact 的 AppTools 绑定

静态 definition 只描述能力。一个 App 在共同祖先使用一个 `AppTools`，集中提供本实例的 handler 与 enabled。普通组件和 View 可以作为其后代；View 之间必须独立，不能嵌套。

下面是绑定组件片段；完整托管应用与运行命令见文末链接。

```tsx
import Type from 'typebox';
import { AppTools, ToolCatalog, View, defineToolSet, defineViewTypeTool } from '@aotui/sdk';

const tools = defineToolSet({
  edit: defineViewTypeTool({
    viewType: 'FileDetail', name: 'edit_file', description: 'Edit an opened file.',
    inputSchema: Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false }),
  }),
});

export function FileApp({ editOpenedFile, opened }: {
  editOpenedFile: (path: string, content: string) => void;
  opened: boolean;
}) {
  return (
    <AppTools definition={tools} bindings={{
      edit: { enabled: opened, execute: args => {
        editOpenedFile(args.path, args.content);
        return { success: true };
      } },
    }}>
      <View kind="instruction" id="root" type="Root"><ToolCatalog definition={tools} /></View>
      {opened && <View kind="state" id="file" type="FileDetail"><p>The file is open.</p></View>}
    </AppTools>
  );
}
```

业务函数负责对象选择、权限与前置条件，正文通过对应 View 呈现。示例的回执不表示投影已经被 Host 观察到。实际应用通过 `createTUIApp` 托管该组件；普通应用不直接构造私有 Context 或 Runtime port。

bindings 的参数由 definition 单向推导，拒绝缺项、多项（含变量或 spread）、非法 enabled 和过窄 handler。enabled 缺席为 true；提供时必须是 boolean；disabled 仍需 handler。静态 definition 禁止 execute，函数只属于实例 bindings。

render 捕获候选绑定；layout commit 才同步更新 Registry，并与现有 projection begin/end 配对。如果后代在渲染时抛错且错误传播到 AppTools，本次候选失效，错误继续交给外层边界处理。备用页面提交前仍按上一帧的 handler 和 enabled 执行。handler-only 更新保留注册身份；禁用后旧资格失效，重新启用产生新身份。同类多个 View 共享注册。

ToolSet 和 App port 在 AppTools 存续期间固定。更换必须先显式卸载再挂载（例如更换 key）。第二个 owner 即使全部 disabled 也被拒绝。卸载只清理本 owner；清理失败保留未确认 handle，SDK renderer 的后续 unmount 或绑定提交会重试。失败的 controller 不恢复提交；资源确认清理后可以显式重挂新 owner。清理错误保留有界诊断、失败总数和省略数。SDK 仅在旧树尚待清理时记录其容器和 App Tool 端口。首次初始化失败、调用方拿不到 renderer 时，再次初始化同一容器或端口会先重试旧树清理。如果释放仍失败，本次初始化直接报告该错误。Preact 已移除 DOM 后，即使投影收尾抛错，旧 renderer 再次卸载也只处理自己待释放的资源。App 的 `useAppLifecycle` 仍由应用持有。

`ToolCatalog` 复用 getToolCatalog，表达“已定义能力”。它不读取 handler、enabled、当前 View 或业务对象数量，不代表可执行工具清单。将其放在 Root，按 ViewType 简要呈现工具名，不呈现说明或 Schema。完整合同由 Context Tools 提供；数据 View 呈现状态与 Ref，不重复工具目录。目录稳定不表示整个 instruction View 永远不变。

完整的打开、更新、关闭示例见 [文件 App](examples/file-app.tsx)。运行与匹配包见 [包使用说明](runtime-compatibility.md)。
