/**
 * 跨进程输入验证工具（纯函数，无 Node 依赖）
 *
 * 职责：为 IPC 处理器和 Web HTTP 路由提供统一的输入校验，
 * 防止路径遍历、注入等安全风险。
 *
 * 设计原则：白名单优先，拒绝一切含路径分隔符或特殊字符的输入。
 *
 * 架构位置：
 *   - 本模块位于 shared/ 层，是输入校验的真理源（纯函数，无 Node 依赖）
 *   - electron/ipc/inputValidation.ts 重新导出本模块，并额外实现 isPathAllowed（依赖 node:path）
 *   - web/routes/* 直接从本模块导入（避免重复定义导致行为不一致）
 *
 * 安全约束：Web 层和 IPC 层必须共用本模块的白名单实现，行为完全一致，
 * 否则宽松层会成为路径遍历绕过的入口。
 *
 * 注意：isPathAllowed 因依赖 node:path，已迁移到 electron/ipc/inputValidation.ts，
 * 不在本模块中实现（保持 shared/ 无 Node 依赖的架构约束）。
 */

/** 会话名/配置名白名单：仅允许字母、数字、连字符、下划线 */
const NAME_PATTERN = /^[\w-]+$/;

/** 内容长度上限：10MB 文本，防止内存耗尽攻击 */
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;

/** ID 长度上限：500 字符，覆盖所有 source:xxx 格式的记忆 ID */
const MAX_ID_LENGTH = 500;

/** 搜索关键词长度上限：1000 字符，防止超长查询导致性能问题 */
const MAX_SEARCH_QUERY_LENGTH = 1000;

/**
 * 验证会话名 — 拒绝路径分隔符和特殊字符
 *
 * @param name 待验证的会话名
 * @returns 验证通过返回 true，否则 false
 */
export function isValidSessionName(name: string): boolean {
  if (!name || typeof name !== 'string' || name.length === 0 || name.length > 200) {
    return false;
  }
  return NAME_PATTERN.test(name);
}

/**
 * 验证配置文件名（规则/角色/技能名）— 拒绝路径分隔符
 *
 * 配置名用于构造文件路径（如 .memora/rules/{name}.md），
 * 必须严格限制为安全字符，防止路径遍历写入。
 *
 * @param name 待验证的配置名
 * @returns 验证通过返回 true，否则 false
 */
export function isValidConfigName(name: string): boolean {
  if (!name || typeof name !== 'string' || name.length === 0 || name.length > 200) {
    return false;
  }
  return NAME_PATTERN.test(name);
}

/**
 * 验证内容长度 — 防止超大内容导致内存耗尽
 *
 * @param content 待验证的内容
 * @param maxLength 最大允许长度（默认 10MB）
 * @returns 验证通过返回 true，否则 false
 */
export function isValidContent(content: string, maxLength: number = MAX_CONTENT_LENGTH): boolean {
  if (!content || typeof content !== 'string') {
    return false;
  }
  return content.length <= maxLength;
}

/**
 * FOUNDATION-SEAL Phase 3：验证记忆 ID — 非空字符串 + 长度上限
 *
 * 记忆 ID 格式为 source:xxx（如 "memory:用户偏好"），source 是开放字符串（ADR-004），
 * 不限制字符集，仅校验类型和长度，防止恶意客户端传入非字符串或超长值。
 *
 * @param id 待验证的记忆 ID
 * @returns 验证通过返回 true，否则 false
 */
export function isValidId(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) {
    return false;
  }
  return true;
}

/**
 * FOUNDATION-SEAL Phase 3：验证搜索关键词 — 字符串 + 长度上限
 *
 * 搜索关键词允许空字符串（空字符串触发全量召回场景），仅校验类型和长度，
 * 防止恶意客户端传入非字符串或超长值导致向量检索性能问题。
 *
 * @param query 待验证的搜索关键词
 * @returns 验证通过返回 true，否则 false
 */
export function isValidSearchQuery(query: string): boolean {
  if (typeof query !== 'string' || query.length > MAX_SEARCH_QUERY_LENGTH) {
    return false;
  }
  return true;
}

/** 角色名称长度上限：persona 文件名通常 < 50 字符，留余量到 100 */
const MAX_PERSONA_NAME_LENGTH = 100;

/** 文件路径长度上限：Windows MAX_PATH 260 + 余量到 1000 */
const MAX_FILE_PATH_LENGTH = 1000;

/**
 * FOUNDATION-SEAL Phase 3 轮2：验证角色名称 — 白名单字符 + 长度上限
 *
 * persona name 作为文件名（configDir/personas/{name}.json），必须严格校验：
 * - 仅允许字母、数字、连字符、下划线、点（常见角色命名规范）
 * - 拒绝路径分隔符（/ \）、空格、特殊字符，防止路径遍历
 * - 长度上限 100 字符
 *
 * 与 isValidConfigName 共用防路径遍历策略，但字符集更严格
 * （config 允许中文名称，persona 保持 ASCII 命名规范）。
 *
 * @param name 待验证的角色名称
 * @returns 验证通过返回 true，否则 false
 */
export function isValidPersonaName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_PERSONA_NAME_LENGTH) {
    return false;
  }
  // 白名单：字母 + 数字 + 连字符 + 下划线 + 点，拒绝路径分隔符和空格
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

/**
 * FOUNDATION-SEAL Phase 3 轮3：验证文件路径 — 字符串 + 长度上限
 *
 * 文件路径可能含中文、空格、路径分隔符等，不限制字符集，
 * 仅校验类型和长度，防止非字符串或超长值传入内核。
 * 路径遍历防护由 isPathAllowed 在实际文件操作时校验。
 *
 * @param filePath 待验证的文件路径
 * @returns 验证通过返回 true，否则 false
 */
export function isValidFilePath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > MAX_FILE_PATH_LENGTH) {
    return false;
  }
  return true;
}

/** 关系类型白名单：ADR-014 定义的 6 种语义关系 */
const RELATION_TYPE_WHITELIST = new Set([
  'contradicts', 'supports', 'follows', 'refines', 'caused', 'related',
]);

/**
 * 验证记忆关系类型 — 仅允许 ADR-014 白名单内的 6 种语义
 *
 * 防止恶意/异常渲染进程传入任意 type 字符串污染关系存储。
 *
 * @param type 关系类型标识符
 * @returns 验证通过返回 true，否则 false
 */
export function isValidRelationType(type: string): boolean {
  if (typeof type !== 'string' || type.length === 0 || type.length > 50) {
    return false;
  }
  return RELATION_TYPE_WHITELIST.has(type);
}
