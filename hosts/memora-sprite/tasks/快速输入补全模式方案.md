# 快速输入补全模式 · 方案设计

> **模式**：模块重思 → 产出方案文档（不执行代码修改）
> **日期**：2026-07-07
> **来源**：`memora-sprite-redesign/` 重构方案中提炼——不做推倒重来，而是作为现有 Sprite 的新增功能模块
> **核心原则**：自然生长——不删除现有功能，不改变核心产品形态，新增一个"快速输入"模式作为对话模式的并行入口

---

## 1. 问题分析

### 1.1 现有对话模式的局限

当前 Sprite 的唯一交互模式是"打开完整窗口 → 打字对话 → AI 回复"。这种模式适合：
- 需要深度思考的问题
- 多轮对话探索
- 知识查询和创作

但不适合：
- 只想快速输入一段文本（如邮件开头、IM 回复、代码注释）
- 不需要 AI "回答"，只需要 AI "记住并加速"
- 在另一个应用中工作时，不想切换窗口

### 1.2 redesign 中的核心洞察

原 redesign 有一个关键洞察是正确的：**大厂都在做"AI 回答"，但没人做"AI 记住你怎么打字并加速"**。这个场景真实存在，且与 Sprite 的"个人记忆"核心能力天然契合。

但 redesign 的错误在于：**认为要做这个就必须删除对话模式**。两者可以共存。

### 1.3 用户心智模型

```
对话模式 = "我有问题想问你"（主动提问，AI 回答）
↓
快速输入模式 = "我要写东西，帮我加速"（用户输入，AI 补全）
```

两种模式对应两种使用场景，互不冲突。

---

## 2. 设计方案

### 2.1 产品形态

在现有 Sprite 基础上新增一个**快速输入浮窗**，通过独立快捷键触发：

```
┌─────────────────────────────────────┐
│  [输入你想写的内容...]          [✕]  │  ← 极简输入框（300×80px）
├─────────────────────────────────────┤
│  💡 关于项目的会议记录...           │  ← 补全候选 1（Tab 选择）
│  💡 您好，附件是本周的...           │  ← 补全候选 2
│  💡 收到，我来看一下这个问题        │  ← 补全候选 3
│                         [回车发送]  │
└─────────────────────────────────────┘
```

### 2.2 与现有功能的关系

| 维度 | 对话模式（现有） | 快速输入模式（新增） |
|------|-----------------|---------------------|
| 触发方式 | 托盘/气泡点击、Ctrl+Shift+Space | **新快捷键 Ctrl+Shift+Enter** |
| 窗口形态 | 完整聊天窗口（侧边栏+对话区） | 极简浮窗（300×80px，展开后 300×240px） |
| AI 角色 | 回答者（多轮对话、工具调用） | 补全者（静默建议，不主动说话） |
| 记忆流向 | 对话内容 → 归档为记忆 | 输入内容 → 沉淀为 `source:input-habit` 记忆 |
| 输出方式 | 对话消息流 | 文本发送到剪贴板 / 目标窗口 |
| 精灵主动行为 | 可触发 | 静默（不弹窗、不主动建议） |

### 2.3 核心交互流程

```
用户按 Ctrl+Shift+Enter
  → 快速输入浮窗出现（焦点自动落入输入框）
  → 用户开始打字
  → 输入 ≥3 字符后，记忆引擎召回相关历史输入
  → 显示 Top-5 补全候选（↓↑ 选择，Tab 确认，Esc 取消）
  → 用户确认后，文本：
      - 默认：复制到剪贴板 + 浮窗消失
      - Shift+Enter：尝试发送到当前焦点窗口（模拟粘贴）
  → 后台异步分析输入内容，更新记忆
```

### 2.4 补全候选来源

复用现有 memora 内核的召回能力，按优先级排序：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | 精确前缀匹配 | 用户历史上以相同前缀开头的输入（`source:input-habit`） |
| 2 | 语义相似匹配 | 基于向量嵌入的语义相似度召回（复用现有 VectorStore） |
| 3 | 对话记忆 | 从 `source:user` 的历史对话中提取用户常用句式 |
| 4 | 通用模板 | 内置的常用场景模板（邮件开头、IM 回复、代码注释） |

---

## 3. 技术实现方案

### 3.1 复用现有资产

| 现有模块 | 复用方式 | 改动 |
|---------|---------|------|
| `electron/windows/floatWindow.ts` | 浮动窗口基础设施 | 新增 `createQuickInputWindow()` 方法 |
| `electron/shortcuts.ts` | 全局快捷键管理 | 新增 `quick-input` 动作注册 |
| `electron/ipc/` | IPC 通道体系 | 新增 2-3 个通道（QUICK_INPUT_*） |
| `sprite/sprite.ts` | 精灵核心 | 新增 `getQuickCompletions()` 方法 |
| `sprite/controllers/memoryController.ts` | 记忆召回 | 新增 `searchByPrefix()` 方法（前缀匹配优先） |
| `sprite/controllers/contextAwareness.ts` | 上下文感知 | 新增 `getActiveWindowInfo()` 场景识别 |
| `memora 内核` | 记忆引擎 | **零修改**——通过 `source:input-habit` 区分记忆类型 |

### 3.2 新增模块

```
src/
├── electron/
│   ├── ipc/
│   │   └── quickInputHandlers.ts    # 快速输入 IPC 处理器（~80 行）
│   ├── windows/
│   │   └── quickInputWindow.ts      # 快速输入浮窗管理（~120 行）
│   └── renderer/
│       ├── float/
│       │   └── quickInput.html      # 快速输入浮窗 HTML（~60 行）
│       └── panels/
│           └── quickInputManager.ts # 快速输入 UI 管理器（~250 行）
│
├── sprite/
│   └── controllers/
│       └── quickInputController.ts  # 快速输入控制器（~200 行）
│           # 职责：补全候选生成、输入分析、记忆沉淀
│
└── __tests__/
    └── sprite/controllers/
        └── quickInputController.test.ts
```

**总新增代码量估算**：~800 行（含测试），**零现有代码删除**。

### 3.3 数据流

```
quickInput.html (用户输入)
  → IPC QUICK_INPUT_COMPLETIONS
  → quickInputHandlers.ts (参数校验)
  → quickInputController.ts
      → memoryController.searchByPrefix(prefix)
      → memora 内核 recall (双通道：前缀 + 语义)
      → 排序 (最近使用 + 频率 + 相似度)
  → 返回 Top-5 候选
  → quickInput.html 渲染候选列表

用户确认输入
  → IPC QUICK_INPUT_CONFIRM
  → quickInputHandlers.ts
      → 复制到剪贴板 (或 SendInput 到目标窗口)
      → quickInputController.analyzeAndStore(text, targetApp)
          → 敏感过滤 (复用剪贴板三重保护)
          → 后台 LLM 分析 (异步，复用 LLM 韧性逻辑)
          → 写入 memora 内核 (source: input-habit)
```

### 3.4 场景识别（可选，Phase 2）

通过 `contextAwareness.ts` 获取当前焦点窗口信息（Electron 不直接支持，但可通过 `node-ffi` 或 PowerShell 调用 Windows API）：

```typescript
// 伪代码
interface ActiveWindowInfo {
  appName: string;      // 'wechat.exe' | 'outlook.exe' | 'code.exe'
  windowTitle: string;  // 窗口标题
}

// 场景 → 补全策略映射
const SCENE_STRATEGIES = {
  'wechat': { boostTemplates: ['casual-reply', 'greeting'] },
  'outlook': { boostTemplates: ['formal-open', 'sign-off'] },
  'code': { boostTemplates: ['function-doc', 'todo-comment'] },
};
```

**Phase 1 不做场景识别**（降低 MVP 复杂度），默认使用通用策略。

---

## 4. 与现有功能的关系处理

### 4.1 不冲突的设计

- **快捷键**：`Ctrl+Shift+Enter`（快速输入）与 `Ctrl+Shift+Space`（对话窗口）独立
- **记忆存储**：`source:input-habit` 与 `source:user`/`source:content` 共存，互不干扰
- **精灵主动行为**：快速输入模式下静默（不触发 proactiveEngine），对话模式正常
- **UI 组件**：快速输入浮窗是独立的 `BrowserWindow`，与现有浮动气泡/完整窗口并行

### 4.2 记忆的统一

快速输入模式产生的记忆（`source:input-habit`）与对话模式产生的记忆共享同一个 `memora.db`，统一参与：
- 衰减调度（复用现有 MemoryDecayScheduler）
- 语义搜索召回（双通道中 `input-habit` 作为可召回源）
- 健康度评估（复用现有 memoryHealth）

### 4.3 设置面板集成

在设置面板中新增"快速输入"标签页（或合并到现有标签页）：
- 快捷键自定义
- 补全候选数量（默认 5）
- 自动复制到剪贴板 / 尝试发送到目标窗口
- 输入历史管理（查看/清空 `input-habit` 记忆）

---

## 5. MVP 分阶段计划

### Phase 1：骨架（1-2 周）

**目标**：可呼出输入框、输入文本、发送到剪贴板。（无补全、无记忆）

| 任务 | 涉及模块 | 预估 |
|------|---------|------|
| 新增 `Ctrl+Shift+Enter` 快捷键 | `shortcuts.ts` | 0.5 天 |
| 创建快速输入浮窗 HTML | `quickInput.html` + `quickInputWindow.ts` | 1 天 |
| 实现输入框 UI 管理器 | `quickInputManager.ts` | 1.5 天 |
| 实现文本发送（剪贴板） | `quickInputHandlers.ts` | 1 天 |
| IPC 通道注册 + preload 暴露 | `channels.ts` + `preload.ts` | 0.5 天 |
| 测试 | `__tests__/` | 1 天 |

**交付物**：按 `Ctrl+Shift+Enter` → 浮窗输入 → 回车复制到剪贴板。

### Phase 2：记忆与补全（2-3 周）

**目标**：输入时有基于个人记忆的智能补全建议。

| 任务 | 涉及模块 | 预估 |
|------|---------|------|
| 实现 `quickInputController` | `quickInputController.ts` | 2 天 |
| 实现前缀匹配召回 | `memoryController.ts` 新增 `searchByPrefix` | 1.5 天 |
| 接入语义召回 | 复用现有 `recall` 管线 | 1 天 |
| 补全候选排序 + 渲染 | `quickInputManager.ts` | 1.5 天 |
| 后台输入分析（LLM 异步） | `quickInputController.analyzeAndStore` | 2 天 |
| 测试 | `__tests__/` | 2 天 |

**交付物**：输入时显示 3-5 个补全候选，Tab 选择，后台异步沉淀记忆。

### Phase 3：场景识别（可选，1-2 周）

**目标**：根据当前焦点应用提供不同补全策略。

| 任务 | 涉及模块 | 预估 |
|------|---------|------|
| 实现窗口信息获取 | `contextAwareness.ts` 新增方法 | 2 天 |
| 场景 → 策略映射表 | `quickInputController.ts` | 1 天 |
| 设置面板集成 | `settingsPanelManager.ts` | 1 天 |
| 测试 | `__tests__/` | 1 天 |

---

## 6. 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 快捷键冲突 | 中 | 用户无法触发 | 允许自定义快捷键；与现有快捷键不重叠 |
| 补全质量低（冷启动） | 高 | 初期体验差 | 内置通用模板兜底；补全标注"个人记忆"vs"通用模板"来源 |
| 目标窗口文本注入失败 | 中 | 仅能复制到剪贴板 | 默认行为是复制到剪贴板（最兼容）；SendInput 作为可选增强 |
| 记忆量膨胀 | 低 | 召回性能下降 | 复用现有衰减机制；`input-habit` 记忆 score 初始值 0.5（低于对话记忆的 0.7），优先衰减 |
| 与现有代码冲突 | 低 | 构建失败 | 纯新增模块，零修改现有代码 |

---

## 7. 决策建议

**推荐执行 Phase 1 + Phase 2**（共 3-5 周），Phase 3（场景识别）等有真实使用反馈后再决定。

**不做的**：
- 删除对话模式（已有用户习惯）
- 删除角色/技能/话题系统（已有功能完整性）
- 改变核心产品定位（"对话 Agent"仍是主线）

**做减法的**：
- 快速输入模式本身做减法：静默、不弹窗、不主动建议、不角色切换
- 代码做减法：纯新增模块，不修改现有代码，独立可回滚

---

## 8. 与 redesign 的差异总结

| 维度 | redesign（已废弃） | 本方案 |
|------|-------------------|--------|
| 对话模式 | 删除 | 保留 |
| 角色/技能/话题 | 删除 | 保留 |
| 快速输入 | 唯一交互模式 | 新增并行模式 |
| 产品定位 | 转型为输入工具 | 对话 Agent + 输入加速 |
| 代码改动 | 大量删除 + 重构 | 纯新增 ~800 行 |
| 工期 | 7-10 周 | 3-5 周 |
| 风险 | 核心假设不成立则全盘失败 | 低风险，功能独立可回滚 |