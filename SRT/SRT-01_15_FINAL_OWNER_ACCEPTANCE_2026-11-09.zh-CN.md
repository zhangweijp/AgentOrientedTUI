# SRT-01～SRT-15 完整工程验收与根目录采用

2026-11-09，SRT Owner。**结论：APPROVED_ADOPTED。原定SRT-01～SRT-15工程任务全部完成，已进入实际根目录。当前没有待处理的实现或采用阻断，没有新增人工验收前置。**

本结论覆盖完整清单，包含此前漏报的App元数据／身份、结果判别合同、协议来源与提前拒绝，以及对应的文档、正常包消费者和旧入口迁移。此前将已派发批次完成误称为整体完成的表述已经纠正。Planning／Ref／View既有人工签收保留，不要求项目所有者重复操作。

## 分工与最终对象

Clean连续完成整项开发、消费者／文档迁移和必要验证，SRT Owner在完整交付后集中审查。唯一实测P2为缺失local source被目录清单入口替换，已限定修复；随后并入的facades纯转导出退出也已核对。没有为每个小改动单独审批，没有第二位Owner复核Clean代码。

MC执行Agent开发的两组减法由MC Owner唯一复核，SRT Owner直接接收并采用：[升级后19路径](SRT-15_POST_UPGRADE_OWNER_ADOPTION_2026-11-09.zh-CN.md)、[内核14路径](SRT-15_KERNEL_CLEANUP_OWNER_ADOPTION_2026-11-09.zh-CN.md)。它们已成为Clean最终候选基线，不计入Clean新增路径，也未做第二轮代码审查。

- 最终候选：`.tmp/srt-01-15-remaining-20261109`，revision `r02-combined`。
- Clean最终增量：118路径，1新增、115修改、2删除；MC14不在其内。
- 完整patch SHA-256：`965b6eb65e65790dbb2a2657788f1a1c5deadd6c0e9293e9076d4a88878a1abb`。
- 复核后修订patch SHA-256：`9368e5db95fff19dbe1e231b265c497c8a608d8f0ddf059e678dea2b665223f8`，仅7路径。
- 实际根目录：`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI`。
- 采用前后HEAD：`8938449925ada2f92e072e1c0492af8f2428d14f`。保留共享树已有变更，未覆盖main、提交、推送、合并或发布。

[集中复核及原失败](SRT-01_15_FINAL_OWNER_REVIEW_2026-11-09.zh-CN.md)、[最终执行报告](../.tmp/srt-01-15-remaining-20261109/REPORT.zh-CN.md)、[限定修订报告](../.tmp/srt-01-15-remaining-20261109/R02_REPAIR.zh-CN.md)分别保留审查与执行事实。

## 全部15项的完成映射

| 项目 | 已完成行为与范围 | 主要依据 |
| --- | --- | --- |
| SRT-01 单一声明 | Tool定义同时供类型、注册、参数校验和目录使用；实例handler和动态可用性分开 | M4.3 G1–G4及9/9作者验证；既有根采用和当前SDK／包消费者 |
| SRT-02 统一Ref参数 | 普通值与对象、整数组、元素、多个／可选Ref及Ref名数组共用Tool；旧SnapshotTool退出，Planning对象工具免抄业务ID | Ref＋View联合批准、两Producer及Planning27次调用；既有人工签收 |
| SRT-03 显式View元数据 | View显式type／kind，实例id不代替type；五个当前App及两Producer保持合同 | 联合交付、当前文档示例及Token Monitor迁移／构建 |
| SRT-04 串行观察刷新 | 观察等待已提交投影；无变化、失败投影不重做业务操作 | 已批准r02及现有回归 |
| SRT-05 采用与失效 | 采用新Observation撤销旧调用／Ref资格、释放旧专属持有；预览不擅自采用，注册owner校验保留 | 既有Core／Receiver1159项、真实Worker／Source和当前资源释放 |
| SRT-06 Driver边界与工具链 | B独立薄适配包；Runtime／SDK不依赖具体Driver；TS7、完整Driver／Host严格类型及IDE原生后端已落地 | SRT-06最终33路径采用、真实6次Driver→Worker→IDE调用；精确临时补丁限制保留 |
| SRT-07 唯一包装 | View元数据与正文分离；Runtime包装编码一次，Host解码一次，CR／LF及原样正文保真 | 联合验收、六组XML／Host逐字符验证及人工页面签收 |
| SRT-08 单App失败隔离 | 声明、命名和投影失败隔离对应App，诊断与清理保留，健康App仍可用 | 既有42项独立组合和当前Adapter46项 |
| SRT-09 元数据与身份 | 工厂唯一手写来源、现有生成器、静态manifest发现；注册／Worker／AppKernel身份核对；原生别名限制在适配边界；View局部类型展示、调用指定view_id | 当前Registry、身份测试和缺失源修复；既有双View Ref验收 |
| SRT-10 结果与诊断 | success判别联合、JSON错误记录；保留none／partial／unknown、未进入handler及本地INIT／OPEN诊断 | 严格正反类型、Core／Worker捕获和六种真实Worker结果 |
| SRT-11 有据减法 | 沿用测量支持的重复recheck删除；时钟回拨拒绝后可恢复观察／调用，释放归零 | 独立236项及本轮10→9→10检查；不外推普遍提速 |
| SRT-12 当前文档 | 指南、示例、skill、迁移、支持组合和总索引同步当前合同；旧Driver阻断表述已纠正 | 既有24路径作者交付及当前正常安装包文档编译／运行 |
| SRT-13 协议与兼容 | 所属SPI／Core常量复用；工厂／端口v4，Snapshot仍3；INIT／ACK提前确认Snapshot及全部请求能力，旧组合明确拒绝 | 九类协议清单、握手测试和当前匹配包严格消费 |
| SRT-14 包与作者 | 正常四包安装、两Producer、Tool／Ref真实调用和关闭释放；新作者限定试用沿用有效结果 | 最终462文件载荷核对；既有作者一次构建、0修复／0私有API、10帧11调用 |
| SRT-15 迁移与退出 | 旧作者／Ref入口及专属实现退出；既有20路径、MC19／14路径减法已采用；本轮配置、结果、协议、发现回退与导出消费者迁移完成 | 对应唯一负责人批准、实际根采用及删除产物核对 |

每项详细历史与证据统一从[唯一索引](../deepseek_review.md#review-todos)定位；不再建立另一份待办列表。

## 质量证据及实际采用

证据按所对应产物复用，不将上一版全量结果伪称为最终组合又重跑了一遍：

| 层次 | 结果 |
| --- | --- |
| Clean完整r01有效检查 | Runtime131文件2096项、SDK20文件188项、Adapter46项；IDE63项及收据专项；Planning15／Terminal8／Browser3／Token1。构建、严格公开类型、两Producer与正常包检查通过，共34项最终检查记录。 |
| MC14唯一批准证据 | MC独立Runtime54＋SDK28项，正常包普通／Ref两调用及释放通过；执行方Runtime2089／SDK187完整检查按其基线有效。删除的3项仅测试已退出Desktop observer，不混计为失败或跳过。 |
| r02-combined直接相关检查 | Registry与两集成文件27/27；Runtime／SDK构建、完整公开严格类型、工厂／配置／Desktop／关闭、实际CLI help通过。15个公开运行时符号集合保持。 |
| Owner独立实际包检查 | r01六次真实Worker结果为succeeded／failed／failed／unknown／unknown／rejected，关闭释放且scope／bytes为0。原缺失源accepted:true已保留；最终包同一反例独立复验为拒绝，code／path正确，目录与有效显式入口仍成功，退出0、0.079秒。 |
| 最终四包 | 正常安装462文件与tar及候选逐字节匹配；Runtime342、SDK86、Adapter14、Driver20。依赖解析指向同一Runtime／Driver，安装shim单列。 |
| 实际根采用 | 118个before逐项匹配并备份，全部after和2项源码删除匹配；App Builder受保护文件也已获工具授权采用。两个退出源码的8个可能dist路径均不存在。 |
| 实际根必要检查 | 根冻结离线安装0.385秒、Token变更锁文件安装1.265秒；原run.sh九模块构建6.866秒；Token构建1.387秒；Host严格类型0.507秒。全部退出0。 |

[Owner采用身份与命令](../review-evidence/srt-01-15-final-owner-20261109/adoption.json)、[最终修订身份核对](../review-evidence/srt-01-15-final-owner-20261109/r02-identity.json)及[根验证日志索引](../review-evidence/srt-01-15-final-owner-20261109/root-validation.json)保留可追溯记录。没有操作用户正在运行的Host或业务数据库，没有重复GUI／真实模型／人工Planning流程。

## 最终包身份与边界

最终包只使用`.tmp/srt-01-15-remaining-20261109/artifacts/r02-combined`；旧artifacts和中间r02均保留为历史。

| 包 | 版本 | SHA-256 |
| --- | --- | --- |
| Runtime | 7.0.0-srt.1 | `4e70e8cbe8726f96722c06053693572414c01c0173c6c446d30d96755fe7dfca` |
| SDK | 0.8.0-srt.1 | `a51b266cbe9952c58cabe610992a28134e66b5fd4e5fb70ed2f5ef3f9013d75c` |
| Adapter | 0.4.0-srt.1 | `cf40c333401e1f3645a87f6f5a51e1b7a32519b8b4ba756db89af48c1e664c94` |
| Driver | 0.3.0 | `eea0fb06299519ad511f1f2cd29e82c31004b2e34c336de7b3c8211113689874` |

Driver精确声明补丁及原生LSP本地修复仍明确列为当前支持条件，原生资格限darwin-arm64；不能宣称上游正式包已修复。当前包尚未发布。

Ref字段访问、View／App／全局作用域、基础类型体系仍是用户明确未来TODO；并发和资源策略整体重设计暂缓，D3取消。独立lint／RSS专项不由本次签收关闭，不扩大为本清单新关卡。此次完成范围内没有遗留实现任务。

## 下一条执行指令

本轮代码执行任务结案，当前不再向Clean派发小修或追加矩阵。实际使用入口仍为根目录`./run.sh`，下次正常重启会加载已采用的匹配源码与构建；无需项目所有者重复人工签收。后续新增功能、正式发布或明确暂缓项，应依据新的任务指令推进。

持续推进方式已记录在[AGENTS第十一节](../AGENTS.md#十一2026-11-09-反馈按开发线承担一次负责人复核)：明确完整任务、连续实施、完整交付后由对应Owner集中复核并采用，不等待额外聊天确认。向MC Owner重复发送采用状态被自动审批拒绝，已停止发送；仓库采用记录完整，该通信限制不影响本次交付。
