/**
 * 路径白名单 + 审计日志
 *
 * 4 类允许 + 6 类禁止
 * 详见 03-安全权限-v0.2.md §4 + ADR-006
 * 阶段二新增：M-101 写入二次确认 + M-105 审计日志
 */
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { logger } from '@/logging/logger.js';
import { securityError } from '@/utils/errors.js';

const BLOCKED_PATTERNS = [
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.env(\.|$)/i,
  /[\\/]system32([\\/]|$)/i,
  /[\\/]Windows[\\/]System/i,
  /[\\/]etc[\\/]passwd/i,
];

export type Permission = 'owner' | 'guest';
export type WriteDecision = 'confirmed' | 'declined' | 'auto-approved' | 'auto-denied';

export interface AuditEvent {
  /** 事件类型 */
  type: 'path-allow' | 'path-deny' | 'write-confirm' | 'write-decline' | 'write-auto';
  /** 涉及的绝对路径 */
  path: string;
  /** 工具名（read_file / write_file） */
  tool?: string;
  /** 用户决策（写入二次确认场景） */
  decision?: WriteDecision;
  /** 拒绝原因 */
  reason?: string;
  /** 时间戳（ISO 8601） */
  timestamp: string;
}

/**
 * 审计日志订阅器
 * 默认输出到 pino logger；可被业务层重定向到独立审计文件
 */
export type AuditListener = (event: AuditEvent) => void;

export class SecurityGuard {
  private readonly listeners: AuditListener[] = [];
  /** 审计事件缓冲（最近 N 条，供调试与回溯） */
  private readonly auditBuffer: AuditEvent[] = [];
  private readonly bufferLimit = 100;

  constructor(
    private readonly projectPath: string,
    private readonly dataDir: string,
    private readonly extraAllowedPaths: string[] = [],
    /** owner 是否启用写入二次确认；guest 强制开启 */
    public readonly confirmWrites: boolean = false,
    /** 权限模式 */
    public readonly permission: Permission = 'owner',
  ) {}

  /**
   * 订阅审计事件
   * @returns 取消订阅函数
   */
  onAudit(listener: AuditListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /**
   * 获取最近的审计事件（深拷贝，外部不可修改内部缓冲）
   */
  getRecentAudits(limit = 10): AuditEvent[] {
    return this.auditBuffer.slice(-limit).map((e) => ({ ...e }));
  }

  /**
   * 断言路径允许访问
   * @throws Error 不在白名单时
   */
  assertPathAllowed(absolutePath: string, tool?: string): void {
    const resolved = resolve(absolutePath);

    // 1. 黑名单优先
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(resolved)) {
        this.emitAudit({
          type: 'path-deny',
          path: resolved,
          tool,
          reason: `命中黑名单规则 (${pattern})`,
          timestamp: new Date().toISOString(),
        });
        throw securityError(
          '禁止访问：路径命中黑名单',
          `路径 ${resolved} 命中黑名单规则 (${pattern})`,
          ['检查路径是否正确', '如需访问该路径，请联系管理员添加白名单'],
        );
      }
    }

    // 2. 白名单：项目目录
    if (resolved.startsWith(resolve(this.projectPath))) {
      this.emitAudit({
        type: 'path-allow',
        path: resolved,
        tool,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // 3. 白名单：数据目录
    const memoraDir = resolve(this.dataDir.replace(/^~/, homedir()));
    if (resolved.startsWith(memoraDir)) {
      this.emitAudit({
        type: 'path-allow',
        path: resolved,
        tool,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // 4. 白名单：用户显式声明
    for (const allowed of this.extraAllowedPaths) {
      if (resolved.startsWith(resolve(allowed))) {
        this.emitAudit({
          type: 'path-allow',
          path: resolved,
          tool,
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    this.emitAudit({
      type: 'path-deny',
      path: resolved,
      tool,
      reason: '路径越界，不在白名单内',
      timestamp: new Date().toISOString(),
    });
    throw securityError('路径越界', `${resolved} 不在白名单内`, [
      '检查路径是否在项目目录内',
      '在配置文件中添加该路径到 allowedPaths',
    ]);
  }

  /**
   * 写入操作前请求用户确认（M-101）
   *
   * 规则：
   *   - guest 模式：始终要求确认
   *   - owner + confirmWrites=true：要求确认
   *   - owner + confirmWrites=false：自动批准
   *
   * @returns true 确认通过；false 用户拒绝
   */
  async requestWriteConfirmation(
    targetPath: string,
    tool: string,
    description?: string,
  ): Promise<boolean> {
    const needConfirm = this.permission === 'guest' || this.confirmWrites;

    if (!needConfirm) {
      this.emitAudit({
        type: 'write-auto',
        path: targetPath,
        tool,
        decision: 'auto-approved',
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    // 交互式确认
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const lines = [
        `\n🔒 写入二次确认 [${this.permission}]`,
        `   工具: ${tool}`,
        `   路径: ${targetPath}`,
        ...(description ? [`   说明: ${description}`] : []),
        `   确认写入？(y/N) `,
      ];
      const answer = (await rl.question(lines.join('\n'))).trim().toLowerCase();

      if (answer === 'y' || answer === 'yes') {
        this.emitAudit({
          type: 'write-confirm',
          path: targetPath,
          tool,
          decision: 'confirmed',
          timestamp: new Date().toISOString(),
        });
        return true;
      }

      this.emitAudit({
        type: 'write-decline',
        path: targetPath,
        tool,
        decision: 'declined',
        timestamp: new Date().toISOString(),
      });
      return false;
    } finally {
      rl.close();
    }
  }

  /**
   * 触发审计事件 + 写入日志 + 通知订阅者
   */
  private emitAudit(event: AuditEvent): void {
    // 缓冲
    this.auditBuffer.push(event);
    if (this.auditBuffer.length > this.bufferLimit) {
      this.auditBuffer.shift();
    }

    // 写到 pino（结构化日志，方便后续检索）
    if (event.type === 'path-deny' || event.type === 'write-decline') {
      logger.warn({ audit: event }, '安全审计：拒绝');
    } else {
      logger.info({ audit: event }, '安全审计：通过');
    }

    // 通知订阅者（业务层可重定向到独立审计文件）
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.error({ err }, '审计订阅者执行失败');
      }
    }
  }
}
