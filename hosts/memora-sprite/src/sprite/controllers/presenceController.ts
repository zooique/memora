/**
 * 在场状态控制器 — 用户离开/回来检测
 *
 * 职责：
 *   1. 监听系统锁屏/挂起/解锁/恢复事件（powerMonitor）
 *   2. 监听窗口焦点变化（browser-window-blur/focus）
 *   3. 转发为统一的 presenceChanged 精灵事件
 *   4. 用户回来时触发 ProactiveEngine 检查累积事件
 *   5. 长时间离开（>= 1 小时）后回来时触发记忆召回（onWelcomeBack 回调）
 *
 * 设计原则：
 *   - 依赖注入 powerMonitor/app 接口，便于单元测试 mock
 *   - 不监听键盘/鼠标输入内容（ADR-006 安全模型核心卖点）
 *   - 幂等保护：重复 lock-screen 不重复触发状态变化
 *   - 记录离开时长，为 Phase 2 AffectController 预留数据
 *   - 召回与检查分离：onWelcomeBack 在 checkPending 之前调用，错误隔离
 *
 * 集成点：
 *   - sprite.ts：start() 中调用 presenceController.start()
 *   - main.ts：注入 powerMonitor 和 app 事件源
 *   - SpriteEventMap：新增 presenceChanged 事件
 */
import { logger } from 'memora';
import type { ProactiveEngine } from './proactiveEngine.js';
import { MS_PER_HOUR, MS_PER_MINUTE } from '../constants.js';

/**
 * powerMonitor 事件源抽象接口（解耦 sprite/ 与 electron）
 *
 * Electron 的 PowerMonitor 模块自动满足此接口（结构子类型）。
 * 测试时可注入 mock 实现而无需引入 electron。
 *
 * removeListener 方法支持 stop() 时取消注册，防止 reinitAgent 后旧 PresenceController 监听器泄漏。
 */
export interface IPowerMonitor {
  /** 系统锁屏时触发 */
  on(event: 'lock-screen', listener: () => void): void;
  /** 系统挂起（睡眠/休眠）时触发 */
  on(event: 'suspend', listener: () => void): void;
  /** 系统解锁时触发 */
  on(event: 'unlock-screen', listener: () => void): void;
  /** 系统从挂起恢复时触发 */
  on(event: 'resume', listener: () => void): void;
  /** 取消注册事件监听器 */
  removeListener(event: 'lock-screen' | 'suspend' | 'unlock-screen' | 'resume', listener: () => void): void;
}

/**
 * app 事件源抽象接口（解耦 sprite/ 与 electron）
 *
 * Electron 的 App 模块自动满足此接口（结构子类型）。
 * 测试时可注入 mock 实现而无需引入 electron。
 *
 * removeListener 方法支持 stop() 时取消注册。
 */
export interface IApp {
  /** 浏览器窗口失焦时触发 */
  on(event: 'browser-window-blur', listener: () => void): void;
  /** 浏览器窗口聚焦时触发 */
  on(event: 'browser-window-focus', listener: () => void): void;
  /** 取消注册事件监听器 */
  removeListener(event: 'browser-window-blur' | 'browser-window-focus', listener: () => void): void;
}

/**
 * 欢迎回来触发阈值（毫秒）
 *
 * 离开时长超过此值时，回来后触发记忆召回。
 * 复用 getCrossSessionContext 的 1 小时间隔约定（perceptionCoordinator.ts），
 * 避免引入新阈值造成行为不一致。
 */
const WELCOME_BACK_THRESHOLD_MS = MS_PER_HOUR; // 1 小时

/**
 * 窗口失焦离开 debounce 时长（毫秒）
 *
 * browser-window-blur 触发后延迟此时长才真正判定为"离开"。
 * 期间若窗口重新获得焦点（browser-window-focus），则取消判定。
 * 避免 Alt+Tab 切窗查看内容几秒钟就误触发完整的 away → present 循环。
 *
 * 仅适用于窗口失焦；系统级事件（lock-screen/suspend）立即判定，不走 debounce。
 */
const AWAY_DEBOUNCE_MS = MS_PER_MINUTE * 2; // 2 分钟

/** 用户在场状态 */
export type PresenceState = 'present' | 'away';

/** 在场状态变化事件载荷 */
export interface PresenceChangeEvent {
  /** 新状态 */
  state: PresenceState;
  /** 状态变化时间戳（ISO 8601） */
  timestamp: string;
  /** 离开时长（毫秒），仅回来时有意义 */
  awayDurationMs?: number;
  /** 状态变化原因（如 'lock-screen'、'unlock-screen'、'window-blur'） */
  reason: string;
}

/** PresenceController 构造选项 */
export interface PresenceControllerOptions {
  /**
   * ProactiveEngine 引用（用户回来时触发 checkPending）
   *
   * 类型从 ProactiveEngine 收窄为 Pick<'checkPending'>，
   * 应用接口隔离原则——PresenceController 仅依赖 checkPending 方法，
   * 测试可注入仅含 checkPending 的 mock。
   */
  proactiveEngine?: Pick<ProactiveEngine, 'checkPending'>;
  /** 事件发射器（由 Sprite 注入，转发为精灵事件） */
  emit?: (event: 'presenceChanged', payload: PresenceChangeEvent) => void;
  /**
   * 用户长时间离开后回来回调（用于触发记忆召回）
   *
   * 仅当 awayDurationMs >= WELCOME_BACK_THRESHOLD_MS（1 小时）时触发。
   * 在 proactiveEngine.checkPending() 之前调用，让召回结果先注入 pendingNotices，
   * 这样 checkPending 能一并消费召回事件。
   *
   * 回调内的错误不影响后续 checkPending（错误隔离）。
   *
   * @param awayDurationMs 离开时长（毫秒），必定 >= WELCOME_BACK_THRESHOLD_MS
   */
  onWelcomeBack?: (awayDurationMs: number) => void;
}

/**
 * 在场状态控制器
 *
 * 通过依赖注入 powerMonitor 和 app 接口实现可测试性。
 * 生产环境传入 Electron 的 powerMonitor 和 app 模块，测试环境传入 mock。
 */
export class PresenceController {
  /** 当前在场状态 */
  private state: PresenceState = 'present';
  /** 离开开始时间戳（毫秒），null 表示当前在场 */
  private awaySince: number | null = null;
  /** 事件源：满足 IPowerMonitor 接口（Electron powerMonitor 或 mock） */
  private readonly powerMonitor: IPowerMonitor;
  /** 事件源：满足 IApp 接口（Electron app 或 mock） */
  private readonly app: IApp;
  /** 构造选项 */
  private readonly options: PresenceControllerOptions;
  /** 是否已启动（避免重复注册事件） */
  private started = false;
  /** 窗口失焦离开 debounce 定时器（null 表示无待判定的失焦） */
  private blurDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // ── 保存监听器引用，stop() 时可取消注册 ──
  /** lock-screen 监听器引用 */
  private lockScreenHandler: (() => void) | null = null;
  /** suspend 监听器引用 */
  private suspendHandler: (() => void) | null = null;
  /** unlock-screen 监听器引用 */
  private unlockScreenHandler: (() => void) | null = null;
  /** resume 监听器引用 */
  private resumeHandler: (() => void) | null = null;
  /** browser-window-blur 监听器引用 */
  private blurHandler: (() => void) | null = null;
  /** browser-window-focus 监听器引用 */
  private focusHandler: (() => void) | null = null;

  constructor(
    powerMonitor: IPowerMonitor,
    app: IApp,
    options: PresenceControllerOptions = {},
  ) {
    this.powerMonitor = powerMonitor;
    this.app = app;
    this.options = options;
  }

  /**
   * 启动在场状态监听
   *
   * 注册 powerMonitor 和 app 事件监听器。
   * 幂等保护：重复调用不会重复注册。
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    // ── powerMonitor 事件：系统级离开/回来 ──
    // 锁屏 → away
    this.lockScreenHandler = () => this.handleAway('lock-screen');
    this.powerMonitor.on('lock-screen', this.lockScreenHandler);
    // 系统挂起（睡眠/休眠）→ away
    this.suspendHandler = () => this.handleAway('suspend');
    this.powerMonitor.on('suspend', this.suspendHandler);
    // 解锁屏幕 → present
    this.unlockScreenHandler = () => this.handlePresent('unlock-screen');
    this.powerMonitor.on('unlock-screen', this.unlockScreenHandler);
    // 系统恢复 → present
    this.resumeHandler = () => this.handlePresent('resume');
    this.powerMonitor.on('resume', this.resumeHandler);

    // ── app 事件：窗口焦点变化 ──
    // 窗口失焦 → 延迟判定离开（debounce，避免 Alt+Tab 切窗几秒就误触发）
    this.blurHandler = () => this.scheduleAwayDebounce();
    this.app.on('browser-window-blur', this.blurHandler);
    // 窗口聚焦 → 取消待判定的失焦 + 回来判定
    // 若 debounce 未过期，cancel 后 state 仍为 present，handlePresent 幂等 return
    // 若 debounce 已过期，state 已是 away，handlePresent 正常触发
    this.focusHandler = () => {
      this.cancelAwayDebounce();
      this.handlePresent('window-focus');
    };
    this.app.on('browser-window-focus', this.focusHandler);

    logger.info('在场状态控制器已启动');
  }

  /**
   * 停止在场状态监听
   *
   * 取消注册所有事件监听器，防止 reinitAgent 后旧实例泄漏。
   * 幂等保护：未启动时调用无副作用。
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    // 逐个取消注册 powerMonitor 监听器
    if (this.lockScreenHandler) {
      this.powerMonitor.removeListener('lock-screen', this.lockScreenHandler);
      this.lockScreenHandler = null;
    }
    if (this.suspendHandler) {
      this.powerMonitor.removeListener('suspend', this.suspendHandler);
      this.suspendHandler = null;
    }
    if (this.unlockScreenHandler) {
      this.powerMonitor.removeListener('unlock-screen', this.unlockScreenHandler);
      this.unlockScreenHandler = null;
    }
    if (this.resumeHandler) {
      this.powerMonitor.removeListener('resume', this.resumeHandler);
      this.resumeHandler = null;
    }

    // 逐个取消注册 app 监听器
    if (this.blurHandler) {
      this.app.removeListener('browser-window-blur', this.blurHandler);
      this.blurHandler = null;
    }
    if (this.focusHandler) {
      this.app.removeListener('browser-window-focus', this.focusHandler);
      this.focusHandler = null;
    }

    // 清理待判定的失焦 debounce 定时器，防止 stop 后仍触发 handleAway
    this.cancelAwayDebounce();

    logger.info('在场状态控制器已停止');
  }

  /**
   * 调度窗口失焦离开判定（debounce）
   *
   * browser-window-blur 后不立即判定离开，而是延迟 AWAY_DEBOUNCE_MS。
   * 期间若窗口重新聚焦（focusHandler 调 cancelAwayDebounce）则取消判定。
   * 幂等保护：已有待判定定时器时不重复调度。
   */
  private scheduleAwayDebounce(): void {
    // 已有待判定定时器，不重复调度
    if (this.blurDebounceTimer) return;
    // 已离开，无需 debounce（幂等保护）
    if (this.state === 'away') return;

    this.blurDebounceTimer = setTimeout(() => {
      this.blurDebounceTimer = null;
      this.handleAway('window-blur');
    }, AWAY_DEBOUNCE_MS);
  }

  /**
   * 取消窗口失焦离开 debounce
   *
   * 由 focusHandler 和 handleAway 调用，清理待判定的失焦定时器。
   * 无待判定定时器时无副作用。
   */
  private cancelAwayDebounce(): void {
    if (this.blurDebounceTimer) {
      clearTimeout(this.blurDebounceTimer);
      this.blurDebounceTimer = null;
    }
  }

  /**
   * 获取当前在场状态
   *
   * 供外部查询（如仪表盘显示"用户已离开 5 分钟"）。
   */
  getState(): PresenceState {
    return this.state;
  }

  /**
   * 获取离开开始时间戳
   *
   * 返回 null 表示当前在场。
   */
  getAwaySince(): number | null {
    return this.awaySince;
  }

  /**
   * 处理离开事件（内部方法）
   *
   * 幂等保护：已处于 away 状态时忽略后续离开事件。
   *
   * @param reason 离开原因（如 'lock-screen'、'window-blur'）
   */
  private handleAway(reason: string): void {
    // 幂等保护：已离开则不重复触发
    if (this.state === 'away') return;

    // 系统级事件触发离开时，取消可能存在的窗口失焦 debounce（避免冗余触发）
    this.cancelAwayDebounce();

    this.state = 'away';
    this.awaySince = Date.now();

    const payload: PresenceChangeEvent = {
      state: 'away',
      timestamp: new Date(this.awaySince).toISOString(),
      reason,
    };

    this.options.emit?.('presenceChanged', payload);
    logger.info({ reason, timestamp: payload.timestamp }, '用户离开');
  }

  /**
   * 处理回来事件（内部方法）
   *
   * 幂等保护：已处于 present 状态时忽略后续回来事件。
   * 用户回来时触发 ProactiveEngine 检查累积事件。
   *
   * @param reason 回来原因（如 'unlock-screen'、'window-focus'）
   */
  private handlePresent(reason: string): void {
    // 幂等保护：已在场则不重复触发
    if (this.state === 'present') return;

    // 单次 Date.now() 调用，避免两次调用间毫秒级差异导致 awayDurationMs 与 timestamp 不一致
    const now = Date.now();
    const awayDurationMs = this.awaySince ? now - this.awaySince : 0;

    this.state = 'present';
    this.awaySince = null;

    const payload: PresenceChangeEvent = {
      state: 'present',
      timestamp: new Date(now).toISOString(),
      awayDurationMs,
      reason,
    };

    this.options.emit?.('presenceChanged', payload);
    logger.info({ reason, awayDurationMs, timestamp: payload.timestamp }, '用户回来');

    // 长时间离开后回来：触发记忆召回（在 checkPending 之前，让召回结果先入队）
    // 仅当离开时长 >= WELCOME_BACK_THRESHOLD_MS 时触发，避免短时间切窗误触发
    if (awayDurationMs >= WELCOME_BACK_THRESHOLD_MS) {
      try {
        this.options.onWelcomeBack?.(awayDurationMs);
      } catch (err) {
        // 回调失败不影响后续 checkPending（错误隔离）
        logger.warn({ err, awayDurationMs }, 'onWelcomeBack 回调失败');
      }
    }

    // 用户回来时触发 ProactiveEngine 检查累积事件
    // 例如用户离开期间积累了多条 memory/insight 事件，回来时统一提示
    // onWelcomeBack 注入的 recalled 事件也会在此被消费
    this.options.proactiveEngine?.checkPending();
  }
}
