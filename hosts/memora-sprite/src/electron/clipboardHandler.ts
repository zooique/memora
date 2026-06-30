/**
 * 剪贴板处理器 — 三重保护：被动检测 + 主动触发 + 敏感过滤
 *
 * 职责（Phase 3.1）：
 *   1. 被动检测剪贴板变化（轮询模式，仅检测"是否有变化"，不读取内容）
 *   2. 用户主动触发分析时读取内容
 *   3. 敏感内容检测（密码/Token/信用卡/私钥），命中则静默忽略
 *   4. 非敏感内容经输入护栏检查后通知 UI 展示确认
 *
 * 设计原则：
 *   - 不持续监听剪贴板内容，只检测变化事件（R20 隐私风险）
 *   - 不自动存储剪贴板内容为记忆（R21 写入二次确认）
 *   - 敏感信息静默忽略，不提示分析（R22 安全风险）
 *   - 依赖注入 clipboard 接口，便于单元测试 mock
 *   - 仅在精灵窗口可见时轮询，避免后台占用
 *
 * 集成点：
 *   - main.ts：创建 ClipboardHandler，注入 clipboard 模块
 *   - IPC 通道：clipboard:changed / clipboard:analyze / clipboard:confirm
 */
import type { Clipboard } from 'electron';
// 合并 memora 导入：加入安全定时器包装，统一追踪定时器生命周期
import { logger, safeSetInterval, clearSafeInterval } from 'memora';
// 引入共享时间常量：消除魔法数字 2000，与 sprite 层统一时间单位定义
import { MS_PER_SECOND } from '../sprite/constants.js';

/** 剪贴板事件类型（开放字符串，非枚举） */
export type ClipboardEventType =
  | 'changed'           // 剪贴板内容变化（不携带内容）
  | 'sensitive-ignored' // 检测到敏感内容，静默忽略
  | 'analysis-ready'    // 内容已通过敏感检测和护栏，等待用户确认
  | 'analysis-rejected'; // 输入护栏拦截

/** 敏感内容类型（开放字符串，非枚举，遵循 ADR-004） */
export type SensitiveType = string;

/** 敏感内容检测结果 */
export interface SensitiveCheckResult {
  /** 是否敏感 */
  sensitive: boolean;
  /** 命中的敏感类型（如 'password'、'token'、'credit-card'、'private-key'） */
  type?: SensitiveType;
}

/**
 * 敏感内容检测模式（常量数组，便于扩展）
 *
 * 每个模式包含 type（类型标识）、pattern（正则）、label（人类可读描述）。
 * 命中任一模式即判定为敏感内容，静默忽略不提示分析。
 */
export const SENSITIVE_PATTERNS: ReadonlyArray<{ type: string; pattern: RegExp; label: string }> = [
  // API Token 前缀模式（Bearer / sk- / api_key= 等）
  {
    type: 'token',
    pattern: /^(Bearer\s|sk-|api_key=|apikey=|token=|authorization:\s)/i,
    label: 'API Token',
  },
  // 信用卡模式（16 位连续数字，可能含空格或连字符）
  {
    type: 'credit-card',
    pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
    label: '信用卡号',
  },
  // 密码模式（8+ 位，含大小写字母+数字+特殊字符，无空格）
  // 注意：此模式可能误判，但宁可误判也不漏判（安全优先）
  {
    type: 'password',
    pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])[^\s]{8,}$/,
    label: '密码',
  },
  // 私钥模式（PEM 格式头部）
  {
    type: 'private-key',
    pattern: /-----BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE\s+KEY-----/,
    label: '私钥',
  },
  // AWS Access Key 模式（20 位大写字母数字）
  {
    type: 'aws-key',
    pattern: /AKIA[0-9A-Z]{16}/,
    label: 'AWS Access Key',
  },
];

/**
 * 检测内容是否包含敏感信息（纯函数）
 *
 * 遍历 SENSITIVE_PATTERNS，命中任一模式即返回敏感结果。
 * 纯函数无副作用，可独立测试。
 *
 * @param content 待检测内容
 * @returns 敏感检测结果
 */
export function isSensitive(content: string): SensitiveCheckResult {
  for (const { type, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(content)) {
      return { sensitive: true, type };
    }
  }
  return { sensitive: false };
}

/** 输入护栏检查结果 */
export interface GuardCheckResult {
  /** 是否被拦截 */
  blocked: boolean;
  /** 拦截原因（blocked=true 时有值） */
  reason?: string;
}

/** ClipboardHandler 构造选项 */
export interface ClipboardHandlerOptions {
  /** 事件发射器（通知 UI 层） */
  emit?: (event: ClipboardEventType, payload?: unknown) => void;
  /** 输入护栏检查函数（由 Agent 注入，可选） */
  inputGuard?: (content: string) => GuardCheckResult;
  /** 轮询间隔（毫秒），默认 2 * MS_PER_SECOND（2 秒） */
  pollIntervalMs?: number;
}

/**
 * 剪贴板处理器
 *
 * 通过依赖注入 clipboard 接口实现可测试性。
 * 生产环境传入 Electron 的 clipboard 模块，测试环境传入 mock。
 *
 * 三重保护流程：
 *   1. 被动检测：轮询检测剪贴板变化（不读取内容，仅比较哈希）
 *   2. 主动触发：用户点击"分析"后读取内容
 *   3. 敏感过滤：isSensitive() 检测，命中则静默忽略
 *   4. 输入护栏：inputGuard() 检查，拦截则通知 UI
 *   5. 用户确认：通过事件通知 UI 展示确认对话框
 */
export class ClipboardHandler {
  /** Electron clipboard 模块（依赖注入） */
  private readonly clipboard: Clipboard;
  /** 已解析的配置（pollIntervalMs 构造时已赋默认值，确保为 number） */
  private readonly options: Omit<ClipboardHandlerOptions, 'pollIntervalMs'> & { pollIntervalMs: number };
  /** 轮询定时器 */
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** 上次剪贴板内容的哈希（用于变化检测，不存储原文） */
  private lastHash: string = '';
  /** 是否正在轮询 */
  private polling = false;

  constructor(clipboard: Clipboard, options: ClipboardHandlerOptions = {}) {
    this.clipboard = clipboard;
    // 使用 ?? 确保默认值不会被 undefined 覆盖（展开运算符的陷阱：undefined 会覆盖前面的默认值）
    this.options = {
      ...options,
      pollIntervalMs: options.pollIntervalMs ?? 2 * MS_PER_SECOND,
    };
  }

  /**
   * 启动剪贴板变化检测
   *
   * 采用轮询模式（Electron clipboard 无 text-change 事件）。
   * 仅检测内容哈希变化，不存储原文，不读取内容直到用户触发分析。
   */
  startPolling(): void {
    if (this.polling) return;
    this.polling = true;

    // 初始化哈希（记录当前剪贴板状态，避免启动时立即触发变化事件）
    this.lastHash = this.computeHash();

    // 使用 safeSetInterval 替代原生 setInterval，便于统一追踪定时器生命周期
    this.pollTimer = safeSetInterval(() => {
      this.checkChange();
    }, this.options.pollIntervalMs);

    logger.info({ pollIntervalMs: this.options.pollIntervalMs }, '剪贴板变化检测已启动');
  }

  /**
   * 停止剪贴板变化检测
   *
   * 清理轮询定时器，避免内存泄漏。
   */
  stopPolling(): void {
    if (this.pollTimer) {
      // 使用 clearSafeInterval 清理定时器并从注册表中移除
      clearSafeInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.polling = false;
  }

  /**
   * 检查剪贴板是否变化（内部方法）
   *
   * 比较当前哈希与上次哈希，不同则触发 changed 事件。
   * 不读取内容，不存储原文。
   */
  private checkChange(): void {
    const currentHash = this.computeHash();
    if (currentHash !== this.lastHash) {
      this.lastHash = currentHash;
      // 仅通知"剪贴板有变化"，不传递内容
      this.options.emit?.('changed');
      logger.debug('剪贴板内容已变化');
    }
  }

  /**
   * 计算剪贴板内容的哈希（内部方法）
   *
   * QC-CLIP-02 澄清：Electron clipboard API 未提供"只检测变化不读取内容"的接口，
   * readText() 是获取剪贴板文本的唯一方式。此处的隐私保护体现在：
   *   1. 读取后立即哈希化（djb2 算法），不存储原文
   *   2. 哈希不可逆推内容
   *   3. 仅在轮询和主动分析时读取，不持续监听
   * 设计原则中"不读取内容"的实际语义是"不存储/不持久化原文"，而非"不调用 readText"。
   */
  private computeHash(): string {
    const text = this.clipboard.readText();
    // 简单字符串哈希（djb2 算法），足够检测变化
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash) + text.charCodeAt(i);
      hash = hash & 0xffffffff; // 转为 32 位整数
    }
    return hash.toString(16);
  }

  /**
   * 分析剪贴板内容（用户主动触发）
   *
   * 三重保护流程：
   *   1. 读取剪贴板内容
   *   2. 敏感内容检测 → 命中则静默忽略，返回 false
   *   3. 输入护栏检查 → 拦截则通知 UI，返回 false
   *   4. 通过则通知 UI 展示确认对话框，返回 true
   *
   * @returns 是否通过检测（true 表示已通知 UI 展示确认）
   */
  analyze(): boolean {
    const content = this.clipboard.readText();

    // 空内容不处理
    if (!content || content.trim().length === 0) {
      return false;
    }

    // 保护 3：敏感内容检测
    const sensitiveResult = isSensitive(content);
    if (sensitiveResult.sensitive) {
      // 静默忽略，不提示分析，不存储
      this.options.emit?.('sensitive-ignored', { type: sensitiveResult.type });
      logger.warn({ type: sensitiveResult.type }, '剪贴板检测到敏感内容，已静默忽略');
      return false;
    }

    // 保护 4：输入护栏检查（如配置）
    if (this.options.inputGuard) {
      const guardResult = this.options.inputGuard(content);
      if (guardResult.blocked) {
        this.options.emit?.('analysis-rejected', { reason: guardResult.reason });
        logger.warn({ reason: guardResult.reason }, '剪贴板内容被输入护栏拦截');
        return false;
      }
    }

    // 保护 5：通知 UI 展示确认对话框
    // 注意：此处传递内容给 UI，但 UI 需用户确认后才写入记忆
    this.options.emit?.('analysis-ready', { content });
    logger.info('剪贴板内容已通过检测，等待用户确认');
    return true;
  }

  /**
   * 获取当前轮询状态
   */
  isPolling(): boolean {
    return this.polling;
  }
}
