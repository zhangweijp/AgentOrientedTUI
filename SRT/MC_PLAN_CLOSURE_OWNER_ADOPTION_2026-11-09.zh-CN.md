# Minimal Core 原计划最后两项：根目录采用记录

2026-11-09。**APPROVED_ADOPTED。** MC 执行 Agent 完成开发，MC Owner 已给出[唯一独立裁决 APPROVED](../MINIMAL_CORE/MINIMAL_CORE_REMAINING_WORK_REVIEW_2026-11-09.zh-CN.md)；SRT Owner 接收结论，完成实际根目录采用与受影响构建，没有追加代码复审。

原计划 M5／R4 的重复参数编译及 M8／R6 的 IDE 随包消费者迁移两项已完成开发、复核和采用。此前 SRT-01～SRT-15、Clean 追加减法及 MC 已批准批次的结论分别保留；本次采用使已授权工程尾项全部落到实际根目录，没有新的开发或人工验收前置。

## 实际变化

- Worker 使用现有注册记录持有的已编译参数合同，退出每次调用重复编译；Core 授权前校验、Worker 接收端校验、Ref 来源检查和 SDK 执行资格等实际责任保留。
- IDE 随包本地入口与当前文档迁到现行合同，删除旧模式／投影分支及失效的 `scripts/scoped-ide.mjs` 启动包装。正常安装入口已由 MC 验证真实文件操作、最新 View、收据回读、LSP 和关闭。
- 本增量 19 路径：16 修改、2 新增测试文件、1 删除生产文件；生产 7 路径净减 131 行，测试 10 路径净增 132 行，文档 2 路径净减 14 行。没有新增依赖、包版本或生产配置变化。

## 身份、组合与采用

批准对象：[combined-r01/closure.patch](../review-evidence/minimal-core-plan-closure-20261109/combined-r01/closure.patch)，SHA-256 为 `50575be4591e42a15ac6f0c56f298b1b50129d63b8a890a684bf95136a510d25`。该增量相对于 Clean 62 路径已采用后的实际基线，未使用旧候选整文件覆盖交集。

SRT Owner 核对全部 19 项当前 before、冻结 before／after 与最终候选，全部匹配；patch 路径集合与清单一致，`git apply --check` 通过。备份实际 before 后选择性采用，随后 19 项 after 全部一致，已删除启动脚本不存在。已有未提交和未跟踪工作保留，HEAD 前后均为 `8938449925ada2f92e072e1c0492af8f2428d14f`。

MC Owner 已验证组合保留 Clean 的 60 个非交集路径与两个 Worker 文件中的删除；SRT Owner 直接接收这项结论。新增注册合同测试的 AppContext 夹具使用当前身份字段，没有恢复旧回调或私有转导出。

原件：[采用记录](../review-evidence/minimal-core-plan-closure-owner-adoption-20261109/adoption.json)、[准确增量清单](../review-evidence/minimal-core-plan-closure-owner-adoption-20261109/adopted-changes.json)、[采用前备份目录](../review-evidence/minimal-core-plan-closure-owner-adoption-20261109/before)。

## 验证与结案

MC 的独立验证直接复用：原实现 109 项参数／绑定测试及随包终端 9 场景；最终组合 74 项注册／真实 Worker 测试，522 件包文件与三份 tar 一致。当前组合执行方已有 255 项相关测试、终端 9 场景及三包构建，MC 已核对。以上按各自版本记录，不跨批次累加为一套全量结果。

SRT Owner 在采用后的实际根目录依次运行既有 `pnpm run build`：

| 包 | 结果 | 耗时 |
| --- | --- | --- |
| Runtime | 通过，exit 0 | 0.613 秒 |
| SDK | 通过，exit 0 | 0.407 秒 |
| IDE | 通过，exit 0 | 0.839 秒 |

构建后重新核对 19 项 after 全部匹配，IDE 生成元数据没有额外变化。见[构建记录及日志索引](../review-evidence/minimal-core-plan-closure-owner-adoption-20261109/root-validation.json)。没有重复代码审查、历史全量矩阵、GUI 或人工 Planning 验收。

**本次阻断为 0。** 原生 LSP 资格仍限已测本地环境，MC 记录的受限环境原失败保留；本次不扩展平台承诺。此前额外 linkedom 源码依赖声明检查的非阻断限制也不因本次采用被改写为通过。

下一条执行指令：MC Owner依据本采用原件关闭本线原计划及两项尾项的状态；SRT 总索引同步记为已完成。工程实现、复核及实际采用已全部完成，不等待状态文档更新再开放使用。项目所有者可按原 `./run.sh` 入口继续使用，后续新需求另行定义范围。未来 Ref 字段／作用域／基础类型、并发和资源策略重设计保持原决定；本次没有提交、推送、合并或发布。
