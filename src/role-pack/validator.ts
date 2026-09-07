/**
 * 角色包格式校验器：独立于任何实现、只吃解析后的 manifest.json 对象，按 spec 严格判定
 * （manager 宽松容错，二者互补）。文件夹形态，manifest.json 为核心控制文件。
 * 校验：必填字段（name/formatVersion）、键名合法性（未知键 warning+忽略）、版本语义、
 * 合规分档（interactionType/aiIdentityDisclosure/minorProtection）、策略键、内容路径、
 * skills/capabilities 格式。companion 内容红线由装载方在读取内容后调用 checkCompanionContentRedline。
 * 零依赖、纯函数。
 */

import { STRATEGY_KEY_RULES } from './strategyKeys.js';

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

/** 校验输入（manifest.json 解析后的对象） */
export interface RolePackValidateInput {
  /** 解析后的 manifest.json 对象 */
  manifest: Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════
// 规则常量
// ════════════════════════════════════════════════════════════

/** 顶层已知键（manifest 字段集：元数据 + 合规 + 策略 + 技能 + 接手衔接 + 标准远期键）。
 * 注意：keywords/trigger 已废弃（v0.13 角色包手动切换，自动匹配链死），故意不在已知键集
 * ——旧包带此二键按「未知键 warning + 忽略」宽容处理，与当前解析行为等价。 */
const MANIFEST_KEYS: ReadonlySet<string> = new Set([
  'name', 'displayName', 'formatVersion', 'version', 'description',
  'author', 'homepage', 'repository', 'license',
  'minKernelVersion',
  'interactionType', 'aiIdentityDisclosure', 'minorProtection',
  'strategy', 'skills', 'capabilities', 'handoffPrompt',
]);

/** 合规 interactionType 枚举 */
const INTERACTION_TYPES: ReadonlySet<string> = new Set(['tool_assistant', 'companion']);

/** companion 全量强校验时的虚拟亲密关系红线特征词 */
const INTIMATE_REDLINE_PATTERN =
  /虚拟伴侣|虚拟恋人|虚拟亲属|虚拟男友|虚拟女友|虚拟丈夫|虚拟妻子|AI伴侣|AI恋人/;

/** semver（宽松：主.次.修 + 可选预发布/构建元数据） */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** 中立能力名格式：`域:动作`（如 file:write / web:search / llm:summarize） */
const CAPABILITY_PATTERN = /^[a-z]+:[a-zA-Z0-9._-]+$/;

// ════════════════════════════════════════════════════════════
// 非策略键字段上限常量（SSOT：validator 校验报错 + rolePackManager 运行时兜底共用）
// 策略键数值区间在 strategyKeys.ts；此处管策略键之外的开放字段，防止无条件填写导致资源失控
// ════════════════════════════════════════════════════════════

/** skills 白名单最大数量：与 L1 列表工具阈值同量级，防止白名单膨胀 */
export const MAX_MANIFEST_SKILLS = 50;
/** capabilities 最大数量：防止能力声明面膨胀 */
export const MAX_CAPABILITIES = 50;
/** handoffPrompt 最大长度（字符）：接手话术防巨型注入 prompt */
export const MAX_HANDOFF_PROMPT_LEN = 2000;
/** 元数据字符串字段（name/description/author 等）最大长度（字符） */
export const MAX_META_STRING_LEN = 200;

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
const META_STRING_FIELDS: ReadonlyArray<string> = [
  'name', 'displayName', 'description', 'author', 'homepage', 'repository', 'license',
];

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

  // formatVersion：缺省按 1.0.0，声明则必须 semver
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
  if (
    version !== undefined &&
    (typeof version !== 'string' || !SEMVER_PATTERN.test(version))
  ) {
    issues.push({
      severity: 'warning',
      code: 'INVALID_VERSION',
      path: 'version',
      message: `version 建议使用 semver（当前：${String(version)}）`,
    });
  }

  // minKernelVersion：标准远期键（spec §五 定义），格式不规范仅提示不阻塞——实现按「未知键 warn + ignore」处理
  const minKernelVersion = manifest['minKernelVersion'];
  if (
    minKernelVersion !== undefined &&
    (typeof minKernelVersion !== 'string' || !SEMVER_PATTERN.test(minKernelVersion))
  ) {
    issues.push({
      severity: 'warning',
      code: 'INVALID_MIN_KERNEL_VERSION',
      path: 'minKernelVersion',
      message: `minKernelVersion 建议使用 semver（当前：${String(minKernelVersion)}）`,
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
function validateStrategy(
  strategyNode: unknown,
  issues: RolePackValidationIssue[],
): void {
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
        const range = rule.range
          ? `，合法区间 [${rule.range.min}, ${rule.range.max}]`
          : '';
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
function validateManifestSkills(
  skillsNode: unknown,
  issues: RolePackValidationIssue[],
): void {
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
        message:
          `capability 必须匹配中立能力名 "域:动作"（如 file:write / web:search），当前：${String(capability)}`,
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
 * 校验 manifest.json：必填/版本、合规分档、策略键、skills/capabilities。
 * 未知键 warning + 忽略；valid = 无 error（warning 不阻塞装载）。
 */
export function validateManifest(
  manifest: Record<string, unknown>,
): RolePackValidationResult {
  const issues: RolePackValidationIssue[] = [];

  validateTopLevelKeys(manifest, issues);
  validateMetaFields(manifest, issues);
  validateComplianceFields(manifest, issues);
  validateStrategy(manifest['strategy'], issues);
  validateHandoffPrompt(manifest, issues);
  validateManifestSkills(manifest['skills'], issues);
  validateManifestCapabilities(manifest['capabilities'], issues);

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