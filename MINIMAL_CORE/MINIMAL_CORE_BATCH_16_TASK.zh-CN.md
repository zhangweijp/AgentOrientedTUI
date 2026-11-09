# Batch 16 · Planning 已写明是计划，工具为什么还收到 unknown

Planning 当前用 `useArrayRef('unfinished_plans', plans, { itemType: 'Plan' })` 发布计划列表。这个选项已经进入列表及元素的名字。现有 Runtime 在生成快照时把它们的 `refType` 都写成了 `unknown`。负责人已用真实 Planning 页面和 Node Worker 做过对照。同一元素在不限定种类的只读工具中成功，给该工具加上现有的 `refType: 'Plan'`，该元素就在派发前收到 `REF_TYPE_MISMATCH`。[原有消费者](review-evidence/minimal-core-batch-16/owner-review/opening/unrestricted-kind.json) · [限定 Plan 的消费者](review-evidence/minimal-core-batch-16/owner-review/opening/requires-plan.json)

**范围是隔离验证与最小候选。** 用户已经提供的 `itemType` 能否通过现有注册入口进入同一份快照，并让现有只读工具正确区分两个长得一样的业务对象？用签收的 B15 组合包建私有基线，说明它与上述冻结原包对照的关系。本批只研究已有数组发布接口，不为单对象另定作者 API。

可改的副本限于 SDK 的 `src/hooks/useArrayRef.ts`、`src/components/View.tsx`，以及 Runtime 的 `src/spi/app/public-types.ts`、`src/spi/app/ref-exporter.interface.ts`、`src/worker-runtime/app-kernel/AppKernel.ts`、`src/worker-runtime/dom-snapshot-producer.ts`。按实际需要取用，额外探针只放本批目录。共享源码、SRT 工作树、真实应用和历史交付只读。

**准出条件**

1. 在真实 Worker 里先复现限定 Plan 的工具为何拒绝已显示的计划元素。候选中，类型沿已有注册记录从发布方传入快照和本轮观察。作者仍只写已有的 `itemType`，名字逐字沿用。试件把 `Plan` 作为业务种类，列表和元素的差别由现有值形状表达。记录页面正文、默认 Source 的引用提示和实际授予的类型。该写法与提示变化留给上级决定是否采用。
2. 在同一有效观察中，用原有的只读工具读取标为 Plan 的元素，验证真实业务只进入一次且拿到正确 ID。对同形但发布为其他种类的元素、没有声明类型却把名字起得像 Plan 的引用，各自验证明确拒绝、零业务进入。保留不限种类的对照；整份列表遇到原有对象专用入口仍应按原有形状限制拒绝。记录观察、绑定、执行收据与 handler 输入。
3. 让列表内容更新、缩短、变空，再卸载页面。核对相同名字更新到新值，旧元素退出新观察，空列表仍存在，关闭时资源结清。沿用现有发布者所有权和旧 cleanup 保护。对没有 `itemType`、空串和纯空白的开工表现分别取样，保留可观察的既有行为；遇到影响旧应用的取舍时记录事实，不能无声地改变名字或让整页失去投影。
4. 提交一个能从实际基线正反应用的增量，附现有 SDK 引用所有权、DOM Producer 和相关 Core 检查，以及本批真实 Worker 的一条复跑命令。核查对外类型声明的真实差异。复用此前封存输入，单列本批新增原件。不得从名字前缀或数据字段反推业务种类，不增注册中心或兼容执行路径。

本批准出止于**发布端种类确实能被现有消费者验证**。普通工具接入 B15 多引用参数、Worker 协商、跨 View 寻址、旧观察采用规则、公开 API 和共享代码落地留在后续决定。若必须改动现有授权或执行协议才能让对照成立，保留首次失败和最小决策项，停止扩大范围。

**给执行 Codex 的 Prompt**  
在隔离副本沿着 Planning 已有的 `itemType: 'Plan'` 跟到真实快照和只读工具收据。用已有端口传递作者给出的类型，验证一个计划元素成功、同形的其他类型和徒有名字前缀的未标注对象被拒绝。覆盖列表更新与清理，交代 Agent 实际看见的差异。只动白名单内确有必要的副本，按四项准出交 READY_FOR_REVIEW。
