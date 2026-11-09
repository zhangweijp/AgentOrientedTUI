# TS7 原生语言服务：只读方案与有限入口裁决

2026-11-08。**只读责任盘点与下述精确原生协议探针入口限定 APPROVED。** 可以在合成临时工作区执行原生能力诊断；本裁决不批准 IDE 生产后端替换、健康版本范围扩大、Host／GUI、模型调用、用户项目访问或共享采用。SDK 四文件结项另见[独立裁决](MINIMAL_CORE_TS7_SDK_TOOLING_REVIEW_2026-11-08.zh-CN.md)。

## 1. 审查依据与精确身份

负责人审查 `IDE_NATIVE_LSP_PLAN.zh-CN.md`、完整 `ide-native-probe.mjs` 和现有 IDE 请求、结果与清理责任链；再次核对 `ide-source-map.json` 的 13 件实际候选源码。方案保留 ScopedLSP 的 root epoch、目录身份、文档版本、query generation、队列、实际在途计数及进程所有权，没有把文件／语言服务资源交给 Runtime。

负责人在执行方已正常安装的消费者 `/private/tmp/aotui-ts7-native-lsp-prepared-cdxqnqv6`，重新检查三个输入和原生文件指纹，并以本裁决的固定环境执行 `--prepare`。退出 0，与冻结预检逐项相同，未启动语言服务。原首次导入错误保留，不能将原 `preparation.json` 内失败的 preflight 当作成功记录。

| 输入 | SHA256 |
| --- | --- |
| `package.json` | `c90eb03cd446ecb1065fc65d95981ebe65a282bc869b0cf7c6b0fe7b3c7faf85` |
| `package-lock.json` | `f9158ef60260fb86cc10a3f56938c7c51c4f841060af77a44aaa97819680b6d8` |
| `ide-native-probe.mjs` | `f9ed6f12e4b2652177f881bb83745317b266628e62eb76f43a5112cb5c93cde0` |
| Darwin arm64 平台原生程序 | `a82f731365ad69d5c4c15f5e18fba4584bf3b7b839960172a76c3462b5114bf2` |

Node 固定为 `/Users/zhangwei/.local/share/fnm/node-versions/v24.15.0/installation/bin/node`，版本 24.15.0。编译器固定 7.0.2，JSON-RPC 包固定 8.2.1；不解析共享 IDE 或 Host 初始化模块。

## 2. 本次允许的运行与成功条件

允许执行上述消费者中的精确脚本 `--run`。父进程使用白名单环境：PATH 为上述 Node 目录加 `/usr/bin:/bin`，LANG 为 `en_US.UTF-8`，CI／NO_COLOR 为 `1`，TMPDIR 固定 `/private/tmp`。因此脚本的 `os.tmpdir()` 与文档声明一致，也不继承 ambient NODE_OPTIONS。子服务继续使用脚本已审查的独立工作目录、HOME 和缓存目录。

脚本只创建两份合成 TypeScript 文件及一个 tsconfig，启动固定原生程序的 `--lsp --stdio`。最多 24 次主动请求、90 秒工作截止、有限清理等待、2 MiB JSON 记录预算和 256 条记录上限。记录预算不被解释为整个服务进程的内存限制。

实际成功必须同时满足：

1. initialize 提供所要求的六类能力，位置编码为 UTF-16 或协议默认值。
2. hover、definition、references、symbols、incoming 与 outgoing 得到相应符号或文件；编辑前诊断含 TS2322，编辑后该错误消失。
3. 不支持的请求明确报协议错误，随后有效 hover 仍能成功。
4. 正常 didClose、shutdown、exit 后，子进程 code 0、无 signal，所属进程组确实消失。
5. 入口退出 0、九个 case 通过，`forcedSignals` 为空；原始请求／响应、stderr 和结果全部保留。

脚本失败后的 TERM／KILL 仅允许清理其自己创建的进程组，任何强制信号都不能记为正常关闭。若进程或组仍存活，保留身份与原始失败，不重复运行制造通过。不得用外层超时只杀 Node 父进程而遗留 detached 子服务；先让脚本有限清理完成，异常残留按真实所有权处理。

执行方先运行一次，遇到首个断言或协议失败即提交原始事实，不在原目录改入口重跑。负责人可用相同三输入、相同正常 npm 锁及原生身份，在自己的新消费者进行独立复验；需要修订时另交增量，不覆盖此入口和首次失败。

## 3. 明确未覆盖的部分

本探针证明固定原生版本在合成文件上的协议能力，不包含实际 ScopedLSP。它不验证 App 的 root／document／generation 旧结果拒绝、容量与超时、启动取消、真实根目录退役或业务页面与收据，也没有强断言所有返回坐标和 Unicode 边界。不能据此直接放宽生产 `processGroupVerified`。

原生诊断使用 full report，首批不引入 previousResultId 缓存；其他语言服务器原有 versioned push 行为保持。生产补丁应复用现有 server、client、ScopedLSP，删除默认 TypeScript 的 tsserver 专用诊断请求，不新增另一套资源管理器或降级现有检查。

## 4. 下一批范围与 Codex Prompt

本次范围只到上述原生探针。通过后，执行方提交实际结果及具体 IDE 生产增量方案；负责人据真实能力决定 `server.ts`、`client.ts`、`scoped-lsp.ts`、IDE 开发依赖／脚本和必要现有测试的实施边界。生产准出必须另外证明七类查询、DTO 与位置、编辑更新、三个独立 stale 条件、实际在途容量／超时、初始化中止、根退役重开、文档清理以及正常子进程／组关闭。

> 依据本裁决执行冻结的 f9ed6f12… 原生 LSP 入口，三输入、Node、锁与实际 native 身份全部先核对。使用 input-review.json 中的精确白名单环境，当前消费者为 /private/tmp/aotui-ts7-native-lsp-prepared-cdxqnqv6。只运行一次 --run；保留命令、完整退出码、result／transcript／stderr、真实子进程与组关闭事实。首失败停止推进并交付，不修补原输入、不缩减能力断言、不把强制终止写成正常关闭。不要启动 Host、GUI、模型、用户项目或私人手测状态，不修改生产 IDE。成功后给出基于真实能力的最小生产增量与验证矩阵；待负责人独立复验和下一条具体实施指令，不自行签收。

证据：[13 源码、三个入口输入与独立预检](../review-evidence/typescript-sdk-tooling-20261108/owner-review/native-lsp-admission/input-review.json)；[执行方只读计划](../review-evidence/typescript-sdk-tooling-20261108/IDE_NATIVE_LSP_PLAN.zh-CN.md)；[入口源码](../review-evidence/typescript-sdk-tooling-20261108/ide-native-probe.mjs)；[准入指纹](../review-evidence/typescript-sdk-tooling-20261108/owner-review/native-lsp-admission/signoff.json)。
