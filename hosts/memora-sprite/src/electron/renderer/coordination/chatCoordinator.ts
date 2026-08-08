/**
 * Chat 域二级协调器
 *
 * 封装对话相关的 5 个子模块，共享同一条数据管道：
 * 用户输入 → LLM 流式输出 → 消息列表渲染 + 主动提示
 *
 * 设计原则（对齐 PerceptionCoordinator 模式）：
 * - 纯状态容器 + cleanup 集中清理（不持有业务逻辑，业务逻辑仍在 UIManager + mixin）
 * - 字段公开暴露，chatDelegations mixin 直接读写
 * - 初始化仍在 UIManager 构造函数（chatPanel 依赖 ChatPanelHost 反向注入）
 *
 * 集成点：
 * - UIManager 持有 chatCoordinator 实例并挂载到 this.chatCoordinator
 * - chatDelegations.ts 通过 this.chatCoordinator.chatPanel 等访问
 * - UIManager.cleanup() 调用 chatCoordinator.cleanup() 集中清理
 */

import type { ChatPanelManager } from '../panels/chatPanelManager.js';
import type { InputAreaManager } from '../panels/inputAreaManager.js';
import type { TaskTablePanelManager } from '../panels/taskTablePanelManager.js';
import type { ProactiveBanner } from '../components/proactiveBanner.js';
import type { SuggestionCardManager } from '../components/suggestionCard.js';

/**
 * Chat 域二级协调器类
 *
 * 集中管理对话相关的 5 个子模块，避免分散在 UIManager 中。
 * 退出时通过 cleanup() 集中调用各子模块的清理方法，确保流式安全定时器、
 * ResizeObserver、事件监听器等正确释放。
 */
export class ChatCoordinator {
  /** 聊天面板管理器（消息渲染、流式输出、工具卡片），UIManager 构造函数初始化 */
  chatPanel!: ChatPanelManager;
  /** 输入区域管理器（输入框事件 + 发送按钮状态 + ResizeObserver），UIManager 构造函数初始化 */
  inputAreaManager!: InputAreaManager;
  /** P1-5: 任务表面板管理器（渲染 checkpoint plan + 草稿区），UIManager 构造函数初始化 */
  taskTablePanelManager!: TaskTablePanelManager;
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
