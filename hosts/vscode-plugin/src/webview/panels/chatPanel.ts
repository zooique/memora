/**
 * 对话打磨面板 — 侧边栏 Webview 视图提供者（u1 UX 改进）
 *
 * 职责：
 *   - 渲染对话消息区（用户 / AI）+ 输入框 + 主动提问框；
 *   - 将用户输入 postMessage 到 extension host，调 Agent.chat() 流式返回并渲染；
 *   - 收到 extension host 的 questionPending 事件渲染提问框，回答后 resumeExecution 续跑；
 *   - 会话持久化：打开面板时从 sessionStore 恢复历史，发消息时写入。
 *
 * 设计（薄壳 + 复用内核，单一真理源）：
 *   - 文档属「当前任务上下文」注入 chat 输入，不进入记忆召回；
 *   - 渲染逻辑全部在 webview 内（postMessage 驱动），extension host 不做 DOM 操作；
 *   - 持久化复用内核 sessionStore 机制（date-session 组织消息）。
 */
import * as vscode from 'vscode';
import { formatDateKey, type Agent, type AgentChunk, type ISessionStore } from '@zooique/memora';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { ProviderStore } from '../../extension/providers/providerStore.js';
import { createDocReviewProvider } from '../../extension/host/llmConfig.js';
import { buildDropdownHtml, dropdownStyles } from '../components/dropdown.js';
import { chatStyles } from '../styles/chatStyles.js';
import { toolCardStyles } from '../styles/toolCard.js';
import { stripDocContextPrefix } from '../helpers/docContext.js';

/** 历史回放单次最大条数：跨天合并视图聚焦近期对话，
 *  防止长期使用后消息累积导致每次打开/切换都全量回放 + 逐条建 DOM（对抗评估 P1-7） */
const MAX_HISTORY_MESSAGES = 200;

/** 宿主会话存储类型：内核 ISessionStore + 宿主扩展能力（清空会话）。
 *  用交集类型收窄，替代 handleClear 中的 as unknown as 双重断言（对抗评估 P2-5） */
type HostSessionStore = ISessionStore & {
  clearSession: (date: string, session: string) => void;
};

/** 技能内部名 → 中文显示名（与工具名中文化同一体验原则，对抗评估 P2-6）。
 *  未知技能回退原值（内部名），保证未收录技能不显示为空白 */
function skillDisplayName(skill: string): string {
  const map: Record<string, string> = { 'doc-review': '文档打磨', scaffold: '代码骨架' };
  return map[skill] || skill;
}

/** 侧边栏视图提供者 */
export class MemoraChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'memora.docReview.chat';

  /** 当前 webview（视图被关闭时 undefined） */
  private _view: vscode.WebviewView | undefined;
  /** 当前装配的 Agent（由 extension 装配后注入） */
  private _agent: Agent | undefined;
  /** 当前打磨文档上下文（打开时快照） */
  private _docContext: string | undefined;
  /** 大模型配置存储（用于底部模型下拉框 + 切换） */
  private readonly _providerStore: ProviderStore;
  /** Agent 懒装配工厂（由 extension 注入，打开面板即装配，不依赖先执行 open 命令） */
  private _getAgent: ((projectPath: string) => Promise<Agent>) | undefined;
  /** 是否已尝试装配（避免面板每次展开都重复装配） */
  private _agentResolving = false;
  /** 当前激活 Skill（对话面板装配的打磨技能，toolbar 徽章展示；装配时由 extension 注入） */
  private _activeSkill: string | undefined;
  /**
   * 当前查看的历史会话日期（YYYY-MM-DD，toolbar 历史下拉框）
   *
   * undefined = 查看全部历史（跨天合并，默认）；选定值 = 只看该天对话记录。
   * 仅影响回放展示，不影响持久化写入（写入始终走当天 main，与内核一致）。
   */
  private _historyDate: string | undefined;
  /** 是否正在流式生成中（由 consumeFlow 维护）：生成中禁止切换历史，
   *  避免重放清空消息区后，进行中的 chunk 污染重放视图（对抗评估 P1-3） */
  private _streaming = false;
  /**
   * 当前进行中流的 AbortController（mvp-scope 打断能力）
   *
   * 停止按钮 / 生成中插话共用：abort() 中断 chat()/resumeExecution() 流，
   * 内核在下一 await 点退出并 yield aborted chunk。无进行中流时为 undefined
   * （stop 可安全 no-op）。
   */
  private _abortController: AbortController | undefined;
  /** 当前进行中流的 promise：生成中插话需 await 旧流彻底结束再发新流，
   *  避免 chatLock 未释放导致「发起新对话」busy 冲突 */
  private _currentFlow: Promise<void> | undefined;

  /**
   * @param extensionUri 插件扩展根 URI（用于 webview 本地资源加载 localResourceRoots）
   * @param sessionStore 会话存储（用于持久化/恢复对话历史）
   * @param providerStore 大模型配置存储（用于底部模型下拉框）
   */
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionStore: HostSessionStore,
    providerStore: ProviderStore,
  ) {
    this._providerStore = providerStore;
  }

  /** 注入 Agent 懒装配工厂（由 extension.ts 提供 getOrCreateAgent） */
  public setAgentFactory(getAgent: (projectPath: string) => Promise<Agent>): void {
    this._getAgent = getAgent;
  }

  /** 由 extension 在装配 Agent 后注入（open 命令路径），同时绑定会话级可观测事件 */
  public setAgent(agent: Agent): void {
    this._agent = agent;
    // 与 ensureAgent 懒装配路径保持一致：注入即绑定，确保事件通知两条路径都生效
    // （bindAgentNoticeEvents 内部先 off 再 on，幂等，折叠展开重复注入不重复注册）
    this.bindAgentNoticeEvents();
  }

  /** 设置当前打磨文档上下文（打开面板时调用） */
  public setDocContext(docContext: string | undefined): void {
    this._docContext = docContext;
  }

  /**
   * 设置当前激活 Skill（由 extension 装配时注入）
   *
   * 对话面板定位「文档打磨」，装配 doc-review skill；skill 名在就绪回放时推送给
   * webview 渲染 toolbar 徽章（主动可见：用户始终知道当前用哪个技能）。
   *
   * @param skill Skill 名（如 'doc-review'）
   */
  public setActiveSkill(skill: string): void {
    this._activeSkill = skill;
    // 视图已就绪时立即推送（而非等待下次 replaySession），保证徽章即时显示；
    // 视图未就绪时由 replaySession 兜底（就绪回放时读取 _activeSkill 推送）。
    if (this._view) {
      this.post({ type: 'chat_skill', skill: skillDisplayName(skill) });
    }
  }

  /** 视图被解析（侧边栏展开）时初始化 */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    // 折叠/展开会触发 resolve 重建 HTML。不设 retainContextWhenHidden（避免 window
    // 全局标志残留与 document 重建的冲突），统一走「ready 回放」这一确定性机制：
    // 每次重建后，webview 脚本就绪发 ready，extension 再回放会话，保证数据不丢。
    // 阶段 B（P2-1）：启用外部脚本（chatView.js），localResourceRoots 指向 dist/webview
    // 供 webview.asWebviewUri 解析（CSP script-src 'self'，不再用 'unsafe-inline' 注入脚本）
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };

    // 仅设置 HTML（不在就绪前回放，避免消息在脚本监听器注册前丢失）
    this.render();

    // 打开面板即确保 Agent 装配（不依赖先执行 open 命令），避免发送无反应
    void this.ensureAgent();

    // 视图被销毁（折叠/关闭）时清理引用，避免向已销毁 webview postMessage
    webviewView.onDidDispose(() => {
      if (this._view === webviewView) this._view = undefined;
    });

    // 处理来自 webview 的用户输入
    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      if (msg.type === 'ready') {
        // webview 脚本就绪后才回放会话（历史 + Provider 列表），消除时序竞态
        this.replaySession();
      } else if (msg.type === 'send' && msg.text.trim()) {
        void this.handleSend(msg.text.trim());
      } else if (msg.type === 'clarify_answer' && msg.text.trim()) {
        void this.handleResume(msg.text.trim());
      } else if (msg.type === 'clear') {
        void this.handleClear();
      } else if (msg.type === 'chat_set_provider') {
        void this.handleSetProvider(msg.name);
      } else if (msg.type === 'chat_switch_date') {
        // 历史会话切换：更新查看日期并重放对应历史
        this.handleSwitchDate(msg.date);
      } else if (msg.type === 'stop') {
        // 停止生成：中断当前流式输出（mvp-scope 打断能力）
        this.handleStop();
      }
    });
  }

  /**
   * 确保 Agent 已装配：若尚未装配则通过工厂懒装配一次
   *
   * 用户可能直接点活动栏面板图标打开（未执行 open 命令），此时 agent 从未装配，
   * 会导致发送无反应。此方法在打开面板时自动装配，失败时给出明确提示。
   */
  private async ensureAgent(): Promise<void> {
    if (this._agent || this._agentResolving || !this._getAgent) return;
    this._agentResolving = true;
    try {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) {
        void vscode.window.showWarningMessage('Memora：请先打开一个工作区');
        return;
      }
      this._agent = await this._getAgent(ws);
      // 装配成功后绑定会话级可观测事件 → 错误提示（会话异常/恢复失败等，不插入消息区）
      this.bindAgentNoticeEvents();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Memora 装配失败：${msg}`);
    } finally {
      this._agentResolving = false;
    }
  }

  // ─── 会话异常可观测出口（错误级 notice，功能→UI 对齐排雷 P1） ───
  // 监听内核会话级事件并转发为错误提示条。错误不插入消息区，避免污染对话历史；
  // 以下 handler 均为箭头函数属性，保证 off/on 引用一致（折叠展开防重复注册）。

  /** sessionError：会话异常（LLM 超时等） */
  private readonly onSessionError = (info: { cause: string }): void => {
    this.post({ type: 'notice', level: 'error', message: `会话异常：${info.cause}` });
  };

  /** sessionResumeFailed：恢复操作执行失败（如存储层异常） */
  private readonly onSessionResumeFailed = (info: { reason: string }): void => {
    this.post({ type: 'notice', level: 'error', message: `会话恢复失败：${info.reason}` });
  };

  /** sessionResumeBlocked：恢复被阻止（暂停超时检查点已清理） */
  private readonly onSessionResumeBlocked = (info: { reason: string }): void => {
    this.post({ type: 'notice', level: 'error', message: `会话无法恢复：${info.reason}` });
  };

  /** sessionPauseTimedOut：暂停超时，需重新开始 */
  private readonly onSessionPauseTimedOut = (): void => {
    this.post({ type: 'notice', level: 'error', message: '会话暂停超时，请重新开始' });
  };

  /** guardrailError：安全规则正则编译失败（安全放行但规则未生效） */
  private readonly onGuardrailError = (info: { message: string }): void => {
    this.post({ type: 'notice', level: 'error', message: `安全规则未生效：${info.message}` });
  };

  // ─── 低扰信息出口（info 级 notice，P1 后续波） ───
  // 上下文截断 / 记忆冲突 / 归档失败 / 权重持久化失败 —— 均为「知晓即可」的低频信息，
  // 统一走 notice info 级提示条（语义分级单一通道，不插入消息区，不污染对话历史）。
  // 提示条为独立元素，不随流式 chunk 重建，天然规避「截断提示被后续 chunk 覆盖」（排雷雷-6）。

  /** contextTruncated：上下文窗口截断（消息超出 token 上限被裁剪） */
  private readonly onContextTruncated = (info: { skippedCount: number; keptCount: number }): void => {
    this.post({
      type: 'notice',
      level: 'info',
      message: `上下文已截断：跳过 ${info.skippedCount} 条，保留 ${info.keptCount} 条`,
    });
  };

  /** conflictDetected 事件已随内核记忆关系图谱收敛移除（2026-08-14） */

  /** archiveFailed：记忆归档失败（insight / content 阶段） */
  private readonly onArchiveFailed = (info: { stage: string; message: string }): void => {
    this.post({ type: 'notice', level: 'info', message: `记忆归档失败（${info.stage}）：${info.message}` });
  };

  /** boostPersistFailed：boost score 持久化失败（记忆权重可能丢失） */
  private readonly onBoostPersistFailed = (info: { message: string }): void => {
    this.post({ type: 'notice', level: 'info', message: `记忆权重保存失败：${info.message}` });
  };

  /**
   * 绑定会话级可观测事件 → 错误提示
   *
   * Agent 为单例跨面板展开共享，此处先 off 再 on（命名 handler 引用一致），
   * 避免折叠/展开重建视图时重复注册导致重复通知。
   */
  private bindAgentNoticeEvents(): void {
    if (!this._agent) return;
    const a = this._agent;
    a.off('sessionError', this.onSessionError);
    a.on('sessionError', this.onSessionError);
    a.off('sessionResumeFailed', this.onSessionResumeFailed);
    a.on('sessionResumeFailed', this.onSessionResumeFailed);
    a.off('sessionResumeBlocked', this.onSessionResumeBlocked);
    a.on('sessionResumeBlocked', this.onSessionResumeBlocked);
    a.off('sessionPauseTimedOut', this.onSessionPauseTimedOut);
    a.on('sessionPauseTimedOut', this.onSessionPauseTimedOut);
    a.off('guardrailError', this.onGuardrailError);
    a.on('guardrailError', this.onGuardrailError);
    // P1 后续波：低扰信息（截断/归档失败/权重保存失败）→ info 级提示条
    a.off('contextTruncated', this.onContextTruncated);
    a.on('contextTruncated', this.onContextTruncated);
    a.off('archiveFailed', this.onArchiveFailed);
    a.on('archiveFailed', this.onArchiveFailed);
    a.off('boostPersistFailed', this.onBoostPersistFailed);
    a.on('boostPersistFailed', this.onBoostPersistFailed);
  }

  /**
   * 清空当前会话：确认后清空会话消息，并通知 webview 清空消息区
   *
   * 危险操作确认走 host 侧原生 modal（VSCode webview 禁用原生 confirm()，
   * 避免「确认框静默失效 → 按钮无反应」的功能性缺陷，对抗评估 P0-2）。
   * 依赖 WorkspaceSessionStore.clearSession（宿主扩展方法，非内核 ISessionStore 标准接口）。
   *
   * 收窄语义（SSOT 排雷 P1-1）：只清空「当前查看的会话」这一个 date-main 最小单元——
   * 若正在查看某历史天（_historyDate）则清该天，否则清当天 main。绝不清空跨天全部
   * 历史，避免「清空当前对话」实际清光全部历史的数据破坏错位。
   */
  private async handleClear(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      '确定清空当前对话？此操作不可恢复。',
      { modal: true },
      '清空',
    );
    if (choice !== '清空') return;
    try {
      // 清空当前查看范围的 date-main 会话（_historyDate 存在则清该历史天，否则当天）
      const date = this._historyDate ?? formatDateKey(new Date());
      this.sessionStore.clearSession(date, 'main');
    } catch (err) {
      // 清空失败不阻塞展示（仅清 webview UI），但需记录（SSOT 不藏错）
      console.warn('Memora 清空会话失败', err);
    }
    // 清空后回放当前查看范围，保证 UI 与存储一致（其余天历史保留）
    this.post({ type: 'clear_ok' });
    const history = this.loadHistory(this._historyDate);
    for (const m of history) {
      this.post({ type: m.role, text: m.content, ts: m.ts });
    }
  }

  /** 仅渲染 HTML 骨架（历史/Provider 在 webview 就绪后经 replaySession 回放）；
   *  脚本由外部 chatView.js 提供（阶段 B P2-1，经 asWebviewUri 引用） */
  private render(): void {
    if (!this._view) return;
    const scriptUri = this._view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'scripts', 'chatView.js'),
    );
    this._view.webview.html = buildHtml(scriptUri);
  }

  /**
   * 回放当前会话（历史消息 + 历史日期列表 + Skill + Provider）
   *
   * 仅在 webview 发来 ready（脚本监听器已注册）后调用，避免 postMessage
   * 在监听器就绪前到达而被丢弃（折叠/展开重建 HTML 时尤其明显）。
   */
  private replaySession(): void {
    if (!this._view) return;
    // 恢复历史消息（按当前查看日期过滤：_historyDate 或全部跨天合并）
    const history = this.loadHistory(this._historyDate);
    for (const m of history) {
      this.post({ type: m.role, text: m.content, ts: m.ts });
    }
    // 推送历史会话日期列表 → toolbar 历史下拉框（主动可见，可手动切换查看）
    this.pushHistoryDates();
    // P1-2：回传当前查看范围（宿主权威），webview 历史下拉触发器据此回显
    this.post({ type: 'chat_history_view', date: this._historyDate ?? '' });
    // 推送当前激活 Skill → toolbar 技能徽章（主动可见）
    if (this._activeSkill) {
      this.post({ type: 'chat_skill', skill: skillDisplayName(this._activeSkill) });
    }
    // 推送 Provider 列表到 webview（底部模型下拉框）
    void this.pushProviders();
  }

  /**
   * 推送历史会话日期列表到 webview（toolbar 历史下拉框）
   *
   * 从 sessionStore 收集全部 `YYYY-MM-DD-main` 会话的日期，去重后倒序
   * （最新在前），供用户手动切换查看某天对话记录（精灵「日期导航」机制的插件版）。
   */
  private pushHistoryDates(): void {
    try {
      const dates = new Set<string>();
      for (const key of this.sessionStore.listSessions()) {
        if (!key.endsWith('-main')) continue;
        const idx = key.lastIndexOf('-');
        if (idx > 0) dates.add(key.slice(0, idx));
      }
      this.post({ type: 'chat_history_dates', dates: [...dates].sort().reverse() });
    } catch {
      // 推送失败不阻塞主流程
    }
  }

  /**
   * 处理用户切换查看的历史会话日期（toolbar 历史下拉框）
   *
   * 更新当前查看日期，清空 webview 消息区后重放对应历史。date 传空串表示
   * 查看全部历史（跨天合并，默认），否则只看该天对话。
   *
   * @param date 选中的日期（YYYY-MM-DD），空串 = 全部
   */
  private handleSwitchDate(date: string): void {
    // 流式生成中禁止切换历史：重放会清空消息区，导致进行中的 chunk 追加进
    // 重放后的视图，形成「历史 + 进行中流」混血（对抗评估 P1-3）。
    // 约束放在 host 侧（流状态单一真理源），提示用户等待本轮生成完成。
    if (this._streaming) {
      this.post({ type: 'notice', level: 'info', message: '生成中，请稍候再切换历史' });
      return;
    }
    this._historyDate = date || undefined;
    // P1-2：回传新查看范围，webview 历史下拉触发器据此回显当前日期
    this.post({ type: 'chat_history_view', date: this._historyDate ?? '' });
    // 先清空 webview 消息区，再重放对应日期历史（复用 clear_ok 清空协议）
    this.post({ type: 'clear_ok' });
    const history = this.loadHistory(this._historyDate);
    for (const m of history) {
      this.post({ type: m.role, text: m.content, ts: m.ts });
    }
  }

  /**
   * 推送 Provider 列表到 webview（异步读取配置）
   *
   * 在 render 时调用，也可在切换 Provider 后再次调用以刷新下拉框。
   */
  private async pushProviders(): Promise<void> {
    try {
      const providers = await this._providerStore.listMasked();
      const activeName = this._providerStore.getActiveName();
      const list = providers.map((p) => ({ name: p.name, displayName: p.displayName || p.name }));
      this.post({ type: 'chat_providers', providers: list, activeName });
    } catch {
      // 推送失败不阻塞主流程
    }
  }

  /**
   * 处理用户切换激活 Provider（底部模型下拉框）
   *
   * 除持久化激活态外，还做「热生效」：复用装配工厂 createDocReviewProvider（SSOT，
   * 不重复构造）构造新 Provider 并注入 Agent，让后续对话立即使用新模型。
   * 切换未生效时（对话进行中不可切换 / 配置缺失）回滚激活态并提示，避免
   * UI 显示已切换但实际未生效（功能→UI 对齐排雷 P0）。
   *
   * @param name 用户选中的 Provider 别名
   */
  private async handleSetProvider(name: string): Promise<void> {
    // 备份当前激活名，切换失败时回滚（保持 UI 与真实生效状态一致）
    const prev = this._providerStore.getActiveName();
    const r = await this._providerStore.setActive(name);
    if (!r.ok) return;
    try {
      // 热生效：Agent.setProvider 在对话进行中会抛 assertNotBusy，需捕获
      if (this._agent) {
        await this._agent.setProvider(await createDocReviewProvider(this._providerStore));
      }
      await this.pushProviders();
    } catch (err) {
      // 切换未生效：回滚激活态 + 错误提示（不误导用户）
      // prev 存在 → 还原原激活 Provider；prev 为 undefined（原本无激活、靠 env 装配，
      // 见 llmConfig 回退路径）→ 清空激活态，否则 UI 显示新 provider 已激活但 agent
      // 仍用 env，造成功能↔UI 不一致（对抗评估 P1-3）。
      if (prev) {
        await this._providerStore.setActive(prev);
      } else {
        await this._providerStore.clearActive();
      }
      await this.pushProviders();
      this.post({
        type: 'notice',
        level: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 从 sessionStore 恢复会话完整历史（user + assistant），跨天合并或按日期过滤
   *
   * 恢复策略：
   *   - 内核按 `YYYY-MM-DD-main` 归档（todayDate），跨天会落在不同 key；
   *     默认遍历全部 `*-main` 会话合并加载，杜绝「隔天历史丢失」（用户实测发现）；
   *     传入 date 时只加载该天的 main 会话（toolbar 历史下拉手动切换查看）。
   *   - user 消息：回放剥离 `[当前打磨文档内容]` 前缀（该前缀为宿主注入的当前任务上下文，
   *     不属于用户实际输入，仅用于 LLM 上下文，不应回显）。
   *   - assistant 消息：回放上一次流式输出的完整内容（避免拼接不完整流）。
   *   - 内核注入的 `<user_input>` 系统消息跳过（由内核 appendUser 持久化的 user 消息替代）。
   *
   * @param date 可选过滤日期（YYYY-MM-DD），缺省/空串 = 全部跨天合并
   * @returns 带 role/timestamp 标记的会话消息列表（按时间升序）
   */
  private loadHistory(date?: string): { role: 'user' | 'assistant'; content: string; ts?: string }[] {
    try {
      const result: { role: 'user' | 'assistant'; content: string; ts?: string }[] = [];
      for (const key of this.sessionStore.listSessions()) {
        // key 格式：YYYY-MM-DD-session；只取 main 会话（面板单会话模型）
        if (!key.endsWith('-main')) continue;
        const idx = key.lastIndexOf('-');
        const keyDate = key.slice(0, idx);
        // 指定查看日期时，跳过其他日期的会话
        if (date && keyDate !== date) continue;
        const msgs = this.sessionStore.loadMessages(keyDate, 'main') as {
          role?: string;
          content?: string;
          timestamp?: string;
        }[];
        for (const m of msgs) {
          if (!m.content || m.content.startsWith('<user_input>')) continue;
          result.push({
            role: (m.role === 'user' || m.role === 'assistant' ? m.role : 'user') as
              | 'user'
              | 'assistant',
            content: m.role === 'user' ? stripDocContextPrefix(m.content) : m.content,
            ts: m.timestamp,
          });
        }
      }
      // 跨天合并后按时间升序（消息存储顺序可能因多次回放而乱序）
      result.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
      // 上限保护：仅回放最近 MAX_HISTORY_MESSAGES 条（按时间升序取末段）。
      // 单天历史通常远低于上限不受影响；跨天合并视图聚焦近期对话，避免长期
      // 使用后消息累积导致每次打开/切换都全量回放 + 逐条建 DOM（对抗评估 P1-7）
      return result.slice(-MAX_HISTORY_MESSAGES);
    } catch (err) {
      // 读取失败不阻塞面板展示，但需记录（SSOT 不藏错，避免「历史空白」静默吞因）
      console.warn('Memora 加载会话历史失败', err);
      return [];
    }
  }

  /** 当前会话的 date/session（默认当天 main，复用内核会话组织） */
  private sessionInfo(): { date: string; session: string; store: HostSessionStore } {
    // 复用内核 formatDateKey（本地时区 YYYY-MM-DD），替代手写日期拼接（对抗评估 P2-5）
    const date = formatDateKey(new Date());
    return { date, session: 'main', store: this.sessionStore };
  }

  /** 持久化一条消息 */
  private persist(role: 'user' | 'assistant', content: string): void {
    const { date, session, store } = this.sessionInfo();
    store.appendMessage(date, session, { role, content, timestamp: new Date().toISOString() });
  }

  /** 向 webview 发送消息 */
  private post(msg: ExtensionToWebviewMessage): void {
    void this._view?.webview.postMessage(msg);
  }

  /** 处理用户输入：面板上屏 + Agent 流式对话（持久化由内核 appendUser 完成，SSOT 不双写）
   *
   * 插话语义（mvp-scope 打断能力）：生成中用户发送新消息 = 中断当前流 + 作为新消息重发。
   * 必须 await 旧流彻底结束（chatLock 释放）再发起新 chat，否则触发 busy 冲突；等待期间
   * 旧流 consumeFlow 会发送 interrupted 通知 webview（恢复输入框 + 渲染「已停止」提示）。 */
  private async handleSend(input: string): Promise<void> {
    if (!this._agent) {
      // Agent 未装配（可能仍在懒装配中）：提示用户稍候，而非静默无反应
      void vscode.window.showWarningMessage('Memora：Agent 尚未就绪，请稍候片刻再发送');
      return;
    }
    // 插话：生成中发送 → 中断当前流（abort() 同步置 signal.aborted，供 consumeFlow
    // 判定并发送 interrupted），待旧流结束后走正常发送路径（此时 _streaming 已复位，
    // 不会再次进入本分支）
    if (this._streaming && this._abortController) {
      this._abortController.abort();
      await this._currentFlow;
    }
    const now = new Date().toISOString();
    // P1-1：若正查看历史日期，发送前回置到「全部历史（当前会话）」视图，
    // 避免新消息持久化到今天却显示在历史日期视图的状态错位。
    // handleSwitchDate('') 会清空消息区 + 回放当前 + 回传 chat_history_view('')
    if (this._historyDate) this.handleSwitchDate('');
    // 用户消息持久化由内核 chat() → appendUser 完成（写入 todayDate-main），
    // 此处不再 persist，避免与内核双写同一条消息（SSOT 单一真理源）
    this.post({ type: 'user', text: input, ts: now });

    // 注入文档上下文（当前任务上下文，不进入记忆召回）
    const chatInput = this._docContext
      ? `[当前打磨文档内容]\n${this._docContext}\n[/当前打磨文档内容]\n\n用户请求：${input}`
      : input;

    // runFlow 统一管理 AbortController + consumeFlow + 同步抛错兜底
    await this.runFlow((signal) => this._agent!.chat(chatInput, signal));
  }

  /** 处理用户对主动提问的回答：persist + resumeExecution 续跑 */
  private async handleResume(input: string): Promise<void> {
    if (!this._agent) return;
    const now = new Date().toISOString();
    // P1-1：与 handleSend 同一状态错位防护——正查看历史时回答，先回置到当前会话视图
    if (this._historyDate) this.handleSwitchDate('');
    // resumeExecution 内核路径不写 user 消息（仅 appendAssistant），
    // 此处由 UI 补写，避免回答丢失（内核 resume 能力缺口，宿主补丁）
    this.persist('user', input);
    this.post({ type: 'user', text: input, ts: now });
    await this.runFlow((signal) => this._agent!.resumeExecution(input, signal));
  }

  /**
   * 运行一轮 Agent 流（chat / resumeExecution 的统一入口）
   *
   * 抽取动机：handleSend / handleResume 原先各写一份「新建 AbortController +
   * consumeFlow + catch 清理」样板，2 处重复构成该抽却漏抽的回溯信号
   * （coding-convention §3）。内部新建本轮 controller（上一轮已在 consumeFlow
   * finally 清理），以 factory 注入 signal 供内核流使用；同步抛错（如 chatLock
   * busy）时兜底给出可见错误（对抗评估 P1-2）——因从未进入 thinking 状态，输入框
   * 未被禁用，无需再补发 status done。
   */
  private async runFlow(
    factory: (signal: AbortSignal) => AsyncGenerator<AgentChunk, void, unknown>,
  ): Promise<void> {
    this._abortController = new AbortController();
    try {
      this._currentFlow = this.consumeFlow(
        factory(this._abortController.signal),
        this._abortController,
      );
      await this._currentFlow;
    } catch (err) {
      // 同步抛错路径：清理 controller，避免 AbortController 泄漏
      this._abortController = undefined;
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * 停止生成：用户主动中断当前流式输出（mvp-scope 打断能力）
   *
   * 无进行中流时 no-op（可安全重复点击）。abort 后内核 generator 在下一个
   * await 点退出并 yield aborted chunk，consumeFlow 捕获后发送 interrupted
   * 通知 webview（恢复输入框 + 渲染「已停止」提示）。
   */
  private handleStop(): void {
    if (!this._streaming || !this._abortController) return;
    // abort() 同步置 signal.aborted，consumeFlow 末尾据此判定发送 interrupted
    this._abortController.abort();
  }

  /** 消费 Agent 流：转发 text chunk，监听主动提问事件，透出运行状态，支持用户打断
   *  @param gen Agent 流（chat / resumeExecution）
   *  @param controller 本轮 AbortController：stop / 插话经 abort() 中断流；
   *         finally 中与本轮 controller 比对后清理（避免误清下一轮的 controller） */
  private async consumeFlow(
    gen: AsyncGenerator<AgentChunk, void, unknown>,
    controller: AbortController,
  ): Promise<void> {
    if (!this._agent) return;
    // 监听主动提问事件 → 渲染提问框
    const onPendingQuestion = (questions: { slot: string; question: string }[]) => {
      this.post({ type: 'need_clarify', questions });
    };
    this._agent.on('questionPending', onPendingQuestion);
    // 监听记忆事件 → 转发到 webview 展示记忆条（recalled：「想起」/ added：「已沉淀」）
    // 对齐 kernel 对称事件：memoryRecalled {count,query} / memoryAdded {id,source,name}
    const onMemoryRecalled = (info: { count: number }) => {
      this.post({ type: 'memory', action: 'recalled', count: info.count });
    };
    const onMemoryAdded = (info: { id: string; source: string; name: string }) => {
      this.post({ type: 'memory', action: 'added', count: 1, detail: info });
    };
    this._agent.on('memoryRecalled', onMemoryRecalled);
    this._agent.on('memoryAdded', onMemoryAdded);

    // P0-2：进入生成状态（webview 展示加载动画 + 禁用输入）
    this.post({ type: 'status', state: 'thinking' });
    // 置位生成态：handleSwitchDate 据此拒绝切换历史（P1-3）
    this._streaming = true;
    // P1：流式第一条 chunk 的时间戳（作为本轮 assistant 回复的时间）
    let firstChunkTs = new Date().toISOString();
    try {
      for await (const chunk of gen) {
        if (chunk.type === 'aborted') {
          // 用户 stop/插话 → 内核 abort 应答：提前退出，不再转发后续 chunk
          //（中断通知统一由本方法末尾按 controller.signal.aborted 发出）
          break;
        }
        if (chunk.type === 'text' && chunk.content) {
          this.post({ type: 'chunk', content: chunk.content, ts: firstChunkTs });
        } else if (chunk.type === 'tool_start') {
          // 工具调用开始 → webview 渲染「执行中」卡片
          this.post({ type: 'tool_start', toolCallId: chunk.toolCallId, name: chunk.name, args: chunk.args });
        } else if (chunk.type === 'tool_result') {
          // 工具调用结束 → 更新卡片状态
          this.post({
            type: 'tool_result',
            toolCallId: chunk.toolCallId,
            name: chunk.name,
            ok: chunk.ok,
            summary: chunk.summary,
          });
        } else if (chunk.type === 'selfReview') {
          // 自审查轮开始 → 转发为过程性提示（活动透明，交叉审核观察 A）
          this.post({ type: 'self_review', round: chunk.round });
        }
      }
      // assistant 消息持久化由内核 appendAssistant 完成（写入 todayDate-main），
      // 此处不再 persist，避免与内核双写同一条回复（SSOT 单一真理源）
    } catch (err) {
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      this._agent.off('questionPending', onPendingQuestion);
      this._agent.off('memoryRecalled', onMemoryRecalled);
      this._agent.off('memoryAdded', onMemoryAdded);
      // 无论成败均清除生成态（恢复历史切换能力，P1-3）
      this._streaming = false;
      // 清理本轮 AbortController：仅当仍是本轮的 controller（防止下一轮已创建新 controller）
      if (this._abortController === controller) this._abortController = undefined;
    }
    // 结束状态：用户打断（abort() 已置 signal.aborted）→ interrupted（webview 渲染
    // 「已停止」并恢复输入框）；正常结束 → done。两者均恢复输入框，仅提示语义不同。
    if (controller.signal.aborted) {
      this.post({ type: 'interrupted' });
    } else {
      this.post({ type: 'done' });
    }
    this.post({ type: 'status', state: 'done' });
  }
}

/** 生成 Webview HTML（含消息区 / 输入框 + 模型下拉框 / 主动提问框）
 *  @param scriptUri 外部脚本 chatView.js 的 asWebviewUri（CSP script-src 'self' 加载，阶段 B P2-1） */
function buildHtml(scriptUri: vscode.Uri): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'self';" />
<style>
  ${chatStyles}
  ${dropdownStyles}
  ${toolCardStyles}
</style>
</head>
<body>
  <div id="toolbar">
    <span class="title">文档打磨</span>
    <span id="skillBadge" class="skill-badge" hidden title="当前技能"></span>
    ${buildDropdownHtml([], { extraClass: 'history-picker treedd--capsule', onSelect: '__historyPickerOnSelect' })}
    ${buildDropdownHtml([{ id: 'clear', label: '清空对话', danger: true }])}
  </div>
  <div id="memoryBar" class="memory-bar" hidden></div>
  <!-- 提示条（错误级 / 低扰 info）：不插入消息区，独立承载会话异常等通知 -->
  <div id="noticeBar" class="notice-bar" hidden></div>
  <div id="messages">
    <div id="emptyState" class="empty-state" hidden>开始打磨你的设计文档<br>在下方输入你的想法，或粘贴要打磨的文档内容</div>
  </div>
  <div id="clarifyBar">
    <div id="clarifyText"></div>
    <div id="clarifyOptions"></div>
    <div id="clarifyRow">
      <input id="clarifyInput" type="text" placeholder="回答 Agent 的问题，回车提交……" aria-label="回答 Agent 的问题" />
      <button id="clarifySend">提交回答</button>
    </div>
  </div>
  <div id="inputBar">
    <div id="inputWrap">
      <textarea id="input" rows="1" placeholder="在文档上打磨你的想法……（Enter 发送，Shift+Enter 换行）" aria-label="消息输入"></textarea>
      <div id="inputFooter">
        ${buildDropdownHtml([], { extraClass: 'model-picker treedd--capsule', onSelect: '__modelPickerOnSelect' })}
        <button id="send" class="send-btn" title="发送 (Enter)" aria-label="发送">
          <svg class="send-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
          <!-- 生成中切换为停止方块（loading 类驱动）：点击 = 停止当前生成（mvp-scope 打断能力） -->
          <svg class="stop-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
        </button>
      </div>
    </div>
  </div>
  <!-- 阶段 B（P2-1）：运行时脚本由外部 chatView.js 提供（CSP script-src 'self'） -->
  <script src="${scriptUri}"></script>
</body>
</html>`;
}