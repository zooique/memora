# HEAL-17 Component 基类建设与 JS 层组件抽象方案

> 来源：sprite-ui-engineering-audit-2026-07-28.md §四（6.0/10 最大短板）+ meta-stock 设计理念对照 + ui-engineering-mindset-rules §四.1~§四.4 新增
> 日期：2026-07-28
> 模式：基础设施建设 + 渐进式迁移（非单一提取，分阶段验证）

---

## 一、现状分析

### 1.1 触发背景

**审计对照**（[sprite-ui-engineering-audit-2026-07-28.md](../tasks/sprite-ui-engineering-audit-2026-07-28.md)）：

| 维度 | 得分 | 状态 |
|------|------|------|
| §一 设计令牌 | 9.5/10 | ✅ 项目最强维度 |
| §二 通用组件（CSS） | 8.0/10 | ✅ 控件收口到位 |
| §三 独特性 | 8.5/10 | ✅ 覆写范围克制 |
| §四 组件化（JS） | **6.0/10** | ❌ **最大短板——本方案目标** |
| §五 前后端嫁接 | 7.5/10 | CSS 层优秀，JS 层弱 |

**核心缺陷**（审计 §四）：

1. **没有 JS 层组件抽象**——每个 Manager 手写 `document.createElement` / `className` / `appendChild`
2. **Manager 不是真正的组件**——ChatPanelManager（~900 行）是"DOM 操作类"而非"组件"
3. **index.html 是单体 DOM**——所有面板 HTML 在一个文件中（~1000+ 行）
4. **缺少组件树 / 组合模式**——UIManager 直接持有 25+ 平级子模块，无父子层级

**HEAL-16 已解决的部分**：UIManager 字段数从 ~31 降至 ~20（4 个 Coordinator 提取完成）。本方案不重复处理字段数问题，专注 JS 层组件抽象。

### 1.2 meta-stock 设计理念对照

对照 [meta-stock ui-design-philosophy.md](../../meta-stock/docs/ui-design-philosophy.md) 和实际代码实现：

| 理念 | meta-stock 实现 | sprite 可吸收点 | sprite 不可照搬点 |
|------|----------------|----------------|------------------|
| 统一生命周期 API | `create/mount/update/destroy` 四件套 | ✅ 全部吸收（§四.1） | — |
| 声明式工厂造页 | ListPage/DetailPage/Dashboard/Workspace 4 范式 | ✅ 吸收模式，不照搬 4 范式 | sprite 面板类型与进销存不同 |
| 组件分层 + 统一导出 | base/feedback/form/navigation/data 五层 + `components/index.js` | ✅ 全部吸收（§四.3） | sprite 是 TS，需 `index.ts` |
| hash 路由 + import() 懒加载 | Web SPA 路由 | ❌ 不照搬 | sprite 是 Electron 多窗口，已用 `BrowserWindow.loadFile()` 隔离 |
| 纯 JS ESM 路径别名 | `@components` / `@modules` | ❌ 不照搬 | sprite 是 TS，已有自己的 import 风格 |
| BEM 重写 | `.button--primary` | ❌ 不照搬 | sprite CSS 层已 9.5/10，无需重写 |

### 1.3 规则更新总结

本方案配套的规则更新（[ui-engineering-mindset-rules.md](../.trae/rules/ui-engineering-mindset-rules.md)）已先行：

- 新增 §四.1 JS 层组件抽象——统一生命周期 API
- 新增 §四.2 声明式工厂——通过配置声明差异
- 新增 §四.3 组件分层与统一导出
- 新增 §四.4 Manager 与 Component 的边界
- §五 嫁接对照表补充 JS 层列
- §六 速查表从 5 问扩展到 8 问 + 判定流程图

### 1.4 阈值判定

对照 [progressive-refactor-rules.md](../.trae/rules/progressive-refactor-rules.md) §1 硬阈值：

| 维度 | sprite 当前值 | 阈值 | 触发？ |
|------|--------------|------|--------|
| 单 Manager 文件长度 | ChatPanelManager ~900 行 | > 1200 行 | ⚠️ 临界（未触发但接近） |
| 手写 DOM 的 Manager 数量 | 25+ 个 PanelManager 全部手写 DOM | — | 非阈值驱动，是结构性债务 |
| 重复结构面板数量 | 待统计（记忆/审计/设置文件列表可能相似） | ≥ 3 即抽工厂 | ⏸️ 触发式 |

**结论**：当前未达硬阈值，但结构性债务明确。本方案采用**基础设施建设 + 触发式迁移**模式，不强制立即全量重构。

---

## 二、阶段路线图

### 2.1 总体演进路径

```
sprite JS 层组件抽象演进
  │
  ├── Phase 0: 基础设施建设（轻量，纯新增）
  │     - Component 抽象基类
  │     - components/index.ts 统一导出口
  │     - 分层目录骨架（base/feedback/form/navigation/data）
  │     ↓
  ├── Phase 1: 第一个 Component 验证（轻量）
  │     - 选 1 个简单组件迁移（候选：Toast）
  │     - 验证 create/mount/update/destroy 四件套
  │     - 验证 Manager 持有 Component 的协作模式
  │     ↓
  ├── Phase 2: 复杂 Component 验证（中等，触发式）
  │     - 候选：MessageBubble（ChatPanelManager 内部）
  │     - 验证 Component 与现有 Host 接口的兼容性
  │     - 触发条件：Phase 1 验证通过 + 涉足 Chat 域
  │     ↓
  ├── Phase 3: 声明式工厂验证（触发式）
  │     - 候选：ListPanel 工厂（记忆/审计/设置文件列表）
  │     - 触发条件：3 个以上结构相似面板
  │     ↓
  └── Phase 4: Manager 渐进迁移（触发式）
        - 候选：ChatPanelManager DOM 操作下沉
        - 触发条件：单 Manager > 1200 行
```

### 2.2 各 Phase 触发条件与改动量评估

| Phase | 触发条件 | 改动量 | 风险 | 状态 |
|-------|---------|--------|------|------|
| Phase 0 | 无前置依赖，建议与 Phase 1 一起做 | ~3 个新文件 | 极低（纯新增） | ⏸️ 待确认 |
| Phase 1 | Phase 0 完成 | ~1-2 个新 Component + 1-2 处调用方 | 低（小范围验证） | ⏸️ |
| Phase 2 | Phase 1 验证通过 + 涉足对应 Manager | ~1 个 Component + Manager 5-10 处调用 | 中（涉及 Manager 内部） | ⏸️ 触发式 |
| Phase 3 | 3 个以上结构相似面板 | ~1 个工厂 + 3-5 个面板迁移 | 中高（多面板） | ⏸️ 触发式 |
| Phase 4 | 单 Manager > 1200 行 | Manager 内部重构 | 高（核心交互） | ⏸️ 触发式 |

### 2.3 与现有 Coordinator 模式的关系

本方案与 HEAL-16 的 Coordinator 提取**正交不冲突**：

| 维度 | Coordinator（HEAL-16） | Component（HEAL-17） |
|------|----------------------|---------------------|
| 目标 | UIManager 字段数下降 | Manager 内部 DOM 操作下沉 |
| 层次 | UIManager → Coordinator → Manager | Manager → Component → DOM |
| 改动面 | 字段路径（`this.chatPanel` → `this.chatCoordinator.chatPanel`） | Manager 内部结构（`this.messagesEl.innerHTML` → `this.messageListComponent.update(data)`） |
| 兼容性 | 完全兼容——Coordinator 持有 Manager，Manager 持有 Component | 完全兼容——Coordinator 不感知 Component |

---

## 三、Phase 0 + Phase 1 详细设计

> 以下为建议立即启动的部分。Phase 2-4 为触发式，只在路线图中保留位置，不展开设计。

### 3.1 Phase 0：Component 抽象基类

#### 3.1.1 文件位置

```
hosts/memora-sprite/src/electron/renderer/components/
  ├── base/
  │   └── Component.ts          ← 新增：抽象基类
  ├── feedback/                  ← 目录骨架（Phase 1 填充）
  ├── form/                      ← 目录骨架（后续填充）
  ├── navigation/                ← 目录骨架（后续填充）
  ├── data/                      ← 目录骨架（后续填充）
  └── index.ts                   ← 新增：统一导出口
```

#### 3.1.2 Component 抽象基类设计

```typescript
/**
 * Component 抽象基类
 *
 * 所有 JS 层组件的统一生命周期契约：
 *   - new(options)     构造函数（只合并配置，无副作用）
 *   - mount(container) 挂载到 DOM
 *   - update(options)  增量更新内部状态
 *   - destroy()        解绑事件 + 移除 DOM + nullify 引用
 *
 * 设计原则（对齐 ui-engineering-mindset-rules §四.1）：
 *   - 构造函数只做配置合并 + 字段初始化，不做副作用
 *   - mount() 后 this.el 必须指向根 DOM 元素
 *   - update() 增量更新，不重建 DOM（避免丢失焦点/滚动/过渡）
 *   - destroy() 彻底清理，残留引用 = 内存泄漏
 *
 * 与现有 Manager 模式的关系：
 *   - Manager 的 init() + cleanup() 是生命周期的雏形
 *   - Component 是 Manager 内部 DOM 操作的替代者
 *   - Manager 持有 Component 实例，不直接 createElement
 *
 * @template P 组件配置（Props）类型
 */
export abstract class Component<P = Record<string, unknown>> {
  /** 合并后的配置（构造函数合并 defaults + options） */
  protected options: P;
  /** 组件根 DOM 元素（mount() 后赋值，destroy() 后 nullify） */
  protected el: HTMLElement | null = null;
  /** 事件解绑函数列表（mount 时收集，destroy 时统一调用） */
  private _cleanups: Array<() => void> = [];

  /**
   * 构造函数——只做配置合并，不做副作用
   *
   * 副作用（DOM 查询、事件绑定、请求发起）放在 mount() 后。
   * 注：protected 强制子类显式声明 public constructor（与 abstract 双保险）。
   *
   * @param options 组件配置
   */
  protected constructor(options: P) {
    this.options = { ...options };
  }

  /**
   * 静态工厂方法——便捷 API（已移除）
   *
   * 原方案设计为 `static create<P>(this: ..., options: P): InstanceType<this>`，
   * 实施时发现 TypeScript 对 `this` 类型在静态方法中的限制（TS2526），
   * 且项目实际调用方均使用 `new XXXComponent(options)`，create() 无引用。
   * 已在 HEAL-17 Phase 2 实施时移除，统一使用 `new` 构造函数。
   */

  /**
   * 挂载到容器——DOM 已就绪后才能调用
   *
   * 子类必须实现：
   *   1. 创建根 DOM 元素赋值给 this.el
   *   2. 绑定事件（通过 trackEvent 收集解绑函数）
   *   3. 将 this.el 追加到 container
   *
   * @param container 容器元素或选择器
   * @returns this（链式调用）
   */
  abstract mount(container: HTMLElement | string): this;

  /**
   * 增量更新内部状态——不重建 DOM
   *
   * 子类应通过 textContent / classList.toggle / setAttribute 等增量操作更新。
   * 当确实需要重建（结构变化）时，子类应明确注释「结构变更，需重建」。
   *
   * @param newOptions 新的配置项（与构造函数 options 同类型）
   * @returns this（链式调用）
   */
  abstract update(newOptions: Partial<P>): this;

  /**
   * 销毁组件——彻底清理
   *
   * 子类应 override 并在最后调用 super.destroy()：
   *   1. 解绑所有事件（super 已处理 _cleanups）
   *   2. 移除 DOM 元素（super 已处理 el.remove()）
   *   3. nullify 子类自己的字段引用
   *   4. 调用 super.destroy() 完成通用清理
   */
  destroy(): void {
    /** 执行所有收集的解绑函数 */
    this._cleanups.forEach(cleanup => cleanup());
    this._cleanups = [];
    /** 移除根 DOM 元素 */
    this.el?.remove();
    this.el = null;
  }

  /**
   * 收集事件解绑函数——子类在 mount() 中调用
   *
   * 所有通过 addEventListener 绑定的事件，都应通过此方法收集解绑函数。
   * destroy() 时统一调用，避免遗漏。
   *
   * @param cleanup 解绑函数（removeEventListener 的 wrapper）
   */
  protected trackEvent(cleanup: () => void): void {
    this._cleanups.push(cleanup);
  }

  /**
   * 获取根 DOM 元素——外部访问组件的唯一锚点
   *
   * 外部通过 component.el 访问根元素（如父组件 appendChild(child.el)）。
   * 但外部不应访问 el.children 或内部结构——el 是挂载锚点，不是内部 API。
   *
   * @returns 根 DOM 元素（未挂载时为 null）
   */
  getElement(): HTMLElement | null {
    return this.el;
  }
}
```

#### 3.1.3 统一导出口设计

```typescript
/**
 * components/index.ts - UI 组件库统一导出入口
 *
 * 集中导出所有公共组件，便于页面统一导入。
 * 组件按分类组织：基础组件 / 反馈组件 / 表单组件 / 导航组件 / 数据展示组件
 *
 * 依赖规则（对齐 ui-engineering-mindset-rules §四.3）：
 *   - 高层可依赖低层，低层不可依赖高层
 *   - data → navigation → form → feedback → base
 *
 * 使用方式：
 *   import { Component, Toast } from '@components/index.js';
 *
 * @module components
 */

/* ========== 基础组件 ========== */
export { Component } from './base/Component.js';

/* ========== 反馈组件 ========== */
// export { Toast } from './feedback/Toast/index.js';  // Phase 1 启用

/* ========== 表单组件 ========== */
// 待后续 Phase 填充

/* ========== 导航组件 ========== */
// 待后续 Phase 填充

/* ========== 数据展示组件 ========== */
// 待后续 Phase 填充
```

### 3.2 Phase 1：第一个 Component 验证（Toast 迁移）

#### 3.2.1 选择 Toast 的理由

1. **纯反馈组件**——无业务逻辑，无跨模块依赖
2. **复用频率高**——全局唯一实例，所有 Manager 都通过 `host.showToast()` 调用
3. **现有实现简单**——主要是 `show()` / `hide()` / 自动消失定时器
4. **验证点完整**——能验证 create / mount / update / destroy 四件套 + 事件绑定 + 定时器清理

#### 3.2.2 现有 Toast 实现位置

需先调研现有 Toast 实现：
- 候选位置 1：`hosts/memora-sprite/src/electron/renderer/infrastructure/toastManager.ts`
- 候选位置 2：内联在 UIManager 或某个 helper 中

**Phase 1 启动前的前置调研**：grep `showToast` / `Toast` 定位现有实现。

#### 3.2.3 ToastComponent 设计骨架

```typescript
/**
 * Toast 反馈组件
 *
 * 遵循 Component 统一生命周期（对齐 ui-engineering-mindset-rules §四.1）：
 *   - new(options)     创建实例（构造函数只合并配置）
 *   - mount(container) 挂载到 DOM（通常挂到 body）
 *   - update(options)  更新消息/类型/持续时间
 *   - destroy()        清理定时器 + 移除 DOM
 *
 * 与现有 ToastManager 的关系：
 *   - ToastManager 作为 Manager，持有 ToastComponent 实例
 *   - ToastManager 负责调用 component.update() 切换内容
 *   - ToastComponent 负责 DOM 操作 + 自动消失定时器
 */
export class ToastComponent extends Component<ToastOptions> {
  /** 默认配置 */
  static defaults: ToastOptions = {
    message: '',
    type: 'info',        // info | success | warning | error
    duration: 3000,      // 自动消失时长（ms），0 表示不消失
  };

  /** 自动消失定时器引用（destroy 时清理） */
  private _timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: Partial<ToastOptions>) {
    super({ ...ToastComponent.defaults, ...options });
  }

  mount(container: HTMLElement | string): this {
    /** 解析容器 */
    const target = typeof container === 'string'
      ? document.querySelector<HTMLElement>(container)
      : container;
    if (!target) return this;

    /** 创建根 DOM 元素 */
    this.el = document.createElement('div');
    this.el.className = `toast toast--${this.options.type}`;
    this.el.textContent = this.options.message;

    /** 绑定点击关闭事件（通过 trackEvent 收集解绑函数） */
    const handleClick = () => this.hide();
    this.el.addEventListener('click', handleClick);
    this.trackEvent(() => this.el?.removeEventListener('click', handleClick));

    /** 挂载到容器 */
    target.appendChild(this.el);

    /** 触发进入动画（下一帧添加 show 类） */
    requestAnimationFrame(() => this.el?.classList.add('toast--show'));

    /** 启动自动消失定时器 */
    this._startTimer();

    return this;
  }

  update(newOptions: Partial<ToastOptions>): this {
    /** 增量更新配置 */
    Object.assign(this.options, newOptions);

    if (!this.el) return this;

    /** 增量更新 DOM（不重建） */
    if (newOptions.message !== undefined) {
      this.el.textContent = newOptions.message;
    }
    if (newOptions.type !== undefined) {
      this.el.className = `toast toast--${newOptions.type}`;
    }

    /** 重启定时器 */
    this._startTimer();

    return this;
  }

  /** 隐藏 Toast（触发离开动画后移除） */
  hide(): void {
    if (!this.el) return;
    this.el.classList.remove('toast--show');
    /** 等待动画结束后 destroy */
    setTimeout(() => this.destroy(), 300);
  }

  destroy(): void {
    /** 清理定时器 */
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    /** 调用基类 destroy（清理事件 + 移除 DOM + nullify el） */
    super.destroy();
  }

  /** 启动自动消失定时器 */
  private _startTimer(): void {
    if (this._timer) {
      clearTimeout(this._timer);
    }
    if (this.options.duration > 0) {
      this._timer = setTimeout(() => this.hide(), this.options.duration);
    }
  }
}

/** Toast 配置类型 */
interface ToastOptions {
  /** 消息内容 */
  message: string;
  /** 类型：info | success | warning | error */
  type: 'info' | 'success' | 'warning' | 'error';
  /** 自动消失时长（ms），0 表示不消失 */
  duration: number;
}
```

### 3.3 改动文件清单（Phase 0 + Phase 1）

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `components/base/Component.ts` | **新增** | Component 抽象基类（~120 行） |
| `components/index.ts` | **新增** | 统一导出口（~15 行，含注释） |
| `components/feedback/Toast/ToastComponent.ts` | **新增** | ToastComponent 实现（~100 行） |
| `components/feedback/Toast/style.css` | **新增** | Toast 样式（从现有 toast 样式提取） |
| 现有 Toast 调用方 | **修改** | 改为通过 ToastComponent.create() 调用（待调研后确定具体文件） |
| `infrastructure/toastManager.ts`（如存在） | **修改** | 内部改为持有 ToastComponent 实例 |

### 3.4 验证计划（Phase 0 + Phase 1）

#### 3.4.1 编译器验证

```bash
cd hosts/memora-sprite && npx tsc --noEmit
```

预期 0 错误。

#### 3.4.2 测试验证

```bash
cd hosts/memora-sprite && npx vitest run
```

关注点：
- 现有 Toast 相关测试（如有）通过
- 新增 ToastComponent 单元测试：
  - `create + mount` 后 `el` 非空
  - `update` 后 `textContent` 正确更新
  - `destroy` 后 `el` 为 null，定时器已清理
  - 自动消失定时器在 `duration` 后触发 `hide`

#### 3.4.3 样式门

```bash
cd hosts/memora-sprite && npm run lint:css
```

0 错误。

#### 3.4.4 功能回归

- 触发各种 Toast（success / error / warning / info）显示正常
- Toast 自动消失后 DOM 已移除（用 DevTools Elements 面板确认）
- 快速连续触发 Toast 无残留 DOM

---

## 四、不提取的归档

按 [progressive-refactor-rules.md](../.trae/rules/progressive-refactor-rules.md) §5.2 的 3 次阈值 + 领域内聚度判定：

| 项目 | 不做理由 |
|------|---------|
| **一次性重写所有 Manager** | 70+ TS 文件，改动量过大，违反渐进式原则。采用触发式迁移 |
| **引入虚拟 DOM 框架（React/Lit）** | 违反"零依赖内核"原则（ADR-002），且审计报告自己也反对。Component 基类是轻量替代方案 |
| **照搬 meta-stock 的 hash 路由** | sprite 是 Electron 多窗口，已用 `BrowserWindow.loadFile()` 隔离。hash 路由适用于 Web SPA，不适用于 Electron |
| **照搬 meta-stock 的 4 种页面范式** | sprite 的面板类型与进销存系统不同。声明式工厂的触发条件是"3 个以上结构相似面板"，不是"照搬范式" |
| **重写 BEM 命名体系** | sprite CSS 层已 9.5/10，是项目最强维度。本方案专注 JS 层，不动 CSS 层 |
| **Phase 0 单独完成不验证** | 空壳基础设施无意义。Phase 0 必须与 Phase 1 一起做，用 Toast 验证基类设计 |
| **提前抽 ListPanel 工厂** | 当前未确认有 3 个以上结构相似面板。需先统计记忆/审计/设置文件列表的结构相似度，满足阈值后再启动 Phase 3 |

---

## 五、后续演进路径

### 5.1 Phase 2-4 触发条件

| Phase | 触发条件 | 候选 | 评估时机 |
|-------|---------|------|---------|
| Phase 2 | Phase 1 验证通过 + 涉足 Chat 域 | MessageBubble（ChatPanelManager 内部） | 下次修改 ChatPanelManager 时 |
| Phase 3 | 3 个以上结构相似面板 | ListPanel 工厂 | 统计面板结构相似度后 |
| Phase 4 | 单 Manager > 1200 行 | ChatPanelManager DOM 操作下沉 | ChatPanelManager 行数监控 |

### 5.2 终态愿景

```
sprite JS 层组件抽象终态（远景，非本方案范围）
  │
  ├── components/
  │     ├── base/        Component, Button, Icon
  │     ├── feedback/    Toast, Modal, Confirm, Empty, Skeleton
  │     ├── form/        Input, Select, FormBuilder
  │     ├── navigation/  Layout, PageHeader, Tabs
  │     └── data/        DataTable, ListPanel（工厂）, SearchPanel
  │
  ├── managers/（原 PanelManager，瘦身后）
  │     ├── ChatPanelManager       持有 MessageListComponent + InputComponent
  │     ├── MemoryPanelManager     持有 ListPanel（工厂）+ DetailComponent
  │     └── ...
  │
  └── coordination/（HEAL-16 已建立）
        ├── ChatCoordinator
        ├── MemoryCoordinator
        └── SettingsCoordinator
```

### 5.3 与 HEAL-16 的协同

HEAL-16（Coordinator 提取）解决了 UIManager 字段数问题，本方案（HEAL-17）解决 Manager 内部 DOM 操作问题。两者正交：

- **HEAL-16 路径**：UIManager → Coordinator → Manager（字段路径变化）
- **HEAL-17 路径**：Manager → Component → DOM（内部结构变化）

Coordinator 不感知 Component，Component 不感知 Coordinator。两者可独立演进。

---

## 六、验证计划（总体）

### 6.1 Phase 0 + Phase 1 验证

见 §3.4。

### 6.2 规则更新验证

规则文件更新后，需在后续 UI 开发中验证：
- 新写的 JS 组件是否遵循 `create/mount/update/destroy` 四件套
- 新增组件是否注册到 `components/index.ts`
- Manager 是否通过 Component 实例操作 DOM，而非直接 createElement

### 6.3 审计分数提升预期

| 维度 | 审计前（2026-07-28） | Phase 1 后预期 | 终态预期 |
|------|---------------------|---------------|---------|
| §四 组件化 | 6.0/10 | 6.5/10（基类就绪 + 1 个验证组件） | 8.0/10（多组件迁移 + 工厂就绪） |

---

## 七、实施完成（Phase 0 + Phase 1）

### 7.1 实施日期

2026-07-28

### 7.2 实际修改文件清单

| 文件 | 变更类型 | 行数 | 说明 |
|------|---------|------|------|
| `hosts/memora-sprite/src/electron/renderer/components/Component.ts` | **新增** | 170 行 | Component 抽象基类，含 create/mount/destroy/trackEvent/getElement/isDestroyed |
| `hosts/memora-sprite/src/electron/renderer/components/index.ts` | **新增** | 32 行 | 统一导出口，导出 Component + ToastComponent |
| `hosts/memora-sprite/src/electron/renderer/components/toastComponent.ts` | **新增** | 280 行 | ToastComponent 单实例组件，含 hide/cancelAutoDismiss |
| `hosts/memora-sprite/src/electron/renderer/components/toast.ts` | **重写** | 99 行 | ToastManager 委托 ToastComponent，公共 API 不变 |
| `hosts/memora-sprite/.trae/rules/directory-structure.md` | **修改** | §1 components/ 节 | 补登 Component.ts + index.ts + toastComponent.ts + toast.ts 注释 |
| `.trae/rules/ui-engineering-mindset-rules.md` | **修改** | §四 + §五 + §六 | 新增 §四.1~§四.4 + §五 JS 层嫁接列 + §六 8 问 + 判定流程图 |

### 7.3 设计调整记录

实施过程中相对原方案的 3 处调整：

#### 调整 1：Component.ts 位置改为平铺（非分层）

**原方案**：`components/base/Component.ts`（分层目录）
**实际**：`components/Component.ts`（平铺）

**原因**：directory-structure.md §1 规定"禁止单文件目录"。base/ 目录若只有 Component.ts 会违反规则。
**未来触发**：当 components/ 文件数达到 15+ 时，再启动分层（base/feedback/form/navigation/data）。

#### 调整 2：ToastComponent 重试/操作按钮调用 hide() 而非 destroy()

**原方案**：按钮 click → `this.destroy()` + 回调
**实际**：按钮 click → `this.hide()` + 回调

**原因**：测试期望按钮 click 后 toast 添加 `leaving` 类触发离场动画，animationend 后才移除 DOM。直接 destroy 会跳过动画，破坏视觉一致性。

#### 调整 3：ToastManager.cleanup() 调用 cancelAutoDismiss() 而非 destroy()

**原方案**：`cleanup()` 遍历 `component.destroy()`
**实际**：`cleanup()` 遍历 `component.cancelAutoDismiss()`

**原因**：测试期望 cleanup 后 toast DOM 仍存在（只停止定时器）。这是 ToastManager 的特殊语义——"切换面板时停止自动消失，但保留已显示 Toast 让用户看到残留内容"。

**新增方法**：ToastComponent.cancelAutoDismiss()——只清理定时器，不移除 DOM。与 destroy() 形成对比：
- `cancelAutoDismiss()`：停定时器，DOM 保留
- `destroy()`：停定时器 + 移除 DOM + nullify 引用

### 7.4 验证结果

#### 7.4.1 编译器验证

```bash
cd hosts/memora-sprite && npx tsc --noEmit
```

**结果**：0 错误。

#### 7.4.2 测试验证

```bash
cd hosts/memora-sprite && npx vitest run src/__tests__/electron/renderer/toast.test.ts
```

**结果**：27/27 全部通过。

| 测试组 | 用例数 | 状态 |
|--------|--------|------|
| showToast · 容器缺失 | 1 | ✅ |
| showToast · FIFO 限制 | 3 | ✅ |
| showToast · 类型图标 | 4 | ✅ |
| showToast · role 属性 | 2 | ✅ |
| showToast · 重试按钮 | 3 | ✅ |
| showToast · 自定义操作按钮 | 3 | ✅ |
| showToast · 关闭按钮 | 2 | ✅ |
| showToast · 自动消失 | 6 | ✅ |
| cleanup | 3 | ✅ |

#### 7.4.3 样式门

```bash
cd hosts/memora-sprite && npm run lint:css
```

**结果**：0 错误。

#### 7.4.4 预存在失败说明

全量 vitest 运行有 86 个失败在 `uiDelegations.test.ts` 的 settingsModalDelegations 部分。经 git stash 验证：**这些失败是预先存在的**，与 HEAL-17 修改无关。失败特征是"mock.settingsPanelManager.xxx 没被调用"，属于 mixin 委托测试的 mock 初始化问题，已归档待后续处理。

### 7.5 额外发现

1. **ToastManager 已有完整测试覆盖**——27 个测试覆盖容器缺失/FIFO/图标/role/重试/操作/关闭/自动消失/cleanup 全场景。Component 基类设计需与现有测试期望对齐，不能为了"纯粹的 Component 生命周期"破坏现有行为。

2. **Component 生命周期与 Manager 特殊语义的兼容**——ToastManager.cleanup() 的"只停定时器不移除 DOM"是 Manager 层的特殊语义。Component 通过新增 `cancelAutoDismiss()` 方法支持此语义，避免在基类中塞入过多特殊行为。

3. **trackEvent 的使用边界**——最初在 `_startTimer()` 中通过 `trackEvent` 收集定时器清理，但 update 重启定时器时会重复堆积清理函数。修复方案：定时器清理在 `destroy()` override 中直接处理，不通过 `trackEvent`。这为后续 Component 子类提供了参考——单一引用的资源直接在 override 中清理，多引用的资源才用 `trackEvent` 收集。

### 7.6 审计分数提升

| 维度 | Phase 1 前 | Phase 1 后 |
|------|-----------|------------|
| §四 组件化 | 6.0/10 | **6.5/10**（基类就绪 + 1 个验证组件 + 27 测试覆盖） |

### 7.7 后续演进

Phase 2-4 保持触发式（见 §5.1）：

| Phase | 触发条件 | 候选 |
|-------|---------|------|
| Phase 2 | 涉足 Chat 域 + Phase 1 验证通过 ✅ | MessageBubble（ChatPanelManager 内部） |
| Phase 3 | 3 个以上结构相似面板 | ListPanel 工厂（已调研：审计/记忆/设定三面板结构差异大，**不达触发条件**） |
| Phase 4 | 单 Manager > 1200 行 | ChatPanelManager DOM 操作下沉（当前 ~900 行，临界） |

**Phase 1 验证结论**：Component 基类设计可行，ToastComponent 迁移成功，Manager→Component 协作模式验证通过。可作为后续 Phase 2-4 的参考模式。

---

## 八、禁止事项对照

按 [progressive-refactor-rules.md](../.trae/rules/progressive-refactor-rules.md) §9 逐项自检：

| 规则 | 本方案是否遵守 |
|------|----------------|
| ❌ 跳过方案设计直接改代码 | ✅ 本文档即方案设计 |
| ❌ 单轮提取多个领域 | ✅ Phase 0+1 仅建设基础设施 + 验证 1 个组件 |
| ❌ 提取未达 3 次阈值的逻辑 | ✅ Phase 3 明确等待 3 个以上相似面板触发 |
| ❌ 在容器类中夹带业务逻辑 | ✅ Component 基类是抽象，无业务逻辑 |
| ❌ 提取时顺便优化无关代码 | ✅ Phase 0+1 仅新增，不动现有代码（除 Toast 调用方） |
| ❌ 修改后跳过全量测试验证 | ✅ 见 §3.4 |
| ❌ 跳过炼化归元收尾直接提交 | ✅ 见 §7 |
| ❌ 使用 `null! as Type` | ✅ 使用 `!:` definite assignment 或 null 检查 |
| ❌ 在跨 Service 依赖中构造函数注入 | ✅ Component 不涉及跨 Service 依赖 |

---

## 九、决策点（需用户确认）

在开始任何代码改动前，需确认：

### 9.1 是否立即启动 Phase 0 + Phase 1？

| 选项 | 说明 |
|------|------|
| **A（推荐）** | 立即启动 Phase 0 + Phase 1。用 Toast 验证 Component 基类设计，为后续触发式迁移打基础 |
| **B** | 归档等待触发。等涉足新面板开发或某个 Manager 难以维护时再启动 |
| **C** | 仅启动 Phase 0（基础设施建设），不立即做 Phase 1（不推荐——空壳基础设施无意义） |

### 9.2 第一个 Component 候选确认

| 候选 | 理由 | 风险 |
|------|------|------|
| **Toast（推荐）** | 纯反馈，无业务逻辑，复用频率高，验证点完整 | 低 |
| Empty State | 纯展示，更简单 | 极低（但验证点较少） |
| Loading Spinner | 纯动画 | 极低（但验证点更少） |
| 其他建议 | — | — |

### 9.3 Phase 2-4 的触发式策略是否认可？

- Phase 2（MessageBubble）：下次修改 ChatPanelManager 时触发
- Phase 3（ListPanel 工厂）：统计面板结构相似度后触发
- Phase 4（Manager 迁移）：单 Manager > 1200 行时触发

如果认可触发式策略，Phase 2-4 不在本方案范围内，各自触发时单独写方案文档。

---

*本方案遵循 progressive-refactor-rules.md 全部约束：先方案后代码、单轮一域、纯状态容器、3 次阈值判定、禁止顺便优化。同时吸收 meta-stock 的统一生命周期 API + 声明式工厂 + 组件分层导出理念，拒绝照搬 hash 路由 / 纯 JS / BEM 重写。*
