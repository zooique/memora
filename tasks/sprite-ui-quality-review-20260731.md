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
| **Phase B（P1→P2）** | 将 6 个 `*Renderer` 改造为继承 `Component`，Manager 持有实例（已完成 completionStats + healthDashboard **2/6**，见 §9；剩余 insights / partnerInsights / llmGovernanceResult / streaming） | 中 | 行为不变 + 新增/迁移 `destroy()` 测试 |
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

### 9.4 铺开计划（剩余 5 个 `*Renderer`）
模式已验证，下一步按相同契约逐个改造并各自跑质量门：`healthDashboardRenderer` → `insightsRenderer` → `partnerInsightsRenderer` → `llmGovernanceResultRenderer` → `streamingRenderer`（外加可选最小面板 `badgeManager`/`panelErrorBannerManager`）。每个独立可验证，符合「渐进迁移，不一次性重写」。

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
