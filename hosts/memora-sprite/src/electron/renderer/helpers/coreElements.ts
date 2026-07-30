/**
 * 核心交互元素容器 — UIManager 私有 DOM 引用集中管理
 *
 * 职责：
 * - 持有 UIManager 的核心 DOM 元素引用（消息容器 / 输入框 / 按钮 / 徽章 / 状态指示器）
 * - 纯状态容器，不持有业务逻辑（progressive-refactor-rules §4 模式 A）
 *
 * 设计原则：
 * - 字段语法：`!:` definite assignment（原 UIManager 构造函数赋值，progressive-refactor-rules §4）
 * - 业务逻辑保留在 UIManager + mixin 委托方法
 * - mixin 委托方法（helpers/ui-delegations/）不访问 private 字段，提取到容器不影响 HEAL-13 红线
 *
 * 字段分类：
 * - 必需元素（fast-fail）：messagesEl / inputEl / btnSend / btnStop —— 缺失时抛出
 * - 可选元素（降级）：badge / btnMaximize / chatAgentStatusEl —— 缺失时降级
 *
 * 来源：MIND2-D2 从 UIManager 提取 7 个 private DOM 字段为单一容器（字段数 31 → 25）。
 */

// ─── CoreElements 容器类 ─────────────────────────────────

/**
 * 核心交互元素容器
 *
 * 由 UIManager 构造函数创建并赋值，UIManager 内部通过 `this.coreElements.xxx` 路径访问。
 * 不暴露给外部模块（UIManager 作为唯一持有者）。
 */
export class CoreElements {
  // ─── 必需元素（缺失时抛出，UI 无法工作） ────────────────
  /** 消息容器元素（聊天消息列表的根容器） */
  messagesEl!: HTMLElement;
  /** 输入框元素（用户输入文本区域） */
  inputEl!: HTMLTextAreaElement;
  /** 发送按钮（空闲态可见，发送用户消息） */
  btnSend!: HTMLButtonElement;
  /** 停止生成按钮（流式态时可见，独立于发送按钮，对齐 demo v3 .btn-stop-float） */
  btnStop!: HTMLButtonElement;

  // ─── 可选元素（缺失时降级，不阻塞其他功能） ──────────────
  /** 未读计数徽章（标题栏右上角，部分布局可能未提供该元素） */
  badge: HTMLElement | null = null;
  /** 最大化按钮（标题栏右侧，用于图标切换 □ ↔ ❐，部分布局无标题栏） */
  btnMaximize: HTMLButtonElement | null = null;
  /** 聊天面板 Agent 状态指示器（输入区上方，门面体验：让用户看到初始化进度） */
  chatAgentStatusEl: HTMLElement | null = null;
}
