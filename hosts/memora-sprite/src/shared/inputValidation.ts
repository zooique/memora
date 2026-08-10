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

// ShortcutConfig 类型用于 isValidShortcutConfig 的类型守卫返回值
import type { ShortcutConfig } from './shortcutDefaults.js';

/**
 * 会话名/配置名白名单：允许字母、数字、连字符、下划线、中文及常见 Unicode 字母
 *
 * 安全说明：仍然拒绝路径分隔符（/ \）、点号（..）、空格等危险字符，
 * 防止路径遍历攻击。AutoConfigRefiner 产出的建议名称常含中文（如"程序员助手"），
 * 因此扩展为 Unicode 字母白名单。
 */
const NAME_PATTERN = /^[\p{L}\p{N}_-]+$/u;

/** 内容长度上限：10MB 文本，防止内存耗尽攻击 */
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;

/** ID 长度上限：500 字符，覆盖所有 source:xxx 格式的记忆 ID */
const MAX_ID_LENGTH = 500;

/** 搜索关键词长度上限：1000 字符，防止超长查询导致性能问题 */
const MAX_SEARCH_QUERY_LENGTH = 1000;

/**
 * 配置名（规则/技能/角色文件名）最大长度
 *
 * T-B3：与内核 utils/strings.ts `isValidConfigName` 默认阈值（MAX_CONFIG_NAME_LENGTH=100）同步。
 * T-B1 数据核查：真实 configDir 最大名长 25；persona 现上限 100。100 是「文件名物理约束」
 * （MAX_PATH）与命名自由的折中。
 */
const MAX_CONFIG_NAME_LENGTH = 100;

/**
 * 验证名称类字符串（会话名/配置名）的公共校验逻辑
 *
 * 白名单：字母、数字、连字符、下划线、中文及常见 Unicode 字母。
 * 拒绝路径分隔符（/ \）、点号（..）、空格等危险字符。
 *
 * @param name 待验证的名称
 * @param maxLength 最大长度（默认 200，会话名用）
 * @returns 验证通过返回 true，否则 false
 */
function isValidName(name: string, maxLength: number = 200): boolean {
  if (!name || typeof name !== 'string' || name.length === 0 || name.length > maxLength) {
    return false;
  }
  return NAME_PATTERN.test(name);
}

/**
 * 验证会话名 — 拒绝路径分隔符和特殊字符
 *
 * 会话名是 DB 记录名（无文件系统约束），长度保持 200（与配置名 100 解耦）。
 *
 * @param name 待验证的会话名
 * @returns 验证通过返回 true，否则 false
 */
export function isValidSessionName(name: string): boolean {
  return isValidName(name);
}

/**
 * 验证配置文件名（规则/角色/技能名）— 拒绝路径分隔符
 *
 * 配置名用于构造文件路径（如 .memora/rules/{name}.md），
 * 必须严格限制为安全字符，防止路径遍历写入。
 *
 * 与内核 `isValidConfigName`（utils/strings.ts，T-B2/B3）同规则：
 * 字符集 NAME_PATTERN 一致 + 长度 100。renderer（浏览器环境）无法 import memora 裸模块，
 * 故 shared/ 保留本实现；两端一致性由 inputValidation.test.ts 的契约测试锁定。
 *
 * @param name 待验证的配置名
 * @returns 验证通过返回 true，否则 false
 */
export function isValidConfigName(name: string): boolean {
  return isValidName(name, MAX_CONFIG_NAME_LENGTH);
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
 * 验证记忆 ID — 非空字符串 + 长度上限
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
 * 验证搜索关键词 — 字符串 + 长度上限
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
 * 验证角色名称 — 白名单字符 + 长度上限
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
 * 验证文件路径 — 字符串 + 长度上限
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

/**
 * 验证非空字符串（通用工具，消除 `!value || typeof value !== 'string'` 重复）
 *
 * @param value 待验证的值（unknown 类型，支持运行时类型收窄）
 * @returns 验证通过返回 true，否则 false
 */
export function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

/** 记忆关系参数结构（sourceId + targetId + type 三元组） */
interface RelationParams {
  sourceId: string;
  targetId: string;
  type: string;
}

/**
 * 验证记忆关系参数三元组（sourceId + targetId + type 组合校验）
 *
 * 消除 addRelation / removeRelation / updateRelation 三处重复的 `!isValidId || !isValidId || !isValidRelationType` 校验链。
 *
 * @param data 关系参数对象
 * @returns 三项全部校验通过返回 true，否则 false
 */
export function isValidRelationParams(data: RelationParams | undefined | null): boolean {
  if (!data) return false;
  return isValidId(data.sourceId) && isValidId(data.targetId) && isValidRelationType(data.type);
}

/**
 * 验证快捷键配置结构（运行时类型守卫）
 *
 * 校验 enabled 为 boolean、accelerators 为 action→string 的非数组对象。
 * 从 configHandlers.ts 局部定义迁移至 shared/，统一作为输入校验真理源。
 *
 * @param value 待验证的配置值
 * @returns 校验通过返回 true（类型收窄为 ShortcutConfig），否则 false
 */
export function isValidShortcutConfig(value: unknown): value is ShortcutConfig {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as { enabled?: unknown; accelerators?: unknown };
  return (
    typeof s.enabled === 'boolean' &&
    typeof s.accelerators === 'object' &&
    s.accelerators !== null &&
    !Array.isArray(s.accelerators) &&
    Object.values(s.accelerators as Record<string, unknown>).every((v) => typeof v === 'string')
  );
}

/** LLM 配置 API Key 长度上限：1000 字符，防止超大值传入 IPC */
const MAX_LLM_API_KEY_LENGTH = 1000;

/**
 * 验证 LLM 配置输入（provider 类型 + apiKey 长度）
 *
 * 消除 minimalHandlers.ts 中 LLM_CONFIG_TEST 和 LLM_CONFIG_SAVE 重复的校验链
 * （STEP3-13，ADR-017 枝叶层 2 次提取）。
 *
 * 仅校验 provider 类型为 string 且 apiKey 为非空字符串且长度 ≤ 1000，
 * model/baseUrl/temperature 由后续业务逻辑处理。
 *
 * @param config LLM 配置对象（unknown 类型，IPC 入参运行时类型收窄）
 * @returns 校验通过返回 true，否则 false
 */
export function isValidLlmConfigInput(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const c = config as { provider?: unknown; apiKey?: unknown };
  if (typeof c.provider !== 'string') return false;
  // isValidContent 拒绝非字符串和空字符串，先用 typeof 收窄避免传入非字符串
  return typeof c.apiKey === 'string' && isValidContent(c.apiKey, MAX_LLM_API_KEY_LENGTH);
}
