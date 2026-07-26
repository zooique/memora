# 视觉语言 v2（统计洞察 / 健康度 / 伙伴洞察）

> 3 页分析面板的视觉语言统一方案。上一轮（类名收口到 `analysis-panel.css`）已落地，本轮目标：补齐"**使用规则层**"——解决"组件已统一但组合方式不一致"的视觉漂移。

## 摘要

| 层 | 状态 | 说明 |
|---|------|------|
| 设计令牌层（`tokens.css`） | ✓ 完整 | 颜色 / 间距 / 字号 / 圆角 / 字重 / 阴影全有 |
| 组件外壳层（`analysis-panel.css`） | ✓ 统一 | `.stat-card` / `.panel-badge` / `.panel-chip` / `.dist-bar` / `.gap-item` / `.profile-card` / `.panel-score` |
| **使用规则层** | ✗ **缺失** | 3 页各自决定"什么时候用什么" → 视觉漂移 |

---

## 1. 根因：第一性原理（基于 3 张截图 + tokens.css + 4 个 CSS 调研）

### 6 个不搭的具体维度

1. **顶部标题区**：统计 / 伙伴 无状态徽章 / 健康度 有 "良好 86"
2. **主指标展示**：stat-card 网格 / stat-score+chip / 无
3. **配色语义**：同色不同义（青 = 积极 vs 青 = 信息）
4. **容器 padding**：12px（`--space-3`，统计）vs 16px（`--pad-card`，健康）vs 0+内层12px（伙伴，且标题16px/内容12px 错位）
5. **按钮**：健康度 3 个 vs 其他 0 个
6. **列表项**：dist-bar / metric-track / gap-item / chip 各异

---

## 2. 视觉语言 v2（设计令牌 + 组件规格 + 使用规则）

### 2.1 使用规则（场景 → 组件）—— 本轮新增

| 场景 | 组件 | 颜色 / 语义 | 强制？ |
|------|------|------------|-------|
| 页面顶部 | `analysis-panel__header`（图标+标题+状态徽章+关闭） | 标题 `--font-sm` `--weight-semibold` | ✓ |
| 页面状态 | `panel-badge`（`.excellent`/`.good`/`.fair`/`.poor`） | `--green-20` / `--accent-20` / `--yellow-20` / `--red-20` | ✓ 3 页必须都有 |
| 单一大指标 | `stat-card` 居中 | `--font-score` / `--font-h2` | 推荐 |
| 多并列指标（≤4） | `stat-grid` 4 列 + `stat-card` | `--accent` / `--text` | ✓ |
| 多并列状态（≤5） | `panel-chip` 横排 | `.warning` / `.danger` / `.info` | 推荐 |
| 详情画像 | `profile-cards` 网格 + `profile-card` | `--surface0` + `--surface2` | 推荐 |
| 列表项 | `dist-bar` / `gap-item` / `relation-item` | 各自规格（条形 / 虚线 / 实线） | ✓ |
| 趋势图 | `trend-chart`（**新增**） | `--accent` 单色 + `--accent-soft` 填充 | ✓ |
| 主操作 | `btn-primary` | `--accent` filled | **强制 ≤1 / 页** |
| 危险操作 | `btn-danger` | `--red` filled | **强制 ≤1 / 页 + 二次确认** |
| 次操作 | `btn-secondary` | outline 中性 | 推荐 |
| 可选 / 折叠 | `btn-tertiary` 或 `<details>` | ghost / 默认 | 推荐 |

### 2.2 颜色语义规范（强制）

| 颜色 | 语义 | 使用场景 |
|------|------|---------|
| 绿 `--green` | 正常 / 积极 / 达标 | 健康度"良好"、趋势向上、积极统计 |
| 橙 `--yellow` | 注意 / 警告 | 健康度"瘦复"、警告胶囊 |
| 红 `--red` | 异常 / 危险 | 健康度"低质量"、"一键清理"按钮、错误值高亮 |
| 青 `--accent` | 信息 / 链接 / 趋势线 | 统计洞察强调色、伙伴洞察折线、主操作按钮 |
| 灰 `--text-3` / `--muted` | 中性 / 辅助 | 描述文字、辅助元数据 |

**强制规则**：同一颜色在三页中语义必须一致（不允许"青 = 积极" vs "青 = 信息"混用）。

### 2.3 新增组件 `trend-chart`（统一规格，添加到 `analysis-panel.css`）

```css
/* 趋势图（统一规格：记忆积累趋势 / 未来其他趋势复用） */
.trend-chart {
  padding: var(--space-3);
  background: var(--surface0);
  border: 1px solid var(--surface2);
  border-radius: var(--radius-sm);
}
.trend-chart svg .axis { stroke: var(--surface2); }
.trend-chart svg .axis-label { fill: var(--text-3); font-size: var(--font-2xs); }
.trend-chart svg .line { stroke: var(--accent); stroke-width: 2; fill: none; }
.trend-chart svg .area { fill: var(--accent-soft); }
.trend-chart__total {
  font-size: var(--font-xs);
  color: var(--text-3);
  margin-bottom: var(--space-1);
}
```

---

## 3. 3 页重设计规格

### 3.1 统计洞察 v2

| 区块 | 组件 | 内容 |
|------|------|------|
| 顶部 | `analysis-panel__header` | 📊 + "统计洞察" + `panel-badge.good` "29 条记忆" + × |
| 主指标 | `stat-grid` 4 列 × `stat-card` | 统计 29 / 关系 7 / 冲突 0 / 来源 7 |
| 来源分布 | `panel-section` + `dist-bars` | 来源分布列表（统一组件） |
| 最近关系 | `panel-section` + `relation-item` 列表 | 最近关系（统一组件） |
| 操作（可选） | `btn-secondary` | "导出数据" |

### 3.2 健康度 v2

| 区块 | 组件 | 内容 |
|------|------|------|
| 顶部 | `analysis-panel__header` | ♡ + "记忆健康度" + `panel-badge.good` "良好 86" + × |
| 主指标 | `health-summary` | `panel-score` "86" + `panel-score-sample` "29 条" |
| 维度指标 | `health-metrics` 3 行 | `metric-track` 3 行（uniqueness / freshness / completeness） |
| 状态胶囊 | `health-details` | 4 × `panel-chip` 横排（瘦复 warning / 过期 warning / 低质量 danger / 正常 good） |
| 操作 | `btn-danger` + `btn-secondary` + `<details>` | "一键清理" + "清理重复" + "AI 治理"（折叠） |
| 描述 | `health-description` | 一段文字说明 |

### 3.3 伙伴洞察 v2

| 区块 | 组件 | 内容 |
|------|------|------|
| 顶部 | `analysis-panel__header` | 🌟 + "伙伴洞察" + `panel-badge.good` "29 条了解" + × |
| 画像卡片 | `profile-cards` 2 列网格 | 多个 `profile-card` |
| 知识缺口 | `panel-section` + `gap-list` + `gap-item` | 虚线边框列表 |
| 趋势图 | `panel-section` + `trend-chart` | 记忆积累趋势（统一规格） |
| 操作（可选） | `btn-secondary` | "补充信息" |

---

## 4. 实施路径（零风险切片起步）

### 切片 1：顶部标题区统一（最低风险，**推荐先做**）

- 3 渲染器 + `index.html` 同步加 `panel-badge`
- 3 测试加 `panel-badge` 断言
- 预计变更：~30 行
- 验证：3 页都有图标+标题+状态徽章+关闭

### 切片 2：颜色语义规范化

- 仅 CSS 调整 + 渲染器类名调整
- 预计变更：~20 行
- 验证：同色同义（绿 = 积极，红 = 异常，青 = 信息）

### 切片 3：`trend-chart` 抽离为共享组件

- `analysis-panel.css` 新增 `.trend-chart`
- `partnerInsightsRenderer` 改造使用
- 预计变更：~40 行

### 切片 4：按钮等级统一

- 健康度：`btn-danger` "一键清理" + `btn-secondary` "清理重复" + `<details>` "AI 治理"
- 统计洞察 / 伙伴洞察：可选 `btn-secondary` 次操作
- 预计变更：~30 行

### 切片 5（高风险，需用户确认）：3 页整体重设计

- 按 v2 规格全面重设计 3 页
- 影响面：3 渲染器 + 3 CSS + `index.html` + 3 测试
- 预计变更：~150 行

---

## 5. 风险自查

| 风险 | 应对 |
|------|------|
| 改动面 3 渲染器 + index.html + 4 CSS + 3 测试 | 中等，建议切片 |
| 视觉回归（用户习惯冲击） | 保留"标题文字"和"主指标语义"，只统一视觉规格 |
| 趋势图 SVG 性能 | 体积小，无影响 |
| 测试 fixture 类名断言 | 同步更新 |
| 配色语义一致性 | 强制规则文档化 + lint 提示 |

---

## 6. 验证清单（落地后核对）

- [x] 顶部标题区：3 页都有图标+标题+状态徽章+关闭
- [ ] 配色语义：绿 / 橙 / 红 / 青 / 灰 用法一致（切片 2 经审计确认已自洽，暂不动）
- [x] 容器 padding：3 页统一 16px（`--space-4` / `--pad-card`）
- [x] 布局语法：3 页统一 `.panel-section`+`.panel-section-title` 切块（伙伴/健康由裸块改为分块）
- [ ] 按钮等级：≤1 主操作 / 页，≤1 危险 / 页（切片 4 经审计确认已收口，暂不动）
- [ ] 趋势图：Canvas 折线（非 SVG，文档规格已修正）
- [x] 列表项：横向项统一规格（dist-bar / gap-item / relation-item）
- [x] 质量门：`lint:css` 0 错误 + 3 渲染器测试 72 passed（build:electron 按用户要求改由手动测试）

---

**文档版本**：v2（2026-07-25 起草，2026-07-26 布局重设计落地）
**配套文档**：`docs/memory-ui-visual-language.md`（v1，已落地）
**下一步**：用户手动真机验证（§7.4.4）后，按反馈微调或收口

---

## 7. 实施记录与现实验证（2026-07-25，对抗式审计后修正）

### 7.1 切片 1：顶部标题区统一 —— ✅ 已完成并验证

**改动（src 层）**：
- `index.html`：统计洞察 header 插 `insights-total-badge`（标题｜徽章｜×）；伙伴洞察 `.partner-insights-header` → `.analysis-panel__header` + 加 `partner-insights-badge`；健康度 `health-badge` 从 `health-summary` 移入 `.analysis-panel__header`（id 不变 → `healthDashboardRenderer.ts` 零改）。
- `insightsRenderer.ts` / `partnerInsightsRenderer.ts`：动态更新新增 badge 文本（`X 条记忆` / `X 条了解`），`.good`（青=信息）语义保留。
- `memory-views.css`：失效的 `.partner-insights-header` 改名 `.partner-insights > .analysis-panel__header`（精确作用域，保留伙伴标题横向内距，避免标题贴边回归）。

**质量门全绿**：`typecheck:electron` 0 错误、`lint:css` 0 错误、3 渲染器测试 **72 passed**。

### 7.2 现实验证（对抗式审计 vs 原文档假设）

| 维度 | 原文档假设 | 真实代码 | 结论 |
|------|-----------|---------|------|
| 趋势图（切片 3） | SVG `.trend-chart`（`.line`/`.area`/`.axis`） | 伙伴趋势图为 **Canvas**（`partnerInsightsRenderer.renderGrowthChart` + `<canvas id="partner-growth-chart">`）；容器 `.partner-growth-chart` 已有 `border-radius`+`bg surface0` | 文档 SVG 规格不适用，**盲建会成死代码** → 切片 3 无需改动 |
| 按钮（切片 4） | 需统一 `btn-danger`/`btn-secondary`/`<details>` | 健康度操作**已收口**：`btn btn-secondary`（清理重复/过期）+ `btn btn-danger`（一键清理）+ `<details>` AI 治理；共享 `.btn*` 在 `foundation/controls.css` | **已满足** → 切片 4 无需改动 |
| 配色（切片 2） | 同色不同义（青=积极 vs 青=信息） | 冲突数 `has-conflicts`→`--red`（红=异常）✓；metric-track 维度 绿/青/黄=**分类着色**非好/坏评价；健康度 badge `excellent/good/fair/poor`=绿/青/黄/红=**质量刻度**内部自洽 | 仅有的张力是 `.panel-badge.good`(青) 复用为"质量良好"与"信息计数"——改色有回归风险，**建议保留** → 切片 2 无需改动 |

### 7.3 结论（2026-07-25 阶段性）

- 切片 2/3/4 在现有代码中已满足或基于过时假设，盲执行会引入死代码 / 视觉回归。
- 当时判断"切片 1 收敛 header 后即解决主因"，**但此判断仅覆盖样式层**。

> ⚠️ 同日用户手动审查后**推翻上述结论**：问题不在样式（颜色/按钮/组件），而在**「设定（信息架构）与布局」**——3 页用了 3 种完全不同的布局语法（统计=标题块列表 / 伙伴=裸内容流 / 健康=裸仪表盘），且横向 padding 三值不一致、伙伴标题与内容错位。故推进 **布局重设计**（见 §7.4），而非停留在切片 1。

> 注：本会话模型无法读取用户提供的 3 张截图（图像过滤），上述审计基于 v2 文档 + 4 个 CSS + 3 个渲染器 + `index.html` 源码的第一性原理核对，已规避对截图像素的依赖。

---

### 7.4 布局重设计落地（2026-07-26，用户手动审查后推进）

**定性**：用户明确"不是样式问题，是设定和布局问题"。本次为**纯结构 / 信息架构重构**，复用现有组件样式（`.stat-card`/`.panel-section`/`.panel-badge` 等），**不引入新视觉语言**。

#### 7.4.1 根因（布局层）
1. **三种布局语法并存**：统计洞察用 `.panel-section`+`.panel-section-title` 切块（干净）；伙伴洞察 `#profile-cards`/`#gap-list` 是裸 div 漂浮无标题；健康度各块裸语义 div 自成仪表盘。同一外壳下组织范式不同 → 视觉杂乱。
2. **横向 padding 三值不一致**：统计 12px / 健康 16px / 伙伴根 0+内层 12px（且伙伴标题 16px、内容 12px 错位）。

#### 7.4.2 改动清单
- **`analysis-panel.css`**：新增 `.panel-section-head`（标题+右侧元信息 flex 行，baseline 对齐），其内 `.panel-section-title` 取消自身 margin-bottom；`.profile-cards` 横 padding 上移至根（`padding: 0 0 var(--space-2)`）。
- **`insights.css`**：`.insights-bar` 横向 `var(--space-3)`→`var(--space-4)`（统一 16px）。
- **`memory-views.css`**：`.partner-insights` 根加横向 16px（去掉内层错位）；`.partner-insights > .analysis-panel__header` 改纵向内距；`.gap-list`/`.growth-section` 横 padding 上移/归零。
- **`health.css`**：`.health-summary`/`.health-details` margin-bottom→0；`.health-metrics` margin-bottom→`--space-1-5`（同 section 内与 details 间距）；`.health-actions` margin-top→0；`.health-llm-group` margin-top→`--space-1-5`（块间距上移至 `.panel-section`）。
- **`index.html`**：
  - 伙伴洞察：`<div id="profile-cards">`、`<div id="gap-list">` 各包进 `.panel-section`+`.panel-section-head`（标题「用户画像」「待了解」）；`growth-section` 改 `.panel-section.growth-section`，头部改用 `.panel-section-head`（标题「记忆累积趋势」+ 右侧 `partner-growth-total` 计数）。
  - 健康度：依次包进 4 个 `.panel-section`（「健康评分」「维度明细」「诊断建议」「治理操作」），维度与详情合并入「维度明细」。所有渲染所需 `id` 全部保留。

#### 7.4.3 质量门（未跑 build:electron，按用户要求手动测试）
- `lint:css`：**0 错误**。
- 3 渲染器测试（`insights`/`health`/`partner`）：**72 passed**（canvas 无环境降级用例的 stderr 为预期日志）。
- **ID 契约零破坏**：`health-*`、`profile-cards`、`gap-list`、`partner-growth-chart/total` 等渲染锚点均保留，渲染器零改。

#### 7.4.4 待用户手动验证项（真机 UI）
- [ ] 3 页内容左缘是否统一对齐（均为 16px）
- [ ] 伙伴「用户画像/待了解」分块标题是否清晰、与卡片不重叠
- [ ] 健康「评分/维度/建议/操作」四段叙事是否顺读
- [ ] 趋势图块标题与右侧计数同行不溢出
- [ ] 折叠/展开动画与 padding 过渡无跳变
