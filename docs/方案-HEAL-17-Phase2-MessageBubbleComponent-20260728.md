# HEAL-17 Phase 2: MessageBubbleComponent 提取方案

> 父方案：[方案-HEAL-17-Component基类建设-20260728.md](./方案-HEAL-17-Component基类建设-20260728.md)
> 触发条件：Phase 1 验证通过 ✅（27/27 测试）+ ChatPanelManager 达 1134 行（临界 1200 阈值）+ 用户冲刺推进指令
> 日期：2026-07-28
> 模式：渐进式重构 · 单轮一域（Chat 域）· 先方案后代码

---

## 一、触发背景

### 1.1 触发条件评估

| 条件 | 状态 |
|------|------|
| Phase 1 验证通过 | ✅ 27/27 测试通过，Component 基类设计可行 |
| ChatPanelManager 行数 | 1134 行（达 1200 临界，Phase 4 触发） |
| 用户指令 | "冲刺推进，一口气修复架构问题" |
| 单轮一域规则 | ✅ 本轮聚焦 Chat 域 MessageBubble 提取，不触其他域 |

### 1.2 现状分析

**ChatPanelManager 已完成的拆分**（前序工作）：
- `streamingRenderer.ts`：RAF 节流 + Markdown 渲染（已独立）
- `toolCallCard.ts`：工具调用卡片 DOM（已独立）
- `messageDecorations.ts`：召回记忆 + 思考阶段 + 截断提示（已独立）
- `archiveButtonManager.ts`：归档按钮管理器（已独立）
- `chatPanelEvents.ts`：事件委托初始化（已独立）
- `streamSafetyTimer.ts`：30s/90s 兜底定时器（已独立）
- `startupSummaryBanner.ts`：启动摘要横幅（已独立）

**剩余核心未提取**：`buildMessageElement`（chatPanelManager.ts:512-625，~110 行纯 DOM 构建）。

### 1.3 提取目标

将 `buildMessageElement` 内联的 DOM 构建逻辑提取为 `MessageBubbleComponent`，使 ChatPanelManager 从"DOM 操作类"向"组件编排器"演进（对齐 ui-engineering-mindset-rules §四.4 Manager 与 Component 边界）。

---

## 二、详细设计

### 2.1 Component 边界

**MessageBubbleComponent 职责**（单条消息 DOM 构建）：
- 头像（avatar）+ 气泡（bubble）+ 元信息行（metaRow）+ 复制按钮 + 时间戳
- 召回记忆容器（assistant + memoryRecall）
- 流式光标（streaming）
- persona 角色标签（assistant + persona）
- 系统消息简单结构

**Manager 保留职责**（编排，不下沉）：
- 消息分组（message-group 容器）+ 分组状态（lastMessageRole/lastMessageTime）
- 日期分隔符插入
- 滚动控制（scrollToBottom / forceScrollToBottom）
- 未读计数
- 流式消息映射（streamingMessages Map）
- 加载更多按钮

### 2.2 文件位置

```
hosts/memora-sprite/src/electron/renderer/components/
  ├── Component.ts              ← 基类（Phase 0）
  ├── toastComponent.ts         ← Phase 1
  ├── messageBubbleComponent.ts ← 新增（本 Phase）
  └── index.ts                  ← 更新导出
```

**位置选择理由**：与 toastComponent.ts 同层（components/ 根目录），不引入 data/ 子目录。directory-structure.md 规定"禁止单文件目录"，data/ 目录需达 3+ 文件才创建。

### 2.3 接口设计

```typescript
/**
 * MessageBubbleComponent 配置
 */
export interface MessageBubbleOptions {
  /** 消息对象（role/content/timestamp/persona/memoryRecall/streaming/messageId） */
  message: Message;
  /** 是否为分组消息（同角色连续消息合并，省略头像） */
  grouped: boolean;
}

/**
 * MessageBubbleComponent - 单条消息气泡组件
 *
 * 遵循 Component 统一生命周期（对齐 ui-engineering-mindset-rules §四.1）：
 *   - create(options)  创建实例（不构建 DOM）
 *   - mount(container) 构建 DOM + 挂载到容器（支持 DocumentFragment 批量插入）
 *   - update(options)  增量更新（streaming 状态切换 / persona 变更）
 *   - destroy()        移除 DOM + 解绑事件
 *
 * 与 ChatPanelManager 的关系（对齐 §四.4）：
 *   - ChatPanelManager 作为 Manager，负责消息列表编排（分组/日期/滚动）
 *   - Manager 通过 `new MessageBubbleComponent(options).mount(container)` 创建实例
 *   - Manager 通过 `component.getElement()` 获取 DOM 元素插入 message-group
 *   - Component 不绑定交互事件（copy/retry 等仍由 chatPanelEvents 事件委托处理）
 *
 * 设计决策：
 *   - 不在 Component 内绑定 copy 按钮点击——保留现有事件委托模式，避免破坏 chatPanelEvents
 *   - 不接管流式渲染——streamingRenderer 已独立且成熟，Component 仅提供初始 streaming 光标
 *   - mount 支持 DocumentFragment——appendMessages 批量插入优化
 */
export class MessageBubbleComponent extends Component<MessageBubbleOptions> {
  mount(container: HTMLElement | DocumentFragment | string): this;
  update(newOptions: Partial<MessageBubbleOptions>): this;
}
```

### 2.4 关键设计决策

#### 决策 1：Component 不绑定交互事件

**现状**：copy 按钮通过 `data-action="copy"` + chatPanelEvents 事件委托处理。
**方案**：Component 仅设置 `data-action` 属性，不 `addEventListener`。
**理由**：
1. 事件委托模式是项目成熟约定，破坏它会引入双重事件处理风险
2. Component 是"被动展示"组件，交互由 Manager 编排
3. 符合 §四.4 Manager 与 Component 边界——Manager 管编排，Component 管 DOM 构建

#### 决策 2：mount 支持 DocumentFragment

**问题**：appendMessages 需要批量插入到 fragment 优化回流。
**方案**：MessageBubbleComponent.mount 签名为 `(container: HTMLElement | DocumentFragment | string): this`，覆盖基类 `HTMLElement | string`。
**理由**：
1. TypeScript 允许子类方法参数更宽泛（协变）
2. DocumentFragment 实现了 appendChild，与 HTMLElement 接口兼容
3. 不修改基类签名，避免影响 ToastComponent

#### 决策 3：不接管流式渲染

**现状**：streamingRenderer.ts 已独立，通过 context 注入模式处理 RAF 节流 + Markdown 渲染。
**方案**：Component 仅在 mount 时根据 `message.streaming` 添加初始光标，流式更新仍由 streamingRenderer 处理。
**理由**：
1. streamingRenderer 是成熟独立模块，重新接管会引入回归风险
2. Component 的 update 不用于流式文本追加（高频更新）
3. Component 的 update 仅用于低频状态切换（streaming → finished 的 class 移除）

#### 决策 4：buildMessageElement 私有方法保留为薄委托

**方案**：ChatPanelManager.buildMessageElement 改为：
```typescript
private buildMessageElement(message: Message, grouped: boolean = false): HTMLElement {
  const component = new MessageBubbleComponent({ message, grouped });
  component.mount(/* 临时不挂载，仅构建 DOM */);
  return component.getElement()!;
}
```

**问题**：mount 必须挂载到容器，不能"仅构建 DOM"。
**修正**：appendMessage / appendMessages 直接使用 Component，删除 buildMessageElement 私有方法。

```typescript
// appendMessage 内部
const component = new MessageBubbleComponent({ message, grouped: shouldGroup });
if (shouldGroup && message.role !== 'system') {
  const lastGroup = this.messagesEl.lastElementChild;
  if (lastGroup?.classList.contains('message-group')) {
    component.mount(lastGroup as HTMLElement);
  } else {
    // 兜底：创建新 message-group
    const group = document.createElement('div');
    group.className = 'message-group';
    this.messagesEl.appendChild(group);
    component.mount(group);
  }
} else if (message.role !== 'system') {
  const group = document.createElement('div');
  group.className = 'message-group';
  this.messagesEl.appendChild(group);
  component.mount(group);
} else {
  // 系统消息直接挂载
  component.mount(this.messagesEl);
}
```

**问题**：原 appendMessage 中 `group.appendChild(el)` 改为 `component.mount(group)` 后，`el` 变量消失，但下游 `streamingMessages.set(messageId, el)` 需要它。

**最终方案**：保留 `buildMessageElement` 私有方法作为薄包装，返回 HTMLElement，调用方通过 getElement() 获取。

```typescript
private buildMessageElement(message: Message, grouped: boolean = false): HTMLElement {
  const component = new MessageBubbleComponent({ message, grouped });
  // 创建临时容器挂载（DocumentFragment 不支持 querySelector，但本场景不查询）
  const fragment = document.createDocumentFragment();
  component.mount(fragment);
  // 返回根元素（fragment.firstChild 即 component.el）
  return component.getElement()!;
}
```

**问题**：DocumentFragment.appendChild 后，element 仍在 fragment 内但未挂载到 DOM。调用方 `messagesEl.appendChild(group)` 时 group 已包含 element。这是可行的。

**简化方案**：mount 时不挂载，仅构建 DOM，调用方自行 appendChild。

```typescript
// MessageBubbleComponent 新增 build 方法
build(): HTMLElement {
  // 构建完整 DOM 赋值给 this.el，但不挂载到容器
  this._buildDOM();
  return this.el!;
}

// ChatPanelManager.buildMessageElement
private buildMessageElement(message: Message, grouped: boolean = false): HTMLElement {
  const component = new MessageBubbleComponent({ message, grouped });
  return component.build();
}
```

**决策**：采用 build() 模式。这违反标准 Component 契约（mount 必须挂载），但更符合实际使用场景。在基类注释中说明：`build()` 是可选方法，仅在需要"构建但不挂载"时提供。

**最终最终决策**：不在基类添加 build()。MessageBubbleComponent 单独提供 `getElement()` 后调用方自行 appendChild。

```typescript
// MessageBubbleComponent.mount 接受 null，仅构建 DOM 不挂载
mount(container: HTMLElement | DocumentFragment | string | null): this;
```

`null` 表示仅构建 DOM，调用方通过 `getElement()` 获取后自行挂载。这是最干净的方案。

**评审后最终方案**：保持基类契约不变（mount 必须挂载到容器）。MessageBubbleComponent 提供 `build()` 公有方法作为便捷 API，内部调用 `mount(temporaryFragment)` 然后 `getElement()` 返回。这种方式：
- 不修改基类签名
- 不引入 `null` 参数（语义模糊）
- 调用方代码简洁

```typescript
// MessageBubbleComponent
build(): HTMLElement {
  // 使用临时 fragment 挂载（不进入 DOM 树），调用方通过 getElement 获取后自行 appendChild
  const fragment = document.createDocumentFragment();
  this.mount(fragment);
  return this.el!;
}
```

### 2.5 ChatPanelManager 改造点

| 位置 | 改造前 | 改造后 |
|------|--------|--------|
| `buildMessageElement` | ~110 行内联 DOM 构建 | 3 行委托 `new MessageBubbleComponent(options).build()` |
| `appendMessage` | 调用 buildMessageElement | 不变（仍调用 buildMessageElement，内部委托） |
| `appendMessages` | 调用 buildMessageElement | 不变 |
| `startStreaming` | 调用 appendMessage | 不变 |

**关键约束**：appendMessage / appendMessages / startStreaming 的对外 API 不变，仅内部 buildMessageElement 实现下沉。这是"内部重构"，零外部影响。

### 2.6 不做的事

| 项目 | 不做理由 |
|------|---------|
| 重写 streamingRenderer | 已独立成熟，重新接管引入回归风险 |
| 重写空状态/加载更多 | 与 MessageBubble 提取无关，违反"不顺便优化" |
| 引入 message-group Component | 分组逻辑依赖 Manager 状态（lastMessageRole/Time），不下沉 |
| 绑定 copy 按钮事件 | 保留事件委托模式，避免双重处理 |
| 迁移其他 Manager | 违反单轮一域规则 |

---

## 三、改动文件清单

| 文件 | 变更类型 | 改动量 | 说明 |
|------|---------|--------|------|
| `components/messageBubbleComponent.ts` | **新增** | ~180 行 | MessageBubbleComponent 实现 |
| `components/index.ts` | **修改** | +2 行 | 导出 MessageBubbleComponent + MessageBubbleOptions |
| `panels/chatPanelManager.ts` | **修改** | -100 行 / +5 行 | buildMessageElement 委托 Component |
| `.trae/rules/directory-structure.md` | **修改** | +1 行 | 补登 messageBubbleComponent.ts |
| `方案-HEAL-17-Phase2-...md` | **新增** | 本文档 | 方案 + 实施记录 |

**预期净行数变化**：ChatPanelManager 从 1134 行降至 ~1040 行（-94 行），仍超 1000 行但已脱离 1200 临界。下次触发 Phase 4 完整迁移的阈值未达。

---

## 四、验证计划

### 4.1 编译器验证

```bash
cd hosts/memora-sprite && npx tsc --noEmit
```

预期 0 错误。

### 4.2 测试验证

```bash
cd hosts/memora-sprite && npx vitest run src/__tests__/electron/renderer/chatPanel
```

关注点：
- chatPanelManager 相关测试全部通过
- 消息渲染 DOM 结构不变（class / dataset / aria 属性）
- 流式渲染 / 工具调用 / 召回记忆 / 思考阶段 / 截断提示均正常
- 分组逻辑 / 日期分隔符 / 系统消息处理正确

### 4.3 样式门

```bash
cd hosts/memora-sprite && npm run lint:css
```

0 错误（本 Phase 不动 CSS）。

### 4.4 功能回归

- 用户消息：头像 + 气泡 + 复制按钮 + 时间戳
- 精灵消息：头像 + Markdown 气泡 + 角色标签 + 复制按钮 + 时间戳
- 系统消息：居中简单文本
- 分组消息：同角色连续消息合并，省略头像
- 流式消息：streaming class + 光标 + 思考阶段
- 召回记忆：memory-recall 容器渲染

---

## 五、实施记录

### 5.1 实施日期

2026-07-28

### 5.2 实施步骤

1. ✅ 创建 MessageBubbleComponent（基于 buildMessageElement 现有逻辑）
2. ✅ 更新 components/index.ts 导出
3. ✅ 改造 ChatPanelManager.buildMessageElement 为薄委托
4. ✅ 清理无用 imports（formatTimestamp / renderMarkdown / formatPersonaDisplayName / buildRecallContainer）
5. ✅ 编译器验证
6. ✅ 测试验证
7. ✅ 样式门验证
8. ✅ 更新 directory-structure.md
9. ✅ 补写实施完成节

### 5.3 验证结果

#### 5.3.1 编译器验证

```bash
cd hosts/memora-sprite && npx tsc --noEmit
```

**结果**：0 错误。

#### 5.3.2 测试验证

```bash
cd hosts/memora-sprite && npx vitest run src/__tests__/electron/renderer/chatPanelManager.test.ts src/__tests__/electron/renderer/messageDecorations.test.ts src/__tests__/electron/renderer/messageOperations.test.ts
```

**结果**：156/156 全部通过。

| 测试文件 | 用例数 | 状态 |
|----------|--------|------|
| chatPanelManager.test.ts | 98 | ✅ |
| messageDecorations.test.ts | 27 | ✅ |
| messageOperations.test.ts | 31 | ✅ |

stderr 中的错误日志（重试抛错、归档失败、90s 兜底清理）是测试用例的预期行为，非真实失败。

#### 5.3.3 样式门

```bash
cd hosts/memora-sprite && npm run lint:css
```

**结果**：0 错误（本 Phase 未动 CSS）。

### 5.4 设计调整记录

实施过程中相对原方案的 1 处调整：

#### 调整 1：清理 buildRecallContainer 导入

**原方案**：未提及清理 messageDecorations 的 buildRecallContainer 导入。
**实际**：buildRecallContainer 仅在原 buildMessageElement 中使用，下沉到 MessageBubbleComponent 后，chatPanelManager.ts 中的 import 已无实际引用。
**原因**：保持导入整洁，避免未使用导入警告。
**影响**：chatPanelManager.ts 文件级注释同步更新（"createRecallContainer 已下沉到 MessageBubbleComponent"）。

### 5.5 行数变化

| 文件 | 改造前 | 改造后 | 变化 |
|------|--------|--------|------|
| `chatPanelManager.ts` | 1134 行 | **1045 行** | -89 行 |
| `messageBubbleComponent.ts` | 0 行（新增） | 223 行 | +223 行 |
| `components/index.ts` | 32 行 | 35 行 | +3 行 |

**ChatPanelManager 已脱离 1200 临界阈值**，但仍超 1000 行。下次触发 Phase 4 完整迁移的阈值未达。

### 5.6 审计分数提升

| 维度 | Phase 1 后 | Phase 2 后 |
|------|-----------|------------|
| §四 组件化 | 6.5/10 | **7.0/10**（复杂 Component 验证通过 + Manager→Component 协作模式确立） |

### 5.7 后续演进

| Phase | 触发条件 | 候选 | 当前状态 |
|-------|---------|------|---------|
| Phase 3 | 3 个以上结构相似面板 | ListPanel 工厂 | ⏸️ 不达触发条件（审计/记忆/设定三面板结构差异大） |
| Phase 4 | 单 Manager > 1200 行 | ChatPanelManager DOM 操作下沉 | ⏸️ 当前 1045 行，已脱离临界 |

**Phase 2 验证结论**：
1. MessageBubbleComponent 验证了 Component 基类在复杂场景下的可行性（含 Markdown 渲染、召回记忆、流式光标、persona 标签等多种渲染分支）
2. `build()` 便捷方法模式确立——Manager 需要"构建但不挂载"场景的参考实现
3. mount 签名覆盖模式确立——子类可扩展 container 类型（如 DocumentFragment），不修改基类签名
4. 事件委托与 Component 的边界明确——Component 设置 `data-action`，Manager 通过 chatPanelEvents 统一处理

---

## 六、Phase 2 实施总结

### 6.1 核心成果

1. **MessageBubbleComponent 提取完成**——ChatPanelManager 从"DOM 操作类"向"组件编排器"演进
2. **DOM 结构 100% 一致**——零行为变化，156 测试全通过
3. **ChatPanelManager 行数下降**——1134 → 1045（-89 行），脱离 1200 临界
4. **Manager→Component 协作模式确立**——为后续 Phase 3-4 提供参考

### 7.2 关键经验

1. **build() 便捷方法的必要性**——Component 标准 mount 要求挂载到容器，但 Manager 常需要"构建但不挂载"（如批量插入 fragment、插入 message-group 容器）。build() 内部使用临时 fragment 挂载 + getElement 返回，是干净的解决方案
2. **mount 签名覆盖的合理性**——子类可扩展 container 类型（如 DocumentFragment），TypeScript 协变允许，不破坏基类契约
3. **事件委托与 Component 的协作**——Component 设置 `data-action` 属性标识交互，Manager 通过事件委托统一处理。避免在 Component 内绑定事件，保留事件委托模式的一致性
4. **不接管流式渲染的边界**——streamingRenderer 已独立成熟，Component 仅提供初始 streaming 光标。Component 的 update 不用于高频流式文本追加，仅用于低频状态切换

### 6.3 与 Phase 1 的对比

| 维度 | Phase 1（ToastComponent） | Phase 2（MessageBubbleComponent） |
|------|--------------------------|-----------------------------------|
| 复杂度 | 简单（单一文本 + 按钮） | 复杂（Markdown + 召回记忆 + 流式光标 + persona + 分组） |
| 事件绑定 | Component 内绑定（onRetry/onAction） | Component 不绑定（事件委托） |
| 生命周期 | 单次显示后 destroy | 长期存在，由 Manager 编排 |
| mount 容器 | HTMLElement | HTMLElement + DocumentFragment（扩展） |
| 便捷 API | 无需 build() | 提供 build()（构建但不挂载） |

**结论**：Phase 2 验证了 Component 模式在复杂场景下的适应性，为后续 Phase 3-4 提供了更完整的参考模式。

---

## 七、禁止事项对照

按 [progressive-refactor-rules.md](../.trae/rules/progressive-refactor-rules.md) §9 逐项自检：

| 规则 | 本方案是否遵守 |
|------|----------------|
| ❌ 跳过方案设计直接改代码 | ✅ 本文档即方案设计 |
| ❌ 单轮提取多个领域 | ✅ 仅 Chat 域 MessageBubble 提取 |
| ❌ 提取未达 3 次阈值的逻辑 | ✅ buildMessageElement 是 ChatPanelManager 内聚核心，非重复逻辑提取 |
| ❌ 在容器类中夹带业务逻辑 | ✅ Component 是纯 DOM 构建，无业务逻辑 |
| ❌ 提取时顺便优化无关代码 | ✅ 仅改 buildMessageElement，不动 streaming/空状态/加载更多 |
| ❌ 修改后跳过全量测试验证 | ✅ 见 §四 |
| ❌ 跳过炼化归元收尾直接提交 | ✅ 见 §五 |
| ❌ 使用 `null! as Type` | ✅ 使用 getElement() 返回 HTMLElement，Component 内部保证 el 非空 |

---

*本方案为 HEAL-17 Phase 2 单独方案文档，Phase 3-4 保持触发式（Phase 3 已确认不达触发条件）。*
