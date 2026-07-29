# 迭 3 评审报告

> 日期：2026-07-29 | 来源：`ux-review-iteration-plan-2026-07-29.md`

---

## 3-1：M3 空态收口 — createEmptyState 工厂收敛

### 现状分析

手写空态统计（共 ~18 处），按实现方式分两类：

| 类别 | 特征 | 数量 | 示例 | 是否可收口 |
|------|------|------|------|-----------|
| **Type A** — DOM 引用 | `document.getElementById('xxx-empty')` 从 `index.html` 预定义 DOM，JS 仅控制可见性 | **7** | `#chat-empty-state`、`#clipboard-empty-state`、`#dashboard-growth-empty`、`#memory-graph-empty`、`#perception-proactive-empty`、5×`#xxx-config-empty` | ❌ 不应也不能。这些元素有复杂 HTML 内联结构（图标+文案+按钮），不可用简单工厂替换 |
| **Type B** — createEl 手写 | `createEl('div', 'xxx-empty', '文案')` 忽略基线 `.empty-state` 类，各写 CSS | **9** | `auditPanelManager.ts:162`、`completionStatsRenderer.ts:196/278`、`dateNavManager.ts:238`、`llmGovernanceResultRenderer.ts:147/198`、`partnerInsightsRenderer.ts:181/239`、`profilePanelManager.ts:164`、`workProjectionPanelManager.ts:147` | ✅ 可收敛 |
| **Type C** — 已用工厂 | `createEmptyState(...)` | **2** | `memoryTimelineView.ts:78`、`memoryPanelManager.ts:341` | ✅ 已是目标状态 |

**关键结论**：实际收敛范围只有 **Type B（9 处）**，不是最初估计的 10+。Type A 根本不应修改。

### 工厂 API 已支持全部需求

`createEmptyState(options)` 支持：`panelPrefix`（饰类）、`iconHtml`（可选图标）、`title`（必须）、`subtitle`（可选副标题）、`ctaText`/`ctaOnClick`（可选 CTA 按钮）。

Type B 的 9 处手写空态均为「纯文字、无图标、无 CTA」，可零取舍映射到 `createEmptyState({ title: '...' })`。

### 评审结论

**可行。建议执行。** 风险低（纯文字空态替换，零行为变更）、范围清晰（9 处）、收益明确（统一 `.empty-state` 基线类，消除视觉漂移）。

---

## 3-2：ListPanel/DetailPanel 工厂 — 记忆/审计/设置三面板抽取

### 现状分析

| 面板 | 行数 | 结构 | 复杂度 |
|------|------|------|--------|
| `memoryPanelManager.ts` | 1458 | 多子视图（列表/时间线/图谱/详情）+ 嵌套 tab + 搜索/切换 | 极高 |
| `settingsPanelManager.ts` | 1044 | 多 tab（LLM/精灵/画像/审计/帮助）+ 表单 + 保存/取消 | 高 |
| `auditPanelManager.ts` | 236 | 单列表 + 刷新/清空 + 事件符号渲染 | 低 |

### 结构相似度评估

§四.2 称三面板有「标题 + 列表 + 详情」共同结构。实测：

- **标题区**：三者确实都有 `panel-header` + `panel-title`，但这是 **所有面板的通用骨架**（`app-grid.css` / `index.html` 提供），不是可以被工厂抽象的业务差异。
- **列表区**：memory 有搜索+筛选+四视图切换，settings 是 tab 式配置表单，audit 是简单列表 —— 三者列表引擎完全不同。
- **详情区**：memory 有弹窗详情 + 演化脉络 + 邻居关系（多层嵌套），settings 有 Provider 弹窗编辑，audit 没有详情视图。

**结论**：三个面板 **不共享足够多的结构相似度**。被点名的「标题+列表+详情」是表单/列表型面板的通用骨架，不足以支撑工厂抽象。按 §四.2 自身的判定原则（"抽工厂的触发条件是「已有 3 处重复」，不是「将来可能有 3 处」"），这三者不满足触发条件——它们只有 **结构性相似**（所有列表型面板都这样），没有 **配置化相似**（可被一份配置描述的形态）。

### 评审结论

**不建议立即执行。建议延后。** 

理由：
1. 规则自身约束：§四.2 要求"已有 3 处重复"才抽，但这三者仅是「标题+列表」的骨架相似，不是"可被配置声明差异"的结构相同
2. 成本收益比差：audit 仅 236 行，抽工厂反而增加理解成本（需要跳转到工厂文件看默认行为 + 再回到配置看覆写）
3. 最危险的是：强行抽象会导致 God Object（工厂必须同时支持列表/时间线/图谱/配置表单/搜索/筛选——每种视图的需求互相冲突）
4. 正确路径：「先让新面板自然生长」——当出现**第 4 个**需要"简单列表 + 详情弹窗"的面板时，把最像的两个抽工厂，而不是把最不像的三个强扭在一起

### 替代方案（迭代 4 可选）

如果将来真的需要更多列表型面板，建议：
- 先抽 `SimpleListPanel`（用于 audit、clipboard、work-projection 这类**无复杂子视图**的单列表）
- 再考虑 `TabbedConfigPanel`（用于 settings、sprite-settings 这类**tab 式配置**）
- memory panel 因复杂度极高，不适合硬塞工厂

---

## 迭 3 修正建议

| 原计划 | 修正后 | 原因 |
|--------|--------|------|
| 3-1 全量空态收口（10+ 处） | 仅 Type B 9 处 `createEl` 手写 → factory | Type A 7 处 DOM 引用不应修改 |
| 3-2 ListPanel 工厂 | **搁置**，延后至第 4 个列表型面板出现时重新评估 | 三面板结构差异大，强制抽象即 God Object |

**修正后 3-1 实际范围**：9 个文件 × 9 处修改（每处将 `createEl('div', 'xxx-empty', '文案')` 替换为 `createEmptyState({ title: '文案' })`），纯参数变换，零风险。
