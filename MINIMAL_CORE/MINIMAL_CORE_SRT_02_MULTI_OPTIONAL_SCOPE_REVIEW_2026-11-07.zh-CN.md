# SRT-02 多 Ref／可选 Ref 范围 r03 独立复核

2026-11-07。执行：SRT Owner。独立复核：Minimal Core 负责人。

**范围 r03 APPROVED；下一批隔离基线准备及无 Worker 验证准入 APPROVED。** 本次没有批准新能力实现、真实 Worker 运行、共享采用或最终 Semantic 验收。Driver 完整集成仍为 CHANGES_REQUESTED，不阻止本批无 Driver 的准备。

这批准备的目的，是让一个普通工具能够接收多个页面对象，并允许某个对象参数缺席。继续使用现有 `refParam`、`Type.Optional` 和 ViewType Tool，减少作者绕行和重复解析；必要的来源解析、累计参数与清理仍由现有 Runtime 负责，不增加工具类别或状态管理器。

## 1. 精确输入与独立核对

批准范围是 [SRT-02_MULTI_OPTIONAL_REF_SCOPE.zh-CN.md](../SRT/SRT-02_MULTI_OPTIONAL_REF_SCOPE.zh-CN.md)，SHA256 `100ded72278bf46a06445ceda35b1b37beec260be035dfc4471fb736e6aac7bd`；[15 件 r03 清单](../review-evidence/srt-02-multi-optional-scope-20261107/submission-r03.json) SHA256 `8a1c2df00378af9423118e96077c5665f74a02ccdeebe96f43566ad24e8aec6d`。

负责人实际核对 15/15 件提交、B r02 的 738/738 源码及新准备副本的 738/738 源码，全部匹配封存 manifest；准备副本为不同 inode 的物理副本，原源码未变。见 [身份审计](../review-evidence/srt-02-multi-optional-scope-20261107/owner-review/r03-identity.json)。

已读取三个 Runtime 责任落点：正式 profile 的声明限制、参数准备的累计解析和缺席处理、Worker 参数验证的逐字段对应关系；SDK 现有 ArgsOf 与 Schema witness 作为待验证输入，不预设新增 API。范围包含对象／列表的顶层组合与可选字段；Ref 名数组、多选、嵌套 Ref、属性路径和 SRT-05 均不在本批。

## 2. 修正验收承诺，保留既有职责

r01 将全部 payload 篡改写为 Worker 能拒绝；r02 仍遗漏非空 viewId／viewInstanceId 改值的边界。两版原件和 CHANGES_REQUESTED 事实已保留。r03 清楚区分：

- 可信 Runtime 根据原 Observation／Snapshot 解析原值与真实来源，并维护原有授权、绑定和不可变值。
- 参数验证器检查 schema、raw／effective 普通字段、来源的结构与数量、字段对应及预算；它不持有原 Snapshot，不能独立认证所有形式自洽的改值或来源。
- 真实 Worker 还检查 App 实例、协商能力和当前 Tool 绑定，不能用纯验证器代替完整调用。

负责人核对七个实际执行模块与封存 Runtime tar 逐字一致，独立重跑原六场景，又在自己的 Note 试件验证 11 个场景；随后独立重跑最终 r03 的 21 个场景，完整输出与执行方一致。合法形状的 payload 改值、非空 view／mount 改值和 raw／source 一致改名在该验证器层被接受；格式、schema、相对字段一致性和预算错误按现有逻辑拒绝。见 [负责人补充边界探针](../review-evidence/srt-02-multi-optional-scope-20261107/owner-review/boundary-review.json)及 [r03 独立结果](../review-evidence/srt-02-multi-optional-scope-20261107/owner-review/r03-independent-result.json)。

这些是现有纯函数的边界事实，没有创建 Runtime 或 Worker，没有 handler 调用或 Snapshot 查找。没有为扩大验收承诺而加入签名、独立认证或另一套状态。静态模块闭包也不被当作通用安全沙箱。

## 3. 下一批具体范围与准出条件

准入目录为现有独占准备目录 `.tmp/srt-02-multi-optional-ref-20261107` 的新消费者／试件子目录，封存 baseline 不改。SRT Owner 独占执行，Minimal Core 独立复核。当前只允许依赖安装、类型与纯 Core 基线试件、证据和具体执行入口准备。

1. 使用精确 r02 SDK／Runtime tar，在仓库外普通消费者正常安装；确认依赖图无 Driver／AI。记录 manifest、lock、包与 Node／编译器身份，不用源码 alias 或手工补声明冒充公开消费。
2. 从公开 SDK 声明及正式 Core 注册／编译入口，分别记录“SDK 能捕获声明”和“正式 Runtime profile 接受声明”。基线必须证明单必填对象／对象列表继续接受，多顶层 Ref／可选顶层 Ref 明确拒绝；不能再次混淆捕获成功与注册成功。
3. 用 TS5.3.3／TS5.9.3 的完整严格选项检查现有 `ArgsOf`：每字段的 readonly payload、可选缺席以及错误形状和写入的负向断言。类型支持即使已存在，也不能推导运行支持已完成。
4. 准备后续必要实现和真实 Worker 入口，列出三处生产差异的预期、拟修改文件、双 Producer、旧新四组合、累计预算、第二个 Ref 失败无业务进入、正常清理等验收。入口必须明确合成 App、运行目录、全部读写路径和清理动作，不能导入真实 Host 初始化或读取用户 profile。本轮只准备，不启动 Worker。
5. 保留原拒绝、意外失败和命令退出码，不能删断言使基线通过。若公开类型先暴露额外 SDK 问题或需要协议变化，给出具体原因和影响，再修订范围。

这些基线和入口形成可审查交付后，负责人独立决定三处实现与真实 Worker 验证的准入；最终补丁仍需独立验收。项目所有者不需要为这一步常规准备再确认一次“继续”。

可直接转交的 Codex Prompt：

> 以已批准 r03 范围和 B r02 的 738 文件物理基线准备下一批，不改封存 baseline 或生产源码。在新的无 Driver 消费者正常安装精确 SDK／Runtime 包，记录锁和包身份。通过公开 SDK 与正式 Core profile 入口分别验证捕获和注册：保留单对象／对象列表正向，多 Ref／optional 的现有明确拒绝；再以两版编译器的 strict、exactOptionalPropertyTypes:true、skipLibCheck:false 验证逐字段 readonly 和 optional 正负类型。只运行类型与纯 Core，不创建 Runtime／Worker，不导入 Host 或读取用户状态。准备三处实现的具体差异和后续双 Producer／真实 Worker 入口、兼容矩阵、累计预算和清理预期，交独立审查。保留 r01/r02/r03 和所有原始失败，不扩大到 Ref 数组、多选、SRT-05、Driver 政策或新信任机制。

## 4. 未覆盖风险

多 Ref／可选 Ref 尚未实现；多个参数的累计预算、来源一致性、旧新组合、真实 Worker 与 SDK 类型都不能由本次范围批准替代验证。Driver 的声明修复分发和编译器政策仍为独立问题；本批不得把正常 Core 消费绿灯扩写为完整集成、共享采用或 Semantic 已验收。
