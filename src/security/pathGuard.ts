/**
 * 路径白名单 + 审计日志
 *
 * 4 类允许 + 12 类禁止
 * 详见 ADR-006 · 安全模型
 * 阶段二新增：M-101 写入二次确认 + M-105 审计日志
 */
import { resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { logger } from '@/logging/logger.js';
import { securityError, toError } from '@/utils/errors.js';
import { expandHome } from '@/utils/path.js';

const BLOCKED_PATTERNS = [
  // 系统凭证
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])\.pgpass$/i,
  /[\\/]etc[\\/]passwd/i,
  // 云服务凭证
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.azure([\\/]|$)/i,
  /(^|[\\/])\.docker([\\/]|$)/i,
  /(^|[\\/])\.kube([\\/]|$)/i,
  /[\\/]gcloud([\\/]|$)/i,
  // 仅拦截纯 `.env`、`.env.<name>`（name 不含 .）。
  /(^|[\\/])\.env$|(^|[\\/])\.env\.[^\\/.]+$/i,
  // 系统目录
  /[\\/]system32([\\/]|$)/i,
  /[\\/]Windows[\\/]System/i,
];

export type Permission = 'owner' | 'guest';
export type WriteDecision = 'confirmed' | 'declined' | 'auto-approved' | 'auto-denied';

export interface AuditEvent {
  /** 事件类型 */
  type: 'path-allow' | 'path-deny' | 'write-confirm' | 'write-decline' | 'write-auto';
  /** 涉及的绝对路径 */
  path: string;
  /** 工具名（read_file / write_file / 自定义工具名） */
  tool?: string;
  /** S-02: 调用链来源（builtin / custom / system），标记安全检查的触发方 */
  source?: 'builtin' | 'custom' | 'system';
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

/**
 * 写入确认请求
 *
 * 宿主程序在非交互式环境（WebUI/桌宠/无终端服务）需要自定义确认 UI。
 * 注入此回调后，SecurityGuard.requestWriteConfirmation() 会调用它而不是直接读 stdin。
 *
 * 返回 true 确认写入，false 拒绝写入。
 * 抛错视为拒绝（fail-closed，安全优先）。
 */
export type WriteConfirmationRequest = (info: WriteConfirmationInfo) => Promise<boolean>;

/** 写入确认请求的载荷 */
export interface WriteConfirmationInfo {
  /** 目标文件绝对路径 */
  targetPath: string;
  /** 工具名（如 write_file） */
  tool: string;
  /** 人类可读的描述（"写入 100 字符到 foo.md"） */
  description?: string;
  /** 权限模式（owner / guest） */
  permission: Permission;
  /** 是否需要确认（owner + confirmWrites=false 时为 false，宿主可跳过弹窗） */
  needsConfirm: boolean;
}

export class SecurityGuard {
  private readonly listeners: AuditListener[] = [];
  /** 审计事件缓冲（最近 N 条，供调试与回溯） */
  private readonly auditBuffer: AuditEvent[] = [];
  private readonly bufferLimit = 100;
  /**
   * 注入式写入确认回调。
   * 宿主注册后，requestWriteConfirmation() 走自定义 UI；
   * 不注册时回退到终端 readline（CLI 场景）。
   */
  private confirmationHandler: WriteConfirmationRequest | null = null;

  /** 允许访问的根目录列表（白名单） */
  private readonly allowedRoots: string[];

  constructor(
    projectPath: string,
    memoraDir: string,
    extraAllowedPaths: string[] = [],
    /** owner 是否启用写入二次确认；guest 强制开启 */
    public readonly confirmWrites: boolean = false,
    /** 权限模式 */
    public readonly permission: Permission = 'owner',
    /** Agent 级配置目录（personas/rules/skills 所在目录） */
    configDir?: string,
    /** Agent 级数据目录（memora.db/vectors 所在目录） */
    agentDataDir?: string,
  ) {
    // 构建白名单根目录列表
    this.allowedRoots = [
      resolve(projectPath),
      resolve(expandHome(memoraDir)),
    ];
    if (configDir) {
      this.allowedRoots.push(resolve(expandHome(configDir)));
    }
    if (agentDataDir) {
      this.allowedRoots.push(resolve(expandHome(agentDataDir)));
    }
    for (const p of extraAllowedPaths) {
      this.allowedRoots.push(resolve(expandHome(p)));
    }
  }

  /**
   * 注册自定义写入确认回调（宿主程序接入）
   *
   * 适用于 WebUI/桌宠/无终端服务。注册后，requestWriteConfirmation()
   * 不再直接读 stdin，而是回调此函数让宿主决定如何提示用户。
   *
   * 取消注册：传入 null。
   *
   * @example
   *   securityGuard.onWriteConfirmation(async (info) => {
   *     return await showConfirmDialog(info.targetPath, info.description);
   *   });
   */
  onWriteConfirmation(handler: WriteConfirmationRequest | null): void {
    this.confirmationHandler = handler;
  }

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
   * @param source S-02: 调用链来源标记
   */
  assertPathAllowed(absolutePath: string, tool?: string, source?: 'builtin' | 'custom' | 'system'): void {
    // SEC-05: NFKC 规范化，防止全角字符（如 ．．/）绕过黑名单正则
    const normalized = absolutePath.normalize('NFKC');
    const resolved = resolve(normalized);

    // 1. 黑名单优先
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(resolved)) {
        this.emitAudit({
          type: 'path-deny',
          path: resolved,
          tool,
          source,
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

    // 2. 白名单：遍历所有允许的根目录（严格前缀匹配，追加 sep 防止兄弟目录绕过）
    for (const allowedRoot of this.allowedRoots) {
      if (resolved === allowedRoot || resolved.startsWith(allowedRoot + sep)) {
        this.emitAudit({
          type: 'path-allow',
          path: resolved,
          tool,
          source,
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    this.emitAudit({
      type: 'path-deny',
      path: resolved,
      tool,
      source,
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
   * 优先走 confirmationHandler 注入式回调（宿主程序），
   * 未注册时回退到 readline + stdin（CLI 场景）。
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

    const info: WriteConfirmationInfo = {
      targetPath,
      tool,
      description,
      permission: this.permission,
      needsConfirm: needConfirm,
    };

    if (this.confirmationHandler) {
      try {
        const ok = await this.confirmationHandler(info);
        this.emitAudit({
          type: ok ? 'write-confirm' : 'write-decline',
          path: targetPath,
          tool,
          decision: ok ? 'confirmed' : 'declined',
          timestamp: new Date().toISOString(),
        });
        return ok;
      } catch (err) {
        // 抛错视为拒绝（fail-closed 安全优先）
        logger.warn({ err, targetPath }, '写入确认回调异常，视为拒绝');
        this.emitAudit({
          type: 'write-decline',
          path: targetPath,
          tool,
          decision: 'declined',
          reason: `回调异常：${toError(err).message}`,
          timestamp: new Date().toISOString(),
        });
        return false;
      }
    }

    // 回退：CLI 场景直接走终端 readline
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
