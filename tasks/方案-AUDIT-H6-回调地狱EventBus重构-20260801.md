# AUDIT-H6 MemoryPanelManager 回调地狱重构 — 方案设计

> 任务：`tasks/待完成任务.md` §1.2 AUDIT-H6（MemoryPanelManager 回调地狱重构：20 回调字段 → 类型化 EventMap/EventBus）
> 状态：**方案设计阶段（未实施）**
> 日期：2026-08-01

## 一、现状分析

### 1.1 演进路径（从当前状态到目标状态）

```
当前（三份模板代码各自独立演化）          目标（签名单一真理源 + 统一存储）
─────────────────────────────            ─────────────────────────────
20 个 callback 字段                      MemoryPanelEventMap（签名唯一）
  ↑ 签名手写第 1 份                       ↑ EventMap 接口（单一真理源）
20 个 onXxx() 注册方法                    20 个 onXxx() 保留为薄委托
  ↑ 签名手写第 2 份                          ↓ 内部
22 个 getXxxCallback() getter 定义        TypedEventBus<MemoryPanelEventMap>
  ↑ 签名手写第 3 份（4 个 context 分散）     ↓ 内部
33 处 helper 消费（getter 调用）           helpers 直呼 bus.emit(event, ...)
```

**核心矛盾**：回调的**签名**被复制 3 份（字段类型 / onXxx 参数 / getter 返回类型），**存储**被分散 4 处（4 个 context builder 各自暴露 getter），**同一回调被重复暴露**（`memoryClickCallback` 在 3 个 context 中各有一个 getter）。新增/修改一个回调需同时改 3+ 处签名，类型漂移风险随面板演进累积。

### 1.2 调研结论（是否真的需要重构）

**触发依据（符合 progressive-refactor-rules §1 硬阈值）**：

| 维度 | 阈值 | 实测 | 结论 |
|------|------|------|------|
| 字段数 | ≥15 | 20 回调字段 | ✅ 超阈值 |
| 修改成本 | 单次改动 ≥10 处 | 新增 1 个回调需改：字段 + onXxx + N 个 context getter 定义 + N 处消费 | ✅ 超阈值 |
| 签名重复 | — | 3 份手写签名（字段/方法/getter） | ✅ 模板代码 |

**根因（第一性原理）**：回调地狱不是"字段多"的表象问题，而是**"注册接口、存储、读取"三者之间缺少单一真理源**。getter 机制本质是"onXxx 注册晚于 initMemoryPanelListeners"时序问题的产物——事件触发时需动态读取最新回调，于是手写了一套"单槽位事件注册表"（`Map` 的拙劣替代）。EventBus 正是这套手写机制的正式化：存储收敛为 Map、签名收敛为 EventMap、读取收敛为 emit。

### 1.3 本轮提取范围（20 个回调全量清单）

| # | 事件名（kebab-case） | 签名 | 当前字段 | 当前 onXxx | helper 消费点 |
|---|---------------------|------|---------|-----------|--------------|
| 1 | `memory-search` | `(query: string) => void` | memorySearchCallback | onMemorySearch | memoryPanelEvents:279 |
| 2 | `memory-filter` | `(source: string) => void` | memoryFilterCallback | onMemoryFilter | memoryPanelEvents:286 |
| 3 | `memory-click` | `(id: string) => void` | memoryClickCallback | onMemoryClick | events:246,258 + graphPanel:112 + detailPanel:149,300,435 |
| 4 | `memory-delete` | `() => void` | memoryDeleteCallback | onMemoryDelete | memoryPanelEvents:400 |
| 5 | `memory-add` | `(data: {source;name;content}) => void` | memoryAddCallback | onMemoryAdd | memoryPanelEvents:319,342 |
| 6 | `memory-edit` | `(id: string, content: string) => void` | memoryEditCallback | onMemoryEdit | saveEdit 直用:779 |
| 7 | `memory-discuss` | `(memoryName: string) => void` | memoryDiscussCallback | onMemoryDiscuss | memoryPanelEvents:437 |
| 8 | `more-menu-action` | `(action: string) => void` | moreMenuActionCallback | onMoreMenuAction | events:612 + viewSwitcher:250,457 |
| 9 | `sort-change` | `() => void` | sortChangeCallback | onSortChange | memoryPanelEvents:528 |
| 10 | `time-range-change` | `() => void` | timeRangeChangeCallback | onTimeRangeChange | memoryPanelEvents:536 |
| 11 | `cleanup-request` | `(type: 'duplicates'\|'stale'\|'all') => string[]` | cleanupRequestCallback | onCleanupRequest | memoryPanelEvents:634,645,656 |
| 12 | `cleanup-confirm` | `(ids: string[]) => Promise<void>` | cleanupConfirmCallback | onCleanupConfirm | memoryPanelEvents:684 |
| 13 | `llm-governance` | `(action: 'dedup'\|'timeliness'\|'conflicts') => Promise<void>` | llmGovernanceCallback | onLlmGovernance | memoryPanelEvents:209 |
| 14 | `view-switch` | `(mode: 'list'\|'timeline'\|'graph') => void` | viewSwitchCallback | onViewSwitch | memoryPanelEvents:605 |
| 15 | `graph-context-menu` | `(action: string, nodeId: string) => void` | graphContextMenuCallback | onGraphContextMenuAction | graphPanel:212 |
| 16 | `relation-edit` | `(sourceId,targetId,type,weight) => void` | relationEditCallback | onRelationEdit | graphPanel:341 |
| 17 | `relation-delete` | `(sourceId,targetId,type) => void` | relationDeleteCallback | onRelationDelete | graphPanel:348 |
| 18 | `relation-create` | `(sourceId,targetId,type,weight) => void` | relationCreateCallback | onRelationCreate | graphPanel:404 |
| 19 | `recycle-bin-action` | `(action: 'restore'\|'purge', id) => Promise<void>` | recycleBinActionCallback | onRecycleBinAction | memoryPanelEvents:721,735 |
| 20 | `recycle-bin-batch-action` | `(action: 'restore-all'\|'purge-all') => Promise<void>` | recycleBinBatchActionCallback | onRecycleBinBatchAction | memoryPanelEvents:759,769 |

**签名形态统计**：20 个回调中 17 个返回 `void`，**3 个返回非 void**（#11 返回 `string[]`、#12/#13/#19/#20 返回 `Promise<void>`，共 5 个）。→ EventBus 的 `emit` **必须支持返回值透传**（详见 §2.2 决策 2）。

### 1.4 不提取的归档

| 项 | 理由 |
|----|------|
| `isEditing` / `pendingCleanupIds` / `viewSwitchToken` 等非回调状态字段 | 不属回调范畴，保持现状（本轮只重构回调管理机制，夹带状态迁移违反单一改动原则） |
| 子渲染器组件回调（`onReloadInsights` / `onReloadHealth` / `onResetCompletionStats` / `onPartnerMemoryClick`） | 已由各 Component 自管理（`insights.onReloadInsights(cb)`），非本面板回调地狱的一部分 |
| `onMemoryRecallClick`（renderer.ts / uiDelegations personaThemeDelegations） | 属 perception 面板回调，不在 MemoryPanelEventMap 范围 |
| 内核 `agent.on('memoryAdded')`（spriteLifecycleManager） | 内核 AgentEventMap 事件，与面板回调无关，不合并 |

## 二、目标设计

### 2.1 EventMap 接口（签名单一真理源）

新建 `src/electron/renderer/panels/memoryPanelEventMap.ts`（与 memoryPanelManager 同层，随面板演进）：

```typescript
/**
 * 记忆面板事件映射 — 回调签名单一真理源
 *
 * 事件名统一 kebab-case（与 DOM data-action 命名风格一致）。
 * 每个事件对应一个回调签名；onXxx() 注册方法 / EventBus 存储 / helper 触发
 * 均从此映射推导类型，禁止在别处手写重复签名。
 */
export interface MemoryPanelEventMap {
  /** 搜索记忆（防抖后触发，query 为空表示清除搜索） */
  'memory-search': (query: string) => void;
  /** 来源筛选（空字符串表示全部来源） */
  'memory-filter': (source: string) => void;
  /** 记忆项点击（列表/图谱/详情内关联项/脉络节点共用） */
  'memory-click': (id: string) => void;
  /** 删除当前记忆 */
  'memory-delete': () => void;
  /** 添加记忆（表单校验通过后） */
  'memory-add': (data: { source: string; name: string; content: string }) => void;
  /** 编辑记忆内容（保存按钮 / Ctrl+Enter） */
  'memory-edit': (id: string, content: string) => void;
  /** 讨论记忆（切换到对话面板预填） */
  'memory-discuss': (memoryName: string) => void;
  /** 更多菜单项点击（insights/health/completion-stats/recycle-bin/partner-insights） */
  'more-menu-action': (action: string) => void;
  /** 排序方式变更 */
  'sort-change': () => void;
  /** 时间范围变更 */
  'time-range-change': () => void;
  /** 清理请求（返回待清理 ID 列表；未注册返回 undefined，调用方 ?? [] 兜底） */
  'cleanup-request': (type: 'duplicates' | 'stale' | 'all') => string[];
  /** 清理确认（执行批量删除） */
  'cleanup-confirm': (ids: string[]) => Promise<void>;
  /** LLM 记忆治理（dedup/timeliness/conflicts） */
  'llm-governance': (action: 'dedup' | 'timeliness' | 'conflicts') => Promise<void>;
  /** 视图切换（通知 Controller 同步按钮 active 状态） */
  'view-switch': (mode: 'list' | 'timeline' | 'graph') => void;
  /** 图谱上下文菜单操作 */
  'graph-context-menu': (action: string, nodeId: string) => void;
  /** 关系编辑 */
  'relation-edit': (sourceId: string, targetId: string, type: string, weight: number) => void;
  /** 关系删除 */
  'relation-delete': (sourceId: string, targetId: string, type: string) => void;
  /** 关系创建 */
  'relation-create': (sourceId: string, targetId: string, type: string, weight: number) => void;
  /** 回收站单项操作（restore/purge） */
  'recycle-bin-action': (action: 'restore' | 'purge', id: string) => Promise<void>;
  /** 回收站批量操作（restore-all/purge-all） */
  'recycle-bin-batch-action': (action: 'restore-all' | 'purge-all') => Promise<void>;
}
```

### 2.2 EventBus 类（泛型基础设施）

新建 `src/electron/renderer/helpers/typedEventBus.ts`（渲染进程通用基础设施，与 eventTracker.ts 同级）：

```typescript
/**
 * 类型化事件总线 — 面板回调的统一存储与分发
 *
 * 语义说明（对抗式审查结论）：
 * - **单订阅（覆盖）语义**：on() 重复注册同一事件会覆盖前者，等价于旧
 *   onXxx() 赋值行为（测试 memoryPanelManagerInstance.test.ts:770「多次注册
 *   onMemoryDiscuss 应覆盖前者」锁定此语义）。**不是** Node EventEmitter 的
 *   多订阅语义——引入多订阅会破坏既有行为契约。
 * - **emit 支持返回值透传**：回调返回非 void 时（如 cleanup-request 返回
 *   string[]），emit 原样返回；未注册时返回 undefined（调用方用 ?? 兜底）。
 *
 * 设计边界（复杂度守恒，YAGNI）：
 * - 不做 once / wildcard / 异步队列 / 错误隔离——当前面板无此需求，
 *   出现真实需求再按 ADR-017 Scenario A 扩展。
 */
export type AnyListener = (...args: never[]) => unknown;

export class TypedEventBus<TEventMap extends Record<string, AnyListener>> {
  /** 事件 → 回调（单订阅：Map.set 天然覆盖） */
  private handlers = new Map<keyof TEventMap, TEventMap[keyof TEventMap]>();

  /** 注册回调（覆盖旧值，等价于旧 onXxx 赋值语义） */
  on<K extends keyof TEventMap>(event: K, cb: TEventMap[K]): void {
    this.handlers.set(event, cb);
  }

  /** 移除回调（新增能力：现有代码无 off 用法，cleanup 场景用 clear） */
  off<K extends keyof TEventMap>(event: K): void {
    this.handlers.delete(event);
  }

  /** 触发回调，透传返回值；未注册返回 undefined */
  emit<K extends keyof TEventMap>(
    event: K,
    ...args: Parameters<TEventMap[K]>
  ): ReturnType<TEventMap[K]> | undefined {
    const handler = this.handlers.get(event) as TEventMap[K] | undefined;
    return handler?.(...args);
  }

  /** 是否已注册 */
  has<K extends keyof TEventMap>(event: K): boolean {
    return this.handlers.has(event);
  }

  /** 清空全部回调（cleanup() 时调用，对齐 ADR-SP-015 §2「清空回调引用」） */
  clear(): void {
    this.handlers.clear();
  }
}
```

**泛型约束说明**：`Record<string, AnyListener>` 中 `AnyListener = (...args: never[]) => unknown` 是 TS 社区标准技巧——`never[]` 参数在**函数赋值逆变**下与任意具体签名兼容（`(query: string) => void` 可赋给 `(...args: never[]) => unknown`），同时 `K extends keyof` 索引后 `TEventMap[K]` 恢复精确签名，`Parameters`/`ReturnType` 推导不受损。**避免在约束中使用 `Function`/`any`**（对齐 project-rules §7.1 禁 `as any` 精神；唯一的 `as TEventMap[K] | undefined` 断言是 Map.get 返回联合类型的必要类型适配，符合 AUDIT-TRIG-2 判定）。

### 2.3 与现有模式的对比表

| 维度 | 现状（callback \| null 模式） | 目标（EventMap/EventBus） |
|------|------------------------------|--------------------------|
| 签名真理源 | 3 份手写（字段/onXxx/getter） | 1 份（MemoryPanelEventMap） |
| 存储 | 20 个字段 | 1 个 `Map`（bus 私有） |
| 注册 | 20 个 onXxx 赋值方法 | 20 个 onXxx 薄委托 → `bus.on` |
| 读取 | 22 个 getter 定义 + 33 处消费 | `bus.emit(event, ...args)` 直呼 |
| 时序问题 | getter 动态读取（onXxx 晚于 init） | emit 时查 Map，天然无时序问题 |
| 清理 | cleanup 无需处理（引用随字段销毁） | cleanup() 需 `bus.clear()` |
| 测试 mock | 每个测试 mock N 个 getter 函数 | mock 1 个 bus（`emit: vi.fn()`）或传真实 bus |
| 新增回调成本 | 改 3+ 处签名 + N 处 getter 定义/消费 | 改 1 处 EventMap + 1 处 onXxx 委托 + N 处 emit 调用（tsc 强制同步） |

### 2.4 与 helper context 的集成方式（核心决策）

**决策：context 新增 `bus` 字段，删除全部回调 getter**。

```typescript
// helpers/memoryPanelEvents.ts — MemoryPanelEventContext 接口变更
export interface MemoryPanelEventContext {
  // ...DOM 元素 / events / host / 状态访问器 / 实例方法引用（不变）
  // ─── 回调（统一经 EventBus，删除原 15 个 getXxxCallback getter） ───
  /** 记忆面板事件总线（事件名→回调签名见 MemoryPanelEventMap） */
  readonly bus: TypedEventBus<MemoryPanelEventMap>;
}
```

helper 消费点改写模式（3 种形态全覆盖）：

```typescript
// 形态 1：void 返回（memoryPanelEvents.ts:279 等 ~26 处）
// 旧：ctx.getMemorySearchCallback()?.(searchEl.value.trim());
// 新：
ctx.bus.emit('memory-search', searchEl.value.trim());

// 形态 2：非 void 同步返回（cleanup-request，3 处）
// 旧：const ids = ctx.getCleanupRequestCallback()?.('duplicates') ?? [];
// 新：
const ids = ctx.bus.emit('cleanup-request', 'duplicates') ?? [];

// 形态 3：Promise 返回（await，4 处）
// 旧：await ctx.getCleanupConfirmCallback()?.(ids);
// 新：
await ctx.bus.emit('cleanup-confirm', ids);
```

**对抗式审查：为什么传 bus 实例而非窄包装？**

| 备选方案 | 结论 |
|---------|------|
| A：context 暴露 `emitMemorySearch(q)` 窄包装 | ❌ 仍是 20 个模板方法，只把 getter 换成 emit 包装，模板代码未消除 |
| B：直接传 MemoryPanelManager 实例 | ❌ 破坏 context 接口隔离设计（helper 依赖具体类，重建 helpers→panels 循环依赖） |
| C：保留 getter 内部委托 `bus.get()` | ❌ getter 模板仍在，只解决存储不解决签名复制，半吊子 |
| **D：传 `bus: TypedEventBus<MemoryPanelEventMap>`** | ✅ 收窄为单一引用 + 类型安全；bus 是 helpers/ 同层通用基础设施，helper 依赖它不构成层级越权；测试只需 mock 1 个对象 |

**manager 侧改动**（4 个 context builder 统一模式）：

```typescript
// memoryPanelManager.ts
private bus = new TypedEventBus<MemoryPanelEventMap>();

private buildGraphPanelContext(): MemoryGraphPanelContext {
  return {
    host: this.host,
    bus: this.bus,                    // 替代原 5 个 getter（memory-click 等）
    getGraphRenderer: () => this.graphRenderer,
    // ...其余状态 getter/setter 不变
  };
}
```

### 2.5 向后兼容层（onXxx 保留）

20 个 onXxx() 方法**全部保留**，改为薄委托（外部调用方零改动）：

```typescript
// memoryPanelManager.ts — 回调注册区（原 1059-1139 行，逐方法改写）
/** 注册记忆搜索回调 */
onMemorySearch(cb: (query: string) => void): void {
  this.bus.on('memory-search', cb);
}
// ...其余 19 个同构（onXxx → bus.on(kebab-event, cb)）
```

**契约链验证**（三层零改动）：

| 层 | 现状 | 迁移后 |
|----|------|--------|
| `memoryDelegations.ts`（UIManager mixin 委托群，20 个转发方法） | `onXxx(cb) → memoryPanel.onXxx(cb)` | **零改动** |
| `memoryOrchestrator.ts`（19 处 `uiManager.onXxx(...)` 注册） | — | **零改动** |
| `renderer.ts`（`uiManager.onMemoryDiscuss(...)`） | — | **零改动** |

### 2.6 生命周期

```typescript
cleanup(): void {
  // ...原有清理（searchTimer / graphRenderer / 子组件 / events）
  this.bus.clear();  // 新增：清空回调引用（对齐 ADR-SP-015 §2）
  this.events.cleanup();
}
```

## 三、改动文件清单

### 3.1 生产代码

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `src/electron/renderer/helpers/typedEventBus.ts` | **新增** | TypedEventBus 泛型类（~50 行） |
| `src/electron/renderer/panels/memoryPanelEventMap.ts` | **新增** | MemoryPanelEventMap 接口（~45 行） |
| `src/electron/renderer/panels/memoryPanelManager.ts` | 修改 | ① 删 20 回调字段（137-177 中回调部分）② 新增 `bus` 字段 ③ 20 个 onXxx 改薄委托 ④ `saveEdit` 直用改 `bus.emit('memory-edit', ...)` ⑤ 4 个 context builder 删 22 个 getter 定义 + 加 `bus` ⑥ `cleanup()` 加 `bus.clear()` |
| `src/electron/renderer/helpers/memoryPanelEvents.ts` | 修改 | 接口删 15 个 getter 声明 + 加 `bus` 字段；21 处消费改 `bus.emit` |
| `src/electron/renderer/panels/memoryGraphPanel.ts` | 修改 | 接口删 5 个 getter 声明 + 加 `bus` 字段；5 处消费改 `bus.emit` |
| `src/electron/renderer/helpers/memoryDetailPanel.ts` | 修改 | 接口删 1 个 getter 声明 + 加 `bus` 字段；3 处消费改 `bus.emit` |
| `src/electron/renderer/helpers/memoryViewSwitcher.ts` | 修改 | 接口删 1 个 getter 声明 + 加 `bus` 字段；2 处消费改 `bus.emit` |
| `src/electron/renderer/helpers/ui-delegations/memoryDelegations.ts` | **零改动** | 对外契约不变（验证：接口签名与 20 个 onXxx 逐一对应） |
| `src/electron/renderer/orchestrators/memoryOrchestrator.ts` | **零改动** | 19 处 onXxx 注册不变 |
| `src/electron/renderer/renderer.ts` | **零改动** | onMemoryDiscuss 调用不变 |

### 3.2 测试代码

| 文件 | 变更 | 工作量 |
|------|------|--------|
| `src/__tests__/electron/renderer/typedEventBus.test.ts` | **新增**：单订阅覆盖语义 / 返回值透传 / 未注册 undefined / off / clear / 类型安全 | 中 |
| `src/__tests__/electron/renderer/memoryPanelEvents.test.ts` | mock ctx 中 14 个 getter（169-206）→ 替换为真实 TypedEventBus + spy；~20 处断言从 `callbacks.xxx` 改 `bus.emit` 捕获 | **最大**（可简化：真实 bus 免去 callbacks 对象） |
| `src/__tests__/electron/renderer/memoryGraphPanel.test.ts` | context mock 的 getter → bus | 中 |
| `src/__tests__/electron/renderer/memoryPanelManagerInstance.test.ts` | **不变**（onXxx 兼容层保证注册断言与"覆盖前者"测试原样通过） | 低（仅回归） |
| `src/__tests__/electron/renderer/memoryPanelManagerViews.test.ts` | **不变**（onMemoryClick/onMemoryEdit 注册断言走兼容层） | 低（仅回归） |
| `src/__tests__/electron/renderer/memoryOrchestrator.test.ts` | **不变**（mock 20 个 onXxx 仍有效） | 低（仅回归） |
| `src/__tests__/electron/renderer/uiDelegations.test.ts` | **不变**（透传断言） | 低（仅回归） |
| `src/__tests__/electron/renderer/ui.test.ts` | **不变**（onMemorySearch/onMemoryAdd 门面断言） | 低（仅回归） |

## 四、不提取的归档

| 项 | 理由 |
|----|------|
| SettingsPanelManager 的 host 接口回调（`onSettingsTabSwitch?` / `onProviderChanged?`） | AUDIT-H5 已落地的**模式 A（Host 接口注入）**是"宿主能力注入"语义，与 MemoryPanel 的"面板业务回调"语义不同；本方案只重构 MemoryPanel，不强改 Settings 形态（触发条件：Settings 面板出现第 5+ 个回调字段再评估） |
| 子渲染器组件回调（onReloadInsights 等 4 个） | 已由 Component 自管理，非本面板回调 |
| 多订阅（addListener）能力 | 现有测试锁定单订阅覆盖语义；多订阅是行为变更，无真实需求（YAGNI） |
| `once` / `wildcard` / 异步队列 | 无真实需求（YAGNI），出现需求按 ADR-017 Scenario A 扩展 |
| 内核 AgentEventMap / sprite 层 TriggerBus | 属另一层的事件体系，与本面板回调无重叠 |

## 五、后续演进路径

```
阶段 1（本轮）：MemoryPanel 20 回调 → EventMap/EventBus
  └─ 消除 20 字段 + 22 getter；签名收敛为单一真理源；对外 API 零改动
阶段 2（触发式）：onXxx 兼容层评估
  └─ 若新开发者反复问"为什么有 onMemorySearch 又要 on('memory-search')"，
     或新增回调时开始手写 onXxx 而非 bus.on → 评估直接暴露 on()/emit()
     公开方法（breaking change，走 deprecation 周期，对齐编程哲学 §5 契约与边界）
阶段 3（触发式）：跨面板推广
  └─ 当第 2 个面板出现 ≥8 回调字段（阈值驱动）→ 复用 TypedEventBus；
     memoryClick 事件双面板消费（memory + perception）可评估 bus 共享或保留各自独立
```

**阶段划分原则**：本轮只做 MemoryPanel 重构（渐进式，单域一轮）；TypedEventBus 作为泛型基础设施一次到位（避免二次重复实现），但**不主动迁移**其他面板（YAGNI，阈值触发再迁移）。

## 六、验证计划

| 验证项 | 方法 | 预期 |
|--------|------|------|
| 类型检查 | `tsc --noEmit` | 0 错误（EventMap 单一真理源会强制所有 emit/on 消费点类型同步） |
| Lint | `eslint` + `lint:css` | 0 新增告警 |
| 全量测试 | `vitest run` | 全量通过（既有 2390 测试基线，不新增失败用例） |
| 兼容层回归 | memoryPanelManagerInstance.test.ts / ui.test.ts / uiDelegations.test.ts / memoryOrchestrator.test.ts | onXxx 注册断言原样通过，证明外部契约零破坏 |
| 语义回归 | memoryPanelEvents.test.ts（改造后） | getter 消费断言与 emit 消费断言行为一致 |
| 新能力验证 | typedEventBus.test.ts | 单订阅覆盖 / 返回值透传 / 未注册 undefined |
| 集成冒烟 | `npm run start:electron` | 搜索/筛选/点击/删除/清理/回收站/图谱操作功能正常 |

## 七、实施完成（2026-08-01 提交后补写）

- **验证结果**：`tsc --noEmit` 0 错误；eslint 0 告警（10 个改动文件）；改造相关测试文件 111 用例全过（memoryPanelEvents 66 / memoryGraphPanel 36 / typedEventBus 新增 9）。**全量 vitest 存在既有 jsdom flake**：`SVGPolygonElement is not defined`（`perceptionAffectComponent.ts:57`，jsdom 环境缺 SVG 类）导致未改动的 perceptionPanelManager.test.ts（52 用例）与 ui.test.ts（87 用例）等文件失败；三次全量运行失败数波动（176/175/0）属环境性，**与本次改动零交集**（失败文件均未在本轮改动范围）。
- **实际修改文件清单**：
  - 新增 `helpers/typedEventBus.ts`（62 行）+ `panels/memoryPanelEventMap.ts`（71 行）+ `__tests__/electron/renderer/typedEventBus.test.ts`（9 用例）
  - 修改 `panels/memoryPanelManager.ts`（1507 → 1454 行，-53 行；删 20 字段 + 22 getter 定义，onXxx 20 个保留为薄委托，4 个 context builder 改 bus，cleanup 加 bus.clear）
  - 修改 `helpers/memoryPanelEvents.ts`（接口 15 getter → bus；21 处消费 → emit；4 处注释同步）
  - 修改 `panels/memoryGraphPanel.ts`（接口 5 getter → bus；5 处消费 → emit）
  - 修改 `helpers/memoryDetailPanel.ts`（接口 1 getter → bus；3 处消费 → emit）
  - 修改 `helpers/memoryViewSwitcher.ts`（接口 1 getter → bus；2 处消费 → emit）
  - 修改 `__tests__/electron/renderer/memoryPanelEvents.test.ts`（mock ctx 14 getter → 真实 bus 预注册 15 回调，断言零改动；顺带补 llmGovernance 历史缺漏字段）
  - 修改 `__tests__/electron/renderer/memoryGraphPanel.test.ts`（createCtx 5 getter → bus；4 处动态覆盖 → bus.on）
  - **零改动**：memoryDelegations.ts / memoryOrchestrator.ts / renderer.ts（外部契约三层验证通过）
- **排雷记录（实施前 grep 实测）**：
  - R1：`tsconfig.json` exclude `src/__tests__` → 测试类型错误不受 tsc 保护，靠 vitest 运行时暴露（bus 漏加会崩 `ctx.bus` undefined）
  - R2：memoryGraphPanel.test.ts 用「mock 函数 + 动态覆盖」双模式（`ctx.getRelationEditCallback = () => cb` ×4）→ 已改 bus.on
  - R3：memoryPanelEvents.test.ts 旧 mock 缺 getLlmGovernanceCallback（历史遗漏，llmGovernance 零测试覆盖）→ 已补
  - R4：生产 getter 消费实为 32 处（events 21 + graph 5 + detail 3 + viewSwitcher 2 + saveEdit 1），方案 §1.3 写 33 处为笔误
  - R5：partnerInsightsComponent / perceptionPanelManager 的 onMemoryClick 是独立回调，确认排除
  - R6：`await bus.emit('llm-governance')`（Promise<void>|undefined）与 `bus.emit('cleanup-request') ?? []` 语义兼容已验证
  - R7：泛型约束 `Record<string, (...args: never[]) => unknown>` 与具体签名赋值兼容，tsc 实测通过
- **额外修复**：替换中一处注释乱码（「���册」→「注册」）；memoryPanelEvents.ts 4 处旧 getter 注释同步为 emit 描述。
- **后续演进**：阶段 2（onXxx 兼容层是否收敛 on()/emit() 公开方法）与阶段 3（跨面板推广 TypedEventBus）保持触发式，见 §五。

---

## 附录 A：迁移成本量化

### A.1 生产代码模板量（现状）

| 项目 | 数量 | 位置 |
|------|------|------|
| 回调字段声明 | 20 处（~40 行） | memoryPanelManager.ts:137-177 |
| onXxx 注册方法 | 20 处（~80 行） | memoryPanelManager.ts:1059-1139 |
| context getter 定义 | 22 处（~30 行） | initMemoryPanelListeners ctx 15 + viewSwitcher 1 + graphPanel 5 + detailPanel 1 |
| context getter 接口声明 | 22 处（~25 行） | 4 个 context 接口 |
| helper getter 消费 | 33 处 | events 21 + graph 5 + detail 3 + viewSwitcher 2 + saveEdit 1 |

### A.2 重构后

| 项目 | 数量 |
|------|------|
| EventMap 签名定义 | 20 处（**单一真理源**） |
| bus.on 委托（onXxx 保留） | 20 处薄方法 |
| context 加 bus 字段 | 4 处 |
| helper emit 消费 | 33 处（改写，数量不变但模板删除） |
| **净减（memoryPanelManager.ts）** | **~77 行**（1507 → ~1430） |

### A.3 外部契约影响面

| 层 | 文件数 | 改动 |
|----|--------|------|
| 生产（orchestrator / renderer / memoryDelegations / 其他 panels） | 0 个需改 | 零改动 |
| 测试（instance / views / orchestrator / ui / uiDelegations） | 0 个需改（仅回归） | 零改动 |
| 测试（events / graphPanel 的 context mock） | 2 个需改 | getter → bus |
| 新增测试 | 2 个 | typedEventBus + 已有文件改造 |

## 附录 B：对抗式审查记录

| # | 质疑 | 结论 |
|---|------|------|
| B1 | "EventBus 会不会引入过度抽象？20 字段换成 Map 只是把模板挪了位置" | 反驳：核心收益不是"少写行数"，而是**签名单一真理源**——3 份手写签名收敛为 1 份，tsc 强制类型同步；新增回调从"改 3+ 处"降为"改 1 处 + 消费点"。行数净减 ~77 行是附带收益 |
| B2 | "标准 EventEmitter 语义更通用，为什么做单订阅？" | 现有测试锁定覆盖语义（instance:770），换多订阅是**行为变更**，违反向后兼容目标。单订阅是既有契约，不是简化妥协 |
| B3 | "bus 传进 4 个 context 是否违反接口隔离？" | bus 是 helpers/ 同层基础设施（与 eventTracker 同级），helper 依赖它不构成层级越权（sprite-project-rules §4.1 只禁 components 反向依赖 panels/controllers）；收窄为单一引用优于 22 个散落 getter |
| B4 | "返回值透传的 `as` 断言是否违反禁 `as any` 规则？" | 是必要类型适配（Map.get 返回联合类型），符合 AUDIT-TRIG-2 判定（生产 17 处 as 均为必要适配）；且断言目标是精确的 `TEventMap[K]`，非 `any` |
| B5 | "cleanup-request 未注册时 emit 返回 undefined，`?? []` 兜底语义是否有变化？" | 无变化：旧 `ctx.getCleanupRequestCallback()?.('duplicates') ?? []` 与新 `ctx.bus.emit('cleanup-request', 'duplicates') ?? []` 行为完全一致（未注册均走空数组分支） |
| B6 | "AUDIT-H5 在待完成任务.md 标'未启动'，但代码已拆 Component？" | 属实：settingsPanelManager.ts 头注释与 components/form/ 下 3 个 Component 证明 AUDIT-H5 已实施；`tasks/待完成任务.md` 状态未同步。本方案基于**用户确认（AUDIT-H5 已完成）**设计；建议实施阶段顺手更新任务文档状态（README §1.2） |
| B7 | "spriteLifecycleManager.ts 也匹配了 onMemory*，是否在影响面内？" | 排除：其匹配项是内核 `agent.on('memoryAdded')`（AgentEventMap 事件），与面板回调无关 |
