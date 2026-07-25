# Memora 精灵 · 统一视觉语言（Visual Language Spec）

> 任务 #18 交付物。配套重设计任务：#19 统计洞察页 / #20 健康度页 / #21 伙伴洞察页 / #22 质量门。
> 约束：每次改动遵循"第一性原理 + 对抗式审查"。

---

## 0. 问题与第一性原理

**用户反馈**：统计洞察 / 健康度 / 伙伴洞察 三块分析面板的 UI 与整体设计"不搭、比较乱"，需要重设计，并先提炼统一的设计风格与视觉语言，降低使用者视觉成本。

**对抗式根因核查（非记忆，已读源码验证）**：

| 面板 | 现状 | 问题定性 |
|---|---|---|
| completion-stats | 用 `.stat-card` / `.metric-track`（analysis-panel.css 共享外壳） | ✅ **对齐基准**，作为唯一"搭"的参照 |
| 统计洞察 `.insights-bar` | 自有 `.insights-*`：`.insights-stat` / `.insights-distribution-bar` / `.distribution-fill` / `.insights-relation-item` / `.insights-section-title` | ❌ 自创视觉词汇，与外壳不互通 |
| 健康度 `.health-bar` | 自有 `.health-*`：`.health-badge` / `.health-score` / **`.health-metric-track` / `.health-metric-fill`** / `.health-detail-item` | ❌ 不仅自创，且 **`.health-metric-track`/`.health-metric-fill` 是外壳 `.metric-track` 的逐字重复实现**（双重真相，最严重） |
| 伙伴洞察 `.partner-insights` | 自有 `.partner-*`：`.partner-profile-card` / `.partner-gap-item` / `.partner-growth-*` | ❌ 自创词汇；但 token 取值（surface0/border/radius-sm）已接近规范，属"命名散落"而非"视觉走样" |

**第一性原理结论**：
1. 任何"视觉原子"（一张卡 / 一条进度条 / 一个标签 / 一个区块标题）在代码里**只应有一个定义、一个名字**。
2. 设计系统单一真理源 = `tokens.css`（令牌）+ `analysis-panel.css`（共享组件外壳）。新增/复用组件**必须先查外壳**，禁止在面板文件里再发明。
3. 用户价值：统一词汇 → 三页"同属一个产品"，视觉扫描成本下降。

---

## 1. 设计令牌（已存在，唯一真理源，不重定义）

从 `tokens.css` 摘录关键尺度，作为所有组件的唯一取值来源：

- **间距**：`--space-1`(4) ~ `--space-8`(32)，半档 `--space-1-5`(6)/`--space-2-5`(10)/`--space-7`(28)
- **圆角**：`--radius-xs`(3)/`--radius-sm`(6)/`--radius-md`(10)/`--radius-lg`(12)/`--radius-xl`(18)/`--radius-pill`(100)
- **字号**：`--font-2xs`(10) ~ `--font-2xl`(28)；标题 `--font-h1`(18)/`--font-score`(20)
- **字重**：`--weight-regular`(400)/`--weight-medium`(500)/`--weight-semibold`(600)/`--weight-bold`(700)
- **表面**：`--window-bg` / `--window-bg-2` / `--surface0..3` / `--border`
- **文字**：`--text` / `--text-2` / `--text-3` / `--text-4`
- **强调**：`--accent` / `--accent-20` / `--accent-soft` / `--active-*`
- **语义色**：`--green`/`--red`/`--yellow`/`--mauve`/`--teal`/`--peach` + `-20` 浅底（badge/标签背景）
- **阴影**：`--shadow-sm` / `--shadow` / `--shadow-window`；**过渡**：`--transition-fast`(0.15s)/`--transition-base`(0.2s)/`--transition-xl`(0.3s)

---

## 2. 统一组件词汇表（Single Source of Truth → `analysis-panel.css`）

每个组件给出：类名、用途、关键令牌、双主题。三页所有对应元素**必须**复用这些类，禁止在面板 CSS 里再写等价规则。

### 2.1 面板根 `.analysis-panel`（已有）
`display:flex; flex-direction:column; overflow-y:auto; padding:var(--pad-card); background:var(--window-bg);`

### 2.2 头部 `.analysis-panel__header` / `__title` / `__close`（已有）
标题 `--font-sm` `semibold` `--text`；关闭复用 `.panel-close-btn`。

### 2.3 统计卡 `.stat-card` + `__value`/`__label`/`__hint`（已有）+ `--accent` 修饰
- value：`--font-lg`(16) `bold` `--text`（tabular-nums）
- label：`--font-xs` `--text-2`
- hint：`--font-xs` `--text-3`
- `--accent` 修饰：value 转 `--accent`
- → 三页所有"数字 + 标签"KPI 用此卡，删 `.insights-stat` / 各自数字样式。

### 2.4 指标条 `.metric-track` + `__fill`（已有）
6px，`bg:var(--surface0)`，`fill:var(--accent)`，`transition:width var(--transition-xl)`。
→ 健康度三行**必须**复用，**删除 `.health-metric-track` / `.health-metric-fill`**（逐字重复）。

### 2.5 区块标题 `.panel-section-title`（**新增**）
`--font-xs` `semibold` `--text-2`，`margin-bottom:var(--space-1)`。
→ 替代散落的 `.insights-section-title` / `.partner-growth-title` / `.completion-stats-events-title` / `.completion-stats-trend-title`（四者现状取值完全相同，属重复定义）。

### 2.6 分布条（source 分布）`.dist-bar`（**新增**）
- `.dist-bar`：`display:flex; align-items:center; gap:var(--space-1-5); --font-xs`
- `.dist-bar__label`：`width:60px; flex-shrink:0; --text-2; truncate`
- `.dist-bar__fill`：`flex:1; height:6px; --radius-xs; min-width:2px; transition:width var(--transition-fast)`；颜色由 `.source-*` 修饰类提供（沿用现有跨面板 source 配色）
- `.dist-bar__count`：`flex-shrink:0; --text-2; tabular-nums; min-width:24px; text-align:right`
- → 替代 `.insights-distribution-bar` / `.distribution-label` / `.distribution-fill` / `.distribution-count`。

### 2.7 关系项 + 类型标签 `.relation-item` / `.relation-type-tag`（**提升为共享**）
- `.relation-item`：`display:flex; align-items:center; gap:var(--gap-compact); --font-sm; padding:3px 0`
- `.relation-type-tag`：`padding:1px var(--space-1-5); --radius-sm; --font-2xs; medium`；6 种类型色（`contradicts`→red-20/red、`supports`→green-20/green、`follows`→accent-20/accent、`refines`→yellow-20/yellow、`caused`→mauve-20/mauve、`related`→muted/text）提升到外壳（现定义于 insights.css，memoryDetailPanel.ts 也用，故应提升为共享）
- → 替代 `.insights-relation-item`（保留 `.relation-type-tag` 名称，提升位置）。

### 2.8 徽章 / 胶囊 `.panel-badge` / `.panel-chip`（**新增**）
- `.panel-badge`：`padding:2px var(--space-2); --radius-pill; --font-xs; medium`；修饰 `excellent`(green-20/green)/`good`(accent-20/accent)/`fair`(yellow-20/yellow)/`poor`(red-20/red)
- `.panel-chip`：`--font-2xs; --text-2; background:var(--surface1); border:1px solid var(--surface2); --radius-pill; padding:2px var(--space-2)`；修饰 `warning`(yellow-20/yellow)/`danger`(red-20/red)
- → 替代 `.health-badge` / `.health-detail-item`。

### 2.9 评分 `.panel-score` / `.panel-score-sample`（**新增**）
- `.panel-score`：`--font-score`(20) `bold` `--text` `tabular-nums`；保留 `scoreReveal` 动画（从 health.css 迁此）
- `.panel-score-sample`：`--font-xs; regular; --text-3; margin-left:2px`
- → 替代 `.health-score` / `.health-score-sample`。

### 2.10 画像卡网格 `.profile-cards` / `.profile-card`（**提升/新增**）
- `.profile-cards`：`display:grid; grid-template-columns:1fr 1fr; gap:var(--space-1-5)`
- `.profile-card`：`background:var(--surface0); border:1px solid var(--surface2); --radius-sm; padding:var(--space-2-5); cursor:pointer; transition`（hover：`--surface1` + border `--muted` + `translateY(-1px)`）
- 子元素 `.profile-card-name`(--font-xs semibold --text) / `.profile-card-preview`(--font-xs --text-3, 2 行截断)
- → 替代 `.partner-profile-cards` / `.partner-profile-card`（含 `-name`/`-preview`）。

### 2.11 知识缺口项 `.gap-item`（**新增**）
`display:flex; align-items:center; gap:var(--gap-compact); padding:var(--input-padding); background:var(--surface0); border:1px dashed var(--surface2); --radius-sm; --font-xs; --text-2`
→ 替代 `.partner-gap-item`（图标 `.partner-gap-icon` 属图标元素，保留）。

---

## 3. 当前分叉审计（bespoke → 共享映射）

| 面板 | bespoke 类 | 共享等价 | 动作 |
|---|---|---|---|
| insights | `.insights-bar` 根 | 加共享 `.analysis-bar` 根类 | 对齐 padding/bg/collapse，删 bespoke 根规则 |
| insights | `.insights-header`/`.insights-title` | `.analysis-panel__header`/`__title` | 重命名 |
| insights | `.insights-stat`/`-value`/`-label` | `.stat-card`/`__value`/`__label` | 重命名 |
| insights | `.insights-distribution-bar`/`.distribution-label`/`.distribution-fill`/`.distribution-count` | `.dist-bar`/`__label`/`__fill`/`__count` | 重命名 |
| insights | `.insights-relation-item` | `.relation-item` | 重命名；`.relation-type-tag` 提升共享 |
| insights | `.insights-section-title` | `.panel-section-title` | 重命名 |
| insights | `.insights-stats`/`.insights-row`/`.insights-section` | `.stat-card` 网格 + `.panel-section` 间距 | 用外壳结构 |
| health | `.health-bar` 根 | 加共享 `.analysis-bar` | 对齐 |
| health | `.health-header`/`.health-title` | `.analysis-panel__header`/`__title` | 重命名 |
| health | `.health-badge` | `.panel-badge` | 重命名 |
| health | `.health-score`/`.health-score-sample` | `.panel-score`/`.panel-score-sample` | 重命名 |
| health | `.health-metric-track`/`.health-metric-fill` | `.metric-track`/`__fill` | **删除**（逐字重复外壳） |
| health | `.health-detail-item` | `.panel-chip` | 重命名 |
| health | `.health-description` | 通用文本（`--font-xs --text-3`） | 直接用工具类/原子 |
| health | `.health-llm-*` | 保留（LLM 治理专属，无共享对应，对齐令牌即可） | 不动结构 |
| health | `.health-actions`/按钮 | 已收口 `.btn*`（不动） | — |
| partner | `.partner-insights` 根 | 加共享 `.analysis-bar` | 对齐 |
| partner | `.partner-insights-header`/`.partner-insights-title` | `.analysis-panel__header`/`__title` | 重命名 |
| partner | `.partner-profile-cards`/`.partner-profile-card`(-name/-preview) | `.profile-cards`/`.profile-card`(-name/-preview) | 重命名 |
| partner | `.partner-knowledge-gaps`/`.partner-gap-item` | 容器用 `.panel-section`；`.gap-item` | 重命名 |
| partner | `.partner-growth-section`/`-header`/`-title`/`-total` | 标题用 `.panel-section-title`；其余对齐令牌 | 重命名/对齐 |
| partner | `.partner-growth-chart`（Canvas） | 保留（Canvas 专属），用共享 border/radius/bg 令牌 | 仅对齐令牌 |
| partner | `.partner-empty-hint` | 保留（空态提示文本，语义专属） | 不动 |

---

## 4. 三页重设计映射（落地细则）

### 4.1 统计洞察页（#19）
- **index.html**：`#memory-insights-bar` 根加 `analysis-bar`；`insights-header`→`analysis-panel__header`+`analysis-panel__title`；4 个 `insights-stat`→`stat-card`（`insights-stat-value`→`stat-card__value`，冲突数保留 `conflict-value has-conflicts` 修饰，挂在 `__value` 上）；`insights-distribution-bar`→`dist-bar` 系列；`insights-relation-item`→`relation-item`；`insights-section-title`→`panel-section-title`。
- **insightsRenderer.ts**：`createEl('div','insights-section-title',...)`→`'panel-section-title'`；`createEl('div','insights-relation-item')`→`'relation-item'`；`createEl('div',`distribution-fill source-...`)`→``dist-bar__fill source-...``。
- **insights.css**：删除全部 `.insights-*` 规则（已迁外壳）；`relation-type-tag` 类型色规则迁 analysis-panel.css。
- **测试**：`insightsRenderer.test.ts` 的 `.distribution-fill`→`.dist-bar__fill`、`.insights-section-title`→`.panel-section-title`、`.insights-relation-item`→`.relation-item` 选择器更新。

### 4.2 健康度页（#20）
- **index.html**：`#memory-health-bar` 根加 `analysis-bar`；`health-header`→`analysis-panel__header`+`analysis-panel__title`；`health-badge`→`panel-badge`；`health-score`/`-sample`→`panel-score`/`-sample`；`health-metric-track`/`health-metric-fill`→`metric-track`/`metric-track__fill`（修饰 `uniqueness`/`freshness`/`completeness` 颜色挂 `__fill` 上，迁 analysis-panel.css）；`health-detail-item`→`panel-chip`（warning/danger 修饰）。
- **healthDashboardRenderer.ts**：`badgeEl.className='health-badge'`→`'panel-badge'`；`fillEl.className=`health-metric-fill ${cssClass}``→``metric-track__fill ${cssClass}``；`dupEl.className='health-detail-item'`→`'panel-chip'`。
- **health.css**：删除 `.health-badge`/`.health-score`/`.health-metric-*`/`.health-detail-item` 已迁规则；保留 `.health-llm-*`/`.health-actions`/`.health-description` 对齐。
- **测试**：`healthDashboardRenderer.test.ts` fixture 的 `health-badge`→`panel-badge`、`health-metric-fill`→`metric-track__fill`、`health-detail-item`→`panel-chip`；断言 `classList.contains('excellent')` 等修饰不变。

### 4.3 伙伴洞察页（#21）
- **index.html**：`#partner-insights` 根加 `analysis-bar`；`partner-insights-header`/`-title`→`analysis-panel__header`/`__title`；`partner-profile-cards`→`profile-cards`、`partner-profile-card`→`profile-card`；`partner-knowledge-gaps` 容器加 `panel-section`；`partner-gap-item`→`gap-item`；`partner-growth-title`→`panel-section-title`；`partner-growth-chart` 保留（对齐 border/radius/bg）。
- **partnerInsightsRenderer.ts**：`createEl('div','partner-profile-card')`→`'profile-card'`；`-name`/`-preview`→`profile-card-name`/`-preview`；`createEl('div','partner-gap-item')`→`'gap-item'`。
- **memory-views.css**：删除 `.partner-*` 已迁规则（`partner-insights`/`-header`/`-title`/`-profile-cards`/`-profile-card`/`-gap-item`/`-growth-*`）；`partner-growth-chart` 保留并对齐令牌。
- **测试**：`partnerInsightsRenderer.test.ts` 全部 `.partner-profile-card`(-name/-preview)/`.partner-gap-item` 选择器更新为 `profile-card`/`gap-item`。

---

## 5. 质量门（Task #22）
- `npm run typecheck`（tsc --noEmit）0 错误
- `npm run lint:css`（stylelint + `csstools/value-no-unknown-custom-properties`）0 错误
- `npm run test`（vitest 全量，当前 4599 用例 / 137 文件）全绿
- 亮 / 暗主题目测：三页与 completion-stats 视觉一致（间距/圆角/字号/字重/进度条/徽章）

---

## 6. 风险与对抗式自查
1. **类名必须同步三处**：渲染器 TS（写 className）+ index.html（静态结构）+ 测试（断言选择器）。任一处漏改 = 样式丢失或测试红。落地时按页逐文件改、改完即跑该页测试。
2. **保留跨面板语义色类**：`source-*`（`distribution-fill`/画布配色）、`relation-type-*` 类型修饰是跨面板共享的，仅提升位置（insights.css→analysis-panel.css），不改名不改值。
3. **折叠动画保留**：三页根 `.hidden` 折叠（max-height:0 + opacity）统一收口到共享 `.analysis-bar.hidden`，避免回归展开/收起动效。
4. **completion-stats 不动**：它是已对齐基准，仅其 `*-title` 类可顺手统一为 `.panel-section-title`（可选，非必须）。
5. **回归面**：命令面板（`.memory-rail-item[data-section]` 跳转）、rail 高亮（updateRailItemsActive）与此重构无关，但重设计后建议跑一遍 rail/面板开关冒烟。

---

## 7. 推荐落地顺序
1. analysis-panel.css 扩充共享词汇（§2.5–2.11 新增 + 提升 relation-type-tag）。
2. insights 页（#19）：html + renderer + css + 测试。
3. health 页（#20）：同上（先消最严重重复 metric-track）。
4. partner 页（#21）：同上。
5. 质量门（#22）。
