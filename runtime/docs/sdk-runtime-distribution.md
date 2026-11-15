# Runtime / SDK 的分发与验证边界

## 当前 Runtime 入口

- [Runtime package guide](../README.md)：Node Host 入口、纯 Core 子路径、独立适配包与接入文档导航。
- [Semantic Host integration](semantic-host-integration.zh-CN.md)：标准 Source 的 Context、AppInteraction、Observation、Tool 和 Receipt 合同。
- [Runtime App interaction](runtime-app-interaction.md)：`toolsEnabled`, `getAppInteraction`, `SemanticAOTUIDrivenSource.getContext()` 与 Context release。
- [Tool lifecycle and cleanup](tool-lifecycle.md)：统一 ViewType Worker 参数模式、Tool 结果与 managed App 生命周期。
- [Pure Core entry](core-public-entry.md)：从正式包名编译运行的无 DOM Producer / Host 示例。
- 仓库内示例见 [IDE local consumer](../../demo-apps/aotui-ide/SCOPED_IDE.md#local-terminal-from-exact-installed-packages)：在正常安装的匹配包中直接运行随包入口；旧的仓库 prepare/run/verify 启动包装已退出。

<a id="current-delivery"></a>
## 当前本地交付

| 包 | 版本 | 正式依赖关系 |
| --- | --- | --- |
| `@aotui/runtime` | `8.0.0` | 提供纯 Core、Node Host 和 Worker |
| `@aotui/sdk` | `0.9.0` | 精确依赖 Runtime `8.0.0`，要求 TypeBox `1.4.3`，Preact 为可选 peer |
| `@aotui/agent-driver-adapter` | `0.5.0` | 精确要求 Runtime `8.0.0` 和 Driver `0.3.2` 两个 peer |
| `@aotui/agent-driver-v2` | `0.3.2` | 完整 Source Host 使用的 Driver，严格类型安装见包内 `STRICT_TYPES.md` |

安装时使用同一次本地交付的 tar，并以其清单核对 SHA-256。版本号用于选择包，Worker 与 App 通过各自协议确认是否能协作。可用范围以本地验证记录为准。

在仓库根目录指定一个新的绝对路径运行交付入口。使用 `--store-dir` 可指定已有 pnpm store，缓存齐全时可加 `--offline`。

```sh
pnpm run release:local --out /absolute/path/aotui-local-delivery
```

入口从当前源码冻结构建输入，使用相同锁文件在两个新目录依次构建 Runtime、SDK、Driver、Adapter。它调用 npm pack，比较每个包的文件内容、权限和内部链接，然后将第一组 tar 放入 `artifacts/`。实际输入、工具链、两组 payload 与原始 tar 的哈希、安装解析图、命令和报告写入 `release-manifest.json`。

`consumers/plain/` 是普通 TypeScript 作者及中立 Host 的最小依赖图。`consumers/host/` 包含 Preact、标准 Source 和 Driver 的严格类型图。各自使用同一组最终 tar 正常安装、验证，并在另一个新目录同锁重装和复验。要重装，保留 `artifacts/`、消费者 manifest、lock 与 patch 的相对位置，在所选消费者目录运行 `pnpm install --frozen-lockfile`。完整 Host 首次配置见 `@aotui/agent-driver-v2` 包内 `STRICT_TYPES.md`。

App 作者可从 `@aotui/sdk` 包内 `docs/runtime-compatibility.md` 开始。Host 迁移、Core 的 `inspect()` 和声明容量边界分别见 [公共 App 交互](runtime-app-interaction.md)、[纯 Core 入口](core-public-entry.md) 和 [初始化诊断](initialization-diagnostics.md)。

## 当前协议与拒绝边界

下表供 Runtime／宿主集成者定位当前合同。SDK 作者使用工厂与组件，由 SDK 提供协议标记。包版本、工厂、端口、Snapshot、调用和持久化各自演进，没有统一的协议大版本；源码文件或类型名里的 V2／V3 也不能替代实际字段。

| 合同 | 当前身份与生产／消费位置 | 支持与拒绝边界 |
| --- | --- | --- |
| 托管 App 工厂 | SDK 的 `createApp` 与 `createTUIApp` 提供 `toolAuthoringProtocol: 'view-type-tools-v5'`，Runtime 的 `hasViewTypeToolAuthoringProtocol` 校验 | Registry 从生成的 aoapp.json 读取该标记。Worker 的模块 default 必须是托管对象工厂。`isTUIAppFactory` 先检查形状、持久化及生命周期声明，再检查工具标记。缺失、旧值或 accessor 工具标记产生 `APP_AUTHORING_PROTOCOL_UNSUPPORTED`。 |
| 当前状态 Snapshot | Core 的 `PreparedAppSnapshotDraftV4`／`AppSnapshotV4` 使用 `schemaVersion: 4`；DOM Producer 或普通 TS Producer 提交，Core `v4-validator` 接收 | 正文为 `markdown-v1` 字符串，Ref 使用 `snapshot-value` JSON payload。Runtime 自己生成并请求 `app-snapshot/v4`，Worker 在导入 App 前要求该能力，Host 在 OPEN 前要求 ACK；缺失为 `WORKER_SNAPSHOT_UNSUPPORTED`，未知版本能力为 `WORKER_CAPABILITY_UNSUPPORTED`。其他实际 schemaVersion 仍由数据边界拒绝为 `SNAPSHOT_INVALID`；握手不代替身份、序列、Ref owner、Tool activation 及预算检查。 |
| Host 交互选择 | 可信安装选项 `toolsEnabled?: boolean` | 省略或设为 `true` 启用 Tool 协商。`false` 只协商 Snapshot。安装前拒绝未知选项（`CONFIG_INVALID`）和不合法的 `toolsEnabled` 字段（`TOOLS_ENABLED_INVALID`）。 |
| Worker Tool IPC | `PARAMETERS_V6_CAPABILITY = 'view-tool-parameters-invoke/v6'`。`VIEW_TOOL_INVOKE_V6`／`VIEW_TOOL_INVOKE_V6_RESPONSE` 的 `argumentMode` 为 `view-type-parameters-v1` | 启用工具时 Host INIT 请求此能力，Worker 明确返回 acceptedCapabilities；Host 要求全部请求的能力被确认，缺少调用能力为 `WORKER_CAPABILITY_UNAVAILABLE`。双方仍独立校验完整调用消息、success 判别的 JSON 结果、身份与预算；不尝试旧 RPC。 |
| 参数与 Ref profile | Core `compileOrdinarySchema` 处理裸声明，`ordinaryParameterProfile`／`compileOrdinaryProfile` 处理带 `view-type-parameters-v1` 标记的 profile | 普通字段与 Ref 目标共享有限 JSON 值域，显式 Ref 从 Observation 解析。支持的关键词和位置见 `@aotui/sdk` 包内 `docs/tool-parameters.md`。 |
| App 生命周期 | SDK 声明 `appLifecycleSupport: 'app-lifecycle-v2'`；Runtime 端口／清理报告用该 protocol，INIT offer／ACK 另带 `version: 2` 和同一 instanceId | Worker 校验 offer，Host `captureAppLifecycleAck` 校验 ACK；缺失、旧值、错误版本或实例不能建立托管生命周期。Host 的 ACK 失败为 `APP_LIFECYCLE_NEGOTIATION_FAILED`；清理报告仍另行校验，不把 ACK 当作已关闭。 |
| 实例持久化与传输 | SDK 声明 `persistenceSupport: 'state-session-v1'`；Runtime 的 `STATE_SESSION_PROTOCOL` 标识 offer／ACK、App 端口和报告。offer／ACK 与 `STATE_STORAGE_REQUEST`／`STATE_STORAGE_RESPONSE` 的传输版本为 `1` | Worker `capturePersistenceOffer` 与 Host `capturePersistenceAck` 分别检查版本、实例及预算；Host ACK 失败为 `PERSISTENCE_NEGOTIATION_FAILED`。请求／响应还核对 sequence、action、地址和结果，不能用生命周期 ACK 代替持久化结算。 |
| 持久化记录编码 | Core `encodeStateRecord`／`decodeStateRecord` 的 JSON 外壳为 `{ version: 1, updatedAt, value }` | 记录格式与实例传输是独立合同；无版本的裸业务 JSON 或其他记录版本为 `UNSUPPORTED_FORMAT`。业务自己的 version 字段可位于 value 内，不充当外壳版本。 |

Worker 握手对退役或未知能力返回 `WORKER_CAPABILITY_UNSUPPORTED`，对不合法的能力列表返回 `WORKER_CAPABILITY_INVALID`。Core 直连与 Worker 使用同一 ViewType 参数合同，验证已采用观察中的页面接收者和显式 Ref 来源。交付清单记录了配套 tar 的哈希和每个包在独立消费者中的实际解析路径。

这些检查发生在各自入口。旧工厂、缺少必要 offer／ACK、未知能力或不匹配的调用身份不能靠“包版本看起来相近”通过。Worker INIT／OPEN 的失败仍按原阶段和诊断合同报告，不将不同错误统一改写成一个兼容错误。
