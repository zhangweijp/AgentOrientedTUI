# SRT-02 整列表 Ref：基线准备与首次入口复核

2026-11-07。**APPROVED，批准精确准备交付，以及下列两个入口在本批独占消费者目录的首次运行。** 这不是整列表实现或行为通过的签收，也不解除 Host 预览诊断的 NOT_ADMITTED。

提交报告为 [REPORT.zh-CN.md](../review-evidence/srt-02-list-ref-baseline-20261107/REPORT.zh-CN.md)，SHA-256 `e531a1f197482b0ab1cb244eae2c9415d884fef363f509d1c9f46f1456a4ac71`；[submission-01.json](../review-evidence/srt-02-list-ref-baseline-20261107/submission-01.json) 为 `faa1aaf60ca451a449898c0be6290d4f29a75a719eeda9110706de2180c3580e`。实施者为 SRT Owner，独立审查者为 Minimal Core 负责人。

## 独立核对结果

负责人只读核对了 67 件提交证据、418 件重建源码输入，以及源码编译出的 SDK 76／Runtime 372 件 dist；执行代码、声明和 maps 均与精确原包逐字一致。消费者内 SDK 90／Runtime 388 件原包文件、Driver 17 件冻结文件、入口原件及实际依赖链接也相符。消费者的实际 emitted App 和 data JS 已直接阅读，业务只记录本目录的合成输入。

当时消费者的 state、business、result 和两入口日志均不存在；没有先运行后补准入。核对没有重新编译、导入项目模块或读取私有状态。[可重跑静态核对脚本](../review-evidence/srt-02-list-ref-baseline-20261107/owner-review/verify-preparation.py) · [结果与入口指纹](../review-evidence/srt-02-list-ref-baseline-20261107/owner-review/preparation-check.json)

入口初始化与资源责任符合这次有界验证：

- 声明探针从 SDK tools 公开入口调用参数编译，只创建声明数据，不创建 Runtime 或 Worker。
- Worker 探针只显式创建一个 Runtime、一个 Desktop，池 initialSize=0、maxSize=1，安装自己的 file URL App；未创建 AppRegistry，未导入 Host 默认 DesktopManager。
- Runtime 根入口虽然导出 Registry、catalog、npm helper，所查模块没有在顶层创建 Registry、读取默认配置或执行安装／catalog 调用。不能把“根入口导出这些函数”写成“这些模块未被加载”；此次依据是其初始化代码及脚本实际调用路径。
- App 配置明确提供本消费者 state 目录。WorkerHost 使用该配置建立持久化 root；默认 storage backend 的构造只创建内存状态，I/O 从后续操作进入。脚本不调用默认用户配置发现或真实 Planning 服务。
- Source 构造时会调用 loadAOTUIInstruction。includeInstruction:false 不阻止加载；当前脚本额外提供非空合成 instruction，loader 首个分支直接返回。该变更只作用于新测试脚本，不修改框架或历史证据。
- Python 包装仅继承明确列出的基础环境变量，保持原 HOME，排除模型凭据和 Node preload 配置。这里的准入来自具体入口与数据路径审查，**不声称包装器构成 OS 沙盒或完整 I/O 审计**。
- Source／Context 在正常及 finally 路径清理，Runtime finally 等待真实 shutdown completion。45 秒超时或初始化异常若没有关闭回执，只能记录未知，不能以进程退出冒充资源结清。

## 获准命令和判定

以下 cwd 均为 `/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/.tmp/srt-02-list-ref-baseline-20261107/consumer`，命令及输入 SHA 按提交原件。顺序执行，各运行一次：

```sh
python3 run-reviewed-entry.py declaration
python3 run-reviewed-entry.py worker
```

第一条预期单对象声明通过，整对象列表、数值列表、optional、多 Ref、Ref 名数组五种声明明确拒绝；这是确认既有限制，不是整列表成功。

第二条预期六次实际工具调用：两个正确对象进入业务，各派发一次；四个错误在派发前拒绝，无业务进入。必须记录真实 Node 退出状态、原始 stdout/stderr、输入与 wire、两条业务记录、Source/Context 释放及 Runtime 关闭回执。

不得覆盖已有运行结果。若执行前发现输入变化或输出已存在，保留事实并停止该次执行；需要重跑时用新的运行位置或先完整封存原件。若入口失败，先区分消费者错误、环境错误和产品行为，不把缺依赖或外层脚本 exit 0 当作有效基线。

## 后续实施范围与 Codex Prompt

两个基线入口满足预期并封存后，可继续已签收的隔离整列表实施，无需再请项目所有者确认同一日常范围。保留本次基线目录，候选另用新目录，避免修改已签输入。生产逻辑优先仅限 `ordinary-parameter-contract.ts`、`snapshot-value-arguments.ts`，SDK 声明注释／支持文档与相关测试按原范围同步。

必须完整执行 [范围任务 G-A 至 G-G](../SRT-02_REMAINING_SCOPE_AND_ACCEPTANCE.zh-CN.md)：一个必填顶层 Array<Object> Ref；双 Producer；模型名字与 handler 数组；运行时数组和元素不可变；原观察来源、授权、单次执行、总预算、释放关闭；四包组合及预先固定的拒绝阶段。不得扩展多个／可选 Ref、Ref 名数组、属性路径、Observation 采用、Planning 业务或 Host 修复。需改 wire、capability、公共签名或额外生产模块时先提交失败依据和范围修订。

> SRT Owner 负责执行已准入的两个精确基线入口，封存真实结果后在新独占候选中实现一个必填整列表 Ref。你不是唯一执行者，不回退他人修改，不改共享生产或冻结候选。保留基线、原始失败、精确包身份和资源事实；只沿已审的显式合成配置／本地 App 链补验 G-A 至 G-G，不导入 Host 默认实例、不发现用户应用、不访问真实私有状态或模型。沿现有参数编译、原 Observation 解析和 Worker 链完成两处最小修改，保持普通参数、对象 Ref、预算与关闭语义。新增失败如需扩大范围先升级；实现与测试结束后提交独立 patch、真实 tar 和 READY_FOR_REVIEW，由 Minimal Core 独立复核，不自行宣布实现 APPROVED。

当前未覆盖整列表运行、混合版本、容量边界、不可变性及修复后的生命周期；本裁决时没有新行为结果。正式采用、发布、旧入口退出及最终 Semantic 验收继续遵守原分工。
