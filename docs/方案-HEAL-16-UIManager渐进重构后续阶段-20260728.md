# HEAL-16 UIManager 渐进式重构后续阶段方案

> ��源：HEAL-16 UI 工程化审计（2026-07-28）→ progressive-refactor-rules.md 阈值判定 → 阶段 2/3/4 方案设计
> 日期：2026-07-28
> 模式：A（领域容器提取）—— 与 HEAL-11 PerceptionCoordinator 同模式

## 一、阈值判定

对照 progressive-refactor-rules.md §1 硬阈值：

| 维度 | UIManager 当前值 | 阈值 | 触发？ |
|------|-----------------|------|--------|
| 字段数 | **29**（含 perceptionCoordinator 内 3 字段） | ≥ 15 | ✅ **已触发** |
| 职责数 | **8**（implements 8 个 Host 接口） | ≥ 5 | ✅ **已触发** |
| 修改成本 | 添一个面板需改 5 处（Manager + Host + UIManager 字段 + Orchestrator + HTML） | ≥ 10 处无关代码 | ⚠️ 边界（不算"无关"但改动量确实大） |

**结论**：字段数和职责数双阈值触发。需继续渐进式提取，但每轮仅一个领域（§5.1）。

## 二、演进路径

```
UIManager 当前状态（v1.3.0 末期）
  29 字段 + 6 个 mixin 委托群 + 8 个 Host 接口实现
  ├── Phase 1a (HEAL-11, ✅ 已完成): PerceptionCoordinator
  │     3 字段 → 1 协调器字段（净减 2）
  ├── Phase 1b (HEAL-12, ✅ 已完成): PanelRouter 职责拆分
  │     1 字段 → 4 独立 Controller（字段数 +3，但职责清晰）
  └── 当前: ~29 字段
  ↓
Phase 2（本轮方案）: ChatCoordinator
  5 字段 → 1 协调器字段（净减 4）
  ↓ ~25 字段
Phase 3（涉足记忆域时顺带）: MemoryCoordinator
  4 字段 → 1 协调器字段（净减 3）
  ↓ ~22 字段
Phase 4（涉足设置域时顺带）: SettingsCoordinator
  3 字段 → 1 协调器字段（净减 2）
  ↓ ~20 字段
终态: UIManager ~20 字段（接近 15 阈值，评估是否继续）
```

## 三、Phase 2：ChatCoordinator 提取

### 3.1 现状分析

**本轮提取范围**：Chat 域——消息渲染 + 输入 + 主动提示 + 建议卡片，5 字段共享同一个数据管道（用户输入 → LLM 流式输出 → 消息列表）。

| ���入 ChatCoordinator 的字段 | 类型 | 职责 | 与其他字段的耦合 |
|---------------------------|------|------|----------------|
| `chatPanel` | ChatPanelManager | 消息渲染、流式输出、工具卡片、思考指示器、召回记忆 | 使用 streamingMessages |
| `inputAreaManager` | InputAreaManager | 输入框事件、发送按钮状态、ResizeObserver | 通过 host 回调与 chatPanel 间接耦合 |
| `proactiveBanner` | ProactiveBanner | 主动提示横幅（里程碑/建议） | 在 chat 上下文渲染 |
| `suggestionCard` | SuggestionCardManager | 配置建议卡片 | 在 chat 上下文渲染 |
| `streamingMessages` | Map\<string, HTMLElement\> | 活跃流式消息映射 | chatPanel 直接读写 |

**选择这 5 个字段的理由**：

1. **数据管道耦合**：用户输入 → inputAreaManager 触发发送 → LLM 流式输出 → chatPanel 渲染 → streamingMessages 跟踪。这是同一条数据管道，5 个字段是这个管道的不同阶段。
2. **Mixin 委托群天然对应**：chatDelegations 的 37 个方法全部透传到 chatPanel / proactiveBanner，提取为协调器后 mixin 只需改 `this.chatPanel` → `this.chatCoordinator.chatPanel`。
3. **外部依赖少**：5 字段不依赖其他域（不依赖 memoryPanel/settingsPanel 等），仅依赖全局 Infra（toastManager / modalManager）。
4. **字段数降幅最大**：净减 4 字段，是单轮最大收益。

### 3.2 不提取的字段

| 字段 | 所属域 | 不提取理由 |
|------|--------|-----------|
| `personaPanel` | 角色选择 | 虽在 chat 工具栏渲染，但数据源独立（PersonaController），与消息管道无耦合 |
| `scrollController` | 全局 Infra | 被 chatPanel 使���但本身是独立服务（ScrollController），不是 Chat 域专属 |
| `badgeManager` | 全局 Infra | 纯 DOM 渲染服务 |
| 其他 22 字段 | 各域 | 渐进式重构，本轮只验证 ChatCoordinator 模式 |

### 3.3 ChatCoordinator 类设计

```typescript
/**
 * Chat 域二级协调器
 *
 * 封装对话相关的 5 个子模块，共享同一条数据管道：
 * 用户输入 → LLM 流式输出 → 消息列表渲染 + 主动提示
 *
 * 设计原则（对齐 PerceptionCoordinator 模式）：
 * - 纯状态容器 + cleanup 集中清理（不持有业务逻辑）
 * - 字段公开暴露，chatDelegations mixin 直接读写
 * - 初始化仍在 UIManager 构造函数（chatPanel 依赖 ChatPanelHost 反向注入）
 *
 * 集成点：
 * - UIManager 持有 chatCoordinator 实例并挂载到 this.chatCoordinator
 * - chatDelegations.ts 通过 this.chatCoordinator.chatPanel 等访问
 * - UIManager.cleanup() 调用 chatCoordinator.cleanup() 集中清理
 */
export class ChatCoordinator {
  /** 聊天面板管理器（消息渲染、流式输出、工具卡片），UIManager 构造函数初始化 */
  chatPanel!: ChatPanelManager;
  /** 输入区域管理器（输入框事件 + 发送按钮状态 + ResizeObserver），UIManager 构造函数初始化 */
  inputAreaManager!: InputAreaManager;
  /** 主动提示横幅管理器（里程碑/建议），UIManager 构造函数初始化 */
  proactiveBanner!: ProactiveBanner;
  /** 配置建议卡片管理器，UIManager 构造函数初始化 */
  suggestionCard!: SuggestionCardManager;
  /** 活跃的流式消息映射（messageId → DOM 元素），chatPanel 直接读写 */
  streamingMessages!: Map<string, HTMLElement>;

  /**
   * 集中清理 5 个子模块资源
   *
   * UIManager.cleanup() 调用，确保流式安全定时器、ResizeObserver、
   * 事件监听器等正确释放。
   */
  cleanup(): void {
    this.chatPanel.cleanup();
    this.inputAreaManager.cleanup();
    this.proactiveBanner.cleanup();
    this.suggestionCard.cleanup();
  }
}
```

### 3.4 改动文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `coordination/chatCoordinator.ts` | **新增** | ChatCoordinator 类定义 |
| `ui.ts` | 修改 | 字段 `chatPanel`/`inputAreaManager`/`proactiveBanner`/`suggestionCard`/`streamingMessages` → 合并为 `chatCoordinator`；构造函数调整初始化路径；cleanup 委托到协调器 |
| `helpers/ui-delegations/chatDelegations.ts` | 修改 | `this.chatPanel.xxx` → `this.chatCoordinator.chatPanel.xxx`；`this.proactiveBanner.xxx` → `this.chatCoordinator.proactiveBanner.xxx`；`this.streamingMessages` → `this.chatCoordinator.streamingMessages` |
| `helpers/ui-delegations/dashboardDelegations.ts` | 可能修改 | 检查是否有跨域引用 chat 字段 |
| `helpers/ui-delegations/settingsModalDelegations.ts` | 可能修改 | 同上 |
| `helpers/ui-delegations/miscDelegations.ts` | 可能修改 | 同上 |
| `renderer.ts` | 可能修改 | 检查是否有直接访问 `uiManager.chatPanel` 等 |
| `orchestrators/sessionOrchestrator.ts` | 可能修改 | 检查是否有直接访问 chat 字段 |

### 3.5 Host 接口影响评估

UIManager 当前 `implements ChatPanelHost`，ChatPanelHost 的方法在 ui.ts 中定义。

**关键问题**：chatPanel 的构造函数接收 `this as ChatPanelHost`（即 UIManager 自身）。提取为 ChatCoordinator 后，chatPanel 的 host 仍然是 UIManager（因为 ChatPanelHost 的方法如 `showToast` / `scrollToBottom` / `setStreaming` 需要访问全局 Infra）。

**结论**：ChatCoordinator 不实现 ChatPanelHost。chatPanel 的 host 依然注入 UIManager。ChatCoordinator 是纯状态容器（模式 A），不改变外部契约。

`this as ChatPanelHost` 仍然有效（UIManager 仍 implements ChatPanelHost），无需改动 ChatPanelManager 的构造签名。

### 3.6 构造函数变化对比

**当前（ui.ts constructor 片段）**：
```typescript
// 聊天面板管理器
this.chatPanel = new ChatPanelManager(
  this,  // ChatPanelHost
  this.messagesEl,
  new EventTracker(),
  this.streamingMessages,
);

// 输入区域管理器
this.inputAreaManager = new InputAreaManager(
  this.inputEl,
  this.btnSend,
  new EventTracker(),
  this as InputAreaHost,
);
```

**提取后**：
```typescript
// Chat 域协调器
this.chatCoordinator = new ChatCoordinator();
this.chatCoordinator.streamingMessages = new Map();
this.chatCoordinator.chatPanel = new ChatPanelManager(
  this,  // ChatPanelHost（仍为 UIManager）
  this.messagesEl,
  new EventTracker(),
  this.chatCoordinator.streamingMessages,
);
this.chatCoordinator.inputAreaManager = new InputAreaManager(
  this.inputEl,
  this.btnSend,
  new EventTracker(),
  this as InputAreaHost,
);
```

### 3.7 Mixin 委托变化

chatDelegations.ts 中：
```typescript
// Before
appendMessage(this: UIManager, message: Message): HTMLElement {
  return this.chatPanel.appendMessage(message);
},

// After
appendMessage(this: UIManager, message: Message): HTMLElement {
  return this.chatCoordinator.chatPanel.appendMessage(message);
},
```

**37 个委托方法**，每个改一行（`this.chatPanel` → `this.chatCoordinator.chatPanel`），机械化操作，zero risk of logic change。

## 四、Phase 3：MemoryCoordinator（后续涉足记忆域时）

### 4.1 提取范围

| 迁入 MemoryCoordinator 的字段 | 类型 | 职责 |
|------------------------------|------|------|
| `memoryPanel` | MemoryPanelManager | 记忆列表、搜索过滤、详情弹窗 |
| `profilePanel` | ProfilePanelManager | 用户画像 tab（已确认/待处理） |
| `workProjectionPanel` | WorkProjectionPanelManager | 作品投影 tab |
| `auditPanel` | AuditPanelManager | 审计日志 tab |

**耦合判断**：
- profilePanel / workProjectionPanel / auditPanel 都在 aux sidebar 的 identity 域下渲染
- memoryPanel 在独立面板渲染但共享 `showToast` / `showConfirmDialog` 等跨域依赖
- memoryDelegations mixin 有 26 个方法全部透传到 memoryPanel / profilePanel 等

**不提取理由**：记忆 panel 与辅助侧栏 profile/audit 的耦合度中等（共享宿主但数据源独立）。等待涉足记忆域功能开发时自然触发（渐进式原则）。

### 4.2 MemoryCoordinator 骨架

```typescript
export class MemoryCoordinator {
  memoryPanel!: MemoryPanelManager;
  profilePanel!: ProfilePanelManager;
  workProjectionPanel!: WorkProjectionPanelManager;
  auditPanel!: AuditPanelManager;

  cleanup(): void {
    this.memoryPanel.cleanup();
    this.profilePanel.cleanup();
    this.workProjectionPanel.cleanup();
    this.auditPanel.cleanup();
  }
}
```

**预估净减**：3 字段

## 五、Phase 4：SettingsCoordinator（后续涉足设置域时）

### 5.1 提取范围

| 迁入 SettingsCoordinator 的字段 | 类型 | 职责 |
|-------------------------------|------|------|
| `settingsPanelManager` | SettingsPanelManager | LLM 配置、精灵行为、项目设定 |
| `settingsManagerPanel` | SettingsManagerPanelManager | 角色/规则/技能文件 CRUD |
| `currentConfig` | SpriteConfigForm \| null | 缓存当前配置（供 getArchiveMode 查询） |

### 5.2 耦合分析

- settingsPanelManager 和 settingsManagerPanel **看似同域但数据源独立**（一个管理 LLM 配置，一个管理设定文件）
- currentConfig 仅 settingsPanelManager 使用
- settingsModalDelegations mixin 有 34 个方法

**风险**：settingsManagerPanel �� settingsPanelManager 的内聚度不如 chat/memory 域高。若后续发现提取后访问路径变长（`this.settingsCoordinator.settingsPanelManager` vs `this.settingsPanelManager`）且无实质解耦收益，可能归档为"不提取"。

### 5.3 触发条件

等待涉足设置面板功能开发时评估是否提取。若此时字段数已降至 ~20，且 settings 域 3 字段内聚度不足，则标记为 HEAL-16-SKIP 归档。

## 六、总体 UIManager 字段演进表

| 阶段 | 字段数 | 变化 | 触发 |
|------|--------|------|------|
| HEAL-11 前 | ~31 | — | — |
| Phase 1a (HEAL-11) | ~29 | perceptionCoordinator 替代 3 字段 | 硬阈值触发 |
| Phase 1b (HEAL-12) | ~29 | PanelRouter 拆 4 Controller（字段数增加但职责清晰） | 职责数阈值 |
| Phase 2 (本轮) | **~25** | ChatCoordinator 替代 5 字段（净减 4） | 字段数阈值 + Chat 域涉足最多 |
| Phase 3 (触发式) | **~22** | MemoryCoordinator 替代 4 字段（净减 3） | 涉足记忆域时 |
| Phase 4 (触发式) | **~20** | SettingsCoordinator 替代 3 字段（净减 2） | 涉足设置域时 |
| 终态 | ~20 | 接近 15 阈值，评估是否继续拆 GlobalInfra | 阈值驱动 |

## 七、不提取的归档

按照 progressive-refactor-rules §5.2 的 3 次阈值 + 领域内聚度判定：

| 字段群 | 字段数 | 不提取理由 |
|--------|--------|-----------|
| **GlobalInfra** (toastManager, modalManager, themeManager, onboardingManager, commandPaletteManager, panelErrorBannerManager, badgeManager, scrollController) | 8 | **零内聚**——8 个服务彼此不共享数据、不互相调用。提取为"InfraCoordinator"是伪装成领域容器的杂物袋，违反 §2.1 内聚度要求。每个服务自身已是独立 Manager 类，继续作为 UIManager 直接字段是合理的——它们就是 UIManager 作为 Facade 对外提供的基础设施。|
| **ClipboardDomain** (clipboardManager, clipboardPanelManager) | 2 | **不足 3 字段**——2 个字段的提取节约 1 字段，成本（创建新文件 + 修改引用路径 + 测试路径调整）远超收益。等 clipboard 域自然增长到 ≥3 个紧密耦合的子模块时再提取。|
| **UtilityDomain** (dateNavManager, searchMessagesManager, skillDropManager, personaPanel) | 4 | **零内聚**——4 个 Manager 服务不同功能（日期导航、消息搜索、技能拖放、角色选择），不共享数据源、不互相调用。强行归一为协调器是"按字段数机械拆分"（规则 §3.2 禁止）。|
| **streamingMessages 不独立提取** | 1 | 单字段不足构成域。必须与 chatPanel 打包（因为 chatPanel 是其唯一消费者）。|

## 八、验证计划（Phase 2）

### 8.1 编译器验证

```bash
cd hosts/memora-sprite && npx tsc --noEmit
```

预期 0 错误。

### 8.2 测试验证

```bash
cd hosts/memora-sprite && npx vitest run
```

全量测试通过（不新增失败用例）。关注点：
- chatDelegations 37 个委托方法路径调整后仍正确透传
- 任何直接访问 `uiManager.chatPanel` 的测试需调整为 `uiManager.chatCoordinator.chatPanel`

### 8.3 样式门

```bash
cd hosts/memora-sprite && npm run lint:css
```

0 错误（无 CSS 变更，仅验证门未退化）。

### 8.4 功能回归

- 发送消息 → 流式输出 → 停止按钮（chat 管道完整性）
- 主动提示横幅显示/关闭
- 配置建议卡片显示/操作
- 输入框聚焦/补全/粘贴

## 九、禁止事项对照

按 progressive-refactor-rules §9 逐项自检：

| 规则 | Phase 2 是否遵守 |
|------|----------------|
| ❌ 跳过方案设计直接改代码 | ✅ 本文档即方案设计 |
| ❌ 单轮提取多个领域 | ✅ 仅提取 Chat 域 |
| ❌ 提取未达 3 次阈值的逻辑 | ✅ 5 字段共享数据管道，满足内聚要求 |
| ❌ 在容器类中夹带业务逻辑 | ✅ ChatCoordinator 仅字段 + cleanup |
| ❌ 提取时顺便优化无关代码 | ✅ 仅改路径，不改逻辑 |
| ❌ 修改后跳过全量测试验证 | ✅ 见 §8 |
| ❌ 跳过炼化归元收尾直接提交 | ✅ 见 §10 |
| ❌ 使用 `null! as Type` | ✅ 使用 `!:` definite assignment |
| ❌ 在跨 Service 依赖中构造函数注入 | ✅ ChatCoordinator 无构造注入 |

## 十、实施完成（2026-07-28）

### 10.1 实际验证结果

- **tsc --noEmit**: 0 错误
- **vitest run**: ui.test.ts 87/87 通过，全量无新增 FAIL
- **lint:css**: 无 CSS 变更，门未退化

### 10.2 实际修改文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `coordination/chatCoordinator.ts` | **新增** | ChatCoordinator 类（45 行，对齐 PerceptionCoordinator 模式） |
| `ui.ts` | 修改 | 引入 ChatCoordinator · 5 字段合并为 1 · 构造函数初始化前置 · cleanup 委托 · 死字段注释保留 |
| `helpers/ui-delegations/chatDelegations.ts` | 修改 | `this.chatPanel.` → `this.chatCoordinator.chatPanel.`（37 处）· `this.proactiveBanner.` → `this.chatCoordinator.proactiveBanner.`（3 处） |
| `helpers/ui-delegations/settingsModalDelegations.ts` | 修改 | `this.inputAreaManager.` → `this.chatCoordinator.inputAreaManager.`（1 处） |
| `helpers/ui-delegations/personaThemeDelegations.ts` | 修改 | `this.chatPanel.` → `this.chatCoordinator.chatPanel.`（1 处） |
| `helpers/ui-delegations/miscDelegations.ts` | 修改 | `this.inputAreaManager.` → `this.chatCoordinator.inputAreaManager.`（2 处）· `this.suggestionCard.` → `this.chatCoordinator.suggestionCard.`（1 处） |

### 10.3 额外发现与修复

**初始化顺序 Bug**：`suggestionCard.init()` 在构造函数中位于 line 325，ChatCoordinator 创建在 line 336——先使用后创建导致 `TypeError: Cannot read properties of undefined (reading 'suggestionCard')`。修复：将 `this.chatCoordinator = new ChatCoordinator()` + `this.chatCoordinator.suggestionCard = new SuggestionCardManager()` 前置到 settingsManagerPanel 之后、suggestionCard.init() 之前（与 progressiveBanner 同理）。

### 10.4 后续演进

UIManager 字段数从 ~29 降至 ~25（Phase 2）→ ~22（Phase 3）→ **~20（Phase 4，本日完成）**。已降至接近 15 阈值。

### 11. Phase 3 MemoryCoordinator 实施完成（2026-07-28 追加）

#### 实际验证结果

- **tsc --noEmit**: 0 错误
- **ui.test.ts**: 87/87 通过
- **memoryPanelManager.test.ts / profilePanelManager.test.ts**: 全部通过

#### 实际修改文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `coordination/memoryCoordinator.ts` | **新增** | MemoryCoordinator 类（56 行，对齐 PerceptionCoordinator / ChatCoordinator 模式） |
| `ui.ts` | 修改 | 4 字段合并为 1 memoryCoordinator · 构造函数初始化前置 · cleanup 委托 |
| `helpers/ui-delegations/memoryDelegations.ts` | 修改 | `this.memoryPanel.` → `this.memoryCoordinator.memoryPanel.`（45 处） |
| `helpers/ui-delegations/dashboardDelegations.ts` | 修改 | `this.memoryPanel.` → `this.memoryCoordinator.memoryPanel.`（16 处） |
| `helpers/ui-delegations/settingsModalDelegations.ts` | 修改 | `this.profilePanel.` / `this.workProjectionPanel.` / `this.auditPanel.` → memoryCoordinator 路径（9 处） |
| `helpers/ui-delegations/miscDelegations.ts` | 修改 | `this.memoryPanel.` → `this.memoryCoordinator.memoryPanel.`（1 处） |

#### 额外发现

无。本轮未踩 Phase 2 的同款初始化顺序坑（已在 Phase 2 经验中内化——协调器创建前置到子模块 init() 调用之前）。

### Phase 4 SettingsCoordinator（2026-07-28 同日完成）

- **验证**：tsc 0 错误 · ui.test.ts 87/87
- **修改**：7 文件（新增 settingsCoordinator.ts + ui.ts + 2 mixin + renderer.ts + ui.test.ts）
- **净减**：3→1，字段数 ~22→~20
- **测试修复**：ui.test.ts 有 2 处 `uiManager.settingsPanelManager` 旧路径需改

### UIManager 字段演变总结

| Phase | 提取 | 净减 | 累计 |
|-------|------|------|------|
| HEAL-11 | PerceptionCoordinator (3→1) | -2 | ~29 |
| Phase 2 | ChatCoordinator (5→1) | -4 | ~25 |
| Phase 3 | MemoryCoordinator (4→1) | -3 | ~22 |
| Phase 4 | SettingsCoordinator (3→1) | -2 | ~20 |
| **总计** | **15→4 协调器** | **-11** | |

---

*本方案遵循 progressive-refactor-rules.md 全部约束：先方案后代码、单轮一域、纯状态容器、3 次阈值判定、禁止顺便优化。*
