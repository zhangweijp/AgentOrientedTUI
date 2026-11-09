# 普通 TypeScript 的 Tool 绑定

可运行的业务实现见 [file-controller.ts](examples/file-controller.ts)，验证入口见 [包使用说明](runtime-compatibility.md)。宿主提供真实端口和页面发布；App controller 只管理自己的业务状态及绑定。

静态 ToolSet 描述能力；`createToolBindings` 将它绑定到一个 App 的 `IAppTypeToolPort`。两个 App 可共用同一 ToolSet，各自拥有 handler、enabled 和清理资源。两者不共享业务状态。总入口与 `@aotui/sdk/tools` 指向同一实现、品牌表和 owner 表。

```ts
import Type from 'typebox';
import { createToolBindings, defineToolSet, defineViewTypeTool } from '@aotui/sdk/tools';
import type { IAppTypeToolPort, ToolResult } from '@aotui/runtime/spi';

const tools = defineToolSet({
  editFile: defineViewTypeTool({
    viewType: 'FileDetail', name: 'edit_file',
    description: 'Edit an opened file; read its updated View.',
    inputSchema: Type.Object({ filePath: Type.String(), content: Type.String() },
      { additionalProperties: false }),
  }),
});

// 普通 TS Producer 从既有 Runtime 上下文接收 port；不自行构造私有 AppKernel。
export function bindFileTools(
  appTypeTools: IAppTypeToolPort,
  editOpenedFile: (filePath: string, content: string) => ToolResult | Promise<ToolResult>,
) {
  const bindings = createToolBindings({ definition: tools, appTypeTools });
  bindings.commit({ editFile: { execute: args => editOpenedFile(args.filePath, args.content) } });
  return bindings;
}
```

参数类型完全由 definition 的 Schema 决定，`ToolBinding` / `ToolBindings` / `ToolBindingController` 可显式标注。commit 接收完整映射，拒绝缺项、多项（包括变量中的多余键）、过窄参数和非法 enabled。disabled 仍需 handler。函数必须适用声明的所有合法输入；enabled 省略为 true，显式 undefined 不合法。

`ToolBindingController<Map>` 对声明 Map 不变：宽 Schema 的 controller 不能赋给窄 Schema 的 controller，反方向也不支持。controller 始终代表创建时的那份声明，不作为另一个 Schema 的适配器。同 Map 的变量赋值、跨模块参数/返回和 root/tools 传递正常；单个 handler 接受比声明更宽的参数仍可安全使用。

该不变性由公开类型表达，不增加业务状态。App 直接使用相同声明推导 controller，不做跨 Schema 强转。

创建 controller 不注册、不占用 owner、不执行业务函数；构造时即验证 port 的 `view-type-tools-v4` 合同，即使以后所有成员都 disabled。端口可为普通对象或类实例，protocol/method 必须可从数据描述符读取，不接受 getter。创建时固定 ToolSet 与 port；换集合或端口需 dispose 后新建。

commit 的 prepare 先通过 own property descriptors 捕获完整候选，拒绝 getter，不写 registry。前置失败不替换旧 handler 或注册。首次进入 registry 提交阶段才取得该 port 的 owner；第二 controller 即使全部 disabled 也会被拒绝。ToolSet 本地键不进入 wire，注册只传 viewType、name、description、inputSchema。

commit 同步完成注册协调与 handler frame 替换。enabled 持续为 true 时保留 release handle、注册与 activation，只替换函数引用。true → false 释放注册；false → true 新建身份，旧资格不会复活。同类型多个 View 共享一组 Tool；最后一个匹配 View 关闭后类型不再激活，重开产生新的 activation。catalog 与这些动态变化无关。

执行使用 Runtime 的 `view-type-parameters-v1`，保留只读 JSON 与 entered/not-entered 语义；Ref 参数先从绑定 Observation 展开，再把同一份 effectiveInput 用于授权和 handler。注册中、关闭中、failed/disposed 的 controller 不允许新 handler 进入；参数捕获后、业务函数进入前再次确认当前注册与提交 frame。正在 await 的调用持有其进入时的函数，不随后续 commit 改换；dispose 不撤销已经发生的业务副作用。

## 提交失败与清理

registry 更新一旦失败，本 controller 立即 fail-closed：清空候选和已提交 handler 引用，尝试清理本 owner 的所有注册，不恢复旧 frame，也不回滚其他 App。release 抛错仍继续处理余下 handle。

清理全部确认且 register 已返回后，按 token 释放 owner；失败 controller 不能再次 commit，应显式新建。尚未确认释放的 handle 和 owner 留存，后续 `dispose()` 重试。清理失败会抛 `TOOL_BINDING_CLEANUP_FAILED`，不能当作资源已释放。旧 controller 的 dispose 无法释放继任 owner。

`dispose()` 可重复调用。cleanup 内重入 dispose 不启动第二轮清理。在 register/release 或 prepare 尚在栈内时发生 dispose，会立即禁止执行，清理由外层同步操作接管；迟到 handle 返回后也必须释放。重入调用的返回不表示外层注册已结束。commit/handler 在 registry 更新阶段的重入会被拒绝；业务 handler 已正常进入后，可以同步 commit 一个完整的新 frame。

## 结构化且有界的诊断

操作错误有可读取的 `error.code`。`TOOL_BINDING_CLOSED` 覆盖 prepare、release、register 期间关闭；这些路径不只把名称写在 message。`error.diagnostics` 分别提供：

- `original`：原始提交/注册异常的 name、message、可选 code 和 truncated。
- `cleanupErrors`：本次最多 8 项具体工具键与清理异常摘要。
- `cleanupFailureCount` 和 `omittedCleanupFailures`：本次所有失败与未展开数量。

`TOOL_BINDING_DIAGNOSTIC_LIMITS` 给出固定界限：异常 name/code、工具键各 64 个 UTF-16 code unit，message 256 个，cleanup 摘要最多 8 项。只读取数据描述符，不调用异常 getter；不可读字段给出有限说明，不保留任意 raw Error、stack、cause 或业务对象。清理未完成期间保留有界原始摘要，重试错误仍能看到根因；清理完成后释放。摘要、条目和列表冻结；数量限制不减少实际清理尝试。

其他主要 code：`TOOL_BINDING_INVALID`（候选形状）、`TOOL_BINDING_PORT_INVALID`（端口合同）、`TOOL_BINDING_OWNER_CONFLICT`（重复 owner）、`TOOL_BINDING_UNAVAILABLE`（不合法状态或重入）、`TOOL_BINDING_COMMIT_FAILED`（registry 失败但本 owner 清理成功）。诊断属于本地 SDK 控制接口，不增加 Runtime wire 错误协议。

## 与 Producer 的边界

controller 管理 ViewType Tool 的绑定，包括带 Ref 参数的工具；不拥有业务 owner、View、Ref、Observation、Scope 或 projection。普通 TS Producer 在既有同步提交/发布边界内调用 commit，协调后再发布。这里不提供 View/Ref/Tool 全事务，也不保证 handler promise 返回时新的 View 已可观察。

当前组件与普通 TS 入口复用同一 controller、品牌和 owner 状态。Ref 参数也使用 refParam 与这一绑定入口；没有独立 Snapshot Tool Hook。纯入口不加载 Preact／DOM／Worker 实现，但安装仍有 Preact peer，声明仍使用 DOM ambient 类型。
