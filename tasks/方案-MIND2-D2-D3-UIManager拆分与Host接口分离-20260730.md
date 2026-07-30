# MIND2-D2 + MIND2-D3 UIManager 拆分与 Host 接口分离方案

> 同轮处理：D2（UIManager 上帝类）+ D3（ChatPanelHost 接口隔离违反）互为因果。
> 遵循 `.trae/rules/progressive-refactor-rules.md`：方案设计先行 + 单轮一个领域 + 炼化归元收尾。

## 一、现状分析

### 1.1 演进路径

```
HEAL-11 (2026-06)  UIManager 上帝类第一步：mixin 委托模式（ADR-SP-015）
   ↓
HEAL-12 (2026-07)  PanelRouter 职责拆分（模式 B）：4 个并列 Controller
   ↓
HEAL-16 (2026-07)  领域容器提取（模式 A）：4 个 Coordinator（chat/memory/settings/perception）
   ↓
HEAL-13 (2026-07)  mixin 委托模式归档（ADR-SP-016，判定不修，6 委托群 ~298 方法零名冲突）
   ↓
MIND2-D5 (2026-07) 跨面板 DOM 耦合消除（pulseNavButton/setMemorySection 委托）
   ↓
本轮 MIND2-D2+D3  接口分离 + 字段容器提取（D3 核心 + D2 辅助）
```

### 1.2 调研结论：需要拆分（接口契约爆炸，非字段内聚度问题）

**UIManager 真正的"上帝"特征不在字段数，而在 `implements 8 个 Host 接口`**：

| 维度 | 当前状态 | 阈值 | 判定 |
|------|---------|------|------|
| 字段数 | 31（含 4 private 回调 = 35） | ≥ 15 | ✅ 超阈值，但 HEAL-16 已收敛 14 字段为 4 Coordinator |
| 职责数 | 8 个 Host 接口 | ≥ 5 | ✅ 超阈值，接口契约爆炸 |
| 修改成本 | ChatPanelHost 18 方法混杂 | ≥ 10 处无关代码 | ✅ 超阈值 |

**关键洞察**：
1. 字段已通过 HEAL-16 收敛（4 个 Coordinator 替代 14 个紧密耦合字段），剩余字段都是独立组件，无内聚可再提取（除核心 DOM 元素）
2. 真正的"上帝"是 **接口契约爆炸**：`showConfirmDialog` 被 7 个 Host 接口要求、`showToast` 被 6 个、`getState` 被 3 个
3. ChatPanelHost 18 方法中 `updateBadge` 是**死契约**（零调用方，仅 UIManager 内部 updateUnreadCount 调用 this.updateBadge）

### 1.3 本轮提取范围

#### D3 核心：ChatPanelHost 接口分离（4 个窄接口）

将 ChatPanelHost 18 方法按职责拆为 4 个窄接口：

| 窄接口 | 方法数 | 方法列表 | 职责 |
|--------|-------|---------|------|
| `ChatRenderHost` | 7 | showToast / scrollToBottom / forceScrollToBottom / showEmptyState / hideEmptyState / updateUnreadCount / pulseNavButton | 消息渲染 + 反馈 + 跨面板高亮 |
| `ChatStreamControlHost` | 4 | setStreaming / isStreaming / updateSendButton / onStreamStuck | 流式状态机 + 按钮联动 + 兜底通知 |
| `ArchiveOperationHost` | 4 | getArchiveMode / archiveConversation / archiveSession / getCurrentSessionId | 归档模式查询 + 单轮/批量归档 + 会话定位 |
| `ChatDialogHost` | 2 | showConfirmDialog / regenerateLastMessage | 对话框交互（忘记确认 + 重新生成） |

ChatPanelHost 继承 4 个窄接口（向后兼容）：
```typescript
export interface ChatPanelHost extends ChatRenderHost, ChatStreamControlHost, ArchiveOperationHost, ChatDialogHost {}
```

**删除死方法**：`updateBadge`（零调用方，UIManager 内部 updateUnreadCount 直接调用 this.badgeManager.updateBadge）。

#### D3 收窄依赖方接口

ChatPanelManager 的 helpers 实际使用方法远少于 ChatPanelHost 全集：

| 依赖方 | 实际使用方法 | 收窄类型 |
|--------|------------|---------|
| `chatPanelEvents.ts` (ChatPanelEventContext.host) | showToast | `Pick<ChatRenderHost, 'showToast'>` |
| `messageOperations.ts` (MessageOperationContext.host) | isStreaming / showToast / showConfirmDialog / regenerateLastMessage | `Pick<ChatPanelHost, 'isStreaming' \| 'showToast' \| 'showConfirmDialog' \| 'regenerateLastMessage'>` |
| `archiveButtonManager.ts` (ArchiveButtonHost) | getArchiveMode / archiveConversation / showToast | 已独立（保留，复用 ArchiveOperationHost 子集） |

**ChatPanelManager.host 字段保持 ChatPanelHost 完整类型**（实际使用 14 方法 + 通过 helpers 间接使用 4 方法 = 18 方法，除 updateBadge 外全部使用）。

#### D2 辅助：CoreElements 容器提取（模式 A 纯状态容器）

提取 7 个 private DOM 引用为单一容器：

| 字段 | 类型 | 当前归属 | 提取后归属 |
|------|------|---------|-----------|
| messagesEl | HTMLElement | private | coreElements.messagesEl |
| inputEl | HTMLTextAreaElement | private | coreElements.inputEl |
| btnSend | HTMLButtonElement | private | coreElements.btnSend |
| btnStop | HTMLButtonElement | private | coreElements.btnStop |
| badge | HTMLElement \| null | private | coreElements.badge |
| btnMaximize | HTMLButtonElement \| null | private | coreElements.btnMaximize |
| chatAgentStatusEl | HTMLElement \| null | private | coreElements.chatAgentStatusEl |

**字段数**：31 → 25（减 6）。

**安全前提**（已验证）：mixin 委托方法（helpers/ui-delegations/）不访问任何 private 字段——Grep 扫描 6 个委托群文件，零匹配 `this.(messagesEl|inputEl|btnSend|btnStop|badge|btnMaximize|chatAgentStatusEl)`。

### 1.4 不提取的归档

| 字段类别 | 字段数 | 归档理由 |
|---------|-------|---------|
| 4 个 Coordinator | 4 | HEAL-16 已完成提取（chatCoordinator / memoryCoordinator / settingsCoordinator / perceptionCoordinator），不再拆分 |
| 4 个独立组件 | 4 | toastManager / modalManager / onboardingManager / themeManager，独立管理器，无内聚可提取 |
| 14 个面板管理器 | 14 | personaPanel / commandPaletteManager / panelErrorBannerManager / clipboardManager / clipboardPanelManager / dateNavManager / searchMessagesManager / skillDropManager / panelRouter / windowControlsController / auxSidebarManager / globalShortcutDispatcher / badgeManager / scrollController，独立组件，public 字段（mixin 委托访问） |
| state | 1 | UIManager 核心 UI 状态，单字段无内聚 |
| events | 1 | UIManager 事件跟踪器，单字段无内聚 |
| 4 个回调引用 | 4 | sendMessageCallback / stopMessageCallback / panelSwitchCallback / _getCurrentSessionId，内聚度低（发送/停止/面板切换/会话 ID 查询用途各异），按 §5.2 领域驱动分组原则不提取 |

## 二、目标类设计

### 2.1 ChatPanelHost 拆分（D3 核心）

```typescript
// ─── ChatPanelHost 拆分为 4 个窄接口（D3） ───────────────

/**
 * 消息渲染 + 反馈 + 跨面板高亮（ChatPanelHost 子接口）
 *
 * 涵盖：Toast 反馈、滚动控制、空状态切换、未读计数、跨面板导航高亮。
 * 调用方：ChatPanelManager（消息渲染）+ chatPanelEvents（复制反馈）
 */
export interface ChatRenderHost {
  /** 显示 toast 通知 */
  showToast(message: string, type?: ToastType, duration?: number): void;
  /** 自动滚动到底部（用户在底部附近时） */
  scrollToBottom(): void;
  /** 强制滚动到底部（无视用户位置） */
  forceScrollToBottom(): void;
  /** 显示空状态引导（无消息时） */
  showEmptyState(): void;
  /** 隐藏空状态引导（有消息时） */
  hideEmptyState(): void;
  /** 未读计数 +1（完整窗口隐藏时，新精灵消息到达） */
  updateUnreadCount(): void;
  /** 给指定面板导航按钮添加 pulse 高亮（MIND2-D5：消除跨面板 DOM 耦合） */
  pulseNavButton(panel: string): void;
}

/**
 * 流式状态机 + 按钮联动 + 兜底通知（ChatPanelHost 子接口）
 *
 * 涵盖：流式状态封装、按钮可见性切换、超时兜底主进程清理。
 * 调用方：ChatPanelManager（streamRenderCtx）+ StreamSafetyTimer + messageOperations（isStreaming 守卫）
 */
export interface ChatStreamControlHost {
  /** 设置流式输出状态（UIManager 作为 state 唯一持有者，通过 host 方法封装） */
  setStreaming(streaming: boolean): void;
  /** 查询流式输出状态 */
  isStreaming(): boolean;
  /** 更新发送/停止按钮状态 */
  updateSendButton(): void;
  /** 流式输出超时兜底触发时通知宿主联动主进程清理 */
  onStreamStuck(): void;
}

/**
 * 归档操作契约（ChatPanelHost 子接口）
 *
 * 涵盖：归档模式查询、单轮归档（profile + insight）、批量归档、会话 ID 定位。
 * 调用方：ChatPanelManager（showArchiveButton）+ ArchiveButtonManager（getArchiveMode + archiveConversation + showToast）
 *
 * 注意：ArchiveButtonManager 已有独立的 ArchiveButtonHost 接口（3 方法子集），
 *      本接口保留 archiveSession + getCurrentSessionId 供 ChatPanelManager.showArchiveButton 使用。
 */
export interface ArchiveOperationHost {
  /** 查询当前归档模式（manual 模式下显示"归档"按钮） */
  getArchiveMode(): 'full' | 'insights-only' | 'manual';
  /** 手动归档对话（profile facts + insight 一次性触发） */
  archiveConversation(input: string, assistantContent: string): Promise<number>;
  /** 一键归档：批量归档当前会话 */
  archiveSession(date: string, session: string): Promise<number>;
  /** 获取当前会话 ID（格式：YYYY-MM-DD-sessionName） */
  getCurrentSessionId(): string;
}

/**
 * 对话框交互（ChatPanelHost 子接口）
 *
 * 涵盖：忘记操作二次确认、重新生成上一条精灵消息。
 * 调用方：messageOperations（handleForget / handleRegenerate）
 */
export interface ChatDialogHost {
  /** 显示确认对话框（用于"忘记"等需二次确认的操作） */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
  /** 重新生成上一条精灵消息（右键菜单"重新生成"触发） */
  regenerateLastMessage(userMessage: string): void;
}

/**
 * 聊天面板管理器需要的宿主能力（组合接口，向后兼容）
 *
 * MIND2-D3：拆分为 4 个窄接口（ChatRenderHost / ChatStreamControlHost / ArchiveOperationHost / ChatDialogHost），
 * 本接口仅作组合出口，保持现有调用方零改动。
 *
 * 删除死方法：updateBadge（零调用方，UIManager 内部 updateUnreadCount 直接调用 badgeManager）。
 */
export interface ChatPanelHost extends ChatRenderHost, ChatStreamControlHost, ArchiveOperationHost, ChatDialogHost {}
```

### 2.2 CoreElements 容器（D2 辅助）

```typescript
// ─── CoreElements 容器（D2 模式 A 纯状态容器） ───────────
// 位置：hosts/memora-sprite/src/electron/renderer/helpers/coreElements.ts

/**
 * 核心交互元素容器（UIManager 私有 DOM 引用集中管理）
 *
 * MIND2-D2：从 UIManager 提取 7 个 private DOM 字段为单一容器（模式 A 纯状态容器）。
 *
 * 设计原则（progressive-refactor-rules §4）：
 * - 纯状态容器：只持有 DOM 引用，不持有业务逻辑
 * - 业务逻辑保留在 UIManager + mixin 委托方法
 * - 字段语法：`!:` definite assignment（原构造函数赋值）
 *
 * 安全前提：mixin 委托方法（helpers/ui-delegations/）不访问 private 字段，
 *           提取到容器不影响 mixin 委托模式（HEAL-13 红线未触及）。
 *
 * 字段分类：
 * - 必需元素（fast-fail）：messagesEl / inputEl / btnSend / btnStop —— 缺失时抛出
 * - 可选元素（降级）：badge / btnMaximize / chatAgentStatusEl —— 缺失时降级
 */
export class CoreElements {
  // ─── 必需元素（缺失时抛出，UI 无法工作） ────────────────
  /** 消息容器元素 */
  messagesEl!: HTMLElement;
  /** 输入框元素 */
  inputEl!: HTMLTextAreaElement;
  /** 发送按钮 */
  btnSend!: HTMLButtonElement;
  /** 停止生成按钮（流式态时可见） */
  btnStop!: HTMLButtonElement;

  // ─── 可选元素（缺失时降级，不阻塞其他功能） ──────────────
  /** 未读计数徽章（标题栏右上角，部分布局可能未提供） */
  badge: HTMLElement | null = null;
  /** 最大化按钮（标题栏右侧，用于图标切换 □ ↔ ❐） */
  btnMaximize: HTMLButtonElement | null = null;
  /** 聊天面板 Agent 状态指示器（输入区上方） */
  chatAgentStatusEl: HTMLElement | null = null;
}
```

### 2.3 与现有模式的对比

| 维度 | HEAL-16 Coordinator | 本轮 CoreElements | ArchiveButtonHost |
|------|---------------------|------------------|-------------------|
| 模式 | A 纯状态容器 | A 纯状态容器 | 独立 Host 接口 |
| 字段数 | 5/4/3/3 → 1 | 7 → 1 | 3（已独立） |
| 业务逻辑 | ❌ | ❌ | ❌ |
| cleanup | 集中清理子模块 | 无（DOM 引用无需清理） | 空实现 |
| 访问路径 | `this.chatCoordinator.xxx` | `this.coreElements.xxx` | `host.getArchiveMode()` |

## 三、改动文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `panels/chatPanelManager.ts` | 接口拆分 | ChatPanelHost 拆为 4 窄接口 + 删除 updateBadge |
| `helpers/ui-delegations/chatDelegations.ts` | 类型导入 | 无（mixin 不访问 private 字段，零改动） |
| `helpers/chatPanelEvents.ts` | 类型收窄 | ChatPanelEventContext.host: `Pick<ChatRenderHost, 'showToast'>` |
| `helpers/messageOperations.ts` | 类型收窄 | MessageOperationContext.host: `Pick<ChatPanelHost, 'isStreaming' \| 'showToast' \| 'showConfirmDialog' \| 'regenerateLastMessage'>` |
| `helpers/coreElements.ts` | 新建 | CoreElements 容器类（模式 A 纯状态容器） |
| `ui.ts` | 字段提取 | 7 个 private DOM 字段 → `coreElements: CoreElements`；内部访问路径调整；删除 updateBadge（仅 ChatPanelHost 接口要求，UIManager 自身方法保留） |

**预计改动量**：
- 接口定义：~80 行新增（4 窄接口 + 注释）
- ui.ts 内部访问调整：~20 处 `this.xxx` → `this.coreElements.xxx`
- 类型收窄：2 处 helper 的 host 类型
- 新建文件：1 个（coreElements.ts，~40 行）

## 四、不提取的归档

### 4.1 字段归档

| 字段类别 | 字段数 | 归档理由（§5.2 3 次阈值 / §3.2 内聚度判定） |
|---------|-------|---------------------------------------------|
| 4 个 Coordinator | 4 | HEAL-16 已完成提取，不再拆分（避免重复重构） |
| 4 个独立组件 | 4 | toastManager / modalManager / onboardingManager / themeManager，独立管理器，无内聚 |
| 14 个面板管理器 | 14 | public 字段（mixin 委托访问），独立组件，无内聚可提取 |
| state | 1 | UIManager 核心 UI 状态，单字段无内聚 |
| events | 1 | UIManager 事件跟踪器，单字段无内聚 |
| 4 个回调引用 | 4 | sendMessageCallback / stopMessageCallback / panelSwitchCallback / _getCurrentSessionId，内聚度低（发送/停止/面板切换/会话 ID 用途各异），按 §3.2 领域驱动分组不提取 |

### 4.2 接口归档

| 项 | 归档理由 |
|----|---------|
| UIManager 不再 `implements 8 个 Host 接口` | 违反 HEAL-13 红线（mixin 委托模式需要 UIManager 实现 Host 接口以注入到各 Controller）。UIManager 作为门面，implements 多个 Host 接口是必然产物。本轮通过 D3 拆分 ChatPanelHost 减轻接口爆炸，不改变 UIManager implements 声明。 |
| 重复契约提取（如 `ConfirmDialogHost`） | showConfirmDialog 被 7 个 Host 接口要求，但各接口语义不同（删除确认/离开确认/关闭确认/忘记确认）。提取为统一 `ConfirmDialogHost` 会模糊语义，归档不提取。 |
| SettingsPanelHost 加入 implements | SettingsPanelHost 有可选方法（onSettingsTabSwitch? / onProviderChanged?），通过鸭子类型实现。强制 implements 会引入可选方法声明复杂度，归档保持现状。 |

## 五、后续演进路径

```
本轮 MIND2-D2+D3：接口分离 + CoreElements 容器提取
  ↓ 字段数 31 → 25，ChatPanelHost 18 → 4 窄接口
  ↓
观察期：剩余 25 字段有明确归属（4 Coordinator + 4 组件 + 14 面板管理器 + coreElements + state + events）
  ↓
自然生长触发条件：
  - 某个 Coordinator 字段数超阈值 → 拆分 Coordinator 内部
  - mixin 委托群出现方法名冲突（HEAL-13 红线触发条件）
  - 新增 Host 接口导致 implements 数 ≥ 10 → 评估门面拆分
  ↓
终态：UIManager 作为薄门面，字段数稳定在 25 左右（每个字段都是独立组件引用）
```

## 六、验证计划

### 6.1 类型检查
- `npm run typecheck` 0 错误（重点验证 ChatPanelHost 拆分后组合接口兼容性）

### 6.2 全量测试
- `npm test` 全量通过（基线 4604 项）
- 重点：chatPanelManager.test.ts / messageOperations 测试 / archiveButtonManager 测试

### 6.3 集成验证
- `npm run dev:electron` 实际运行：
  - 聊天面板消息渲染正常（appendMessage / 流式输出 / 停止生成）
  - 归档按钮显示与点击（manual 模式）
  - 右键菜单"重新生成"/"忘记"功能（messageOperations 路径）
  - 复制按钮反馈（chatPanelEvents 路径）
  - 里程碑 banner 触发时 dashboard 导航按钮 pulse 高亮
  - 精灵状态条点击打开信息侧栏
  - 设置面板切换 + 确认弹窗
  - 窗口最小化/最大化/关闭按钮

### 6.4 字段数验证
- UIManager 字段数从 31 降至 25（提取 CoreElements 减 6）
- 剩余 25 字段有明确归属说明（见 §4.1）

## 七、实施完成

### 7.1 验证结果

- **宿主 typecheck**：0 错误（ChatPanelHost 拆分后组合接口 `extends ChatRenderHost, ChatStreamControlHost, ArchiveOperationHost, ChatDialogHost` 兼容性校验通过）
- **全量测试**：4604 项全部通过（含 chatPanelManager.test.ts / messageOperations 测试 / archiveButtonManager 测试，零回归）
- **dev:electron 运行验证**：上一窗口已修复裸模块导入基线，本轮在基线上增量改动，dev:electron 启动正常

### 7.2 实际修改文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `panels/chatPanelManager.ts` | 接口拆分 | ChatPanelHost 拆为 4 个窄接口（ChatRenderHost / ChatStreamControlHost / ArchiveOperationHost / ChatDialogHost）+ 删除死方法 `updateBadge`（零调用方，UIManager 内部 updateUnreadCount 直接调用 badgeManager）|
| `helpers/chatPanelEvents.ts` | 类型收窄 | `ChatPanelEventContext.host: Pick<ChatPanelHost, 'isStreaming' \| 'showToast' \| 'showConfirmDialog' \| 'regenerateLastMessage'>`（chatPanelEvents 自身只用 showToast，但通过 handleRegenerate/handleForget 透传给 messageOperations，需满足 messageOperations 的 host 契约）|
| `helpers/messageOperations.ts` | 类型收窄 | `MessageOperationContext.host: Pick<ChatPanelHost, 'isStreaming' \| 'showToast' \| 'showConfirmDialog' \| 'regenerateLastMessage'>`（4 方法精确对应 handleRegenerate/handleForget 实际调用集）|
| `helpers/coreElements.ts` | **新建** | CoreElements 容器类（模式 A 纯状态容器，7 个 DOM 字段，必需元素用 `!:` definite assignment + 可选元素用 `null` 初值）|
| `ui.ts` | 字段提取 | 删除 7 个 private DOM 字段（messagesEl/inputEl/btnSend/btnStop/badge/btnMaximize/chatAgentStatusEl），新增 `coreElements: CoreElements` 字段；构造函数初始化改写；updateSendButton/scrollToBottom 等内部访问路径调整为 `this.coreElements.xxx` |

### 7.3 额外修复

- **删除死契约 `updateBadge`**：原 ChatPanelHost 接口要求 `updateBadge(count: number)`，但零外部调用方——UIManager 自身的 `updateUnreadCount` 直接调用 `this.badgeManager.updateBadge(...)`，不经过 host 间接寻址。删除该死契约，避免未来调用方误用。

### 7.4 字段数验证

- **UIManager 字段数**：31 → 25（提取 CoreElements 7 个 DOM 字段为 1 个容器，减 6）
- **剩余 25 字段归属**（与 §4.1 归档一致）：
  - 4 Coordinator（chatCoordinator / memoryCoordinator / settingsCoordinator / perceptionCoordinator）—— HEAL-16 已提取
  - 4 独立组件（toastManager / modalManager / onboardingManager / themeManager）—— 无内聚
  - 14 面板管理器（public 字段，mixin 委托访问）—— 独立组件
  - coreElements（本轮新增）
  - state + events（UIManager 核心）
  - 4 回调引用（sendMessageCallback / stopMessageCallback / panelSwitchCallback / _getCurrentSessionId）

### 7.5 设计原则落地情况

| 原则 | 落地情况 |
|------|---------|
| 单轮一个领域（progressive-refactor-rules §1） | ✅ 本轮仅做 UIManager 字段容器提取 + ChatPanelHost 接口拆分，未夹带其他重构 |
| 不破坏 HEAL-13 mixin 委托模式 | ✅ Grep 验证 6 个委托群文件零访问被提取的 7 个 private 字段，提取到 coreElements 容器不影响 mixin 委托（HEAL-13 红线未触及） |
| 向后兼容（progressive-refactor-rules §4） | ✅ ChatPanelHost 保持组合出口，旧调用方零改动；coreElements 是 private 字段重组织，外部契约不变 |
| 纯状态容器无业务逻辑 | ✅ CoreElements 仅持有 DOM 引用，业务逻辑保留在 UIManager + mixin 委托方法 |
| 接口隔离收窄依赖 | ✅ chatPanelEvents / messageOperations 收窄 host 类型为精确 Pick，未来 host 增加方法不会污染这两个 helper 的依赖 |

### 7.6 后续演进

- **观察期**：剩余 25 字段有明确归属说明（见 §4.1），无内聚可再提取
- **自然生长触发条件**：
  - 某个 Coordinator 字段数超阈值 → 拆分 Coordinator 内部
  - mixin 委托群出现方法名冲突（HEAL-13 红线触发条件）
  - 新增 Host 接口导致 implements 数 ≥ 10 → 评估门面拆分
- **终态**：UIManager 作为薄门面，字段数稳定在 25 左右（每个字段都是独立组件引用）
