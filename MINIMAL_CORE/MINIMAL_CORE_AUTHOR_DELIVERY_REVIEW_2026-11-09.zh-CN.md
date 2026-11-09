# SDK 作者交付：完整独立验收

**APPROVED，可按24项精确差异采用。** 2026-11-09，延续2026-11-08完整任务。本次统一审查整份作者材料、示例和运行接线，独立正常安装并执行文档示例通过；没有阻断项。共享采用由SRT Owner完成，本报告签署时尚未采用。

**交付解决的问题。** 当前入口统一为静态Tool声明、App绑定和View投影；清除M1／M2／M3阶段教程及“已采用能力仍是候选”的过时说明。文件示例继续使用路径，Preact和普通TS复用一份`file-tools.ts`；笔记Ref的完整实现只维护在`ref-app.tsx`，指南引用实际可运行文件。展示类型提示与调用`view_id.local_ref`明确分开，Root仅列工具名，业务数据与收据各走已有路径。Core文档中的函数签名错误和Host示例漏采用Observation已修正。

App负责业务状态与业务检查；SDK共同controller负责绑定，Runtime／Source继续负责观察、调用资格、Ref解析与释放。普通TS的低层Producer接线仅在验证侧，作者controller使用已有公开端口，没有把框架机制转嫁给App，也没有新增内核、API、协议、版本、依赖或兼容分支。读者可沿一条当前指南进入实际示例，不必了解旧批次名称或在重复实现之间选择。

**精确范围。** 24路径：20修改、4新增，均属于作者指南、skill、示例或现有验证入口。负责人用当前before实际重放24项，结果与候选after全部一致；另核对312份生产源码与配置，与共享树相同。上游SRT-10是已采用输入，不属于本patch。

- 候选：`.tmp/author-delivery-20261108/candidate`。
- [完整patch](../review-evidence/author-delivery-20261108/author-delivery.patch)，SHA-256：`0ccdc11e6cddc47b54ff18c5341824868b943419591f277b5c310344ba05c531`。
- [采用路径与before／after](../review-evidence/author-delivery-20261108/changes.json)；[负责人重放与输入核对](../review-evidence/author-delivery-owner-review-20261109/identity.json)。

**独立运行结果。** 负责人在新目录`/private/tmp/aotui-author-owner-consumer-2zfiwv6_`正常frozen／offline安装最终四个tar，复跑已有`verify-docs.mjs`。源码未替代被测包，所有临时业务数据位于私有测试目录。

| 验证 | 负责人实际结果 |
| --- | --- |
| 正常包内容 | 四包490份安装文件与tar逐字节相同 |
| 文档与完整示例编译 | strict、exactOptionalPropertyTypes、skipLibCheck:false通过；纯Core另以ES2022-only／types:[]通过 |
| README、文件与Ref App | 实际Worker运行通过；多App隔离、共享工具、最新页面、短收据、View定位、多个／可选／有序重复Ref选择及错误拒绝成立 |
| 普通TS controller及Core／Host原例 | 打开／编辑／观察／关闭、采用与旧资格拒绝通过；Core保留旧／新Ref见证与持久值恢复 |
| 清理 | 四个Runtime均报告resourcesReleased；普通TS路径Scope／lease／逻辑字节／绑定归零 |

[独立命令与退出码](../review-evidence/author-delivery-owner-review-20261109/commands.json) · [完整编译和运行事实](../review-evidence/author-delivery-owner-review-20261109/documentation-results.json) · [实际安装身份](../review-evidence/author-delivery-owner-review-20261109/package-identity.json)。执行方四包构建、SDK静态类型及51项相关测试属于其证据，未与负责人结果重复计数，也未重复运行无关全量套件。

**边界。** 使用已封存的依赖缓存并跳过安装脚本，不表示registry发布或原生安装脚本验收。完整Driver第三方严格声明、原生LSP及新的模型作者评测未在本批执行。普通TS示例展示现有Producer合同，不提供新的无DOM应用工厂。前批人工签收保持，不因文档收口重开。本项不代表全部SRT治理或未来Ref能力完成。

**下一步范围、准出与执行Prompt。** SRT Owner按上述24路径采用，保持生产内核、包版本和其他并行修改；核对目标before及采用后after即可，不追加第二轮相同代码复核或全项目测试。采用完成后更新唯一索引和当前作者入口状态。

> 采用本报告APPROVED的作者交付，使用changes.json的24路径before／after核对并保留必要回退原件，不整树覆盖。负责人已独立完成正常包文档编译与真实运行，生产源码未改；本次采用只需核对实际差异落地，不重复行为矩阵。回传采用完成事实和任何实际漂移，保持已签收历史及用户数据不变。
