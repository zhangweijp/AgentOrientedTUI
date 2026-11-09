# 普通 Tool 的 TypeBox 参数合同

Tool 使用 defineViewTypeTool 声明 viewType、name、description 和 inputSchema，再由 AppTools 或 createToolBindings 绑定业务 handler。框架不分类工具是否改变业务状态；Scope授权、只读入参、effects/partial/unknown终态与清理各自保留。

TypeBox 1.4.3 是参数声明和静态类型的唯一来源：Schema 推导实例 binding 的 execute 参数类型，SDK 在定义时导出有界 JSON Schema，并调用 Runtime 的 `compileOrdinarySchema` 做早期兼容检查与规范化。Runtime 注册时会再次独立编译、捕获合同。SDK 不复制 Runtime 的参数 grammar。

## 声明与绑定

完整可执行的 [双文件例子](examples/file-app.tsx) 使用 module-scope defineToolSet 与 AppTools 的完整 bindings。静态 definition 不含 execute；处理函数只属于实例绑定。ArgsOf / SchemaOf 可跨模块保留精确 Schema 与 readonly 参数；字符串枚举用 Type.Enum，optional 用 Type.Optional。

一个 App / ViewType 只注册一组 Tool；多个同类 View 共享。ToolRef 可在匹配 View 呈现，但不参与授权、注册或业务目标选择。省略 ToolRef 不禁用能力。业务 filePath 等选择器是普通参数，由 App 重新校验目标是否仍打开、允许和当前。Host 另做授权。

## TypeBox and Runtime profile

TypeBox accepts more constructs than the executable ViewType parameter profile. The SDK does not promise that every TypeBox type can be represented. It rejects an unsupported constraint at definition time with the path from Runtime's compiler; it never silently drops a rule. Runtime repeats compilation when registering the Tool.

For `refParam`, SDK capture uses the broader `ref-value-specimen` vocabulary;
capture success is not execution support. The formal `view-type-parameters-v1`
registration in the current contract permits multiple top-level object or
object-list Refs alongside ordinary fields, including Type.Optional(refParam(...)).
Absent optional fields stay absent; invalid present values reject the call.
Arrays of Ref names use Type.Array(refParam(...)); each selected Ref resolves independently and shares the complete argument budget. Nested Ref queries and non-object payload lists remain rejected.
Do not infer an older Runtime package's supported shapes from SDK capture or the V4 header; verify the exact matching packages. All payloads share the existing
complete argument and envelope budgets.
Display markers retain their type prefix; explicit Ref inputs use view_id.local_ref, not the displayed Type: prefix. See the README for payload types and compatibility requirements.

The JSON Schema string constraint `pattern` is not supported. For example, `Type.String({ pattern: '^[a-z]+$' })` is rejected during Tool definition with the path to that Schema field. A business input field named `pattern`, such as a glob query, remains an ordinary string parameter; the property name does not add regular-expression validation.

The current Runtime profile supports an object root, string/number/boolean fields, string enums, primitive or opaque-object arrays, and the profile's documented descriptions, defaults, and scalar bounds. Array `items` only support the declared item type; put a description on the array field rather than on `Type.String()` used as its item. Nested field schemas, union/intersection, custom refinements, codecs, references and other unsupported JSON Schema vocabulary are rejected. An empty open object such as `Type.Object({}, { additionalProperties: true })` may be represented as an opaque JSON object, including as an array item.

TypeBox's `additionalProperties` behavior is preserved. If the root Schema omits the setting, the Runtime contract treats additional properties as allowed. Write `{ additionalProperties: false }` when the application wants a closed parameter object. For a nested opaque object, the open setting must remain `true`; restrictive empty objects are not collapsed into unconstrained objects.

`Type.Optional` controls the root `required` list. `Type.Readonly` is accepted as a type annotation and does not change the JSON contract. TypeBox `Refine`, `Decode`/`Encode` codecs, unknown hidden `~` metadata, getters, symbols, cycles, custom prototypes, oversized schemas and unsupported visible JSON Schema keys are refused with a bounded diagnostic. Ordinary data such as a user field named `~kind` or `default: { '~kind': 'value' }` is preserved.

The SDK captures a detached, deeply frozen normalized schema at definition time. Changing the author's TypeBox object later cannot alter an existing definition; call `defineViewTypeTool` again to declare a new contract. Equivalent schemas with fields declared in a different order normalize to the same contract.

## Runtime execution and results

Runtime validates JSON arguments before invoking the registered handler and provides recursively frozen argument data. The SDK invokes the latest committed application handler. Bad arguments do not enter it; unsupported declarations fail before registration. A controller/AppTools keeps its original ToolSet and port. Handler-only commits preserve the registration. Replace a contract/port through explicit unmount/remount; direct replacement is rejected before registry changes. Disabled releases the registration; re-enabled obtains a new qualification.

The handler returns a `ToolResult`. Return a concise receipt; put the current business data in the matching View. A successful handler response alone does not assert that some asynchronously published View is already observable. `effects: 'none' | 'partial'` can describe an application's known failure effects; omitting it does not let the SDK infer whether business side effects occurred.

The binding controller requires the Runtime `view-type-tools-v4` port. `createTUIApp` adds that author marker automatically; Host/Worker execution uses `view-type-parameters-v1`. Missing or mismatched markers are rejected before initialization. Ref parameters use the same declaration and binding through [refParam](readonly-ref-v2.md), not a separate View-instance API. Retired modes do not fall back to the ordinary path.

## Native Host Tool aliases

For native Host exposure, the App name, ViewType, and Tool name are joined as `appName-ViewType-toolName`. Each component accepts only ASCII letters, digits, and underscores; the `-` characters are separators, not allowed inside a component. The full alias is limited to 64 characters. The Runtime rejects invalid aliases instead of rewriting them. This is an adapter naming rule and does not constrain pure Core identities.
