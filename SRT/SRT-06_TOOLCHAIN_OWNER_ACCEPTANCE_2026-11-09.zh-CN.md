# SRT-06 工具链与实际入口验收

2026-11-09。**SRT-06：APPROVED / ADOPTED。** Clean 的工具链、IDE 原生接入和 Host 消费增量已由 SRT Owner 集中复核并采用到实际根目录，本项没有剩余工程阻断。本报告原先把已派发批次完成写成全部原定任务完成，现按用户明确的SRT-01～SRT-15范围纠正：整份清单尚未完成，状态以[唯一索引](../deepseek_review.md#review-todos)为准。这里的代码采用、测试与质量结论继续有效。

采用对象为[完整候选](../.tmp/srt06-native-integration-20261109/REPORT.zh-CN.md)及其 [Host 增量](../.tmp/srt06-native-integration-20261109/HOST_INCREMENT.json)。两份差异合计33个路径；采用前全部核对当前根原件，备份20个已有文件，再复制已审核差异及两个已验证的原生构建产物。没有用旧 HEAD 重建或覆盖共享工作树。Git HEAD 仍为 `8938449925ada2f92e072e1c0492af8f2428d14f`，未执行提交、推送、合并或发布。

## 最终行为

- Runtime 与具体 Driver 继续通过独立薄适配包连接，SDK／Runtime 本批没有新增业务或 LSP 职责。
- 编译采用 TypeScript 7.0.2。Driver 和 Host 使用 AI 6.0.326、provider-utils 4.0.65 的明确类型补丁；Pnpm 配置与锁文件保证可重复安装。实际本地链接的 Zod 类型上下文统一为3.25.76，旧 provider 的其他主版本依赖保留。
- IDE 默认接入固定7.0.2源码的临时关闭修复，使用随包原生程序、UTF-16位置及标准 pull diagnostics。旧默认包装器和 PATH 回退已退出；版本／实例检查、外部文件更新、容量和关闭责任保留。
- 工具回调暂停 Driver 后，排队中的 Source 更新保持 pending，恢复后才继续执行；不再在暂停状态续轮。
- Owner 集中反馈的实际 Host 配置遗漏及测试命令默认结果路径均已修正。无需新增人工验收流程。

## 质量依据与实际采用

| 范围 | 有效结果及承担方 |
|---|---|
| 当前 Runtime／SDK | MC 执行 Agent 完整运行、MC Owner 唯一复核：Runtime 2092/2092、SDK 187/187，零失败／跳过／todo；两包构建和两项严格公共类型通过。SRT Owner直接复用[正式结论](../MINIMAL_CORE/MINIMAL_CORE_FINAL_CORE_REGRESSION_REVIEW_2026-11-09.zh-CN.md)。 |
| IDE 与普通包 | Clean：Jest 65项、保留IDE流程44次调用、LSP功能／容量／原生接入场景、五包正常冻结安装、严格公开正向及8个独立非法类型项目通过。已通过部分未重复执行。 |
| 暂停修复 | Clean：旧实现反例失败，最小循环条件修复后相关4项通过；保留pending与resume语义。 |
| 安装包实际链路 | SRT Owner独立重放6次 Driver→Worker→IDE 操作：双文件打开、编辑、真实hover、关闭及关闭后误写拒绝。capture／adopt／release各6，关闭成功，Scope／保留字节和Worker池归零，原生PID及进程组消失。 |
| Host 增量 | Clean：实际 Host／Driver 的 AI、补丁和Zod图一致；Host main／preload、GUI及严格完整类型消费通过。原测试命令无结果路径运行的限定检查通过。 |
| 实际根目录 | Owner：Driver、IDE、Host三处 `pnpm install --frozen-lockfile --offline` 全部通过；原 `run.sh` 九模块构建段、Host GUI、`test:driver-types`全部通过。没有启动用户 Host 或真实模型服务。 |

独立重放首次被沙箱禁止执行 `ps`，正常本机权限下重放通过；两次原始结果分别保留。Host联网审批未执行的环境问题已通过先前获准的本地缓存离线安装解决，不构成当前阻断。Driver依赖更新阶段的默认结果为49通过、1个既有skip，暂停增量另有4项结果；不把它们合称最终全仓零跳过测试。

原始事实与备份位于[Owner采用记录](../review-evidence/srt06-native-integration-owner-20261109/adoption.json)、[根安装](../review-evidence/srt06-native-integration-owner-20261109/root-installs.json)、[根构建](../review-evidence/srt06-native-integration-owner-20261109/root-builds.json)及[独立实际链路](../review-evidence/srt06-native-integration-owner-20261109/installed-chain-local.json)。

根采用后已重新打包Driver，纳入最终消费说明与开发依赖。该包SHA-256为 `eea0fb06299519ad511f1f2cd29e82c31004b2e34c336de7b3c8211113689874`；与已通过实际链路的包相比仅 `package.json` 和 `STRICT_TYPES.md` 不同，运行JS与声明逐字节一致，直接复用已通过结果，见[包记录](../review-evidence/srt06-native-integration-owner-20261109/current-driver-package.json)。

## 本次交付与既有 G0–G7 证据的对应

此表说明当前工具链交付复用了哪些证据，不构成SRT-01～SRT-15所有剩余要求完成的证明。

| 原门槛 | 本轮最终对应 |
|---|---|
| G0 基线与安装 | 以已采用工作树为输入，必要差异可追溯；实际根冻结安装和构建通过。 |
| G1 合同与迁移 | 已采用SRT-01至09、12／13的当前合同；本次补齐工具链与Host消费，没有改动Ref／Observation／Scope或协议。 |
| G2 核心行为 | 复用MC当前2092／187完整回归，结合已采用双Producer及实际IDE／Worker链路。 |
| G3 唯一执行与消息链 | 既有Source、Driver、MCP、IM和Host裁决保持；当前实际链路验证单执行，并关闭暂停续轮缺陷。 |
| G4 所有权与释放 | MC当前回归与本次LSP／Worker退出、Scope及payload释放证据覆盖；没有用超时冒充资源释放。 |
| G5 清理落地 | SRT-11／15已采用，旧重复包装与无职责代码已按本轮范围退出；本次继续删除默认LSP旧包装和专属诊断转换。 |
| G6 作者与使用体验 | SRT-12文档／示例、SRT-14新作者试用，以及已有Planning／Ref／View人工签收有效；没有追加重复人工门槛。 |
| G7 组合交付 | 匹配包、实际Host与根运行入口已完成采用及构建；正式注册表发布不在授权范围内。 |

## 保留边界与下一条指令

当前原生LSP资格验证范围为darwin-arm64及普通本机OS权限。采用的是精确的临时类型补丁和源码回移，不表示官方原版7.0.2已包含修复；上游正式修复经确认后可移除这些临时资产。IDE的JS API6仅供开发期Jest，编译与运行的原生后端保持7.0.2。

D3历史消息迁移保持取消。Ref字段访问／数据作用域／基础类型、并发与资源策略重设计保持用户明确的未来或暂缓决定。SRT-09元数据／身份治理、SRT-10结果合同与SRT-13剩余协议来源属于原清单剩余工作，继续执行；它们不撤销本项工具链验收。另列lint／RSS事项按原归属保留，不借本项扩大成新的治理项目。

**下一条指令：完成[SRT-01～SRT-15剩余交付](SRT-01_15_REMAINING_DELIVERY_CLEAN_TASK_2026-11-09.zh-CN.md)，与MC升级后旧代码清理衔接。** 使用当前已采用版本仍可从仓库根目录运行 `./run.sh`；已有人工签收有效，不要求项目所有者重复验收。提交、推送、合并或发布仍未执行。
