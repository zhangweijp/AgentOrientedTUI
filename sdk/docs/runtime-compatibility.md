# 安装 SDK 与 Runtime

普通 TypeScript App 使用 `@aotui/sdk/app` 和 TypeBox。Preact App 另外安装 Preact，从 `@aotui/sdk` 根入口使用 `createTUIApp` 与 `View.bindings`。两个入口都导出同一合同的托管工厂，并复用 Runtime 的参数与调用验证。[App 作者指南](app-authoring.md)

## 安装本地交付包

在独立目录安装同一批次的 SDK 和 Runtime tar。下面的 `package.json` 对应交付目录里的 `consumers/plain/`，以相对路径访问 `artifacts/`。Runtime override 保证 SDK 与 Host 解析到同一份 Runtime。

```json
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@aotui/runtime": "file:../../artifacts/aotui-runtime-8.0.0.tgz",
    "@aotui/sdk": "file:../../artifacts/aotui-sdk-0.9.0.tgz",
    "typebox": "1.4.3"
  },
  "devDependencies": {
    "@types/node": "24.11.0",
    "typescript": "7.0.2"
  },
  "pnpm": {
    "overrides": {
      "@aotui/runtime": "file:../../artifacts/aotui-runtime-8.0.0.tgz"
    }
  }
}
```

首次运行 `pnpm install`。保留相对路径、tar 和 lock 后，可用 `pnpm install --frozen-lockfile` 重装。本批使用 Node 24。Preact 作者可添加 `preact@10.29.1`。使用标准 Source 的 Host 另装匹配的 Adapter 和 Driver，按 Driver 包内 `STRICT_TYPES.md` 配置补丁。

当前四包版本、公开协议与本地交付入口由 `@aotui/runtime` 包内 `docs/sdk-runtime-distribution.md#current-delivery` 维护。完整 Host 安装和调用示例见同包 `docs/semantic-host-integration.zh-CN.md#source-host-example`。

## 验证作者入口

`docs/examples/` 包含文件 App、Ref App 和普通 TypeScript／Preact 两种工作项 App。普通作者入口与 Core 可在 `lib: ["ES2022"]`、`types: []`、`strict: true`、`exactOptionalPropertyTypes: true` 和 `skipLibCheck: false` 下编译。Preact 示例另外使用 DOM 类型。

仓库验证脚本读取已安装包中的教程和示例，从公共入口编译并运行。第一个参数为消费者绝对路径，第二个参数为结果文件。

```sh
node sdk/tests/srt01-m4/verify-docs.mjs /absolute/path/consumers/plain /tmp/aotui-plain-check.json plain
node sdk/tests/srt01-m4/verify-docs.mjs /absolute/path/consumers/host /tmp/aotui-host-check.json full
```

`plain` 运行纯 Core 和中立 Worker 示例。`full` 同时运行 Preact 与标准 Source 教程。SDK 与 App 的职责、Tool 收据和 View 的分工以及迁移入口见 [App 作者指南](app-authoring.md)、[Ref 指南](readonly-ref-v2.md) 和 [迁移指南](migration.md)。
