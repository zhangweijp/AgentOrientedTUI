# SRT-02 完整交付：Owner 验收

2026-11-08。结论：**APPROVED_FOR_COMBINED_INTEGRATION**。

Clean 已完成约定的 Ref／ArrayRef 实施、迁移、包消费、测试和文档。Owner 收到完整交付后集中审查并独立验证，没有发现本任务的阻断问题。批准下面这份精确候选进入与 View 任务的联合整合；这不表示候选已经采用到共享根目录，也不替代项目所有者的最终 Semantic 人工验收。

## 验收对象

- [完整任务](SRT-02_COMPLETE_DELIVERY_CLEAN_TASK_2026-11-08.zh-CN.md)、[Clean 交付](../.tmp/srt-02-complete-clean-20261108/REPORT.zh-CN.md)。
- 候选：`.tmp/srt-02-complete-clean-20261108/candidate`，55 个差异路径（2 新增、49 修改、4 删除），有效源码 913 件。
- `source-manifest.json` SHA256：`bc2abeba8f8c02b5709c379a9e514a0dd8b1a90f552841a6e53d3290779ea43a`。
- `changes.patch` SHA256：`e78d19e336a532ed73b4881ffd6c6941316581a2b143c67be254e9aadb76b1f5`。
- `DELIVERY.json` SHA256：`bf445fa153c6b3b84ec5331e235728ba0987fd4532ac5be49e8e2dff5288ffa0`。
- Runtime `5.0.0-srt02.1`、SDK `0.6.0-srt02.1`、Adapter `0.2.0-srt02.1` 是未发布的匹配候选；完整包身份与复跑结果见 [Owner 证据](../review-evidence/srt-02-complete-owner-review-20261108/verdict.json)。

## 实现裁决

对象 Ref、整个对象列表、自然数组元素、多个／可选 Ref 和 Ref 名数组均进入同一声明与调用链。`Type.Array(refParam(...))` 保留选择顺序与重复项，和 `refParam(type, Type.Array(...))` 的单个整列表 Ref 有明确区别。可选字段缺席保持缺席；空数组是一次空选择；错误成员导致 handler 前整体拒绝。

新增实现复用现有参数编译、原 Observation 解析与 V4 来源检查。Core 与 Worker 共用选择枚举，保留实际 refType、来源、完整参数与 envelope 预算、普通参数不变、深冻结及释放检查。没有新增解析器体系、业务事务或调度机制；当前对象有效性、业务归属与权限仍由 App 负责。

`SafeRefInvoker` 专属类型别名退出，共享 `SafeOrdinaryInvoker` 合同保留。两个旧位置的集成测试已在独立 Adapter 测试入口覆盖，实际复跑通过；诊断测试只迁移工厂标记，没有删除原 cause/name/stack/phase 断言。文档及 App Builder skill 同步声明了已实现形状、限制、显式采用语义和迁移方式。

## 独立质量证据

Owner 从记录的实际基线在新临时目录重放补丁，没有使用共享根目录源码替代候选，也没有修改 Clean 的封存交付。

| 验证 | Owner 实际结果 |
|---|---|
| 完整性与补丁 | 2098 件交付文件无差异；补丁重放后 913 件源码和删除项匹配 |
| 独立构建 | Runtime／SDK 构建通过；351＋68 件 dist 逐字匹配交付 tar |
| SDK | 默认测试 180/180；公开 TS7 严格类型检查通过 |
| Runtime | 默认运行 2048 通过、2 项既有诊断失败；另一个 16 项套件首次因 Owner 未安装仓库根依赖而未收集，补齐根依赖后原套件 16/16。合计独立验证 2064 通过、同一 2 项诊断失败，无跳过；首次环境失败日志保留 |
| Adapter 与迁移入口 | 46/46；跨包真实集成 30/30 |
| 正常包消费者 | 新目录 npm 离线安装，Runtime／SDK 的 450 件安装文件与 tar 一致；无源码软链接；Core／SDK 严格公共类型、纯入口及品牌／owner 一致性通过 |
| 两种 Producer | 普通 TypeScript 与真实 SDK／Worker 各 41 次调用，分别 24 成功／17 指定拒绝；41 对完整 handler 见证与终态一致；旧观察 A 与新观察 B 的来源、采用后撤销及最终资源释放通过 |

包消费者复用 Clean 的公开测试输入，Owner 只把输出目录和 npm 配置文件位置改到新目录，未改断言；独立源码回归来自重放后的候选。日志和复跑入口均保存在上述 Owner 证据目录。

Clean 另外完成的 Planning 15 项测试与原 27 次调用、Terminal 8 项、Browser 3 项、IDE 行为核验、原 `run.sh` 九模块构建和 GUI bundle，本轮作为执行方证据复核，没有冒充 Owner 再次独立运行的结果。原根入口 Planning 采用已在上一整合任务单独验收。

## 保留问题与下一步

Runtime 的 INIT／OPEN 异常详情两项失败仍归 SRT-10。同一迁移后 fixture 在起点也得到 2 失败／1 健康对照通过，且本候选没有修改生产异常转发；不因此要求 Ref 任务扩入诊断治理，也不称全仓全绿。Driver 上游完整严格声明、原生 LSP 及真实模型／GUI 人工验收的既有边界保持。

下一条执行指令：View 完整任务的 R1 修订通过后，交 Clean 一次完成两项成果的隔离整合，合并公共文档、匹配版本和消费者，验证同一套包及原启动链；Owner 对合并交付统一验收并按差异采用到根目录。当前唯一实际共享文件冲突是 `deepseek_review.md`，由 Owner 保留两项最新状态合并，不能用候选旧索引覆盖。不得覆盖共享 main、推送、合并 Git 或发布。
