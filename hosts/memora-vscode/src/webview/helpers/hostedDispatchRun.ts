/**
 * 派发执行域（`send_to_session` 宿主侧实现，面板只留注入依赖的薄壳）
 *
 * 三条硬约束（与 `workSessionTools.ts` 头注释同源）：
 *   ① **不注入用户上下文**，只投调用方给的原文；
 *   ② **不绕过并发闸**：目标在跑回 `E_BUSY`（不排队）；
 *   ③ handler 不持有面板实例，只拿注入回调。
 *
 * 为什么先拿写锁：派发必然在目标会话里建新轮（内核 `appendUser` → `appendRoundId`），
 * 而会话文件整写有 fail-closed 跨进程锁守卫。不持锁就写，内核只 warn 后丢引用 ⇒ 轮文件在、
 * 会话 `roundIds` 里没有它（孤儿轮），重启后这一轮从会话历史消失（真机 2026-11-15）。
 * 触发条件具体、非偶发：目标会话**已存在**（重启前就有）且本面板**未持锁**（本进程没进过它）；
 * 助手新建的会话因 `createSession` 已拿锁，所以只有「派给用户自建会话」会中招。
 * 锁的归还时机见 `hostedDispatchLock`（只盖住本轮，收场即还；用户正在看则保留长锁）。
 *
 * 为什么外置：`chatPanel.ts` 贴 `max-lines` 基线（只降不升），本域是自足的「校验 → 拿锁 →
 * 起流 → 收尾」闭环，与 `hostedSessionCreate` 同一拆法——面板只注入窄依赖，不为过闸压平代码。
 */
import * as vscode from 'vscode';
import { logger } from '@zooique/memora';
import type { Agent, AgentChunk, IRoundStore } from '@zooique/memora';
import type { HostedDispatchResult } from '../../extension/host/workSessionTools.js';
import { hasRoundPresenceProbe } from '../../extension/host/workspaceRoundStore.js';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { acquireDispatchWriteLease, type DispatchWriteLease } from './hostedDispatchLock.js';
import type { FlowSeed } from './sessionRuntime.js';

// 本模块文案走 l10n（与面板同一套键面）
const { l10n } = vscode;

/** 派发执行域的依赖（全部是延迟闭包：面板不向外泄露实例，也不与调用时机耦合） */
export interface HostedDispatchDeps {
  /** 调用方是否托管（装配期事实；重启回落 self 时工具面本就不存在，这里只是防御） */
  isManaged: (sessionId: string) => boolean;
  /** 该会话当前是否在跑流（peek 语义：读操作不建记录） */
  isStreaming: (sessionId: string) => boolean;
  /**
   * 目标会话是否处于「用户亲手发轮且未收场」的接管态（DISPATCH-TAKEOVER-GUARD-1）
   *
   * 与 isAgentDriven 不同：派发目标可以是用户自建会话，门禁须看「用户此刻是否在亲自操作」
   * 而非「会话是否代理出生」。暂停 / ask 等待期 streaming=false，E_BUSY 挡不住，须靠本判据
   * 拒绝——否则 agent.chat 会自动 resume 用户暂停的轮（fail-open）。
   */
  isTargetTakenOver: (sessionId: string) => boolean;
  /** 面板当前显示源（判断「用户是否正在看目标会话」，决定收尾还不还锁） */
  currentSessionId: () => string;
  /** 取（或确认已持有）目标会话的跨进程写锁；false = 另一个窗口正持有 */
  acquireLock: (sessionId: string) => Promise<boolean>;
  /** 本面板当前是否已长持有该会话锁 */
  holdsLock: (sessionId: string) => boolean;
  /** 归还本面板长持有的该会话锁 */
  releaseLock: (sessionId: string) => void;
  /** 取（或建）目标会话实例（装配可能在途） */
  getAgent: (sessionId: string) => Promise<Agent>;
  /**
   * 目标会话引用的轮 ID（会话文件真源；拿锁重读之后才是本窗口最新值）
   *
   * 单独给读口而不是直接给 `findMissingRounds`：核对逻辑在存储侧（结构化能力探测），
   * 面板只注入两个既有事实来源，不把目录扫描搬进 max-lines 贴顶的面板。
   */
  roundIds: (sessionId: string) => string[];
  /** 当前 Round 存储（延迟读：装配注入晚于构造；不具备探针能力时自检跳过，不阻断派发） */
  roundStore: () => IRoundStore | undefined;
  /** 受理即登记「该会话由代理驱动」（停止 / 暂停 / 恢复、中断通知、工作台共用判据） */
  markAgentDriven: (sessionId: string) => void;
  /** 记下「谁派来」（落定汇报的收件人） */
  rememberCreator: (sessionId: string, creator: string) => void;
  /** 把写权租约挂到该会话（流收尾统一归还，异常路径同样走那里） */
  trackLease: (sessionId: string, lease: DispatchWriteLease) => void;
  /**
   * 把这条派发输入即时上屏到目标会话（真机 DISPATCH-USER-ECHO-1）
   *
   * 与用户自己发消息的 `post({type:'user'})` 同一时机：只靠 seed 落盘 + 收场 turn_update
   * 是**实时不可见**的——收场投影 replay=false，webview 不重建气泡，只有切会话/重启触发
   * replay 才从落盘补出。派发代用户输入，理应在目标会话即时看到那条提示词气泡。
   */
  postUserEcho: (
    sessionId: string,
    echo: Extract<ExtensionToWebviewMessage, { type: 'user' }>,
  ) => void;
  /** 走既有流通路（不另造流）：`void` 语义——受理即返回，不等目标轮跑完 */
  startFlow: (
    sessionId: string,
    factory: (signal: AbortSignal) => AsyncGenerator<AgentChunk, void, unknown>,
    seed: FlowSeed,
  ) => void;
}

/**
 * 向目标会话派发一条输入
 *
 * @param deps 面板注入的窄依赖
 * @param callingSessionId 调用方会话（非托管 = `E_DENIED`）
 * @param targetSessionId 目标会话（必须是已知会话，存在性由工具层先判）
 * @param text 派发原文（不注入任何信封）
 * @param senderName 发送者名（落盘消息名 + `dispatchedBy.from` 的对侧展示）
 * @returns 受理 / 拒收回执（拒收必带可操作下一步）
 */
export async function dispatchHostedInputWith(
  deps: HostedDispatchDeps,
  callingSessionId: string,
  targetSessionId: string,
  text: string,
  senderName: string,
): Promise<HostedDispatchResult> {
  logger.info({ from: callingSessionId, to: targetSessionId }, '宝派发活');
  // ① 调用方身份
  if (!deps.isManaged(callingSessionId)) {
    logger.warn({ from: callingSessionId, code: 'E_DENIED' }, '派发被拒：调用方非托管');
    return {
      ok: false,
      code: 'E_DENIED',
      message: l10n.t('Memora: only managed sessions can call send_to_session.'),
    };
  }
  // ①.5 目标接管门禁（DISPATCH-TAKEOVER-GUARD-1）：用户正在这条会话里亲手发轮且未收场（含
  //     软暂停 / ask 等待——两态 streaming=false，E_BUSY 挡不住），代理不许往里插输入。
  //     不接 isAgentDriven：派发目标可以是用户自建会话，那样会误伤设计内的正常派发。
  if (deps.isTargetTakenOver(targetSessionId)) {
    logger.warn(
      { from: callingSessionId, to: targetSessionId, code: 'E_DENIED' },
      '派发被拒：目标会话用户接管中',
    );
    return {
      ok: false,
      code: 'E_DENIED',
      message: l10n.t(
        'Memora: the target session is being handled by you right now; the input was not sent. Finish or stop your turn first.',
      ),
    };
  }
  // 前置判忙的同一份信封（两处判据必须同文案，抽一份防漂移）
  const busy: HostedDispatchResult = {
    ok: false,
    code: 'E_BUSY',
    message: l10n.t('Memora: the target session is running; the input was not sent.'),
  };
  // ② 前置判忙：peek 不建记录，值就是该会话的真实 stream 运行态
  if (deps.isStreaming(targetSessionId)) {
    logger.warn(
      { from: callingSessionId, to: targetSessionId, code: 'E_BUSY' },
      '派发被拒：目标在跑',
    );
    return busy;
  }
  // ③ 目标会话写权（判据与归还时机都在 hostedDispatchLock）：拿不到 = 另一个窗口在用 ⇒ 如实拒收
  const lease = await acquireDispatchWriteLease(
    {
      acquire: deps.acquireLock,
      holds: deps.holdsLock,
      release: deps.releaseLock,
      // 用户正在看 / 仍在跑流 ⇒ 保留长锁（「进入过的会话」语义，不是本次派发所有）
      inUse: (sessionId) => sessionId === deps.currentSessionId() || deps.isStreaming(sessionId),
    },
    targetSessionId,
  );
  if (lease.refusal) {
    logger.warn(
      { from: callingSessionId, to: targetSessionId, code: lease.refusal.code },
      '派发被拒：写租约不可得',
    );
    return lease.refusal;
  }
  try {
    // ③.5 轮引用完整性自检（D1）：拿锁已重读会话文件（roundIds 为最新引用真源），
    //     接着核对「引用的轮文件在不在盘上」。外部移走轮文件 = 会话历史已残缺，
    //     此时再 append 会留下永久悬空引用（重启后该轮永久失踪）⇒ 拒收，不落任何新轮。
    //     判据是盘上目录列举（同一 WorkspaceRoundStore 真源），不读正文缓存/状态索引。
    /** 缺失的轮 ID（空数组 = 引用完整；存储无探针能力 = 跳过自检） */
    let missingRounds: string[] = [];
    try {
      const roundStore = deps.roundStore();
      missingRounds =
        roundStore && hasRoundPresenceProbe(roundStore)
          ? roundStore.findMissingRounds(deps.roundIds(targetSessionId))
          : [];
    } catch (err) {
      // 目录存在但读不了：区分于「缺失」，同样拒收（fail-closed，不猜可用）
      lease.releaseIfIdle();
      logger.warn(
        { from: callingSessionId, to: targetSessionId, code: 'E_UNREADABLE', err },
        '派发被拒：rounds 目录不可读',
      );
      return {
        ok: false,
        code: 'E_UNREADABLE',
        message: l10n.t(
          "Memora: the target session's round files cannot be read; the input was not sent. Check the rounds directory and retry.",
        ),
      };
    }
    if (missingRounds.length > 0) {
      lease.releaseIfIdle();
      logger.warn(
        {
          from: callingSessionId,
          to: targetSessionId,
          code: 'E_UNREADABLE',
          missing: missingRounds.length,
        },
        '派发被拒：目标会话轮文件缺失',
      );
      return {
        ok: false,
        code: 'E_UNREADABLE',
        message: l10n.t(
          'Memora: the target session is missing {0} round file(s) ({1}); the input was not sent. Restore them from the rounds trash or start a new session, then retry.',
          String(missingRounds.length),
          missingRounds.slice(0, 3).join(', '),
        ),
      };
    }
    // ④ 取（或建）目标会话实例：装配可能在途，期间目标会话或已被别的入口开跑 ⇒ 落地前再判一次
    const agent = await deps.getAgent(targetSessionId);
    // 与 sendInput 同一对齐判据：内核 appendUser 写的是 agent 当前会话，错位会写进别的会话；
    // 只在错位时切，且**不改面板显示源**（后台派发不得把用户界面拽到目标会话）
    const sessionManager = agent.sessionManager;
    if (sessionManager) {
      const info = sessionManager.getCurrentSessionInfo();
      if (info && `${info.date}-${info.session}` !== targetSessionId) {
        await sessionManager.switchToSession(targetSessionId);
      }
    }
    if (deps.isStreaming(targetSessionId)) {
      lease.releaseIfIdle();
      logger.warn(
        { from: callingSessionId, to: targetSessionId, code: 'E_BUSY' },
        '派发被拒：二次判忙',
      );
      return busy;
    }
    const now = new Date().toISOString();
    // ⑤ 受理即登记驱动归属：必须早于首轮流（首轮可能立刻失败 / 被停，晚登记会漏中断通知）；
    //    用户自建的会话被派活后同样归代理（收回仍由用户说了算）
    deps.markAgentDriven(targetSessionId);
    deps.rememberCreator(targetSessionId, callingSessionId);
    deps.trackLease(targetSessionId, lease);
    // ⑤.5 即时上屏这条代发输入（与 sendInput 同序：先 user 回声、再起流）：
    //     text 用裸输入（与 seed.content / 落盘原文同值），ts 与 seed 同源；origin+senderName
    //     让 webview 画「Sent by Memora」标签。缺这一步 = 实时无气泡、切会话才补出（真机实锤）。
    deps.postUserEcho(targetSessionId, {
      type: 'user',
      text,
      ts: now,
      origin: 'hosted',
      senderName,
    });
    // ⑥ 走既有流通路：attachments 不传（派发通道不收图）；opts 让内核把本轮 origin 落 'hosted'、
    //    消息名落 senderName，并把「谁派来」记到 Round.dispatchedBy（重启后工作台靠它反查）
    deps.startFlow(
      targetSessionId,
      (signal) =>
        agent.chat(text, signal, undefined, {
          origin: 'hosted',
          senderName,
          dispatchedBy: { from: callingSessionId, via: 'delegate' },
        }),
      {
        // seed = 上屏与 live 投影用的裸输入：**没有**注入信封，与落盘原文同值
        userMessage: {
          id: `live-hosted-${now}`,
          role: 'user',
          content: text,
          timestamp: now,
          name: senderName,
        },
        origin: 'hosted',
      },
    );
    logger.info({ from: callingSessionId, to: targetSessionId }, '派发受理成功');
    return { ok: true, accepted: true };
  } catch (err) {
    // 起流前就失败（装配 / 切会话抛错）：租约当场归还，不把临时锁漏在本面板
    lease.releaseIfIdle();
    logger.error({ from: callingSessionId, to: targetSessionId, err }, '派发异常：起流前抛错');
    throw err;
  }
}
