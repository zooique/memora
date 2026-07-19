/**
 * 宿主上下文共享类型
 *
 * 定义 Electron 模式与 Web 模式共用的核心依赖容器。
 * Electron 模式的 IpcContext 包含额外的窗口/托盘/快捷键等原生能力，
 * Web 模式仅注入此处的核心字段，两者复用同一套 sprite/storage/agent 核心层。
 *
 * 设计原则：
 *   - 核心字段 = 业务逻辑必需（对话/记忆/会话/配置/角色）
 *   - 原生字段 = Electron 专属（窗口/托盘/剪贴板/快捷键），Web 模式不注入
 *   - Web 模式的 HTTP 路由消费 HostContext，与 IPC handler 平行而非复用
 *
 * 架构约束（STEP9-IMPORTS-03）：
 *   - 本文件对 `../sprite/` 和 `../storage/` 的引用必须保持 `import type`，
 *     禁止改为 value import——否则 shared/ 层将在运行时反向依赖 sprite/storage，
 *     破坏 "shared 是被依赖层" 的分层原则（ADR-008 目录结构）。
 *   - 当前 type-only 引用在编译期擦除，运行时 shared/ 仍只被各层单向引用，无循环风险。
 *   - 设计妥协理由：Electron 和 Web 模式复用同一 HostContext 类型，避免双份定义；
 *     替代方案（移到 sprite/ 层）会让 electron/ 和 web/ 都需多跨一层，代价更高。
 */

import type { Agent } from 'memora';
import type { Sprite } from '../sprite/sprite.js';
import type { SqliteSessionStore } from '../storage/sessionStore.js';
import type { AuditManager } from '../sprite/audit/auditManager.js';
import type { SkillInstallResult } from '../sprite/skillInstaller.js';

/**
 * 宿主上下文（核心依赖容器）
 *
 * Electron 模式和 Web 模式都构造此上下文，注入到各自的传输层
 * （IPC handler / HTTP 路由）。核心层（sprite/storage/agent）对宿主模式无感知。
 *
 * 自然生长原则：auditManager 和 installSkill 为可选字段，
 * 仅在 Web 调试通道需要时由 server.ts 注入。
 */
export interface HostContext {
  /** Agent 实例（对话 + 记忆引擎） */
  agent: Agent;
  /** Sprite 实例（精灵控制 + 配置 + 角色） */
  sprite: Sprite;
  /** 会话存储（历史消息加载） */
  sessionStore: SqliteSessionStore;
  /** 获取当前对话的 AbortController（用于中断流式输出） */
  getAbortController: () => AbortController | null;
  /** 设置当前对话的 AbortController */
  setAbortController: (ctrl: AbortController | null) => void;
  /**
   * Agent 是否就绪
   *
   * 配置缺失或 reinitAgent 失败后为 false，拒绝新对话请求。
   */
  isAgentReady: () => boolean;
  /**
   * 审计日志管理器（可选，Web 调试通道使用）
   *
   * 提供审计日志的读取和清理能力，与 Electron IPC 的 AUDIT_LOG_LIST / AUDIT_LOG_CLEAR 平行。
   */
  auditManager?: AuditManager | null;
  /**
   * 技能安装回调（可选，Web 调试通道使用）
   *
   * 接收技能文件内容和文件名，安装到 configDir/skills/。
   * 与 Electron IPC 的 SKILL_INSTALL 平行。
   */
  installSkill?: (content: string, fileName: string, configDir: string) => Promise<SkillInstallResult>;
}
