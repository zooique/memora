/**
 * 对话面板 · 会话导航域（自 `chatPanel.ts` 按 op 组外置 · B9-D-4）
 *
 * 职责：三个**会话导航**入口——分叉（`forkCurrentSession`）/ 改名（`renameCurrentSession`）/
 * 切换（`switchToSession`）。它们的共同语义是「把显示源挪到另一个会话（或换掉它的名字）」，
 * 与消息收发、流控制无关；三者共用同一套「拿锁 → 换显示源 → 取实例 → 回放」步骤，
 * 放在一起才能让「锁归属」「实例投影表」「回放」这三条不变量只有一份实现。
 *
 * 为什么外置：`chatPanel.ts` 行数逼近 `max-lines` 基线；这组方法在面板里夹在会话生命周期
 * （createSession / agentForSession）与消息分发之间，读起来像「面板的一堆方法」，
 * 实际上是一条独立的导航链。外置后面板只留转发口（公开签名不变，webview 分发与既有
 * 白盒测试继续按原入口驱动）。
 *
 * 注入纪律：`deps` 全部是**读/写面板状态的窄闭包**，本模块不持有 provider 实例。
 */
import * as vscode from 'vscode';
import { formatDateKey, type Agent } from '@zooique/memora';
import { sessionHeldNotice } from '../helpers/sessionHistoryActions.js';
import { toNoticeText } from '../../extension/host/noticeText.js';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

/** 会话导航域的注入面（唯一构造点 = 面板字段初始化处） */
export interface ChatSessionNavOpsDeps {
  /** 向 webview 投递协议消息（面板 `post` 单点） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /** 宿主会话存储：分叉的默认锚点取自 round 列表真源（SessionMeta 不持 roundIds） */
  sessionStore: { getRoundIds(sessionId: string): string[] };
  /** 当前**显示会话** id（空串 = 草稿期） */
  getCurrentSessionId: () => string;
  /** 换显示会话 id（含「已离开草稿」与「导航指针落盘」的唯一写点） */
  setCurrentSessionId: (sessionId: string) => void;
  /** 清空显示会话 id（无旧会话可退时的唯二清空写点，须走收尾器同一入口） */
  clearSessionId: () => void;
  /** 当前会话标题（改名输入框的预填值） */
  currentTitle: () => string;
  /** 当前显示会话的实例（改名只改元数据：未就绪时静默跳过落库） */
  getAgent: () => Agent | undefined;
  /** 取已装配实例；未装配时提示并返回 undefined（分叉的唯一前置） */
  getAgentOrWarn: () => Promise<Agent | undefined>;
  /** 取/建指定会话实例（登记表本地投影的唯一写入点） */
  agentForSession: (sessionId: string) => Promise<Agent>;
  /** 会话锁收尾器：拿锁 / 已持锁判据 / 只还本次新拿的锁 */
  lock: {
    acquire(sessionId: string): Promise<boolean>;
    holds(sessionId: string): boolean;
    releaseOne(sessionId: string): void;
  };
  /** 本面板的会话实例投影表（取 / 写 / 删；真源仍在 extension 登记表） */
  sessionAgents: {
    get(sessionId: string): Agent | undefined;
    set(sessionId: string, agent: Agent): void;
    delete(sessionId: string): void;
  };
  /** 分叉后为同一实例改挂新会话键（登记表键不得漂移） */
  rekeyAgent?: (from: string, to: string) => void;
  /** 绑定显示源（含各订阅面重绑） */
  bindAgent: (agent: Agent) => void;
  /** 重放当前会话，保证 UI 与存储一致 */
  replaySession: () => void;
  /** 后台任务条按会话重投影（切换 / 分叉后必须 force） */
  postBackgroundTasks: () => void;
}

/** 会话导航域对外方法（与面板公开签名一一对应） */
export interface ChatSessionNavOps {
  forkCurrentSession(roundId?: string): Promise<void>;
  renameCurrentSession(): Promise<void>;
  switchToSession(sessionId: string): Promise<void>;
}

/**
 * 构造会话导航域
 *
 * @param deps 面板注入的窄接口（见 {@link ChatSessionNavOpsDeps}）
 */
export function createChatSessionNavOps(deps: ChatSessionNavOpsDeps): ChatSessionNavOps {
  return {
    /**
     * 分叉当前会话（AI 回复底部「分叉」按钮触发）
     *
     * 薄壳消费内核 `forkSession()`：把当前对话复制为新分支并切入（工作记忆同步到新分支）。
     * fork 不分叉记忆——记忆索引全局共享，仅对话历史分叉；空会话 / 对话繁忙由内核拒绝，
     * host 兜底转错误通知。
     */
    async forkCurrentSession(roundId?: string): Promise<void> {
      // 流中分叉由内核 forkSession 自行拒绝（对话繁忙），宿主不再前置拦——E4 批 2 拆宿主闸
      const agent = await deps.getAgentOrWarn();
      if (!agent) return;

      try {
        // 获取当前会话的最后一个 roundId 作为默认分叉点（SSOT：走 getRoundIds 真源）
        const sessionRoundIds = deps.sessionStore.getRoundIds(deps.getCurrentSessionId());
        const forkRoundId = roundId ?? sessionRoundIds[sessionRoundIds.length - 1];

        if (!forkRoundId) {
          deps.post({
            type: 'notice',
            level: 'info',
            message: vscode.l10n.t('This session has no completed turn to fork from'),
          });
          return;
        }

        // round-based 分叉：从指定 Round 位置创建新会话
        const { newSession, roundCount } = agent.forkSession(forkRoundId);
        const forkedId = `${formatDateKey(new Date())}-${newSession}`;
        // 内核分叉已在同步调用里写好了新会话文件（无锁创建豁免）；此处接管锁并重读，
        // 之后对它的写入必须有归属——拿不到说明有第三方在写这个 id（极罕见），拒绝并保持原会话
        const previous = deps.getCurrentSessionId();
        if (!(await deps.lock.acquire(forkedId))) {
          // 拿不到锁就回滚内核当前会话：内核 forkSession 已同步切到新会话，
          // 不回滚会让「内核当前会话」与「宿主显示会话」分叉（后续写到无锁会话上）
          try {
            if (agent.sessionManager) await agent.sessionManager.switchToSession(previous);
          } catch (rollbackErr) {
            console.warn(
              'Memora fork rollback failed (kernel current session may have drifted)',
              rollbackErr,
            );
          }
          deps.post({ type: 'notice', level: 'info', message: sessionHeldNotice() });
          return;
        }
        deps.setCurrentSessionId(forkedId);
        // 内核 forkSession 已把**同一实例**的当前会话切到 forkedId ⇒ 登记表键必须同步改键，
        // 否则「实例 ↔ 注册键」漂移（切回旧会话会取到停在 forkedId 的实例）
        deps.rekeyAgent?.(previous, forkedId);
        if (previous) deps.sessionAgents.delete(previous);
        deps.sessionAgents.set(forkedId, agent);
        deps.bindAgent(agent);
        deps.replaySession();
        // 会话视图入口（分叉）：同新建——后台任务条必须切到新分支自己的任务，显式 force
        deps.postBackgroundTasks();
        deps.post({
          type: 'notice',
          level: 'info',
          message: vscode.l10n.t('Forked new session "{0}" ({1} turns)', newSession, roundCount),
        });
      } catch (err) {
        deps.post({
          type: 'notice',
          level: 'error',
          message: toNoticeText(err),
        });
      }
    },

    /** 改名：只改元数据、不改会话结构（流中允许，E4 批 2 拆宿主闸） */
    async renameCurrentSession(): Promise<void> {
      const title = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Enter a new session name'),
        value: deps.currentTitle(),
        validateInput: (v) =>
          v.trim() ? undefined : vscode.l10n.t('Session name cannot be empty'),
      });
      if (title === undefined || title === null) return; // 用户取消
      const trimmed = title.trim();
      if (!trimmed) return;
      // 会话管理未就绪时静默跳过落库（UI 刷新标题不阻塞，元数据由内核侧 SessionNamer 兜底）
      deps.getAgent()?.sessionManager?.renameSession(deps.getCurrentSessionId(), trimmed);
      deps.post({ type: 'session_title', title: trimmed });
    },

    /**
     * 切换到指定会话：**按会话取/建实例**并绑定为显示源 + 回放该会话历史
     *
     * E4 批 2：不再调内核 `switchToSession` 改单实例身份（各会话各有实例、各停在自己的会话）。
     * 流中允许切换——后台会话的流继续跑，其 UI 投递由 `isBackgroundFlow()` 挡在显示会话之外。
     *
     * @param sessionId 目标会话标识（YYYY-MM-DD-sessionName）
     */
    async switchToSession(sessionId: string): Promise<void> {
      if (sessionId === deps.getCurrentSessionId()) return; // 已在目标会话
      const wasHeld = deps.lock.holds(sessionId); // 切回旧会话 = 已是长锁，失败不得误放
      // 先拿目标会话的锁：拿不到 = 另一窗口正在用，明确拒绝（不静默覆盖对方写入）
      if (!(await deps.lock.acquire(sessionId))) {
        deps.post({ type: 'notice', level: 'info', message: sessionHeldNotice() });
        return;
      }
      const previous = deps.getCurrentSessionId();
      try {
        // 切宿主当前会话 → 取该会话实例（首次进入时才装配）→ 绑定显示源
        deps.setCurrentSessionId(sessionId);
        const agent = await deps.agentForSession(sessionId);
        deps.bindAgent(agent);
        deps.replaySession();
        // 后台任务条按会话重投影（BGTASK-SWITCH-REPUSH-1）：切会话不推 ⇒ 常驻条继续显示上一个会话的任务。
        // 必须 force（两会话任务都可能为空、签名相同）；force 是**第二道保险**——`sessionChanged`
        // 已在起作用，保留它防未来调用顺序漂移，**不是必需成本，勿当冗余删掉**。
        deps.postBackgroundTasks();
      } catch (err) {
        // 切失败：只还**本次新拿**的锁（切回旧会话时本是长锁，误放会放掉仍在写盘的归属）
        if (!wasHeld) deps.lock.releaseOne(sessionId);
        deps.sessionAgents.delete(sessionId);
        if (previous) {
          deps.setCurrentSessionId(previous);
          const previousAgent = deps.sessionAgents.get(previous);
          if (previousAgent) deps.bindAgent(previousAgent);
        } else {
          // 无旧会话可退：经收尾器同一清空写点归零（守卫要求源码仅一处清空赋值）
          deps.clearSessionId();
        }
        deps.post({
          type: 'notice',
          level: 'error',
          message: toNoticeText(err),
        });
      }
    },
  };
}
