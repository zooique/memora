# 记忆模块 UI 统一优化方案（UI 工程化心智模型审查产出）

> 依据 `.trae/rules/ui-engineering-mindset-rules.md` 审查 `hosts/memora-sprite` 记忆模块 UI。
> 目标：统一视觉风格语言、收敛"选项卡"数量、修复窄屏布局崩坏。
> 阶段：方案已批准并落地（go-ahead: "确认，推进方案更新"）。切片①~④ 与 Task#5/#6 均已完成，质量门全绿。

---

## 落地状态（2026-07-25 完成）

- **导航统一（Task#5 竖向全量 rail）**：删除头部 `.view-switch` 分段控件与 `#memory-more-menu` 更多下拉；引入 `MemorySection` 联合类型（list/timeline/graph/insights/health/completion-stats/partner-insights）+ `activeSection` 单一真相 + `setSection()` 统一入口（合并 `switchView`/`toggleAnalysisPanel`/`togglePartnerInsights`）+ `updateRailItemsActive` 高亮同步。`#memory-rail` 事件委托（稳定容器）驱动 7 个区块项；回收站为 `data-action="recycle-bin"` 模态动作项（保持 `showModal('recycle-bin-modal')`）。
- **partner-insights 扶正（Task#6）**：从 insights 子块提升为 rail 独立区块，与数据视图/分析面板互斥；`memoryController.ts` 新增 `loadPartnerInsights()` 解耦出 `loadInsights()`，由 `onMoreMenuAction` 的 `partner-insights` 分支触发。统计/补全归组于 rail「分析」组。
- **样式**：新增 `memory/memory-rail.css`（对标 `settings-tabs` 160px 竖 tab + 左侧激活指示条；`@media(max-width:760px)` 降级 64px 图标轨）；`memory.css` 聚合器 `@import`。
- **测试**：`memoryPanelEvents.test.ts` 重写（`initMoreMenu`/`initViewSwitchButtons` → `initMemoryRail`，127 用例全绿）；`memoryPanelManagerViews.test.ts` 未改仍过。全量 `npm run test` 4603 通过；`typecheck`/`lint:css` 0 错误。
- **已知残留（非阻塞）**：`memoryViewSwitcher` 的 `updateAnalysisMenuItemsActive`/`updateViewMenuItemsActive` 仍引用已删除的 `#memory-more-menu`，生产环境安全 no-op（测试仍断言），可后续低风险清理。

## 一、审查结论

记忆模块把"同一件事"（浏览 / 分析记忆）拆成了 **3 套互不相通的导航机制**，且 **3 个分析面板各自发明了一套视觉语言**。这是"选项卡太多、布局与设计崩"的根因。

### 1.1 现状结构（代码已核实）

| 机制 | 入口 | 行为 |
|------|------|------|
| 视图分段控件 | `#panel-memories .panel-header .view-switch`（列表/时间线/图谱） | 头部常驻，切换 3 个数据视图 |
| "更多"下拉 | `#memory-more-menu`（回收站/统计洞察/健康度/补全统计） | 后 3 项打开即**整面板替换**列表（互斥） |
| partner-insights | 仅作为 insights 子块（`hidden` 默认） | 主头部无法直达，孤儿区块 |
| 模态流 | 添加/详情/回收站/清理确认/关系编辑 | 事务型，非区块（保留） |

- 头部单行 44px flex：标题 + 搜索 + 分段(3) + 高级筛选 + 添加 + 更多。**无 `flex-wrap`、搜索框无 `min-width:0`**。
- 三套分析面板 `insights-bar` / `health-bar` / `completion-stats-bar`：各自 header、统计卡、按钮、间距全不同。
- `completion-stats-bar` **没有关闭按钮**（只能再点一次更多菜单项退出），而 insights/health 有显式关闭 X → 同一语义三种退出方式。

### 1.2 心智模型违规点（映射 ui-engineering-mindset-rules.md）

- **§一 设计令牌**：令牌体系本身 OK（L1/L2 已 token 化），但**缺组件层**——没有共享"分析面板外壳 / 统计卡 / 指标条"等通用组件。
- **§二 通用组件**：三面板重复造 header/card/button；`.health-action-btn`、`.completion-stats-reset-btn`、`.completion-stats-export-btn` 都是页面级变体，应回到 `.btn` / `.btn-secondary` / `.btn-danger`。
- **§三 独特性建立在继承上**：三面板零起点，未继承任何公共 `.analysis-panel` 基类 → 触发"零起点样式"警告。
- **§四 组合优于继承**：头部把 6 个控件硬塞一行，是"巨型工具栏"而非可复用控件组合；分段控件 + 更多菜单是两种平行导航，概念上都是"区块"。
- **状态同步断裂**：打开分析面板时，分段控件仍高亮"列表"，而更多菜单项高亮该面板 → **两个互相矛盾的 active 指示**，设计语言断裂。

### 1.3 量化崩坏（代码已核实）

- 窗口 `minWidth = 640`（`windowManager.ts:28`），`--aux-sidebar-width = 280px`（`tokens.css:87`）。
- 主面板区最窄 ≈ `640 − 6(窗口边距) − 1(分隔线) − 280(侧栏) ≈ 353px`，再扣 panel padding `0 24px` ≈ **305px 内容宽**。
- 头部固定控件链（标题 32 + 分段 ≈104 + 筛选 32 + 添加 52 + 更多 32 + 5×gap10=50）≈ **302px**，加搜索最小宽即超出 305px → **头部横向溢出/裁切**（无换行、无收缩）。窗口越窄越崩。

---

## 二、优化方案（四步，均映射规则）

### A. 统一导航为单一"区块"原语（消除三套机制）
把"列表 / 时间线 / 图谱 / 洞察 / 健康度 / 补全统计"统一为记忆模块的 **N 个区块**，由一个导航原语驱动；回收站保持模态（事务流）。
- 单一状态真相：`activeSection`，分段控件与（如有）菜单共享同一高亮源，杜绝双 active。
- `toggleAnalysisPanel` / `switchView` / `dismissAnalysisPanels` 收敛为 `setSection(section)` 单一入口。

### B. 抽离共享 `.analysis-panel` 外壳 + `.stat-card` / `.metric-track`（消除三套语言）
- 新增 `memory/analysis-panel.css`（L2/L3 单一真理源）：`.analysis-panel`(根: padding+滚动) / `.analysis-panel__header`(标题+关闭 X) / `.analysis-panel__section` / `.stat-card`(被 insights 统计网格 + completion-stats 卡片复用) / `.metric-track`(被 health 指标条复用)。
- 三面板改为"继承 `.analysis-panel` 基类 + 最小语义覆写"（§三 最小覆写）。
- 退出方式统一：三面板 header 均含 `.panel-close-btn`；删除 completion-stats 的"再点菜单退出"特例。
- 按钮收口：`.health-action-btn` / `.completion-stats-reset-btn` / `.completion-stats-export-btn` 改回 `.btn` / `.btn-secondary` / `.btn-danger`（语义变体）。

### C. 修复头部响应式 + active 状态单一真相（§四 / 布局组件职责）
- 给搜索框加 `min-width:0`；头部加 `flex-wrap` 或把次级控件组（筛选/更多）在窄屏折叠为单一"更多"入口（对齐 ADR-SP-008 响应式分层）。
- active 指示灯唯一来源 = `activeSection`，分段控件与菜单项不再各算各的。

### D. 收敛"选项卡"数量 + 扶正 partner-insights
- 统计洞察 / 补全统计都是"分析"语义 → 在统一区块下归为"分析"组（或并排两个区块），减少离散入口。
- partner-insights 从"insights 子块"提升为区块（或洞察区块内的一个 section），使其可达、不再孤儿。

---

## 三、导航统一走向（需确认的分叉）

- **方向 1（推荐）竖向区块导航栏**：对标 `settings.css` 160px 竖 tab / `aux-tab` 64px 图标轨。最稳健、与现有视觉语言一致、可无限扩展区块，天然消化"选项卡太多"。代价：占用 ~160px 横向空间（窄屏可降级为 64px 图标轨）。
- **方向 2 两层级**：头部分段控件仅放 3 个数据视图；"分析"做成次级入口展开分析子区块。保留现有头部形态，改动小，但头部仍偏挤。
- **方向 3 全并入一个分段控件（6 项）**：过于拥挤，不推荐。

---

## 四、落地顺序（确认方向后执行）

1. 抽离 `analysis-panel.css` 外壳 + `.stat-card` / `.metric-track`（纯新增，零破坏）。
2. 三面板迁移继承外壳，按钮收口到 `.btn*`。
3. 引入 `activeSection` 单一状态 + `setSection()`，合并三套切换函数；统一关闭按钮。
4. 头部响应式修复（min-width:0 + 窄屏折叠）。
5. partner-insights 扶正；统计/补全归组。
6. 守卫：`lint:css` + 视觉回归（截图对比）。

> 注：以上改动均落在 `hosts/memora-sprite/src/electron/renderer/` 的 `index.html` / `helpers/*` / `styles/memory/*`，不影响内核；测试走现有 vitest + `lint:css` 风格守卫。
