/**
 * MessageBubbleComponent - 单条消息气泡组件（HEAL-17 Phase 2）
 *
 * 遵循 Component 统一生命周期（对齐 ui-engineering-mindset-rules §四.1）：
 *   - create(options)  创建实例（不构建 DOM）
 *   - mount(container) 构建 DOM + 挂载到容器（支持 DocumentFragment 批量插入）
 *   - update(options)  增量更新（streaming 状态切换 / persona 变更）
 *   - destroy()        移除 DOM（事件由事件委托处理，无需解绑）
 *
 * 与 ChatPanelManager 的关系（对齐 §四.4 Manager 与 Component 边界）：
 *   - ChatPanelManager 作为 Manager，负责消息列表编排（分组 / 日期 / 滚动 / 未读计数）
 *   - Manager 通过 `new MessageBubbleComponent(options).build()` 创建实例并获取 DOM
 *   - Manager 通过 `component.getElement()` 在需要时获取 DOM 元素（如流式消息映射）
 *   - Component 不绑定交互事件（copy / retry 等仍由 chatPanelEvents 事件委托处理）
 *
 * 设计决策（详见方案-HEAL-17-Phase2-MessageBubbleComponent-20260728.md §2.4）：
 *   - 不在 Component 内绑定 copy 按钮点击——保留现有事件委托模式，避免破坏 chatPanelEvents
 *   - 不接管流式渲染——streamingRenderer 已独立且成熟，Component 仅提供初始 streaming 光标
 *   - mount 支持 DocumentFragment——appendMessages 批量插入优化
 *   - 提供 build() 便捷方法——内部 mount 到临时 fragment 后返回 HTMLElement，调用方自行 appendChild
 *
 * DOM 结构（与原 ChatPanelManager.buildMessageElement 100% 一致，零行为变化）：
 *   <div class="message {role}[ streaming][ grouped]" data-message-id="{id}" tabindex="0">
 *     <div class="message-avatar">…SVG 图标…</div>              ← 仅非 grouped 的 user/assistant
 *     <div class="message-content">
 *       <div class="message-bubble">
 *         {Markdown 渲染（assistant）| textContent（user）}
 *         <div class="memory-recall">…召回记忆…</div>            ← 仅 assistant + memoryRecall
 *         <span class="cursor"></span>                           ← 仅 streaming
 *       </div>
 *       <div class="message-meta">
 *         <span class="message-persona">{角色名}</span>          ← 仅 assistant + persona
 *         <div class="message-actions">                          ← 仅 hasPersonaLabel
 *           <button class="message-copy-btn" data-action="copy" data-content="…" aria-label="复制">…SVG…</button>
 *           <div class="message-time">{HH:MM}</div>
 *         </div>
 *       </div>
 *     </div>
 *   </div>
 *
 * 系统消息简单结构：
 *   <div class="message system">{content}</div>
 */

import { Component } from '../base/Component.js';
import type { Message } from '../../types.js';
// 复用 domHelpers 的时间格式化，避免逻辑重复
import { formatTimestamp } from '../../helpers/domHelpers.js';
// 复用 icon helper 设置 SVG 图标，统一视觉风格
import { setIcon } from '../../helpers/icon.js';
// 复用 markdown 渲染器，与 streamingRenderer 保持一致的渲染口径
import { renderMarkdown } from '../markdown.js';
// 复用角色名格式化，与现有 ChatPanelManager 行为一致
import { formatPersonaDisplayName } from '../../helpers/personaLabel.js';
// 复用召回记忆容器构建逻辑，避免重复实现
import { createRecallContainer as buildRecallContainer } from '../../helpers/messageDecorations.js';

/**
 * MessageBubbleComponent 配置
 *
 * 与 Message 类型（来自 types.ts）的区别：
 *   - Message 是数据层类型（描述一条消息的数据结构）
 *   - MessageBubbleOptions 是组件层配置（包含 Message + 渲染选项 grouped）
 */
export interface MessageBubbleOptions {
  /** 消息对象（含 role/content/timestamp/persona/memoryRecall/streaming/messageId） */
  message: Message;
  /** 是否为分组消息（同角色连续消息合并，省略头像） */
  grouped: boolean;
}

/**
 * MessageBubbleComponent - 单条消息气泡组件
 *
 * 一条消息 = 一个 MessageBubbleComponent 实例。
 * ChatPanelManager 持有多个实例，通过 message-group 容器编排分组。
 */
export class MessageBubbleComponent extends Component<MessageBubbleOptions> {
  /**
   * 构造函数——只合并配置，无副作用
   *
   * 显式声明 public 以覆盖基类 protected constructor，
   * 允许 ChatPanelManager 通过 `new MessageBubbleComponent(options)` 创建实例。
   * 与 ToastComponent 同模式（ToastComponent 亦显式声明 public constructor）。
   *
   * @param options 消息气泡配置（message + grouped）
   */
  constructor(options: MessageBubbleOptions) {
    super(options);
  }

  /**
   * 挂载到容器——构建 DOM + 挂载
   *
   * 覆盖基类签名以支持 DocumentFragment（appendMessages 批量插入优化）。
   * TypeScript 允许子类方法参数类型更宽泛（协变），基类签名保持不变。
   *
   * @param container 容器元素 / DocumentFragment / 选择器
   * @returns this（链式调用）
   */
  mount(container: HTMLElement | DocumentFragment | string): this {
    /** 解析容器（string → HTMLElement，DocumentFragment 直接使用） */
    const target = typeof container === 'string'
      ? document.querySelector<HTMLElement>(container)
      : container;
    if (!target) return this;

    /** 构建完整 DOM 结构并赋值给 this.el */
    this._buildDOM();

    /** 挂载到容器（DocumentFragment.appendChild 与 HTMLElement.appendChild 接口一致） */
    target.appendChild(this.el!);

    return this;
  }

  /**
   * 便捷构建方法——构建 DOM 但不挂载到真实容器
   *
   * 内部使用临时 DocumentFragment 挂载（不进入 DOM 树），
   * 调用方通过返回值获取 HTMLElement 后自行 appendChild。
   *
   * 使用场景：
   *   - appendMessage 需要将元素添加到 message-group 容器
   *   - appendMessages 批量插入到 fragment 优化回流
   *
   * @returns 根 DOM 元素（已构建但未挂载到真实容器）
   */
  build(): HTMLElement {
    /** 使用临时 fragment 挂载（fragment 不进入 DOM 树，仅用于收集元素） */
    const fragment = document.createDocumentFragment();
    this.mount(fragment);
    /** 此时 this.el 已赋值，但元素在 fragment 内（未挂载到真实 DOM） */
    return this.el!;
  }

  /**
   * 增量更新内部状态——不重建 DOM
   *
   * 当前 MessageBubbleComponent 的使用场景是单次渲染后由 streamingRenderer 接管流式更新，
   * update 较少被调用。保留 update 以满足 Component 契约，未来可用于：
   *   - streaming 状态切换（添加/移除 streaming class）
   *   - persona 变更（更新角色标签）
   *
   * @param newOptions 新的配置项（部分字段可选）
   * @returns this（链式调用）
   */
  update(newOptions: Partial<MessageBubbleOptions>): this {
    /** 合并配置 */
    Object.assign(this.options, newOptions);

    if (!this.el) return this;

    /** streaming 状态切换：添加/移除 streaming class */
    if (newOptions.message?.streaming !== undefined) {
      this.el.classList.toggle('streaming', !!newOptions.message.streaming);
    }

    return this;
  }

  /**
   * 构建 DOM 结构——内部方法
   *
   * 严格对齐原 ChatPanelManager.buildMessageElement 的实现，确保 DOM 结构 100% 一致。
   * 不绑定交互事件（保留事件委托模式）。
   */
  private _buildDOM(): void {
    /** 解构配置，避免在 DOM 构建逻辑中反复访问 this.options */
    const { message, grouped } = this.options;

    /** 根元素：div.message.{role}[.streaming][.grouped] */
    const el = document.createElement('div');
    el.className = `message ${message.role}${message.streaming ? ' streaming' : ''}${grouped ? ' grouped' : ''}`;
    if (message.messageId) {
      el.dataset.messageId = message.messageId;
    }

    /** 系统消息：简单文本，居中无头像，提前 return */
    if (message.role === 'system') {
      el.textContent = message.content;
      this.el = el;
      return;
    }

    /** 非系统消息可聚焦（tabindex=0），支持 Shift+F10/Menu 键触发右键菜单 */
    el.tabIndex = 0;

    /** 用户/精灵消息：头像 + 气泡结构（分组模式下省略头像） */
    if (!grouped) {
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar flex-shrink-0';
      // 使用 SVG 图标替代 emoji，统一视觉风格（user → 人物图标，assistant → 精灵图标）
      const iconId = message.role === 'user' ? 'icon-person' : 'icon-fairy';
      setIcon(avatar, iconId);
      el.appendChild(avatar);
    }

    /** 消息内容容器（气泡 + 时间戳 + 操作按钮） */
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'message-content';

    /** 气泡元素——承载消息正文 */
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    if (message.role === 'assistant') {
      // 精灵消息：渲染 Markdown（renderMarkdown 返回 DocumentFragment，包含格式化后的 HTML）
      bubble.appendChild(renderMarkdown(message.content));
    } else {
      // 用户消息：使用 textContent（防 XSS，不解析 HTML）
      bubble.textContent = message.content;
    }
    contentWrapper.appendChild(bubble);

    /**
     * 元信息行：复制按钮 + 时间戳同行显示
     * 精灵消息（assistant）含 persona 时采用两端对齐：左侧角色名，右侧操作按钮组
     */
    const metaRow = document.createElement('div');
    metaRow.className = 'message-meta';

    /**
     * 精灵消息且携带 persona：左侧显示角色名标签
     * 让用户明确知道是哪个角色在回答
     * 历史消息不携带 persona，不显示角色标签（不持久化，符合"用户只需知道当前角色"决策）
     */
    const hasPersonaLabel = message.role === 'assistant' && !!message.persona;
    if (hasPersonaLabel) {
      const personaLabel = document.createElement('span');
      personaLabel.className = 'message-persona';
      personaLabel.textContent = formatPersonaDisplayName(message.persona!);
      metaRow.appendChild(personaLabel);
    }

    /**
     * 操作按钮组：复制按钮 + 时间戳
     * 有角色标签时包裹为右侧 .message-actions 容器（两端对齐）
     * 无角色标签时直接挂在 metaRow（左对齐）
     */
    const actionsContainer = hasPersonaLabel
      ? document.createElement('div')
      : metaRow;
    if (hasPersonaLabel) {
      actionsContainer.className = 'message-actions';
    }

    /**
     * 复制按钮（hover 时显示）
     * 用户/精灵消息均添加复制按钮（原仅精灵消息有，用户消息需手动选择文本，体验不一致）
     * 流式消息不显示复制按钮（内容未完成）
     *
     * 事件绑定说明：
     *   - 通过 data-action="copy" 标识，由 chatPanelEvents 事件委托统一处理
     *   - Component 内不 addEventListener，保留事件委托模式
     */
    if (!message.streaming) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'message-copy-btn';
      copyBtn.title = '复制';
      // aria-label 为屏幕阅读器提供可访问名称（icon-only 按钮必需）
      copyBtn.setAttribute('aria-label', '复制');
      // 使用 SVG 图标替代 emoji
      setIcon(copyBtn, 'icon-copy');
      // data-action 属性由事件委托监听器统一处理（chatPanelEvents.ts）
      copyBtn.dataset.action = 'copy';
      copyBtn.dataset.content = message.content;
      actionsContainer.appendChild(copyBtn);
    }

    /** 时间戳：复用 domHelpers.formatTimestamp 统一时间格式化口径 */
    const timestamp = message.timestamp ?? new Date().toISOString();
    const timeEl = document.createElement('div');
    timeEl.className = 'message-time';
    timeEl.textContent = formatTimestamp(timestamp);
    actionsContainer.appendChild(timeEl);

    /** 有角色标签时，actionsContainer 需挂到 metaRow */
    if (hasPersonaLabel) {
      metaRow.appendChild(actionsContainer);
    }

    contentWrapper.appendChild(metaRow);

    el.appendChild(contentWrapper);

    /**
     * 召回记忆提示（仅精灵消息且 memoryRecall 非空时）
     * 委托到 messageDecorations helper 构建召回记忆容器
     */
    const memoryRecall = message.memoryRecall;
    if (message.role === 'assistant' && memoryRecall && memoryRecall.length > 0) {
      const recallContainer = buildRecallContainer(memoryRecall);
      bubble.appendChild(recallContainer);
    }

    /**
     * 流式消息光标（streaming=true 时显示）
     * 后续流式更新由 streamingRenderer 接管，Component 仅提供初始光标
     */
    if (message.streaming) {
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      bubble.appendChild(cursor);
    }

    this.el = el;
  }
}
