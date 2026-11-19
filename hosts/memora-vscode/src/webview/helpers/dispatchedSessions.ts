/**
 * 盖章会话列表（独立会话卡区的数据源，DISPATCH-CARD-ZONE-1）
 *
 * 心智：会话卡是第三种信息形态——只要「被助手会话盖章启动过 turn」就上屏，
 * 跟它是被哪句话触发的无关。故本列表的判据只有一条：`Round.dispatchedBy.from === 助手会话`。
 *
 * 与工作台清单的区别（不可混用）：
 *   - 工作台 `buildWorkbenchSnapshot` 会按 `isAgentDriven` 过滤「用户已接管」的会话；
 *   - 本列表**不过滤驱动权**——盖章是既成事实，用户接管后卡片仍在（用户心智：跑完卡还在）。
 *
 * 数据来源（两边覆盖不同批次，必须并集，谁也不是谁的超集）：
 *   - 本进程账本 `childrenOf`：实时，派发/新建受理当场登记 ⇒ 解决「实时不出卡」；
 *   - 轮次反查 `rebuildWorkbenchChildren`：重启后账本为空，靠落盘 `dispatchedBy` / 工具事件补齐。
 * 名字逐条走宿主 `titleFor`（真源 sessionTitleFor）——不依赖 session_activity 的遍历面，
 * 后台会话未装配 / 已收场也能取到真名（解决「卡片显示 sid 而非会话名」）。
 */
import type { Round } from '@zooique/memora';
import { rebuildWorkbenchChildren } from './workbenchHistory.js';

/** 协议载荷里的单条盖章会话（形状与 protocol.ts session_activity.dispatchedSessions 同构） */
export interface DispatchedSession {
  sid: string;
  title: string;
  via: 'delegate' | 'create';
}

/** 计算盖章列表所需的读口（全部由 chatPanel 以闭包注入，本模块不持存储） */
export interface DispatchedSessionsSources {
  /** 助手会话 id（盖章归属锚点） */
  orchestratorId: string;
  /** 本进程创建者账本（实时） */
  childrenOf: (orchestratorId: string) => string[];
  /** 会话的轮 id 列表（反查用） */
  readRoundIds: (sessionId: string) => readonly string[];
  /** 按轮 id 读整轮（create 工具事件与 dispatchedBy 都从它取；读不到返回 undefined） */
  readRound: (roundId: string) => Round | undefined;
  /** 全部会话 id（反查候选面） */
  listSessionIds: () => readonly string[];
  /** 会话展示名真源（注入 sessionTitleFor） */
  titleFor: (sessionId: string) => string;
}

/**
 * 汇总盖章会话列表（sid 去重，会话维度一张卡；不过滤驱动权）
 *
 * 优先级：轮次反查带准确 via，作基底；本进程账本补其未覆盖项（via 缺省按 delegate，
 * 仅用于标签，不影响「显示与否」）。名字一律现场取真源，改名随下次快照刷新。
 */
export function collectDispatchedSessions(sources: DispatchedSessionsSources): DispatchedSession[] {
  const history = rebuildWorkbenchChildren(sources.orchestratorId, {
    readRoundIds: sources.readRoundIds,
    readRound: sources.readRound,
    listSessionIds: sources.listSessionIds,
    // 索引级派发读口缺席时回退整轮读本轮的分布（面板的 IRoundStore 无 getDispatch）
    readRoundDispatch: (roundId) => sources.readRound(roundId)?.dispatchedBy,
  });

  // 基底：轮次反查（create/delegate 分档准确）
  const bySid = new Map<string, DispatchedSession>();
  for (const child of history.children) {
    bySid.set(child.sessionId, {
      sid: child.sessionId,
      title: sources.titleFor(child.sessionId),
      via: child.via,
    });
  }
  // 补本进程账本：实时登记的会话（反查尚未覆盖 —— 首轮未落盘 / 反查窗口外）
  for (const sid of sources.childrenOf(sources.orchestratorId)) {
    if (bySid.has(sid)) continue;
    bySid.set(sid, { sid, title: sources.titleFor(sid), via: 'delegate' });
  }
  return [...bySid.values()];
}
