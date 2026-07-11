# 方案：memoryPanelManager.ts 拆分

> **触发**：F-LINE-2 监控项（1968 行，超 1800 触发线，模块重整全阶段完成后启动拆分评估）
> **模式**：模块重思（分析 → 设计 → 产出方案文档，不执行代码修改）
> **日期**：2026-07-11

---

## 1. 问题诊断

### 1.1 现状

`memoryPanelManager.ts` 当前 1968 行，是 sprite renderer 最大的面板管理器，超 1500 行阈值 468 行。

**增长原因**：2026-07-11 感知仪表盘模块重整阶段二，3 个子渲染器（PartnerInsightsRenderer / HealthDashboardRenderer / InsightsRenderer）从 DashboardPanelManager 归位到 MemoryPanelManager，+353 行（1615→1968）。这是合理的归位——DOM 在 panel-memories 内，归 MemoryPanelManager 管理符合分层原则。

### 1.2 职责分布（12 个职责块）

| # | 职责块 | 行数 | 行号范围 | 耦合度 |
|---|--------|------|----------|--------|
| 1 | 记忆列表渲染 | ~174 | L271-445 | 与搜索/筛选耦合 |
| 2 | 时间线视图 | ~190 | L446-636 | 与视图切换耦合 |
| 3 | 记忆详情 | ~197 | L637-834 | 与演化脉络/邻居耦合 |
| 4 | 演化脉络 + 直接邻居 | ~206 | L737-929 | 与记忆详情耦合 |
| 5 | 记忆编辑模式 | ~94 | L934-1028 | 与记忆详情耦合 |
| 6 | 添加记忆表单 | ~33 | L1029-1062 | 独立 |
| 7 | 图谱视图渲染 + 视图切换 | ~437 | L1063-1500 | 与图谱/视图切换耦合 |
| 8 | 回调注册 | ~79 | L1501-1580 | 独立（接口桥接） |
| 9 | 回收站列表渲染 | ~79 | L1581-1660 | 独立 |
| 10 | 图谱上下文菜单 | ~67 | L1661-1728 | 与图谱渲染耦合 |
| 11 | 关系编辑弹窗 | ~131 | L1729-1860 | 与上下文菜单耦合 |
| 12 | 子渲染器委托方法 | ~86 | L1882-1968 | 独立（委托桥接） |

### 1.3 拆分先例

chatPanelManager.ts 已有 3 次成功拆分（1711→1263 行，-448 行）：
- `helpers/startupSummaryBanner.ts`（startupSummaryBanner 组件提取）
- `helpers/messageOperations.ts`（消息操作提取）
- `helpers/chatPanelEvents.ts`（事件监听器提取）

memoryPanelManager.ts 已有 1 次拆分先例：
- `helpers/memoryPanelEvents.ts`（initMemoryPanelListeners 375 行提取）

---

## 2. 拆分方案

### 2.1 设计原则

| 原则 | 说明 |
|------|------|
| 自然生长 | 仅提取已形成完整子系统的职责块，不提前抽象 |
| 纯函数 helper | 参照 memoryPanelEvents.ts 模式：纯函数模块，状态通过 Context 注入 |
| 循环依赖规避 | type-only 导入避免运行时循环依赖 |
| 单次拆分到位 | 一次提取两个 helper，确保拆分后低于 1500 阈值 |

### 2.2 提取范围

**Helper 1：`helpers/memoryGraphPanel.ts`（图谱视图子系统）**

| 方法 | 类型 | 行数 | 说明 |
|------|------|------|------|
| initGraphRenderer | private | ~30 | Canvas 2D 力导向图初始化 |
| updateGraphEmptyState | private | ~7 | 图谱空状态显示 |
| applyCachedGraphState | private | ~10 | 恢复缓存的高亮/选中状态 |
| hideGraphAllHighlights | public | ~7 | 清除高亮 |
| clearGraphSelection | public | ~6 | 清除选中 |
| showGraphContextMenu | private | ~57 | 右键上下文菜单显示 |
| hideGraphContextMenu | private | ~12 | 右键上下文菜单隐藏 |
| showRelationEditDialog | private | ~52 | 关系编辑弹窗 |
| showRelationCreateDialog | private | ~44 | 关系创建弹窗 |
| hideRelationEditDialog | private | ~13 | 关系弹窗隐藏 |
| Context 接口 + 导入 | - | ~50 | 依赖注入接口 |
| 文件头注释 | - | ~30 | 模块说明 |
| **合计** | - | **~318** | |

**Helper 2：`helpers/memoryDetailPanel.ts`（记忆详情子系统）**

| 方法 | 类型 | 行数 | 说明 |
|------|------|------|------|
| showMemoryDetail | private | ~97 | 记忆详情模态框渲染 |
| renderEvolutionPath | private | ~97 | 演化脉络路径追溯 |
| renderDirectNeighbors | private | ~94 | 直接邻居视图 |
| Context 接口 + 导入 | - | ~50 | 依赖注入接口 |
| 文件头注释 | - | ~30 | 模块说明 |
| **合计** | - | **~368** | |

### 2.3 拆分后行数预估

| 文件 | 当前行数 | 拆分后 |
|------|----------|--------|
| memoryPanelManager.ts | 1968 | ~1282（-686） |
| helpers/memoryGraphPanel.ts | 0（新建） | ~318 |
| helpers/memoryDetailPanel.ts | 0（新建） | ~368 |
| **合计** | 1968 | ~1968（总行数不变，但单文件低于 1500 阈值） |

### 2.4 Context 接口设计

**MemoryGraphPanelContext**（图谱视图依赖注入）：

```typescript
export interface MemoryGraphPanelContext {
  // ─── 图谱状态 ───
  graphRenderer: RelationGraphRenderer | null;
  graphDataCache: RelationGraphData | null;
  cachedHighlightedNodeIds: string[] | null;
  cachedSelectedNodeId: string | null;
  graphContextMenuCloseHandler: ((e: MouseEvent) => void) | null;

  // ─── 状态访问器（getter/setter） ───
  getGraphRenderer(): RelationGraphRenderer | null;
  setGraphRenderer(renderer: RelationGraphRenderer | null): void;
  // ... 其余状态访问器

  // ─── 回调 ───
  graphContextMenuCallback: ((action: string, nodeId: string) => void) | null;
  relationEditCallback: ((sourceId: string, targetId: string, type: string, weight: number) => void) | null;
  relationDeleteCallback: ((sourceId: string, targetId: string, type: string) => void) | null;
  relationCreateCallback: ((sourceId: string, targetId: string, type: string, weight: number) => void) | null;

  // ─── 宿主能力 ───
  host: MemoryPanelHost;
  events: EventTracker;
}
```

**MemoryDetailPanelContext**（记忆详情依赖注入）：

```typescript
export interface MemoryDetailPanelContext {
  // ─── DOM 元素 ───
  memoryDetailModal: HTMLElement | null;

  // ─── 状态 ───
  isEditing: boolean;

  // ─── 回调 ───
  memoryClickCallback: ((id: string) => void) | null;
  memoryEditCallback: ((id: string, content: string) => void) | null;
  memoryDiscussCallback: ((memoryName: string) => void) | null;

  // ─── 宿主能力 ───
  host: MemoryPanelHost;
  events: EventTracker;
}
```

### 2.5 调用方式

参照 memoryPanelEvents.ts 的调用模式：

```typescript
// memoryPanelManager.ts 中
import { renderGraphView } from '../helpers/memoryGraphPanel.js';
import { showMemoryDetailPanel } from '../helpers/memoryDetailPanel.js';

// 原方法替换为委托调用
private initGraphRenderer(): void {
  renderGraphView(this.buildGraphPanelContext());
}

showMemoryDetail(memory: MemoryListItem): void {
  showMemoryDetailPanel(memory, this.buildDetailPanelContext());
}
```

---

## 3. 风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| 状态字段跨模块访问 | 中 | 通过 Context 接口的 getter/setter 访问，避免直接暴露字段 |
| 循环依赖 | 低 | type-only 导入（编译期擦除），运行时无循环 |
| 方法签名变更 | 低 | 保持 public 方法签名不变，仅内部实现委托到 helper |
| 测试覆盖率下降 | 低 | 现有测试通过 MemoryPanelManager 实例调用，拆分后测试路径不变 |

---

## 4. 验证步骤

1. `npx tsc -p tsconfig.electron.json --noEmit` — TypeScript 编译通过
2. `npx vitest run` — 全量测试通过
3. 检查 memoryPanelManager.ts 行数 < 1500
4. 检查无运行时循环依赖

---

## 5. 执行计划

| 阶段 | 内容 | 预估变更文件 |
|------|------|-------------|
| 阶段一 | 创建 helpers/memoryGraphPanel.ts + 迁移图谱视图逻辑 | 新建 1 + 修改 1 |
| 阶段二 | 创建 helpers/memoryDetailPanel.ts + 迁移记忆详情逻辑 | 新建 1 + 修改 1 |
| 阶段三 | 验证（tsc + vitest）+ 更新 directory-structure.md | 修改 1 |

---

> **说明**：本方案为模块重思维产出，不执行代码修改。审查通过后可通过"方案更新"模式执行。
