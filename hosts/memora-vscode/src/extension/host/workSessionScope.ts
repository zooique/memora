/**
 * 开活范围核对（`create_session` 判据 4 的读侧）
 *
 * 为什么外置：范围扫描 + 回执文案是完整闭环，而 `workSessionTools.ts` 已贴
 * `max-lines` 上限；把同域逻辑整体搬出来，工具文件只留「调用 + 拼回执」，
 * 不为过闸去压缩既有注释。
 *
 * 边界（与工具文件同口径）：
 *   - 声明真源 = 会话元数据（`SessionMeta.declaredPaths`），不从历史反推；
 *   - 调用方自己不是被派发的活：冲突判定与计数共用 `occupiesScopeFor` 排除它；
 *   - 没有声明的活按状态分三档计数（在跑 / 在等、已派发未开跑、状态读不到），
 *     只有前两类算「在跑的活」，三类不混成一个数；
 *   - 回执只报可验证事实，不归因「为什么没有声明」，也不把整仓包装成安全建议。
 */
import type { WorkbenchJobStatus } from '../../shared/workbenchDto.js';
import { normalizeScopePaths } from './sessionScope.js';

/**
 * 本次范围核对「核清了多少」（成功的派发回执里必带）
 *
 * ⚠️ 这不是错误码，也**不是**「撞上了」：`coverage !== 'complete'` 表示有活
 * **没有范围声明**（或读不到会话元数据 / 状态），那些活无法判重叠。
 * 这里只报可验证的计数事实，不归因「为什么没有声明」。
 * `note` 是给模型看的一句话，随回执一起返回——**不能只写日志**。
 */
export interface ScopeCheck {
  /** `complete` = 所有在跑的活都有声明可核；其余都是「核不清」 */
  coverage: 'complete' | 'partial' | 'unreadable';
  /** 在跑 / 在等、但没有范围声明的会话数（真正会占写面的活；>0 即 partial） */
  unscopedRunning: number;
  /** 已派发、还没开始跑、也没有范围声明的会话数（单列，不混进「在跑的活」） */
  unscopedQueued: number;
  /** 状态读不到、也没有范围声明的会话数（无法确认是否占写面，不冒充在跑） */
  unscopedUnknown: number;
  /** 核不清时给模型看的一句话；`coverage === 'complete'` 时省略 */
  note?: string;
}

/** 声明范围扫描的读口（由注册函数把 `WorkSessionToolDeps` 的同名回调搬进来） */
export interface ScopeScanInputs {
  /** 本次工具调用方（不占写面、不进计数） */
  callingSessionId?: string;
  /** 工作区根绝对路径（把声明里的绝对路径截成相对；只用于比较） */
  workspaceRoot?: string;
  /** 全部会话的声明范围读口（真源 = 会话元数据；缺省 = 无法核对） */
  readDeclaredScopes?: () => readonly {
    sid: string;
    title?: string;
    paths?: readonly string[];
  }[];
  /** 单会话状态读口（缺省 = 一律按读不到处理，不猜空闲） */
  readStatus?: (sessionId: string) => WorkbenchJobStatus;
  /** 调用方历史重建（只用于认领「范围上线前开的老会话」） */
  readHistory?: (orchestratorId: string) => ScopeHistoryFacts;
}

/**
 * 历史重建的最小消费形状（`SessionHistoryFacts` 结构上直接满足）
 *
 * 只取扫描需要的两件事；不 import 工具文件，避免循环依赖。
 */
export interface ScopeHistoryFacts {
  /** 历史读取覆盖状态（`partial` / `unreadable` 时「没找到」不等于「不是它开的」） */
  coverage: 'complete' | 'partial' | 'unreadable';
  /** 历史里的 `create_session` 记录（sid + 创建时标题） */
  children: readonly { sessionId: string; title?: string }[];
}

/**
 * 一次范围扫描的结果（声明来自会话元数据 + 老会话计数）
 *
 * `scopes` 只含**读得到声明**且在跑的活；没有声明的活按状态分三档计数
 * （在跑 / 在等、已派发未开跑、状态读不到），不猜范围、也不把三类混成一个数。
 */
export interface ActiveScopeScan {
  /** 参与重叠比对的活（声明已规范化） */
  scopes: {
    sid: string;
    title?: string;
    paths: readonly string[];
    status: WorkbenchJobStatus;
  }[];
  /** 是否有可用的元数据读口（没有 = unreadable，无法核对任何声明） */
  readable: boolean;
  /** 历史读口是否可用（用来认领「范围上线前开的老会话」；读不到就无法确认有没有此类活在跑） */
  historyReadable: boolean;
  /** 在跑 / 在等但声明读不到的活数量 */
  unscopedRunning: number;
  /** 已派发、还没开始跑但声明读不到的活数量（单列） */
  unscopedQueued: number;
  /** 状态读不到、声明也读不到的活数量 */
  unscopedUnknown: number;
}

/**
 * 这条活是否「占着声明的写面」（判据 4 的重叠对象）
 *
 * - 占着：running（正在跑）/ waiting（等用户拍板，随时继续）/ queued（已派发、还没开始跑）
 *   / unreadable（读不到——**不得**当成空闲，否则会在可能正写的时候放行第二条活）；
 * - 不占：completed / stopped（已收场）/ unsettled（崩溃未打捞：进程已死，不会再写）。
 *
 * @param kind 状态投影的判别式
 */
function occupiesScope(kind: WorkbenchJobStatus['kind']): boolean {
  return kind === 'running' || kind === 'waiting' || kind === 'queued' || kind === 'unreadable';
}

/**
 * 这条会话是否算「占着写面」的判定对象（冲突判定与计数共用的唯一判据）
 *
 * 两处必须同判据，缺一就会出现「冲突判定已排除调用方、计数却把它算进来」的假回执：
 * 调用方执行工具时通常正在跑且没有范围声明，把它算进来会让每次开活都报「核不清」。
 *
 * @param sid 被检查的会话
 * @param callingSessionId 本次工具调用方（自己不是被派发的活，不占写面）
 * @param status 该会话的状态投影
 * @returns true = 该会话占着写面，需要参与冲突判定与计数
 */
export function occupiesScopeFor(
  sid: string,
  callingSessionId: string | undefined,
  status: WorkbenchJobStatus,
): boolean {
  if (callingSessionId !== undefined && sid === callingSessionId) return false;
  return occupiesScope(status.kind);
}

/**
 * 扫描当前占写面的活 + 这次到底核清了多少
 *
 * 声明随会话创建写进元数据 ⇒ 重启不用反推、不受 60 轮窗口影响。
 * 调用方自己不是被派发的活：冲突判定与计数共用 `occupiesScopeFor` 排除它，
 * 否则「主控自己正在跑且没有声明」会被算成一条核不清的活。
 * 历史重建在这里只用来认领「哪些会话是主控开的」，不用来读声明。
 *
 * @param inputs 读口集合（缺项按「读不到」降级，不冒充空闲）
 * @returns 扫描结果（供冲突比对与回执文案共用）
 */
export function collectActiveScopes(inputs: ScopeScanInputs): ActiveScopeScan {
  const scopes: ActiveScopeScan['scopes'] = [];
  /** 已核对过状态的会话（老会话计数去重） */
  const seen = new Set<string>();
  let unscopedRunning = 0;
  let unscopedQueued = 0;
  let unscopedUnknown = 0;
  const readable = typeof inputs.readDeclaredScopes === 'function';
  /** 没有声明的活按状态分档计数（只有真正在跑 / 在等的进「在跑的活」） */
  const countUnscoped = (status: WorkbenchJobStatus): void => {
    if (status.kind === 'running' || status.kind === 'waiting') unscopedRunning += 1;
    else if (status.kind === 'queued') unscopedQueued += 1;
    else if (status.kind === 'unreadable') unscopedUnknown += 1;
  };
  for (const entry of inputs.readDeclaredScopes?.() ?? []) {
    seen.add(entry.sid);
    // 状态读不到按「占着」处理（读不到 ≠ 空闲）
    const status = inputs.readStatus?.(entry.sid) ?? { kind: 'unreadable' as const };
    // 与冲突判定共用同一判据：调用方不占写面，也不进任何计数
    if (!occupiesScopeFor(entry.sid, inputs.callingSessionId, status)) continue;
    if (!entry.paths || entry.paths.length === 0) {
      countUnscoped(status);
      continue;
    }
    scopes.push({
      sid: entry.sid,
      ...(entry.title ? { title: entry.title } : {}),
      // 元数据里存的已是规范化值；再归一一遍是幂等的，防旧数据 / 手改漏网
      paths: normalizeScopePaths(entry.paths, inputs.workspaceRoot),
      status,
    });
  }
  // 老会话认领：历史里主控开过、但元数据没有声明的在跑活（只计数，不猜范围）
  const history = inputs.callingSessionId
    ? inputs.readHistory?.(inputs.callingSessionId)
    : undefined;
  const historyReadable = !!history && history.coverage !== 'unreadable';
  for (const child of history?.children ?? []) {
    if (seen.has(child.sessionId)) continue;
    const status = inputs.readStatus?.(child.sessionId) ?? { kind: 'unreadable' as const };
    // 同一判据：历史里也可能出现调用方自己（例如它开过子会话），不能算成未声明活
    if (!occupiesScopeFor(child.sessionId, inputs.callingSessionId, status)) continue;
    countUnscoped(status);
  }
  return {
    scopes,
    readable,
    historyReadable,
    unscopedRunning,
    unscopedQueued,
    unscopedUnknown,
  };
}

/**
 * 把扫描事实转成回执里的 `scopeCheck`（给模型看，不只是给日志看）
 *
 * 「核不清」与「撞上了」是两件事：这里只描述前者，不伪造后者，也不在核不清时假装
 * 「没有冲突」。**不把「声明整仓」包装成安全建议**：整仓 = 自愿独占，会挡住其它活，
 * 该不该用由代理按任务实际范围自己定。
 *
 * @param scan 本次范围扫描结果
 * @returns 回执字段（`note` 在核不清时必有）
 */
export function buildScopeCheck(scan: ActiveScopeScan): ScopeCheck {
  if (!scan.readable) {
    return {
      coverage: 'unreadable',
      unscopedRunning: scan.unscopedRunning,
      unscopedQueued: scan.unscopedQueued,
      unscopedUnknown: scan.unscopedUnknown,
      note:
        '读不到会话元数据，本次无法核到在跑活的声明范围。这不是「撞上了」，是「核不清」；' +
        '按这条活实际要动的范围声明即可（整仓 = 自愿独占，会挡住其它活）。',
    };
  }
  if (scan.unscopedRunning > 0 || scan.unscopedQueued > 0) {
    /** 分档事实句：只写在跑 / 已派发，不合并成一个数 */
    const parts: string[] = [];
    if (scan.unscopedRunning > 0) {
      parts.push(`有 ${scan.unscopedRunning} 条会话没有范围声明，无法判重叠。`);
    }
    if (scan.unscopedQueued > 0) {
      parts.push(
        `另有 ${scan.unscopedQueued} 条已派发、还没开始跑的会话没有范围声明，也无法判重叠。`,
      );
    }
    if (scan.unscopedUnknown > 0) {
      parts.push(`还有 ${scan.unscopedUnknown} 条会话的状态读不到，无法确认它们是否占着范围。`);
    }
    return {
      coverage: 'partial',
      unscopedRunning: scan.unscopedRunning,
      unscopedQueued: scan.unscopedQueued,
      unscopedUnknown: scan.unscopedUnknown,
      note:
        parts.join('') +
        '这不是「撞上了」，是「核不清」；按这条活实际要动的范围声明即可' +
        '（整仓 = 自愿独占，会挡住其它活，不是更安全的做法）。',
    };
  }
  if (scan.unscopedUnknown > 0) {
    return {
      coverage: 'unreadable',
      unscopedRunning: 0,
      unscopedQueued: 0,
      unscopedUnknown: scan.unscopedUnknown,
      note:
        `有 ${scan.unscopedUnknown} 条会话的状态读不到，无法确认它们是否占着范围。` +
        '这不是「撞上了」，是「核不清」；按这条活实际要动的范围声明即可' +
        '（整仓 = 自愿独占，会挡住其它活）。',
    };
  }
  if (!scan.historyReadable) {
    return {
      coverage: 'unreadable',
      unscopedRunning: 0,
      unscopedQueued: 0,
      unscopedUnknown: 0,
      note:
        '历史读不到，无法确认有没有老活在跑。这不是「撞上了」，是「核不清」；' +
        '按这条活实际要动的范围声明即可（整仓 = 自愿独占，会挡住其它活）。',
    };
  }
  return {
    coverage: 'complete',
    unscopedRunning: 0,
    unscopedQueued: 0,
    unscopedUnknown: 0,
  };
}
