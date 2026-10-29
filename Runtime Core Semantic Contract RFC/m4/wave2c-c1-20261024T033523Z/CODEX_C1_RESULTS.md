# Wave 2C C1 限定修复交付

结论：C1 反例已修复并完成本轮回归，建议交由 ChatGPT 复验；**未自行授予 Wave 2C LIMITED PASS**。

## 根因与最小差异

起点 `ref-declarations.ts` 的 `visit()` 只识别部分 Schema 成员映射。遗漏旧 `dependencies` 后，整个映射被当成 Schema 对象：映射名 default/const/enum/examples 被错误跳过；映射名 x-aotui-ref 被错误当作声明。dependentRequired 的实例属性名也被按 Schema 对象解释。因此同一根因造成漏拒和误拒，而非 Ref 值展开或 caller 获得任意 Schema 写权限。

本轮只改一个生产文件 `runtime/src/core/tool/ref-declarations.ts`（5 行增加、3 行移除，含注释）：

1. 复用原有 Schema map 分支，增加 dependencies；成员名只用于定位路径，不参与 Schema 关键字解释。Schema 成员继续递归，错误位置声明仍报 REF_DECLARATION_INVALID。
2. dependencies 的数组成员是属性依赖数据，明确跳过，避免将其当作 Schema。
3. dependentRequired 是属性名到依赖列表的映射，不把该映射当作 Schema。default/const/enum/examples 的真实字面数据继续保持不透明。

没有引入通用 JSON Schema 引擎；未改变声明位置、metadata exact-shape、预算、canonical/binding 或既有错误码。合法顶层声明继续保留到 Schema/V2，但执行返回 REF_CONTRACT_UNSUPPORTED，Handler=0。

新增 `runtime/src/core/tool/ref-declarations.wave2c-c1.test.ts`，共 26 cases：完整重现本次四个漏拒、两个兼容性反例，并对 Schema-valued/boolean dependencies、已有五类 Schema map、四种真实字面数据、保留字参数名及合法声明继续拒绝执行作对照。

## 红绿轨迹和兼容性

修改前新测试 9 failed /17 passed，独立 v3 为 6/10 违规；修改后 26 个新用例和 39 个原 Core 用例全绿，未修改的独立 v3 为 0/10。原样起点 Registry 对照恢复两种普通依赖 Schema 的接受与 Handler success:true 行为。该对照使用已保存起点模块和当前未改 JSON codec，未夸大为旧 Host/Worker 的完整二进制验证。

六项顺序回归：Runtime 74 files /723 passed /3 skipped /7 todo，SDK 11 files /110 passed，IDE 6 suites /27 passed，三处 tsc 成功。三轮定向各 13 files /200 passed；原始 R1 为真实 Worker 0/4、受控 0/10 违规。完整命令、退出码、证据层次见 VALIDATION_RESULTS.md 与 GATE_STATUS.json。

原 Wave 2C 的三份测试文件（39+14+10=63 cases）与 R1 29-case 文件内容均未变，并实际运行。Core/SDK/IDE 其它生产源码、Host、Worker IPC、SDK API、默认 Router、实验开关和 Strict 标志均保持本轮起点内容。

## 用户工作树及原证据保护

- HEAD：`789ef07cb18084d97b0476c1ffc234ae0b9319f0`；暂存差异输出 SHA-256 前后同为 `258d9b26c2ac0c01d9156553bd3bd775de08ba16330546d65b5bb53b896dcf54`。
- 另行核验 `.git/index` 文件本体 SHA-256 前后相同，值为 `8ed3a27a94f2a4f13caa9afb06e52923139484f882e83999ce836c6834a34162`。没有把两种哈希混同。
- 起点清单为 1368 条路径记录：1346 个存在文件、22 个缺失路径。除计划内一个 Core 文件精确修改外，其余 1367 条内容或缺失状态不变，所有 586 条既有 RFC 路径均保持。没有越界新增路径；新增源码仅 C1 测试，其余新增都在本批独立证据目录。
- 原 helper 起点已是 untracked，不能靠 git diff 证明它没变；起点完整备份、1368 条指纹和本轮增量 patch 共同保护已有内容。未暂存 diff 输出恰好也保持 `0bc8bea331369d1c6c5f393f700645094e7835edf36fb6a4ef95e7fdbf20848c`，并不代表 untracked 源码无变化。
- inventory 在创建本证据目录之前采集；`baseline-status.porcelain-v1.txt` 是持久化备份后真实执行的原始 status，含当时已写入的本目录自身条目。保护判断以预先采集的 baseline.json 为准。忽略规则覆盖的构建产物/缓存不在源文件清单内。
- `incremental-changes.patch` 相对本轮起始工作树，只包含一个生产差异和一个新测试；在 mkdtemp 起点副本中 `git apply --check` exit 0，未对用户 index 或工作树应用该检查。

## 剩余限制与停点

本批新增反例是 Core/Registry/V2 +合成 Handler 证据；C1 异常 Schema 的真实 SDK/Worker 全链路为 NOT_TESTED。已有真实 Worker 声明阻断路径与 R1 保持回归支持。校验器仍不是通用 JSON Schema 规范验证器，也不是恶意 JavaScript 沙箱。
性能、coverage、完整历史二进制矩阵均 NOT_TESTED。没有执行 Ref 解析、effectiveArgs/provenance、新执行 IPC 或未来 receivedArgs 展开结果处理；receivedArgs 回显作为真正 Ref 执行前的独立必验项保留。

本轮止于 C1 再验收，不实现后续 API，不切换路由，不开放写入，不改变 Strict，不自动执行后续批次。
