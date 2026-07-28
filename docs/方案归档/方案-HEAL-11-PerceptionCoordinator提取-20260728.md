# HEAL-11 PerceptionCoordinator 提取方案

> 来源：HEAL-11 UIManager 上帝类重构第一步。UIManager 持有 28 个子模块，远超"上帝类"阈值。本轮按功能域提取第一个二级容器验证集成模式。
> 日期：2026-07-28

## 一、现状分析

### 1.1 演进路径

```
UIManager 当前状态（ADR-SP-015 组合模式 + ADR-SP-016 Mixin 拆分）
  - 28 个子模块字段（已通过 mixin 完成方法级解耦）
  - 构造函数 145 行（27 步实例化 + 16 步 init）
  - 每个子模块是独立 Manager 类，UIManager 是 facade + 协调器
  ↓
本轮：提取 PerceptionCoordinator（3 字段，感知/仪表盘域）
  ↓
（后续渐进）SettingsCoordinator / MemoryCoordinator / ChatCoordinator / GlobalInfraCoordinator
  ↓
UIManager 从 28 字段降至 ~10 字段 + 4-5 个 Coordinator
```

### 1.2 调研结论

UIManager 表面是"上帝类"（28 字段 + 100+ 方法），但实际已通过 ADR-SP-015 + ADR-SP-016 完成深度解耦：
- 每个子模块是独立 Manager 类、独立 EventTracker、独立 cleanup 契约
- 6 个 mixin 委托群已完成方法级拆分（纯透传，不夹带业务逻辑）
- UIManager 主要承担 facade + 协调器角色

**剩余问题**：字段数量过多（28）+ 构造函数长度（145 行）。解决方向是按功能域引入二级协调器，而非继续 mixin 拆分。

### 1.3 本轮提取范围

| 迁入 PerceptionCoordinator 的字段 | 类型 | 职责 |
|----------------------------------|------|------|
| `dashboardPanel` | DashboardPanelManager | 仪表盘（概览 + 运行指标 + 记忆源健康 + 增长趋势） |
| `perceptionPanel` | PerceptionPanelManager | 完整版感知数据展示（情感/默契/上下文/模式/在场/叙事） |
| `spriteStatusPopover` | SpriteStatusPopover | hover 弹出轻量感知摘要（与 perceptionPanel 共享数据源） |

**选择这 3 个字段的理由**：
1. **耦合度高**：三者共享 AffectPayload / RapportPayload / ContextPayload 数据源，dashboardDelegations 中 `updateAffectDisplay` / `updateRapportDisplay` / `updateContextDisplay` 同时委托 perceptionPanel + spriteStatusPopover
2. **外部依赖少**：3 个子模块不依赖 toastManager / modalManager 等全局基础设施（dashboardPanel 仅依赖 EventTracker，perceptionPanel 依赖 PerceptionPanelHost，spriteStatusPopover 无依赖）
3. **职责封闭**：感知/仪表盘域与其他域正交，不跨域
4. **调研建议**：报告第 8.3 节明确建议阶段 1 抽容器 D（PerceptionInsightLayer），3 个子模块耦合度高、外部依赖少

### 1.4 不提取的字段

| 字段 | 所属域 | 不提取理由 |
|------|--------|-----------|
| `memoryPanel` | MemoryExplorerLayer | 虽然在 dashboardDelegations 中被委托，但属于记忆域，下一轮提取 |
| 其他 24 个字段 | 各域 | 渐进式重构，本轮只验证集成模式 |

## 二、PerceptionCoordinator 类设计

```typescript
/**
 * 感知/仪表盘域二级协调器
 *
 * 封装感知可视化相关的 3 个子模块：
 * - dashboardPanel（仪表盘：概览 + 运行指标 + 记忆源健康 + 增长趋势）
 * - perceptionPanel（完整版感知数据展示：情感/默契/上下文/模式/在场/叙事）
 * - spriteStatusPopover（hover 弹出轻量感知摘要，与 perceptionPanel 共享数据源）
 *
 * 设计原则：
 * - 纯状态容器 + cleanup 集中清理（不持有业务逻辑，业务逻辑仍在 UIManager + mixin）
 * - 字段公开暴露，dashboardDelegations / ui.ts 直接读写
 * - 初始化仍在 UIManager 构造函数中（perceptionPanel 依赖 PerceptionPanelHost 反向注入）
 *
 * 集成点：
 * - UIManager 持有 perceptionCoordinator 实例并挂载到 this.perceptionCoordinator
 * - dashboardDelegations.ts 通过 this.perceptionCoordinator.dashboardPanel 等访问
 * - UIManager.cleanup() 调用 perceptionCoordinator.cleanup() 集中清理
 */
export class PerceptionCoordinator {
  /** 仪表盘面板管理器（概览 + 指标 + 健康 + 趋势），构造函数初始化 */
  dashboardPanel!: DashboardPanelManager;
  /** 完整版感知面板管理器（情感/默契/上下文/模式/在场/叙事），构造函数初始化 */
  perceptionPanel!: PerceptionPanelManager;
  /** 精灵状态浮层（hover 弹出轻量感知摘要），构造函数初始化 */
  spriteStatusPopover!: SpriteStatusPopover;

  /**
   * 集中清理 3 个子模块资源
   *
   * UIManager.cleanup() 调用，确保定时器和事件监听器正确释放。
   * 各子模块的 cleanup 由各自实现，此方法仅集中调度。
   */
  cleanup(): void {
    this.dashboardPanel.cleanup(); // 清理仪表盘脉冲定时器与重试按钮事件
    this.perceptionPanel.cleanup(); // 清理感知面板资源
    this.spriteStatusPopover.cleanup(); // 清理精灵状态浮层 hover 事件和定时器
  }
}
```

> **注**：字段使用 `!:` definite assignment 语法（与 WindowService/QuickInputService 一致）。初始化仍在 UIManager 构造函数中，因 perceptionPanel 构造依赖 `this as PerceptionPanelHost`。

### 2.1 与 main.ts Service 模式的对比

| 维度 | main.ts Service | UIManager Coordinator |
|------|----------------|----------------------|
| 字段语法 | `!:` definite assignment | `!:` definite assignment |
| 初始化位置 | main.ts 构造函数 / 阶段 1/2 | UIManager 构造函数 |
| cleanup | `nullify()`（切断引用） | `cleanup()`（调用子模块 cleanup + 切断引用） |
| 业务逻辑 | 仍在 main.ts | 仍在 UIManager + mixin |
| 依赖注入 | 无（纯字段赋值） | perceptionPanel 依赖 Host 反向注入 |

**关键差异**：main.ts 的 Service 是主进程状态容器，退出时只需 nullify 切断引用；UIManager 的 Coordinator 是渲染进程 UI 组件容器，cleanup 时需先调用各子模块的 cleanup 方法（清理定时器/事件监听器），再切断引用。

## 三、改动文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `renderer/coordination/perceptionCoordinator.ts` | **新建** | PerceptionCoordinator 类（3 字段 + cleanup） |
| `renderer/ui.ts` | 修改 | 3 字段声明替换为 coordinator；构造函数初始化路径调整；cleanup 集中调用；业务方法路径调整 |
| `renderer/helpers/ui-delegations/dashboardDelegations.ts` | 修改 | this.dashboardPanel → this.perceptionCoordinator.dashboardPanel 等（3 字段路径调整） |
| `src/__tests__/electron/renderer/uiDelegations.test.ts` | 修改 | 断言路径调整（mock.dashboardPanel → mock.perceptionCoordinator.dashboardPanel） |

### 3.1 ui.ts 改动详情

**字段声明**（第 161/163/165 行）：
```typescript
// 修改前
dashboardPanel: DashboardPanelManager;
perceptionPanel: PerceptionPanelManager;
spriteStatusPopover: SpriteStatusPopover;

// 修改后
perceptionCoordinator: PerceptionCoordinator;
```

**构造函数初始化**（第 335/338/341 行）：
```typescript
// 修改前
this.dashboardPanel = new DashboardPanelManager(new EventTracker());
this.perceptionPanel = new PerceptionPanelManager(this as PerceptionPanelHost);
this.spriteStatusPopover = new SpriteStatusPopover();

// 修改后
this.perceptionCoordinator = new PerceptionCoordinator();
this.perceptionCoordinator.dashboardPanel = new DashboardPanelManager(new EventTracker());
this.perceptionCoordinator.perceptionPanel = new PerceptionPanelManager(this as PerceptionPanelHost);
this.perceptionCoordinator.spriteStatusPopover = new SpriteStatusPopover();
```

**init 调用**（第 384 行）：
```typescript
// 修改前
this.perceptionPanel.init(new EventTracker());

// 修改后
this.perceptionCoordinator.perceptionPanel.init(new EventTracker());
```

**cleanup**（第 458-460 行）：
```typescript
// 修改前
this.dashboardPanel.cleanup();
this.perceptionPanel.cleanup();
this.spriteStatusPopover.cleanup();

// 修改后
this.perceptionCoordinator.cleanup();
```

**业务方法**（第 913/956-961/965-966 行）：
```typescript
// 修改前
this.dashboardPanel.showMemoryListError(listEl);
this.perceptionPanel.renderPerceptionSnapshot(snapshot);
if (snapshot.affect) this.spriteStatusPopover.updateAffect(snapshot.affect as AffectPayload);
// ...

// 修改后
this.perceptionCoordinator.dashboardPanel.showMemoryListError(listEl);
this.perceptionCoordinator.perceptionPanel.renderPerceptionSnapshot(snapshot);
if (snapshot.affect) this.perceptionCoordinator.spriteStatusPopover.updateAffect(snapshot.affect as AffectPayload);
// ...
```

### 3.2 dashboardDelegations.ts 改动详情

3 个字段的委托路径调整（共 18 处）：
- `this.dashboardPanel` → `this.perceptionCoordinator.dashboardPanel`（8 处）
- `this.perceptionPanel` → `this.perceptionCoordinator.perceptionPanel`（7 处）
- `this.spriteStatusPopover` → `this.perceptionCoordinator.spriteStatusPopover`（3 处）

**注意**：`this.memoryPanel` 保持不变（下一轮提取）。

### 3.3 uiDelegations.test.ts 改动详情

断言路径调整（共 11 处），如：
```typescript
// 修改前
expect(mock.dashboardPanel.renderDashboardStats).toHaveBeenCalledWith(data);
expect(mock.perceptionPanel.updateAffectDisplay).toHaveBeenCalledWith(affect);
expect(mock.spriteStatusPopover.updateAffect).toHaveBeenCalledWith(affect);

// 修改后
expect(mock.perceptionCoordinator.dashboardPanel.renderDashboardStats).toHaveBeenCalledWith(data);
expect(mock.perceptionCoordinator.perceptionPanel.updateAffectDisplay).toHaveBeenCalledWith(affect);
expect(mock.perceptionCoordinator.spriteStatusPopover.updateAffect).toHaveBeenCalledWith(affect);
```

**mock 机制**：`createMockThis` 使用 Proxy 动态属性访问，`mock.perceptionCoordinator.dashboardPanel` 会自动创建嵌套 Proxy，无需修改 mock 设置逻辑。

## 四、不提取的归档

### 4.1 memoryPanel（下一轮提取）

**理由**：
- 属于 MemoryExplorerLayer（容器 B），与 dashboardPanel/perceptionPanel/spriteStatusPopover 所属的 PerceptionInsightLayer（容器 D）是不同功能域
- dashboardDelegations 中同时委托 memoryPanel 和 perceptionPanel，但这是 mixin 的跨域委托，不应通过 Coordinator 强制耦合
- 下一轮提取 MemoryCoordinator 时，dashboardDelegations 中的 `this.memoryPanel` 路径会一并调整

### 4.2 其他 24 个字段

按 5 阶段渐进式提取（见 §五），本轮只验证集成模式。

## 五、后续演进路径

```
本轮：PerceptionCoordinator 提取（3 字段，感知/仪表盘域）
  ↓
阶段 2：SettingsCoordinator 提取（5 字段，设置/配置域）
  ↓
阶段 3：MemoryCoordinator 提取（5 字段，记忆/检索域）
  ↓
阶段 4：ChatCoordinator 提取（6 字段，对话域）
  ↓
阶段 5：GlobalInfraCoordinator 提取（9 字段，全局基础设施域）
  ↓
UIManager 从 28 字段降至 ~5 个 Coordinator + 应用级状态
```

每个阶段独立验证集成模式，降低单次修改风险。

## 六、验证计划

1. **类型检查**：`tsc --noEmit` 通过
2. **全量测试**：4631/4631 通过（含 uiDelegations 11 处断言路径调整）
3. **集成模式验证点**：
   - 构造函数正确初始化 3 字段到 perceptionCoordinator
   - cleanup 正确调用 perceptionCoordinator.cleanup()
   - dashboardDelegations 通过 perceptionCoordinator.xxx 访问
   - ui.ts 业务方法通过 perceptionCoordinator.xxx 访问
   - uiDelegations.test.ts 断言路径正确

## 七、实施完成（2026-07-28）

### 验证结果

- `npm run typecheck:electron`：0 错误
- `npm run test`：138 文件 / 4631 测试全通过（含 uiDelegations 128 测试）

### 实际修改文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `renderer/coordination/perceptionCoordinator.ts` | **新建** | PerceptionCoordinator 类（3 字段 + cleanup） |
| `renderer/ui.ts` | 修改 | 添加 PerceptionCoordinator 导入；3 字段声明替换为 perceptionCoordinator；构造函数初始化路径调整；cleanup 集中调用；业务方法路径调整 |
| `renderer/helpers/ui-delegations/dashboardDelegations.ts` | 修改 | 16 处委托路径调整为 this.perceptionCoordinator.xxx；注释更新 |
| `renderer/helpers/ui-delegations/memoryDelegations.ts` | 修改 | 1 处委托路径调整（onMemoryClick 中的 perceptionPanel） |
| `src/__tests__/electron/renderer/uiDelegations.test.ts` | 修改 | 断言路径统一为 mock.perceptionCoordinator.xxx；重写 createMockThis() 为深度 Proxy 支持任意层级嵌套访问 |
| `src/electron/main.ts` | 修复 | 补充 QuickInputService 导入（HEAL-10C 遗留） |

### 额外修复

- **main.ts QuickInputService 导入缺失**：HEAL-10C 遗留问题，`appState.quickInputService = new QuickInputService()` 引用了未导入的类。本轮补充导入。
- **createMockThis() 深度 Proxy 重写**：原 Proxy 只支持两层访问（mock.xxx.yyy），HEAL-11 引入三层访问（mock.perceptionCoordinator.dashboardPanel.xxx）后失效。重写为递归 Proxy，每一层既是 vi.fn()（可调用、支持 mock API）又是 Proxy（属性访问返回新的同类 Proxy），支持任意深度嵌套。

### 后续演进

- 阶段 2：SettingsCoordinator 提取（5 字段，设置/配置域）
- 阶段 3：MemoryCoordinator 提取（5 字段，记忆/检索域）
- 阶段 4：ChatCoordinator 提取（6 字段，对话域）
- 阶段 5：GlobalInfraCoordinator 提取（9 字段，全局基础设施域）
