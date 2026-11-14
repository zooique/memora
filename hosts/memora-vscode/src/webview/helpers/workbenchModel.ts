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
  isRoundSettled,
  isRoundSuccessful,
  type Round,
  type RoundStatus,
  type SessionMeta,
} from '@zooique/memora';
import { deriveInterruptReason, type InterruptReason } from '../../shared/interruptReason.js';
import type {
  WorkbenchAgentIdentity,
  WorkbenchCoverage,
  WorkbenchJob,
  WorkbenchJobStatus,
  WorkbenchSnapshot,
  WorkbenchStopReason,
} from '../../shared/workbenchDto.js';
import { WORKBENCH_REBUILD_MAX_ROUNDS, type WorkbenchHistoryResult } from './workbenchHistory.js';

/** 单会话运行态（工作台只需要这两问） */
export interface WorkbenchActivity {
  /** 正在流式生成 */
  running: boolean;
  /** 在等用户（待答提问 / 待确认 / 已软暂停） */
  waiting: boolean;
}

/**
 * 快照投影的全部读口（由面板注入；本模块不持有任何实例）
 *
 * 全部是「读既有事实」的回调：换成测试替身即可直接驱动投影，不需要构造 Agent / 存储。
 */
export interface WorkbenchSnapshotInputs {
  /** 座位会话标识（工作台以一条托管会话为单位） */
  orchestratorId: string;
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
  /** 该会话开出去的子会话（真源 = 中断通知器的创建者账本，仅本进程） */
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
  // 清单 = 历史重建 ∪ 本进程创建者账本：账本更新（刚开出的会话还未落盘事件），
  // 历史更全（重启后账本为空）。两边都只是既有事实，不是两份状态源。
  const merged = new Map<string, string | undefined>();
  for (const child of inputs.history.children) merged.set(child.sessionId, child.title);
  for (const sessionId of inputs.childrenOf(inputs.orchestratorId)) {
    if (!merged.has(sessionId)) merged.set(sessionId, undefined);
  }
  const jobs: WorkbenchJob[] = [];
  /** 历史里有 sid、但磁盘上已找不到的会话数（跳过并计数，不静默丢） */
  let missingCount = 0;
  for (const [sessionId, historyTitle] of merged) {
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
      title: getSessionDisplayName(meta) || historyTitle || inputs.titleOf(sessionId, meta),
      status: projectStatus(inputs, sessionId),
      updatedAt: meta.updatedAt,
    });
  }
  jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    orchestrator,
    jobs,
    coverage: resolveCoverage(inputs, missingCount),
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
 * 优先级：座位会话本身都读不到 ⇒ `unreadable`（历史无从谈起）；
 * 历史读不全 / 有会话找不到 ⇒ `partial`；否则 `complete`。
 *
 * @param inputs 读口
 * @param missingCount 找不到的会话数
 */
function resolveCoverage(inputs: WorkbenchSnapshotInputs, missingCount: number): WorkbenchCoverage {
  // 座位会话元数据都没了（会话被删 / 未落盘）：历史读不出来，不能说「一条都没有」
  if (!inputs.readMeta(inputs.orchestratorId)) return 'unreadable';
  if (inputs.history.coverage === 'unreadable') return 'unreadable';
  if (inputs.history.coverage === 'partial' || missingCount > 0) return 'partial';
  return 'complete';
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

/**
 * 单会话状态投影（优先级：等你 > 在跑 > 终态）
 *
 * 为什么「等你」优先：会话在等用户拍板时才是可行动的；此时即使运行态表还残留
 * `streaming === true`（暂停收尾的时序窗口），展示「在跑」会让用户以为它在自己推进。
 */
function projectStatus(inputs: WorkbenchSnapshotInputs, sessionId: string): WorkbenchJobStatus {
  const activity = inputs.peekActivity(sessionId);
  if (activity.waiting) return { kind: 'waiting' };
  if (activity.running) return { kind: 'running' };

  const roundIds = inputs.readRoundIds(sessionId);
  const lastRoundId = roundIds[roundIds.length - 1];
  // 一轮都没有：已交给助手但还没开始（不冒充在跑 / 完成）
  if (!lastRoundId) return { kind: 'queued' };

  // 状态优先读索引（不读盘）；索引缺失时退回整轮读取；两者都拿不到 = 如实不可知
  const status = inputs.readRoundStatus(lastRoundId) ?? inputs.readRound(lastRoundId)?.status;
  if (!status) return { kind: 'unreadable' };

  if (isRoundSuccessful(status)) return { kind: 'completed' };
  if (!isRoundSettled(status)) return { kind: 'unsettled' };

  // 已收场且未成功 = interrupted：原因取该轮已落地的 processEvents（读不到整轮就如实 unavailable）
  const round = inputs.readRound(lastRoundId);
  const derived = deriveInterruptReason(round?.processEvents ?? []);
  return { kind: 'stopped', stop: toStopReason(derived) };
}

/**
 * 中断原因投影 → 跨进程分档
 *
 * 只搬运事实：`error` 带原始错误文本（webview 按语言拼文案），其余档不带额外字段。
 */
function toStopReason(derived: InterruptReason): WorkbenchStopReason {
  switch (derived.stopper) {
    case 'user':
      return { kind: 'user' };
    case 'timeout':
      return { kind: 'timeout' };
    case 'error':
      return {
        kind: 'error',
        // error 分支必有 error 事件；缺失文本时不编造（webview 只显示「异常终止」）
        ...(derived.source?.type === 'error' ? { message: derived.source.payload.message } : {}),
      };
    case 'unavailable':
      // 取不到原因就如实标取不到：不回落「用户停止」
      return { kind: 'unavailable' };
  }
}
