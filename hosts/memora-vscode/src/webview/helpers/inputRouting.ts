/**
 * 输入路由（HOSTED-SEAT-SESSION-1）：把一条上行 input 派到**目标会话**
 *
 * 本模块只做「按会话解析相位 → 选四条内核入口之一（发送 / 回答 / 继续 / 重生成）」，
 * 执行面（Agent、流、确认）全部由 chatPanel 注入。外置理由 = chatPanel 贴 max-lines 上限，
 * 而这段是自足的判据链（不持有状态，除 pinned 落盘外无写操作）。
 *
 * 关键不变量：
 * - **答案位次不压缩**（ASK-PARTIAL-ANSWER-1）：只 trim、不过滤，空串 = 该题未答；
 * - **错位即丢弃**（迟到回答 / 迟到续跑）不回填进行中的轮，但必须留日志痕；
 * - 草稿页只属侧栏当前会话：助手窗没有草稿，首次建会话由 `hostedSeat` 负责。
 */
import * as vscode from 'vscode';
import type { Agent, ImageRef } from '@zooique/memora';
import type {
  ChatRef,
  ExtensionToWebviewMessage,
  InjectionSource,
  TurnState,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { truncateFailNotice } from '../panels/chatTurnStructureOps.js';

type InputMsg = Extract<WebviewToExtensionMessage, { type: 'input' }>;

/** 输入路由依赖（面板注入既有实现，本模块不做状态归属判断） */
export interface InputRoutingDeps {
  /** 侧栏当前显示会话（草稿判据 / 「无会话」提示的目标） */
  currentSessionId: () => string;
  /** 是否处于草稿页（只属侧栏当前会话） */
  isDraft: () => boolean;
  /** 草稿落成会话（false = 失败已提示，中止本条输入） */
  flushDraft: () => Promise<boolean>;
  /** 取/装配目标会话实例（undefined = 未就绪，已由本模块提示） */
  ensureAgent: (sessionId: string) => Promise<Agent | undefined>;
  /** 会话级消息投递 */
  postToSession: (sessionId: string, msg: ExtensionToWebviewMessage) => void;
  /** 当前会话消息投递（无会话提示） */
  postCurrent: (msg: ExtensionToWebviewMessage) => void;
  /** 是否有待生效的模型配置（发送前补做） */
  providerStale: () => boolean;
  /** 补做模型配置（失败不拦发送；返回值不消费） */
  applyProviderRefresh: () => Promise<unknown>;
  /** 发起输入（目标会话） */
  sendInput: (
    sessionId: string,
    text: string,
    skillName?: string,
    refs?: ChatRef[],
    injections?: Exclude<InjectionSource, 'active-file'>[],
    attachments?: ImageRef[],
  ) => Promise<void>;
  /** 指定会话是否停在某等待相位 */
  isWaiting: (sessionId: string, reason: 'ask' | 'pause') => boolean;
  /** 指定会话的 turn 状态（日志痕用） */
  turnState: (sessionId: string) => TurnState;
  /** 该会话的 ask 域（只为题数校验，故只取这一个方法） */
  askFor: (sessionId: string) => {
    checkAnswerCount: (
      answers: string[],
    ) => { ok: true } | { ok: false; got: number; expected: number };
  };
  /** 作答（同一执行链） */
  answer: (answers: string[], sessionId: string) => Promise<void>;
  /** 继续（暂停态） */
  resume: (sessionId: string) => Promise<void>;
  /** 结构写操作域（只对当前会话） */
  truncateTurn: (
    roundId: string,
    confirmText: string,
    confirmLabel: string,
  ) => Promise<{ ok: boolean; reason?: string; userText?: string }>;
  /** 会话级钉住落盘 */
  writePinned: (sessionId: string, msg: InputMsg) => void;
}

/**
 * 处理一条 input（目标会话显式）
 *
 * @param deps 面板注入的窄依赖
 * @param msg 上行输入
 * @param sessionId 目标会话（助手窗 = 助手会话；侧栏 = 当前显示会话）
 */
export async function routeInput(
  deps: InputRoutingDeps,
  msg: InputMsg,
  sessionId: string,
): Promise<void> {
  const current = deps.currentSessionId();
  // 会话级钉住（0.9.0）：锁/解锁/移除是动作 ⇒ 动作即落盘，必须在草稿/Agent 守卫之前受理
  if (msg.kind === 'pin') {
    deps.writePinned(sessionId, msg);
    return;
  }
  // 草稿态只属于侧栏当前会话：助手窗没有草稿页，首次发送由 hostedSeat 建会话
  if (sessionId === current && deps.isDraft()) {
    if (msg.kind !== 'send' || !(msg.text?.trim() ?? '')) return;
    if (!(await deps.flushDraft())) return;
    // DRAFT-FIRST-SEND-1：flush 已把草稿落成真实会话（createSession 内 setCurrentSessionId +
    // agentForSession 均已就位），入口快照这个空 id 已失效。回读真源（只读访问器，不写状态）
    // 覆盖目标 id，否则下方 ensureAgent('') 弹「Agent is not ready」并吞掉首条。
    sessionId = deps.currentSessionId();
  }
  const agent = await deps.ensureAgent(sessionId);
  if (!agent) {
    // Agent 未装配（可能仍在懒装配中）：提示用户稍候，而非静默无反应
    void vscode.window.showWarningMessage(
      vscode.l10n.t('Memora: Agent is not ready; retry shortly'),
    );
    return;
  }
  // 会话管理纯度：无会话（初始空态）→ 引导手动新建，绝不隐式创建
  if (!sessionId) {
    deps.postCurrent({
      type: 'notice',
      level: 'info',
      message: vscode.l10n.t('Click + above to create a session before chatting'),
    });
    return;
  }
  switch (msg.kind) {
    case 'send': {
      const text = msg.text?.trim() ?? '';
      if (!text) return;
      // 上一轮已收场 ⇒ 新 turn 起点是唯一必然可用的安全点；补做失败不拦发送
      if (deps.providerStale()) await deps.applyProviderRefresh();
      await deps.sendInput(
        sessionId,
        text,
        msg.skillName,
        msg.refs,
        msg.injections,
        msg.attachments,
      );
      // 草稿期已锁清单补落（sendInput 已把草稿 flush 成会话，此刻才有元数据载体）
      if (msg.skillPinned === true || msg.refs?.some((r) => r.pinned === true))
        deps.writePinned(sessionId, msg);
      return;
    }
    case 'answer': {
      // 答案位次不压缩：只 trim、不过滤（空串 = 该题未答）
      const answers = (msg.answers ?? []).map((a) => a.trim());
      if (answers.length === 0 || answers.every((a) => a === '')) return;
      // 错位（迟到回答）→ 丢弃并留痕
      if (!deps.isWaiting(sessionId, 'ask')) {
        const state = deps.turnState(sessionId);
        console.warn(
          '错位回答已丢弃',
          state.phase,
          'reason' in state ? state.reason : '—',
          answers.length,
        );
        return;
      }
      // 题数不等 ⇒ 两侧对批次认知已分叉，按位回填必错位：拒收留痕，不写坏盘面
      const count = deps.askFor(sessionId).checkAnswerCount(answers);
      if (!count.ok) {
        console.warn(
          `Memora: answer count does not match question count (${count.got} != ${count.expected}); rejected`,
        );
        deps.postToSession(sessionId, {
          type: 'notice',
          level: 'error',
          message: vscode.l10n.t(
            'The answers do not match the current questions ({0} answers / {1} questions); please answer again',
            count.got,
            count.expected,
          ),
        });
        return;
      }
      await deps.answer(answers, sessionId);
      return;
    }
    case 'resume':
      // 错位（非暂停态收到继续）→ 丢弃并留痕（兜跨消息竞态残留）
      if (!deps.isWaiting(sessionId, 'pause')) {
        const state = deps.turnState(sessionId);
        console.warn(
          `Memora：错位续跑已丢弃（当前相位=${state.phase}/${
            'reason' in state ? state.reason : '—'
          }）`,
        );
        return;
      }
      await deps.resume(sessionId);
      return;
    case 'regenerate': {
      // 结构写操作只属侧栏当前会话（助手窗不暴露 regenerate）：目标不符即丢弃
      if (sessionId !== current) return;
      const anchor = msg.roundId?.trim() ?? '';
      if (!anchor) return;
      const outcome = await deps.truncateTurn(
        anchor,
        vscode.l10n.t(
          'Regenerating deletes this turn and all later turns, then resends the original text. This cannot be undone.',
        ),
        vscode.l10n.t('Regenerate'),
      );
      if (!outcome.ok) {
        // busy 已在核内提示、cancel 是用户主动 → 均静默；miss / error 必须可见否则等于失灵
        if (outcome.reason === 'miss' || outcome.reason === 'error') {
          deps.postCurrent({ type: 'notice', level: 'info', message: truncateFailNotice() });
        }
        return;
      }
      const text = outcome.userText?.trim() ?? '';
      if (!text) {
        // 锚点轮无 user 原文（异常态）→ 如实提示，不静默吞
        deps.postCurrent({
          type: 'notice',
          level: 'info',
          message: vscode.l10n.t(
            'Could not retrieve the original prompt text; nothing was regenerated',
          ),
        });
        return;
      }
      await deps.sendInput(sessionId, text, undefined, undefined, undefined, undefined);
      return;
    }
  }
}
