# Memora VS Code 插件 · UI 重设计方案

> 状态：设计定稿，待评审后实施
> 日期：2026-08-15
> 关联：[ui-engineering-mindset-rules.md](../../../.trae/rules/ui-engineering-mindset-rules.md)、[plugin-alignment.md](./plugin-alignment.md)、[directory-structure.md](./directory-structure.md)
> 定位：本方案是插件两个 webview 面板（对话 + 大模型配置）的**视觉与信息架构重构清单**。不新增 ADR、不改协议、不引入框架，全部改动在现有分层上自然生长。

---

## 一、背景与目标

插件当前 UI 骨架已遵循「IDE 原生 + 单侧真理源」思路（`--vscode-*` 令牌 + 薄壳 postMessage），但**交互语言偏旧**，缺少 AI 原生产品（Cursor / Copilot Chat / Claude Code）在 2026 年已标准化的关键体验。

**目标**：在现有分层上，把交互语言升级到「AI 原生 + IDE 原生」的当前大厂水准，同时保持：
- **克制**：直角/小圆角、克制配色、高信息密度，完全跟随 `--vscode-*` 主题变量（用户确认：IDE 原生极简）
- **自然生长**：复用现有 `tokens.ts` / `chatView.ts` / `configView.ts` 结构，不改协议、不重写架构
- **克制的动效**：思考折叠块、工具状态色等 AI 原生细节，不堆装饰

**本次交付**：先出本设计文档（含分区结构、令牌、组件清单、验收标准），评审通过后再实施代码。

---

## 二、设计原则（来自 2026 大厂 AI 原生 UI 调研）

| # | 原则 | 说明 | 来源映射 |
|---|------|------|---------|
| P1 | **IDE 原生皮肤** | Webview 侧边栏应跟随 VS Code 设计语言：直角极简、克制配色、高信息密度、主题变量驱动。不引入独立 App 的玻璃拟态/渐变/大圆角 | Copilot Chat / VS Code Webview UI Toolkit / codespine sidebar |
| P2 | **AI 原生交互** | 交互细节引入：流式思考可视化、工具执行 inline 植入对话、输入 composer 多通道、上下文分组 | ChatGPT / Claude Code / Cursor Composer |
| P3 | **克制用色** | 颜色几乎单色，仅用 `--vscode-foreground / descriptionForeground / border`，accent 只留给真实状态信号 | VS Code 原生 chrome |
| P4 | **主动可见** | 操作按钮不 hover-only（已落地，保持），新状态（思考/工具/模型）主动可见 | 用户既有 UX 原则 |
| P5 | **单一真理源** | 令牌/协议/组件只在一处定义，改动遵循现有分层 | ui-engineering-mindset-rules |

> 调研要点：2026 年 AI 原生 UI 的「等待压力」靠**途中展示**（token 流式 + 思考过程折叠 + 工具 inline）而非「转圈等结果」；历史/上下文管理靠**分组**（日期分隔/会话分区）而非平铺长列表。

---

## 三、现状评估（问题清单）

### 3.1 对话面板（[chatPanel.ts](../src/webview/panels/chatPanel.ts) + [chatView.ts](../src/webview/scripts/chatView.ts) + [chatStyles.ts](../src/webview/styles/chatStyles.ts)）

| # | 现状 | 问题 |
|---|------|------|
| C1 | AI 消息无头像/身份，仅 `border-top` 分隔 | 无视觉身份，跨天合并后难区分"谁在说" |
| C2 | `thinking` 只切换发送按钮图标 | 缺思考过程可视化，等待期一片空白 |
| C3 | 工具卡片是独立黑卡片，纯文本参数 | 无图标/状态色，与对话流割裂（[toolCard.ts](../src/webview/components/toolCard.ts)） |
| C4 | 角色徽章是孤立文字条（`roleBar`） | 无角色头像/身份，未与模型/状态整合 |
| C5 | 跨天合并视图无日期分组 | 长会话难定位时间边界 |
| C6 | 空状态是纯文本 | 无引导，新用户不知能做什么 |
| C7 | 活动标题条（`activityBar`）+ 详情折叠（`activityDetail`）顶置 | 顶置挤占消息区，临时状态应内联到对话流附近 |
| C8 | 输入区是 textarea + footer（模型选择 + 发送） | 无附加能力入口，视觉偏"表单"而非"composer" |

### 3.2 大模型配置面板（[providerConfigPanel.ts](../src/webview/panels/providerConfigPanel.ts) + [configView.ts](../src/webview/scripts/configView.ts) + [configStyles.ts](../src/webview/styles/configStyles.ts)）

| # | 现状 | 问题 |
|---|------|------|
| D1 | 顶栏标题 + 添加按钮 | 无统计/状态概览 |
| D2 | Provider 卡片平铺 | 活跃/非活跃无分区，长列表难扫读 |
| D3 | 空状态是纯文本 | 无引导 |
| D4 | 卡片动作为平铺文本按钮 | 信息密度低，无图标/层级 |

---

## 四、目标布局

### 4.1 对话面板（4 分区，自上而下）

```
┌─────────────────────────────────────┐
│ ① 身份条（新）                        │
│  [磨] 文档打磨 · DeepSeek · ●待命中    │  ← 角色头像/名 + 当前模型 + 实时状态
├─────────────────────────────────────┤
│ ② 消息流（优化）                      │
│  ─── 8月15日 今天 ───               │  ← 新增：日期分隔线
│  [用户气泡]                          │
│  [磨] AI 回复 …                      │  ← 新增：AI 头像身份
│       🧠 思考过程 · 3 步 ▾          │  ← 新增：轻量折叠块（流式）
│       🔧 文档自洽审阅  ✓成功         │  ← 优化：带图标/状态色 inline
│  [空状态引导（有内容则隐藏）]          │  ← 优化：提供示例提问
├─────────────────────────────────────┤
│ ③ 活动条（优化）                      │  ← 内联临时状态，不顶置挤占
│  已召回 2 条记忆 · …                 │
├─────────────────────────────────────┤
│ ④ 输入 Composer（优化）               │
│  ┌─────────────────────────────────┐│
│  │  textarea（自适应高度）          ││
│  │  [DeepSeek▾] [🔍联网] [📎]  [↑] ││  ← 模型 + 附加能力 + 发送
│  └─────────────────────────────────┘│
└─────────────────────────────────────┘
```

### 4.2 大模型配置面板（4 分区）

```
┌─────────────────────────────────────┐
│ ① 顶栏（sticky）                     │  ← 新增：统计 + 添加
│  大模型配置 · 已配置 2 个 API   [+添加] │
├─────────────────────────────────────┤
│ ② 激活 Provider                      │  ← 新增：分区
│  [icon] DeepSeek [当前]  deepseek-chat │
├─────────────────────────────────────┤
│ ③ 其他 Provider                      │  ← 新增：分区
│  [icon] 本地        local-model       │
├─────────────────────────────────────┤
│ ④ 空状态引导                          │  ← 优化
└─────────────────────────────────────┘
```

---

## 五、设计令牌扩展（[tokens.ts](../src/webview/styles/tokens.ts)）

仅在 L2 语义令牌层新增，遵循「令牌先行于组件」：

| 令牌 | 值（映射 --vscode-* 或已有令牌） | 用途 |
|------|------|------|
| `--surface-ai-avatar` | `var(--badge-background)` 或 accent | AI 头像底色 |
| `--surface-thought` | `var(--editorWidget-background)` | 思考折叠块底色 |
| `--tool-running` / `--tool-ok` / `--tool-fail` | 复用 `--status-info` / `--status-pass` / `--status-fail`（已存在，不新增） | 工具状态色 |
| `--date-divider` | `--text-secondary` 复用 | 日期分隔线 |
| `--composer-tool-bg` | `--btn-secondary-bg` 复用 | composer 工具 chip |

> 约束：**不新增裸值**；凡已有语义令牌能满足的（如工具状态色、日期分隔色），一律复用，不重复造令牌。

---

## 六、组件清单（新增 / 改造）

### 6.1 对话面板

| 组件 | 类型 | 说明 |
|------|------|------|
| 身份条 `#identityBar` | 改造 `roleBar` | `[avatar][角色名][模型名][状态圆点]` 一行；avatar 用首字 + accent 底 |
| 日期分隔线 `.date-divider` | 新增 | 跨天合并时在日期交界插入「8月15日 今天」，`text-content` 构建防注入 |
| AI 消息头像 `.msg-ai` | 改造 `.msg.assistant` | 左侧加头像，正文与头像分离布局 |
| 思考折叠块 `.thought-block` | 新增 | 消息内一行可折叠 `<details>`，展开显示思考步骤/状态；**不落库、不重放**（运行时一次性） |
| 工具卡片 `ToolCard` | 改造 | header 加图标（复用 `getToolDisplayName`），运行中/成功/失败用状态色点缀；其余保持（折叠、事件委托） |
| Composer 工具 chip | 改造 `#inputFooter` | 模型选择器 + 附加能力 chip 组 + 发送；chip 为 `button`，聚焦可见 |
| 空状态 `.empty-state` | 改造 | 加 2-3 条示例提问（点击填入输入框），更引导 |

### 6.2 配置面板

| 组件 | 类型 | 说明 |
|------|------|------|
| 顶栏统计 `#statBar` | 新增 | 面板顶部显示「已配置 N 个 API」+ 添加按钮 |
| 分区标题 `.group-title` | 新增 | 「激活 Provider」/「其他 Provider」分组标签 |
| 卡片图标 `.cfg-icon` | 新增 | Provider 首字母/图标，提升扫读 |
| 空状态 `.empty-state` | 改造 | 复刻对话面板引导样式 |

> **组件分层纪律**（ui-engineering-mindset-rules §四.3）：现有组件已按 `components/`（dropdown / toolCard）分层。本次新增的日期分隔线、思考折叠块、身份条若仅供对话面板使用，作为面板私有实现（不强制抽组件）；仅当出现第二消费者才下沉到 `components/`。

---

## 七、交互细节

### 7.1 思考过程轻量折叠块（用户确认方案）

- **形态**：AI 消息内一行 `<details class="thought-block"><summary>🧠 思考过程</summary>…</details>`，默认折叠
- **数据**：来自 `selfReview` 事件 / 新增的运行时状态行；**不落库、不重放**（每次回放不重建，避免 DOM 膨胀）
- **流式**：生成中显示「思考中…」+ 呼吸圆点（复用 `self-review` 的 pulse 动效，遵守 `prefers-reduced-motion`）
- **语义**：过程性反馈降级——灰字小字号，与对话主体明显区分

### 7.2 工具卡片状态化

- 保留现有 `show/update/settleRunning` API 与事件委托（不动协议）
- 仅增强视觉：header 名称前加对应工具图标（`getToolDisplayName` 映射），状态文本用 `--status-*` 色

### 7.3 输入 Composer

- 保留 `textarea` 自适应高度、Enter 发送 / Shift+Enter 换行、生成中切换停止等现有逻辑（`chatView.ts` 已实现）
- 仅重排 footer：模型选择器 + 附加能力 chip + 发送按钮，统一 `--control-h` 高度对齐

### 7.4 无障碍（保持并增强）

- 所有新交互（chip / 折叠 summary / 头像）保持 `:focus-visible` 焦点环
- 思考折叠块 `<summary>` 本身可聚焦，键盘可达
- 日期分隔线、头像用 `aria-hidden` 或 `role=presentation` 避免冗余读屏

---

## 八、验收标准

- [ ] 对话面板：身份条整合角色/模型/状态，AI 消息带头像，日期分隔线正确分组
- [ ] 思考折叠块：生成中显示「思考中…」，`selfReview` 时展开显示步骤，结束后保留折叠态，不落库不重放
- [ ] 工具卡片：带图标 + 状态色，运行/成功/失败三种状态正确
- [ ] 输入 composer：模型选择 + 附加能力 chip + 发送，风格统一，聚焦可见
- [ ] 配置面板：顶栏统计 + 分区分组 + 卡片图标 + 空状态引导
- [ ] 明暗主题均正常（`--vscode-*` 驱动），无硬编码裸色
- [ ] `prefers-reduced-motion` 生效，无布局抖动
- [ ] 全量测试通过：typecheck 干净 + 现有测试全过（新增/更新 view 渲染测试）

---

## 九、实施顺序（评审后）

按「令牌 → 组件 → 面板 → 测试」渐进落地，每步独立可验证：

1. **令牌**：在 `tokens.ts` 补 L2 语义令牌（无裸值）
2. **对话面板视觉**：`chatStyles.ts` 重排 ①~④ 分区 + 日期分隔 + 身份条 + 思考折叠块样式
3. **对话面板交互**：`chatView.ts` 增补日期分隔、思考折叠块渲染、composer 排版
4. **工具卡片**：`toolCard.ts` + `toolCard.ts`(styles) 加图标/状态色
5. **配置面板**：`configStyles.ts` + `configView.ts` + `providerConfigPanel.ts` 分区重排
6. **测试**：补 `chatView.test.ts` / `configView.test.ts` 的渲染分支用例，跑全量检查

---

## 十、边界与纪律

1. **不改协议**：所有改动在 `shared/protocol.ts` 现有消息契约内完成（思考折叠块用现有 `selfReview` / `status` 事件驱动，不新增协议消息）
2. **不引入框架**：保持纯 DOM 手写工厂（`chatView.ts` / `configView.ts`），不引 React/Vue
3. **不重复造令牌/组件**：可复用的一律复用（工具状态色、日期分隔色、空状态样式）
4. **克制**：直角/小圆角、克制配色、高信息密度，不做玻璃拟态/渐变/装饰
5. **自然生长**：面向现有结构增量改造，不重写架构