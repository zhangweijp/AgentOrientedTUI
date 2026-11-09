# LSP 安装与支持边界

当前公开入口是 IDE 默认 App factory，其文件、工作区和 LSP 由每个 App 的 IDESession 拥有。旧全局文件／持久化服务和 LSP 单例入口已删除；新消费者使用默认 App factory，不深层导入旧服务。

## JavaScript / TypeScript

默认使用 **TypeScript 7.0.2 原生 LSP**，不再从 PATH 寻找 typescript-language-server。当前候选回移官方 PR #64894 的关闭修复，未声称该修复已进入正式 7.0.2 npm 包。

目前完成资格验证的平台是 **darwin-arm64**。其他平台明确返回 `LSP_NATIVE_PLATFORM_UNSUPPORTED`，不自动回退到未验证的包装器或版本。

源码开发：

```sh
pnpm install --frozen-lockfile
pnpm build
```

编译和 watch 均使用 `@typescript/native` 别名指向的官方 7.0.2 编译器。Jest 使用的 TypeScript JS API6 仅为开发依赖，不是编译器或 App 运行时依赖。

第一次源码构建还需要 PATH 中的 **Go 1.26.2**、tar 与 patch。`scripts/build-native-lsp.mjs` 使用 `toolchain/` 中固定来源、固定哈希的源码选取归档和单文件补丁构建，验证产物哈希；后续构建复用匹配的产物。Go 模块由原 go.mod/go.sum 固定；可复用标准 Go 缓存。构建不依赖已修改的 node_modules 或外层仓库 Git 信息。

打包后的 App 含 `native-lsp/tsgo` 与 `profile.json`，普通安装者无需 Go，也不需要 TypeScript JS API6。启动时核对配套来源/profile 和二进制；不会执行另一份全局工具。上游正式修复可用后，应移除这份临时回移与构建输入。

客户端使用 UTF-16，工具位置为一基坐标。支持 hover、definition、references、symbols、incoming/outgoing calls，以及标准 pull diagnostics。缺失 pull 能力、非 full 报告、非法/超限结果明确失败。文件正文和查询结果通过当前 View 展示，Tool 只返回操作收据。

外部依赖更新由原生服务器的 OS 文件监听承担。需要系统允许 FSEvents；受限沙箱不能收到更新的运行不算监听通过。App 不用伪造 didChange、全盘轮询或自动重启来隐藏此限制。

## 其他语言与自定义服务

现有 Python/Pyright、Go/gopls、Rust/rust-analyzer、C/C++/clangd 入口保留。相应工具需要由运行环境提供，不能从本次 TypeScript 验证推导其兼容性。其他语言的诊断继续使用带文档版本的 push；无版本或旧版本不取得当前诊断资格。

工作区 `.aotui-ide/lsp-config.json` 可以禁用或显式配置服务：

```json
{ "lsp": false }
```

```json
{
  "lsp": {
    "python": {
      "extensions": [".py"],
      "command": ["pyright-langserver", "--stdio"]
    }
  }
}
```

默认 TypeScript 的服务 id 是 `typescript`；显式替换该 id 的服务须提供当前 UTF-16/pull 合同。自定义命令不继承默认二进制的资源清理认证；查询可用不等于关闭已验证。Windows 和其他未资格验证的平台同样不获得健康 Worker 复用承诺。

## 生命周期与验证

仍保留每 App 4 个实际在途查询、8 个客户端、每客户端 64 个文档、4 MiB 文档上限，查询 30 秒与初始化 45 秒到期不提前释放实际资源责任。查询结果必须经过 App/root/document version/generation 检查；停止、关闭和旧响应不能重新绑定。

默认 TypeScript 正常关闭须满足：shutdown 返回、exit 后 code 0 / signal null、子进程和所属进程组消失。提前 exit、非零关闭、未确认清理不能被当作健康。可执行当前 `scoped-lsp.e2e.mjs`、`scoped-lsp-capacity.mjs`、`native-lsp.e2e.mjs`；最后一项的外部监听检查需要正常本机 OS 权限，测试目录始终是合成临时目录。
