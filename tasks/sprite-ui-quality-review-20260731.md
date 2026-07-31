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
| **Phase B（P1→P2）** | 将 6 个 `*Renderer` 与 1-2 个最小面板（如 `badgeManager`/`panelErrorBannerManager`）改造为继承 `Component`，UIManager 持有实例 | 中 | 行为不变 + 新增 `destroy()` 测试 |
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
