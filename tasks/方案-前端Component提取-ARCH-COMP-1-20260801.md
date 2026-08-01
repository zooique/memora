# 方案：前端 PanelManager 直接 DOM 操作 → Component 提取

> 对应任务：ARCH-COMP-1（P0）
> 日期：2026-08-01
> 状态：阶段 1 已完成

---

## 1. 背景

当前前端面板层（`panels/`）存在大量直接 DOM 操作（`document.getElementById`），与项目的 UI 工程化心智模型（Manager 编排 + Component 封装）不一致。memoryPanelManager 已实践 Component 模式（持有 4 个 Component 实例），验证了模式可行，需推广至其余面板。

## 2. 现状分析

### 2.1 DOM 操作分布

| 文件 | document.getElementById 次数 | 行数 | 优先级 |
|------|---------------------------|------|--------|
| dashboardPanelManager.ts | 29 | 881 | P0 |
| perceptionPanelManager.ts | 23 | 179 | P0 |
| settingsManagerPanel.ts | 15 | 1208 | P0 |
| dateNavManager.ts | 11 | ~500 | P1 |
| memoryPanelManager.ts | 10 | 1462 | ✅ 已部分组件化 |
| inputAreaManager.ts | 7 | ~400 | P1 |
| clipboardPanelManager.ts | 6 | 556 | P1 |
| commandPaletteManager.ts | 6 | 695 | P1 |
| panelRouter.ts | 4 | ~200 | P2 |
| panelErrorBannerManager.ts | 3 | ~100 | P2 |
| chatPanelManager.ts | 2 | 1186 | P2 |
| auxSidebarManager.ts | 3 | ~200 | P2 |
| globalShortcutDispatcher.ts | 2 | ~250 | P2 |

### 2.2 现有 Component 基础设施

- `Component<P>` 抽象基类（`components/base/component.ts`）— 提供 `mount/update/destroy` 生命周期
- `components/` 已分层：`base/`、`data/`、`feedback/`
- 已有实践：`CompletionStatsComponent`、`HealthDashboardComponent`、`InsightsComponent`、`PartnerInsightsComponent`
- 参考模式：memoryPanelManager 持有 Component 实例，调用 `mount('#selector')` 挂载，`destroy()` 清理

### 2.3 现有模式与问题

**当前模式**（反模式）：
```typescript
// panelManager.ts
init(): void {
  this.someEl = document.getElementById('some-element'); // 直接查询 DOM
  this.someEl.textContent = data.value; // 直接操作 DOM
}
```

**目标模式**：
```typescript
// panelManager.ts — Manager 编排
init(): void {
  this.someComponent = new SomeComponent({ host: this.host });
  this.someComponent.mount('#panel-container');
}

// someComponent.ts — Component 封装
class SomeComponent extends Component<Options> {
  mount(container: string): this {
    this.el = document.createElement('div');
    // ... 内部 DOM 操作
    document.getElementById(container)!.appendChild(this.el);
    return this;
  }
}
```

## 3. 方案设计

### 3.1 提取原则

1. **按功能域聚类**：将同一面板中逻辑内聚的 DOM 操作群提取为一个 Component
2. **Manager 持有 Component**：Manager 不直接 createElement，通过 Component 实例操作 DOM
3. **增量替换**：不一次性全量替换，按优先级分阶段替换
4. **复用已有 Component**：优先使用 `components/` 下已有的 Component 类型
5. **不破坏现有 API**：Component 提取不改变 Manager 对外暴露的接口

### 3.2 Component 提取清单

#### 阶段 1：dashboardPanelManager（29 处 → 预计 4 个 Component）

| Component | 封装范围 | document.getElementById 覆盖 |
|-----------|---------|---------------------------|
| `DashboardGrowthComponent` | 增长卡片区域（growthSection/growthDesc/growthCards/growthCanvas/growthEmpty） | ~5 处 |
| `DashboardStatsComponent` | 统计指标卡（memories/today/insights/llmCalls/tokens/recallRate/toolFailures/truncation/messageCount/estimatedTokens） | ~10 处 |
| `DashboardDecayComponent` | 衰减管理（decayCount/decayDetail/decayRuns + triggerDecayBtn） | ~4 处 |
| `DashboardSourceHealthComponent` | 记忆源健康诊断（sourceHealthList/section/overall/diagnosed + recentInsights） | ~6 处 |
| `DashboardErrorBannerComponent` | 错误提示（error/errorMsg/retryBtn） | ~3 处 |

**清理后**：dashboardPanelManager 的 `document.getElementById` 从 29 → 0，Manager 仅持有 5 个 Component 实例 + 调用 mount/update。

#### 阶段 2：perceptionPanelManager（23 处 → 预计 4 个 Component）

| Component | 封装范围 |
|-----------|---------|
| `PerceptionAffectComponent` | 情感基调（四维进度条 + 等级） |
| `PerceptionRapportComponent` | 默契度（等级徽章 + 信任/熟悉进度条） |
| `PerceptionContextComponent` | 对话上下文（节奏/话题/深度三卡片） |
| `PerceptionProactiveComponent` | 主动提示统计（suggest/accept/rate/rejects/cooldown） |
| `PerceptionPresenceComponent` | 在场状态（presenceDot/presenceText + narrativeText） |

#### 阶段 3：settingsManagerPanel（15 处 → 预计 3 个 Component）

| Component | 封装范围 |
|-----------|---------|
| `SettingsEditorComponent` | 编辑器模态框（内容编辑 crud 操作） |
| `SettingsFileListComponent` | 文件列表区（tab 切换 + 列表渲染） |
| `SettingsDropZoneComponent` | 技能拖入安装区 |

### 3.3 参考实现：CompletionStatsComponent 模式

```typescript
// 已有参考实现，新 Component 应遵循此模式：
export class XxxComponent extends Component<XxxOptions> {
  // 内部 DOM 引用（非 document.getElementById，而是通过 this.el 查询）
  private subEl: HTMLElement | null = null;

  mount(container: string): this {
    // 1. 创建根元素
    this.el = document.createElement('div');
    this.el.className = 'xxx-component';

    // 2. 构建骨架（使用 createElement，不依赖外部 HTML）
    this.subEl = document.createElement('div');
    this.el.appendChild(this.subEl);

    // 3. 绑定事件（通过 trackEvent 管理清理）
    const handler = () => this.handleClick();
    this.subEl.addEventListener('click', handler);
    this.trackEvent(() => this.subEl?.removeEventListener('click', handler));

    // 4. 挂载到容器
    const containerEl = document.getElementById(container);
    if (!containerEl) throw new Error(`Container #${container} not found`);
    containerEl.appendChild(this.el);

    return this;
  }

  update(newOptions: Partial<XxxOptions>): this {
    // 增量更新，不重建 DOM
    return this;
  }

  destroy(): void {
    // 1. 清理子类引用
    this.subEl = null;
    // 2. 调用 super 清理（事件解绑 + 移除 DOM + nullify el）
    super.destroy();
  }
}
```

### 3.4 Manager 端改造模式

```typescript
// 改造前
class DashboardPanelManager {
  private growthSectionEl: HTMLElement | null = null;
  init(): void {
    this.growthSectionEl = document.getElementById('dashboard-growth');
    // ... 29 处 DOM 查询
  }
}

// 改造后
class DashboardPanelManager {
  private growthComponent: DashboardGrowthComponent | null = null;
  private statsComponent: DashboardStatsComponent | null = null;

  init(): void {
    this.growthComponent = new DashboardGrowthComponent({ host: this.host });
    this.growthComponent.mount('#dashboard-container');
    this.statsComponent = new DashboardStatsComponent({ host: this.host });
    this.statsComponent.mount('#dashboard-container');
  }

  update(data: DashboardData): void {
    this.growthComponent?.update({ data });
    this.statsComponent?.update({ data });
  }

  cleanup(): void {
    this.growthComponent?.destroy();
    this.growthComponent = null;
    this.statsComponent?.destroy();
    this.statsComponent = null;
  }
}
```

## 4. 实施路径

### 阶段 1（P0，当前轮次）：dashboardPanelManager Component 提取

1. 创建 `DashboardGrowthComponent` — 封装增长卡片区域（~5 处 DOM 操作）
2. 创建 `DashboardStatsComponent` — 封装统计指标卡（~10 处 DOM 操作）
3. 创建 `DashboardDecayComponent` — 封装衰减管理（~4 处 DOM 操作）
4. 创建 `DashboardSourceHealthComponent` — 封装记忆源健康诊断（~6 处 DOM 操作）
5. 创建 `DashboardErrorBannerComponent` — 封装错误提示（~3 处 DOM 操作）
6. 改造 `dashboardPanelManager.ts` — 删除直接 DOM 操作，改为持有 Component 实例

### 阶段 2（P0，后续轮次）：perceptionPanelManager Component 提取

1. 创建感知面板各 Component
2. 改造 perceptionPanelManager.ts

### 阶段 3（P0，后续轮次）：settingsManagerPanel Component 提取

1. 创建设定面板各 Component
2. 改造 settingsManagerPanel.ts

### 阶段 4（P1，后续轮次）：其余面板 Component 提取

1. dateNavManager → DateNavComponent
2. inputAreaManager → InputAreaComponent（ProviderSelector + TokenUsage）
3. clipboardPanelManager → ClipboardComponent
4. commandPaletteManager → 部分 DOM 操作迁移

## 5. 风险与注意事项

### 风险

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| Component 提取后 Manager 与 Component 的 update 时机不一致 | 🟡 | 统一使用 `update()` 方法，Manager 在数据到达时调用 |
| 过度拆分导致 Component 粒度过细 | 🟡 | 每个 Component 至少封装 3+ 处 DOM 操作，避免 1 处 DOM 操作 1 个 Component |
| 现有 CSS 选择器依赖 ID 选择器 | 🟢 | Component 内部使用 class 选择器，保持 CSS 兼容 |

### 注意事项

1. **不破坏现有 API**：Manager 的对外接口（方法名、参数）不变
2. **增量迁移**：阶段 1 完成后验证 dashboardPanelManager 功能正常，再继续阶段 2
3. **CSS 兼容**：Component 类名使用 `xxx-component` 格式，避免与现有 ID 选择器冲突
4. **无功能新增**：Component 提取是纯重构，不引入新功能
5. **handleXxx 方法保留**：Component 内部的事件处理方法（如 handleClick）保留在 Component 内部，不移回 Manager

## 7. 实施完成（阶段 1 — dashboardPanelManager）

### 7.1 验证结果

- **编译**: `tsc --noEmit` 零错误通过
- **消除 document.getElementById**: ~14 处（增长趋势 7 + 源健康 4 + 错误横幅 3）
- **删除代码**: 7 个私有方法 + 1 个字段（已迁移到对应 Component）
- **新增代码**: 3 个 Component 文件

### 7.2 实际修改文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `components/data/dashboardGrowthComponent.ts` | 新建 | 封装增长趋势区域（趋势描述/对比卡片/柱状图/最近洞察） |
| `components/data/dashboardSourceHealthComponent.ts` | 新建 | 封装记忆源健康诊断（健康列表/总体状态/诊断时间） |
| `components/data/dashboardErrorBannerComponent.ts` | 新建 | 封装错误提示横幅（错误信息/重试按钮） |
| `panels/dashboardPanelManager.ts` | 修改 | 删除 5 个 DOM 缓存字段 + 7 个私有方法，替换为 3 个 Component 实例持有 |

### 7.3 额外修复

- 修复 `formatTimeAgo` 缺失导入的遗留问题（renderAgentMetrics 中使用了但未导入）

### 7.4 后续演进

- **阶段 2**：perceptionPanelManager Component 提取（23 处 DOM 操作）
- **阶段 3**：settingsManagerPanel Component 提取（15 处 DOM 操作）
- **阶段 4**：其余面板 Component 提取（P1 优先级）

## 6. 关联任务

- **AUDIT-H5**（SettingsPanelManager 4 职责域拆分）：阶段 3 完成后可评估 SettingsPanelManager 的职责拆分
- **AUDIT-H6**（MemoryPanelManager 回调地狱重构）：Component 提取完成后，MemoryPanelManager 的 DOM 操作已清理，回调字段可独立评估
- **ARCH-ORCH**（Orchestrator 边界）：Component 提取不涉及 Orchestrator 边界，可并行推进