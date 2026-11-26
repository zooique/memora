/**
 * 失败限流（按来源 IP / 设备指纹维度）—— 防口令爆破与探测
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §16.2 G4：按来源 IP + 设备维度失败计数、临时封禁与 TTL
 *   - §4.5.5：同一来源 5 分钟内失败 ≥5 次 ⇒ 封禁 30 分钟
 *
 * 为什么要有本文件：配对是「未知客户端」唯一能反复触发的入口（§5.8：握手端点直接暴露），
 * 没有失败计数就等于把「能否发起配对」交给扫描器。计数状态必须有界，否则未知来源
 * 可以靠不停换 IP 把宿主内存撑爆。
 *
 * 边界：只记录失败与封禁，**不做任何业务裁决**（是否真的拒绝由桥查 `check()` 决定）；
 * 内存态、不落盘（进程重启后封禁清零是可接受的：重启本身已是人工动作）。
 */

/** 限流检查结果 */
export interface RemoteRateLimitState {
  /** 当前是否被封禁 */
  blocked: boolean;
  /** 距解封的毫秒数（未封禁 = 0） */
  retryAfterMs: number;
}

/** 构造参数（时钟可注入，便于单测） */
export interface RemoteFailureLimiterOptions {
  /** 时钟（缺省 `Date.now`） */
  now?: () => number;
  /** 失败计数窗口（缺省 5 分钟） */
  windowMs?: number;
  /** 窗口内失败达到该次数即封禁（缺省 5） */
  maxFailures?: number;
  /** 封禁时长（缺省 30 分钟） */
  banMs?: number;
  /** 内存键上限（缺省 512；超出淘汰最久未活动的键） */
  maxKeys?: number;
  /** 日志口（键被淘汰时留痕一次；缺省静默） */
  log?: (message: string) => void;
}

/** 单个键的计数状态 */
interface FailureEntry {
  /** 窗口内的失败时刻（epoch ms） */
  failures: number[];
  /** 最近一次活动时刻（淘汰判据） */
  lastActivity: number;
  /** 封禁到期时刻（0 = 未封禁） */
  blockedUntil: number;
}

/** 默认窗口（§4.5.5：5 分钟） */
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

/** 默认失败阈值（§4.5.5：5 次） */
const DEFAULT_MAX_FAILURES = 5;

/** 默认封禁时长（§4.5.5：30 分钟） */
const DEFAULT_BAN_MS = 30 * 60 * 1000;

/** 默认键上限（防未知来源换键撑爆内存） */
const DEFAULT_MAX_KEYS = 512;

/**
 * 失败限流器（一个宿主进程一份）
 *
 * 失败计数只统计**窗口内**的失败：连续 5 次慢速失败（相隔 > 5 分钟）不会累积成封禁；
 * 封禁期间继续失败不延长封禁（`blockedUntil` 只在达到阈值那一刻设置一次）。
 */
export class RemoteFailureLimiter {
  /** 键 → 计数状态（Map 保持插入 / 更新顺序，便于淘汰最久未活动者） */
  private readonly entries = new Map<string, FailureEntry>();
  /** 时钟 */
  private readonly now: () => number;
  /** 窗口 */
  private readonly windowMs: number;
  /** 失败阈值 */
  private readonly maxFailures: number;
  /** 封禁时长 */
  private readonly banMs: number;
  /** 键上限 */
  private readonly maxKeys: number;
  /** 日志口 */
  private readonly log: (message: string) => void;

  constructor(opts: RemoteFailureLimiterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.banMs = opts.banMs ?? DEFAULT_BAN_MS;
    this.maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
    this.log = opts.log ?? (() => undefined);
  }

  /**
   * 查当前是否被封禁
   *
   * @param key 来源维度（IP 或设备指纹）
   */
  check(key: string): RemoteRateLimitState {
    const entry = this.entries.get(key);
    if (!entry) return { blocked: false, retryAfterMs: 0 };
    const now = this.now();
    if (entry.blockedUntil > now) {
      return { blocked: true, retryAfterMs: entry.blockedUntil - now };
    }
    // 封禁已到期：清掉标记（失败计数已在封禁时清空，故解封即从零开始）
    if (entry.blockedUntil !== 0) entry.blockedUntil = 0;
    return { blocked: false, retryAfterMs: 0 };
  }

  /**
   * 记录一次失败，并返回记录后的限流状态
   *
   * @param key 来源维度（IP 或设备指纹）
   */
  noteFailure(key: string): RemoteRateLimitState {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { failures: [], lastActivity: now, blockedUntil: 0 };
      this.insert(key, entry);
    }
    // 封禁期内继续失败：不延长封禁，如实回报剩余时间
    if (entry.blockedUntil > now) {
      return { blocked: true, retryAfterMs: entry.blockedUntil - now };
    }
    entry.lastActivity = now;
    entry.failures = entry.failures.filter((at) => now - at <= this.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.maxFailures) {
      entry.failures = [];
      entry.blockedUntil = now + this.banMs;
      return { blocked: true, retryAfterMs: this.banMs };
    }
    return { blocked: false, retryAfterMs: 0 };
  }

  /**
   * 记录一次成功（清零该键的全部状态）
   *
   * @param key 来源维度（IP 或设备指纹）
   */
  noteSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** 写入新键；超上限时淘汰最久未活动的键（并留痕一次） */
  private insert(key: string, entry: FailureEntry): void {
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.findOldestKey();
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.log(`[REMOTE-LIMIT] 计数键超过上限 ${this.maxKeys}，淘汰最久未活动键`);
    }
    this.entries.set(key, entry);
  }

  /** 找 `lastActivity` 最小的键（并列时取插入顺序更早者） */
  private findOldestKey(): string | undefined {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.lastActivity < oldestAt) {
        oldestAt = entry.lastActivity;
        oldestKey = key;
      }
    }
    return oldestKey;
  }
}
