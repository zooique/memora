# Sprite 渲染层 UI 设计与实现质量审查报告

> 审查对象：`hosts/memora-sprite/src/electron/renderer/`
> 依据规范：`.trae/rules/ui-engineering-mindset-rules.md`（UI 工程化心智模型）
> 方法：第一性原理 + 对抗式审查（grep 量化 → 抽样核实 → 归因，拒绝凭印象）
> 日期：2026-07-31

---

## 0. 一句话结论

Sprite 渲染层**已经是一个成熟、有意识的渐进式重构现场**（UIManager 门面 + 域协调器 + Mixin 委托 + Component 基类 + 令牌体系），方向**完全契合**规则文件。但 HEAL-17 迁移**尚未完成**：DOM 操作仍大量集中在 `panels/*` 的 Manager 与 `*Renderer` 中，组件生命周期契约未普及，统一导出口与声明式工厂缺位。问题不在「方向错」，而在「迁移到一半」。

**总评级：B+（架构正确，落地率约 60%）**。下面按五维拆解，每条都给 `file:line` 证据与根因。

---

## 1. 评估方法（对抗式，非印象流）

| 维度 | 量化手段 | 关键结果 |
| --- | --- | --- |
| §一 令牌 | grep 非 token 文件的裸 `#hex`/`rgba` | **0 处**硬编码色（`float.css` 的 `#bad` 经核实是 `#badge` ID 选择器，非色值） |
| §二 通用组件 | 读 `controls.css` | `.btn`/`.tag`/`.card`/`.input` 单一真理源，**状态矩阵齐全** |
| §四.1/§四.4 | grep `document.createElement` / `innerHTML =` / `getElementById` | 18 个面板用 createElement；11 个用 innerHTML；7 个组件用 getElementById |
| §四.2 | 结构相似性核对 | 记忆/审计/画像/作品投影面板共享「列表+详情」 |
| §四.3 | 比对 `components/index.ts` 导出 vs 实际组件文件 | 仅导出 3/≈13 个，其余被直接路径导入 |

---

## 2. 五维审查

### 2.1 UI 组件化（§四.1 / §四.4）—— ⚠️ 显著落差

**现状**
- 已有 `components/Component.ts` 抽象基类，定义 `protected constructor / abstract mount / abstract update / destroy / trackEvent / getElement()` 四件套契约，**完全符合** §四.1。
- 但 `Component` 仅被 `ToastComponent`、`MessageBubbleComponent` 两个组件继承。`panels/` 下 18 个 `Manager` 与 6 个 `*Renderer`（`completionStatsRenderer`、`healthDashboardRenderer`、`insightsRenderer`、`partnerInsightsRenderer`、`llmGovernanceResultRenderer`、`streamingRenderer`）均**未继承 `Component`**，直接 `document.createElement` 拼 DOM。
- `components/modal.ts` 用 `getElementById` 查**自身内部元素**（`modal.ts:224-228` 的 `confirm-title`/`confirm-message`/`btn-confirm-ok`/`btn-confirm-cancel`），违反 §四.1「组件不应通过 `document.getElementById` 查找内部元素，应 `this.el.querySelector`」。

**根因（第一性原理）**
规则 §四.4 明确：Manager = 编排（持有 Component），Component = 封装（DOM+交互）。当前 sprite 处于「Manager 兼任 DOM 操作类」的旧范式向新范式迁移的**中途态**——`Component.ts` 已立，但旧 Manager 未下沉。这不是「不知道怎么做」，而是迁移成本未摊完。

**改进（增量，不重写）**
1. 新写的面板/渲染器**一律继承 `Component`**，旧 Manager 按 §四.4 三步渐进：① 抽 DOM 为 Component，Manager 持有；② 事件迁入 Component；③ Manager 只剩编排。每步独立可测。
2. `modal.ts` 改为在 `mount()` 内 `this.el.querySelector('.confirm-title')` 等，去掉全局 `getElementById`。

### 2.2 样式抽象化（§一 / §二 / §三）—— ✅ 基本合格

**现状**
- **令牌化严谨**：`styles/foundation/tokens.css`（`:root` 浅 + `[data-theme="dark"]` 深），全量 `var()` 引用，零裸色泄露。双主题完整。
- **通用控件收口到位**：`controls.css` 是 `.btn`/`.btn-primary|secondary|danger|sm`、`.tag`/`.source-tag`/`.lineage-source-tag`/`.profile-category`、`.card`、`.input`/`.input--pill`/`.input-with-action` 的**单一真理源**，且补齐全状态矩阵（`:hover`/`:active`/`:disabled`/`:focus-visible`/`[aria-busy]`）。
- **独特性建立在继承上**：BEM 修饰符（`--primary`/`--sm`/`--pill`），覆写窄。

**可精炼点（P2，非硬违规）**
- `tokens.css` 将 L1 基础 + L2 语义混在同一 `:root`（如 `--border`/`--warning`/`--success-10` 与色板同块）。规则建议显式 L1/L2/L3 分层。当前 L3 组件令牌散落在各面板 CSS。建议在文件内用注释分区（`/* L1 色板 */` `/* L2 语义 */`），不必拆文件——拆文件收益低、迁移成本高，违反复杂度守恒。

### 2.3 逻辑抽象化（§四.2 / §四.4）—— ⚠️ 缺失工厂

**现状**
- 逻辑分层已有雏形：`shared/`（纯函数工具）、`helpers/`（domHelpers、eventTracker、scrollController 等）、`orchestrators/`（业务编排）、`panels/`（UI）。方向对。
- **但「列表+详情」结构无工厂**：`memoryPanelManager.ts`(64KB)、`auditPanelManager.ts`、`profilePanelManager.ts`、`workProjectionPanelManager.ts` 三者共享「标题 + 搜索 + 列表 + 详情弹窗」，却各写各的 DOM 与加载/空/错误态。规则 §四.2 明确「≥3 次重复即抽工厂」。

**根因**
规则 §四.2 的判定流程：① ≥3 个相似面板？→ 抽工厂。当前已满足触发条件，但迁移优先级排在 Component 基类之后（HEAL-17 Phase 顺序），属于「已知未做」。

**改进**
抽 `ListPanel` / `DetailPanel` 声明式工厂：config 声明 `columns / rowActions / search / detailRender / loadApi`，工厂处理分页/搜索/加载/空/错误/骨架屏。`customRender` 作逃生舱。配置项用 TS 接口声明完整契约（§四.2）。

### 2.4 组件间通信（§四.4）—— ✅ 方向对，略绕

**现状**
- 采用 **Host 接口注入模式**（规则 §四.4 的 sanctioned 例外）：`UIManager implements ChatPanelHost / MemoryPanelHost / ...`，子 Manager 通过 `host.xxx()` 回调向上通信，而非反向 `this.manager.xxx`。`ui.ts:140` 起。
- 域协调器（`MemoryCoordinator`/`PerceptionCoordinator`/`ChatCoordinator`/`SettingsCoordinator`）是**纯状态容器**，集中 cleanup，方向正确（§四.4「编排与封装分离」）。

**可精炼点**
- `UIManager` 同时是「门面 + Host 实现 + 状态持有者」，1099 行偏大。Host 接口方法（如 `updateSpriteStatus` `ui.ts:668`）内部仍 `document.getElementById` 找跨面板共享元素——这是「Manager 依赖外部 DOM 上下文」的灰区。建议把这些跨面板共享锚点也收为协调器持有的 Component 引用，而非全局查找。

### 2.5 可维护性（命名/注释/结构）—— ✅ 良好，有杂音

**现状**
- 注释密度高、带 ADR 引用与决策理由（如 `controls.css` ADR-018、`ui.ts` HEAL-16），符合「关键逻辑有注释」。
- 命名分层清晰：`*Manager`（编排）、`*Coordinator`（域容器）、`*Renderer`、`*Component`、`*Helpers`。

**杂音（P1）**
- `ui.ts:151-166` 一坨「`// xxx 已移入 XCoordinator（HEAL-16）`」死注释——字段已不存在，属迁移残留。规则偏好「纯粹」，应清理。
- `applyMixins` 运行时原型拷贝（`ui.ts:1091`）把 6 个 `ui-delegations` 群注入 `UIManager.prototype`。这是「薄委托」的巧妙解，但**增加认知负荷与调试难度**（断点看不到方法来源）。建议：委托群若仅为透传，可考虑直接保留在 `UIManager` 内分区注释，而非运行时 mixin——除非 TS 单文件超 1500 行否则不必拆。

---

## 3. 优先级问题清单

| 等级 | 问题 | 证据 | 对应规则 |
| --- | --- | --- | --- |
| P1 | 组件用 `getElementById` 查内部元素 | `components/modal.ts:224-228` 等 7 文件 | §四.1 |
| P1 | 6 个 `*Renderer` + 18 个面板直接 `createElement`/`innerHTML` 操作 DOM | grep 计数 | §四.4 |
| P1 | `ui.ts` 死注释残留（已移入协调器的字段） | `ui.ts:151-166` | §五 可维护性 |
| P2 | 「列表+详情」无声明式工厂 | memory/audit/profile/workProjection 面板 | §四.2 |
| P2 | `components/index.ts` 仅导出 3/≈13，绕过统一导出口 | `components/index.ts` vs `ui.ts:30,31,34...` | §四.3 |
| P2 | `tokens.css` L1/L2 未显式分区 | `tokens.css:11-312` | §一 |
| P3 | Mixin 运行时注入认知负荷 | `ui.ts:1091` | §五 |

> 注：§四.3「统一导出口」与 `index.ts` 自身注释「15+ 文件再分层」存在张力。项目是有**意**分阶段，故 P2 而非 P0——待真正分层时一并完成注册，勿为合规而合规地提前强制注册（复杂度守恒）。

---

## 4. 重构设计方案（目标架构）

### 4.1 组件分层（§四.3）—— 单向依赖

```
components/
  index.ts                ← 统一导出（注册所有公共组件）
  base/        Component(基类) · Icon · Button · Tag · Card · Input
  feedback/    Toast · Modal · Confirm · Onboarding · Banner
  data/        MessageBubble · RelationGraph · ListPanel(工厂) · DetailPanel(工厂)
  (form/navigation 暂不需，按需生长)
```
- 高层可依赖低层，低层绝不反向。新增组件**必须**注册 `index.ts`。
- `panels/` 中的 DOM 操作类下沉为 `data/` 下的 `Component` 子类，或拆为「Manager(编排) + Component(封装)」对。

### 4.2 生命周期普及（§四.1）

所有可视单元统一 `new → mount(container) → update(props) → destroy()`。`destroy()` 走 `trackEvent` 收集解绑 + `el.remove()` + nullify，杜绝泄漏。`update()` 增量（`textContent`/`classList.toggle`），禁止 `innerHTML` 重建。

### 4.3 声明式 ListPanel 工厂（§四.2）

```ts
interface ListPanelConfig<T> {
  title: string;
  columns: ColumnDef<T>[];
  load: (params) => Promise<{ items: T[]; total: number }>;
  rowActions?: RowAction<T>[];
  search?: SearchConfig;
  detailRender?: (item: T) => HTMLElement;  // 逃生舱
  emptyState: EmptyStateConfig;
}
```
记忆/审计/画像/作品投影四面板先作为 config 接入，差异收敛为配置，共同点（分页/搜索/加载/空/错误）入工厂。

### 4.4 通信机制（§四.4）

- **子→父**：`onXxx(props)` 回调（Component 经 Host 注入上抛）。
- **父→子**：`component.update(props)` 单向数据。
- **跨域**：经 `UIManager` 门面 sugar API（如 `openAuxSidebar`），不经全局 DOM。
- **禁止**：Component 内部 `getElementById`；Manager 直接 `innerHTML`。

### 4.5 令牌 L1/L2/L3（§一）

`tokens.css` 内分区：`/* L1 色板/间距/字号/阴影 */` `/* L2 语义(--text/--surface/--accent) */`；组件级覆写令牌保留在各面板 CSS（L3）。新增视觉属性先补令牌再写组件。

---

## 5. 分阶段实施计划（增量，拒绝一次性重写）

| 阶段 | 动作 | 风险 | 验收 |
| --- | --- | --- | --- |
| **Phase A（P1，低风险）** ✅ 已执行 | `ui.ts` 清理 3 处已移入协调器的 orphaned 死注释；`modal.ts` 把 `showConfirmDialog`/`showInputDialog` 的**内部元素**查找由全局 `getElementById` 收敛为 `modal.querySelector(...)`（模态根的 id 查找保留，因 `ModalManager` 非 Component、模态 DOM 为静态 HTML） | 极低 | typecheck:electron ✅ · stylelint ✅ · eslint ✅ · modal.test.ts 50/50 ✅ |
| **Phase B（P1→P2）** ✅ 面板渲染器完成 | 6 个 `*Renderer` 中 **5 个面板渲染器**已改造为 Component（completionStats/healthDashboard/insights/partnerInsights/llmGovernanceResult）；`streamingRenderer` 经对抗式审查**豁免**（非面板、无单根 `el`、在册架构已排除，见 §9.9） | 中 | 行为不变 + 新增/迁移 `destroy()` 测试；streaming 零改动、chat 测试 185/185 通过 |
| **Phase C（P2）** | 抽 `ListPanel` 工厂，先接入 `auditPanel`（最小）验证，再接 memory/profile/workProjection | 中高 | 四面板 DOM 行数下降、共性逻辑单测覆盖 |
| **Phase D（P2）** | `tokens.css` L1/L2 注释分区；`components/index.ts` 随分层补全注册 | 低 | stylelint 无新增裸值 |
| **Phase E（P3）** | 评估 mixin 是否回退为内联分区注释 | 中 | 调试可见性提升 |

每阶段独立可验证，符合规则「渐进迁移，不一次性重写」与「逻辑先于实现」。

---

## 6. 守恒提醒（什么**不要**做）

- **不要**为「将来可能复用」提前抽工厂（§四.2 DON'T）——当前仅 4 个相似面板，已达阈值，但只抽工厂不抽过度抽象。
- **不要**用 `!important` 救特异性（§三 DON'T）——先调选择器链/分层。
- **不要**把业务编排塞进 `ListPanel` 工厂（§四.2 DON'T）——工厂只组装通用结构，业务逻辑留 Manager/Coordinator。
- **不要**为合规而合规地强制注册 `index.ts` 而破坏项目已声明的分阶段决策（复杂度守恒）。

---

## 7. 已在文档化/已做对的部分（勿回退）

- `Component.ts` 四件套契约 ✅
- `controls.css` 通用控件单一真理源 + 状态矩阵 ✅
- `tokens.css` 双主题 + 零裸色 ✅
- Host 接口注入（ sanctioned 例外）✅
- 域协调器纯状态容器 + 集中 cleanup ✅
- 重注释 + ADR 引用 ✅

---

## 8. 执行记录（Phase A，2026-07-31）

- **对抗式修正原 Phase A 计划**：原拟「modal.ts 改 `this.el.querySelector`」经核实为误判——`ModalManager` 不继承 `Component`（无 `this.el`），模态 DOM 是 `index.html` 静态元素。盲改会因 `this.el` 不存在而编译失败/破坏功能。改为：保留模态根按 id 查找（挂载点模式，与 `getRequiredElement` 同构），仅把 `showConfirmDialog`/`showInputDialog` 的**内部元素**查找收敛为 `modal.querySelector(...)`。
- **ui.ts**：删除 3 处 orphaned 死注释（151-166 整块 + 256-257 + 276-277，对应已移入协调器的字段）。
- **modal.ts**：内部元素 11 处 `document.getElementById` → `modal.querySelector`；移除因此变为未用的 `getOptionalElement` 导入；因 TS 控制流收窄，将模态根 null 回退提前到内部查找之前（保留 `window.confirm/prompt` 防御性回退）。
- **验证**：`tsc -p tsconfig.electron.json --noEmit` 0 错；`stylelint` 0 错；`eslint` 改文件 0 错；`modal.test.ts` 50/50 通过。零回归。
- **Phase B 起点**：6 个 `*Renderer` + 18 个面板 `Manager` 仍直接 `createElement`/`innerHTML`（含 ModalManager 自身应按 Component 化），为下一阶段重点。

## 9. 执行记录（Phase B 试点 · completionStatsRenderer，2026-07-31）

> 试点目标：在 6 个 `*Renderer` 中先挑最独立、引用最干净的一个（`completionStatsRenderer`）验证「Renderer → Component 子类 + Manager 持有实例」迁移模式，跑通后再铺开其余 5 个。

### 9.1 改动清单
- **`panels/completionStatsRenderer.ts`（重写）**：原 `CompletionStatsRenderer`（`render()` 中 `document.getElementById` + `container.innerHTML=''` 全量重建 + 每次重绑按钮）改写为 `CompletionStatsComponent extends Component<CompletionStatsOptions>`。
  - 四件套落地：`public constructor(options)` 仅合并配置（含 `host`）；`mount(container)` 解析 `#completion-stats-bar` → 建根 `.completion-stats-component` wrapper → 标题栏 + 3 按钮（导出/重置/关闭，导出与重置 `addEventListener` + `trackEvent` **只绑一次**）→ 6 张指标卡（一次构建，登记 `metricValueEls[]`/`metricHintEls[]` 引用）→ 趋势区/事件流区 section 容器 → 首屏 `_renderData()`。
  - `update()` 热更新 `host` 后调 `_renderData()`（增量：6 卡 value/hint 原地写；趋势/事件区因结构可变走 `replaceChildren()` 重建，已注释「结构变更，需重建」）。
  - 删除冗余常量 `STATS_CONTAINER_ID`（挂载选择器改由 holder 传入）。
  - 内部元素一律 `this.el.querySelector`，不再 `getElementById`。
- **`components/index.ts`（编辑）**：新增 Phase B 段，统一导出 `CompletionStatsComponent` + 类型（物理文件暂留 `panels/`，待 Phase D 迁移；先注册以满足 §四.3「新增组件必须注册」）。
- **`panels/memoryPanelManager.ts`（5 处编辑）**：持有 `completionStatsComponent` 实例；`renderCompletionStat()` 区分首挂（`mount('#completion-stats-bar')`）vs 增量（`update()`）；`onResetCompletionStats(cb)` 委托 `component.onResetStats(cb)`；`cleanup()` 调 `component.destroy()`。
- **`helpers/memoryPanelEvents.ts`（注释）**：567 行注释 `CompletionStatsRenderer` → `CompletionStatsComponent`。
- **`src/__tests__/electron/renderer/panels/completionStatsComponent.test.ts`（新建）**：6 例，`@vitest-environment jsdom`，`vi.hoisted` + `vi.mock` 隔离 `getCompletionMetrics`；覆盖 mount 骨架/首屏数据、update 增量（卡数不变）、重置回调、destroy 幂等、事件流空态/有事件、趋势空态/有数据。

### 9.2 验证（本地可执行质量门）
- `tsc -p tsconfig.electron.json --noEmit`：**0 错**（含修复 TS6133 `STATS_CONTAINER_ID` 未用）。
- `eslint`（改文件）：**0 错**。
- `stylelint`：无 CSS 改动，天然通过。
- 新组件测试 `completionStatsComponent.test.ts`：**6/6 PASS**（含修复测试数据 bug：`adoptionRate` 漏写致断言错位；空态选择器 `events-section .empty-state` 与原子渲染器对称）。
- 回归 `memoryOrchestrator.test.ts`：**18/18 PASS**（验证 `renderCompletionStat`/`onResetCompletionStats` 委托未破）。
- ⚠️ 3 个回归测试文件（`memoryPanelManagerInstance.test.ts`/`memoryPanelManagerViews.test.ts`/`memoryPanelEvents.test.ts`）因 **Bash 沙箱 FS 错位**（沙箱快照缺失 `helpers/__tests__/` 等）无法经 Bash 跑 vitest；已用 Windows API（Grep）静态核实这三文件**零引用旧类名、零调用变更方法**（零匹配），证明不受影响，故未改代码。

### 9.3 卡点（环境，非代码）
- `git status`/`rev-parse` 经 PowerShell 输出乱码（整列 `X`，branch 回声缺失），属已记录的 git/sandbox 错位。依 git-safety 红线**未执行任何 commit 写操作**——真实代码改动均已落盘（Windows API 可读），仅 git 索引/工作树视图在沙箱内不一致。待 git 视图可靠后再落 checkpoint（commit 规范 `refactor(sprite): 补全统计面板升级为 Component`）。

### 9.4 铺开计划（已执行完毕，streaming 经审查豁免）
按相同契约逐个改造并各自跑质量门：`healthDashboardRenderer` → `insightsRenderer` → `partnerInsightsRenderer` → `llmGovernanceResultRenderer` → `streamingRenderer`。前 4 个面板渲染器已转换为 Component；第 6 个 `streamingRenderer` 经对抗式审查**豁免**（非面板、无单根 `el`、在册架构已刻意排除，详见 §9.9）。可选最小面板 `badgeManager`/`panelErrorBannerManager` 不属强制范围，留待后续评估。

### 9.5 执行记录（Phase B 第 2 个 · healthDashboardRenderer，2026-07-31）

> 按 §9.4 既定顺序，`healthDashboard` 是试点之后最独立的下一个（已全增量渲染、单静态容器、无 innerHTML 重建）。
> 与试点（`completionStats` 建 wrapper）不同，本组件采用**「采纳静态容器」变体**：`#memory-health-bar` 在 index.html 已是富骨架（header + 评分 + 维度 + 诊断 + 治理操作），组件直接将其采纳为 `this.el` 并缓存内部引用，不新建 wrapper。

#### 9.5.1 改动清单
- **`panels/healthDashboardRenderer.ts`（重写）**：`HealthDashboardRenderer` → `HealthDashboardComponent extends Component<HealthDashboardOptions>`。
  - `mount(container)`：`document.querySelector` 解析 `#memory-health-bar`（与试点一致的 `#` 选择器语义），采纳为 `this.el`，**缓存全部内部引用**（`metricsEl`/`scoreEl`/`badgeEl`/三维 `dimFillEls`/`dimValEls`/`dupEl`/`staleEl`/`lowEl`/`descEl`/三个清理按钮/`actionsEl`）——消除原 12+ 处 `document.getElementById` 查内部元素（§四.1 反模式）。
  - `update({data})`：增量刷新（`textContent`/`style.width`/`className`，与原实现逐行等价，本就无 `innerHTML` 重建）。
  - `showLoading()`/`showError()`：沿用 `showPanelLoading`/`renderErrorState`（后者仍由本地 `EventTracker` 承载重试按钮，destroy 时统一清理）。
  - `destroy()`：先 `events.cleanup()` + nullify，再 `this.el = null` 后调 `super.destroy()`——因 `#memory-health-bar` 是**共享静态容器**（亦承载 `#health-llm-result` 子区，后续 LLM 治理组件），销毁时**不应移除它**，故置 null 使基类跳过 `el.remove()`，仅清事件与引用。
- **`panels/memoryPanelManager.ts`（5 处）**：`import HealthDashboardRenderer` → `HealthDashboardComponent`；字段 `new HealthDashboardComponent()`；`cleanup()` → `destroy()`；委托块新增 `ensureHealthDashboardMounted()`（首开挂载、仅 hidden 不销毁，与试点同模式），`render(data)` → `update({data})`，`showHealthLoading/showHealthError` 均先 ensureMounted；`onReloadHealth` 直转（仅存回调，无需挂载）。
- **`components/index.ts`**：Phase B 块补导出 `HealthDashboardComponent` + `HealthDashboardOptions`（§四.3 统一入口）。
- **`__tests__/.../healthDashboardRenderer.test.ts`（重写）**：`render`→`update({data})`、`cleanup`→`destroy`；`createRenderer` 先 `mount('#memory-health-bar')`；`HEALTH_HTML` 夹具改为**嵌套**所有内部 id 于 `#memory-health-bar` 内（对齐真实 index.html，组件经 `this.el.querySelector` 缓存），原 20 例断言全部保留。
- **`__tests__/.../dashboardPanelManager.test.ts`**：仅更新一处注释（`HealthDashboardRenderer`→`HealthDashboardComponent`）。

#### 9.5.2 验证（本地可执行质量门，全部通过）
- `tsc -p tsconfig.electron.json --noEmit`：**0 错**。
- `eslint`（改文件）：**0 错**。
- `healthDashboardRenderer.test.ts`：**20/20 PASS**。
- 回归 `memoryPanelManagerViews`(61) + `memoryPanelEvents`(66) + `memoryPanelManagerInstance`(56) + `memoryOrchestrator`(18)：**201/201 PASS**（验证 holder 委托未破、清理按钮关闭委托未破）。

#### 9.5.3 踩坑（对抗式，已修）
- 首跑测试 **18/20 失败**：`mount('#memory-health-bar')` 传 `#` 前缀字符串，但初版 `mount` 用 `document.getElementById(container)`（不接受 `#`），返回 null → 全操作 no-op。修正为与试点一致的 `document.querySelector<HTMLElement>(container)`（接受 `#` 选择器）。根因：两种按 id 选元素 API 语义不同（`getElementById` 不带 `#`，`querySelector` 带 `#`），混合即错。

#### 9.5.4 卡点
- 同 §9.3：`git` 视图仍乱码（sandbox 错位），**未 commit**。真实改动已落盘（Windows API 可读）。

### 9.6 执行记录（Phase B 第 3 个 · insightsRenderer，2026-07-31）

> 按 §9.4 既定顺序，`insights` 是 health 之后最独立的下一个（单静态容器 `#memory-insights-bar`、统计卡增量、仅分布/摘要列表重建、重试按钮委托模式 D）。
> 沿用 health 验证过的**「采纳静态容器」变体**：`#memory-insights-bar` 在 index.html 已是富骨架（header + 统计卡 + 来源分布 + 最近关系），组件直接采纳为 `this.el` 并缓存内部引用，不新建 wrapper。

#### 9.6.1 改动清单
- **`panels/insightsRenderer.ts`（重写）**：`InsightsRenderer` → `InsightsComponent extends Component<InsightsOptions>`（`InsightsOptions = { dashboard?; graph? }`，字段可选，对齐 health）。
  - 消除原 9 处 `document.getElementById` 查内部元素（§四.1 反模式）：`mount(container)` 经 `document.querySelector('#memory-insights-bar')` 采纳 `this.el`，缓存 `totalEl`/`relationsEl`/`conflictsEl`/`sourcesEl`/`totalBadgeEl`/`distEl`/`summaryEl`。
  - `update({dashboard, graph})`：合并进 `this.options` 后增量渲染——统计卡原地写（`textContent`/`classList.toggle`）；source 分布与关系摘要属结构可变，按规则许可「结构变更，需重建」（`clearElement` 后重建子节点），逻辑与原 `render()` 逐行等价。
  - `showLoading()`/`showError()`：沿用 `showPanelLoading`；重试按钮监听改经 `trackEvent` 收集（**移除原独立 `EventTracker` 导入**，对齐 Component「destroy 内置事件清理，无需额外 EventTracker」）。
  - `destroy()`：先 nullify `reloadCallback`，再 `this.el = null` 后调 `super.destroy()`——`#memory-insights-bar` 是**共享静态容器**（面板仅 hidden 不销毁），销毁时不应移除它。
- **`panels/memoryPanelManager.ts`（5 处）**：`import InsightsRenderer` → `InsightsComponent`；字段 `new InsightsComponent()`；`cleanup()` → `destroy()`；委托块新增 `ensureInsightsMounted()`（首开挂载、仅 hidden 不销毁），`render(dashboard, graph)` → `update({ dashboard, graph })`，`showInsightsLoading/showInsightsError` 均先 ensureMounted，`onReloadInsights` 直转（仅存回调）；section 注释同步。
- **`components/index.ts`**：Phase B 块补导出 `InsightsComponent` + `InsightsOptions`/`InsightsDashboardData`（§四.3 统一入口）。
- **`__tests__/.../insightsRenderer.test.ts`（重写）**：`render`→`update({dashboard, graph})`、`cleanup`→`destroy`；`createComponent` 先 `mount('#memory-insights-bar')`；`INSIGHTS_HTML` 夹具改为**嵌套**所有内部 id 于 `#memory-insights-bar` 内（对齐真实 index.html）；原覆盖（加载态/统计卡/分布条形图/关系摘要/失败重试/清理）全部保留并扩充为 **33 例**（含 mount 采纳容器、destroy 不删共享容器、destroy 幂等等）。
- **`__tests__/.../ui.test.ts`**：仅更新一处注释（`InsightsRenderer`→`InsightsComponent`）。

#### 9.6.2 验证（本地可执行质量门，全部通过）
- `tsc -p tsconfig.electron.json --noEmit`：**0 错**。
- `eslint`（改文件）：**0 错**。
- `insightsRenderer.test.ts`：**33/33 PASS**。
- 回归 `memoryPanelManagerViews`(61) + `memoryPanelManagerInstance`(56) + `memoryPanelEvents`(66) + `memoryOrchestrator`(18)：**201/201 PASS**（验证 holder 委托未破、关闭按钮委托未破）。

#### 9.6.3 踩坑（对抗式，已修）
- ESLint/tsc 首报 `INSIGHTS_CONTAINER_ID` 未使用（TS6133）：组件内不必要存容器常量——挂载容器由 holder 经 `ensureInsightsMounted` 传入字符串 `'#memory-insights-bar'`（与 health 同模式）。删除冗余常量后两门皆 0 错。

#### 9.6.4 卡点
- 同 §9.3：`git` 视图仍乱码（sandbox 错位），**未 commit**。真实改动已落盘（Windows API 可读）。

### 9.7 执行记录（Phase B 第 4 个 · partnerInsightsRenderer，2026-07-31）

#### 9.7.1 改动清单
- `panels/partnerInsightsRenderer.ts`：`PartnerInsightsRenderer` → `PartnerInsightsComponent extends Component<PartnerInsightsOptions>`。
  - 采纳 `index.html` 静态容器 `#partner-insights` 为 `this.el`（富骨架已含全部内部 id：`partner-insights-badge`/`.profile-cards`/`.gap-list`/`partner-growth-total`/`partner-growth-chart`），`mount()` 缓存 5 个内部引用，消除原 9 处 `document.getElementById` 查内部元素（§四.1 反模式）。CSS 关键耦合 `.partner-insights > .analysis-panel__header`（memory-views.css:125）是 child combinator——因本模式**不新增 wrapper**，直接子关系不变，零破坏。
  - `render(memories)` → `update({memories})`，逻辑逐行等价（含空数据早返回不更新 `lastMemories` 的既有行为，保留未改）。
  - 卡片点击监听由独立 `EventTracker` 改为经 `trackEvent(() => removeEventListener(...))` 收集（**移除 `EventTracker` 导入**），`destroy()` 内置清理；`repaintOnThemeChange()`、`onMemoryClick(cb)` 作为公开方法保留（holder 主题重绘与点击委托依赖）。
  - `destroy()` 先 `this.el=null` 再 `super.destroy()`——`#partner-insights` 是共享静态容器（还被 `memoryViewSwitcher` 直接控制显隐），销毁时不可 `el.remove()` 误删。
- `panels/memoryPanelManager.ts`：import/字段（`partnerInsights`→`partnerInsightsComponent`）/cleanup→destroy/主题委托，委托块新增 `ensurePartnerInsightsMounted`（首挂一次）+ `renderPartnerInsights` 改 `mount-or-update` 语义。
- `components/index.ts`：统一导出 `PartnerInsightsComponent` + `PartnerInsightsOptions`。
- `__tests__/.../partnerInsightsRenderer.test.ts`：重写为 Component 契约（mount/update/destroy），fixture 用 `#partner-insights` 包裹内部 id（含 `partner-insights` 类以匹配真实 DOM），25 例含挂载采纳/空数据隐藏/卡片 6 张截断/缺口/趋势图/主题重绘/destroy 监听移除+不删共享容器+幂等。
- 注释同步：`perceptionPanelManager.test.ts:587`、`dashboardPanelManager.test.ts:298` 陈旧类名改为 `PartnerInsightsComponent`（均为注释，非代码导入）。

#### 9.7.2 验证（本地可执行质量门，全部通过）
| 质量门 | 结果 |
|---|---|
| `tsc -p tsconfig.electron.json --noEmit` | 0 错 |
| `eslint`（改文件） | 0 错 |
| `partnerInsightsRenderer.test.ts` | 25/25 |
| memory 面板回归（Views 61 + Instance 56 + Events 66 + Orchestrator 18） | 201/201 |
| dashboard + perception 面板测试 | 78/78 |

#### 9.7.3 踩坑（对抗式，已修）
- **测试 fixture 漏类**：初版 fixture 的 `#partner-insights` 只写 `class="hidden"`，漏掉真实 `partner-insights` 类，致"采纳为根元素"断言 `classList.contains('partner-insights')` 失败。修正为 `class="partner-insights analysis-bar hidden"` 镜像真实 DOM（组件采纳现有元素、不增删类）。**记忆点**：Renderer→Component 的测试 fixture 必须完整镜像 `index.html` 静态容器的 class 集合，否则验证失真。

#### 9.7.4 卡点
- 同 §9.3：`git` 视图仍乱码（sandbox 错位），**未 commit**。真实改动已落盘（Windows API 可读）。

---

#### 9.8 第 5 个：`llmGovernanceResultRenderer` → `LlmGovernanceResultComponent`

**Holder 差异（关键）**：前 4 个由 `memoryPanelManager` 持有（类字段），本组件由 `memoryOrchestrator`（工厂函数，`createMemoryOrchestrator(uiManager)`）以**闭包 `const`** 持有（line 95），`onRestoreMemory` 在 setup 注册一次，3 个 `render*` 在 `uiManager.onLlmGovernance` 回调内按 action 调用；**原 `cleanup()` 从未被调用**（泄漏）。工厂 `return { ..., cleanup }`（line 1014）仅清 debounce 定时器。

**改造要点**：
- 沿用「采纳静态容器」变体：`#health-llm-result` 是 `#memory-health-bar` 内**嵌套静态子区**（index.html:686，health 组件已设计为不移除共享容器），`mount()` 直接采纳为 `this.el`；`destroy()` 先置 `this.el=null` 不误删。
- **升级为单一事件委托**：原 `EventTracker` 逐条绑定恢复按钮、每次 render 先 `events.cleanup()`。改为在 `mount` 对容器根绑一个 click 委托（捕获 `[data-action="restore-boost"]`，从 `data-memory-id` 取 id），彻底消除"每渲染重绑/监听器累积"——更贴合"容器静态、按钮动态重建"语义，且对齐项目关闭按钮委托惯例。
- **单一 `update` 入口**：`update({report})` 接受判别联合 `{type:'dedup'|'timeliness'|'conflicts', data}`，内部 `_renderReport` 分发； orchestrator 三调用点改为 `update({ report: { type, data } })`（符合 §四.1 `update(newOptions)` 契约，原 3 个 `render*` 退为私有）。
- 工厂 `cleanup` 接入 `llmResultRenderer.destroy()`（修复"从不清理"泄漏）。

**改动文件**：`panels/llmGovernanceResultRenderer.ts`（重写：`LlmGovernanceResultComponent extends Component` + 委托 + 判别联合 `update` + `destroy`）、`orchestrators/memoryOrchestrator.ts`（import/实例/`update` 三调用点/`cleanup` 接 `destroy`）、`components/index.ts`（统一导出）。

#### 9.8.1 验证（本地可执行质量门，全部通过）
| 质量门 | 结果 |
|---|---|
| `tsc -p tsconfig.electron.json --noEmit` | 0 错 |
| `eslint`（改文件） | 0 错 |
| `memoryOrchestrator.test.ts`（含 LLM 治理 5 项 + 其余 13 项） | **18/18** |
| memory 面板回归（Views 61 + Instance 56 + Events 66 + Orchestrator 18） | **201/201** |

#### 9.8.2 踩坑（对抗式，已修）
- **判别联合包裹层遗漏**：`update` 设计签名 `update(newOptions: Partial<LlmGovernanceOptions>)` 期望 `{ report: LlmGovernanceReport }`，但首版 orchestrator 调用写成 `update({ type:'dedup', data: report })`（少 `report` 包裹）。`newOptions.report` 为 `undefined` → `this._report` 恒 null → `_renderReport` 早返回 → 容器空白；**esbuild 不做类型检查故测试静默失败**（5 项全空）。修正为 `update({ report: { type, data } })` 后全绿。→ 记忆点：判别联合经 `update({report})` 传入时，orchestrator 调用必须补 `report` 包裹层，不能把 `LlmGovernanceReport` 直接当 options 传。

#### 9.8.3 卡点
- 同 §9.3：`git` 视图仍乱码（sandbox 错位），**未 commit**。真实改动已落盘（Windows API 可读）。

---

### 9.9 第 6 个 `streamingRenderer`：对抗式审查 → **豁免 Component 改造（不改动）**

> 本轮原计划按 Phase B 既定顺序处理第 6 个 `*Renderer`。但**先读真实文件而非套用计划**，发现它与其他 5 个架构角色根本不同，遂做对抗式判定而非盲目转换。

#### 9.9.1 事实核查（不靠记忆）
- `panels/streamingRenderer.ts` **不是类、不是面板**：导出 4 个**模块级纯函数** `updateStreamingMessage` / `finishStreamingMessage` / `addCopyButtonToMessage` / `cancelPendingRaf`，外加共享状态对象 `StreamingRendererContext`（持有 `streamingMessages: Map<string, HTMLElement>`、RAF 句柄、`latestStreamText` 等）。
- 文件头注释自述（line 1-19）：从 `chatPanelManager.ts` 提取的**流式 RAF 核心 ~220 行**，设计为 **context 注入式无状态函数**以降低体量，状态通过 `StreamingRendererContext` 共享。
- **无单根 `el`**：它操作一个**动态的 `Map<messageId, 气泡>`**——多条消息各自独立创建/销毁，不存在"一个根 DOM 元素"。
- **无 Component 生命周期**：调用是 per-chunk（`updateStreamingMessage`）、per-message-end（`finishStreamingMessage`）、cleanup（`cancelPendingRaf`），与 `new/mount/update/destroy` 四件套语义不符。
- **无 §四.1 反模式**：内部元素访问走 `ctx.streamingMessages.get(id)` + `el.querySelector(...)`，**未用 `document.getElementById` 查自身内部元素**（唯一 `document.getElementById('stream-live-region')` 是跨切面全局 live region，非自身内部元素，合理保留）。

#### 9.9.2 在册架构决策（决定性证据）
- `components/messageBubbleComponent.ts:18` 已明确写道：**"不接管流式渲染——streamingRenderer 已独立且成熟，Component 仅提供初始 streaming 光标"**。
- 即项目自身架构**已刻意把流式渲染排除在 Component 模式之外**——`MessageBubbleComponent` 只负责初始气泡骨架与光标，流式期间的增量更新/收尾/复制按钮全部交由 `streamingRenderer` 的纯函数处理。

#### 9.9.3 第一性原理判定（为何不转换）
强行把 `streamingRenderer` 套成 `Component` 子类会同时违反两条铁律：
1. **复杂度守恒（USER.md §3 / 规则「逻辑先于实现」）**：无单根 `el` 却要 fabricate 一个（或强行把 `messagesEl` 当 `this.el`），纯属为套模式而加的一层**零收益抽象**——它本就无状态、本就无内部元素查找反模式，套类不改任何行为，只多一个故障面。
2. **Component 生命周期契约（§四.1）**：`mount/update/destroy` 要求单一根元素 + 增量 `update`；流式是**多消息、动态生灭、逐 chunk 节流**的引擎，与单根组件模型根本不兼容。
3. **破坏既有架构（§四.4 反向调用禁忌 + 在册决策）**：`ChatPanelManager` 已持有 `streamRenderCtx` 并以纯函数调用；改写为 Component 需重构调用方以获得"零收益"。

**结论**：`streamingRenderer` 不在 Component 改造对象之内。Phase B 的"6 个 `*Renderer`"是按**文件名模式**归纳的启发式，经逐个核实，其中 5 个是面板渲染器（已转换），第 6 个是流式引擎（**豁免**）。未改动任何代码。

#### 9.9.4 验证（零改动，实测佐证）
- `chatPanelManager.test.ts` + `ui.test.ts`：**185/185 通过**（EXIT=0）。流式子系统的既有覆盖（startStreaming / 逐 chunk rAF flush / finishStreamingMessage / 复制按钮 / stopAllStreaming / 90s 兜底）全绿，证明"不转换"未引入任何回归。
- `tsc -p tsconfig.electron.json --noEmit`：0 错（无改动，基线保持）。
- `eslint`：0 错（无改动）。

#### 9.9.5 卡点（已解除）
- 原 §9.3/§9.8.3 的 `git` 视图乱码（sandbox 错位）**已解除**：用户手动 commit，前 5 个组件 + 本报告均已落盘；后续不再受 git 红线阻塞。

---

### 9.10 可选最小面板 `badgeManager` / `panelErrorBannerManager`：对抗式评估 → **保留为 Manager，不予 Component 化**

> Phase B 原计划标注二者为"可选最小面板"。本轮先读真实文件（而非套用计划），判定二者均属 §四.4 意义上的 **Manager**（持有/协调 DOM，而非被持有的单根 Component）。强行 Component 化违反复杂度守恒与 Manager/Component 边界，故**保留现状、零改动**。

#### 9.10.1 事实核查（读真实文件，不靠记忆）
- `panels/badgeManager.ts`：`export class BadgeManager`，`constructor(private badge: HTMLElement | null)`——**接收注入的既有元素**（非自建根 el）；`updateBadge/clear/setCount` 仅 `textContent` + `classList.toggle('visible')`；**零 `getElementById`**；`cleanup()` 空实现（无监听器）。注释自述"纯 DOM 渲染，不持有业务状态"、"与 UIManager 其他子管理器同模式"。
- `panels/panelErrorBannerManager.ts`：`export class PanelErrorBannerManager`，`init()` 为 5 个面板（`settings/memory/chat/dashboard/perception`）的 `${panelId}-error-retry` 绑 click（经 `EventTracker`）；`showPanelError(panelId,message,retry?)`/`hidePanelError(panelId)` 用 `getElementById(\`${panelId}-error\`)` 与 `${panelId}-error-msg`；`cleanup()` 清 `events` + `retryCallbacks`。**无单根 `this.el`**，管理的是**跨 5 个面板分布的横幅集合**。
- 持有方：`ui.ts:292` `this.badgeManager = new BadgeManager(this.coreElements.badge)`；`ui.ts:365` `this.panelErrorBannerManager = new PanelErrorBannerManager()`（`:410 init()`、`:483 cleanup()`）。调用方 `settingsModalDelegations.ts:95-104` 用 `showPanelError(panelId,message,retryCallback)` / `hidePanelError(panelId)` 语义——**非单 `update(options)` 签名**。
- 在册契约：BadgeManager 注释引用 `ADR-SP-015 §2 生命周期契约`——项目已建立**独立于 Component 的 Manager 生命周期（init/cleanup）**，与 Component 的 `mount/update/destroy` 并存。

#### 9.10.2 第一性原理判定（为何不转换）
1. **二者均无单根 `this.el`，是 §四.4 的 Manager 而非 Component**：
   - BadgeManager **装饰注入元素**（不创建 DOM），是"管理器持有/操作一个既有元素"——正是 §四.4 描述的 Manager 角色。
   - PanelErrorBannerManager **跨 5 个面板协调分布式横幅**——一个 Component 无法表达"管理 N 个根"，其 `getElementById` 是**合法的跨面板按动态 id 查找**（查各面板自有 DOM），**非 §四.1 反模式**（反模式是"查自身内部元素"）。
2. **复杂度守恒**：两文件均极小、已正确、BadgeManager 零反模式。套 Component 需 fabricate 空壳 `mount` + 改 `showPanelError(panelId,...)` 为 `update({type:'show',panelId,...})`，**制造零收益抽象、多故障面、强制改动 6+ 调用点**（`ui.ts`/`settingsModalDelegations.ts`/测试 mock 语义）。
3. **违反既有 Manager 契约**：二者已按 `ADR-SP-015 §2` 的 `init/cleanup` 设计，与 Component 的 `mount/update/destroy` 是**两套并存的契约**。强行统一会破坏项目刻意保留的 Manager 分层。

#### 9.10.3 决策矩阵（可复用判别法）
| 维度 | 应 Component 化 | 应保留 Manager / 豁免 |
|---|---|---|
| 是否持有单根 `this.el`（自建或采纳） | 是 | 否（装饰注入元素 / 跨多面板分布） |
| §四.1 反模式（getElementById 查自身内部元素） | 有 → 改造消除 | 无，或仅为合法跨面板/跨切面查找 |
| 语义 | 自包含视觉单元，状态→增量渲染 | 跨切面协调器 / 既有元素装饰器 |
| 已有契约 | 未 Component 化 | 已按 Manager(init/cleanup) 设计 |

→ **判别铁律**：类名含 `Manager` 且**无单根 el** 者（badge / panelErrorBanner / streaming 的协调本质），属 §四.4 Manager 角色，**默认不 Component 化**；仅当确有"单根视觉单元 + 自身内部元素反模式"时才转。Phase B"6 个 `*Renderer`"是按文件名归纳的启发式，须逐个核实架构角色。

#### 9.10.4 结论与验证
- **结论**：`badgeManager` 与 `panelErrorBannerManager` **不予 Component 化，保留为 Manager，零改动**。Phase B 至此完整闭环——5 个面板 `*Renderer`→Component（含 llmGovernance 单事件委托升级 + 修复泄漏），`streamingRenderer` 流式引擎豁免，2 个可选 `Manager` 评审后保留。
- **验证**：零代码改动，基线保持——`tsc`/`eslint` 0 错；`uiDelegations.test.ts`（含 `panelErrorBannerManager` 委托断言）、`panelErrorBannerManager.test.ts`、badge 相关调用面均已存在且无需改动。
- **卡点解除**：用户已手动 commit，git 视图错位不再阻塞；前 5 个组件 + 本报告 §9.1–§9.10 已随用户提交落盘。

---

### 9.11 Phase C 前提对抗式核查 → 原「ListPanel/DetailPanel 工厂」计划**过度泛化，须收窄**

> 用户指令「继续 Phase C」。按第一性原理 + 对抗式审查，**先验证计划前提再执行**——而非盲套 §4.3/§5 的"四面板共享 list+detail"假设。

#### 9.11.1 核查事实（读真实文件，不靠记忆）
- `auditPanelManager.ts`(236) / `profilePanelManager.ts`(326) / `workProjectionPanelManager.ts`(281)：三者均为**扁平列表**，**无 search、无 detail 模态**；空态/错误态/刷新已分别抽入 `domHelpers.createEmptyState` / `errorState.renderErrorState` / `buttonHelpers.bindRefreshButton`（helper 已收口共性脚手架）。差异点在行 schema（`.audit-item`/`.profile-card`/`.work-projection-card`）、双列表(pending/confirmed)、行内展开、特殊动作（audit clear、profile 确认/拒绝、work 展开）。
- `memoryPanelManager.ts`(1506)：**唯一具备 list+search+detail(分页+模态)**，且错误态走自有 `#memory-error` 横幅（**不走 renderErrorState**）、分页+缓存+委托 helper+timeline/graph/分析/回收站/治理多职责。与另 3 个**结构根本不同**。
- 测试面：audit 有 328 行测试断言 `.audit-item` 选择器与 clear 二次确认流程；memory 有 Instance/Views/Events 三套大测试；profile/work 无测试（无安全网）。

#### 9.11.2 第一性原理判定
1. **「≥3 面板共享 list+search+detail」假设不成立**：4 个里仅 memory 满足；另 3 个是扁平列表，且真正共性（load/空/错/刷新）**已被 helper 抽走**。剩余重复仅为结构性样板（getElementById/计数/接线），体小低频。
2. **完整 ListPanel/DetailPanel 工厂属过度抽象**：若按 §4.3 `ListPanelConfig<T>`（含 columns/search/detailRender/load→{items,total}）接入，memory 一个面板就需 `customRender` 逃生舱承载分页+委托详情+回收站+治理——等于架空工厂，违反 §四.2 DON'T「不要让工厂变成 God Object」。
3. **真实可抽的命题更窄**：仅 audit/profile/work 三个**扁平列表**可抽一个薄"FlatListPanel"工厂（rootId/listContainerId/countElId?/refreshBtnId?/load/renderRow/emptyText/errorText + `customRender` 逃生舱）。但收益有限（脚手架已 helper 化），且 audit 现有测试会因选择器/流程变动受影响。

#### 9.11.3 待决（用户拍板，不盲执行）
- **路径 A**：抽薄 `FlatListPanel` 工厂，仅覆盖 audit/profile/work，先用 audit 做 PoC（有测试可验），再决定是否推广。——**收窄、有界、对抗式可行**。
- **路径 B**：**不抽工厂**。理由：共性脚手架已 helper 化，剩余差异真且小；抽薄工厂收益有限却冲击 audit 现有测试（违反复杂度守恒 + §四.2「不要为过度抽象抽工厂」）。Phase C 结论改写为"经核查，完整工厂过度抽象、薄工厂收益不足，故不重构，仅文档化此判定"。
- **路径 C（不推荐）**：按原 §4.3 完整工厂接入四面板，memory 走 `customRender`。—— 已知会架空工厂、高风险改 memory 大测试，违反 §四.2，建议否决。

> 方法论沉淀：声明式工厂前必须核实"≥3 相似"是否**结构真实**（文件名相似 ≠ 结构相似）；已抽进 helper 的共性不应重复计入"待抽工厂"的重复量。此判据已并入 MEMORY.md「Component 化判别铁律」的姊妹原则。

---

### 9.12 执行记录（Phase C 试点 · FlatListPanel 工厂 + audit 接入，2026-07-31）

> 用户选路径 A：抽薄 `FlatListPanel` 工厂，audit 先试点。先建工厂，再把 audit 接入，跑通质量门。

#### 9.12.1 改动清单
- **`components/flatListPanel.ts`（新建）**：`FlatListPanel<T> extends Component<FlatListPanelOptions<T>>` 声明式工厂（§四.2）。
  - 采纳 `index.html` 静态列表容器为 `this.el`（与 Phase B 同"采纳静态容器"变体）；`destroy()` 先置 `this.el=null` 不误删共享容器。
  - 共性入工厂：容器采纳 + 计数更新（`countElId`）+ 刷新绑定（`bindRefreshButton` 经 `trackEvent` 收集）+ 空态（`createEmptyState`）+ 错误态（`renderErrorState` 含重试→`load`）+ 事件清理（`destroy` 经 `trackEvent`）。
  - 差异收敛为配置：`listContainerId / countElId? / refreshBtnId? / load:()=>Promise<T[]> / renderRow / emptyText / errorText? / customRender?`（逃生舱，供 profile 双列表 / work 行内展开）。
  - 采用**真实数组 load 形态**（对齐 audit/profile/work IPC），非报告 §4.3 草拟的 `{items,total}`——后者是过度泛化，已据实修正。
- **`panels/auditPanelManager.ts`（重写）**：列表/计数/空/错/刷新下沉到 `FlatListPanel`；audit 特有"清空 + 二次确认"保留在 Manager 层（`clearBtn` 经 `EventTracker`，`cleanup` 调 `listPanel.destroy()`）。`buildRow`/`getTypeSymbol` 作为审计专属行结构注入 `renderRow`。公开 API（init / setClearAuditLogCallback / load / cleanup）零签名变更。
- **`components/index.ts`**：新增「声明式列表工厂（Phase C）」段，导出 `FlatListPanel` + `FlatListPanelOptions`（§四.3 统一入口）。

#### 9.12.2 验证（本地可执行质量门，全部通过）
| 质量门 | 结果 |
|---|---|
| `tsc -p tsconfig.electron.json --noEmit` | 0 错（含修 TS6133 `_items` 未用、TS2345 handler 需 `Promise<void>`） |
| `eslint`（改文件） | 0 错 |
| `auditPanelManager.test.ts` | **24/24**（`.audit-item` 结构 / 计数 / 5 图标映射 / `?` 降级 / 元信息拼接 / XSS / 空态`暂无审计记录` / 错误态`加载失败`·`清空审计日志失败` / 幂等 / cleanup 解绑 全部保持） |

#### 9.12.3 对抗式核实（零回归依据）
- grep 全 renderer：除测试外仅 `ui.ts`（构造）、`memoryCoordinator.ts`（type）、`settingsOrchestrator.ts`（注释）引用 `AuditPanelManager`；**无代码调用被移除的私有 `render`/`listEl`**，公开 API 签名未变 → 无外部破坏。
- `index.html` 静态容器 `#audit-list`/`#audit-count`/`#btn-audit-refresh`/`#btn-audit-clear` 均存在，与工厂配置 id 完全对齐。

#### 9.12.4 下一步
- 路径 A 剩余：profile / work 接入 `FlatListPanel`（profile 双列表→`customRender`；work 行内展开→`customRender`）。二者**无测试**（profile/work），接入需补最小测试或静态核实。
- memory 维持排除（异类，不纳入本工厂）。
- 卡点解除：git 已解除（用户手动提交），本次改动可随时落 commit（建议 `refactor(sprite): 抽 FlatListPanel 工厂并接入审计面板`）。

---

## 9.13 Phase C · #2 work 接入 FlatListPanel（customRender）

### 9.13.1 前提对抗式核实（work 是真单列表）
- 读真实文件 + index.html：`workProjectionPanelManager` 的 IPC `listWorkProjections` **直接返回数组 T[]**（非 `{entries}`），与工厂 `load:()=>Promise<T[]>` 契约**精确匹配**。
- DOM 结构（index.html:1020-1029）：`work-projection-list`（单容器）+ `work-projection-count`（单计数）+ `btn-work-projection-refresh`（单刷新）→ 与 audit **同构**，是真单列表。差异仅在行布局（卡片 + 行内展开 + 空态引导 hint）→ 适合 `customRender` 逃生舱。

### 9.13.2 改动
- `panels/workProjectionPanelManager.ts` 重写：列表/计数/刷新/空/错/销毁下沉 `FlatListPanel`；行内展开 + 空态引导 hint 经 `customRender` 接管整段渲染。公开 API（`init`/`load`/`cleanup`）**零签名变更**；保留 `showPanelLoading`（load 前经 `getElement()` 调，对齐原 UX）。
- 工厂扩展（使 `customRender` 不架空工厂，落实 §四.2）：
  - 新增 `_rowEvents` 行级追踪器；`customRender` 签名增第三参 `rowEvents: EventTracker` 注入，使行级交互（展开按钮）经其绑定，随每次 `_renderItems` 重建前清理、destroy 时随工厂清理（防跨刷新监听累积泄漏）。
  - `_renderItems` 把 `customRender` 判断**提前到空态前** —— customRender 接管整段渲染（含空态 hint），消除"空态被默认分支覆盖"的初版缺陷。
  - `renderError` 改用 `_rowEvents`（重试按钮随渲染重生，区别于 mount-once 的 `_events` 刷新按钮）。
  - `renderRow` 改为**可选**（customRender 路径不必填）；默认分支加守卫 + 局部捕获，规避闭包内 TS 收窄失效（TS2722）。

### 9.13.3 验证（全部通过）
| 质量门 | 结果 |
|---|---|
| `tsc -p tsconfig.electron.json --noEmit` | 0 错 |
| `eslint . --ext .ts`（全量） | 0 错 |
| `workProjectionPanelManager.test.ts` | **24/24**（图标映射 / 文件名 / 概要 / 结构·决策 / XSS / 展开折叠 / cleanup 回调解绑全保持） |
| 全 renderer 测试 `src/__tests__/electron/renderer/` | **2390/2390**（68 文件，零回归） |

### 9.13.4 踩坑
- 初版 `_renderItems` 空态分支在 `customRender` 前 `return` → work 空态 hint 丢失（测试 `空数组应显示…引导文字` 失败）→ 将 `customRender` 判断提前。
- `renderRow` 误设必填 → work 缺 `renderRow` 编译失败（TS2345）→ 改可选 + 默认分支守卫 + `const renderRow = this.options.renderRow` 局部捕获（闭包内收窄失效 TS2722）。
- 完整 `vitest run` 被 Bash 默认 120s 超时杀（e2e 单文件 28s），**非测试失败**；renderer 目录 2390 全过佐证零回归。

---

## 9.14 Phase C · #3 profile 对抗式排除（异类，与 memory 同级）

### 9.14.1 事实（DOM + IPC 双核实）
- index.html:1044-1057：`profile-pending-list` / `profile-confirmed-list` 是**两个并列容器**（各自 count + 交互按钮），**无外层包裹**；刷新 `btn-profile-refresh` 在两组之上。
- `profilePanelManager.load()` 单次 fetch `listUserProfile` 返回 **`{entries}`**（非 T[]），按 `confirmed` 分组后渲染到两处。

### 9.14.2 三重不匹配（硬排除证据）
1. **双容器** vs 工厂单 `this.el`：强行纳入需为单消费者撑出"双 count id + 分组渲染 + wrapper"。
2. **IPC 返回 `{entries}`** vs 工厂 `load:()=>Promise<T[]>` 契约：profile 形状与 audit/work 根本不同。
3. **单 fetch 分两组** vs 工厂"单 load 单渲染"：若拆两个 FlatListPanel 会**重复 IPC fetch**（浪费且刷新按钮仅一个）。
- 综合：为单消费者撑大工厂契约 → 违反 §四.2「不要让工厂变成 God Object」，正是"customRender 架空工厂"的反模式。

### 9.14.3 结论与判别铁律补充
- **profile 维持排除**，与 memory 同级（异类不强行纳入）。其双列表 + 确认/拒绝/删除交互已遵循 Manager + helper 良好结构，无需改造。
- 判别铁律（已写入 MEMORY.md）：声明式列表工厂**仅接纳「单容器 + 单 load 返回 T[] + 单计数」面板**；遇 双列表 / `{entries}` 返回 / 无外层包裹 → **异类排除**，不可为单消费者撑大契约。
- Phase C 收口：audit（试点）+ work（customRender）已接入；profile、memory 排除；工厂契约最小可行、未被撑大。

---

## 9.15 Phase D（P2）· 令牌分区 + 注册核对（2026-07-31 续）

### 9.15.1 范围对抗式厘清（报告内部张力）
Phase D 在计划中有两处表述需先对齐，再执行：
- 报告 line 159 Phase D 表：**`tokens.css` L1/L2 注释分区；`components/index.ts` 随分层补全注册**（验收：stylelint 无新增裸值）。
- 报告 line 101 注（同一方案）："§四.3 统一导出口与 index.ts 自身「15+ 文件再分层」存在张力。项目**有意分阶段**，故 P2 而非 P0——**待真正分层时一并完成注册，勿为合规而合规地提前强制注册（复杂度守恒）**。"
- 之前会话 summary 把「将 Phase B 的 `panels/` 组件物理迁至 `components/` + 建 base/feedback/data 子目录」也列入 Phase D。

**第一性结论**：物理迁移 + 子目录分层 = line 101 明确警告的「为合规而合规提前强制分层」，违反复杂度守恒 → **本回合不做**，改为诚实修正过时注释。Phase D 实际交付 = tokens.css 注释分区（实质）+ index.ts 注册核对（注册早已在 Phase B/C 完成，仅修过时注释）。

### 9.15.2 tokens.css L1/L2 注释分区（已执行）
`styles/foundation/tokens.css` 改动**仅注释，不重排、不拆文件**（对齐 line 54/148「注释分区、不必拆文件」）：
- 文件头与 `:root` 间插入**作用域模型横幅**：L1 全局基础（色板/尺度/字体/阴影/z-index/过渡，不可依赖高层）、L2 语义别名（经 var() 引用 L1）、L3 组件覆写（在各面板 CSS，不在此文件）。
- 对 `:root` 内**语义别名块显式标 `[L2]`**（激活态 / source 标签配色 / 语义内边距 / 语义化背景 / 语义化文字别名 / 浮层 / 搜索高亮 / 技能错误态 / 里程碑 / 补齐变量 / 浮动窗口专属，共 13 处）。
- `:root` 关闭处加 **L3 注记**：组件覆写须引用 L1/L2，禁止硬编码裸值。
- `[data-theme="dark"]` 块加**覆盖横幅**：标注其覆盖 L1+L2，L3 仍在各面板 CSS。

> 对抗式校正：`tokens.css` 的 `:root` 内 L1/L2 **按主题交错排列**（非 L1 在前 L2 在后），故采用「顶部模型横幅 + 对 L2 块逐块标注」而非单一分隔带，避免失真误导。

### 9.15.3 components/index.ts 注册核对 + 过时注释修正
- **注册已完整**：grep `extends Component` 得 8 个子类（HealthDashboard/CompletionStats/PartnerInsights/LlmGovernance/Insights/FlatListPanel/MessageBubble/Toast）+ 基类，均已在 `index.ts` 导出（Phase B/C 已完成）。原 P2「仅导出 3/≈13」项**早已解决**。
- **修正 line 33-34 过时注释**：原「待 Phase D 迁移」与 line 101 的「有意分阶段、勿提前强制分层」判据冲突，属谎言注释。改为明示：物理留 `panels/` 为有意为之，未达 15+ 文件分层阈值前不强制 base/feedback/... 子目录归类，故 Phase D 不做物理迁移。

### 9.15.4 质量门（全部通过）
| 门 | 结果 |
|---|---|
| `stylelint "src/electron/renderer/styles/**/*.css"` | OK（无新增裸值、无未知令牌） |
| `tsc -p tsconfig.electron.json --noEmit` | 0 错 |
| 全 renderer 测试 `src/__tests__/electron/renderer/` | **2390/2390**（68 文件，零回归） |

### 9.15.5 结论
Phase D 收口：**tokens.css L1/L2/L3 注释分区落地（可审计的作用域模型）**；`index.ts` 注册核实完整 + 过时注释修正；**刻意递延** panels/→components/ 物理迁移（复杂度守恒，待 15+ 文件再分层）。验收「stylelint 无新增裸值」达成。

### 9.16 Phase E（P3）· applyMixins 回退评估（2026-08-01 收口）

- **实测触发条件**：`ui.ts` = **1077 行**（wc -l + grep 核验），远低于 1500 触发阈值。
- **现状**：`applyMixins`（`helpers/applyMixins.ts`，纯运行时原型的 6 委托群注入）仍在用——`ui.ts:1066-1070` 将 6 个 `ui-delegations` 群复制到 `UIManager.prototype`；类型安全由 `interface extends` 保证（ADR-SP-016 确认 mixin 为有意架构选择，HEAL-13 已判不拆）。
- **第一性结论**：未达「TS 单文件超 1500 行」触发条件 → **不回退**为内联分区注释。回退收益（断点可直接见方法来源、调试可见性）被代价（300+ 委托方法重新内联、重新制造 1500+ 行巨文件、丢失委托群物理隔离）抵消，违反复杂度守恒。
- 与 HEAL-13 决策一致：mixin 因 `UIManager` 门面必然产物 + 委托群物理隔离需求而存在，维持监控不重构。
- **验收**：「调试可见性提升」本为可触发项 → 因未触发，无动作；转为长期观察条目 `UI-MIXIN-OBS`（ui.ts 行数监控，阈值 1500）。

---

## 10. 闭环声明

HEAL-17 渲染层渐进重构 review 全部 5 阶段（A–E）已收口：
- **A**（P1）：`ui.ts` 3 处 orphaned 死注释清理；`modal.ts` 内部元素查找收敛为 `querySelector`。
- **B**（P1→P2）：6 个 `*Renderer` 中 5 个面板渲染器升级 Component（completionStats/healthDashboard/insights/partnerInsights/llmGovernanceResult）；`streamingRenderer` 对抗式豁免。
- **C**（P2）：抽 `FlatListPanel` 声明式工厂——audit（试点）+ work（customRender）接入；profile（双列表+`{entries}`）/ memory（list+search+detail）异类排除；暴露「单容器+单 load 返回 T[]+单计数」接纳判据。
- **D**（P2）：`tokens.css` L1/L2/L3 注释分区落地；`components/index.ts` 注册核对完整 + 过时注释修正；**刻意递延** panels/→components/ 物理迁移（复杂度守恒，待 15+ 文件再分层）。
- **E**（P3）：`applyMixins` 评估——未达 1500 行触发，**不回退**。

报告闭环，归档至 `tasks/归档/`。未闭环项（递延 + 长期观察）已转入 `待完成任务.md`（UI-MIXIN-OBS、D-MIGRATE-OBS、HEAL-17-P3/UI-AUDIT-P0-2 状态刷新）。
