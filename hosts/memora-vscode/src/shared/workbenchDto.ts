/**
 * 工作台 v0 — 跨进程 DTO（宿主 → webview 的快照形状）
 *
 * 为什么单独成文件：协议文件只登记消息类型（`type` 字面量），DTO 形状外置后
 * 计数守卫不会被字段名干扰，webview 与宿主共用同一份类型（禁两侧各写一份镜像）。
 *
 * 口径：
 *   - 这里只装**事实与枚举**，不装展示文案——文案在 webview 侧走 `@vscode/l10n`，
 *     宿主不替它翻译（同一事实不接受两处表达）。
 *   - 状态是一个判别联合：`stopped` 必带 `stop` 分档；其它分支不允许带
 *     （不让 `unknown` 之类的兜底值混进来）。
 */

/**
 * 单个会话在工作台上的状态分档
 *
 * - `running`：正在跑（宿主运行态 `streaming === true`）
 * - `waiting`：等你（待答提问 / 待确认 / 已软暂停）
 * - `completed`：最后一轮成功收场
 * - `stopped`：最后一轮以中断收场（原因见 `stop`）
 * - `unsettled`：最后一轮未收场（崩溃残留且尚未被打捞）——如实标，不冒充 `stopped`
 * - `queued`：已交给助手，但还没有任何一轮（首轮同步失败等窗口）——不冒充在跑/完成
 * - `unreadable`：最新一轮存在，但宿主索引与正文都读不到它的状态——**如实标不可知**，
 *   不拿 `unsettled` / `stopped` 冒充（这条分支只在读盘失败时可达）
 */
export type WorkbenchJobKind =
  'running' | 'waiting' | 'completed' | 'stopped' | 'unsettled' | 'queued' | 'unreadable';

/**
 * 被中止的停手者分档（与 `shared/interruptReason.ts` 的 `InterruptStopper` 同源）
 *
 * `unavailable` = 本轮确实以中断收场，但没有任何可判定的原因（如实标，不伪造）。
 */
export type WorkbenchStopKind = 'user' | 'timeout' | 'error' | 'unavailable';

/** 被中止的原因（只有 `kind === 'stopped'` 携带） */
export interface WorkbenchStopReason {
  /** 停手者分档 */
  kind: WorkbenchStopKind;
  /**
   * 异常终止的原始错误文本（仅 `kind === 'error'` 携带）
   *
   * 保留原文而不是提前翻译：webview 要按界面语言拼「异常终止：{0}」。
   */
  message?: string;
}

/** 会话状态（判别联合：避免「有 stop 却没有 stopped」这类非法组合） */
export type WorkbenchJobStatus =
  | { kind: 'running' }
  | { kind: 'waiting' }
  | { kind: 'completed' }
  | { kind: 'unsettled' }
  | { kind: 'queued' }
  | { kind: 'unreadable' }
  | { kind: 'stopped'; stop: WorkbenchStopReason };

/** 一条「最近在办什么」 */
export interface WorkbenchJob {
  /** 会话标识（点击「去这个会话」的载荷） */
  sessionId: string;
  /** 展示标题（宿主按既有标题回落链算好；webview 不再拼） */
  title: string;
  /** 状态投影 */
  status: WorkbenchJobStatus;
  /** 最后更新时间（ISO 8601；列表按此降序） */
  updatedAt: string;
}

/**
 * 代理座位（第一块「代理是谁」）
 *
 * 只放既有事实：发送者名（装配期注入）、座位会话标题、角色包名 / 展示名、
 * 以及「本进程是否仍按托管装配」。没有「头像 / 在线状态」这类新造概念。
 */
export interface WorkbenchAgentIdentity {
  /** 代理名（= 托管输入落 `RoundMessage.name` 的同一份名字） */
  name: string;
  /** 座位会话标识 */
  sessionId: string;
  /** 座位会话标题 */
  title: string;
  /** 本进程是否仍按托管装配（撤销后为 false，如实显示） */
  managed: boolean;
  /** 角色包名快照（会话元数据；缺省 = 未记录，不显示该行） */
  rolePackName?: string;
  /** 角色包展示名（有实例时经内核编目解析；缺省 = 只显示名字） */
  rolePackDisplayName?: string;
}

/**
 * 座位来源（回答「这一屏是实时事实，还是重启后按历史重建」）
 *
 * - `live`：本进程仍按托管装配这条座位，状态读的是实时运行态；
 * - `history`：进程内托管表已空（多为重启后），座位从持久历史里重建，**当前没有实时驱动方**。
 */
export type WorkbenchSeatSource = 'live' | 'history';

/** 工作台全量快照（每次 `ready` 都整份重发，不做增量） */
export interface WorkbenchSnapshot {
  /** 第一块：代理是谁 */
  orchestrator: WorkbenchAgentIdentity;
  /** 座位来源（界面据此说清「实时」与「重启后按历史重建」） */
  seatSource: WorkbenchSeatSource;
  /** 第二块：在管会话清单（空数组 = 空态，不摆空表格） */
  jobs: WorkbenchJob[];
  /**
   * 候选记录里因「当前不由代理驱动」而被过滤掉的数量
   *
   * 只统计**确实存在、但被驱动权判据挡掉**的记录（用户收回等）；用于空清单时如实
   * 区分「一条都没有」与「有记录但被过滤」，避免把「我看不见」说成「你没有」。
   */
  filteredCount: number;
  /**
   * 清单覆盖状态——空清单时区分「一条都没有」与「读不到」
   *
   * - `complete`：历史读全了；空 = 确实一条都没开过
   * - `partial`：读完了一部分（超扫描上限 / 有记录解析失败 / 有会话找不到）
   * - `unreadable`：历史根本读不出（读盘失败 / 座位会话已不存在）
   *
   * ⚠️ `jobs` 为空且 `coverage !== 'complete'` 时**不得**显示「还没有交给助手的活」。
   */
  coverage: WorkbenchCoverage;
  /** 历史里有 sid、但磁盘上已找不到的会话数（跳过并计数，不静默丢弃） */
  missingCount: number;
  /** 重建扫描口径（超上限时 webview 说清「只读了多少轮」） */
  scan: WorkbenchScanInfo;
}

/** 清单覆盖状态（三态；不是新状态源，只是「这次重建读到哪」的说明） */
export type WorkbenchCoverage = 'complete' | 'partial' | 'unreadable';

/** 历史重建的扫描口径 */
export interface WorkbenchScanInfo {
  /** 单次重建的轮数上限（写死并对外可见） */
  maxRounds: number;
  /** 该会话总轮数 */
  totalRounds: number;
  /** 本次实际扫描的轮数（= min(totalRounds, maxRounds)） */
  scannedRounds: number;
}
