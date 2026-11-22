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
import type {
  HostedDispatchInput,
  HostedDispatchResult,
} from '../../extension/host/workSessionTools.js';
// 交代消息与流式正文同构（复用既有 chunk 渲染，不新造消息类型）
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { hasRoundPresenceProbe } from '../../extension/host/workspaceRoundStore.js';
import { acquireDispatchWriteLease, type DispatchWriteLease } from './hostedDispatchLock.js';
// 派活账本（判据 C）：旁路记「受理 → 落定 / 悬空」，失败不影响派发
import {
  abortDispatchLedger,
  recordDispatchLedger,
} from '../../extension/host/dispatchLedger.js';
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
  /** 走既有流通路（不另造流）：`void` 语义——受理即返回，不等目标轮跑完 */
  startFlow: (
    sessionId: string,
    factory: (signal: AbortSignal) => AsyncGenerator<AgentChunk, void, unknown>,
    seed: FlowSeed,
  ) => void;
  /**
   * 项目根（派活账本落盘用；缺省 = 不记账——测试 / 旧装配零破坏）
   *
   * 路径推导仍走 `extension/host/projectDataDir.ts` 单点，本模块不拼目录名。
   */
  projectPath?: () => string;
  /**
   * 把一条正文段推进调用方会话并上屏（派发交代用）
   *
   * 消息形态与流式 chunk 完全同构，复用既有渲染路径；面板实现只做投递
   * （`postToSession(callingSessionId, msg)`）。
   */
  note: (msg: Extract<ExtensionToWebviewMessage, { type: 'chunk' }>) => void;
}

/** 派发执行域入参（形状与工具层同一份类型，防两处各写一份） */

/**
 * 向目标会话派发一条输入
 *
 * @param deps 面板注入的窄依赖
 * @param callingSessionId 调用方会话（非托管 = `E_DENIED`）
 * @param targetSessionId 目标会话（必须是已知会话，存在性由工具层先判）
 * @param text 派发原文（不注入任何信封）
 * @param senderName 发送者名（落 `RoundMessage.name` 的展示名，取 `HOSTED_SENDER_NAME`；
 *                    `Round.dispatchedBy` 是纯数据、不参与任何上屏文案）
 * @returns 受理 / 拒收回执（拒收必带可操作下一步）
 */
export async function dispatchHostedInputWith(
  deps: HostedDispatchDeps,
  input: HostedDispatchInput,
): Promise<HostedDispatchResult> {
  const { callingSessionId, targetSessionId, text, senderName, targetTitle } = input;
  /**
   * 派发交代（机制保证）：把「派给谁 + 派什么活（原文）」写进**调用方当前轮**并上屏。
   *
   * 为什么由宿主写：模型自己的交代常落在 `narrate` 过程事件里（助手形态隐藏过程流，
   * reload 后消失）；宿主写入的是 `assistantLog` 的正文段，重放天然带出。
   * 失败一律静默降级——交代写不进去不能连累派发（主次不能颠倒）。
   *
   * @param content 已拼好的交代正文（真值只来自会话标题与派发原文）
   */
  const noteCaller = (content: string): void => {
    try {
      const roundId = deps.roundIds(callingSessionId).at(-1);
      const store = deps.roundStore();
      const round = roundId && store ? store.getById(roundId) : undefined;
      const ts = new Date().toISOString();
      if (roundId && store && round) {
        store.save({
          ...round,
          assistantLog: [
            ...(round.assistantLog ?? []),
            {
              id: `msg-${roundId}-dispatch-note-${Date.now()}`,
              role: 'assistant',
              content,
              timestamp: ts,
            },
          ],
        });
      }
      deps.note({ type: 'chunk', content: `\n\n${content}\n`, ts, roundId: roundId ?? '' });
    } catch (err) {
      logger.warn({ err }, '派发交代写入失败（不影响派发）');
    }
  };
  /** 派给谁 / 派什么活的唯一文案来源（标题 + 原文，不生成、不润色） */
  const noteText = `派给《${targetTitle}》：\n\n${text}`;
  /** 失败收尾：在同一气泡补一句为什么没派成（既有错误文案原文，不新造） */
  const noteFail = (message: string): void => noteCaller(`没派出去：${message}`);
  /**
   * 成功收尾：明确本次只到「受理」，落盘与结果看目标会话（与失败收尾对仗）
   *
   * 为什么必须有：成功路径原本无收尾，静默丢弃时界面只留「派给《X》」无下文，
   * 用户分不清「还在跑」和「根本没送出去」。这句不承诺落盘——派发的成功口径
   * 到起流受理为止，目标会话是否出活由它自己的气泡与时间证明。
   */
  const noteAccepted = (): void => noteCaller('已接单，等目标会话回话');
  logger.info({ from: callingSessionId, to: targetSessionId }, '宝派发活');
  // 派发前先把交代写上屏（机制保证）：拒绝路径也会在同一气泡里补一句收尾
  noteCaller(noteText);
  // ① 调用方身份
  if (!deps.isManaged(callingSessionId)) {
    logger.warn({ from: callingSessionId, code: 'E_DENIED' }, '派发被拒：调用方非托管');
    const denied: HostedDispatchResult = {
      ok: false,
      code: 'E_DENIED',
      message: l10n.t('Memora: only managed sessions can call send_to_session.'),
    };
    noteFail(denied.message);
    return denied;
  }
  // ①.5 目标接管门禁（DISPATCH-TAKEOVER-GUARD-1）：用户正在这条会话里亲手发轮且未收场（含
  //     软暂停 / ask 等待——两态 streaming=false，E_BUSY 挡不住），代理不许往里插输入。
  //     不接 isAgentDriven：派发目标可以是用户自建会话，那样会误伤设计内的正常派发。
  if (deps.isTargetTakenOver(targetSessionId)) {
    logger.warn(
      { from: callingSessionId, to: targetSessionId, code: 'E_DENIED' },
      '派发被拒：目标会话用户接管中',
    );
    const denied: HostedDispatchResult = {
      ok: false,
      code: 'E_DENIED',
      message: l10n.t(
        'Memora: the target session is being handled by you right now; the input was not sent. Finish or stop your turn first.',
      ),
    };
    noteFail(denied.message);
    return denied;
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
    noteFail(busy.message);
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
    noteFail(lease.refusal.message);
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
        message: (() => {
          const message = l10n.t(
            "Memora: the target session's round files cannot be read; the input was not sent. Check the rounds directory and retry.",
          );
          noteFail(message);
          return message;
        })(),
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
        message: (() => {
          const message = l10n.t(
            'Memora: the target session is missing {0} round file(s) ({1}); the input was not sent. Restore them from the rounds trash or start a new session, then retry.',
            String(missingRounds.length),
            missingRounds.slice(0, 3).join(', '),
          );
          noteFail(message);
          return message;
        })(),
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
      noteFail(busy.message);
      return busy;
    }
    const now = new Date().toISOString();
    // ⑤ 受理即登记驱动归属：必须早于首轮流（首轮可能立刻失败 / 被停，晚登记会漏中断通知）；
    //    用户自建的会话被派活后同样归代理（收回仍由用户说了算）
    deps.markAgentDriven(targetSessionId);
    deps.rememberCreator(targetSessionId, callingSessionId);
    deps.trackLease(targetSessionId, lease);
    // ⑤.5 开轮回声不在这里推：它必须**随轮建立**上屏（DISPATCH-USER-ECHO-1）。
    //     轮建立前推孤立气泡没有归属（buildLiveTurn 以 roundId 为界），ready 重放会被
    //     resetChatView 清掉；现由 consumeFlow 在首个带 roundId 的 chunk 上屏（seed 同源）。
    // 旁路记账必须先于 startFlow（与 create 同型）：首轮从起流到落定可能极快，晚记会让
    // settle 落在 dispatch 之前，账本按行序配对就找不到主人。被拒路径前面已 return，
    // 不会入账；账本写坏只 warn，不让已受理的派发变成失败。
    let projectPath: string | undefined;
    try {
      projectPath = deps.projectPath?.();
      if (projectPath) {
        recordDispatchLedger(projectPath, {
          kind: 'send',
          callerSessionId: callingSessionId,
          targetSessionId,
          targetTitle,
          text,
          // 调用方当时的轮 id：只作追溯线索，不参与核销匹配
          callerRoundId: deps.roundIds(callingSessionId).at(-1),
        });
      }
    } catch (err) {
      logger.warn(
        { err, from: callingSessionId, to: targetSessionId },
        '派活账本记账失败（不影响派发）',
      );
    }
    // ⑥ 走既有流通路：attachments 不传（派发通道不收图）；opts 让内核把本轮 origin 落 'hosted'、
    //    消息名落 senderName，并把「谁派来」记到 Round.dispatchedBy（重启后工作台靠它反查）
    try {
      deps.startFlow(
        targetSessionId,
        (signal) =>
          agent.chat(text, signal, undefined, {
            origin: 'hosted',
            senderName,
            dispatchedBy: { from: callingSessionId, via: 'delegate' },
          }),
        {
          // seed = 上屏与 live 投影用的裸输入：**没有**注入信封，与落盘原文同值。
          // 盖章统一 = 助手身份名（2026-11-20 拍板）：不再按来源会话取名——`Round.dispatchedBy`
          // 仍是纯数据（数据层有归属价值），但不参与任何上屏文案，避免同一事实两个名字源。
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
    } catch (err) {
      // 起流同步抛错 = 这笔派发永远不会有轮落定。补 aborted 终态，否则记账前移后
      // 它只会停在 pending，一小时后被误判「没回音」——同样是把失败说成没结果。
      // 写终态本身失败也只 warn：不能让原始起流错误被账本错误盖掉。
      try {
        if (projectPath) {
          abortDispatchLedger(projectPath, { targetSessionId });
        }
      } catch (abortErr) {
        logger.warn(
          { abortErr, from: callingSessionId, to: targetSessionId },
          '派活账本中止留痕失败（不影响失败返回）',
        );
      }
      throw err;
    }
    logger.info({ from: callingSessionId, to: targetSessionId }, '派发受理成功');
    noteAccepted();
    return { ok: true, accepted: true };
  } catch (err) {
    // 起流前就失败（装配 / 切会话抛错）：租约当场归还，不把临时锁漏在本面板
    lease.releaseIfIdle();
    logger.error({ from: callingSessionId, to: targetSessionId, err }, '派发异常：起流前抛错');
    throw err;
  }
}
