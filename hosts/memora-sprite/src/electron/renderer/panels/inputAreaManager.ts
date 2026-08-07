/**
 * 输入区域管理器
 *
 * 从 UIManager 拆分，统一管理输入区域的 UI 联动。
 *
 * 职责：
 * - 输入框键盘事件处理（Enter 发送/停止、Esc 清空/失焦）
 * - 输入框内容变化处理（自适应高度 + 发送按钮视觉反馈）
 * - 发送按钮点击处理（触发发送回调）
 * - 输入区 ResizeObserver（动态更新 --input-area-height CSS 变量）
 * - 输入清理 + 长度限制
 * - 输入补全集成（复用 QuickInputCompletion，输入时显示记忆/对话候选）
 * - 暂停/恢复按钮管理（不中断工作模型，根据会话状态切换按钮禁用态）
 *
 * 设计原则：
 * - 依赖注入：通过 InputAreaHost 接口注入 UIManager 的状态查询和回调，
 *   与 ChatPanelManager/ClipboardManager 同模式
 * - 自包含 EventTracker，init() 绑定事件，cleanup() 统一清理
 * - 不持有流式状态，通过 host.isStreaming() 查询
 * - Agent 就绪/空内容守卫保留在 UIManager.emitSendMessage 内部，
 *   InputAreaManager 仅负责 UI 联动，不重复守卫逻辑
 * - 补全管理器复用 quick-input 模块的 QuickInputCompletion，零重复造轮子
 * - 暂停/恢复按钮通过 onSessionStatusChanged 监听器同步状态，
 *   按钮创建与监听器绑定在 init() 中完成，cleanup() 中清理
 */

import type { EventTracker } from '../helpers/eventTracker.js';
// reportError 统一错误日志（双通道：console + 主进程 logger），替代散落的 console.error
import { reportError } from '../helpers/errorHelpers.js';
// 复用 quick-input 补全管理器（已泛化支持 textarea）
import { QuickInputCompletion } from '../quick-input/quickInputCompletion.js';
import type { CompletionItem } from '../quick-input/quickInputCompletion.js';
import { fetchMemoryContent } from '../helpers/completionHelpers.js';
// Provider 选择器组件（封装 selector/name/dropdown DOM 操作，对齐 ARCH-COMP-1 阶段4）
import { ProviderSelectorComponent } from '../components/data/providerSelectorComponent.js';
// Token 用量指示器组件（封装 usage/text/fill DOM 操作，对齐 ARCH-COMP-1 阶段4）
import { TokenUsageComponent } from '../components/data/tokenUsageComponent.js';

/**
 * 输入区域宿主接口
 *
 * UIManager 实现此接口，向 InputAreaManager 提供状态查询和回调。
 * 与 ChatPanelHost/MemoryPanelHost 同模式。
 */
export interface InputAreaHost {
  /** 查询当前是否正在流式输出（决定 Enter 键触发发送还是停止） */
  isStreaming(): boolean;
  /** 触发发送消息（由输入框 Enter 或发送按钮点击触发，含 Agent 就绪/空内容守卫） */
  emitSendMessage(): void;
  /** 触发停止流式输出（由输入框 Enter 触发） */
  emitStopMessage(): void;
  /** 跳转到设置面板（Provider 未配置时由选择器空状态提示项触发） */
  switchToSettings(): void;
}

/** 输入内容最大长度（超出部分截断，防止超长输入撑爆 LLM 上下文） */
const MAX_INPUT_LENGTH = 10000;
/** 输入框自适应高度上限（像素，超出后滚动而非继续撑高） */
const MAX_INPUT_HEIGHT = 120;

/**
 * 输入区域管理器类
 *
 * 职责：输入框事件 + 发送按钮状态 + ResizeObserver + 输入清理
 * 依赖：InputAreaHost（状态查询 + 回调）+ EventTracker（事件清理）
 * 生命周期：init() 绑定事件 + 启动 observer，cleanup() 清理
 */
export class InputAreaManager {
  /** 输入区 ResizeObserver（监听 #input-area 高度变化），null 表示元素缺失或环境不支持 */
  private resizeObserver: ResizeObserver | null = null;

  /** Provider 选择器组件（封装 selector/name/dropdown DOM 操作 + 事件 + 渲染） */
  private providerSelectorComponent: ProviderSelectorComponent;
  /** Token 用量指示器组件（封装 usage/text/fill DOM 操作 + 状态渲染） */
  private tokenUsageComponent: TokenUsageComponent;
  /** 上下文窗口大小（token 数，不同模型不同，默认 32K） */
  private static readonly DEFAULT_CONTEXT_TOKENS = 32768;

  /** 输入补全管理器（复用 quick-input 模块，null 表示候选列表容器缺失时降级跳过） */
  private completion: QuickInputCompletion | null = null;

  /** 暂停会话按钮（不中断工作模型，暂停态时禁用），null 表示元素缺失 */
  private btnPause: HTMLButtonElement | null = null;
  /** 恢复会话按钮（不中断工作模型，仅暂停态时启用），null 表示元素缺失 */
  private btnResume: HTMLButtonElement | null = null;

  /**
   * 构造函数：注入 DOM 元素 + 事件跟踪器 + 宿主接口
   *
   * @param inputEl 输入框元素（textarea）
   * @param btnSend 发送按钮元素
   * @param events 事件跟踪器（独立实例，cleanup 时统一清理）
   * @param host 宿主接口（提供流式状态查询 + 发送/停止回调）
   */
  constructor(
    private readonly inputEl: HTMLTextAreaElement,
    private readonly btnSend: HTMLButtonElement,
    private readonly events: EventTracker,
    private readonly host: InputAreaHost,
  ) {
    // 创建并挂载 Provider 选择器组件（封装 DOM 引用 + 事件 + 渲染）
    this.providerSelectorComponent = new ProviderSelectorComponent({}).mount('');
    // 创建并挂载 Token 用量指示器组件（封装 DOM 引用 + 状态渲染）
    this.tokenUsageComponent = new TokenUsageComponent({}).mount('');
  }

  /**
   * 初始化：绑定事件 + 启动 ResizeObserver + 初始化输入补全
   *
   * 在 UIManager 构造函数末尾调用（initEventListeners 之后）。
   */
  init(): void {
    // 输入框事件
    this.events.addEventListener(this.inputEl, 'keydown', this.handleKeydown.bind(this));
    this.events.addEventListener(this.inputEl, 'input', this.handleInputChange.bind(this));

    // 初始化输入框高度和发送按钮状态（构造时 textarea 可能已有默认值）
    this.handleInputChange();

    // 发送按钮点击（停止按钮由 UIManager 直接绑定 emitStopMessage，不在此管理）
    this.events.addEventListener(this.btnSend, 'click', this.handleClick.bind(this));

    // 启动输入区 ResizeObserver
    this.initResizeObserver();

    // 初始化 Provider 选择器
    this.initProviderSelector();

    // 初始化输入补全（候选列表容器存在时才启用，让用户输入时即可发现此功能）
    this.initCompletion();

    // 初始化暂停/恢复按钮（不中断工作模型，点击暂停/恢复会话，根据会话状态切换禁用态）
    this.initSessionControlButtons();
  }

  /**
   * 清理：断开 ResizeObserver + 清理事件监听器 + 清理补全管理器
   *
   * 由 UIManager.cleanup() 调用。
   */
  cleanup(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    // 清理补全管理器（移除事件监听器 + 清空候选列表）
    if (this.completion) {
      this.completion.cleanup();
      this.completion = null;
    }
    // 销毁 Provider 选择器组件（解绑事件 + nullify 引用，不删除模板 DOM）
    this.providerSelectorComponent.destroy();
    // 销毁 Token 用量指示器组件（nullify 引用，不删除模板 DOM）
    this.tokenUsageComponent.destroy();
    this.events.cleanup();
  }

  /**
   * 获取输入框值（已 trim + 长度限制）
   *
   * 不清空输入框，仅读取和清理。
   * 由 UIManager.getUserInput() 调用（清空逻辑由调用方处理）。
   *
   * @returns 清理后的文本，空输入返回空字符串
   */
  getValue(): string {
    const trimmed = this.inputEl.value.trim();
    return trimmed.length > MAX_INPUT_LENGTH
      ? trimmed.substring(0, MAX_INPUT_LENGTH)
      : trimmed;
  }

  /**
   * 清空输入框并重置高度/按钮状态
   *
   * 由 UIManager.getUserInput() 在获取输入后调用。
   */
  clearInput(): void {
    this.inputEl.value = '';
    this.handleInputChange();
  }

  /**
   * 预填输入框内容
   *
   * 由 UIManager.prefillChatInput() 调用，用于"在对话中讨论"功能。
   * 设置值后触发 input 事件，让 handleInputChange 调整高度。
   *
   * @param text 预填的文本内容
   */
  setValue(text: string): void {
    this.inputEl.value = text;
    // 触发 input 事件，让 handleInputChange 感知内容变化（调整高度 + 更新按钮状态）
    this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * 刷新发送按钮状态（空闲态下根据输入内容更新 disabled/empty 类）
   *
   * 由 UIManager.updateSendButton() 在流式态 → 空闲态切换时调用。
   * 流式态下此方法无效（由 host.isStreaming() 守卫）。
   */
  refreshSendButtonState(): void {
    if (this.host.isStreaming()) return; // 流式态由 UIManager.updateSendButton 处理
    const hasContent = this.inputEl.value.trim().length > 0;
    this.btnSend.disabled = !hasContent;
    this.btnSend.classList.toggle('empty', !hasContent);
  }

  /**
   * 输入框键盘事件处理
   *
   * - Enter（非 Shift）：发送消息或停止流式输出
   * - Escape：清空输入（有内容时）或失焦（无内容时），交互参考终端/聊天应用惯例
   */
  private handleKeydown(e: Event): void {
    // EventListener 接口签名为 Event，keydown 监听器实际接收 KeyboardEvent
    // instanceof 守卫防止非 KeyboardEvent 类型（理论不会发生，但符合类型安全）
    if (!(e instanceof KeyboardEvent)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      // IME 合成期（中文输入法选词时按 Enter 确认候选词）不触发发送
      // isComposing 为 true 表示合成尚未提交，keyCode 229 是旧版浏览器兼容判断
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      // B2：流式态时 Enter 触发停止（键盘快捷键，对齐 #btn-stop 鼠标点击），空闲态触发发送
      if (this.host.isStreaming()) {
        this.host.emitStopMessage();
      } else {
        // 发送前清空补全候选列表，避免浮层遮挡输入区
        this.completion?.clear();
        this.host.emitSendMessage();
      }
    } else if (e.key === 'Escape') {
      // Esc：有内容则清空，无内容则失焦
      if (this.inputEl.value.trim().length > 0) {
        this.inputEl.value = '';
        this.handleInputChange();
      } else {
        this.inputEl.blur();
      }
    }
  }

  /**
   * 输入框内容变化处理
   *
   * - 自适应高度：根据 scrollHeight 动态调整，最大 120px
   * - 更新发送按钮视觉状态（空态弱化）
   */
  private handleInputChange(): void {
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, MAX_INPUT_HEIGHT) + 'px';
    this.refreshSendButtonState();
  }

  /**
   * 发送按钮点击处理
   *
   * 直接触发发送回调（Agent 就绪/空内容守卫在 UIManager.emitSendMessage 内部）。
   */
  private handleClick(): void {
    // 与 Enter 发送保持一致：点击发送按钮前清空补全候选列表
    this.completion?.clear();
    this.host.emitSendMessage();
  }

  /**
   * 初始化输入区 ResizeObserver
   *
   * 监听 #input-area 高度变化，动态更新 :root 的 --input-area-height CSS 变量。
   * 代替静态 140px，避免 textarea 多行撑高时遮挡最后一条消息。
   *
   * 设计要点：
   * - 使用 ResizeObserver 而非 input 事件，覆盖所有高度变化来源（窗口缩放、内容变化、主题切换）
   * - 写入 documentElement.style 确保所有引用 --input-area-height 的样式（chat-messages.css，原 chat.css:958/1867）同步更新
   * - 元素缺失或环境不支持（jsdom 测试）时静默降级（保持原静态 140px 回退值）
   */
  private initResizeObserver(): void {
    const inputArea = document.getElementById('input-area');
    if (!inputArea) return;
    // 防御性检查：ResizeObserver 是浏览器 API，jsdom 测试环境不提供
    // 缺失时静默降级（保持原静态 140px 回退值），不阻断初始化
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // 获取输入区实际高度（含 padding + border）
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (height > 0) {
          // 更新 CSS 变量，chat-messages.css 中 padding-bottom 和浮动按钮 bottom 都引用此变量
          document.documentElement.style.setProperty('--input-area-height', `${Math.ceil(height)}px`);
        }
      }
    });
    this.resizeObserver.observe(inputArea);
  }

  // ─── 输入补全 ──────────────────────────────────────────

  /**
   * 初始化输入补全
   *
   * 复用 quick-input 模块的 QuickInputCompletion 类，让主对话输入框也具备补全能力。
   * 用户输入 ≥2 字符后自动触发，从记忆 + 历史对话中搜索候选，↓↑ 导航 + ←→ 填充。
   *
   * 设计要点：
   * - 候选列表容器（#chat-completion-list）缺失时静默降级，不阻断初始化
   * - 补全管理器独立绑定 input/keydown 事件，与 InputAreaManager 的事件互不干扰
   *   （补全仅拦截 ↓↑←→，Enter/Esc 由 InputAreaManager 处理）
   * - onSelect 回调：回填文本到输入框并触发 input 事件（更新高度 + 按钮状态）
   * - 不注册 onListChange（主窗口不需要调整窗口高度，候选列表通过 CSS 绝对定位浮层）
   * - enableCollapse：浮层会遮挡最近对话内容，启用折叠开关让用户可临时收起弹窗
   *   （回看/复制对话场景；与 quick-input 浮窗的窗口增高避让形成场景化互补）
   */
  private initCompletion(): void {
    // 候选列表容器可选（缺失时跳过补全能力，不阻断主流程）
    const completionList = document.getElementById('chat-completion-list');
    if (!(completionList instanceof HTMLElement)) return;

    // window.electronAPI 由 preload.ts 通过 contextBridge 注入，已有全局类型声明
    // 传入完整的 ElectronAPI，QuickInputCompletion 仅使用 searchMemories/searchSessionMessages 子集
    this.completion = new QuickInputCompletion(this.inputEl, completionList, window.electronAPI);
    // 启用折叠开关：补全弹窗绝对定位在输入区上方会遮挡最近对话内容，
    // 用户想回看/复制对话时可点击「收起候选」将弹窗折叠为胶囊条（不打断输入、不丢失补全会话）
    this.completion.enableCollapse();
    // 候选项选中时回填到输入框（优先 fullText，降级 text）
    // 主窗口的 window.electronAPI 是完整 API，showMemory 可用，记忆候选异步回库查全量
    this.completion.onSelect((item: CompletionItem) => {
      // 抑制填充文本触发的 input 事件 → 补全搜索（避免候选列表闪烁）
      this.completion?.suppressNextSearch();
      // 对话候选：fullText 已有完整原文，直接同步填充
      if (item.fullText) {
        this.fillCompletionText(item.fullText);
        this.completion?.clear();
        return;
      }
      // 记忆候选：fullText 为空，通过 showMemory IPC 回库查全量
      if (item.memoryId) {
        this.fillFromMemoryAsync(item);
        return;
      }
      // 降级：使用截断预览
      this.fillCompletionText(item.text);
      this.completion?.clear();
    });
    this.completion.init();
  }

  /**
   * 将补全文本填入输入框（同步操作）
   *
   * 设置 value → 触发 input 事件（更新高度 + 按钮状态）→ 光标移到末尾。
   * 与 quickInput.ts 的 fillText 同构，但主输入框需额外触发 input 事件通知 handleInputChange。
   */
  private fillCompletionText(text: string): void {
    this.inputEl.value = text;
    // 触发 input 事件，让 handleInputChange 感知内容变化（更新高度 + 按钮状态）
    this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    // 将光标移到末尾
    this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
  }

  /**
   * 异步从数据库获取记忆全量内容后填入输入框（记忆候选专用）
   *
   * 委托 fetchMemoryContent 公共函数，消除与 quickInput.ts 的重复逻辑。
   * 回库查询期间候选列表保持可见（不提前清除），填充完成后调用 clear() 隐藏。
   */
  private async fillFromMemoryAsync(item: CompletionItem): Promise<void> {
    await fetchMemoryContent(item, window.electronAPI.showMemory, this.fillCompletionText.bind(this), 'InputArea:showMemory');
    this.completion?.clear();
  }

  // ─── 暂停/恢复按钮（不中断工作模型） ──────────────────

  /**
   * 初始化暂停/恢复按钮
   *
   * 在输入工具栏左侧（.input-actions-left）创建暂停和恢复按钮，
   * 点击分别调用 pauseSession/resumeSession IPC。
   * 通过 onSessionStatusChanged 监听器同步按钮禁用态：
   *   - RUNNING：暂停可用，恢复禁用
   *   - PAUSED：暂停禁用，恢复可用
   *   - ERROR：两者均禁用
   * 容器元素缺失时静默降级（不阻断初始化）。
   */
  private initSessionControlButtons(): void {
    // 查找输入工具栏左侧容器，缺失时静默降级
    const actionsLeft = document.querySelector('.input-actions-left');
    if (!(actionsLeft instanceof HTMLElement)) return;

    // 创建暂停按钮
    this.btnPause = document.createElement('button');
    this.btnPause.className = 'input-action session-control-btn session-pause-btn';
    this.btnPause.title = '暂停会话（不中断，自动保存当前状态）';
    this.btnPause.setAttribute('aria-label', '暂停会话');
    // 使用 SVG 暂停图标
    this.btnPause.innerHTML = '<svg class="icon"><use href="#icon-pause"/></svg>';
    this.btnPause.addEventListener('click', () => {
      void window.electronAPI.pauseSession('用户主动暂停');
    });
    actionsLeft.appendChild(this.btnPause);

    // 创建恢复按钮（初始禁用，会话暂停时启用）
    this.btnResume = document.createElement('button');
    this.btnResume.className = 'input-action session-control-btn session-resume-btn';
    this.btnResume.title = '恢复会话（从暂停状态继续）';
    this.btnResume.setAttribute('aria-label', '恢复会话');
    this.btnResume.disabled = true;
    // 使用 SVG 播放/恢复图标
    this.btnResume.innerHTML = '<svg class="icon"><use href="#icon-play"/></svg>';
    this.btnResume.addEventListener('click', () => {
      void window.electronAPI.resumeSession();
    });
    actionsLeft.appendChild(this.btnResume);

    // 初始状态：暂停可用，恢复禁用（会话默认 RUNNING）
    // 会话状态变更监听由 ipcListeners.ts 统一管理，通过 UIManager 委托到本方法
  }

  /**
   * 更新暂停/恢复按钮状态（根据会话状态切换禁用态）
   *
   * @param status 会话状态：'running' | 'paused' | 'error'
   */
  updateSessionStatus(status: string): void {
    if (this.btnPause) {
      // RUNNING 态暂停可用，PAUSED/ERROR 态暂停禁用
      this.btnPause.disabled = status !== 'running';
    }
    if (this.btnResume) {
      // 仅 PAUSED 态恢复可用
      this.btnResume.disabled = status !== 'paused';
    }
  }

  // ─── Provider 选择器 ────────────────────────────────────

  /**
   * 初始化 Provider 选择器
   *
   * 初始隐藏下拉，事件绑定委托给 ProviderSelectorComponent，
   * 最后加载 Provider 列表渲染下拉菜单。
   * DOM 操作与事件绑定封装在 Component 中，本方法仅做编排 + 业务回调注入。
   */
  private async initProviderSelector(): Promise<void> {
    // 元素缺失时跳过初始化（Component mount 时元素可能尚未渲染）
    if (!this.providerSelectorComponent.getSelectorEl() || !this.providerSelectorComponent.getDropdownEl()) return;

    // 初始隐藏下拉菜单（HTML 中可能未带 hidden 类，确保初始态统一）
    this.providerSelectorComponent.closeDropdown();

    // 事件绑定委托给 Component（点击切换、外部关闭、键盘导航）
    this.providerSelectorComponent.initEvents(
      // 选择 Provider：IPC 切换激活 + 重新加载列表 + warning 时跳转设置
      async (key) => {
        const result = await window.electronAPI.setActiveLlmProvider(key);
        await this.loadProviderSelector();
        // Agent 未就绪时 warning 提示已保存但需初始化，引导用户去设置页
        if (result.warning) {
          this.host.switchToSettings();
        }
      },
      // 空状态提示项：跳转到设置面板
      () => {
        this.host.switchToSettings();
      },
    );

    // 加载并渲染 Provider 列表
    await this.loadProviderSelector();
  }

  /**
   * 加载 Provider 选择器内容
   *
   * 从主进程获取 Provider 列表，更新当前显示名称和下拉菜单。
   */
  async loadProviderSelector(): Promise<void> {
    // 元素缺失时静默返回（与原守卫等价，Component 内部方法亦对 null 做防御）
    if (!this.providerSelectorComponent.getNameEl() || !this.providerSelectorComponent.getDropdownEl()) return;

    try {
      const data = await window.electronAPI.listLlmProviders();
      const { active, providers } = data;

      if (providers.length === 0) {
        this.providerSelectorComponent.updateName('未配置');
        this.providerSelectorComponent.setConfigured(false);
        // 空状态提示项渲染委托给 Component（<button> 元素，原生支持 Enter/Space，键盘可访问）
        this.providerSelectorComponent.renderEmpty();
        return;
      }

      // 更新当前显示名称
      const activeProvider = providers.find((p) => p.key === active) ?? providers[0]!;
      this.providerSelectorComponent.updateName(activeProvider.name);
      this.providerSelectorComponent.setConfigured(true);
      // 渲染下拉菜单委托给 Component（createElement 防注入，tabindex/role 支持键盘导航）
      this.providerSelectorComponent.renderProviders(providers, active);

      // 下拉项点击事件已通过 Component initEvents 中的事件委托处理，此处无需重复绑定
    } catch (error) {
      // 加载失败时显示降级文案，UI 已有可见反馈（"加载失败"），此处仅记录日志便于排查
      this.providerSelectorComponent.updateName('加载失败');
      reportError('InputAreaManager.loadProviderSelector', error);
    }
  }

  /**
   * 刷新 Token 用量指示器
   *
   * 消费内核 agent.getMetrics()（通过 getDashboard IPC），
   * 显示当前对话累计输入/输出 token 数 + 进度条。
   * 流式结束后由外部调用（renderer.ts 的 SPRITE_STREAM_END 处理）。
   */
  async refreshTokenUsage(): Promise<void> {
    // 元素缺失时静默返回（Component mount 时元素可能缺失，getElement 返回 usage 容器）
    if (!this.tokenUsageComponent.getElement()) return;

    try {
      // 并行获取仪表盘数据和当前 Provider 配置（减少 IPC 往返）
      const [dashboard, providerList] = await Promise.all([
        window.electronAPI.getDashboard(),
        window.electronAPI.listLlmProviders(),
      ]);

      const metrics = dashboard?.metrics;
      if (!metrics?.llm) {
        // 无用量数据 ≠ 未知。providerList 已在上方 Promise.all 取到，
        // 直接算出上下文窗口，显示「0/窗口」——比模糊的 '--' 更友好、更准确。
        // '--' 仅保留给下方 catch 的「加载失败」(真正未知) 态。
        const activeProvider = providerList?.providers?.find(
          (p) => p.key === providerList?.active,
        );
        const contextWindow = activeProvider?.contextWindow ?? InputAreaManager.DEFAULT_CONTEXT_TOKENS;
        this.tokenUsageComponent.showEmpty(contextWindow);
        return;
      }

      const { totalInputTokens, totalOutputTokens } = metrics.llm;
      const total = totalInputTokens + totalOutputTokens;

      // 获取当前 Provider 的上下文窗口大小（动态，不同模型不同）
      const activeProvider = providerList.providers.find(
        (p) => p.key === providerList.active,
      );
      const contextWindow = activeProvider?.contextWindow ?? InputAreaManager.DEFAULT_CONTEXT_TOKENS;

      // 渲染正常用量（含颜色分级、紧凑态、tooltip 分解）委托给 Component
      this.tokenUsageComponent.showUsage(total, contextWindow, totalInputTokens, totalOutputTokens);
    } catch (error) {
      // Token 用量刷新失败不影响对话功能，UI 显示 '--' 降级，仅记录日志
      this.tokenUsageComponent.showError();
      reportError('InputAreaManager.refreshTokenUsage', error);
    }
  }
}
