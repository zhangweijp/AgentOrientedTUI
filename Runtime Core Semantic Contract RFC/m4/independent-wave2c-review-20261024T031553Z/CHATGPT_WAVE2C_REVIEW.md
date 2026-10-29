# Wave 2C 独立验收 — 退回限定修复

验收日期：2026-10-24（Asia/Shanghai）。
验收对象：`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/Runtime Core Semantic Contract RFC/m4/wave2c-20261024T005534Z`。
本轮结论：**CHANGES_REQUESTED / LIMITED_PASS_NOT_GRANTED**。维持 Wave 2B 的方案 A；实际 Ref 执行、provenance、新 IPC、Strict、默认路由与新增可写开放继续不准出。

## 1. 结论依据

六项全量回归已由本轮按原顺序独立重跑，全部 exit 0：Runtime tsc、SDK tsc、IDE tsc；Runtime 73 files /697 passed /3 skipped /7 todo；SDK 11 files /110 passed；IDE 6 suites /27 passed。两个原始 R1 脚本独立重跑：受控 0/10、真实 Worker 0/4，均 exit 0。

正常顶层 opt-in 的 SDK、Host、Worker 防线与现有用例相符，包括 optional 缺省仍拒绝、authorize/dispatch 前拒绝、活态 Registry 检查、剥 annotation 的 canonical 失效，以及原业务 success:false 透传。

但是新增独立探针确认共享 Schema 遍历存在上下文错误：同一问题造成错误位置声明漏拒，以及普通无声明 Schema 误拒。因此不能依据原有全绿测试签署本次 LIMITED PASS。

## 2. 阻塞项 C1：把 Schema map 的属性名误当成 Schema 关键字

源码：`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/core/tool/ref-declarations.ts`。

- 第 85 行在普通对象上直接检测自有 x-aotui-ref。
- 第 96 行在所有对象层跳过 default/const/enum/examples 等键。
- 第 98 行只对部分 Schema map 做成员名处理，遗漏 dependencies；dependentRequired 的普通映射也被按 Schema 对象解释。
- 第 106 行在未发现声明时直接返回 false。

映射中的成员名可以恰好等于上述字符串；它们不自动具有 Schema 关键字含义。

### 2.1 漏拒：错误位置的声明可注册、通过 V2 校验并调用合成 Handler

```json
{
  "type": "object",
  "properties": {
    "file": { "type": "string" },
    "default": { "type": "boolean" }
  },
  "dependencies": {
    "default": {
      "type": "object",
      "properties": {
        "file": {
          "type": "string",
          "x-aotui-ref": {
            "version": 1,
            "kind": "snapshot-value",
            "owner": "tool-target"
          }
        }
      }
    }
  }
}
```

此声明在依赖子 Schema 内，按本批合同应拒绝。实际 validateToolRefDeclarations 返回 false；createViewOwnedTools.registerTool 接受；validatePreparedV2Draft 返回 ok；registry.invoke 返回 success:true，合成 Handler 调用次数为 1。把依赖属性名改为 const、enum、examples，同样复现。改为 ordinary 则正确拒绝。

调用链均复用该检测器：Registry 注册第184行；Registry invoke第283行；Snapshot validator第248行。Host第527行也使用同一检测器，但本轮未将这组异常 Schema 变体经真实 Host/Worker 重跑；不把 Core 复现冒充该变体的 Worker E2E。

没有 Ref 值展开，没有生产业务副作用，没有证明 Agent 能自行替换可信 Tool Schema。发现的是受信任注册边界对非法声明的 fail-closed 合同不成立。

### 2.2 误拒：普通 dependency 名为 x-aotui-ref

以下映射没有 Ref 参数声明：

```json
{
  "type": "object",
  "properties": {
    "x-aotui-ref": { "type": "boolean" },
    "file": { "type": "string" }
  },
  "dependentRequired": {
    "x-aotui-ref": ["file"]
  }
}
```

实际语义检查、Registry 与 V2 validator 均以 REF_DECLARATION_INVALID 拒绝。将 dependentRequired 换成 dependencies，也复现。

本轮读取并校验了 Wave 2C 起始备份的 Registry 源码 SHA-256，在内存中 transpile 后与当前模块比较：这两个普通 Schema 在起始版本均可登记并执行合成 Handler，当前版本均拒绝。该对照只覆盖 Registry 模块，共享未修改的 JSON codec；不是旧 Host/Worker 二进制兼容矩阵。

JSON Schema 官方说明：dependentRequired 的键为实例属性名；旧 dependencies 同时承载 property dependency 与 schema dependency。参考：[JSON Schema 官方条件依赖说明](https://json-schema.org/understanding-json-schema/reference/conditionals)。

## 3. 独立探针结果

最终脚本：ref-declaration-map-probe-v3.mjs。
结果：10 个场景中 6 个不满足合同，exit 1。

| 场景 | 结果 |
| --- | --- |
| dependencies 下 ordinary 名称的非法嵌套声明 | 正确拒绝，Handler=0 |
| dependencies 下 default/const/enum/examples 四种名称 | 均漏拒；Registry/V2接受，各 Handler=1 |
| dependencies 的普通 x-aotui-ref 属性依赖 | 误拒 |
| dependentRequired 的普通 x-aotui-ref 属性依赖 | 误拒 |
| 真正 default 字面数据中的同名 key | 正确作为普通数据 |
| properties 中参数名为 x-aotui-ref | 正确作为普通参数名 |
| 合法顶层新声明 | 正确拒绝执行，Handler=0 |

最初探针的额外语义预检漏传 copyJson limits；当时独立 Registry/V2 分支已实际执行并复现四个漏拒。v2 修正预检并增加对照，v3 增加现代 dependentRequired 对照。所有脚本和日志保留，见 probe-authoring-note.json；没有为使探针通过修改生产实现。

## 4. 修复边界

只修正声明遍历对 Schema 对象、属性名映射和字面数据的区分，并补充反例/对照。不得用全面拒绝所有 dependencies/dependentRequired、递归扫描所有业务数据、放宽错误位置规则或删除既有兼容断言解决。

不需要引入 JSON Schema 平台、额外 Store、Ref 解析、provenance、IPC 或错误脱敏平台。普通无声明 Schema 继续保持起始合同；含错误位置保留声明的输入明确拒绝。

修复后，最终10场景应全部满足合同；原3份新增测试和所有旧断言保留；按最后一次源码修改后的既定顺序重跑六项回归，并满足原 Wave 2C 稳定性与 R1 Gate。此文是验收意见，未启动修复或后续阶段。

## 5. 证据与限制

独立回归：independent-regressions.json 与六份同名 .log。
独立原始 R1：r1-controlled.log、r1-real-worker.log。
反例：ref-declaration-map-probe-v3.mjs/.json/.log。
基线兼容对照：ordinary-schema-baseline-comparison.mjs/.log。
保护：pre-review-inventory.json；最终对比见 integrity-after.json。

实际命令目录 Node v24.15.0、pnpm 10.15.1。最初元数据在仓库外查询 pnpm 得到10.23.0；toolchain.json 已记录实际 root/runtime/sdk/IDE 目录均为10.15.1。未安装依赖或修改全局设置。

本轮没有修改生产源码、原测试、原交付包或 Git 暂存内容；仅新增本独立审查目录，测试生成既有忽略规则下的产物。性能、coverage、完整历史二进制矩阵、异常Schema的真实Worker E2E均未测。未来 receivedArgs 回显风险仍是执行 Gate 事项，本轮未借此扩大修复范围。

## 6. 审查结束时的独立保护核验

2026-10-24T03:23:07Z 的 integrity-after.json 确认：

- 审查开始时记录的 1343 条路径内容、符号链接或缺失状态均未变化；新路径只在本独立审查目录内。
- HEAD 保持为 `789ef07cb18084d97b0476c1ffc234ae0b9319f0`；本轮未暂存差异的 SHA-256 也未变化。
- `git diff --cached --binary` 输出 SHA-256 仍为 `258d9b26c2ac0c01d9156553bd3bd775de08ba16330546d65b5bb53b896dcf54`。这不是 .git/index 文件本体的哈希。
- Wave 2C 起始 1257 条记录中，22 条原缺失状态保持；变化的既有文件恰为批准的 12 份，无计划外既有文件变化。
- 交付指纹表中的 16 个源码／测试文件均与 finalSha256 匹配。
- Wave 2C 起始记录中，全部 479 条 RFC 目录路径未变。此数采用更宽的目录口径，不应与交付报告的 251 条旧审计保护集合混写。
- reviewIntegrityPass=true。

以上核验后的新增验收结论文件仍只写入本独立审查目录。原 Wave 2C GATE_STATUS.json 未改写，本轮独立状态见 INDEPENDENT_WAVE2C_GATE.json。
