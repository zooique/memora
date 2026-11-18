/**
 * 会话状态投影（纯函数 · 工作台与主控工具共用同一份判断）
 *
 * 职责：把既有事实投影成一条会话的状态视图——
 *   ① 运行态（在跑 / 等你）= 面板运行态表 + ask/confirm + 实例暂停态（调用方注入闭包）；
 *   ② 终态（完成 / 被中止 / 未收场）= 最后一轮的 `RoundStatus`；
 *   ③ 被中止的原因 = `deriveInterruptReason` 读该轮已落地的 `processEvents`；
 *   ④ 状态读不到 = `unreadable`（**不**冒充「没在跑」）。
 *
 * 为什么外置到 `shared/`：工作台（webview 宿主面）与 `list_work_sessions`（主控工具）
 * 必须对「这条活在跑还是能复用」给出**同一个答案**。判断只此一处，两边都调；
 * 各写一份必然漂移（工具说空闲、工作台说在跑，代理就会重复派活）。
 *
 * 边界：
 *   - 只读投影：不写 meta、不建索引、不缓存、不落盘；
 *   - 只出枚举：不造展示文案（文案归 webview 的 l10n）；
 *   - 不补默认值：读不到如实 `unreadable`，没有停止原因如实 `unavailable`。
 */
import type { Round, RoundStatus, SessionMeta } from '@zooique/memora';
import { isRoundSettled, isRoundSuccessful } from '@zooique/memora';
import { deriveInterruptReason, type InterruptReason } from './interruptReason.js';
import type {
  ListCoverageReason,
  WorkbenchCoverage,
  WorkbenchJobStatus,
  WorkbenchStopReason,
} from './workbenchDto.js';

/** 单会话运行态（只回答「在跑吗 / 在等人吗」） */
export interface SessionActivity {
  /** 正在流式生成 */
  running: boolean;
  /** 在等用户（待答提问 / 待确认 / 已软暂停） */
  waiting: boolean;
}

/**
 * 状态投影的读口（全部为「读既有事实」的回调）
 *
 * `WorkbenchSnapshotInputs` 结构上满足本接口，故工作台可直接把整份读口传进来；
 * 主控工具则由宿主装配层注入同一批闭包。测试给替身即可，无需构造 Agent / 存储。
 */
export interface SessionStatusReadPorts {
  /** 单会话运行态读口 */
  peekActivity: (sessionId: string) => SessionActivity;
  /** 会话的轮 id 列表（有序真源；空数组 = 一轮都没有） */
  readRoundIds: (sessionId: string) => readonly string[];
  /** 按轮 id 读索引态（不读盘；索引缺失返回 undefined） */
  readRoundStatus: (roundId: string) => RoundStatus | undefined;
  /** 按轮 id 读整轮（只在需要原因时调用；读不到返回 undefined） */
  readRound: (roundId: string) => Round | undefined;
  /**
   * 会话元数据读口（可选）
   *
   * 用于托管 Worker 会话优先读 `SessionMeta.workStatus`（语义层状态，比轮次状态更可靠）。
   * 缺省 undefined = 不查 workStatus，全走既有轮次状态投影逻辑。
   *
   * 为什么可选：主控工具（list_work_sessions）和工作台（workbenchModel）的调用面不同——
   * 两者都能给，但主控工具在旧装配路径里可能没有，保持可选不强制改全量调用点。
   */
  readMeta?: (sessionId: string) => SessionMeta | undefined;
}

/**
 * hosted Worker 的语义身份是否临时失效（B4）
 *
 * 定案 §3.2.1：用户在 Worker 会话里亲手发轮、且该轮仍在执行时，Worker 身份投影暂停
 * （判据读 `Round.origin` 轮戳，不读 `workOrder` 字段），轮跑完自动恢复。状态字段本身不改，
 * 只在消费侧加这一层判定。判据取「最近一轮无 hosted 级戳且未收场」：戳是轮级事实
 * （`Round.origin`），不看会话身份；
 * 读不到轮 / 读不到状态一律当未触发，不把读不到说成身份失效。
 */
function isWorkerIdentitySuspended(ports: SessionStatusReadPorts, sessionId: string): boolean {
  const lastRoundId = ports.readRoundIds(sessionId).at(-1);
  if (!lastRoundId) return false;
  const round = ports.readRound(lastRoundId);
  if (!round || round.origin === 'hosted') return false;
  const status = ports.readRoundStatus(lastRoundId) ?? round.status;
  return status !== undefined && !isRoundSettled(status);
}

/**
 * 单会话状态投影（优先级：等你 > 在跑 > 终态）
 *
 * 为什么「等你」优先：会话在等用户拍板时才是可行动的；此时即使运行态表还残留
 * `streaming === true`（暂停收尾的时序窗口），报「在跑」会让调用方以为它在自己推进。
 *
 * ⚠️ 读不到 ≠ 空闲：轮状态既不在索引里、整轮也读不到时返回 `unreadable`，
 * **不得**回落成 `queued` / `completed`——那会让代理以为「这条活没在跑，可以再开一个」。
 *
 * @param ports 读口集合
 * @param sessionId 目标会话
 * @returns 状态判别联合（`stopped` 必带原因分档）
 */
export function projectSessionStatus(
  ports: SessionStatusReadPorts,
  sessionId: string,
): WorkbenchJobStatus {
  // ↓ 新增：托管 Worker 会话优先读 SessionMeta.workStatus（语义层状态，比轮次状态更可靠）
  // 为什么：Worker 会话的轮次状态是"最后一轮的 RoundStatus"，但"最后一轮成功" ≠ "这条活完成"
  // （比如三分之二完成了某功能，轮次仍然 pending）。workStatus 是宿主事件钩子消费后写入的
  // 语义状态，更准确。自助会话的 SessionMeta.workStatus 永远 undefined，本分支自然跳过。
  //
  // 判定守卫：只对 origin='hosted' 的会话查 workStatus（防止误读旧数据的托管标记为 null）。
  // readMeta 端口可选（旧装配路径可能没有），没有就跳过，全走既有逻辑。
  if (ports.readMeta) {
    const meta = ports.readMeta(sessionId);
    if (meta?.origin === 'hosted' && meta.workStatus) {
      // B4：用户亲手发的轮仍在执行 ⇒ Worker 身份投影暂停（读 `Round.origin` 轮戳，不读
      // workOrder 字段），workStatus 不再充当投影真源；回落到下方轮次与运行态投影
      // （用户轮的真实状态）。该轮收场后本判定
      // 自然失效、无需复位——投影是纯函数，每次调用都重读最新轮。
      if (!isWorkerIdentitySuspended(ports, sessionId)) {
        return mapWorkStatusToJobStatus(meta.workStatus);
      }
    }
  }

  const activity = ports.peekActivity(sessionId);
  if (activity.waiting) return { kind: 'waiting' };
  if (activity.running) return { kind: 'running' };

  const roundIds = ports.readRoundIds(sessionId);
  const lastRoundId = roundIds[roundIds.length - 1];
  // 一轮都没有：已交给助手但还没开始（已知事实，不冒充在跑 / 完成）
  if (!lastRoundId) return { kind: 'queued' };

  // 状态优先读索引（不读盘）；索引缺失时退回整轮读取；两者都拿不到 = 如实不可知
  const status = ports.readRoundStatus(lastRoundId) ?? ports.readRound(lastRoundId)?.status;
  if (!status) return { kind: 'unreadable' };

  if (isRoundSuccessful(status)) return { kind: 'completed' };
  if (!isRoundSettled(status)) return { kind: 'unsettled' };

  // 已收场且未成功 = interrupted：原因取该轮已落地的 processEvents（读不到整轮就如实 unavailable）
  const round = ports.readRound(lastRoundId);
  const derived = deriveInterruptReason(round?.processEvents ?? []);
  return { kind: 'stopped', stop: toStopReason(derived) };
}

/**
 * SessionMeta.workStatus → WorkbenchJobStatus 映射
 *
 * 语义层 → 展示层的映射，独立成函数方便测试覆盖。
 * 工作会话被用户手动打断时 Worker 身份投影暂停（按 `Round.origin` 轮戳判定，不读 workOrder
 * 字段），但 workStatus 保持 'working'——工作台会同时展示轮次状态（可能是
 * waiting/running），这是正确的。
 */
function mapWorkStatusToJobStatus(
  workStatus: NonNullable<SessionMeta['workStatus']>,
): WorkbenchJobStatus {
  switch (workStatus) {
    case 'working':
      return { kind: 'running' }; // Worker 在跑
    case 'blocked':
      return { kind: 'waiting' }; // 等用户回答（ask_user）
    case 'completed':
      return { kind: 'completed' };
    case 'failed':
      return { kind: 'stopped', stop: { kind: 'unavailable' } }; // 语义层只标失败，中断原因走 stop.kind
  }
}

/**
 * 中断原因投影 → 跨进程分档
 *
 * 只搬运事实：`error` 带原始错误文本（展示侧按语言拼文案），其余档不带额外字段。
 *
 * @param derived 事件推导结果
 */
export function toStopReason(derived: InterruptReason): WorkbenchStopReason {
  switch (derived.stopper) {
    case 'user':
      return { kind: 'user' };
    case 'timeout':
      return { kind: 'timeout' };
    case 'error':
      return {
        kind: 'error',
        // error 分支必有 error 事件；缺失文本时不编造（展示侧只显示「异常终止」）
        ...(derived.source?.type === 'error' ? { message: derived.source.payload.message } : {}),
      };
    case 'unavailable':
      // 取不到原因就如实标取不到：不回落「用户停止」
      return { kind: 'unavailable' };
  }
}

/**
 * 「这条会话是谁开的」——代理判断「该复用还是该新开」的归属依据
 *
 * - `agent`：调用方代理开的（本进程创建者账本，或代理会话历史里的 `create_session` 记录）；
 * - `user`：用户自己建的（`SessionMeta.origin` 为 `'user'` 或旧数据无标记）；
 * - `unknown`：来源是托管通道、但账本与历史都没记到调用方名下——可能是历史超出扫描上限、
 *   也可能是别的代理 / 用户在托管入口建的。**不确定就说不知道**，不猜成「用户」或「代理」。
 */
export type AgentCreatedBy = 'agent' | 'user' | 'unknown';

/** 归属判定所需的既有事实（不新增真源） */
export interface CreatedByFacts {
  /** 本进程创建者账本里的会话 id（重启后为空；真源 = 中断通知器） */
  ledger: readonly string[];
  /** 调用方历史重建结果（只用于「这个 sid 是不是它开的」） */
  history: {
    /** 历史读取覆盖状态（`partial` / `unreadable` 时「没找到」不等于「不是它开的」） */
    coverage: WorkbenchCoverage;
    /** 历史里找到的创建记录 */
    children: readonly { sessionId: string }[];
  };
}

/**
 * 判定会话归属
 *
 * 顺序：用户来源可直接定（`origin` 不是 `hosted` 就是用户建的）→ 账本 / 历史命中即代理开的
 * → 其余一律 `unknown`（托管来源但不在调用方名下）。
 *
 * 为什么不把「历史没找到且覆盖完整」判成 `user`：托管入口允许用户自己新建会话，
 * 其 `origin` 同样是 `'hosted'`，与代理开的不可区分；猜成 `user` 会让代理误以为可以随意接管。
 *
 * @param meta 会话元数据（不存在时仍可判定账本命中）
 * @param sessionId 目标会话
 * @param facts 既有事实
 * @returns 归属三档
 */
export function projectCreatedBy(
  meta: SessionMeta | undefined,
  sessionId: string,
  facts: CreatedByFacts,
): AgentCreatedBy {
  // 用户来源：`origin` 为 'user' 或旧数据无标记（读侧口径 = 用户）⇒ 确定是用户建的
  if (meta && meta.origin !== 'hosted') return 'user';
  if (facts.ledger.includes(sessionId)) return 'agent';
  if (facts.history.children.some((child) => child.sessionId === sessionId)) return 'agent';
  return 'unknown';
}

/**
 * 清单覆盖结论（覆盖状态 + 理由；`complete` / `unreadable` 时理由为空）
 *
 * 理由类型定义在 `workbenchDto`（与 `WorkbenchCoverage` 同处，避免 shared 之间反向依赖）。
 */
export interface ListCoverageResult {
  /** 三态结论 */
  coverage: WorkbenchCoverage;
  /** 理由（`partial` 时必非空；顺序 = 轮窗口 → 记录读不出 → 会话缺失 → 反查窗口） */
  reasons: readonly ListCoverageReason[];
}

/**
 * 解析清单覆盖状态（工作台与主控工具共用同一口径 —— 判据只此一处）
 *
 * 优先级：座位会话本身读不到 ⇒ `unreadable`（清单无从谈起）；否则按四类事实归纳理由，
 * 有理由即 `partial`、无理由即 `complete`。
 *
 * ⚠️ `sessions` 为空且 `coverage !== 'complete'` 时，调用方**不得**把它当成「一条活都没有」。
 *
 * @param args 判定输入
 * @returns 覆盖状态 + 理由（理由供上层措辞，不在上层重新判定）
 */
export function resolveListCoverage(args: {
  /** 历史重建结果（缺省细节 ⇒ 不细分的 partial 也如实说出来） */
  history: {
    coverage: WorkbenchCoverage;
    /** 本次扫描的轮窗口：总数 / 实际扫描数（缺省 = 没有窗口信息） */
    totalRounds?: number;
    scannedRounds?: number;
    /** 成功解析但读不出内容的记录数（缺省 = 0） */
    unreadableRecords?: number;
  };
  /** 座位 / 调用方会话的元数据是否存在 */
  seatExists: boolean;
  /** 历史里有 sid、但磁盘上已找不到的会话数（主控工具不跳过，默认 0） */
  missingCount?: number;
  /** 反查「被派过活」时因超回看上限而截断的会话数（缺省 = 0） */
  dispatchTruncated?: number;
}): ListCoverageResult {
  if (!args.seatExists || args.history.coverage === 'unreadable') {
    return { coverage: 'unreadable', reasons: [] };
  }
  const h = args.history;
  const reasons: ListCoverageReason[] = [];
  if ((h.totalRounds ?? 0) > (h.scannedRounds ?? 0)) reasons.push({ kind: 'history-window' });
  if ((h.unreadableRecords ?? 0) > 0) reasons.push({ kind: 'history-unreadable' });
  // 调用方只给 partial、没给细节：如实说「读不全」，不编具体窗口
  if (h.coverage === 'partial' && reasons.length === 0) {
    reasons.push({ kind: 'history-unreadable' });
  }
  const missing = args.missingCount ?? 0;
  if (missing > 0) reasons.push({ kind: 'missing-sessions', count: missing });
  const dispatch = args.dispatchTruncated ?? 0;
  if (dispatch > 0) reasons.push({ kind: 'dispatch-window', count: dispatch });
  return { coverage: reasons.length > 0 ? 'partial' : 'complete', reasons };
}
