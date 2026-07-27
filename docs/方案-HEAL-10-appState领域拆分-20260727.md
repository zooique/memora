# HEAL-10 appState 领域拆分方案

> 来源：神木回天 P1 归档任务。`main.ts` 的 `appState` 单一对象混装 6 个领域 23 个字段，违反单一职责原则。
> 日期：2026-07-27

## 一、现状分析

### 1.1 appState 字段分布（23 个字段，6 个领域）

| 领域 | 字段 | 初始化时机 |
|------|------|-----------|
| **窗口/托盘基础设施** | windowStateManager / windowManager / interaction / trayManager | 阶段 1 |
| **Agent 运行时** | agent / sprite / sessionStore / closeSprite | setAppRuntime 集中赋值 |
| **流式控制** | currentAbortController | 运行时可变 |
| **功能模块** | pendingWriteConfirmations / auditManager / usageStatsCollector / shortcutManager / clipboardHandler / quickInputWindow | setupAgentReady / 阶段 1 / setupAgentIndependentResources |
| **LLM 配置缓存** | lastProvider / lastModel / lastBaseUrl / lastApiKey | reinitAgent 时更新 |
| **应用级状态** | agentReady / initErrorDetail / ipcRegistered / currentDataDir / unreadCount / isQuitting | 运行时可变 |

### 1.2 耦合关系分析

- **MinimalIpcState 接口约束**：`minimalHandlers.ts` 通过结构子类型直接访问 appState 的 12 个字段，任何拆分需保持接口兼容
- **setAppRuntime 已是 AgentRuntime 雏形**：4 字段（agent/sprite/sessionStore/closeSprite）总是一起变化，已有集中赋值函数
- **interaction 实为 IPC 适配层**：仅向渲染进程发送系统消息，不是窗口领域，与 windowManager 松耦合（仅注入 mainWindow 引用）
- **windowStateManager/windowManager/trayManager/interaction/shortcutManager 在 main.ts 出现 58 次**，提取 WindowService 改动面大

## 二、原方案合理性评审

### 原方案（HEAL-10 描述）

> 需按领域拆 WindowService / AgentRuntime / ClipboardQuickInputService / ShortcutService

### 合理性评估

| Service | 评估 | 结论 |
|---------|------|------|
| AgentRuntime | setAppRuntime 已是雏形，4 字段总是一起变化 | ✅ 本轮提取 |
| WindowService | 4 字段紧密协作，但 58 处引用改动面大 | ⏸️ 归档下一轮 |
| ClipboardQuickInputService | setupAgentIndependentResources 可整体迁出，但回调依赖 windowManager + agent | ⏸️ 归档下一轮 |
| ShortcutService | 单一字段，不达"3 次以上才提取"阈值 | ❌ 过度抽象，归入 WindowService |

**核心调整**：ShortcutManager 是单一字段，单独建 Service 违反自然生长原则（ADR-017 §3 次以上才提取）。快捷键主要触发窗口动作（toggleWindow/quickRecord/recallMemory/quickInput），归入 WindowService 更合理。

## 三、本轮方案：提取 AgentRuntime

### 3.1 提取范围

| 迁入 AgentRuntime 的字段 | 理由 |
|------------------------|------|
| agent | 4 字段总是一起变化，setAppRuntime 已是雏形 |
| sprite | 同上 |
| sessionStore | 同上 |
| closeSprite | 同上 |
| currentAbortController | 流式控制属于 Agent 运行时生命周期 |
| lastProvider | LLM 配置缓存属于 Agent 运行时（reinitAgent 时更新） |
| lastModel | 同上 |
| lastBaseUrl | 同上 |
| lastApiKey | 同上 |

### 3.2 AgentRuntime 类设计

```typescript
/**
 * Agent 运行时状态容器
 *
 * 封装 Agent 实例生命周期相关的 9 个字段：
 * - Agent 实例四元组（agent/sprite/sessionStore/closeSprite）
 * - 流式控制（currentAbortController）
 * - LLM 配置缓存（lastProvider/lastModel/lastBaseUrl/lastApiKey）
 *
 * 设计原则：
 * - 纯状态容器，不持有业务逻辑（业务逻辑仍在 main.ts）
 * - 通过 setRuntime() 集中赋值，替代原 setAppRuntime 函数
 * - 暴露 getter 供 IPC handler 安全访问
 */
export class AgentRuntime {
  agent: Agent | null = null;
  sprite: Sprite | null = null;
  sessionStore: SqliteSessionStore | null = null;
  closeSprite: (() => Promise<void>) | null = null;
  currentAbortController: AbortController | null = null;
  lastProvider: string | null = null;
  lastModel: string | null = null;
  lastBaseUrl: string | null = null;
  lastApiKey: string | null = null;

  /** 集中赋值运行时实例（null 清空所有引用） */
  setRuntime(runtime: AppRuntime | null): void { ... }

  /** 中断进行中的对话 */
  abortCurrentStream(): void { ... }

  /** 清空所有引用（退出时调用） */
  nullify(): void { ... }
}
```

### 3.3 appState 调整后结构

```typescript
const appState = {
  // ─── 领域 Service ───
  agentRuntime: new AgentRuntime(),

  // ─── 窗口/托盘基础设施（阶段 1 初始化，下一轮提取 WindowService） ───
  windowStateManager: null! as WindowStateManager,
  windowManager: null! as WindowManager,
  interaction: null! as ElectronInteraction,
  trayManager: null as TrayManager | null,

  // ─── 功能模块（下一轮提取 ClipboardQuickInputService） ───
  pendingWriteConfirmations: new Map<string, (confirmed: boolean) => void>(),
  auditManager: null as AuditManager | null,
  usageStatsCollector: null as UsageStatsCollector | null,
  shortcutManager: null as ShortcutManager | null,
  clipboardHandler: null as ClipboardHandler | null,
  quickInputWindow: null as QuickInputWindow | null,

  // ─── 应用级状态（跨领域共享，保留 appState） ───
  agentReady: false as boolean,
  initErrorDetail: null as string | null,
  ipcRegistered: false as boolean,
  currentDataDir: DEFAULT_DATA_DIR as string,
  unreadCount: 0 as number,
  isQuitting: false as boolean,
};
```

### 3.4 MinimalIpcState 接口兼容性

**问题**：`minimalHandlers.ts` 通过 `state.lastProvider` / `state.currentAbortController` / `state.closeSprite` 等直接访问。

**方案**：修改 MinimalIpcState 接口，访问路径改为 `state.agentRuntime.lastProvider` 等。

```typescript
// ipc/types.ts 修改前
interface MinimalIpcState {
  currentAbortController: AbortController | null;
  lastProvider: string | null;
  // ...
}

// ipc/types.ts 修改后
interface MinimalIpcState {
  agentRuntime: AgentRuntime;  // 替代 9 个分散字段
  // ...
}
```

`minimalHandlers.ts` 中所有 `state.lastProvider` → `state.agentRuntime.lastProvider`，`state.currentAbortController` → `state.agentRuntime.currentAbortController`，等等。

### 3.5 改动文件清单

| 文件 | 变更类型 |
|------|---------|
| `electron/runtime/agentRuntime.ts` | **新建**：AgentRuntime 类 |
| `electron/main.ts` | 提取 9 字段到 agentRuntime，setAppRuntime 改为 agentRuntime.setRuntime |
| `electron/ipc/types.ts` | MinimalIpcState 接口调整 |
| `electron/ipc/minimalHandlers.ts` | state.xxx → state.agentRuntime.xxx |
| `electron/ipc/handlers.ts` | IpcContext getter 调整（如需） |
| `electron/errorHandler.ts` | （如需）错误处理引用调整 |

## 四、不提取的归档

### 4.1 WindowService（下一轮自然生长触发）

**理由**：
- 58 处引用改动面大，本轮同时提取风险高
- 待 AgentRuntime 验证集成模式成功后，下一轮涉足窗口模块时顺势提取
- ShortcutManager 归入 WindowService（快捷键主要触发窗口动作）

### 4.2 ClipboardQuickInputService（下一轮自然生长触发）

**理由**：
- setupAgentIndependentResources 回调依赖 windowManager + agent + sprite，提取需仔细处理跨领域依赖
- 本轮先验证 AgentRuntime 集成模式，降低并行修改风险

## 五、验证计划

1. **类型检查**：`tsc --noEmit` 通过
2. **全量测试**：4631/4631 通过（含 minimalHandlers 35 测试 + errorHandler 35 测试）
3. **dev:electron 启动验证**：编译 0 错误 + IPC 校验通过 + 精灵正常启动退出 code=0
4. **集成模式验证点**：
   - reinitAgent 路径（LLM_CONFIG_SAVE / LLM_PROVIDER_SAVE）正确更新 agentRuntime
   - before-quit 清理路径正确 nullify agentRuntime
   - minimalHandlers 通过 agentRuntime 访问字段正常工作

## 六、后续演进路径

```
本轮：AgentRuntime 提取（验证集成模式）
  ↓
下一轮：WindowService 提取（含 ShortcutManager）
  ↓
下一轮：ClipboardQuickInputService 提取
  ↓
appState 仅保留应用级状态（~7 字段）
```

## 七、实施完成（2026-07-27）

### 7.1 改动文件清单（实际）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `electron/runtime/agentRuntime.ts` | **新建** | AgentRuntime 类（9 字段 + setRuntime + nullify） |
| `electron/main.ts` | 修改 | appState.agentRuntime 替代 9 字段；setAppRuntime 委托 setRuntime；删除未使用的 SqliteSessionStore 导入 |
| `electron/ipc/types.ts` | 修改 | MinimalIpcState.agentRuntime 字段替代 9 个分散字段 |
| `electron/ipc/minimalHandlers.ts` | 修改 | state.xxx → state.agentRuntime.xxx（reinitAgentRuntime 内） |
| `src/__tests__/electron/ipc/minimalHandlers.test.ts` | 修改 | createState 改用 new AgentRuntime()；新增 createRuntime 辅助函数处理内部字段覆盖 |

### 7.2 与方案设计的偏差

- 方案 3.2 设计了 `abortCurrentStream()` 方法，实际实现中**未提取**：仅 2 处调用（main.ts before-quit + minimalHandlers reinit），提取收益低于 3 次阈值，遵循自然生长原则。
- 方案 3.5 列出 `handlers.ts` / `errorHandler.ts` 可能改动：实际未改动，IpcContext getter 在 main.ts 内部已用 `appState.agentRuntime.agent`，handlers.ts 通过 getter 透明访问。

### 7.3 验证结果

| 验证项 | 结果 |
|--------|------|
| `npm run typecheck` | ✅ 0 错误 |
| `npm run typecheck:electron` | ✅ 0 错误 |
| `npm run check-ipc` | ✅ 通道一致 |
| `npm run test` | ✅ 138 文件 / 4631 测试全通过 |

### 7.4 待完成任务清单迁移

- HEAL-10 标记为已完成，迁入 `tasks/已完成任务.md`
- 后续演进路径（WindowService / ClipboardQuickInputService）作为新的待完成任务归档
