/**
 * 角色包 → webview 的能力/队伍投影（CHATPANEL-EXTRACT-1 外置）
 *
 * 从 `chatPanel` 搬来的两段纯投影：能力徽章 payload 与协议用 team 快照。
 * 外置判据三条全满足：① 无状态（无模块级可变字段）；② 无副作用（不 post / 不写盘）；
 * ③ 只读写参数（agent 是全部输入，面板负责投递与注入当前会话）。
 *
 * SSOT 提醒：三态判定仍走 `capabilityState.deriveCapabilityState`，本文件只做
 * 「内核角色包 → 协议 DTO」的字段投影，不重算 capabilities.length。
 *
 * @module roleCapabilityProjection
 */
import type { Agent } from '@zooique/memora';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { deriveCapabilityState } from './capabilityState.js';
import { capabilityDomainLabel } from './capabilityLabels.js';

type CapabilityBadgeMessage = Extract<ExtensionToWebviewMessage, { type: 'capability_badge' }>;

/**
 * 投影能力徽章消息体；无激活角色包返回 undefined（面板据此跳过投递）。
 * 三态判定走 host 唯一出口，策略提示只做域级短标签投影。
 */
export function capabilityBadgePayload(
  agent: Agent | undefined,
): CapabilityBadgeMessage | undefined {
  if (!agent) return undefined;
  const active = agent.rolePackManager?.getActive();
  if (!active) return undefined;
  const toolMode = active.strategy.act?.toolMode ?? 'allow';
  // 不在此重算 length：显示层再判一次就会与内核语义漂移（CAP-TRISTATE-1 真机缺陷的成因）
  const capabilityState = deriveCapabilityState(active.capabilities, capabilityDomainLabel);

  const strategy = active.strategy;
  const temp = strategy.act?.temperature ?? 0.7;
  const tempGroup = temp >= 0.8 ? 'high' : temp <= 0.4 ? 'low' : 'mid';
  const reasoningMode = strategy.act?.multiStepReasoning;

  return {
    type: 'capability_badge',
    toolMode,
    capabilityState,
    strategyHint: {
      toolReadonly: strategy.act?.toolReadonly,
      tempGroup: tempGroup as 'high' | 'mid' | 'low',
      reasoningMode: reasoningMode as 'auto' | 'manual' | undefined,
      summaryFocus: strategy.prepare?.summaryFocus,
      outputLimit: strategy.act?.outputLimit,
    },
  };
}

/**
 * 协议消息 `chat_role_pack` 携带的 team 快照（组长 + 组员）。
 * SSOT：只读内核 rolePackManager.getActiveTeam()，不绕内核碰 globalState；
 * spread 只读数组为可变引用（协议 team.members 声明 readonly，post 透传不修改）。
 */
export function activeTeamForProtocol(
  agent: Agent | undefined,
): { leader: string; members: string[] } | undefined {
  const team = agent?.rolePackManager?.getActiveTeam();
  if (!team || team.members.length === 0) return undefined;
  return { leader: team.leader, members: [...team.members] };
}
