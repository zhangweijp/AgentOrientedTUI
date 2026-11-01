# AOTUI App LLM-Friendly Design Guidelines

> **版本**: 1.0.0  
> **目的**: 确保AOTUI应用程序对LLM友好，语义清晰，易于理解和使用

---

## 核心原则 🎯

**记住**: AOTUI App是为LLM服务的。LLM本质上没有视觉，所有信息通过Markdown传达。因此，App必须通过语义清晰的文本告诉LLM：

1. **What it is** - 这个App是什么
2. **When to use** - 什么时候使用它
3. **How to use** - 如何使用它（操作流程）
4. **What happened** - 当前发生了什么（状态信息）

---

## 一、createTUIApp 配置规范

### ✅ 黄金标准

```tsx
export default createTUIApp({
    app_name: 'my_app',
    
    // WHAT IT IS - 一句话说明App的本质和核心价值
    whatItIs: 'A detailed description explaining what this app does, its architecture (e.g., hierarchical/workflow-based), key features, and technical characteristics (e.g., LSP support, real-time monitoring, SQLite persistence).',
    
    // WHEN TO USE - 列举具体的使用场景
    whenToUse: 'Use this app when: (1) Specific scenario A with clear trigger condition, (2) Specific scenario B with expected outcome, (3) Specific scenario C explaining the benefit, (4) Additional scenarios with concrete examples.',
    
    component: AppComponent,
    
    // 其他配置...
    launchConfig: {...},
    onDelete: async (context) => {...}
});
```

### 📝 规范要点

#### whatItIs 最佳实践
- **详细描述**：不要只写"Task planning app"，而要写"A hierarchical task planning and progress tracking system..."
- **说明架构**：提到数据结构（Plans → Phases → Todos）
- **列出技术特性**：LSP支持、实时监控、持久化存储等
- **强调核心价值**：为什么LLM需要这个App

**❌ 反例**：
```tsx
whatItIs: 'Text-based IDE for code editing.'
```

**✅ 正例**：
```tsx
whatItIs: 'A text-based Integrated Development Environment designed for LLM Agents to explore codebases, search files by pattern or content, edit code with precise string replacement, and analyze code structure using Language Server Protocol (LSP) features like type inspection, definitions, references, and call hierarchies.'
```

#### whenToUse 最佳实践
- **用编号列举**：(1), (2), (3)...
- **场景具体化**：不要说"管理文件"，而要说"搜索文件by glob pattern或grep content"
- **说明预期结果**：不只是"编辑代码"，而是"编辑代码with precise string replacement"
- **5-7个场景**：覆盖主要使用场景

**❌ 反例**：
```tsx
whenToUse: 'Use when you need to work with code.'
```

**✅ 正例**：
```tsx
whenToUse: 'Use AOTUI IDE when you need to: (1) Navigate and understand a repository structure, (2) Search for files by glob pattern or grep content, (3) Read, edit, create, delete, or rename files with precision, (4) Analyze code using LSP features (hover types, go to definition, find references, diagnostics, symbols, call graphs), (5) Work with multiple files simultaneously through dynamic FileDetail views.'
```

---

## 二、RootView 结构规范

### ✅ 黄金结构模板

```tsx
export function RootView({...props}) {
    // 1. 计算状态变量
    const activePlan = plans.find(p => p.id === activePlanId);
    const totalItems = items.length;
    const completedItems = items.filter(i => i.status === 'completed').length;
    
    // 2. 在目标 <View> 下的组件内声明 View-local Tools
    useViewTypeTool('operation_name', { description: '...', params: {...} }, handler);
    useViewTypeTool('another_operation', { description: '...', params: {...} }, handler);
    // ...
    
    // 3. 返回结构化的说明和工具
    return (
        <>
            {/* ═══════════════════════════════════════════ */}
            {/* Section 1: Application Instruction (最重要！) */}
            {/* ═══════════════════════════════════════════ */}
            <div data-role="application-instruction">
                <section>
                    <h1>{AppName} - Application Instruction</h1>
                    
                    <h2>What it is</h2>
                    <p>One or two sentences explaining the app's purpose, architecture, and core capabilities.</p>
                    
                    <h2>When to use</h2>
                    <ul>
                        <li><strong>Scenario 1:</strong> Specific use case with clear condition</li>
                        <li><strong>Scenario 2:</strong> Another use case with expected benefit</li>
                        <li><strong>Scenario 3:</strong> Additional scenario...</li>
                    </ul>
                    
                    <h2>How to use</h2>
                    <ol>
                        <li><strong>Step 1:</strong> Start with View A, use tool X</li>
                        <li><strong>Step 2:</strong> Then do action Y in View B</li>
                        <li><strong>Step 3:</strong> Finally achieve goal Z</li>
                    </ol>
                    
                    <h2>What happened (Current State)</h2>
                    <ul>
                        <li><strong>Total Items:</strong> {totalItems}</li>
                        <li><strong>Active Item:</strong> {activeItem || 'None'}</li>
                        <li><strong>Progress:</strong> {completedItems}/{totalItems} completed</li>
                        {/* 动态状态信息 */}
                    </ul>
                    
                    <h2>Available Views</h2>
                    <h3>View A</h3>
                    <p><strong>Purpose:</strong> What this view does and why it exists.</p>
                    <p><strong>When Active:</strong> Always visible / Only when X condition.</p>
                    <p><strong>Available Tools:</strong> tool1, tool2, tool3</p>
                    
                    <h3>View B</h3>
                    <p><strong>Purpose:</strong> What this view does...</p>
                    {/* ... */}
                </section>
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* Section 2: Available Tools */}
            {/* ═══════════════════════════════════════════ */}
            <div data-role="available-tools">
                <section>
                    <h2>View A Tools</h2>
                    <ul>
                        <li><Tool1UI /></li>
                        <li><Tool2UI /></li>
                    </ul>
                    
                    {conditionalView && (
                        <>
                            <h2>View B Tools</h2>
                            <ul>
                                <li><Tool3UI /></li>
                            </ul>
                        </>
                    )}
                </section>
            </div>
        </>
    );
}
```

### 📝 关键要点

1. **说明在前，工具在后**
   - LLM首先需要了解整体概念
   - 然后才是具体工具列表

2. **What happened部分必须是动态的**
   - 使用变量显示当前状态
   - 让LLM知道"上次操作后发生了什么"

3. **Available Views部分要完整**
   - 说明每个View的Purpose（目的）
   - 说明When Active（什么时候可见）
   - 列出Available Tools（可用工具）

---

## 三、useViewTypeTool description 规范

### ✅ 黄金标准

```tsx
const [ToolUI] = useViewTypeTool(
    'operation_name',
    {
        description: `WHAT: One-line summary of what this operation does.

WHEN TO USE: 
- Specific scenario A (when user needs X)
- Specific scenario B (when system requires Y)
- Specific scenario C (when condition Z is met)

HOW TO USE:
1. First provide parameter A which does...
2. Then provide parameter B which controls...
3. The system will return C and do D

IMPORTANT: 
- Prerequisite conditions that must be met
- Any gotchas or common mistakes to avoid
- Expected outcome or next steps

EXAMPLE:
User: "Create a new project plan"
You call: create_plan({ title: "Project X", description: "..." })
System returns: { plan_id: "plan_123", message: "Plan created. Use open_plan to start." }`,
        params: defineParams({
            param1: { type: 'string', required: true, desc: 'Detailed parameter description' },
            param2: { type: 'number', required: false, desc: 'Optional parameter with default behavior' }
        })
    },
    async (args) => {
        // Implementation...
    }
);
```

### 📝 规范要点

#### 结构化description
1. **WHAT**: 简短的一行总结
2. **WHEN TO USE**: 3-5个具体场景，用bullet points
3. **HOW TO USE**: 步骤化的使用说明
4. **IMPORTANT**: 注意事项（可选但推荐）
5. **EXAMPLE**: 实际对话示例（强烈推荐）

#### 语言风格
- 使用**强调** markup突出关键词
- 用编号(1, 2, 3)表示步骤
- 用bullet points (-)列举场景
- 避免模糊词汇，使用具体描述

**❌ 反例**：
```tsx
description: `Create a plan.`
```

**✅ 正例**：
```tsx
description: `WHAT: Create a new empty plan.

WHEN TO USE: 
- Starting a new project or initiative
- Before you can add phases or todos (plan must exist first)

HOW TO USE:
1. Provide a descriptive title for the plan
2. Optionally add a description explaining the plan's purpose
3. The system will return a plan_id
4. Use open_plan tool to start adding phases

IMPORTANT: Plans are created empty. You must open them to add phases and todos.`
```

---

## 四、实际案例对比

### 案例1: aotui-ide

#### Before ❌
```tsx
export default createTUIApp({
    app_name: 'aotui_ide',
    whatItIs: 'Text-based IDE for exploring, searching, and editing code with LSP support.',
    whenToUse: 'Use when you need to navigate the repo, search files, or inspect/edit code.',
    component: SystemIDEApp
});
```

#### After ✅
```tsx
export default createTUIApp({
    app_name: 'aotui_ide',
    whatItIs: 'A text-based Integrated Development Environment designed for LLM Agents to explore codebases, search files by pattern or content, edit code with precise string replacement, and analyze code structure using Language Server Protocol (LSP) features like type inspection, definitions, references, and call hierarchies.',
    whenToUse: 'Use AOTUI IDE when you need to: (1) Navigate and understand a repository structure, (2) Search for files by glob pattern or grep content, (3) Read, edit, create, delete, or rename files with precision, (4) Analyze code using LSP features (hover types, go to definition, find references, diagnostics, symbols, call graphs), (5) Work with multiple files simultaneously through dynamic FileDetail views.',
    component: SystemIDEApp
});
```

**改进点**:
- whatItIs：从12个词扩展到48个词，详细说明了功能
- whenToUse：从1个场景变成5个具体场景，每个都说明了具体能力

---

### 案例2: planning-app RootView

#### Before ❌
```tsx
return (
    <div>
        <h1>Planning App</h1>
        <p>You manage plans...</p>
        <p>Available plans: {planIds}</p>
        <ul>
            <li><CreatePlanTool /></li>
            ...
        </ul>
    </div>
);
```

#### After ✅
```tsx
return (
    <>
        <div data-role="application-instruction">
            <h1>Planning App - Application Instruction</h1>
            
            <h2>What it is</h2>
            <p>Planning App is a hierarchical task planning...</p>
            
            <h2>When to use</h2>
            <ul>
                <li><strong>Breaking Down Complex Tasks:</strong> ...</li>
                ...
            </ul>
            
            <h2>How to use</h2>
            <ol>
                <li><strong>Create a Plan:</strong> ...</li>
                ...
            </ol>
            
            <h2>What happened (Current State)</h2>
            <ul>
                <li><strong>Total Plans:</strong> {plans.length}</li>
                <li><strong>Phases Progress:</strong> {completedPhases}/{totalPhases}</li>
                ...
            </ul>
            
            <h2>Available Views</h2>
            <h3>PlanList View</h3>
            <p><strong>Purpose:</strong> ...</p>
            ...
        </div>
        
        <div data-role="available-tools">
            <h2>PlanList View Tools</h2>
            <ul><li><CreatePlanTool /></li>...</ul>
        </div>
    </>
);
```

**改进点**:
- 添加了完整的What/When/How/What happened结构
- 分离了说明（instruction）和工具（tools）
- 添加了Views说明部分
- 显示动态进度信息

---

## 五、检查清单 ✅

在提交App代码前，请确认：

### createTUIApp
- [ ] `whatItIs` 超过50个词，详细说明架构和功能
- [ ] `whenToUse` 列举了5+个具体场景
- [ ] 每个场景都说明了触发条件和预期结果

### RootView
- [ ] 包含完整的 What it is / When to use / How to use / What happened 结构
- [ ] "What happened"部分使用变量显示动态状态
- [ ] Available Views部分说明了每个View的Purpose / When Active / Available Tools
- [ ] 说明部分在工具列表之前

### useViewTypeTool
- [ ] description包含 WHAT / WHEN TO USE / HOW TO USE 结构
- [ ] WHEN TO USE 列举了3+个具体场景
- [ ] HOW TO USE 是步骤化的使用说明
- [ ] 重要工具包含EXAMPLE部分

### 整体语义
- [ ] LLM一看就知道这个App是什么
- [ ] LLM能判断什么时候应该使用这个App
- [ ] LLM知道操作的先后顺序（workflow）
- [ ] LLM能看到当前状态和上次操作结果

---

## 六、常见错误 ❌

### 1. 过于简短
```tsx
// ❌ 错误
whatItIs: 'Planning app'
```
LLM无法理解这个App的核心价值和使用场景。

### 2. 缺少场景
```tsx
// ❌ 错误
whenToUse: 'Use when you need planning'
```
太模糊，LLM不知道什么情况下应该选择这个App。

### 3. 说明在后面
```tsx
// ❌ 错误：工具在前，说明在后
return (
    <>
        <ul><li><Tool1 /></li></ul>
        <h1>App instruction at the end...</h1>
    </>
);
```
LLM必须先看到说明才能理解工具的用途。

### 4. 没有动态状态
```tsx
// ❌ 错误：只有静态文本
<p>This app manages plans.</p>
```

```tsx
// ✅ 正确：显示当前状态
<p>Total Plans: {plans.length}</p>
<p>Active Plan: {activePlan?.title || 'None'}</p>
```

---

## 七、最佳实践总结 🌟

1. **站在LLM视角思考**
   - LLM没有视觉
   - LLM通过Markdown理解App
   - 语义清晰比代码简洁更重要

2. **详细>简洁**
   - 宁可多写50个词，也不要让LLM猜测
   - 每个场景都说清楚触发条件

3. **结构化>自由文本**
   - 使用标题、列表、编号
   - 分离说明和工具
   - What/When/How/What happened结构

4. **动态>静态**
   - 显示当前状态变量
   - 让LLM看到操作结果

5. **示例>抽象**
   - 在description中包含EXAMPLE
   - 用实际对话展示使用方式

---

**记住**: 你不是在写给人类看的UI，而是在写给LLM看的"系统手册"。清晰、详细、结构化是关键！
