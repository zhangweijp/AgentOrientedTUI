# TS7 原生 LSP r02：精确修订入口准入

2026-11-08。**r02 有限原生能力诊断入口 APPROVED，可以执行一次。** 这不是生产 IDE、协议符合性或文件监听健康的批准；[首次失败裁决](MINIMAL_CORE_TS7_NATIVE_LSP_RUN01_REVIEW_2026-11-08.zh-CN.md)保持。

负责人核对首次封存的 26 项，以及 r02 的全部 14 项输入；逐字比较入口，唯一代码差异是未知方法断言从 `error.code === -32601` 改成 `error.code === -32600 && error.message === 'InvalidRequest'`。其余恢复 hover、正常 shutdown、资源检查、限额和清理代码全部一致。

官方 JSON-RPC 规范的未知方法期望仍为 -32601；固定服务的实际 -32600 偏差继续登记。提交的 npm 7.0.2 gitHead 对应源码中，unknown handler 分支返回 InvalidRequest，与首次观测一致。这仅说明当前实现行为，不撤销原有规范要求。当前 IDE 一般查询错误不依赖该数值，无需因此修改生产错误映射。

精确身份：

- 首次 manifest：26 项，`b408c5a68732c632a9bbe1144e6e7f628275d8180a964a8ec867d3f7ab18161b`。
- r02 manifest：14 项，`c46eb5b20b5e8a134010d80a643de021c390524cddf293108cbd6f03ae50891b`。
- r02 入口：`370021bbe377fc016e40b3a96824a507537e72e84623f3a10f4dcab0f9206768`。
- package、lock 与原生二进制指纹均与首次相同，原生程序仍为 `a82f7313…`。

执行方新正常安装消费者为 `/private/tmp/aotui-ts7-native-lsp-r02-prepared-2taof59h`。负责人重新检查其中三个输入，以原准入的精确 Node 和白名单环境执行 `--prepare`，退出 0，与冻结预检相同，没有启动语言服务。

允许以 `owner-review/input-review.json` 的 `futureRunCommand` 和 `launchEnvironment` 运行一次。原准入的合成目录、24 请求、90 秒工作截止及有限清理要求继续生效。九项实际断言、错误后恢复、child code 0／无 signal／group gone／forcedSignals 空数组必须全部成立；任何失败保留并停止，不覆盖首次或 r02 输入。七项 FSEvents 首次失败不因后续通过而消失，外部文件监听继续未验。

负责人可在自己的新正常消费者使用同一三输入独立运行。运行通过后才能裁决原生能力范围，并给出生产 IDE 三模块及必要依赖／测试的具体任务；旧响应拒绝、实际在途容量、初始化中止、真实文档和根目录变化、外部依赖更新仍须在生产候选验证。

**下一条 Codex Prompt：** 核对新 370021bb… 入口、三输入、原生身份和白名单环境，执行一次 r02 --run，将完整命令、退出码、原始三文件、fixture 和进程组事实写入新 execution。不得接受任意错误，不以强杀代替正常退出，不改生产或扩大健康范围。成功时提交精确结果清单及下一批最小生产方案；失败立即交原始证据。首次规范偏差和 FSEvents 记录均保留，由负责人独立复验后签收。

证据：[精确差异、输入与独立预检](../review-evidence/ts7-native-lsp-r02-entry-20261108/owner-review/input-review.json)；[r02 提案](../review-evidence/ts7-native-lsp-r02-entry-20261108/PROPOSAL.zh-CN.md)；[准入签署](../review-evidence/ts7-native-lsp-r02-entry-20261108/owner-review/admission-signoff.json)。
