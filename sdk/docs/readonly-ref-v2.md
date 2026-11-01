# 只读快照值 Ref 参数

通过唯一 View-local Hook `useViewTypeTool` 声明只读快照值 Ref。执行需要支持 snapshot-value-v2 的 Runtime/Worker，并经过受信 Controller 的来源检查与授权。

参数可以包含普通字段和一个必填、顶层的对象 Ref。调用输入中的 Ref 是页面展示的字符串 ID，handler 收到原始观察快照中的递归只读 JSON 对象；普通字段使用 ordinary-v2 规则。

下面是完整应用，所有SDK能力从根入口导入。`useDataRef`发布当前值并显示引用；工具不修改数据，结果指向已有详情View。Root只列出实际挂载的View及工具。

```tsx
import { h } from 'preact';
import { createTUIApp, View, useDataRef, useViewTypeTool } from '@aotui/sdk';

function FileDetail() {
  const file = useDataRef('sample_file', {
    title: 'Example file',
    lines: ['First line', 'Second line'],
  });
  const [Inspect] = useViewTypeTool('inspect_file', {
    description: 'When to use: inspect a displayed file value. How to use: provide its Ref ID and choose summary or full.',
    isMutating: false,
    params: {
      file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' },
      format: { type: 'enum', options: ['summary', 'full'], required: true },
    },
  }, ({ file, format }) => {
    const title = typeof file.title === 'string' ? file.title : 'Untitled';
    return {
      success: true,
      data: { view_id: 'detail', title, format, keys: Object.keys(file) },
    };
  });
  return h('section', {}, [
    h('h2', {}, 'Example file'),
    h('p', {}, file('Original file value')),
    h(Inspect, { children: 'Inspect file' }),
  ]);
}

function App() {
  return h('main', {}, [
    h(View, { id: 'root', type: 'Root' }, [
      h('h1', {}, 'File Inspector Application Instruction'),
      h('h2', {}, 'What File Inspector is'),
      h('p', {}, 'Inspect values displayed in File Detail.'),
      h('h2', {}, 'How to use File Inspector'),
      h('p', {}, 'Use the displayed reference with inspect_file and read its result.'),
      h('h2', {}, 'Views of File Inspector'),
      h('h3', {}, 'File Detail'),
      h('h4', {}, 'File Detail Instruction'),
      h('p', {}, 'Displays the current file value and its reference.'),
      h('h4', {}, 'File Detail Available Tools'),
      h('p', {}, 'inspect_file'),
    ]),
    h(View, { id: 'detail', type: 'FileDetail' }, h(FileDetail, {})),
  ]);
}

export default createTUIApp({ app_name: 'file_inspector', component: App });
```

本例使用 `useDataRef` 的实际unknown业务类型，所以没有声明具体refType。handler把对象字段视为unknown并检查类型；refType不提供业务结构推断。声明具体refType时，原Ref描述符必须严格匹配；Ref必须属于原目标View实例，且payload是非null、非数组的普通JSON对象。

`SnapshotValueRefParamDef`、`TypeToolArgs` 与 `DeepReadonly` 已从 SDK 根入口导出。Ref 要求 `required: true`、`refSource: 'snapshot-value-v1'`，不允许 `default`、`constraints`、`options` 或 `itemType`。恰好一个 Ref 由 Runtime 编译保证。Ref Handler 参数递归只读；普通只读 Tool 的参数也有递归只读类型。`default` 只是声明注释，不补值、不转换类型、不 trim 或删除额外字段。默认拒绝额外参数，显式 `additionalProperties: true` 可保留。

Host 使用 `interactionModes` 配置可执行模式；省略时包含 `snapshot-value-v2`，也可显式配置子集。`refSource: 'snapshot-value-v1'` 与公开 `snapshot-value-params-v1` 都是来源/参数语义标记，不是 V1 transport。单有声明或端口支持不能执行。应用作者无需管理 observationId 或 Worker 身份；Controller 负责观察、绑定、授权和调用。旧 SDK/Worker 组合不会自动获得此能力。

完整参数与展开payload受24层、10000节点及128KiB约束，最终执行还受Core请求、Ref envelope、Snapshot和整IPC的交集限制。类型检查或单次参数验证不证明来源或权限，也不替代实际Worker资格。

## Worker Snapshot 捕获与恢复

Worker 发出 Snapshot 前会把完整 Draft 复制为有界的严格 JSON 数据；复制不会冻结或修改应用拥有的 Ref 对象。捕获最多接受 48 层、100,000 个节点和默认约 8 MiB 的近似输入字节。Ref payload 必须是无 getter/隐藏字段、无 Symbol、循环或类实例的普通 JSON 对象。此复制只约束 IPC 前的数据形状和捕获成本，不代替完整 V2 校验；Host 收到后仍检查结构、Ref/View 归属关系，并核算规范化后的精确序列化字节总量。

无法复制的数据会产生 `SNAPSHOT_SERIALIZATION_ERROR`，并使当前 Snapshot 来源进入 degraded 状态；Runtime 不会把失败的 Draft 发布为当前状态。应用修正 Ref 数据后，下一份有效 Snapshot 会恢复 ready。`auto` 在变化时自动发布并通知 Host；`never` 在变化时自动发布但抑制通知；`manual` 不自动发布后台变化，Tool 调用会提交当时的投影。信号策略不会放宽 JSON 校验。
