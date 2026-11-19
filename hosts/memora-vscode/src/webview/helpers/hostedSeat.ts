/**
 * 助手窗会话编排（HOSTED-SEAT-SESSION-1）
 *
 * 助手窗固定绑定**助手会话**（工作区指针），与侧栏当前工作会话是两条线。本模块只做四件事：
 *   ① 上行消息按目标分流（输入 / 会话操作 → 助手会话；其余 → 同一分发链）；
 *   ② 就绪回放（指针有效 ⇒ 回放那条会话；失效 ⇒ 清指针 + 空态）；
 *   ③ 首次发送建会话（后台建，不抢侧栏显示源）；
 *   ④ 确认卡可见性的「第二个可见会话」同步。
 *
 * 执行面仍归 chatPanel 的同一套状态机：本模块**不持有 agent、不做投影、不复制输入判据**，
 * 依赖全部窄接口注入。外置理由 = chatPanel 贴 max-lines 上限，而这里是自足的
 * 「来源 → 目标解析 → 转交」，与面板其余部分零共享状态。
 */
import * as vscode from 'vscode';
import { newSessionId } from './draftSession.js';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';

/** 助手窗编排依赖（字段读口 + 既有实现，面板只注入不做判断） */
export interface HostedSeatDeps {
  /** 助手会话指针（唯一身份真源） */
  assistantSessionId: () => string | undefined;
  /** 清时针（指针失效 / 会话被删时由 `SessionModeStore` 单点语义处理） */
  dropAssistantSession: (sessionId: string) => void;
  /** 会话是否仍可解析（现读会话存储，不把脏 id 当身份） */
  isResolvable: (sessionId: string) => boolean;
  /** 后台建助手会话（不切显示源） */
  createAssistantSession: (sessionId: string) => Promise<boolean>;
  /** 装配指定会话的实例（回放取角色 / 徽章前） */
  assembleAgent: (sessionId: string) => Promise<void>;
  /** 回放指定会话到绑定它的视图 */
  replaySession: (sessionId: string) => void;
  /** 同一条输入判据链（目标 = 助手会话） */
  handleInput: (
    msg: Extract<WebviewToExtensionMessage, { type: 'input' }>,
    sessionId: string,
  ) => Promise<void>;
  /**
   * 助手窗图片上行（IMAGE-TARGET-1）：按**助手会话**定向回执，不转 forward。
   *
   * forward 会把 `image_picked` 投给侧栏 `_currentSessionId` = 真机串窗根因。
   * 图片采集 / 落盘仍复用面板同一执行面，本依赖只多传一个目标会话 id。
   */
  attachImagesFrom: (msg: WebviewToExtensionMessage, sessionId: string) => void;
  /** 其余上行消息（当前会话的导航 / 全局动作） */
  forward: (msg: WebviewToExtensionMessage) => void;
  /** 该会话是否就是侧栏此刻显示的会话 */
  isCurrentSession: (sessionId: string) => boolean;
  /** 记录「侧栏会话输入框是否有字」（落定汇报的抑制判据，单份状态） */
  noteComposerState: (hasText: boolean) => void;
  /** 会话级投递（有视图绑该会话才到屏） */
  postToSession: (sessionId: string, msg: ExtensionToWebviewMessage) => void;
  /** 只投附加视图（空态：还没有会话 id 可路由） */
  postToExtras: (msg: ExtensionToWebviewMessage) => void;
  /** 停止 / 暂停（目标会话） */
  stop: (sessionId: string) => Promise<boolean>;
  pause: (sessionId: string) => void;
  /** 配置面：模型列表（全局；技能清单要实例，空态由首次发送后的回放补齐） */
  pushProviders: () => void | Promise<void>;
  /** 确认卡「第二个可见会话」（助手窗关闭时收回） */
  setAdditionalForeground: (sessionId: string | undefined) => void;
  /** 在途确认卡补推（助手窗重建后没有旧卡） */
  repostConfirm: (sessionId: string) => void;
  /** 打开工作台（命令归属仍在宿主） */
  openWorkbench: () => void;
}

/** 助手窗编排器（无状态字段，唯一内部状态 = 窗是否挂着） */
export interface HostedSeat {
  /** 解析助手会话（指针有效且仍可解析才返回；失效即清指针） */
  resolveSessionId: () => string | undefined;
  /** 同步确认卡可见性（注册 / 注销 / 指针变化时） */
  syncVisibility: () => void;
  /** 助手窗挂载状态（注册 / 注销时维护） */
  setHostedOpen: (open: boolean) => void;
  /**
   * 上行消息分流；ready 返回回放完成的 Promise，供调用方在回放后补投引用草稿
   * （ADDED-TO-ASSISTANT-1：回放会投 clear_ok 清引用，补投必须排在其后）
   */
  handleMessage: (msg: WebviewToExtensionMessage) => void | Promise<void>;
  /** 就绪回放 */
  handleReady: () => Promise<void>;
  /** 输入（首次发送可建会话） */
  handleInput: (msg: Extract<WebviewToExtensionMessage, { type: 'input' }>) => Promise<void>;
}

/**
 * 创建助手窗编排器
 *
 * @param deps 窄依赖（全部现读字段；本函数不在构造期调用它们）
 */
export function createHostedSeat(deps: HostedSeatDeps): HostedSeat {
  /** 助手窗是否已挂载（关闭后确认卡不再借它的可见性上屏） */
  let open = false;

  const resolveSessionId = (): string | undefined => {
    const sid = deps.assistantSessionId();
    if (!sid) return undefined;
    if (!deps.isResolvable(sid)) {
      deps.dropAssistantSession(sid);
      return undefined;
    }
    return sid;
  };

  const syncVisibility = (): void => {
    deps.setAdditionalForeground(open ? resolveSessionId() : undefined);
  };

  const handleReady = async (): Promise<void> => {
    const sid = resolveSessionId();
    syncVisibility();
    if (!sid) {
      // 空态只投助手窗（此时还没有会话 id 可路由）：清消息区 + 中性标题 + 模型清单
      deps.postToExtras({ type: 'clear_ok' });
      deps.postToExtras({ type: 'session_title', title: vscode.l10n.t('Assistant') });
      void deps.pushProviders();
      return;
    }
    try {
      // 回放里的角色名 / 能力徽章按**该会话实例**取：先确保装配（在途即等待）
      await deps.assembleAgent(sid);
    } catch (err) {
      console.warn(`Memora 助手会话装配失败（${sid}）`, err);
    }
    deps.replaySession(sid);
    // 在途确认卡补推：助手窗重建后没有旧卡 ⇒ 不重推就永远无法作答
    deps.repostConfirm(sid);
  };

  const handleInput = async (
    msg: Extract<WebviewToExtensionMessage, { type: 'input' }>,
  ): Promise<void> => {
    let sid = resolveSessionId();
    if (!sid) {
      // 只认「有文本的发送」建会话：其它意图（回答/续跑/钉住）在空态没有承载对象
      if (msg.kind !== 'send' || !(msg.text?.trim() ?? '')) return;
      const newId = newSessionId();
      if (!(await deps.createAssistantSession(newId))) return;
      sid = newId;
      syncVisibility();
      // 建会话后先给助手窗一份完整骨架（清空 + 标题 + 角色/技能），再发这条输入
      deps.replaySession(sid);
      deps.repostConfirm(sid);
    }
    await deps.handleInput(msg, sid);
  };

  const handleMessage = (msg: WebviewToExtensionMessage): void | Promise<void> => {
    if (msg.type === 'ready') return handleReady();
    if (msg.type === 'assistant_open_workbench') return deps.openWorkbench();
    if (msg.type === 'input') return void handleInput(msg);
    if (msg.type === 'composer_state') {
      // 单份 typing 布尔只描述侧栏当前会话：助手窗打字不压 / 不放侧栏的落定汇报
      const sid = deps.assistantSessionId();
      if (sid && deps.isCurrentSession(sid)) deps.noteComposerState(msg.hasText);
      return;
    }
    if (msg.type === 'stop' || msg.type === 'pause') {
      const sid = resolveSessionId();
      if (!sid) return;
      if (msg.type === 'stop') return void deps.stop(sid);
      return deps.pause(sid);
    }
    if (msg.type === 'clear_pending_queue' || msg.type === 'remove_pending_item') {
      // 助手窗是气泡级取景，不渲染待发送插话区 ⇒ 这两类上行无承载对象，显式忽略
      // （若将来渲染，须按助手会话投递，不能转给 forward——那会作用到侧栏会话）
      return;
    }
    if (msg.type === 'image_pick_request' || msg.type === 'image_ingest') {
      // IMAGE-TARGET-1：图片回执必须投回助手会话。转 forward 会走侧栏的 _currentSessionId，
      // 缩略图串进工作会话输入区（真机实锤）。无会话 id 时不吞——按既有 forward 兜底给可见反馈。
      const sid = resolveSessionId();
      if (sid) return deps.attachImagesFrom(msg, sid);
      return deps.forward(msg);
    }
    deps.forward(msg);
  };

  return {
    resolveSessionId,
    syncVisibility,
    setHostedOpen(value) {
      open = value;
      syncVisibility();
    },
    handleMessage,
    handleReady,
    handleInput,
  };
}
