/**
 * hostedStatusView — 助手座位顶部运行状态签（托管会话微信化，2026-11-16 用户拍板）
 *
 * 职责：把「助手此刻在干什么」压成一句话写到顶部身份条——微信「正在输入…」的对应物
 * （正在推进 / 正在思考 / 等你回答 / 已暂停）。运行**过程**明细不进这条链路：工具折叠行、
 * 相位行、叙述行由消息流 CSS 收起，顶部只留一句概括，避免把「过程」从消息区换个地方漏出来。
 *
 * 判据不另造：相位/等待来自 `SkeletonState`（真源 = turn_update.state），工具在途复用
 * `findRunningTool`（与消息流相位行同一判据，避免顶部说「推进」而过程说「思考」的双真相源）。
 * 零自有状态：只读注入的取数闭包，DOM 写入幂等（同一句不重写，流式高频事件不抖）。
 *
 * @module hostedStatusView
 */
import * as l10n from '@vscode/l10n';
import type { ProcessEvent } from '@zooique/memora';
import type { UiForm } from '../../shared/protocol.js';
import { findRunningTool } from '../helpers/processFlowModel.js';
import type { SkeletonState } from '../helpers/turnUiState.js';

/** 状态档 → 英文源键（l10n 键面；模块加载早于 l10n 初始化，故值不可预解析） */
// @nls-keys
const STATUS_LABEL: Record<HostedStatusKind, string> = {
  advancing: 'Advancing…',
  thinking: 'Thinking…',
  awaiting: 'Awaiting your answer',
  paused: 'Paused',
};

/** 顶部状态四档（无会话在跑 = null，节点清空不占位） */
export type HostedStatusKind = 'advancing' | 'thinking' | 'awaiting' | 'paused';

/**
 * 骨架状态 + 本轮过程事件 → 顶部状态档（纯函数）
 *
 * - 等待提问：`awaiting`；等待暂停：`paused`（助手座位暂停入口已删，这是兜底不是常用路径）；
 * - 运行中有未配对工具：`advancing`（与过程相位行同判据）；
 * - 运行中有非归档思考相位：`thinking`；
 * - 其余运行中（首 token 前无事件 / 只有归档相位）：`advancing`——「正在推进」是微信式默认
 *   措辞，不用「思考中」冒充无证据的内部活动；
 * - 空闲 / 已收场：null。
 */
export function deriveHostedStatus(
  state: SkeletonState,
  events: readonly ProcessEvent[],
): HostedStatusKind | null {
  if (state.phase === 'waiting') {
    return state.reason === 'pause' ? 'paused' : 'awaiting';
  }
  if (state.phase !== 'running') return null;
  if (findRunningTool([...events])) return 'advancing';
  const thinking = [...events].reverse().find((e) => e.type === 'thinking');
  if (thinking && thinking.type === 'thinking' && thinking.payload.phase !== 'archiving') {
    return 'thinking';
  }
  return 'advancing';
}

/** 视图依赖（全部由调用方注入，本模块不持有存储、不查全局 DOM） */
export interface HostedStatusViewDeps {
  /** 状态签节点（生产骨架里的 #assistantState） */
  node: HTMLElement;
  /** 形态真源读数：自助形态不显示托管状态 */
  getForm: () => UiForm;
  /** 骨架状态真源 */
  getState: () => SkeletonState;
  /** 本轮过程事件真源 */
  getEvents: () => readonly ProcessEvent[];
}

export interface HostedStatusView {
  /** 重算并施加（幂等：同文案不重写 DOM） */
  refresh(): void;
}

export function createHostedStatusView(deps: HostedStatusViewDeps): HostedStatusView {
  let lastText = '';

  function refresh(): void {
    const kind =
      deps.getForm() === 'assistant' ? deriveHostedStatus(deps.getState(), deps.getEvents()) : null;
    const text = kind === null ? '' : l10n.t(STATUS_LABEL[kind]);
    if (text === lastText) return;
    lastText = text;
    deps.node.textContent = text;
    deps.node.hidden = text === '';
  }

  return { refresh };
}
