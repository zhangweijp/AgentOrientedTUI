# 内核第二轮减法：完整执行任务

2026-11-09。项目所有者最新授权：“再检查一下有没有可以清理/删除的地方，可删可不删的那就安全的删除掉，这样才能构建强大/稳定/简洁的内核。”

执行：指定 Minimal Core 执行 Agent。整项独立验收：MC Owner。当前授权是实际完成安全删除和必要迁移，不是只提交候选清单。沿用仓库 minimalist skill 和 AGENTS 第十一节：连续完成分析、实施、自测、修复与完整交付，整项结束主动汇报；负责人不轮询聊天、不插入逐点 review，不重复项目所有者已完成的跨 Owner 同步。

## 基线与目的

上一轮19路径清理已经采用到实际根目录，见 [采用记录](../SRT/SRT-15_POST_UPGRADE_OWNER_ADOPTION_2026-11-09.zh-CN.md)。MC Owner已重新核对19项，均符合批准的after（包括7项删除）。这轮从当前实际树建立新的独占副本，不复用旧HEAD、不改写上一轮候选和证据。共享树有其他已验收、未提交和未跟踪实现，你不是唯一执行者，不覆盖或回滚他人的工作。

目标是继续减少SDK／Runtime及直接集成中的必要实现量。上一轮主要退出IDE旧全局服务，本轮重点检查内核内部是否仍有重复状态、只写不读字段、无实际职责的分支／回退、纯转发包装、重复入口和旧实现专属配置。不要以“上一轮已经检查过”替代本轮实际判断，也不设删除行数指标。

## 一次完成的工作

1. 从受支持的包入口和实际提交、观察、调用、投影、关闭链追踪职责；覆盖SDK hooks／context／组件／提交协调，Runtime Core、投影与转换、生命周期和适配层，以及直接使用这些入口的Adapter／Driver／Host消费者。查看公开导出、动态加载、构建与初始化副作用后再判断去留，零静态引用只是线索。
2. 对没有必要职责的代码直接删除。可由已有状态推导的重复记录、没有作用的包装、已退出路径的类型／配置／依赖／脚本，连同直接消费者一起收口。能直接调用已有实现或标准库就直接使用，不引入新抽象、兼容层、管理器或“备用实现”。不要以单纯改名、挪目录或合并大文件充当减法。
3. 同步处理受影响的导出、构建产物、示例与当前使用文档。只验证退出实现的专属测试可删除；仍证明当前合同的断言保留或迁到现行入口。没有行为变化的纯删除优先复用现有测试，不为每项删除机械增加测试。
4. 对每组实际删除简明说明：删了什么重复职责；哪一个现有模块保留必要行为；什么实际验证证明它；作者／维护者少理解了什么。只有明确的当前职责才是保留理由，不能用“以后可能有用”保留实现。实际影响仍在支持的公开能力或产品语义的重大取舍，单独说明该项并继续其他清理。

## 与正在执行的合同任务分工

Clean正在独占完成 [SRT-09／10／13等剩余合同任务](../SRT/SRT-01_15_REMAINING_DELIVERY_CLEAN_TASK_2026-11-09.zh-CN.md)，由SRT Owner唯一验收。本轮不重复开发或审查该任务。下列生产路径及其合同迁移属于该开发线，本轮可只读，不同时修改：

- `runtime/src/engine/app/{registry,manager,worker-host,config}.ts`
- `runtime/src/worker-runtime/index.ts`、`runtime/src/worker-runtime/app-kernel/AppKernel.ts`
- `runtime/src/spi/app/app-factory.interface.ts`、`runtime/src/spi/core/tool-result.ts`、`runtime/src/spi/component-factory.interface.ts`、`runtime/src/spi/runtime/app-type-tools.interface.ts`、`runtime/src/spi/worker-protocol/messages.ts`、`runtime/src/spi/index.ts`
- `runtime/src/adapters/{app-authoring-protocol,app-lifecycle-protocol,worker-message-capture,public-tool-name}.ts`
- `runtime/src/core/invocation/{invocation-outcome,scoped-interaction-types}.ts`、`runtime/src/core/snapshot/types.ts`、`runtime/src/core/tool/view-owned-tools.ts`
- `sdk/src/app-factory/createTUIApp.ts`、`sdk/src/utils/ordinary-parameter-tool.ts`、`sdk/src/tools/view-type-tool.ts`
- `scripts/generate-aoapp.mjs`及其测试，五个Demo的工厂／manifest，Runtime CLI／Host发现实现，直接关联的合同测试、公共作者指南和兼容说明。

其余内核路径与必要直接消费者由本轮承担。若某一必要删除确实跨入上述文件，在报告中指出精确文件、职责和最小改动；不因这一项阻塞其余任务。实际新冲突再告知MC Owner，不为假设冲突反复聊天确认。共享根、AGENTS、deepseek_review、Owner任务及裁决文件由对应负责人维护，执行者只写本轮独占副本和自己的交付材料。

## 行为边界与验证

保留框架已经承担的身份与来源绑定、当前View／Ref生命周期、授权和参数校验、调用防重、结果语义、资源限制及释放责任；不转嫁给App。普通TypeScript Producer、纯Core消费和当前支持的包入口仍是实际职责。D3历史迁移保持取消；不夹带Ref字段／数据作用域、并发或资源策略重设计。

验证围绕实际改动选择：受影响现有合同测试、构建和必要严格类型消费；涉及发布入口、依赖或包布局才补对应正常安装包验证；涉及运行生命周期则跑实际调用与关闭。保留有效已有证据，只有新变化或实际失败才扩大验证。不重跑无关TS／LSP调查、GUI／真实模型或人工Planning验收，不操作用户数据。历史材料、失败记录和review-evidence不属于代码清理对象。

## 交付与准出

交付一个完整候选、相对实际开工基线的patch、仅变更文件的before／after和简明报告，附必要命令与真实结果。生产、测试、配置／依赖、文档的净变化分别统计；说明被检查却有明确职责的主要保留项，以及因正在并行开发暂未修改的具体项。不制作全仓哈希包或大型归档。

准出是：实际删除与职责说明一致；保留行为的相关验证通过；没有留下悬空入口／消费者／旧产物；没有覆盖其他执行者；剩余问题具体可判断。执行者不自批、不向共享生产采用，不提交、推送、合并或发布。整项完成后主动向MC Owner提交完整结果，由MC Owner一次集中给出APPROVED或CHANGES_REQUESTED并推进采用，不等待新的聊天提示。

## Codex Prompt

> 立即按本任务书完成一整轮内核减法。使用minimalist，基于已采用上一轮19路径的实际树建立独占候选；重点清理SDK／Runtime剩余无职责实现及关联入口，遵守已列明的Clean文件归属。可删可不删且已证明不承担必要行为的代码直接删，不只给计划，不逐小点等待review。连续完成实现、迁移、相关验证和修复，提交完整patch及简明职责／验证报告后主动汇报。你不是唯一执行者，保留他人工作；负责人不轮询聊天，完整交付后集中验收一次。
