# View 声明、正文与呈现

每个 View 显式声明三个独立字段：`id` 标识 App 内的页面实例，`type` 指定共享 Tool 的页面类型，`kind` 为 `instruction` 或 `state`。三项均必填；类型不从实例 ID 推导，类别不扫描正文、后代 DOM 或 `data-role`。`name` 是可选展示名称，省略时沿用实例 ID。

```tsx
import { View } from '@aotui/sdk';

export function Pages() {
  const fileText = '    first line  \n<view id="literal">file text</view>\n```\n';
  return <>
    <View id="guide" type="Guide" kind="instruction" name="Usage">
      <p>Open a file, then read its current FileDetail page.</p>
    </View>
    <View id="file_a" type="FileDetail" kind="state" name={'File: A > B & "C"'}>
      <pre><code class="language-text">{fileText}</code></pre>
    </View>
  </>;
}
```

在 `createTUIApp` 的组件中使用这些页面。View 是独立兄弟节点，普通组件可以嵌套，View 不能嵌套。同类型多个 View 仍共享一组 AppTools；`kind` 不改变工具授权、业务目标或 Ref 所有权。Root 使用说明通常声明为 `instruction`，工作对象和当前业务数据声明为 `state`。修改正文不会改变类别。

普通 HTML 说明会转换为 Markdown，段落和列表采用既有排版规则。文件、补丁、日志和原样多行内容使用 `<pre>`，可选 `<code>` 指定语言；不要为了框架自行 trim、预转义或拼接 `<view>`。框架保留 pre 内的空白、换行和字面标签，并选择比正文中反引号更长的代码围栏。行内 `<code>` 同样使用不会被内容关闭的分隔符；需要逐字保留多行内容时使用 pre。

## 普通 TypeScript 作者

通过 `@aotui/sdk/app` 的 `createApp` 提交完整 App。View 提供 `id`、`type`、`kind`、可选 `name` 和 Markdown `body`，Ref 可随同一帧提交。Runtime 创建和验证真实 View 实例身份。普通 TS 与 Preact 共用发布、观察和调用合同。 [两种完整 App 与 Host 启动](app-authoring.md)

## 唯一包装与 XML 文本

Snapshot 的 Markdown 是未包装、未做 XML 转义的正文。Adapter 消费已观察的元数据，在 Runtime 的唯一消息边界生成 `<view id="…" type="…" kind="…" name="…" app_id="…" app_name="…">`，正文和 Ref 提示按 XML 文本转义一次：`&`、`<`、`>` 分别为 `&amp;`、`&lt;`、`&gt;`，回车 CR 编码为 `&#13;`，防止 XML 消费将 CRLF 或独立 CR 规范化为 LF；原有 LF 保留。字面 `</view>` 只能作为正文文本，不能关闭框架 envelope；原文中的 `&lt;` 解码一次后仍是原来的字面 `&lt;`。

模型看到 XML + Markdown 的 User Message；Host 预览在识别外壳后解码一次，恢复原 Markdown。围栏内容、缩进和首尾空白保留。呈现端不根据正文猜测已有 envelope，也不删除正文中合法的标签。App 只提交业务内容，不负责补包装或恢复被截掉的文本。

从旧作者接口迁移见 [迁移说明](migration.md)。这些格式约束不替代业务授权，也不表示任意正文已成为可信指令。

ViewType 由 `<View type="…">` 显式声明。普通组件仍可嵌套，View 只能作为独立页面；合并内部组件接线不改变挂载身份、Ref 所有权或卸载行为。
