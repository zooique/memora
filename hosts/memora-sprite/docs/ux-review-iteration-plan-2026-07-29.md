# 体验评审 · 排雷 + 优化迭代方案

> 来源：`ux-review-full-window-2026-07-29.md`（v2 规则对齐版）
> 日期：2026-07-29
> 模式：`big-tree-grower` 排雷（plan-audit）→ 产出优化方案 → 执行

---

## 排雷核实结论

逐项交叉验证报告 8 个 findings 的代码真值与可行动性：

| # | Finding | 核实结果 | 行动决策 |
|---|---------|---------|---------|
| M1 | 加载态严重不足 | ✅ 真。`showPanelLoading` 仅 3 处，dashboard/perception/profile/audit/workProjection/memory 无 loading 态。规则 §四.2 点名为工厂横切责任。 | **迭 2 / 中风险**。需逐面板加 loading，不可批量写。 |
| M2 | 侧边栏 64px 纯图标无 tooltip | ✅ 真。sidebar.css:145-146 确认 tooltip 气泡已弃用；规则未禁止但属发现性风险。 | **迭 2 / 低风险**。纯 CSS + HTML，加 `data-tooltip` 属性即可。 |
| M3 | 空态碎片化 + 48px 泄露 | ✅ 真。(a) 碎片化：`createEmptyState` 仅 2/10+ 面板使用；(b) 泄露：`base.css:332` 48px 裸 `padding` 违反 §一 + §2.4.6。规则 §二 + §四.2 点名为架构债。 | (a) 架构级 → **迭 3**；(b) 令牌泄露 → **迭 1**（已核实：仅一处 48px 用于 padding，其余均为宽高例外/注释引用）。 |
| L1 | 画布蓝 fallback | ✅ 真。3 文件 4 处硬编码蓝（`#0066ff` + `rgba(0,102,255,0.1)`）。正常运营不触发，但 fallback 值与 teal token 冲突 + 手动同步脆弱。**排雷新发现：`--muted`/`--text-3` 的 fallback 与 tokens.css 实际值也漂移**（light `#7a7a82→#6a6a72`，dark `#a1a1a6→#b5bcd6`）。 | **迭 1 / 零风险**。纯常量 + 字符串替换。 |
| L2 | icon-btn 28px | ⚠️ 不适用。`sprite-project-rules.md` §6 不做移动端 → 44px 触控建议不适用。 | **不修**。保留当前值。 |
| L3 | 视觉个性偏弱 | ⚠️ 主观审美判断，非缺陷。`--accent:#0d7377` 已避开模板风。 | **不修**。属设计取舍，非 Bug。 |
| L4 | token-usage 技术词 | ⚠️ 排雷降级。`id="token-usage"`/`class="token-usage"` 是 DOM 标识符，非用户可见文案。 | **不修**。误报解除。 |
| L5 | aria-labelledby→隐藏标题 | ✅ 真。4 个 nav-btn 的 `aria-labelledby` 指向默认 `aria-hidden` 面板标题。 | **迭 1 / 零风险**。给 nav-btn 加独立 `aria-label`。 |

**排雷额外发现**（原报告未覆盖）：
- `relationGraphColor.ts` 的 `--muted`/`--text-3` fallback 值与 tokens.css 实际令牌两端均漂移（见 L1 核实）。

---

## 迭代方案

### 迭代 1（立即执行 · 零风险 · 纯改值 / 加注释，无行为变更）

| # | 文件 | 行 | 修改 |
|---|------|----|------|
| 1-1 | `helpers/relationGraphColor.ts` | 70 | `'#0066ff'` → `'#0d7377'`（--accent 对齐 teal） |
| 1-2 | `helpers/relationGraphColor.ts` | 71 | `() => '#7a7a82'` → `() => (isDarkTheme() ? '#b5bcd6' : '#6a6a72')`（--muted 双主题对齐） |
| 1-3 | `helpers/relationGraphColor.ts` | 75 | `'#7a7a82'` → `'#6a6a72'`（--text-3 浅色对齐 muted 令牌） |
| 1-4 | `panels/dashboardPanelManager.ts` | 689 | `'#0066ff'` → `'#0d7377'` |
| 1-5 | `panels/partnerInsightsRenderer.ts` | 340 | `'#0066ff'` → `'#0d7377'` |
| 1-6 | `panels/partnerInsightsRenderer.ts` | 341 | `'rgba(0, 102, 255, 0.1)'` → `isDark ? 'rgba(45, 181, 187, 0.2)' : 'rgba(13, 115, 119, 0.1)'`（--accent-20 双主题对齐 tokens.css:141/421） |
| 1-7 | `styles/foundation/base.css` | 332 | `padding: 48px var(--space-6);` → `padding: 48px var(--space-6); /* 非标: --space-* 刻度不含 48px，间距刻度扩展待迭代评估时纳入 */` |
| 1-8 | `index.html` | 220,224,228,240 | 4 个 nav-btn：`aria-labelledby="panel-title-*"` → `aria-label="记忆"/"精灵设定"/"剪贴板"/"设置"` + 保留 `aria-labelledby` 为 `aria-describedby`（提供上下文） |

### 迭代 2（低风险 · 高价值 UX 增强）

| # | 内容 | 工作量 |
|---|------|--------|
| 2-1 | M2 侧边栏 hover tooltip：sidebar.css 恢复 `data-tooltip` 伪元素 + index.html nav-btn 加 `data-tooltip` 属性 | 低（2 文件，~20 行 CSS + 4 属性） |
| 2-2 | M1 加载态：为 dashboardPanelManager / perceptionPanelManager / profilePanelManager / workProjectionPanelManager 异步入口加 `showPanelLoading` 骨架 | 中（4 面板，需理解各异步加载入口） |

### 迭代 3 — 修正后（Type B 空态收口 · 9 处 · 低风险）

> **评审结论**（详见 `docs/ux-review-iteration-3-assessment.md`）：
> - 3-1 缩小范围：Type A（DOM 引用 7 处）不可收口，仅收敛 **Type B 9 处** `createEl` 手写 → `createEmptyState`
> - 3-2 **搁置**：三面板（memory/settings/audit）结构差异大，1458/1044/236 行，「标题+列表+详情」骨架是所有列表型面板的共性而非差异化配置，不满足工厂触发条件。延后至第 4 个列表型面板出现再评估。

| # | 文件 | 修改 |
|---|------|------|
| 3-1 | `panels/auditPanelManager.ts:162` | `createEl('div', 'profile-empty', …)` → `createEmptyState({ title: '暂无审计记录' })` |
| 3-1 | `panels/completionStatsRenderer.ts:196` | → `createEmptyState({ title: '暂无统计数据…' })` |
| 3-1 | `panels/completionStatsRenderer.ts:278` | → `createEmptyState({ title: '暂无趋势数据…' })` |
| 3-1 | `panels/dateNavManager.ts:238` | → `createEmptyState({ title: '暂无对话记录' })` |
| 3-1 | `panels/llmGovernanceResultRenderer.ts:147` | → `createEmptyState({ title: '未发现语义冲突' })` |
| 3-1 | `panels/llmGovernanceResultRenderer.ts:198` | → `createEmptyState({ title: '无需降级' })` |
| 3-1 | `panels/partnerInsightsRenderer.ts:181` | → `createEmptyState` + 适配 `partner-empty-hint` |
| 3-1 | `panels/partnerInsightsRenderer.ts:239` | 同上 |
| 3-1 | `panels/profilePanelManager.ts:164` | → `createEmptyState({ title: '暂无待确认条目' })` |
| 3-1 | `panels/searchMessagesManager.ts:444` | → `createEmptyState({ title: message })` |
| 3-1 | `panels/workProjectionPanelManager.ts:147` | → `createEmptyState({ title: '暂无作品投影' })` |
| 3-1 | `helpers/memoryDetailPanel.ts:202,340` | `lineage-empty` × 2 → `createEmptyState` |

---

## 执行状态

- [x] **迭代 1** — ✅ 已完成（2026-07-29）
  - 修改文件：5 个（`relationGraphColor.ts`、`dashboardPanelManager.ts`、`partnerInsightsRenderer.ts`、`base.css`、`index.html`）
  - 实际修复数：11 处（原计划 8 + 排雷新发现 3 处 `--text-3` 漂移）
  - 验证：grep 核实所有旧蓝值/漂移值已清除，新 teal/令牌值已落位
  - 残留：`dashboardPanelManager.ts:863/865` JSDoc 示例注释含 `#0066ff`（非执行代码，低优下次清理）
- [x] **迭代 2** — ✅ 已完成（2026-07-29）
  - 2-1 M2 侧边栏 tooltip：sidebar.css 恢复 `nav-btn::after` hover 提示气泡 + index.html 4 nav-btn 加 `data-tooltip` 属性
  - 2-2 M1 加载态：`profilePanelManager.load()` / `workProjectionPanelManager.load()` / `memoryOrchestrator.loadDashboard()` / `memoryOrchestrator.loadPerception()` 共 4 处异步入口加 `showPanelLoading` 骨架
  - 修改文件：5 个（`sidebar.css`、`index.html`、`profilePanelManager.ts`、`workProjectionPanelManager.ts`、`memoryOrchestrator.ts`）
  - 验证：grep 确认所有修改落位 + `tsc --noEmit` 零错误通过
- [x] **迭代 3（修正后）** — ✅ 已完成（2026-07-29·方案A: CSS先行对齐+JS替换+删死CSS）
  - 3-1 JS转换：7 文件 import + 10 处 `createEl` → `createEmptyState`（排除 `llm-result-empty`/`partner-empty-hint` 语义不同不转换）
  - 3-1 CSS清理：6 个死规则删除（`.completion-stats-empty`/`-trend-empty`/`.date-nav-empty`/`.search-messages-empty`/`.work-projection-empty`/`.lineage-empty`）
  - 保留 `.profile-empty`（HTML 预定义骨架需要）/ `.work-projection-empty-hint` / `.llm-result-empty` / `.partner-empty-hint`
  - 验证：grep 旧模式零命中 + `tsc --noEmit` 零错误 + `stylelint` 零告警
  - 迭1+2+3合计：17 文件 ~30 处修改
