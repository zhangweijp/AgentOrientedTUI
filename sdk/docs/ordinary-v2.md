# 普通参数 V2 合同

根入口和环境要求见 [SDK README](../README.md)，精确名称及迁移差异见 [API 状态](api-status.md)与[迁移说明](migration.md)。该合同要求匹配的 Runtime/Worker 和受信 Controller 授权。

普通写操作、只读普通参数工具和空参数只读工具都通过 `useViewTypeTool` 注册，并使用 ordinary-v2，详见 [普通 Tool 与应用清理](tool-lifecycle.md)。

单 Ref 的原始快照参数使用独立的 snapshot-value-v2 能力，见[只读快照值 Ref 参数](readonly-ref-v2.md)。

只读工具显式写 `isMutating: false`；普通参数合同标记 `ordinary-params-v1` 说明参数规则，本身不授予执行许可。SDK 不会将不支持的 V2 调用降级到 V1。

下面是完整应用示例。`findSymbolsInCurrentView` 在示例中有实际实现；使用 SDK 根入口，不需要手写 view_id。该应用读取内存符号列表，不调用外部 LSP 或文件系统。

```tsx
import { h } from 'preact';
import { createTUIApp, View, defineParams, useViewTypeTool } from '@aotui/sdk';

const symbols = ['AlphaSymbol', 'BetaSymbol', 'GammaValue'];
function Content() {
  const findSymbolsInCurrentView = (query: string, count: number) =>
    symbols.filter(symbol => symbol.includes(query)).slice(0, count);
  const [Find] = useViewTypeTool('find_symbols', {
    description: '查找当前 View 中的符号',
    isMutating: false,
    params: defineParams({
      query: { type: 'string', required: true, constraints: { minLength: 1 } },
      limit: { type: 'number', default: 20, constraints: { min: 1, max: 100 } },
    }),
  }, async ({ query, limit }) => ({
    success: true,
    data: { matches: findSymbolsInCurrentView(query, limit ?? 20) },
  }));
  return h('section', {}, [h('p', {}, 'Current symbols'), h(Find, { children: 'Find symbols' })]);
}
function Root() {
  return h(View, { id: 'symbols', type: 'Symbols' }, h(Content, {}));
}
export default createTUIApp({ app_name: 'symbol_reader', component: Root });
```

Host 使用 `interactionModes` 配置可执行模式；省略时支持 `ordinary-v2` 与 `snapshot-value-v2`。显式子集不会触发降级，实际执行仍需满足来源、Scope 与受信 Controller 授权。普通 Hook 在缺少 Runtime ordinary-v2 端口或 fingerprint 函数时明确抛出 `ORDINARY_PARAMETERS_UNSUPPORTED`，包括 enabled=false 时。

## 声明、类型与提交

普通 Tool 选项为 `description`、`params`、`isMutating?`、`additionalProperties?` 和 `target?`；`enabled` 放在第四个 `config` 参数中。参数缺省闭合，未知字段拒绝；显式 `additionalProperties: true` 时保留额外 JSON 字段。`enabled` 缺省为 true；false 释放当前绑定并隐藏 Tool，但不跳过声明及 Runtime 能力检查。

支持string、有限number、boolean、浅层JSON object、字符串enum，以及四种普通itemType的数组。enum必须有非空无重复字符串options，输入原本必须是string；array必须指定string/number/boolean/object的itemType。约束按类型区分，字符串按Unicode code point计数，数组输出minItems/maxItems；pattern使用无flags、无隐含锚定的JavaScript RegExp，非法语法在声明阶段拒绝。没有Ref、嵌套数组itemType、integer、组合或通用Schema词汇。

default仅作为注释导出，不填值，不改变required。其值必须符合字段规则；上面示例的 `limit ?? 20` 是业务自行处理缺失。框架不会转换类型、删除额外字段或展开Ref。handler参数递归只读且实际深冻结；需要可变副本时自行复制。类型复用基础InferArgs；类型层不验证任意JSON、正则语法、范围可满足性或所有default约束，Runtime在开发与生产环境都检查。

渲染阶段的fingerprint仅用于判断变化。Runtime在实际注册提交中编译一次B1合同，该同一对象生成公开带标记Schema，并交给私有factory创建SDK校验入口。提交前改写对象时，以提交实际捕获为准；提交后无render的外部修改不影响旧合同。下一次实际提交的类型、约束、required、default、描述、开闭变化会撤销旧绑定，同等键序不会无谓重绑。

handler读取目标View最新已提交状态，不在render期间发布候选逻辑。业务资源目标并不自动成为受保护句柄；应用改变目标时仍需显式换View/重绑，并在资源层完成权限及条件检查。只读声明也不是恶意应用JavaScript或OS资源沙箱。

## 调用与失败边界

Host从观察到的相同profile恢复B1合同，先验证，再执行policy。授权后继续复核原来源。V2请求使用 `VIEW_TOOL_INVOKE_ORDINARY_V2`，响应使用 `VIEW_TOOL_INVOKE_ORDINARY_V2_RESPONSE`，mode准确为ordinary-v2。Worker同步复核实例、观察目标、当前绑定、完整公开合同和私有V2资格，随后直接进入SDK helper；helper用Runtime交付的捕获合同再次检查后才调用handler。公开标记本身不授予执行资格，legacy handler也明确拒绝旁路。

普通参数不合法时不授权、不派发、不进入handler。非JSON请求可能在更早的请求捕获阶段直接refused；进入ledger后拒绝则保留现有not-dispatched/rejected。Worker/SDK进入前拒绝用not-entered与受控E_INVALID_ARGS，不回显参数、未知字段或原始异常。

成功、业务success:false、抛异常和不可信终态继续使用既有结果映射。特别是：有效的entered-returned业务失败若没有应用的副作用声明，Core可能给出带原OperationResult的业务unknown；它不等于传输损坏，健康Worker仍可复用。损坏或丢失的相关终态则沿既有单向transportUncertain处理，不能把unknown解释为未发生副作用。

## 容量与环境前提

以下均为工程容量限制，并非产品性能或任意输入可执行的充分保证：

| 层次 | 深度 | 节点 | 近似及canonical字节 |
| --- | --- | --- | --- |
| B1原始声明 | 24 | 5,000 | 近似64KiB；原始DSL没有新增canonical限制 |
| B1规范化Schema | 24 | 5,000 | 64KiB |
| 带标记外层描述捕获 | 48 | 10,000 | 近似128KiB，同时仍须满足内层B1限制 |
| B1参数模块 | 24 | 10,000 | 128KiB |
| 默认Host普通调用的必要输入上限 | **24** | **5,000** | **128KiB**；还需同时满足请求、消息、来源和Schema等条件 |
| 通用完整IPC消息 | 50 | 32,000 | 512KiB；不提高args/Core限制 |

默认调用是B1与既有Core ordinaryInput（depth32/nodes5000/128KiB）的交集；显式降低的Core配置仍适用。本次不扩大Core、B1或消息预算，不在SDK重复节点计数。JSON根值、对象/数组容器及元素值均计节点，键不单独计节点。例如 `{flags:Array(4998).fill(true)}` 共5000节点；4999个元素共5001节点，虽可通过纯B1，实际默认Core会在policy和派发前以ACTION_INPUT_INVALID拒绝。

严格JSON捕获拒绝getter、隐藏/symbol属性、类、循环、稀疏数组、非有限数等。成功值分离原型并将-0规范为0，不保留JavaScript引用身份；不保证隔离恶意Proxy trap或灾难正则。所有字节检查沿用既有helper。

纯合同/profile不依赖Node、DOM或模型模块，但既有JSON helper需要标准 **TextEncoder**。生产Host/Worker还需要各自平台能力；只读neutral bundle实验不构成完整跨平台、Edge或独立分发证明。该实验入口没有stable承诺；安全Ref的新普通参数规则、其他公共 API 与跨平台范围各依其证据；完整 IDE 当前入口和关闭合同见 tool-lifecycle 与 IDE 的 SCOPED_IDE.md。
