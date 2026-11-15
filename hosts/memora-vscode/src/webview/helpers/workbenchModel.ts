/**
 * 工作台快照投影（纯函数，宿主侧）
 *
 * 职责：把四份既有事实拼成 `WorkbenchSnapshot`——
 *   ① 会话元数据（标题 / 角色包名 / 更新时间）= `SessionStore`；
 *   ② 运行态（在跑 / 等你）= 面板运行态表 + ask/confirm + 实例暂停态（由调用方注入闭包）；
 *   ③ 终态（完成 / 被中止 / 未收场）= 最后一轮的 `RoundStatus`；
 *   ④ 被中止的原因 = `deriveInterruptReason` 读该轮已落地的 `processEvents`。
 *
 * 边界（刻意收窄，勿扩）：
 *   - **不新增状态源**：这里只是读侧投影，不写 meta、不建索引、不缓存状态；
 *   - **不造展示文案**：状态只出枚举，文案归 webview 的 l10n；标题由调用方按既有
 *     回落链算好传入（与历史列表 / 面板标题条同一口径）；
 *   - **不补默认值**：读不到的轮状态如实标 `unreadable`，没有停止原因如实标
 *     `unavailable`；不用 `unknown` 当垃圾桶。
 */
import {
  getSessionDisplayName,
  type Round,
  type RoundStatus,
  type SessionMeta,
} from '@zooique/memora';
import {
  projectSessionStatus,
  resolveListCoverage,
  type ListCoverageResult,
  type SessionActivity,
} from '../../shared/sessionStatus.js';
import {
  filtersByLiveDriver,
  type WorkbenchAgentIdentity,
  type WorkbenchJob,
  type WorkbenchSeatSource,
  type WorkbenchSnapshot,
} from '../../shared/workbenchDto.js';
import { WORKBENCH_REBUILD_MAX_ROUNDS, type WorkbenchHistoryResult } from './workbenchHistory.js';

/** 单会话运行态（工作台只需要这两问；与主控工具共用同一形状） */
export type WorkbenchActivity = SessionActivity;

/**
 * 快照投影的全部读口（由面板注入；本模块不持有任何实例）
 *
 * 全部是「读既有事实」的回调：换成测试替身即可直接驱动投影，不需要构造 Agent / 存储。
 */
export interface WorkbenchSnapshotInputs {
  /** 座位会话标识（工作台以一条托管会话为单位） */
  orchestratorId: string;
  /**
   * 座位来源（`live` = 本进程托管装配；`history` = 重启后按历史重建；`revoked` = 座位被收回）
   *
   * 为 `history` 时**不按当前驱动权过滤清单**：重启后驱动集合必为空，若照旧过滤，
   * 历史里读回来的记录会被全部挡掉——那等于把「我看不见」说成「你没有」。
   * `revoked` 与 `live` 一样**照旧过滤**：收回发生在本进程里，驱动权是**实时事实**，
   * 被收回的记录不该再冒充「在管的活」（挡掉的数量由 `filteredCount` 如实交代）。
   */
  seatSource: WorkbenchSeatSource;
  /** 代理名（装配期注入的发送者名，与 `RoundMessage.name` 同源） */
  agentName: string;
  /** 会话元数据读口（真源 = 宿主 SessionStore） */
  readMeta: (sessionId: string) => SessionMeta | undefined;
  /** 会话角色包名快照读口（真源 = 会话元数据） */
  readRolePackName: (sessionId: string) => string | undefined;
  /** 角色包展示名解析（真源 = 内核角色包编目；取不到返回 undefined） */
  readRolePackDisplayName: (sessionId: string, name: string) => string | undefined;
  /** 本进程是否仍按托管装配（真源 = `SessionModeStore`） */
  isManaged: (sessionId: string) => boolean;
  /**
   * 该会话当前是否仍由代理驱动（真源 = `SessionModeStore`，与停止 / 暂停 / 通知同一判据）
   *
   * 用户收回后即使创建者账本还记着它，也不再出现在清单里——账本只做出生记录，不当权限用。
   */
  isAgentDriven: (sessionId: string) => boolean;
  /** 该会话当前接管过的会话（真源 = 中断通知器的创建者账本：建会话 + 派发接管，仅本进程） */
  childrenOf: (creatorSessionId: string) => readonly string[];
  /**
   * 打开工作台时从历史重建的结果（重启后账本为空，靠它把清单补回来）
   *
   * 调用方只在 `open()` 时重建一次并缓存——不在每次刷新重读（读盘有上限）。
   */
  history: WorkbenchHistoryResult;
  /** 单会话运行态读口（运行态表 + ask/confirm + 实例暂停态） */
  peekActivity: (sessionId: string) => WorkbenchActivity;
  /** 会话的轮 id 列表（有序真源） */
  readRoundIds: (sessionId: string) => readonly string[];
  /** 按轮 id 读索引态（不读盘；索引缺失返回 undefined） */
  readRoundStatus: (roundId: string) => RoundStatus | undefined;
  /** 按轮 id 读整轮（只在需要原因时调用；读不到返回 undefined） */
  readRound: (roundId: string) => Round | undefined;
  /** 会话标题（调用方按既有回落链算好，禁本模块另写一套） */
  titleOf: (sessionId: string, meta: SessionMeta | undefined) => string;
}

/**
 * 构建工作台全量快照
 *
 * 排序：子会话按 `updatedAt` 降序（最近在办的排最前）；元数据缺失的子会话**整条跳过**
 * ——它已被删除（或尚未落盘），显示一行「无名会话」就是假数据。
 *
 * @param inputs 读口集合
 * @returns 可直接投递的快照（`jobs` 为空数组 = 空态）
 */
export function buildWorkbenchSnapshot(inputs: WorkbenchSnapshotInputs): WorkbenchSnapshot {
  const orchestrator = buildIdentity(inputs);
  // 清单 = 本进程创建者账本 ∪ 历史重建。两边覆盖的**不是同一批会话**，谁也不是谁的超集：
  //   账本 = 本进程内「代理建的 + 派发接管的」（重启即空，仅本进程可见）；
  //   历史 = create_session 重建「代理开的」∪ 按 `Round.dispatchedBy` 反查「被派过活的」。
  // 所以两边都要合；都只是既有事实（来源各带 `via`，界面分档展示，不混成一种）。
  const merged = new Map<string, { title?: string; via?: 'create' | 'delegate' }>();
  for (const child of inputs.history.children) {
    merged.set(child.sessionId, { title: child.title, via: child.via });
  }
  for (const sessionId of inputs.childrenOf(inputs.orchestratorId)) {
    if (!merged.has(sessionId)) merged.set(sessionId, {});
  }
  const jobs: WorkbenchJob[] = [];
  /** 历史里有 sid、但磁盘上已找不到的会话数（跳过并计数，不静默丢） */
  let missingCount = 0;
  /** 确实存在、但被「当前不由代理驱动」判据挡掉的记录数（空清单时如实说明用） */
  let filteredCount = 0;
  for (const [sessionId, origin] of merged) {
    // 当前驱动权过滤：用户收回后即使账本 / 历史还记着，也不再归代理（唯一判据）。
    // **是否过滤由座位来源决定**（判据只在 `filtersByLiveDriver` 一处）：`live` / `revoked`
    // 有实时驱动事实 ⇒ 照常过滤；`history` / `restored` 没有（驱动归属不落盘）⇒ 不过滤，
    // 否则重启后重建出来的历史记录会被「集合必空」整片挡掉，界面另行说明「没有实时驱动方」。
    if (filtersByLiveDriver(inputs.seatSource) && !inputs.isAgentDriven(sessionId)) {
      filteredCount += 1;
      continue;
    }
    const meta = inputs.readMeta(sessionId);
    // 元数据缺失 = 会话已删除 / 找不到：跳过但计数，界面明说「有 N 条找不到了」
    if (!meta) {
      missingCount += 1;
      continue;
    }
    jobs.push({
      sessionId,
      // 标题口径：会话自己起过名 → 用它（与历史列表一致）；没名字时用创建时给的标题；
      // 两者都没有才退回占位标题（不把时间占位冒充「它开的活叫什么」）。
      // ⚠️ 用 `||` 而非 `??`：`getSessionDisplayName` 没名字时返回**空串**，
      //    `??` 会把空串当有效值，标题就变成空白行（历史标题被吞掉）。
      title: getSessionDisplayName(meta) || origin.title || inputs.titleOf(sessionId, meta),
      // 状态判断只此一处（shared/sessionStatus）：主控工具调的是同一函数，防两处漂移
      status: projectSessionStatus(inputs, sessionId),
      updatedAt: meta.updatedAt,
      // 来源分档：create（助手开的）/ delegate（被派过活）；分不出来源就不给标签
      ...(origin.via ? { via: origin.via } : {}),
    });
  }
  jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // 判据只算一次：结论与理由同一份，界面据此措辞（不再各自推断「为什么 partial」）
  const listed = resolveCoverage(inputs, missingCount);
  return {
    orchestrator,
    seatSource: inputs.seatSource,
    jobs,
    filteredCount,
    // 别人派出的活只报数量（工作台锚点是当前座位，不混写归属）
    foreignDispatches: inputs.history.dispatchScan.foreign,
    coverage: listed.coverage,
    coverageReasons: listed.reasons,
    missingCount,
    scan: {
      maxRounds: WORKBENCH_REBUILD_MAX_ROUNDS,
      totalRounds: inputs.history.totalRounds,
      scannedRounds: inputs.history.scannedRounds,
    },
  };
}

/**
 * 解析清单覆盖状态
 *
 * 口径已外置到 `shared/sessionStatus.resolveListCoverage`：主控工具与工作台共用同一判据，
 * 避免「工作台说读不到、工具说一条都没有」这种两套答案。这里**只喂事实、不判**——
 * 反查窗口截断也一并交给它，理由由它统一产出。
 *
 * @param inputs 读口
 * @param missingCount 找不到的会话数
 */
function resolveCoverage(
  inputs: WorkbenchSnapshotInputs,
  missingCount: number,
): ListCoverageResult {
  return resolveListCoverage({
    history: inputs.history,
    // 座位会话元数据都没了（会话被删 / 未落盘）：历史读不出来，不能说「一条都没有」
    seatExists: Boolean(inputs.readMeta(inputs.orchestratorId)),
    missingCount,
    // 反查窗口：目标会话轮数超上限时「更早的派发没读到」，与轮窗口同属 partial 理由
    dispatchTruncated: inputs.history.dispatchScan.truncated,
  });
}

/**
 * 第一块：代理座位身份
 *
 * 角色包展示名只有在「内核编目能解析到」时才带上；解析不到只留名字快照，
 * 不拿名字冒充展示名（两者在同一份 manifest 里可以不同）。
 */
function buildIdentity(inputs: WorkbenchSnapshotInputs): WorkbenchAgentIdentity {
  const meta = inputs.readMeta(inputs.orchestratorId);
  const rolePackName = inputs.readRolePackName(inputs.orchestratorId);
  const displayName = rolePackName
    ? inputs.readRolePackDisplayName(inputs.orchestratorId, rolePackName)
    : undefined;
  return {
    name: inputs.agentName,
    sessionId: inputs.orchestratorId,
    title: inputs.titleOf(inputs.orchestratorId, meta),
    managed: inputs.isManaged(inputs.orchestratorId),
    ...(rolePackName ? { rolePackName } : {}),
    ...(displayName ? { rolePackDisplayName: displayName } : {}),
  };
}
