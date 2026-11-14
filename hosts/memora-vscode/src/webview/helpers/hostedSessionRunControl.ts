/**
 * 主控暂停 / 恢复会话（工具 `pause_work_session` / `resume_work_session` 的实现域）
 *
 * 为什么外置：与 `hostedSessionStop.ts` 同因——面板已贴 `max-lines` 基线，这段
 * 「门禁 → 按 sid 取既有实例 → 调实例现有公开方法 → 结果信封」是完整闭环，
 * 留在面板只会挤掉既有注释。
 *
 * 事实边界（与停止完全一致）：
 *   - **内核一行不动**：暂停调目标实例已有的 `requestPause(reason, source)`，
 *     恢复调目标实例已有的 `resumeExecution(input?, signal?, kind?)`，不给内核加目标形参；
 *   - 只判「本窗口有没有这个目标的活实例 / 状态读不读得到」：
 *     没有实例 ⇒ `E_UNREADABLE`，**不为了暂停去装配新实例**（那会凭空造出运行态）；
 *   - 目标态只在读到实例状态后才动作：已暂停 / 申请在途 ⇒ 幂等回 `already`，
 *     读不到状态 ⇒ 拒绝，**绝不猜着暂停或恢复**；
 *   - 恢复只启动续跑、不等待流结束（与 `dispatchHostedInput` 的 `void runFlow` 同口径），
 *     流结果由目标会话自己的收场事件 / 历史承载。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import type {
  HostedPauseResult,
  HostedResumeResult,
} from '../../extension/host/workSessionTools.js';

// 本模块错误文案走 l10n（与面板同一套键面）
const { l10n } = vscode;

/** 暂停 / 恢复共用的读口（全部由面板注入，本模块不持有任何实例） */
export interface HostedRunControlBaseDeps {
  /** 调用方是否托管（纵深防守：不只靠工具面缺席） */
  isManaged: (sessionId: string) => boolean;
  /** 取**目标会话**的既有实例；undefined = 本窗口没有活实例（状态读不到） */
  getAgent: (sessionId: string) => Agent | undefined;
  /** 目标会话是否有未回答的提问（有 ⇒ 处于「等用户回答」的暂停，代理不得代答后恢复） */
  hasPendingQuestion: (sessionId: string) => boolean;
  /** 当前**显示会话**（界面副作用只对显示会话发生） */
  currentSessionId: () => string;
  /** 推送 turn_update（仅显示会话；暂停申请在途变化必须同步补推） */
  postTurnUpdate: () => void;
}

/** 恢复额外需要的动作口（暂停不需要，避免为「暂时用不上的能力」扩参数） */
export interface HostedSessionRunControlDeps extends HostedRunControlBaseDeps {
  /** 让目标会话续跑（面板注入既有 `runFlow` 通路；不等待流结束） */
  runResume: (sessionId: string, agent: Agent) => void;
}

/**
 * 暂停目标会话（软暂停：当前步骤边界生效，历史保留）
 *
 * @param deps 面板注入的读口 / 动作口
 * @param callingSessionId 调用方（非托管 = E_DENIED）
 * @param targetSessionId 目标会话
 * @returns 结果信封（`paused:false` = 目标已收场 / 无活可暂停，不是错误）
 */
export async function pauseHostedSession(
  deps: HostedRunControlBaseDeps,
  callingSessionId: string,
  targetSessionId: string,
): Promise<HostedPauseResult> {
  if (!deps.isManaged(callingSessionId)) {
    return {
      ok: false,
      code: 'E_DENIED',
      message: l10n.t('Memora: only managed sessions can pause other sessions.'),
    };
  }
  try {
    // 按目标 sid 取既有实例：没有实例就没有可读的目标态，不猜、不新建
    const agent = deps.getAgent(targetSessionId);
    if (!agent || !agent.sessionManager) {
      return {
        ok: false,
        code: 'E_UNREADABLE',
        message: l10n.t('Memora: the target session has no live instance to pause.'),
      };
    }
    // 已暂停 / 申请在途：幂等回 already，不重复提交（避免二次请求被内核拒后误报失败）
    if (agent.sessionManager.status === 'paused' || agent.isPausePending()) {
      return { ok: true, paused: true, already: true };
    }
    // 调实例已有的无参公开方法：`requestPause` 内部做空闲守卫 / 幂等 / 状态机拦截
    const paused = agent.requestPause('hosted-pause', 'agent');
    if (paused && targetSessionId === deps.currentSessionId()) {
      // 申请在途：补推 turn_update，按钮切「继续 ▶」（后台会话不投递，避免串台）
      deps.postTurnUpdate();
    }
    return { ok: true, paused, already: false };
  } catch (err) {
    // 业务契约：不 throw（与停止 / 派发一致，工具层要能读到可判读的结果）
    return {
      ok: false,
      code: 'E_HOST',
      message: err instanceof Error ? err.message : l10n.t('Memora: failed to pause the session.'),
    };
  }
}

/**
 * 恢复目标会话（复用宿主既有续跑通路）
 *
 * @param deps 面板注入的读口 / 动作口
 * @param callingSessionId 调用方（非托管 = E_DENIED）
 * @param targetSessionId 目标会话
 * @returns 结果信封（`resumed:false` = 目标不在暂停态，没有可恢复的活）
 */
export async function resumeHostedSession(
  deps: HostedSessionRunControlDeps,
  callingSessionId: string,
  targetSessionId: string,
): Promise<HostedResumeResult> {
  if (!deps.isManaged(callingSessionId)) {
    return {
      ok: false,
      code: 'E_DENIED',
      message: l10n.t('Memora: only managed sessions can resume other sessions.'),
    };
  }
  try {
    // 按目标 sid 取既有实例：没有实例就没有可续跑的运行态
    const agent = deps.getAgent(targetSessionId);
    if (!agent || !agent.sessionManager) {
      return {
        ok: false,
        code: 'E_UNREADABLE',
        message: l10n.t('Memora: the target session has no live instance to resume.'),
      };
    }
    // 只有 paused 才有可恢复的活；其余状态如实回 false，不做「可能该恢复」的猜测
    if (agent.sessionManager.status !== 'paused') {
      return { ok: true, resumed: false };
    }
    // 等用户回答的暂停不是「代理暂停」：恢复会把用户的提问吞掉，代理不得代答
    // （代答提问卡是明确不在本批范围的能力）
    if (deps.hasPendingQuestion(targetSessionId)) {
      return { ok: true, resumed: false };
    }
    if (targetSessionId === deps.currentSessionId()) {
      // 显示会话：先补推骨架，续跑事件随后到达（后台会话不投递）
      deps.postTurnUpdate();
    }
    // 走既有 runFlow（内含 BackgroundFlowGate 归属）：不等待流结束，只回「已启动」
    deps.runResume(targetSessionId, agent);
    return { ok: true, resumed: true };
  } catch (err) {
    return {
      ok: false,
      code: 'E_HOST',
      message: err instanceof Error ? err.message : l10n.t('Memora: failed to resume the session.'),
    };
  }
}
