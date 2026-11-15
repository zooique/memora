/**
 * 历史会话的上下文占用投影（面板只留一行转调）
 *
 * 切到历史会话（含首次启动回放）时把圆环从「空态 0%」纠正为该会话真实占用：
 * - 对话层   = 持久化消息经内核 `estimateTokensMessages` 求和（与运行时 prepare 同口径）
 * - 角色包   = 内核当前激活角色包底盘占用（装配 / 切换即确定，冷启动也有真实值）
 * - 输入锚点 = 0（历史会话无当前输入）
 * 组装复用内核 `estimateOccupancy`（SSOT 单点，free 收敛口径与运行时 prepare 一致）。
 *
 * 为什么外置：`chatPanel.ts` 贴 eslint max-lines 基线（只降不升），而本域是**纯投影**——
 * 只读 Provider / 历史，只往 webview 投一条消息，不持有任何会话导航、清空或写盘入口。
 * 搬出来不会让「会话切换唯一写点 / finalizer 清空 / 写点守卫判据」多出第二处。
 */
import {
  estimateOccupancy,
  estimateTokensMessages,
  resolveContextWindow,
  type Agent,
} from '@zooique/memora';
import type { RoundView } from '../../shared/protocol.js';
import { collectOccupancyHistory } from './occupancyHistory.js';

/** Agent 的上下文档位指标（本模块只读消费；口径仍归内核，不在此另写一份） */
type AgentContextMetrics = ReturnType<Agent['getMetrics']>['context'];

/** 占用投影的注入面（全部窄闭包：面板侧只接线，不把整只面板递进来） */
export interface OccupancyPostDeps {
  /** 当前 Agent 的 context 指标（未装配 = undefined ⇒ 直接跳过，圆环保持空态） */
  agentContext: () => AgentContextMetrics | undefined;
  /** 当前 Provider 列表（用于取选中那条的窗口上限） */
  listProviders: () => Promise<readonly { name: string; contextWindow?: number }[]>;
  /** 当前选中的 Provider 名（未选中 = undefined，窗口按默认档回落） */
  activeProviderName: () => string | undefined;
  /** 是否注入 round-based viewLoader（决定历史取数走哪条路径） */
  hasViewLoader: boolean;
  /** round-based 历史（按时间顺序排列的轮次） */
  loadRounds: () => readonly RoundView[];
  /** legacy 扁平历史（本模块只消费 role / content） */
  loadLegacy: () => readonly { role: 'user' | 'assistant'; content: string }[];
  /** 投递一条投影消息（面板的 post 单点） */
  post: (msg: {
    type: 'context_occupancy';
    occupancy: ReturnType<typeof estimateOccupancy>;
  }) => void;
}

/**
 * 推送历史会话上下文占用（轻量版）
 *
 * 异步仅用于读取当前 Provider 窗口（`listMasked`）；读取失败静默——圆环维持
 * `chat_providers` 空态，不阻塞会话切换（非关键路径）。
 *
 * @param deps 面板提供的窄闭包
 */
export async function pushHistoryOccupancy(deps: OccupancyPostDeps): Promise<void> {
  try {
    const ctx = deps.agentContext();
    if (!ctx) return;
    // 窗口容量：当前选中 LLM 的上下文上限（SSOT：与 Provider 列表同源 resolveContextWindow）
    const providers = await deps.listProviders();
    const activeName = deps.activeProviderName();
    const active = providers.find((p) => p.name === activeName);
    const totalTokens = resolveContextWindow(active?.contextWindow);
    // 对话消息序列：round-based（viewLoader）或 legacy 扁平路径统一提取
    const history = collectOccupancyHistory(deps.hasViewLoader, deps.loadRounds, deps.loadLegacy);
    const dialogueTokens = estimateTokensMessages(history);
    // 角色包固定开销：优先取内核当前激活角色包底盘占用（装配/切换即确定，冷启动也有真实值）；
    // 该指标暂无时回退 occupancy 旧值（兼容极端时序），再回退 0。
    const rolePackBaseTokens = ctx.rolePackBaseTokens ?? ctx.occupancy?.rolePackBaseTokens ?? 0;
    const occ = estimateOccupancy({
      totalTokens,
      rolePackBaseTokens,
      // 历史会话重算无动态 system 注入（持久化历史只含 user+assistant）→ 显式 0
      dynamicSystemTokens: 0,
      dialogueTokens,
      // 计数标准：以用户输入条数计（一个问答闭环=1，残缺回答如实记录），与内核 dialogueCount 口径一致（SSOT）
      dialogueCount: history.filter((m) => m.role === 'user').length,
      inputAnchorTokens: 0,
    });
    deps.post({ type: 'context_occupancy', occupancy: occ });
  } catch {
    // 读取 Provider 失败不阻塞会话切换（圆环维持空态，非关键路径）
  }
}
