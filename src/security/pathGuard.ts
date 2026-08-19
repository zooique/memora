/**
 * 路径白名单 + 审计日志
 * 4 类允许根 + 28 类禁止规则。
 * 写入需二次确认 + 审计日志：未注入 confirmationHandler 时 fail-closed 拒绝写入。
 * 内核纯逻辑库不依赖交互式终端 I/O，宿主应通过 onWriteConfirmation() 注入自己的确认 UI。
 */
import { resolve, sep, dirname, basename, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { logger } from '@/logging/logger.js';
import { securityError, toError } from '@/utils/errors.js';
import { expandHome } from '@/utils/path.js';
import { nowIso } from '@/utils/time.js';

/**
 * 解析符号链接后的真实绝对路径。
 * 安全考量：不解析符号链接时，攻击者可用项目内指向 /etc 的符号链接绕过白名单前缀匹配访问任意系统目录（路径穿越逃逸）。
 * 不存在时（写新文件）逐级向上解析已存在父目录再拼接；全程不存在时回退 resolve()（白名单/黑名单仍兜底校验）。
 */
function resolveRealpath(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    // 路径不存在：递归解析已存在的父目录
    const parent = dirname(resolved);
    const base = basename(resolved);
    try {
      const realParent = realpathSync(parent);
      return join(realParent, base);
    } catch {
      // 父目录也不存在：继续向上递归
      const realGrandParent = resolveRealpath(parent);
      return join(realGrandParent, base);
    }
  }
}

const BLOCKED_PATTERNS = [
  // 系统凭证文件（跨平台，路径段匹配）
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])\.pgpass$/i,
  // 包管理器凭证：多为明文存储，可含推发令牌
  /(^|[\\/])\.gitconfig$/i,
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.pypirc$/i,
  /(^|[\\/])\.gem[\\/]credentials$/i,
  /(^|[\\/])\.composer[\\/]auth\.json$/i,
  /(^|[\\/])\.htpasswd$/i,
  // Linux/macOS 系统账户文件
  /[\\/]etc[\\/]passwd/i,
  /[\\/]etc[\\/]shadow/i,
  /[\\/]etc[\\/]gshadow/i,
  /[\\/]etc[\\/]sudoers/i,
  // 云服务与容器凭证
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.azure([\\/]|$)/i,
  /(^|[\\/])\.docker([\\/]|$)/i,
  /(^|[\\/])\.kube([\\/]|$)/i,
  /(^|[\\/])\.config[\\/]gcloud([\\/]|$)/i,
  // 环境变量文件（.env / .env.local / .env.production.local 等多段后缀；.envrc 独立于 .env.* 后缀模式）
  /(^|[\\/])\.env(\.[^\\/]+)?$/i,
  /(^|[\\/])\.envrc$/i,
  // Windows 系统目录
  /[\\/]Windows([\\/]|$)/i,
  /[\\/]Program Files([\\/]|$)/i,
  /[\\/]Program Files \(x86\)([\\/]|$)/i,
  /[\\/]ProgramData([\\/]|$)/i,
  // Linux/macOS 系统目录（根目录锚定 ^/，避免误伤项目内同名目录）
  /^\/(etc|usr|bin|sbin|var|root|home|lib|lib64|opt)([\\/]|$)/i,
  // 虚拟文件系统 + 启动目录（根目录锚定）
  /^\/(proc|sys|boot)([\\/]|$)/i,
];

export type Permission = 'owner' | 'guest';
export type WriteDecision = 'confirmed' | 'declined' | 'auto-approved' | 'auto-denied';

export interface AuditEvent {
  /** 事件类型：路径允许/拒绝、写入确认/拒绝/自动 */
  type: 'path-allow' | 'path-deny' | 'write-confirm' | 'write-decline' | 'write-auto';
  /** 涉及的绝对路径 */
  path: string;
  /** 工具名（read_file / write_file / 自定义工具名） */
  tool?: string;
  /** 调用链来源，标记安全检查的触发方 */
  source?: 'builtin' | 'custom' | 'system';
  /** 用户决策（写入二次确认场景） */
  decision?: WriteDecision;
  /** 拒绝原因 */
  reason?: string;
  /** 时间戳（ISO 8601） */
  timestamp: string;
}

/** 审计日志订阅器：默认输出到 pino logger，可被业务层重定向到独立审计文件 */
export type AuditListener = (event: AuditEvent) => void;

/**
 * 写入确认请求：宿主在非交互式环境（WebUI/桌宠/无终端）注入自定义确认 UI，
 * 走此回调而非直接读 stdin。返回 true 确认 / false 拒绝；抛错视为拒绝（fail-closed）。
 */
export type WriteConfirmationRequest = (info: WriteConfirmationInfo) => Promise<boolean>;

/** 写入确认请求的载荷 */
export interface WriteConfirmationInfo {
  /** 目标文件绝对路径 */
  targetPath: string;
  /** 工具名（如 write_file） */
  tool: string;
  /** 人类可读描述（"写入 100 字符到 foo.md"） */
  description?: string;
  /** 权限模式（owner / guest） */
  permission: Permission;
  /** 是否需确认（owner+confirmWrites=false 时为 false，宿主可跳过弹窗） */
  needsConfirm: boolean;
  /** 文件当前内容预览（截断到 10KB，null 表示新文件）——供宿主 UI 展示 diff */
  beforeContent?: string | null;
  /** 写入后内容预览（截断到 10KB）——供宿主 UI 展示 diff */
  afterContent?: string;
}

/** diff 内容最大长度（10KB），防大文件撑爆 IPC 传输和 UI 渲染 */
const MAX_DIFF_CONTENT_LENGTH = 10240;

/** 截断 diff 内容到长度上限并追加标记；重载签名保持 beforeContent(null)/afterContent(undefined) 语义一致 */
function truncateForDiff(content: string | null): string | null;
function truncateForDiff(content: string | undefined): string | undefined;
function truncateForDiff(content: string | null | undefined): string | null | undefined;
function truncateForDiff(content: string | null | undefined): string | null | undefined {
  if (content === null || content === undefined) return content;
  if (content.length <= MAX_DIFF_CONTENT_LENGTH) return content;
  // 超限截断并追加标记，让用户知道内容被裁剪
  return content.slice(0, MAX_DIFF_CONTENT_LENGTH) + `\n...（已截断，共 ${content.length} 字符）`;
}

export class SecurityGuard {
  private readonly listeners: AuditListener[] = [];
  /** 审计事件缓冲（最近 N 条，供调试与回溯） */
  private readonly auditBuffer: AuditEvent[] = [];
  private readonly bufferLimit = 100;
  /**
   * 注入式写入确认回调：宿主注册后走自定义 UI；不注册时回退到终端 readline（CLI 场景）。
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
    // 白名单基准用真实路径（resolveRealpath），与 assertPathAllowed 对齐，避免前缀匹配错位
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

  /** 注册自定义写入确认回调（宿主接入）；取消注册传入 null。WebUI/桌宠等无终端场景走此回调而非读 stdin */
  onWriteConfirmation(handler: WriteConfirmationRequest | null): void {
    this.confirmationHandler = handler;
  }

  /** 订阅审计事件；@returns 取消订阅函数 */
  onAudit(listener: AuditListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** 获取最近审计事件（深拷贝，外部不可修改内部缓冲） */
  getRecentAudits(limit = 10): AuditEvent[] {
    return this.auditBuffer.slice(-limit).map((e) => ({ ...e }));
  }

  /**
   * 断言路径允许访问（命中即拒绝）；黑名单优先，其次白名单前缀匹配（追加 sep 防兄弟目录绕过）。
   * @throws 不在白名单时
   */
  assertPathAllowed(absolutePath: string, tool?: string, source?: 'builtin' | 'custom' | 'system'): void {
    // NFKC 规范化，防全角字符（如 ．．/）绕过黑名单正则
    const normalized = absolutePath.normalize('NFKC');
    // 解析符号链接，防项目内符号链接逃逸到系统目录
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

    // 2. 白名单：严格前缀匹配（追加 sep 防兄弟目录绕过）
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
   * 写入前请求用户确认。guest 或 confirmWrites 需确认；未注入 confirmationHandler 时 fail-closed 拒绝（返回 false），
   * 理由：内核纯逻辑库不依赖交互式终端 I/O，宿主负责确认 UI；安全优先：未配置 = 拒绝。
   */
  async requestWriteConfirmation(
    targetPath: string,
    tool: string,
    description?: string,
    /** diff 内容选项（宿主 UI 变更预览用，自动截断到 10KB） */
    options?: { beforeContent?: string | null; afterContent?: string },
  ): Promise<boolean> {
    const needConfirm = this.permission === 'guest' || this.confirmWrites;

    // 无需确认：直接放行并记录审计
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

    // 构建确认信息（透传 diff 内容，供宿主 UI 展示变更预览）
    const info: WriteConfirmationInfo = {
      targetPath,
      tool,
      description,
      permission: this.permission,
      needsConfirm: needConfirm,
      beforeContent: truncateForDiff(options?.beforeContent),
      afterContent: truncateForDiff(options?.afterContent),
    };

    // 未注入 confirmationHandler 时 fail-closed 拒绝
    if (!this.confirmationHandler) {
      logger.warn(
        { targetPath, tool, permission: this.permission },
        '写入确认失败：未注入 confirmationHandler，fail-closed 拒绝写入',
      );
      this.emitAudit({
        type: 'write-decline',
        path: targetPath,
        tool,
        decision: 'declined',
        reason: '未注入 confirmationHandler（fail-closed）',
        timestamp: nowIso(),
      });
      return false;
    }

    // 走宿主注入的 confirmationHandler（此处 handler 必非空，上方已 fail-closed 拦截）
    return this.confirmViaHandler(info, targetPath, tool);
  }

  /**
   * 通过宿主注入的 confirmationHandler 执行写入确认（唯一确认执行路径）。
   * 抛错视为拒绝（fail-closed 安全优先）。
   */
  private async confirmViaHandler(
    info: WriteConfirmationInfo,
    targetPath: string,
    tool: string,
  ): Promise<boolean> {
    try {
      const ok = await this.confirmationHandler!(info);
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

  /** 触发审计事件：缓冲 + 写日志 + 通知订阅者 */
  private emitAudit(event: AuditEvent): void {
    this.auditBuffer.push(event);
    if (this.auditBuffer.length > this.bufferLimit) {
      this.auditBuffer.shift();
    }

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
