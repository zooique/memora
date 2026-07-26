/**
 * 错误文案字典 + 映射函数（跨进程共享，纯函数）
 *
 * 职责：
 *   将底层错误（IPC 异常 / 存储异常 / 归档失败 / 网络 / 通用 unknown）
 *   映射为用户可理解的中文文案，遵循"两段式为主，已知原因才三段式"原则
 *   （UX-13/14：原始 error.message 不应直传 Toast，需分类映射）。
 *
 * 设计原则：
 *   - 纯函数，无 Node/浏览器依赖，主进程 / 渲染进程 / Web 路由共用
 *   - 不引入 i18n 框架（过度工程），用 const 字典 + 映射函数即可
 *   - LLM 类错误（401/403/429 等）由 llmErrorClassifier 处理，本模块仅作 fallback
 *   - 原始 error.message 仅用于模式匹配，不直接拼接进 Toast（避免技术细节泄露）
 *
 * 提取原因（UX-13 根因治理）：
 *   原先 errorHelpers.createIpcErrorHandler / ipcListeners.handleArchiveFailed /
 *   sessionController 等 10+ 处直传 `error.message` 到 Toast，导致：
 *   1. 技术细节（SQL 错误、路径信息、堆栈片段）泄露给用户
 *   2. 文案风格不统一（"XXX失败：${error.message}" 与 "XXX失败，请重试" 并存）
 *   3. 同类错误不同位置描述不一致
 *
 * 架构位置：
 *   - 位于 shared/ 层（与 llmErrorClassifier / toError 同级），跨层共享
 *   - 与 llmErrorClassifier 并列：LLM 错误走 LLM 字典，其他错误走本字典
 */

// ─── 错误模式映射表 ────────────────────────────────────────

/**
 * 错误模式映射条目
 *
 * pattern：匹配原始错误消息的正则（大小写不敏感）
 * reason：用户可理解的原因描述（不含操作前缀，由 formatErrorMessage 拼接）
 */
interface ErrorMessagePattern {
  /** 匹配原始错误消息的正则（大小写不敏感） */
  pattern: RegExp;
  /** 用户可理解的原因描述（不含操作前缀） */
  reason: string;
}

/**
 * 已知错误模式列表（按匹配优先级排序）
 *
 * 排序原则：越具体的模式越靠前，避免被通用模式提前匹配。
 * 仅覆盖 IPC/存储/网络/权限类错误，LLM 类错误由 llmErrorClassifier 处理。
 */
const ERROR_PATTERNS: readonly ErrorMessagePattern[] = [
  // ─── 网络类（fetch 异常、DNS 失败、连接拒绝等，常因 baseUrl 错或断网） ───
  {
    pattern: /econnrefused|enotfound|ehostunreach|enetunreach/i,
    reason: '网络连接失败，请检查网络或 API 地址',
  },
  {
    pattern: /etimedout|timeout|timed out|请求超时/i,
    reason: '请求超时，请检查网络或稍后重试',
  },
  {
    pattern: /fetch failed|network error|网络错误|连接失败/i,
    reason: '网络连接失败，请检查网络后重试',
  },

  // ─── 文件系统 / 权限类 ───
  {
    pattern: /eacces|eperm|permission denied|权限不足/i,
    reason: '权限不足，请检查文件或目录权限',
  },
  {
    pattern: /enoent|no such file|文件不存在/i,
    reason: '文件不存在，可能已被移动或删除',
  },
  {
    pattern: /edquot|enospc|磁盘空间不足/i,
    reason: '磁盘空间不足，请清理后重试',
  },

  // ─── 存储 / 数据类 ───
  {
    pattern: /sqlite|database disk image is malformed|database is locked/i,
    reason: '数据读取失败，请重启应用',
  },
  {
    pattern: /json.*parse|unexpected token|syntaxerror/i,
    reason: '数据解析失败，请重启应用',
  },
  {
    pattern: /sqlitestorage|vacuum|constraint failed|unique constraint/i,
    reason: '数据写入失败，请稍后重试',
  },

  // ─── IPC / 服务可用性类 ───
  {
    pattern: /agent.*not.*ready|not initialized|未初始化|尚未就绪/i,
    reason: '精灵尚未就绪，请稍候片刻后重试',
  },
  {
    pattern: /rate limit|429|too many requests|频率限制/i,
    reason: '请求过于频繁，请稍后再试',
  },
  {
    pattern: /aborted|用户中断|手动停止/i,
    reason: '操作已取消',
  },
];

// ─── 归档失败专用映射（来自内核 archiveFailed 事件） ──────────────────

/**
 * 归档失败阶段类型（与内核 ArchiveFailedStage 对齐）
 */
type ArchiveFailedStage = 'profile' | 'insight' | 'content';

/**
 * 归档失败 stage → 用户可理解文案映射
 *
 * 来自内核 archiveCoordinator 三阶段（profile/insight/content），
 * 经 ipcListeners.handleArchiveFailed 路由到 Toast。
 */
const ARCHIVE_FAILED_MESSAGES: Readonly<Record<ArchiveFailedStage, string>> = {
  profile: '用户画像归档失败，记忆可能未保存——下次对话可重新沉淀',
  insight: '洞察提取归档失败，本次对话未沉淀——可在记忆面板中手动归档',
  content: '会话内容归档失败，对话记录可能丢失——请检查磁盘空间',
};

// ─── 公共函数 ─────────────────────────────────────────────

/**
 * 从 unknown 错误中提取 message 字符串（内部工具）
 *
 * 与 shared/toError 行为对齐，但不构造 Error 对象（仅取字符串），
 * 避免在纯字符串匹配场景下不必要的对象分配。
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const msg = (error as { message: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return String(error ?? '');
}

/**
 * 将错误映射为用户可理解的中文文案（两段式：操作 + 原因/建议）
 *
 * 匹配流程：
 *   1. 按 ERROR_PATTERNS 顺序匹配 error.message（具体模式优先）
 *   2. 命中则返回 `${operation}失败：${reason}`（三段式：操作 + 原因 + 建议）
 *   3. 全部未命中则返回 `${operation}失败，请稍后重试`（两段式：操作 + 建议）
 *
 * 设计权衡（UX-14 模板选择）：
 *   - 两段式为主：catch 块中 90% 场景"原因"是 unknown，强行三段式会写出
 *     "原因未知"废话。未知原因保持 "请稍后重试"，不编造原因
 *   - 已知原因才三段式：网络/权限/存储等明确分类后，三段式提供可操作建议
 *
 * @param operation 操作名（如 "切换会话"、"删除记忆"），不含"失败"后缀
 * @param error 原始错误对象（Error / string / unknown）
 * @returns 完整中文文案（如 "切换会话失败：网络连接失败，请检查网络后重试"）
 *
 * @example
 * formatErrorMessage('切换会话', new Error('fetch failed'))
 *   // '切换会话失败：网络连接失败，请检查网络后重试'
 * formatErrorMessage('删除记忆', new Error('未知内部错误'))
 *   // '删除记忆失败，请稍后重试'
 * formatErrorMessage('保存设置', 'ENOENT: no such file')
 *   // '保存设置失败：文件不存在，可能已被移动或删除'
 */
export function formatErrorMessage(operation: string, error: unknown): string {
  const rawMessage = extractErrorMessage(error);

  // 按优先级顺序匹配，首个命中的模式胜出
  for (const { pattern, reason } of ERROR_PATTERNS) {
    if (pattern.test(rawMessage)) {
      return `${operation}失败：${reason}`;
    }
  }

  // 未匹配任何已知模式，回退到两段式（不编造原因）
  return `${operation}失败，请稍后重试。如持续出现，请检查网络或重启应用`;
}

/**
 * 获取归档失败阶段的用户可理解文案
 *
 * 来自内核 archiveCoordinator 三阶段（profile/insight/content），
 * 经 ipcListeners.handleArchiveFailed 路由到 Toast。
 *
 * @param stage 归档阶段（profile / insight / content）
 * @returns 中文文案（如 "用户画像归档失败，记忆可能未保存"）
 *
 * @example
 * getArchiveFailedMessage('profile')  // '用户画像归档失败，记忆可能未保存'
 * getArchiveFailedMessage('insight')  // '洞察提取归档失败，本次对话未沉淀'
 */
export function getArchiveFailedMessage(stage: ArchiveFailedStage): string {
  return ARCHIVE_FAILED_MESSAGES[stage] ?? ARCHIVE_FAILED_MESSAGES.content;
}
