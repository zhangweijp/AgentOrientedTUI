# 12. 完整快照语义下的性能方案

文档 ID：AOTUI-D12 · 修订：0.5 · 更新：2026-11-18（Asia/Shanghai）

**第二批已验收。P0 只在生成新快照时计算诊断摘要。** 改前基线为 `90449dc2d` 加首批工作树变更。本批收益、尾延迟和兼容范围见第 4 节。P1–P3 各自等待对应瓶颈的证据。

## 1. 先看三页 IDE：只编辑一份文件，究竟要更新什么

Agent 的 IDE 当前打开三个页面。`files` 是 `FileList` 类型的 Files 页，只列文件名；`editor` 是 `FileDetail` 类型的 Editor 页，显示 `test.txt`；`search` 是 Search 页，显示本例中不受此次编辑影响的一组结果。Agent 编辑 `test.txt`，只有 Editor 的正文发生变化。

| 页面 | 这次变化 | 可以省掉什么 | 仍须保证什么 |
| --- | --- | --- | --- |
| Files：`files` | 文件名正文不变 | 复用已捕获的正文与未变节点 | Ref 值若带版本等信息，要单独判断变化 |
| Editor：`editor` | `test.txt` 正文改变 | 静态工具定义不必重新编译 | 新正文与该次提交的 Ref、能力兼容 |
| Search：`search` | 本例中整份页面记录不变 | 复用已拥有的不可变页面记录 | 新完整快照仍包含它 |

**新的快照仍包含三页。** P0 沿用完整捕获与编码。假如今后测出复制未变页面占了主要成本，P2 才值得让新快照引用 Files 和 Search 已捕获的不可变记录。跨 Worker 交付一份完整快照时，仍要处理这三页的输出。

Files 的 ArrayRef 可显示为 `[测试文件](File:results[0])`。沿用 02／09 的示意，若某个工具声明了 `target` 这个 Ref 参数，调用可以是：

```json
{ "view_id": "editor", "target": "files.results[0]" }
```

这是说明两个定位独立的示意，**不是声称现有 IDE 的 `edit_file` Schema 有这个参数**。`view_id` 选择接收页面；`files.results[0]` 选择原观察中的值。显示地址与调用地址保持各自形式。Editor 之后也可以在同一页面内切换为 `notes.txt`，本方案不要求“一页永久绑定一个文件”。

模型取得 Observation O1 后，本轮输入已经冻结。当前快照可以前进到 S2，O1 和在途调用继续持有 S1 所需的数据。若采用 P2，两份快照可以共享未变页面，分别保留 Editor 的新旧内容。采用新观察会撤销旧观察的新调用资格，已分发调用在终结时才释放其持有。若磁盘在模型思考期间被外部修改，文件版本冲突仍由 App 判断。

这个例子也划出了优化禁区：**正文不变，Refs、enabled 或当前闭包仍可能变化。** 不能只看文字相等，就跳过绑定提交；更不能用缓存取代调用前的实例、激活和授权检查。这里真正要减少的是重复复制、编码和诊断计算。

## 2. 用户问题与固定边界

用户原话：**“完整快照语义，不等于每一层都必须重新计算整份数据”——给出最合理／最极致的优化方案。**

本方案遵守以下已明确约束：

- “AOTUI 的一个 View 实例对应的就是 GUI 网站内／桌面应用的一个页面”；不把 View 强制绑定为一个永久业务对象。
- Ref 的显示地址与调用地址不能统一；优化只改变内部存储与传输，不改变这项设计。
- 开页相关问题暂缓；本议题不调整开页准入、撤回或上下文预算策略。
- 成功 Observation 仍表达完整已提交页面集合；原 Observation 的 Ref、在途调用持有、实例／激活检查、授权后复查与 Worker 端验证都保留。
- 默认作者模型仍为 Preact；同一 Agent 的串行调用主路径不变。默认 Node Worker 托管可信 App，不是权限沙箱；本方案不增加并行调度。

**P0 已把诊断摘要计算收敛到实际发布分支。** 同域结果复用、页级共享和传输优化各自按瓶颈证据决定。评价收益时计入完整观察的输出成本、错误恢复和持有释放责任。

## 3. 比较方案：最少长期责任，换取当前确实需要的收益

按仓库 [Minimalist](../../.agents/skills/minimalist/SKILL.md) 的原则，先判断现在是否需要，再复用现有所有权、标准能力和依赖。代码最少不自动等于责任最少：省掉一个真实边界检查，会把错误恢复责任留给所有 App；增加一个只为未来缓存服务的 owner，也会扩大长期维护面。

| 方案 | 三页例子如何工作 | 优势 | 代价与适用条件 |
| --- | --- | --- | --- |
| A. 保持全量复制、验证、编码与 hash | 捕获、接纳等相关阶段处理完整三页 | 路径直观，维持当前基线 | 重复工作随完整体积增长；适合小数据基线，不是长期性能目标 |
| B. 已拥有的 validated candidate＋页级共享 | Editor 建新节点，其余已确认未变节点复用；完整根一次发布 | 减少同域重复工作，不增加网络协议；可以分别评估 | 必须证明不可变、真实所有者及对应成本；**重复捕获或分配成为瓶颈时优先考虑** |
| C. 基于已确认根的 delta＋base ACK | 两端持有同一基线时只交付变化，再形成完整根 | 传输是主要瓶颈时可能收益明显 | 增加基线保留、序列、缺口、重同步与退出责任；不要求先做完 B，按测量证据启用 |
| D. 独占字节 transfer／共享内存 | 尝试避免复制传输字节 | 特定大字节负载有上限收益 | transfer 要证明独占；共享内存另需同步与不可变协议，当前不默认采用 |

首项诊断优化可以独立发生在 A 上，无须先建设 B 的句柄或页共享。若它已消除实际热点，就保留全帧基线；若仍有重复捕获、分配或传输瓶颈，再分别选择对应候选。继续复用现有 Ref 捕获、Schema 缓存和生命周期，不新造缓存平台。所谓“最极致”，应包含维护成本和出错面，而非只追求某个循环更快。

## 4. P0 实现、复测与历史基线

准备端与接收端继续分别调用同一验证函数。它捕获 JSON、检查 View／Ref／Tool 关系，并生成完整 canonical 字符串及用于容量计量的 UTF-8 字节。改前两个调用方都要先算 FNV，再处理各自的下一步。相关入口见 [Projection Coordinator](../../runtime/src/core/projection/coordinator.ts) · [Snapshot Store](../../runtime/src/core/snapshot/store.ts) · [快照验证](../../runtime/src/core/snapshot/validate-snapshot.ts)。

另外，[captureRefEntries](../../sdk/src/app-factory/refs.ts) 先捕获整个 ArrayRef，又逐项调用 capture；[Ref Capture](../../runtime/src/core/snapshot/ref-capture.ts) 每次会复制数据。这使数组整体与元素的同一业务值被多次物化。Schema 已有 [WeakMap 缓存](../../runtime/src/core/tool/tool-parameters.ts)，不应误写成“当前每次都重新编译”；剩余问题是新快照仍要遍历、编码 Schema，并为新对象建立缓存关联。

### 实现与结果合同

`prepare` 取得 `draft` 与 `canonicalContent` 后，在容量检查前释放对临时验证结果的引用。Store 完成来源、顺序、完整 canonical 判等及容量检查后，`unchanged` 返回原 Snapshot 对象，`published` 用验证时生成的字节运行一次原有 FNV。字节只在本次处理期间使用，公开 `AppSnapshot.contentDigest` 仍是普通字符串，序列化格式与现有快照持有路径沿用原合同。[摘要算法](../../runtime/src/core/snapshot/json.ts) · [AppSnapshot 类型](../../runtime/src/core/snapshot/types.ts) · [固定值与恢复测试](../../runtime/src/core/snapshot/validator.metadata-boundary.test.ts)

### 本批同机对照

Apple M2 Pro，Darwin arm64，Node `v24.15.0`。从改前和改后源码独立构建 Runtime，按改前、改后、改后、改前顺序运行。每轮各分支预热 12 次、采样 40 次，每版本每分支共 80 个样本。两边先对 4 KiB 做 384 次同算法预热。每个样本校验返回状态，真实变更交替发布两份正文，重复发布核对返回对象身份。计数在计时结束后另跑。

| 正文总量 | `prepare` p50/p95（ms）| `published` p50/p95（ms）| `unchanged` p50/p95（ms）|
| --- | ---: | ---: | ---: |
| 64 KiB | 1.129/1.580 → 0.244/0.314 | 1.120/1.190 → 1.170/1.609 | 1.100/1.213 → 0.236/0.355 |
| 512 KiB | 8.964/9.722 → 2.020/2.534 | 9.046/10.363 → 8.964/9.883 | 8.995/9.536 → 2.011/2.952 |
| 2 MiB | 35.589/37.727 → 8.045/10.376 | 35.813/37.119 → 35.705/36.602 | 35.741/36.412 → 7.977/10.100 |

各负载的三条分支均编码一次完整 canonical 内容。FNV 次数按 `prepare`、`published`、`unchanged` 顺序从 `1/1/1` 变为 `0/1/0`。2 MiB 通过纯 Core 数据上限，默认托管准入返回 `OBSERVATION_CAPACITY`。另用真实 Worker 各采 25 个样本，约 976 kB 草稿的 `array_ref` 负载从调用到取得下一观察的 p50 为 108.603 → 81.986 ms，重复观察为 29.275 → 15.894 ms，帧字节数一致。这些数据度量本地运行时工作。

首轮计数干预了 V8 后续优化，已移到独立计数阶段。另一次混合冷跑中，基线较早累计足够的 FNV 调用，2 MiB `published` 出现 35.915 → 48.816 ms 的差异。同机单独运行 `published` 得到 48.562 → 47.722 ms，等量预热后以表中数据为准。初版实现还在容量回调期间额外保留了 524,914 字节的编码缓冲。释放验证结果引用后，512 KiB 探针在容量回调、持有旧快照和关闭后的差值均为 0。

开发复测通过 281 项 Runtime 测试、7 步离线包消费检查。负责人验收独立重跑其中 23 项快照与协调器测试，按原始样本重算表中分位数，并逐字节核对安装 Runtime 的 264 个 `dist` 文件与本批归档。随后用原封保留的 Work Items 四个文件重跑两条路径。默认 Worker 和独立 Core 共完成 6 轮，模型替身在 HTTP 发送边界收到 4 个真实序列化请求，产生 11 份业务调用收据，9 次成功、2 次旧挂载调用在分发前被拒。关闭后两端的持有计数归零。该证据覆盖同版本 SDK 0.9.0、Runtime 8.0.0 的两次构建。[快照测量](../../runtime/scripts/snapshot-processing.mjs) · [包消费校验](../../sdk/tests/package-consumer/verify-package-consumer.mjs) · [双路径用例](../../sdk/tests/fixtures/assembly-consumer.mjs)

验收保留了两个限制。64 KiB 的真实变更发布 p95 从 1.190 升至 1.609 ms，这条分支继续承担一次必要摘要。512 KiB 的持有探针在改前、改后的容量回调、旧快照持有和关闭处均未测到额外编码缓冲；探针只度量这些位置的 ArrayBuffer。模型任务成功率、token 及全进程 RSS 需要各自的测量。

```sh
node runtime/scripts/snapshot-processing.mjs "$BASE_RUNTIME_DIR" "$SDK_DIR" digest 40
node runtime/scripts/snapshot-processing.mjs "$NEW_RUNTIME_DIR" "$SDK_DIR" digest 40
node sdk/tests/package-consumer/verify-package-consumer.mjs "$CONSUMER_DIR" "$EVIDENCE_JSON" full
```

### 历史测量记录

在同一远程 Mac、Node `v23.11.0`，将当时 `90449dc2d` 的源码用 esbuild 内存打包，5 次取中位数，单位 ms：

| 正文总量 | prepare | publish | 单独诊断 FNV | 原生 SHA-256 对照 |
| --- | ---: | ---: | ---: | ---: |
| 64 KiB | 2.143 | 2.054 | 1.441 | 0.027 |
| 512 KiB | 16.005 | 15.049 | 10.202 | 0.206 |
| 2 MiB | 59.394 | 60.045 | 40.007 | 0.791 |

这是合成字符串、多页纯 Core 微基准，没有 Worker、Preact 或模型请求。2 MiB 不代表默认托管 Observation 的准入能力；重复 publish 最终可返回 unchanged，仍支付前置成本。不同阶段的中位数不能相加冒充端到端实测。SHA 列只说明诊断实现的优化空间，不主张向纯 Core 引入 Node 专属依赖，也不据此宣称任务成本降低。

## 5. 各候选按现有所有权落地

默认执行端由 AppKernel 组装当前实例的绑定登记与本地投影。调用端由 interaction 管理已接收快照、Observation、资格与持有。Worker 托管层管理通信与物理退出。P0 复用接收端 Store 作出的发布判断。将来若采用缓存，缓存也应跟随实际持有者的生命周期。公开装配入口的取舍见 [03](03-core-assembly.md) 和 [04](04-execution-backend.md)。

validated handle 属于这些所有者内部，不进入 [05](05-compatibility-and-distribution.md) 的最小 AppContract。共享的静态合同或纯验证函数可以复用；执行端与调用端不共享一份可变 registry。作者层 Preact 桥、DOM 转换及 Ref descriptor 分别沿用 [06](06-preact-semantic-bridge.md)／[07](07-dom-adapter-boundary.md)／[08](08-ref-authoring-scope.md) 的边界。

### 5.1 捕获后的值由内核拥有，内部传句柄

公共 `unknown` 输入继续完整捕获、限制检查和规范化，不能冻结调用者的业务对象，也不能相信 `readonly`、`Object.freeze()` 或调用者提供的“已验证”标记。捕获成功后，由本端已有所有者私有的 WeakMap 登记空句柄，保存不可变树、已验证合同和计量结果；同域内后续阶段复用它。三页例子中，已经捕获的完整候选从本端 prepare 进入 commit 时，不必再复制另外两页。

```ts
// 提案：本端已有所有者私有，不能作为跨 Worker 的授权凭证。
let records = new WeakMap<object, OwnedFrame>();
function captureExternal(input: unknown): object {
  const owned = captureValidateAndMeasure(input); // 唯一拥有的不可变值
  const handle = Object.freeze({});
  records.set(handle, owned);
  return handle;
}
function commitPrepared(handle: object) {
  const frame = records.get(handle);
  if (!frame) throw invalidHandle();
  try {
    checkOwnerLifecycleAndSequence(frame); // 动态事实仍检查
    publishCompleteRoot(frame);            // 不再复制、重编译或全量编码
  } finally { records.delete(handle); }    // 候选只结算一次
}
```

WeakMap 解决本域来源资格，不是预算或释放方案。每个候选仍须满足有效投影上限；句柄方案还要在既有 owner 内明确可同时保留候选的数量、总字节上界和结算位置，不能假定 WeakMap 自动提供这些保证。优先复用当前候选生命周期，不因句柄可被持有就开放无限候选；具体上界须在实施时结合现有生命周期确认，不在本文冒充已有配置。容量策略仍归 Host，不新增 App 可调 setter、动态配额或缓存管理平台。候选提交、拒绝或显式释放后删除登记，实例关闭时替换登记表；调用者仅保留空 token 不应继续保住候选树。current、Observation、在途调用仍显式持有根；关闭后撤销调用资格，最终持有者结束才释放数据。不能让强引用缓存保留全部历史，也不承诺释放引用后 RSS 立即下降。

### 5.2 完整逻辑帧，增量物理构建

Snapshot 的逻辑结构仍是“有序 View 集合＋Ref 目录＋Tool 能力”；实现改为共享不可变记录。仅改变的页面正文、Ref 值、元数据创建新节点，未变节点沿用。新根一次发布，旧根及其引用的旧节点保持不变。结构共享可参考 [Immer 的原始状态与未变节点共享机制](https://immerjs.github.io/immer/produce/)，但不要求 SDK 作者使用 Immer，也不默认增加依赖。

先采用页级记录和普通索引；只有页数／索引复制成为可测瓶颈时，再引入持久化映射或分块树。作者反复重建或原地修改任意对象时，框架无法仅凭对象地址识别未变，仍须捕获；只有内核拥有且不可变的节点身份才是复用依据。不要维护第二份“当前业务真相”。

每个节点可以缓存 canonical 片段、精确 JSON UTF-8 长度和必要的结构计数。缓存须包含实际序列化版本、字段顺序与转义规则；拼接时计入逗号、括号和封装元数据。字符串拼接本身可能复制全部内容，只有真正需要平面字节时才展平。字节预算不等于模型 token 预算，Host 对最终请求的职责不变。

### 5.3 ArrayRef 与静态 Schema 专项复用

ArrayRef 将数组值捕获一次，整数组 Ref 与元素 Ref 记录指向同一不可变根，元素使用经验证的 index selector。三页例子的 `results` 整体与 `results[0]` 不再保存两份文件值；显示仍为 `[测试文件](File:results[0])`，调用仍为 `files.results[0]`。可见性、类型、多选、可选参数与跨页选择能力不变。索引必须针对原快照检查；哪怕 Files 后来重排了数组，旧调用也不能改为读取新第零项。

保留现有逻辑 Ref 数量及单值限制；物理保留字节另计，不能以去重为由暗改准入。若线协议仍重复展开每项 payload，跨 Worker 收益会丢失，因此根＋selector 若进入 DTO，需要显式升级该序列化边界并迁移消费者；不新增全局版本协商。

Tool Schema 在 App＋ViewType 声明期规范化一次；语义所有者缓存业务合同与 canonical 表示，表示适配器缓存模型 Schema 的静态部分。动态 `eligibleViewIds` 仅组装对应部分；缓存随所属实例／适配生命周期释放。沿用 [09](09-schema-and-tool-naming.md)，语义 tool id 与模型 alias 分开；表示缓存还要区分实际模型 profile，不能以 alias 或任意字符串 key 充当可信声明。外部 Schema 的首次输入和跨边界引用仍须验证。

### 5.4 内容复用不能跳过执行绑定提交

[View-owned Tools](../../runtime/src/core/tool/view-owned-tools.ts) 会在 owner／type 连续、工具持续 enabled 时沿用身份，却更新当前 execute。因而“正文未变”不能推导“整个提交无事可做”。

内部将呈现数据的复用与绑定登记的提交分别处理：body 不变可以复用文本节点；Ref 改变、enabled 改变、页面更换或 handler/context 更新仍走各自合同。绑定更新不会被内容 hash 短路；也不要求每次闭包变化都撤销旧 Observation，更不冻结闭包。调用时继续验证 App 实例、页面挂载、激活和当前执行端资格。

Hash 只作诊断或索引候选。相同 hash 不能证明值相同，更不能证明授权；正确性判等使用本域不可变节点身份、精确 canonical 值或必要的结构比较。首项改动只省没有消费者的摘要计算，真实 published `contentDigest` 保持现有合同；更广的缓存或算法替换另需证据。

### 5.5 真实边界仍完整验证，避免边界内重复复制

[Node v23.11 Worker 文档](https://nodejs.org/download/release/v23.11.0/docs/api/worker_threads.html) 明确 `postMessage` 使用 structured clone，且可表达超出 JSON 的值。因此“平台已克隆”不等于满足 AOTUI JSON、身份与关系合同。

接收端对独占收到、尚未泄露给其他消费者的 DTO，可以一次遍历完成结构限制、来源／序列校验、关系检查与冻结／必要规范化，建立自己的 owned handle，无需再完整 deep clone。若不能证明独占，仍捕获一次。公共对象输入与专用接收入口不能混用。

已有 structured clone 路径不额外叠加 JSON stringify/parse。选择字节协议时，每个真实边界 encode 一次、decode 一次，再做接收端完整验证；“一次”不要求把所有易维护的小检查融合成巨大函数。跨进程传来的 handle 一律不能继承发送侧 WeakMap 资格。

### 5.6 性能极限路线：先证明值得，再增加协议

只有实际测量表明传输全帧占主要成本，且较小改动不足以解决，才考虑基于已确认完整根的 delta；不要求先完成所有本地优化。最低合同包括 App 实例／通道代际、base ACK、递增序列、差异来源、缺口检测、重复消息规则、完整重同步和关闭释放。接收者先验证 delta 与所持 base，再形成完整新根；缺 base 或 gap 时不得局部发布。不能只发送“变更页面”却默默丢失其余打开页面。

二进制传输只能转移**发送端不再需要的独占 wire buffer**。[Node 的 Buffer／Transfer 注意事项](https://nodejs.org/download/release/v23.11.0/docs/api/worker_threads.html#considerations-when-transferring-typedarrays-and-buffers) 说明底层 ArrayBuffer 转移会使发送端的相关视图失效。旧 Observation 或在途调用仍引用的存储绝不能 detach；Buffer 池也不能假定可转移。SharedArrayBuffer 会引入跨线程可变别名，普通对象 freeze 无法保护共享字节，除非另有可证明的不可变分段与同步协议，否则不用于 Snapshot。

这一路线增加基线保存、故障恢复和协议测试成本；它是后阶段选项，不是“极致”必然意味着的默认方案。

## 6. 能达到的下界：哪些成本再优化也不能消失

设 `B` 为新完整输入字节、`N` 为节点数、`V` 为页面数、`Δ` 为已识别变化的节点／字节。

| 路径 | 能减少的工作 | 无法承诺消失的成本 |
| --- | --- | --- |
| 同域 owned handle | 二次捕获、重复 Schema 编译和诊断 hash | 生命周期、顺序、执行资格检查 |
| 已知脏页＋结构共享 | 旧子树复制与重新编码 | 普通索引可能仍需 `O(V)`；新节点仍需验证 |
| 完整 Worker 帧 | 应用层二次 deep clone | 新全帧至少线性扫描；canonical 排序还可能增加成本 |
| 增量传输 | 在正确 base 上只传／验证变化及关系 | 重同步仍全量；最终完整模型文本输出仍随输出大小增长 |

回到三页例子：内部可以只重做 Editor 的变化正文，但收到一份全新的完整跨 Worker 输入，就至少要检查与其数据量线性相关的内容；向 LLM 组织完整请求，输出全部页面文本仍至少是 `O(输出大小)`。结构共享减少本地分配，不能直接减少模型看到的 token。若模型输入本身才是主成本，缓存再精巧也不会把它变成 `O(一次编辑大小)`。这也是保留普通全帧传输作为可理解基线的理由。

根负责版本，持有者负责寿命，节点负责不可变数据，执行 registry 负责 live binding。可另建有界内容索引寻找共享节点，但 hash 冲突必须精确比较，索引清退不能回收仍被根持有的节点。逻辑 JSON 字节、唯一物理节点字节、V8 分配量与 RSS 分开统计。

## 7. 候选优先级与独立证据门槛

P0—P3 保留为讨论编号与成本优先级，**不是必须走完的里程碑，也不要求每项都依赖前一项**。可以在 P0 后停止；P1/P2 内部也应按具体瓶颈拆开评估。

| 候选 | 改动 | 本项开始与保留的依据 |
| --- | --- | --- |
| P0（已验收） | 只在真实发布时计算诊断摘要 | 三种同负载对照、固定输出、持有探针和原归档包消费见第 4 节 |
| P1 | 私有 validated handle 或其他同域结果复用；接收端独占捕获 | 重复复制仍有显著成本，且独占不可变、容量与结算可证明；真边界验证完整 |
| P2 | 分别选择页级共享、静态 Schema 或 ArrayRef 根＋selector | 对应的分配、编译或重复数据是瓶颈；单页更新、旧来源保留、数组重排分别证明收益 |
| P3 | 持久化索引、delta 或独占字节 transfer | 具体索引／wire 成本主导；有完整 base、恢复、退出及持有证据，协议成本值得承担 |

复测覆盖无变化、单页变化、多页变化、同文本仅 Ref／enabled／closure 改变、大 ArrayRef、长时间持有旧 Observation、调用在途、新实例重开与错误输入。记录端到端及分阶段 p50／p95、吞吐、GC、heap 分配、峰值 retained bytes；同时记录 capture 次数／字节、canonical 次数／字节、Schema 编译命中、wire 字节、selector 解析和持有根数。不预设任意毫秒目标，以同机同版本对照报告收益与代价。

必须保留的验收事实：旧 Ref 仍取旧值；同名重开不接旧绑定；正文相同不吞 enabled／闭包更新；失败不发布半帧；关闭等待实际在途责任；伪造句柄、错来源和缺失 delta base 不得通过。测试围绕这些性质，不镜像内部实现。

按所选候选取相关验收。完整数据跨 Worker 后仍由接收端验证。本批的 `array_ref` 样本在 P0 后仍有可测成本，且编码次数与字节数一致。代表性业务负载若显示重复捕获或分配占主要成本，再单独评估 P1/P2。P3 要先取得实际传输成本占比及重同步责任的证据。

## 8. 决策日志与未决事项

| 日期 | 状态 | 记录 |
| --- | --- | --- |
| 2026-11-18 | 研究完成，方案待讨论 | 推荐 P0 → P1 → P2，P3 按测量证据启动；没有改变当前实现或准入合同 |
| 2026-11-18 · 修订 0.2 | 解释与方案比较补充，仍待讨论 | 以三页 IDE 的一次编辑开篇，比较全量、owned candidate＋页共享、delta／ACK 与 transfer／共享内存；对齐三个既有所有者、最小 AppContract 与作者层边界；保留历史计时与附录，本轮未重跑、未授权实现。 |
| 2026-11-18 · 修订 0.3 | 采纳评审中的设计建议，仍待讨论 | 依据 [Review](REVIEW-2026-11-18.md) 与[回复](REVIEW-RESPONSE-2026-11-18.md)，将 P0 收窄为未消费的诊断计算并保留 published 摘要合同；P0—P3 改为各自证据驱动的候选，替代必须顺序推进的读法。未实施，未新增用户最终方案决定。 |
| 2026-11-18 · 修订 0.4 | P0 已实施并完成本地复测，待本批验收 | Store 复用验证字节生成已发布摘要。保留逐分支计数、同机时间对照与原归档消费证据。P1–P3 仍按各自触发条件评估。 |
| 2026-11-18 · 修订 0.5 | 第二批验收通过 | 复核准备、变更发布、重复发布的摘要次数为 0／1／0，记录小页变更发布的尾延迟代价。原样 App 在本批安装包上复验通过。性能工作在 P0 收束，后续候选按第 7 节的瓶颈条件重开。 |

完整逻辑快照、Ref 双地址和页面语义继续以对应议题为准。开页暂缓，接收端独立验证跨 Worker 输入。后续候选按测量证据各自决定。

未决仅四项：

1. 内部 validated handle 落地时，是否同步收紧 `/core` 的低层公开入口？句柄本身不进入最小 AppContract。
2. ArrayRef 根＋selector 与页级共享是否在同一个 Snapshot DTO 变更中迁移？
3. 初期页级索引是否足够，何种复测结果才值得持久化树？
4. 传输是否确为主要成本且较小改动不足，足以承担 delta 的 base／ACK／重同步生命周期？

## 附录：历史微基准的复现方法

下面的只读命令用于复现历史基准，使用第 4 节历史记录所列提交与 Node 版本。首次诊断预热 4096 字节，各项测五次取中位数，正文每页最多 128 KiB。历史 publish 测量包含 unchanged 样本。本批对照使用第 4 节的新脚本分开测量三条分支。

```bash
node --input-type=module <<'NODE'
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: ['./runtime'] }));
const result = await build({ stdin: {
  contents: "export * from './runtime/src/core/index.ts'; export {diagnosticDigest} from './runtime/src/core/snapshot/json.ts';",
  resolveDir: process.cwd(), loader: 'ts'
}, bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const core = await import('data:text/javascript;base64,' +
  Buffer.from(result.outputFiles[0].text).toString('base64'));
const median = run => {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now(); run();
    samples.push(performance.now() - start);
  }
  return +samples.sort((a, b) => a - b)[2].toFixed(3);
};
core.diagnosticDigest(new Uint8Array(4096));
const rows = [];
for (const bytes of [65536, 524288, 2097152]) {
  const data = new Uint8Array(bytes).fill(97);
  const identity = { appId: 'bench', instanceId: 'one' };
  const store = core.createSnapshotCore(identity);
  const projection = new core.SemanticProjectionCoordinator({ identity: () => identity });
  const views = [];
  for (let left = bytes, i = 0; left; i++) {
    const size = Math.min(left, 131072); left -= size;
    views.push({ id: 'v' + i, viewInstanceId: 'vi' + i, type: 'Detail',
      name: 'View', kind: 'state', toolBindings: [],
      content: { format: 'markdown-v1', value: 'a'.repeat(size) } });
  }
  const frame = { views, refs: [], tools: [] };
  const prepareMs = median(() => {
    const r = projection.commit(() => frame);
    if (r.status !== 'prepared') throw Error(JSON.stringify(r));
  });
  const publishMs = median(() => {
    const r = projection.publishTo(store.committer);
    if (r.status === 'rejected') throw Error(JSON.stringify(r));
  });
  rows.push({ bytes, prepareMs, publishMs,
    digestMs: median(() => core.diagnosticDigest(data)),
    nativeSha256Ms: median(() => createHash('sha256').update(data).digest('hex')) });
  projection.close(); store.lifecycle.dispose();
}
console.log(JSON.stringify({ node: process.version, samples: 5, stat: 'median', rows }, null, 2));
NODE
```

在项目根目录执行。命令通过 esbuild `write:false` 用源码生成内存产物。Worker 路径与编码缓冲的实测范围见第 4 节。
