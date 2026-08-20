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

/** 顶层已知键（manifest 字段集：元数据 + 合规 + 策略 + 技能 + 接手衔接） */
const MANIFEST_KEYS: ReadonlySet<string> = new Set([
  'name', 'displayName', 'formatVersion', 'version', 'description', 'keywords', 'trigger',
  'author', 'homepage', 'repository', 'license',
  'interactionType', 'aiIdentityDisclosure', 'minorProtection', 'exclusiveWith',
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
        issues.push({
          severity: 'error',
          code: 'INVALID_STRATEGY_VALUE',
          path: keyPath,
          message: `${keyPath} 取值 ${String(value)} 不符合约束`,
        });
      }
    }
  }
}

/** 校验互斥声明格式（exclusiveWith 须为字符串数组，空数组合法）；集合级对称性见 validateExclusiveSymmetry */
function validateExclusiveWith(
  manifest: Record<string, unknown>,
  issues: RolePackValidationIssue[],
): void {
  const value = manifest['exclusiveWith'];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    issues.push({
      severity: 'error',
      code: 'INVALID_EXCLUSIVE_WITH',
      path: 'exclusiveWith',
      message: 'exclusiveWith 必须是字符串数组（互斥角色包名列表）',
    });
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

    // name / description 可选字符串（元数据在技能文件 frontmatter，此处声明仅兼容忽略）
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

/** 解析匹配字段（keywords/trigger）为字符串数组：支持数组与逗号串双写法，其余类型为非法返回 null（已 push error） */
function parseMatchField(
  fieldName: 'keywords' | 'trigger',
  node: unknown,
  issues: RolePackValidationIssue[],
): string[] | null {
  if (node === undefined) return null;

  if (Array.isArray(node)) {
    // 数组写法：元素必须全为字符串；含非字符串元素视为非法
    if (node.some((v) => typeof v !== 'string')) {
      issues.push({
        severity: 'error',
        code: `INVALID_${fieldName.toUpperCase()}`,
        path: fieldName,
        message: `${fieldName} 数组的元素必须是字符串（匹配字段双写法）`,
      });
      return null;
    }
    return node.map((s) => String(s));
  }

  if (typeof node === 'string') {
    // 逗号分隔字符串写法：拆分 + 去空格
    return node
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  issues.push({
    severity: 'error',
    code: `INVALID_${fieldName.toUpperCase()}`,
    path: fieldName,
    message: `${fieldName} 必须是字符串数组或逗号分隔字符串（匹配字段双写法）`,
  });
  return null;
}

/** 校验 keywords 字段类型（复用 parseMatchField；无正则语义） */
function validateKeywordsField(
  keywordsNode: unknown,
  issues: RolePackValidationIssue[],
): void {
  parseMatchField('keywords', keywordsNode, issues);
}

/**
 * 校验 trigger 字段类型 + 正则误用：角色包 trigger 为字符串数组（精确/包含匹配）而非正则。
 * 若值含 `/pattern/flags` 正则语法则 warning——会被当作字面关键词，无法匹配任何输入。
 */
function validateTriggerField(
  triggerNode: unknown,
  issues: RolePackValidationIssue[],
): void {
  const values = parseMatchField('trigger', triggerNode, issues);
  if (!values) return;

  // 检测每个 trigger 值是否误用了正则语法
  // 正则语法模式：以 / 开头、以 / 结尾（可能带 flags），如 /pattern/i
  const regexPattern = /^\/.+\/[gimsuy]*$/;
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (regexPattern.test(value)) {
      issues.push({
        severity: 'warning',
        code: 'TRIGGER_REGEX_MISUSE',
        path: `trigger[${i}]`,
        message:
          `trigger 值 "${value}" 疑似正则语法（/pattern/flags）。` +
          `角色包 trigger 为字符串精确/包含匹配，不支持正则。` +
          `正则匹配仅在 Skill 系统中支持。当前值会被当作字面关键词，无法匹配任何输入。`,
      });
    }
  }
}

/**
 * 校验 manifest.json：必填/版本、合规分档、策略键、skills/capabilities、匹配字段。
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
  validateExclusiveWith(manifest, issues);
  validateHandoffPrompt(manifest, issues);
  validateManifestSkills(manifest['skills'], issues);
  validateManifestCapabilities(manifest['capabilities'], issues);
  validateTriggerField(manifest['trigger'], issues);
  validateKeywordsField(manifest['keywords'], issues);

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