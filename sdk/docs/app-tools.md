# Preact 页面操作

在 `defineViewType<Context>()` 里写一次工具的名称、说明、业务 Schema 和实现。每个 `View` 传自己的 `context`，同一操作就可以读写不同页面的状态。

```tsx
import Type from 'typebox';
import { useState } from 'preact/hooks';
import { createTUIApp, defineViewType, ToolCatalog, View } from '@aotui/sdk';

const Guide = defineViewType({ name: 'Guide', tools: {} });
type CounterContext = { setCount(update: (current: number) => number): void };
const Counter = defineViewType<CounterContext>()({
  name: 'Counter',
  tools: {
    add: {
      description: 'Increase the selected counter.',
      inputSchema: Type.Object({ by: Type.Number() }, { additionalProperties: false }),
      execute({ input: { by }, context: { setCount } }) {
        setCount(value => value + by);
        return { success: true };
      },
    },
    reset: {
      description: 'Reset the selected counter to zero.',
      execute({ context: { setCount } }) {
        setCount(() => 0);
        return { success: true };
      },
    },
  },
});
const viewTypes = [Guide, Counter];

function CounterPage({ id, initial }: { id: string; initial: number }) {
  const [count, setCount] = useState(initial);
  return <View id={id} type={Counter} kind="state" context={{ setCount }}>
    <p>Count: {count}</p>
  </View>;
}

function App() {
  return <>
    <View id="root" type={Guide} kind="instruction">
      <p>Use the counter’s XML id as view_id.</p>
      <ToolCatalog />
    </View>
    <CounterPage id="counter_a" initial={0} />
    <CounterPage id="counter_b" initial={10} />
  </>;
}
export default createTUIApp({ app_name: 'counters', component: App, viewTypes });
```

两页共享一份 `counters-add` 和一份 `counters-reset`。模型调用 `add` 并传 `{ "view_id": "counter_b", "by": 1 }`，handler 收到业务参数 `{ by: 1 }` 和 B 的 `setCount`，下一次成功观察显示 A 为 0、B 为 11。调用 `reset` 时只需传接收页的 `view_id`。

工具可以在同一声明提供 `enabled(context): boolean`。SDK 在准备页面时读取该页的启用状态。已有 App 也可用元数据形式 `defineViewType({ name, tools })` 和显式 `View.bindings`。每种声明要求对应的页面属性。 [作者指南](app-authoring.md)
