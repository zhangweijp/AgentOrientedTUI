# 升级后旧代码清理：实际根目录采用

2026-11-09。**APPROVED / ADOPTED。** 直接接收[MC Owner整项独立验收](../MINIMAL_CORE/MINIMAL_CORE_POST_UPGRADE_CLEANUP_REVIEW_2026-11-09.zh-CN.md)，已将批准的19路径采用到实际根目录；没有第二轮代码审查或重复行为矩阵。

批准patch的SHA-256为`ee512a0b8df6a13ac71d89e6bfa7996e4f2c37088ec42362f6047eda3b78e93c`。采用前19个目标均匹配before，19份原件已备份；应用后12个修改文件逐项匹配after、7个退休文件不存在，没有覆盖Clean的其他文件。

此次清理删除IDE旧全局文件／LowDB持久化／LSP服务链、四个专属依赖和Host失效脚本，Runtime复用已有Tool定义中的Schema。生产净减1769行、测试净减126行、配置／锁文件净减281行；当前会话、文件操作、原生LSP、文本替换及明确保留的旧数据导入继续存在。

采用验证仅覆盖实际需要的安装和构建：

| 根目录命令 | 结果 |
| --- | --- |
| IDE `pnpm install --frozen-lockfile --offline --store-dir /Users/zhangwei/Library/pnpm/store` | 通过，0.349秒 |
| Runtime `pnpm run build` | 通过，0.576秒 |
| IDE `pnpm run build` | 通过，0.846秒 |

采用后再次核对全部after。7个退休源码对应的28个可能构建产物位置均不存在，原生程序仍可执行；不把从未生成的测试产物计算为实际删除量。

质量证据沿用MC唯一裁决：执行方Runtime2092、SDK187、IDE63项及受影响集成／LSP／严格包消费通过；MC Owner独立13项与5组真实Worker场景44次调用通过、释放归零。SRT Owner没有重跑这些测试。

原件、命令与实际结果见[采用记录](../review-evidence/srt15-post-upgrade-owner-adoption-20261109/adoption.json)和[安装构建记录](../review-evidence/srt15-post-upgrade-owner-adoption-20261109/validation.json)。HEAD仍为`8938449925ada2f92e072e1c0492af8f2428d14f`，未提交、推送、合并或发布，未操作用户Host或数据。

本次清理无剩余阻断。**下一条执行指令：Clean吸收这19路径作为当前基线，连续完成已派发的SRT-09／10／13及关联文档和消费者整项交付，完整交付后由SRT Owner集中验收。** Runtime `view-owned-tools.ts`的写入占用已解除；必要协议常量迁移应保留本次减法。整份SRT-01～SRT-15仍未全部完成，不将本项采用等同于总体完成。
