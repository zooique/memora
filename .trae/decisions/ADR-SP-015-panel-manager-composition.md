---
alwaysApply: false
description: "PanelManager 组合模式约定：拆分阈值、生命周期契约、依赖注入四模式、委托规范"
---

# ADR-SP-015 · PanelManager 组合模式约定

> **状态**：✅ 已接受（2026-07-01，阶段 C 架构演进沉淀）
> **依赖**：[ADR-SP-007](./ADR-SP-007-directory-structure.md)（目录结构）、[ADR-SP-003](./ADR-SP-003-desktop-shell.md)（渲染进程分层约束）

## 背景

阶段 C 的 C-5 子项（C-5-1~C-5-4）从 UIManager 拆分出 4 个新 Manager（共 572 行），ui.ts 从 2131 → 1896 行（-235 行）。拆分过程中观察到 PanelManager 的实现形态存在显著差异：

- `PanelErrorBannerManager`：自包含 `EventTracker`，无构造参数
- `ClipboardManager`：依赖注入 `ToastManager + ModalManager`，无事件监听
- `DateNavManager`：自包含 `EventTracker`，通过 `onXxx()` 注册外部回调
- `SkillDropManager`：依赖注入 `ToastManager`，事件在外部（renderer.ts）绑定
- `DashboardPanelManager`：Host 接口注入（`DashboardPanelHost`），跨模块关注点通过接口暴露
- `SettingsPanelManager`：Host 接口注入（`SettingsPanelHost`）

这 6 种现存形态揭示了一个共同模式：**PanelManager 通过组合而非继承协作**，各 Manager 行为差异较大，强行提取基类会引入"为了统一而统一"的过度抽象。本 ADR 沉淀这一模式的完整约定，作为后续拆分决策的判据。

## 决策

**PanelManager 采用组合模式，不提取公共基类。每个 Manager 自负其责：选择合适的依赖注入方式、自管理生命周期、通过 UIManager 门面暴露能力。**

### 1. 拆分触发阈值

何时应该把 UIManager 中的内联逻辑拆分到独立的 PanelManager：

| 触发条件 | 说明 |
|----------|------|
| **单一职责边界清晰** | 逻辑聚焦于一个具体面板/功能（如"剪贴板保护"、"日期导航"），可独立成类 |
| **UIManager 体积过大** | ui.ts 超过 ~2000 行，新增功能加剧可读性下降 |
| **可独立测试** | 拆分后逻辑可脱离 UIManager 单测（注入 Mock 依赖即可） |
| **不高度耦合 UIManager 私有方法** | 若逻辑频繁访问 UIManager 私有字段/方法（如 `initEventListeners` 剩余 122 行），强拆会增加委托成本，应暂缓 |

**反例（不拆分）**：单次性 UI 联动、仅 2-3 行的薄包装、强耦合多个面板的编排逻辑——保持内联更清晰。

### 2. 必须实现的生命周期契约

每个 PanelManager 必须提供以下两个方法，由 UIManager 在统一时机调用：

```typescript
export class XxxManager {
  /** 初始化：绑定事件、注册回调、读取初始 DOM 状态 */
  init(): void { /* ... */ }

  /** 清理：移除事件监听器、清空回调引用、释放定时器 */
  cleanup(): void { /* ... */ }
}
```

**调用时机约定**：

| 方法 | 调用位置 | 调用时机 |
|------|----------|----------|
| `init()` | UIManager 构造函数末尾 / `initEventListeners()` 中 | UIManager 持有所有 Manager 实例后，按"先底层后上层"顺序调用 |
| `cleanup()` | UIManager `cleanup()` 中 | 按"先上层后底层"逆序调用，确保依赖方先释放 |

**特殊情况**：

- 若 Manager 不绑定事件监听器（如 ClipboardManager），`init()` 可省略，但 `cleanup()` 必须提供（可为空实现 + 注释说明）
- 若 Manager 有外部回调注册接口（如 `onDateNavJump`），回调注册顺序：先 `init()` 绑定内部事件，再由 renderer.ts 调用 `onXxx()` 注入外部回调

### 3. 依赖注入四模式

PanelManager 与外界的协作通过以下 4 种模式之一完成，按需选择，**不强制统一**：

#### 模式 A：Host 接口注入（推荐用于复杂协作）

Manager 定义 `XxxPanelHost` 接口声明所需宿主能力，UIManager 实现该接口并通过构造函数注入。

```typescript
export interface DashboardPanelHost {
  showToast(message: string, type?: ToastType, duration?: number): void;
}

export class DashboardPanelManager {
  constructor(private readonly host: DashboardPanelHost) {}
}
// UIManager 调用：new DashboardPanelManager(this as DashboardPanelHost)
```

**适用场景**：需要访问 UIManager 多个能力（showToast + 切换面板 + 获取数据），且这些能力适合聚合为接口契约。

#### 模式 B：共享 leaf 组件注入（推荐用于 Toast/Modal）

将 UIManager 已持有的 leaf 组件（ToastManager / ModalManager）作为构造参数传入，Manager 与 UIManager 共享同一实例。

```typescript
export class ClipboardManager {
  constructor(
    private readonly toastManager: ToastManager,
    private readonly modalManager: ModalManager,
  ) {}
}
// UIManager 调用：new ClipboardManager(this.toastManager, this.modalManager)
```

**适用场景**：Manager 只需要 1-2 个独立可复用组件的能力，无需聚合为接口。**优势**：行为与拆分前完全一致（同一实例引用），无重复实例化。

#### 模式 C：自包含 EventTracker（推荐用于事件密集型）

Manager 内部 `new EventTracker()` 自管理事件监听器，不依赖 UIManager。

```typescript
export class DateNavManager {
  private events = new EventTracker();

  init(): void {
    this.events.addEventListener(btn, 'click', handler);
  }
  cleanup(): void {
    this.events.cleanup();
  }
}
```

**适用场景**：Manager 绑定大量 DOM 事件（如日期导航、错误横幅），事件逻辑高度内聚于本 Manager。**约束**：必须在 `cleanup()` 中调用 `this.events.cleanup()`，否则内存泄漏。

#### 模式 D：自包含无注入（推荐用于纯逻辑型）

Manager 不依赖任何外部实例，所有状态自管理。

```typescript
export class PanelErrorBannerManager {
  private events = new EventTracker();
  private retryCallbacks = new Map<string, () => void>();
  // 无构造参数
}
```

**适用场景**：功能完全自包含，如纯 UI 状态机、计数器、横幅显示/隐藏。

#### 模式组合

实际项目中常组合使用，如 `DateNavManager` 是"模式 C（自包含 EventTracker）+ 回调注册接口"的混合。**选择原则**：能用模式 D 就不用模式 C，能用模式 B 就不用模式 A——优先选择耦合度最低的方式。

### 4. UIManager 委托方法命名规范

UIManager 对外暴露的委托方法应**与原方法同名**，保持调用方无感知迁移：

```typescript
// UIManager 中：
/** 显示面板错误横幅（委托到 PanelErrorBannerManager） */
showPanelError(panelId: string, message: string, retryCallback?: () => void): void {
  return this.panelErrorBannerManager.showPanelError(panelId, message, retryCallback);
}
```

**注释规范**：

- 方法上方 JSDoc 说明用途
- 方法体内首行注释 `// 委托到 XxxManager` 或 JSDoc 中包含 `委托到 XxxManager`
- 若委托方法仅是简单透传（单行 return），方法体保持单行；若有参数转换/前置校验，可多行

**禁止**：委托方法内夹带额外业务逻辑（如缓存、副作用）。委托方法必须是纯透传，业务逻辑归 Manager。

### 5. EventTracker 使用规范

任何绑定 DOM 事件的 Manager 必须使用 `EventTracker`，禁止直接 `addEventListener` 后忘记清理：

```typescript
import { EventTracker } from '../helpers/eventTracker.js';

export class XxxManager {
  private events = new EventTracker();

  init(): void {
    // ✅ 通过 EventTracker 绑定，cleanup 时统一移除
    this.events.addEventListener(el, 'click', handler);
    // ❌ 禁止：直接 addEventListener，cleanup 时易遗漏
    // el.addEventListener('click', handler);
  }

  cleanup(): void {
    this.events.cleanup(); // 必须
  }
}
```

**例外**：若事件在外部（renderer.ts）绑定，Manager 不持有监听器引用（如 SkillDropManager），则 Manager 无需 EventTracker，但 `cleanup()` 仍需清空回调引用避免潜在内存泄漏。

### 6. 不提取基类的理由

**决策**：不提取 `abstract class BasePanelManager` 或 `interface IPanelManager`。

**理由**：

| 考虑 | 说明 |
|------|------|
| **组合优于继承** | 各 Manager 行为差异大（事件型/纯逻辑型/回调型），强制抽象基类会导致方法空实现泛滥 |
| **TS 接口的局限性** | `init()` / `cleanup()` 签名相同，但参数、内部状态、回调注册接口各不相同，接口约束价值低 |
| **大模型核心原则** | 枝叶层 2 次提取原则（[ADR-017](./ADR-017-natural-growth-redefinition.md)）——当前 4 种注入模式并存已超 2 次阈值，但其他理由（组合优于继承/TS 接口局限/过度抽象代价）仍支撑不提取基类的决策 |
| **过度抽象的代价** | 基类增加一层间接，阅读时需跳转查看；新增 Manager 时需考虑"是否打破基类假设" |
| **替代方案** | 通过文档（本 ADR）+ 命名约定（统一 `init` / `cleanup` 方法名）+ code review 把关，足以保持一致性 |

**何时重新评估**：当出现 ≥2 个 Manager 共享非平凡的状态机逻辑（如"加载中 → 加载成功 → 加载失败"三态切换）时，可考虑提取 `LoadablePanelManager` mixin 或高阶函数。

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| 提取 `abstract class BasePanelManager` | 各 Manager 差异大，基类方法多为空实现；阅读成本高于收益 |
| 强制统一为"Host 接口注入"单一模式 | 简单 Manager（如 PanelErrorBannerManager）被迫定义空 Host 接口，徒增样板 |
| 强制 Manager 不持有 DOM 事件，全部由 renderer.ts 绑定 | 与"职责内聚"原则冲突，事件处理逻辑会被拆散到两处 |
| 用 React/Vue 等组件框架替代 PanelManager | 与 Electron 原生渲染进程架构不匹配，引入重依赖违反零依赖内核原则 |

## 影响

- **新增 Manager 时**：开发者需对照本 ADR 选择注入模式，实现 `init()` / `cleanup()`，在 UIManager 中注册实例 + 调用 init + 调用 cleanup + 暴露委托方法
- **代码审查 checklist**：新增 PanelManager 必须检查 ① 生命周期方法齐全 ② EventTracker 使用正确 ③ 委托方法是纯透传 ④ 不直接访问 UIManager 私有字段
- **测试要求**：每个 Manager 应可独立单测（通过 Mock 注入依赖），不依赖 UIManager 实例
- **目录归属**：PanelManager 必须放在 `electron/renderer/panels/` 目录，禁止散落到 `controllers/` 或 `components/`

## 年轮修订

### v0.1（2026-07-01）· 阶段 C 架构演进沉淀

**初始版本**：基于 C-5-1~C-5-4 拆分 4 个 Manager 的实践经验提炼。

**沉淀依据**：
- C-5-1 PanelErrorBannerManager（模式 D，自包含 EventTracker + Map）
- C-5-2 ClipboardManager（模式 B，ToastManager + ModalManager 注入）
- C-5-3 DateNavManager（模式 C + 回调注册，自包含 EventTracker）
- C-5-4 SkillDropManager（模式 B，ToastManager 注入 + 外部事件绑定）
- 历史 Manager：DashboardPanelManager / SettingsPanelManager（模式 A，Host 接口注入）

**未来演进方向**：当出现第 3 个"加载三态"Manager 时，评估是否提取 LoadablePanelManager mixin。
