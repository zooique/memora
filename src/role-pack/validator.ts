/**
 * 角色包格式校验器：独立于任何实现、只吃解析后的 manifest.json 对象，按 spec 严格判定
 * （manager 宽松容错，二者互补）。文件夹形态，manifest.json 为核心控制文件。
 * 校验：必填字段（name）、键名合法性（未知键 warning+忽略）、版本语义（formatVersion 可选，缺省 1.0.0）、
 * 合规分档（interactionType/aiIdentityDisclosure/minorProtection）、策略键、内容路径、
 * skills/capabilities 格式。companion 内容红线由装载方在读取内容后调用 checkCompanionContentRedline。
 * 纯函数、无 IO 依赖（能力「是否已登记」查 capabilityMap 的登记表，不复制名单）。
 */

import { STRATEGY_KEY_RULES, TOOL_GROUPS, TOOL_NAME_PATTERN } from './strategyKeys.js';
import { isRegisteredCapability } from './capabilityMap.js';

/** 校验严重级别：error=拒绝加载 / warning=可装载但提示 */
export type RolePackIssueSeverity = 'error' | 'warning';

/** 单个校验问题 */
export interface RolePackValidationIssue {
  severity: RolePackIssueSeverity;
  /** 稳定问题码（机器可判读，如 MISSING_NAME / INVALID_CAPABILITY） */
  code: string;
  /** 字段点路径（如 name / strategy.prepare.contextAssembly） */
  path: string;
  /** 人类可读描述 */
  message: string;
}

/** 校验结果 */
export interface RolePackValidationResult {
  /** 无 error 即 valid（warning 不阻塞装载） */
  valid: boolean;
  issues: readonly RolePackValidationIssue[];
}

// ════════════════════════════════════════════════════════════
// 规则常量
// ════════════════════════════════════════════════════════════

/** 顶层已知键（manifest 字段集：元数据 + 合规 + 策略 + 技能 + 接手衔接）。
 * 注意：keywords/trigger/extensions/minKernelVersion/homepage/repository/license 无消费方
 *（角色包为手动切换，无自动匹配链），故意不在已知键集——带这些键的
 * manifest 按「未知键 warning + 忽略」宽容处理（键级渐进设计，兼容演进）。 */
const MANIFEST_KEYS: ReadonlySet<string> = new Set([
  'name',
  'displayName',
  'formatVersion',
  'version',
  'description',
  'author',
  'interactionType',
  'kind',
  'aiIdentityDisclosure',
  'minorProtection',
  'strategy',
  'skills',
  'capabilities',
  'tools',
  'handoffPrompt',
]);

/** 合规 interactionType 枚举 */
const INTERACTION_TYPES: ReadonlySet<string> = new Set(['tool_assistant', 'companion']);

/** 角色包工种枚举（`kind` 顶层键；缺省 work =存量包行为零变化）。
 * 闭集：显式写错必须 error，不许静默折叠回 work（折叠 = 拼错的助手包静默拿到写盘工具，fail-open）。 */
const ROLE_PACK_KINDS: ReadonlySet<string> = new Set(['work', 'assistant']);

/** companion 全量强校验时的虚拟亲密关系红线特征词 */
const INTIMATE_REDLINE_PATTERN =
  /虚拟伴侣|虚拟恋人|虚拟亲属|虚拟男友|虚拟女友|虚拟丈夫|虚拟妻子|AI伴侣|AI恋人/;

/** semver（宽松：主.次.修 + 可选预发布/构建元数据） */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** 中立能力名格式：`域:动作`（如 file:write / web:search / llm:summarize） */
const CAPABILITY_PATTERN = /^[a-z]+:[a-zA-Z0-9._-]+$/;

// ════════════════════════════════════════════════════════════
// 非策略键字段上限常量（validator 模块内部上限，唯一例外见下）
// 策略键数值区间在 strategyKeys.ts；此处管策略键之外的开放字段，防止无条件填写导致资源失控。
// ⚠️ 仅 MAX_HANDOFF_PROMPT_LEN 跨模块共用（rolePackManager 运行时截断兜底）；
//    其余三个只服务 validator 自身报错，勿声称「共用」。
// ════════════════════════════════════════════════════════════

/** skills 白名单最大数量：与 L1 列表工具阈值同量级，防止白名单膨胀 */
const MAX_MANIFEST_SKILLS = 50;
/** capabilities 最大数量：防止能力声明面膨胀 */
const MAX_CAPABILITIES = 50;
/** tools 最大数量：角色包专属工具上限（与 skills / capabilities 同量级，防声明面膨胀） */
const MAX_MANIFEST_TOOLS = 50;
/** handoffPrompt 最大长度（字符）：接手话术防巨型注入 prompt（rolePackManager 截断兜底复用） */
export const MAX_HANDOFF_PROMPT_LEN = 2000;
/** 元数据字符串字段（name/description/author 等）最大长度（字符） */
const MAX_META_STRING_LEN = 200;

// ── 校验实现 ──────────────────────────────────────

/** 校验顶层键合法性（未知键 warning + 忽略，不阻塞） */
function validateTopLevelKeys(
  manifest: Record<string, unknown>,
  issues: RolePackValidationIssue[],
): void {
  for (const key of Object.keys(manifest)) {
    if (MANIFEST_KEYS.has(key)) continue;
    issues.push({
      severity: 'warning',
      code: 'UNKNOWN_TOP_LEVEL_KEY',
      path: key,
      message: `未知顶层键 "${key}"，忽略（未知键警告并忽略）`,
    });
  }
}

/** 元数据字符串字段（进展示/标识，超长无意义，统一校验报错） */
const META_STRING_FIELDS: ReadonlyArray<string> = ['name', 'displayName', 'description', 'author'];

/** 校验必填字段与版本语义（name 必填；formatVersion 缺省按 1.0.0，声明则须 semver；version 为 warning） */
function validateMetaFields(
  manifest: Record<string, unknown>,
  issues: RolePackValidationIssue[],
): void {
  // name 必填（唯一标识）
  const name = manifest['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    issues.push({
      severity: 'error',
      code: 'MISSING_NAME',
      path: 'name',
      message: '缺少必填字段 name（唯一标识）',
    });
  }

  // 元数据字符串长度上限（防巨型字符串注入 UI/标识/prompt）
  for (const field of META_STRING_FIELDS) {
    const value = manifest[field];
    if (typeof value === 'string' && value.length > MAX_META_STRING_LEN) {
      issues.push({
        severity: 'error',
        code: 'META_STRING_TOO_LONG',
        path: field,
        message: `${field} 超过长度上限 ${MAX_META_STRING_LEN} 字符（当前 ${value.length}）`,
      });
    }
  }

  // formatVersion：缺省按 1.0.0，声明则必须 semver。
  // schema 已同步为可选（docs/role-pack/role-pack.schema.json 的 required 去掉本键）；
  // 此处保持宽松是为不炸既有用户包——存量角色包可能没写该键。
  // 🔴 不要改成「缺省即报错」：那会让能正常装载的老包集体加载失败。
  const formatVersion = manifest['formatVersion'];
  if (
    formatVersion !== undefined &&
    (typeof formatVersion !== 'string' || !SEMVER_PATTERN.test(formatVersion))
  ) {
    issues.push({
      severity: 'error',
      code: 'INVALID_FORMAT_VERSION',
      path: 'formatVersion',
      message: `formatVersion 必须是 semver（当前：${String(formatVersion)}），每个版本绑定固定 schema URL`,
    });
  }

  // version：语义性字段，格式不规范仅提示不阻塞
  const version = manifest['version'];
  if (version !== undefined && (typeof version !== 'string' || !SEMVER_PATTERN.test(version))) {
    issues.push({
      severity: 'warning',
      code: 'INVALID_VERSION',
      path: 'version',
      message: `version 建议使用 semver（当前：${String(version)}）`,
    });
  }
}

/**
 * 校验合规元数据字段：标准级可选（缺省 tool_assistant）；仅显式 companion 时全量强校验
 * （aiIdentityDisclosure 必须 true、minorProtection 必须 required）。正文虚拟亲密关系红线见 checkCompanionContentRedline。
 */
function validateComplianceFields(
  manifest: Record<string, unknown>,
  issues: RolePackValidationIssue[],
): void {
  // interactionType 枚举（缺省 tool_assistant）
  const interactionType = manifest['interactionType'];
  if (
    interactionType !== undefined &&
    (typeof interactionType !== 'string' || !INTERACTION_TYPES.has(interactionType))
  ) {
    issues.push({
      severity: 'error',
      code: 'INVALID_INTERACTION_TYPE',
      path: 'interactionType',
      message: `interactionType 必须是 tool_assistant | companion（当前：${String(interactionType)}），分档校验`,
    });
  }
  const isCompanion = interactionType === 'companion';

  // kind 枚举（缺省 work；显式非法值 error，不静默折叠）
  const kind = manifest['kind'];
  if (kind !== undefined && (typeof kind !== 'string' || !ROLE_PACK_KINDS.has(kind))) {
    issues.push({
      severity: 'error',
      code: 'INVALID_KIND',
      path: 'kind',
      message: `kind 必须是 work | assistant（当前：${String(kind)}）；非法值 error 拒装，不静默退回 work`,
    });
  }

  // aiIdentityDisclosure 类型（缺省 true）
  const disclosure = manifest['aiIdentityDisclosure'];
  if (disclosure !== undefined && typeof disclosure !== 'boolean') {
    issues.push({
      severity: 'error',
      code: 'INVALID_AI_DISCLOSURE',
      path: 'aiIdentityDisclosure',
      message: 'aiIdentityDisclosure 应为布尔值（缺省 true）',
    });
  }

  // minorProtection 取值（仅支持 required）
  const minorProtection = manifest['minorProtection'];
  if (minorProtection !== undefined && minorProtection !== 'required') {
    issues.push({
      severity: 'error',
      code: 'INVALID_MINOR_PROTECTION',
      path: 'minorProtection',
      message: `minorProtection 仅支持 required（当前：${String(minorProtection)}），未成年人保护钩子`,
    });
  }

  // companion 全量强校验
  if (isCompanion) {
    if (disclosure !== true) {
      issues.push({
        severity: 'error',
        code: 'COMPANION_MISSING_AI_DISCLOSURE',
        path: 'aiIdentityDisclosure',
        message: 'companion 角色包必须强制声明 aiIdentityDisclosure: true',
      });
    }
    if (minorProtection !== 'required') {
      issues.push({
        severity: 'error',
        code: 'COMPANION_MISSING_MINOR_PROTECTION',
        path: 'minorProtection',
        message: 'companion 角色包必须声明 minorProtection: required',
      });
    }
  }
}

/**
 * 校验 L2 策略键：未知阶段/未知键 warning + 忽略（键级渐进）；已知键取值越界 = error
 * （策略维度是预定义枚举，角色只"选择"不"定义"）。
 */
function validateStrategy(strategyNode: unknown, issues: RolePackValidationIssue[]): void {
  if (strategyNode === undefined) return;
  if (typeof strategyNode !== 'object' || strategyNode === null || Array.isArray(strategyNode)) {
    issues.push({
      severity: 'error',
      code: 'INVALID_STRATEGY',
      path: 'strategy',
      message: 'strategy 必须是嵌套对象（{ prepare/act/reflect/global }）',
    });
    return;
  }

  for (const [stage, node] of Object.entries(strategyNode)) {
    const stagePath = `strategy.${stage}`;
    const rules = STRATEGY_KEY_RULES[stage];
    if (!rules) {
      issues.push({
        severity: 'warning',
        code: 'UNKNOWN_STRATEGY_STAGE',
        path: stagePath,
        message: `未知策略阶段 "${stage}"（已知：prepare/act/reflect/global），忽略`,
      });
      continue;
    }
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      issues.push({
        severity: 'error',
        code: 'INVALID_STRATEGY_STAGE',
        path: stagePath,
        message: `${stagePath} 必须是对象`,
      });
      continue;
    }

    for (const [key, value] of Object.entries(node)) {
      const keyPath = `${stagePath}.${key}`;
      const rule = rules[key];
      if (!rule) {
        issues.push({
          severity: 'warning',
          code: 'UNKNOWN_STRATEGY_KEY',
          path: keyPath,
          message: `未知策略键 "${keyPath}"（L2 键级渐进：已知生效、未知忽略）`,
        });
        continue;
      }

      // 枚举 / 断言校验
      if (rule.kind === 'enum') {
        if (!rule.values.includes(value)) {
          issues.push({
            severity: 'error',
            code: 'INVALID_STRATEGY_VALUE',
            path: keyPath,
            message: `${keyPath} 取值 ${String(value)} 不在枚举 ${rule.values.join(' / ')}`,
          });
        }
      } else if (!rule.check(value)) {
        // 数值键（带 range 元数据）报错时展示合法区间，指导填写；无区间键仅提示不符合约束
        const range = rule.range ? `，合法区间 [${rule.range.min}, ${rule.range.max}]` : '';
        issues.push({
          severity: 'error',
          code: 'INVALID_STRATEGY_VALUE',
          path: keyPath,
          message: `${keyPath} 取值 ${String(value)} 不符合约束${range}`,
        });
      }
    }
  }
}

/** 校验接手衔接提示词（非空字符串；类型错误仅 warning 不阻塞——宿主消费，宽容容错，角色包只描述自己） */
function validateHandoffPrompt(
  manifest: Record<string, unknown>,
  issues: RolePackValidationIssue[],
): void {
  const value = manifest['handoffPrompt'];
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({
      severity: 'warning',
      code: 'INVALID_HANDOFF_PROMPT',
      path: 'handoffPrompt',
      message: 'handoffPrompt 应为非空字符串（角色包被带入对话时预填的接手衔接提示词）',
    });
    return;
  }
  // 长度上限：接手话术预填进对话，防巨型注入
  if (value.length > MAX_HANDOFF_PROMPT_LEN) {
    issues.push({
      severity: 'error',
      code: 'HANDOFF_PROMPT_TOO_LONG',
      path: 'handoffPrompt',
      message: `handoffPrompt 最多 ${MAX_HANDOFF_PROMPT_LEN} 字符（当前 ${value.length}）`,
    });
  }
}

/**
 * 校验 skills 注册：对象数组，每项须含 file（相对 skills/ 文件名）；目录扫描下声明项仅作白名单过滤
 */
function validateManifestSkills(skillsNode: unknown, issues: RolePackValidationIssue[]): void {
  if (skillsNode === undefined) return;
  if (!Array.isArray(skillsNode)) {
    issues.push({
      severity: 'error',
      code: 'SKILLS_NOT_ARRAY',
      path: 'skills',
      message: 'skills 必须是对象数组（每项 { file }；目录扫描，声明项仅作白名单过滤）',
    });
    return;
  }

  // 数量上限：白名单防膨胀（目录扫描已全量，声明项仅过滤，超限无意义）
  if (skillsNode.length > MAX_MANIFEST_SKILLS) {
    issues.push({
      severity: 'error',
      code: 'SKILLS_TOO_MANY',
      path: 'skills',
      message: `skills 白名单最多 ${MAX_MANIFEST_SKILLS} 项（当前 ${skillsNode.length}）`,
    });
  }

  skillsNode.forEach((item, index) => {
    const itemPath = `skills[${index}]`;
    if (typeof item !== 'object' || item === null) {
      issues.push({
        severity: 'error',
        code: 'INVALID_MANIFEST_SKILL',
        path: itemPath,
        message: `skills[${index}] 必须是对象`,
      });
      return;
    }
    const record = item as Record<string, unknown>;

    // 目录扫描：manifest.skills 仅白名单过滤，声明项必须含 file（相对 skills/ 的文件名）
    const file = record['file'];
    const hasFile = typeof file === 'string' && file.trim() !== '';
    if (!hasFile) {
      issues.push({
        severity: 'error',
        code: 'INVALID_MANIFEST_SKILL',
        path: itemPath,
        message: `skills[${index}] 必须声明 file（技能文件名，如 skills/write.md）；skills 由目录动态扫描，声明项仅作白名单过滤`,
      });
    }

    // name / description 可选字符串（元数据真正在技能文件 frontmatter，此处声明可选，目录扫描时忽略）
    for (const optKey of ['name', 'description'] as const) {
      const opt = record[optKey];
      if (opt !== undefined && typeof opt !== 'string') {
        issues.push({
          severity: 'warning',
          code: 'INVALID_MANIFEST_SKILL',
          path: `${itemPath}.${optKey}`,
          message: `skills[${index}].${optKey} 应为字符串（可选）`,
        });
      }
    }
  });
}

/** 校验顶层 capabilities（能力面声明，每项 `{ capability: "域:动作", description? }`） */
function validateManifestCapabilities(
  capabilitiesNode: unknown,
  issues: RolePackValidationIssue[],
): void {
  if (capabilitiesNode === undefined) return;
  if (!Array.isArray(capabilitiesNode)) {
    issues.push({
      severity: 'error',
      code: 'CAPABILITIES_NOT_ARRAY',
      path: 'capabilities',
      message: 'capabilities 必须是对象数组（每项 { capability: "域:动作", description? }）',
    });
    return;
  }

  // 数量上限：能力声明面防膨胀
  if (capabilitiesNode.length > MAX_CAPABILITIES) {
    issues.push({
      severity: 'error',
      code: 'CAPABILITIES_TOO_MANY',
      path: 'capabilities',
      message: `capabilities 最多 ${MAX_CAPABILITIES} 项（当前 ${capabilitiesNode.length}）`,
    });
  }

  capabilitiesNode.forEach((item, index) => {
    const itemPath = `capabilities[${index}]`;
    if (typeof item !== 'object' || item === null) {
      issues.push({
        severity: 'error',
        code: 'INVALID_CAPABILITY',
        path: itemPath,
        message: `capabilities[${index}] 必须是对象`,
      });
      return;
    }
    const record = item as Record<string, unknown>;
    const capability = record['capability'];
    if (typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability)) {
      issues.push({
        severity: 'error',
        code: 'INVALID_CAPABILITY',
        path: `${itemPath}.capability`,
        message: `capability 必须匹配中立能力名 "域:动作"（如 file:write / web:search），当前：${String(capability)}`,
      });
    } else if (!isRegisteredCapability(capability)) {
      // 格式合法但内核未登记：不阻塞装载（现有角色包不能因这条检查装不上），但必须可见——
      // 否则「白名单从全开收窄为仅常驻集」会静默发生，作者以为声明了什么、实际什么都没解锁。
      issues.push({
        severity: 'warning',
        code: 'UNREGISTERED_CAPABILITY',
        path: `${itemPath}.capability`,
        message:
          `能力名 "${capability}" 格式合法但内核未登记：它不会解锁任何工具；` +
          `且该角色包一旦声明 capabilities，工具面就会从「全开（含特权工具）」收窄为「仅常驻集 + 已登记能力映射出的特权工具」`,
      });
    }
    const description = record['description'];
    if (description !== undefined && typeof description !== 'string') {
      issues.push({
        severity: 'warning',
        code: 'INVALID_CAPABILITY',
        path: `${itemPath}.description`,
        message: `capabilities[${index}].description 应为字符串（可选）`,
      });
    }
  });
}

/**
 * 校验包内工具声明（manifest.tools，§8 角色包专属工具）。
 *
 * **只校验形状与闭集**（纯函数无 IO）：脚本是否存在 / 是否逃逸包目录 / hash 计算全部归
 * `rolePackManager` 装配期（§8.9 R8，两层不得越界）。
 *
 * 判据（每条都 fail-closed，error 级拒绝装载）：
 * - 条目必须是对象，`name` 合法且不重复（重名 = 后者静默覆盖前者，模型看到哪个不确定）；
 * - `description` 非空（空描述会让模型无法判断何时调用）；
 * - `group` 缺省合法，显式值必须在三组闭集内（写错静默归 act = 分组判据失效）；
 * - `readonly` 缺省合法，显式值必须是布尔；
 * - `parameters`：`type === 'object'`、`properties` 是非空对象且每项有非空 `description`、
 *   `required` 是数组且每项必须出现在 `properties` 里（否则模型填的参数永远校验不过）；
 * - `impl`：`type` 必须是 `'script'`（本期闭集）、`path` 非空字符串；
 * - **禁止声明 `confirmPolicy`**（§8.9 R2）：包作者自选「不被审查」等于审查失效，装配期强制 audit。
 */
function validateManifestTools(toolsNode: unknown, issues: RolePackValidationIssue[]): void {
  if (toolsNode === undefined) return;
  if (!Array.isArray(toolsNode)) {
    issues.push({
      severity: 'error',
      code: 'TOOLS_NOT_ARRAY',
      path: 'tools',
      message: 'tools 必须是对象数组（每项 = 一个包内工具声明）',
    });
    return;
  }

  // 数量上限：工具声明面防膨胀
  if (toolsNode.length > MAX_MANIFEST_TOOLS) {
    issues.push({
      severity: 'error',
      code: 'TOOLS_TOO_MANY',
      path: 'tools',
      message: `tools 最多 ${MAX_MANIFEST_TOOLS} 项（当前 ${toolsNode.length}）`,
    });
  }

  /** 已声明的工具名（重名检测：重名会让后一项静默覆盖前一项） */
  const seenNames = new Set<string>();
  /** 工具分组闭集（用于 group 校验；由 TOOL_GROUPS 派生，不复制名单） */
  const toolGroupSet: ReadonlySet<string> = new Set(TOOL_GROUPS);

  toolsNode.forEach((item, index) => {
    const itemPath = `tools[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      issues.push({
        severity: 'error',
        code: 'INVALID_TOOL_DECL',
        path: itemPath,
        message: `tools[${index}] 必须是对象`,
      });
      return;
    }
    const record = item as Record<string, unknown>;

    // ── name：必填 + 格式 + 不重复 ──
    const name = record['name'];
    if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
      issues.push({
        severity: 'error',
        code: 'INVALID_TOOL_DECL',
        path: `${itemPath}.name`,
        message: `tools[${index}].name 必须是合法的工具名（字母或下划线开头，只含字母数字下划线），当前：${String(name)}`,
      });
    } else if (seenNames.has(name)) {
      issues.push({
        severity: 'error',
        code: 'DUPLICATE_TOOL_NAME',
        path: `${itemPath}.name`,
        message: `tools 内工具名 "${name}" 重复声明（后者会静默覆盖前者）`,
      });
    } else {
      seenNames.add(name);
    }

    // ── description：非空字符串（模型据此决定何时调用） ──
    const description = record['description'];
    if (typeof description !== 'string' || description.trim() === '') {
      issues.push({
        severity: 'error',
        code: 'INVALID_TOOL_DECL',
        path: `${itemPath}.description`,
        message: `tools[${index}].description 必须是非空字符串（模型据此判断何时调用该工具）`,
      });
    }

    // ── group：缺省合法，显式值必须在三组闭集内 ──
    const group = record['group'];
    if (group !== undefined && (typeof group !== 'string' || !toolGroupSet.has(group))) {
      issues.push({
        severity: 'error',
        code: 'INVALID_TOOL_DECL',
        path: `${itemPath}.group`,
        message: `tools[${index}].group 必须是 ${TOOL_GROUPS.join(' | ')}（缺省 act），当前：${String(group)}`,
      });
    }

    // ── readonly：缺省合法，显式值必须是布尔 ──
    const readonly = record['readonly'];
    if (readonly !== undefined && typeof readonly !== 'boolean') {
      issues.push({
        severity: 'error',
        code: 'INVALID_TOOL_DECL',
        path: `${itemPath}.readonly`,
        message: `tools[${index}].readonly 必须是布尔值（缺省 false = 写工具）`,
      });
    }

    // ── confirmPolicy：禁止声明（装配期强制 audit，作者不得自选不过闸） ──
    if ('confirmPolicy' in record) {
      issues.push({
        severity: 'error',
        code: 'TOOL_CONFIRM_POLICY_FORBIDDEN',
        path: `${itemPath}.confirmPolicy`,
        message:
          'manifest.tools 不得声明 confirmPolicy：包内工具一律由内核强制 audit（过闸 + 审计），' +
          '作者自选「不被审查」会使审批闸失效',
      });
    }

    // ── parameters：object + properties 非空 + required ⊂ properties ──
    const parameters = record['parameters'];
    if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
      issues.push({
        severity: 'error',
        code: 'INVALID_TOOL_PARAMETERS',
        path: `${itemPath}.parameters`,
        message: `tools[${index}].parameters 必须是对象（{ type: 'object', properties, required }）`,
      });
    } else {
      const params = parameters as Record<string, unknown>;
      if (params['type'] !== 'object') {
        issues.push({
          severity: 'error',
          code: 'INVALID_TOOL_PARAMETERS',
          path: `${itemPath}.parameters.type`,
          message: `tools[${index}].parameters.type 必须是 "object"（当前：${String(params['type'])}）`,
        });
      }
      const properties = params['properties'];
      const propertyNames = new Set<string>();
      if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
        issues.push({
          severity: 'error',
          code: 'INVALID_TOOL_PARAMETERS',
          path: `${itemPath}.parameters.properties`,
          message: `tools[${index}].parameters.properties 必须是对象（参数名 → { type, description }）`,
        });
      } else {
        for (const [propName, propVal] of Object.entries(properties)) {
          propertyNames.add(propName);
          if (typeof propVal !== 'object' || propVal === null || Array.isArray(propVal)) {
            issues.push({
              severity: 'error',
              code: 'INVALID_TOOL_PARAMETERS',
              path: `${itemPath}.parameters.properties.${propName}`,
              message: `参数 "${propName}" 必须是对象（{ type, description }）`,
            });
            continue;
          }
          const prop = propVal as Record<string, unknown>;
          if (typeof prop['type'] !== 'string' || prop['type'] === '') {
            issues.push({
              severity: 'error',
              code: 'INVALID_TOOL_PARAMETERS',
              path: `${itemPath}.parameters.properties.${propName}.type`,
              message: `参数 "${propName}" 缺少 type`,
            });
          }
          // 参数说明必填：空说明 = 模型不知道怎么填，坏 schema 会让工具恒调用失败（§8.9 R6）
          if (typeof prop['description'] !== 'string' || prop['description'].trim() === '') {
            issues.push({
              severity: 'error',
              code: 'INVALID_TOOL_PARAMETERS',
              path: `${itemPath}.parameters.properties.${propName}.description`,
              message: `参数 "${propName}" 缺少非空 description（模型靠它填参）`,
            });
          }
        }
      }
      // required：必须是数组，且每项都在 properties 里（点名不存在的参数 = 模型永远填不对）
      const required = params['required'];
      if (!Array.isArray(required)) {
        issues.push({
          severity: 'error',
          code: 'INVALID_TOOL_PARAMETERS',
          path: `${itemPath}.parameters.required`,
          message: `tools[${index}].parameters.required 必须是数组（无必填参数写 []）`,
        });
      } else {
        required.forEach((req, reqIndex) => {
          if (typeof req !== 'string') {
            issues.push({
              severity: 'error',
              code: 'INVALID_TOOL_PARAMETERS',
              path: `${itemPath}.parameters.required[${reqIndex}]`,
              message: 'parameters.required 的每一项必须是字符串',
            });
          } else if (!propertyNames.has(req)) {
            issues.push({
              severity: 'error',
              code: 'INVALID_TOOL_PARAMETERS',
              path: `${itemPath}.parameters.required[${reqIndex}]`,
              message: `required 里的 "${req}" 未在 properties 中声明`,
            });
          }
        });
      }
    }

    // ── impl：type 闭集 script + path 非空（存在性 / 逃逸 / hash 归装配期） ──
    const impl = record['impl'];
    if (typeof impl !== 'object' || impl === null || Array.isArray(impl)) {
      issues.push({
        severity: 'error',
        code: 'INVALID_TOOL_IMPL',
        path: `${itemPath}.impl`,
        message: `tools[${index}].impl 必须是对象（{ type: 'script', path: 'scripts/xxx.mjs' }）`,
      });
    } else {
      const implRec = impl as Record<string, unknown>;
      if (implRec['type'] !== 'script') {
        issues.push({
          severity: 'error',
          code: 'INVALID_TOOL_IMPL',
          path: `${itemPath}.impl.type`,
          message: `tools[${index}].impl.type 仅支持 "script"（当前：${String(implRec['type'])}）`,
        });
      }
      const implPath = implRec['path'];
      if (typeof implPath !== 'string' || implPath.trim() === '') {
        issues.push({
          severity: 'error',
          code: 'INVALID_TOOL_IMPL',
          path: `${itemPath}.impl.path`,
          message: `tools[${index}].impl.path 必须是非空字符串（相对角色包根的脚本路径）`,
        });
      }
    }
  });
}

/**
 * 校验 manifest.json：必填/版本、合规分档、策略键、skills/capabilities/tools。
 * 未知键 warning + 忽略；valid = 无 error（warning 不阻塞装载）。
 */
export function validateManifest(manifest: Record<string, unknown>): RolePackValidationResult {
  const issues: RolePackValidationIssue[] = [];

  validateTopLevelKeys(manifest, issues);
  validateMetaFields(manifest, issues);
  validateComplianceFields(manifest, issues);
  validateStrategy(manifest['strategy'], issues);
  validateHandoffPrompt(manifest, issues);
  validateManifestSkills(manifest['skills'], issues);
  validateManifestCapabilities(manifest['capabilities'], issues);
  validateManifestTools(manifest['tools'], issues);

  return { valid: issues.every((i) => i.severity !== 'error'), issues };
}

/** 便捷入口：校验原始 manifest.json 文本（非法 JSON 返回 INVALID_JSON error） */
export function validateManifestText(raw: string): RolePackValidationResult {
  try {
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    return validateManifest(manifest);
  } catch {
    return {
      valid: false,
      issues: [
        {
          severity: 'error',
          code: 'INVALID_JSON',
          path: 'manifest',
          message: 'manifest.json 不是合法的 JSON',
        },
      ],
    };
  }
}

/** 校验 companion 内容红线段（虚拟亲密关系）——正文在独立内容文件，本校验器纯函数不读文件，由装载方读内容后调用；tool_assistant 豁免 */
export function checkCompanionContentRedline(content: string): RolePackValidationIssue[] {
  if (!content) return [];
  if (INTIMATE_REDLINE_PATTERN.test(content)) {
    return [
      {
        severity: 'error',
        code: 'COMPANION_INTIMATE_REDLINE',
        path: 'persona',
        message: 'companion 角色包不得携带虚拟亲属/虚拟伴侣特征（内容红线）',
      },
    ];
  }
  return [];
}
