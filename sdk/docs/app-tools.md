# Preact 页面操作

`defineViewType` 声明共享工具，`View.bindings` 把它们绑定到页面。每个页面的闭包读取自己的状态。

```tsx
import Type from 'typebox';
import { useState } from 'preact/hooks';
import { createTUIApp, defineViewType, ToolCatalog, View } from '@aotui/sdk';

const Guide = defineViewType({ name: 'Guide', tools: {} });
const Counter = defineViewType({ name: 'Counter', tools: {
  increment: {
    description: 'Increase the selected counter. Read its updated View.',
    inputSchema: Type.Object({ by: Type.Number() }, { additionalProperties: false }),
  },
} });
const viewTypes = [Guide, Counter];

function CounterPage({ id }: { id: string }) {
  const [value, setValue] = useState(0);
  return <View id={id} type={Counter} kind="state" bindings={{
    increment: { execute({ by }) {
      setValue(current => current + by);
      return { success: true };
    } },
  }}>
    <p>Count {value}</p>
  </View>;
}

function App() {
  return <>
    <View id="root" type={Guide} kind="instruction">
      <p>Use the counter’s XML id as view_id.</p>
      <ToolCatalog viewTypes={viewTypes} />
    </View>
    <CounterPage id="counter_a" />
    <CounterPage id="counter_b" />
  </>;
}
export default createTUIApp({ app_name: 'counters', component: App, viewTypes });
```

模型只看到一份 `Counter.increment` 工具定义。传入 `{ "view_id": "counter_b", "by": 1 }` 会更新 B，handler 收到 `{ by: 1 }`。成功提交后，下一次观察提供 B 的最新快照。
