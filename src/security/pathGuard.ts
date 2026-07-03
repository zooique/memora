/**
 * 路径白名单 + 审计日志
 *
 * 4 类允许根 + 27 类禁止规则
 * 详见 ADR-006 · 安全模型
 * 阶段二新增：M-101 写入二次确认 + M-105 审计日志
 * SEC-06（自动安全）：补全 Windows/Linux 系统目录 + 包管理器凭证 + 符号链接逃逸防护
 */
import { resolve, sep, dirname, basename, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { logger } from '@/logging/logger.js';
import { securityError, toError } from '@/utils/errors.js';
import { expandHome } from '@/utils/path.js';
import { nowIso } from '@/utils/time.js';

/**
 * 解析路径的真实绝对路径（解析符号链接链）
 *
 * 安全考量：若不解析符号链接，攻击者可在项目内放置指向 /etc 的符号链接，
 * 绕过白名单前缀匹配访问任意系统目录（P0 符号链接逃逸漏洞）。
 *
 * 策略：
 * - 路径存在时：realpathSync 解析完整符号链接链
 * - 路径不存在时（写入新文件场景）：逐级向上查找已存在的父目录并 realpath，再拼接不存在部分
 * - 全程不存在时：回退到 resolve()（白名单/黑名单仍会兜底校验）
 *
 * @param p 任意路径（相对或绝对）
 * @returns 解析符号链接后的真实绝对路径
 */
function resolveRealpath(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    // 路径不存在 - 递归解析已存在的父目录
    const parent = dirname(resolved);
    const base = basename(resolved);
    try {
      const realParent = realpathSync(parent);
      return join(realParent, base);
    } catch {
      // 父目录也不存在 - 继续向上递归
      const realGrandParent = resolveRealpath(parent);
      return join(realGrandParent, base);
    }
  }
}

const BLOCKED_PATTERNS = [
  // ─── 系统凭证文件（跨平台，路径段匹配）───
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])\.pgpass$/i,
  // ─── 包管理器凭证（SEC-06 补全）───
  /(^|[\\/])\.gitconfig$/i, // Git 配置（可能含 credential helper token）
  /(^|[\\/])\.git-credentials$/i, // Git credential store 明文存储
  /(^|[\\/])\.npmrc$/i, // npm authToken
  /(^|[\\/])\.pypirc$/i, // PyPI 上传凭证
  /(^|[\\/])\.gem[\\/]credentials$/i, // RubyGems push 凭证
  /(^|[\\/])\.composer[\\/]auth\.json$/i, // Composer 凭证
  /(^|[\\/])\.htpasswd$/i, // Apache Basic Auth 凭证
  // ─── Linux/macOS 特定凭证文件（向后兼容保留）───
  /[\\/]etc[\\/]passwd/i, // 用户密码哈希
  /[\\/]etc[\\/]shadow/i,
  /[\\/]etc[\\/]gshadow/i, // 组密码哈希
  /[\\/]etc[\\/]sudoers/i, // sudo 配置
  // ─── 云服务凭证 ───
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.azure([\\/]|$)/i,
  /(^|[\\/])\.docker([\\/]|$)/i,
  /(^|[\\/])\.kube([\\/]|$)/i,
  /(^|[\\/])\.config[\\/]gcloud([\\/]|$)/i, // gcloud 配置（SEC-06 修正：加 .config 前缀边界，避免误拦用户 gcloud-tools 目录）
  // ─── 环境变量文件（.env / .env.local / .env.production.local 等多段后缀）───
  /(^|[\\/])\.env(\.[^\\/]+)?$/i,
  // ─── Windows 系统目录（SEC-06 补全：从仅 system32 扩展到完整系统目录）───
  /[\\/]Windows([\\/]|$)/i, // C:\Windows（含 System、System32 等子目录）
  /[\\/]Program Files([\\/]|$)/i, // C:\Program Files
  /[\\/]Program Files \(x86\)([\\/]|$)/i, // C:\Program Files (x86)
  /[\\/]ProgramData([\\/]|$)/i, // C:\ProgramData（系统级应用数据）
  // ─── Linux/macOS 系统目录（根目录锚定 ^/，避免误伤项目内同名目录）───
  /^\/(etc|usr|bin|sbin|var|root|home|lib|lib64|opt)([\\/]|$)/i,
  // ─── Linux/macOS 虚拟文件系统 + 启动目录（根目录锚定）───
  /^\/(proc|sys|boot)([\\/]|$)/i,
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
  /** 文件当前内容预览（截断到 10KB，null 表示新文件）—— 供宿主 UI 展示 diff */
  beforeContent?: string | null;
  /** 写入后内容预览（截断到 10KB）—— 供宿主 UI 展示 diff */
  afterContent?: string;
}

/** diff 内容最大长度（10KB），防止大文件内容撑爆 IPC 传输和 UI 渲染 */
const MAX_DIFF_CONTENT_LENGTH = 10240;

/**
 * 截断 diff 内容到 MAX_DIFF_CONTENT_LENGTH，超出时追加截断标记
 *
 * 重载签名确保返回类型与输入类型的 null/undefined 语义一致：
 * - beforeContent（string | null）→ 返回 string | null
 * - afterContent（string | undefined）→ 返回 string | undefined
 */
function truncateForDiff(content: string | null): string | null;
function truncateForDiff(content: string | undefined): string | undefined;
function truncateForDiff(content: string | null | undefined): string | null | undefined;
function truncateForDiff(content: string | null | undefined): string | null | undefined {
  if (content === null || content === undefined) return content;
  if (content.length <= MAX_DIFF_CONTENT_LENGTH) return content;
  // 超过上限时截断并追加标记，让用户知道内容被裁剪
  return content.slice(0, MAX_DIFF_CONTENT_LENGTH) + `\n...（已截断，共 ${content.length} 字符）`;
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
    // 构建白名单根目录列表（SEC-06：使用 resolveRealpath 解析符号链接，
    // 确保白名单基准是真实路径，与 assertPathAllowed 中的 resolveRealpath 对齐）
    this.allowedRoots = [
      resolveRealpath(expandHome(projectPath)),
      resolveRealpath(expandHome(memoraDir)),
    ];
    if (configDir) {
      this.allowedRoots.push(resolveRealpath(expandHome(configDir)));
    }
    if (agentDataDir) {
      this.allowedRoots.push(resolveRealpath(expandHome(agentDataDir)));
    }
    for (const p of extraAllowedPaths) {
      this.allowedRoots.push(resolveRealpath(expandHome(p)));
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
    // SEC-06: resolveRealpath 解析符号链接，防止通过项目内符号链接逃逸到系统目录
    const resolved = resolveRealpath(normalized);

    // 1. 黑名单优先
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(resolved)) {
        this.emitAudit({
          type: 'path-deny',
          path: resolved,
          tool,
          source,
          reason: `命中黑名单规则 (${pattern})`,
          timestamp: nowIso(),
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
          timestamp: nowIso(),
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
      timestamp: nowIso(),
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
    /** diff 内容选项（供宿主 UI 展示变更预览，自动截断到 10KB） */
    options?: { beforeContent?: string | null; afterContent?: string },
  ): Promise<boolean> {
    const needConfirm = this.permission === 'guest' || this.confirmWrites;

    if (!needConfirm) {
      this.emitAudit({
        type: 'write-auto',
        path: targetPath,
        tool,
        decision: 'auto-approved',
        timestamp: nowIso(),
      });
      return true;
    }

    const info: WriteConfirmationInfo = {
      targetPath,
      tool,
      description,
      permission: this.permission,
      needsConfirm: needConfirm,
      // 透传 diff 内容（截断后），供宿主 UI 展示变更预览
      beforeContent: truncateForDiff(options?.beforeContent),
      afterContent: truncateForDiff(options?.afterContent),
    };

    if (this.confirmationHandler) {
      try {
        const ok = await this.confirmationHandler(info);
        this.emitAudit({
          type: ok ? 'write-confirm' : 'write-decline',
          path: targetPath,
          tool,
          decision: ok ? 'confirmed' : 'declined',
          timestamp: nowIso(),
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
          timestamp: nowIso(),
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
          timestamp: nowIso(),
        });
        return true;
      }

      this.emitAudit({
        type: 'write-decline',
        path: targetPath,
        tool,
        decision: 'declined',
        timestamp: nowIso(),
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
