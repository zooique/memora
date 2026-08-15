/**
 * 角色包格式校验器（跨实现一致性，role-pack-spec §八）
 *
 * 定位：
 *   - **独立于任何实现**：不依赖 RolePackManager / types.ts 的运行时类型，
 *     只吃"解析后的 manifest.json 对象"，按 role-pack-spec §五/§七 判定；
 *   - 消费方：角色包作者（CLI/IDE 校验）、各实现的装载前预检；
 *   - 与 rolePackManager 的关系：manager 是 memora 装载实现（宽松容错），
 *     本校验器是标准判定（严格按 spec），二者互补——manager 可先校验再装载。
 *
 * 角色包统一为**文件夹形态**，manifest.json 是唯一核心控制文件（§2.2）：
 *   元数据 + L2 策略 + 内容路径注册（persona/rules）+ 内嵌技能注册（skills）。
 * 内容文件（persona.md / rules.md / skills/*）独立于 manifest，由路径注册装载。
 *
 * 校验维度（对应 spec §八）：
 *   1. 必填字段：name / formatVersion（manifest 唯一权威）
 *   2. 键名合法性：顶层已知键 + strategy 各阶段已知键（§六 v1 键集），未知键 warning + 忽略（§五）
 *   3. 版本语义：formatVersion / version 需 semver
 *   4. 合规分档（§七）：interactionType 缺省 tool_assistant；仅显式 companion 时
 *      全量强校验（aiIdentityDisclosure / minorProtection / 虚拟亲密关系红线）
 *   5. 内容路径注册：persona / rules 必须为字符串路径或 null（允许缺省）
 *   6. capabilities 格式（§四）：skills 项可选 capability，声明则须匹配 `域:动作`
 *
 * companion 内容红线（§七 第 5 条）不在本校验器内判定——正文在独立的内容文件
 * （persona.md/rules.md），本校验器为纯函数不读文件；由管理员在装载内容后调用
 * `checkCompanionContentRedline` 检测（见函数文档）。
 *
 * 零依赖、纯函数：不 import 任何 node 模块。
 */

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
// 规则常量（对齐 role-pack-spec §五/§六/§七）
// ════════════════════════════════════════════════════════════

/** 顶层已知键（§2.2 manifest 字段集：元数据 + 合规 + 内容注册 + 策略 + 技能） */
const MANIFEST_KEYS: ReadonlySet<string> = new Set([
  'name', 'displayName', 'formatVersion', 'version', 'description', 'keywords', 'trigger',
  'author', 'homepage', 'repository', 'license',
  'interactionType', 'aiIdentityDisclosure', 'minorProtection', 'exclusiveWith',
  'strategy', 'skills', 'persona', 'rules',
]);

/** 合规 interactionType 枚举（§七 第 3 条） */
const INTERACTION_TYPES: ReadonlySet<string> = new Set(['tool_assistant', 'companion']);

/** companion 全量强校验时的虚拟亲密关系红线特征词（§七 第 5 条） */
const INTIMATE_REDLINE_PATTERN =
  /虚拟伴侣|虚拟恋人|虚拟亲属|虚拟男友|虚拟女友|虚拟丈夫|虚拟妻子|AI伴侣|AI恋人/;

/** semver（宽松：主.次.修 + 可选预发布/构建元数据） */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** 中立能力名格式：`域:动作`（§四，如 file:write / web:search / llm:summarize） */
const CAPABILITY_PATTERN = /^[a-z]+:[a-zA-Z0-9._-]+$/;

/**
 * 单策略键规则：枚举值集合（enum）或断言函数（check）
 *
 * 设计：角色包对策略维度只"选择"不"定义"（types.ts 设计纪律），
 * 因此枚举外取值是 error（机器可判读），而非忽略。
 */
type KeyRule =
  | { readonly kind: 'enum'; readonly values: readonly unknown[] }
  | { readonly kind: 'check'; readonly check: (value: unknown) => boolean };

/** 正整数断言（recentRounds / askLimit） */
function isPositiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** 非负整数断言（loopContinue，0=关闭自审查） */
function isNonNegativeInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** 温度断言：0.0~2.0 数字（act.temperature） */
function isTemperature(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 2;
}

/** askOn 断言：单枚举字符串 或 元素∈四枚举的数组（可组合，§六） */
function isAskOn(value: unknown): boolean {
  const ASK_TRIGGERS: ReadonlySet<string> = new Set([
    'ambiguity', 'decision', 'missing_info', 'confirm',
  ]);
  if (typeof value === 'string') return ASK_TRIGGERS.has(value);
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'string' && ASK_TRIGGERS.has(v))
  );
}

// L2 策略键集（role-pack-spec §六 v1 最小集 + P0 提炼键，camelCase 统一命名）
// 状态标注（P0 键集对齐 2026-08-12）：无标注 = 冻结（memora 真实消费）；
// `[草案]` = 尚无参考实现消费，保留以征集验证（spec §五 双闸门演进，仍校验语法但语义不承诺一致）
const STRATEGY_KEY_RULES: Readonly<Record<string, Readonly<Record<string, KeyRule>>>> = {
  prepare: {
    contextAssembly: { kind: 'enum', values: ['fixed', 'query', 'hybrid'] }, // [草案]
    recentRounds: { kind: 'check', check: isPositiveInt },
    memoryRecall: { kind: 'enum', values: ['full', 'limited', 'none'] },
    // P0 键集对齐（2026-08-12）：由实现提炼进标准的键（memora 真实消费，spec §六 提炼行）
    memoryRecallQuota: { kind: 'check', check: isPositiveInt },
    summaryRecall: { kind: 'enum', values: ['on', 'off'] }, // [草案]
  },
  act: {
    toolMode: { kind: 'enum', values: ['allow', 'block'] },
    temperature: { kind: 'check', check: isTemperature }, // [草案]
    streaming: { kind: 'enum', values: ['streaming', 'non-streaming'] }, // [草案]
  },
  reflect: {
    summary: { kind: 'enum', values: ['on', 'off'] }, // [草案]（memora 旧字段 summaryGeneration 为僵尸键）
    handoff: { kind: 'enum', values: ['wait', 'loop', 'end'] },
    loopContinue: { kind: 'check', check: isNonNegativeInt },
    userFollowup: { kind: 'enum', values: ['ask', 'silent'] },
  },
  global: {
    askOn: { kind: 'check', check: isAskOn },
    askLimit: { kind: 'check', check: isPositiveInt },
    errorHandling: { kind: 'enum', values: ['retry', 'degrade', 'stop'] }, // [草案]
  },
};

// ════════════════════════════════════════════════════════════
// 校验实现
// ════════════════════════════════════════════════════════════

/**
 * 校验顶层键合法性（未知键 warning + 忽略，§五 键级渐进）
 *
 * @param manifest 待校验的 manifest 对象
 * @param issues 收集校验问题
 */
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
      message: `未知顶层键 "${key}"，忽略（§五 未知键警告并忽略）`,
    });
  }
}

/**
 * 校验必填字段与版本语义（manifest 唯一权威）
 *
 * @param manifest 嵌套 manifest 对象
 * @param issues 收集校验问题
 */
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
      message: '缺少必填字段 name（唯一标识，§2.2）',
    });
  }

  // formatVersion：缺省按 1.0.0（§五），声明则必须 semver
  const formatVersion = manifest['formatVersion'];
  if (
    formatVersion !== undefined &&
    (typeof formatVersion !== 'string' || !SEMVER_PATTERN.test(formatVersion))
  ) {
    issues.push({
      severity: 'error',
      code: 'INVALID_FORMAT_VERSION',
      path: 'formatVersion',
      message: `formatVersion 必须是 semver（当前：${String(formatVersion)}），§五 每个版本绑定固定 schema URL`,
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
 * 校验合规元数据字段（§七，分档校验）
 *
 * 标准级可选（缺省 tool_assistant）；仅显式 companion 时全量强校验：
 *   1. aiIdentityDisclosure 必须为 true（缺失即拒绝）
 *   2. minorProtection 必须为 required
 * 正文虚拟亲密关系红线检测另见 checkCompanionContentRedline（归属内容文件层）。
 *
 * @param manifest 嵌套 manifest 对象
 * @param issues 收集校验问题
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
      message: `interactionType 必须是 tool_assistant | companion（当前：${String(interactionType)}），§七 分档校验`,
    });
  }
  const isCompanion = interactionType === 'companion';

  // aiIdentityDisclosure 类型（缺省 true，§七 第 1 条）
  const disclosure = manifest['aiIdentityDisclosure'];
  if (disclosure !== undefined && typeof disclosure !== 'boolean') {
    issues.push({
      severity: 'error',
      code: 'INVALID_AI_DISCLOSURE',
      path: 'aiIdentityDisclosure',
      message: 'aiIdentityDisclosure 应为布尔值（缺省 true）',
    });
  }

  // minorProtection 取值（§七 第 4 条）
  const minorProtection = manifest['minorProtection'];
  if (minorProtection !== undefined && minorProtection !== 'required') {
    issues.push({
      severity: 'error',
      code: 'INVALID_MINOR_PROTECTION',
      path: 'minorProtection',
      message: `minorProtection 仅支持 required（当前：${String(minorProtection)}），§七 未成年人保护钩子`,
    });
  }

  // companion 全量强校验（§七 分档）
  if (isCompanion) {
    if (disclosure !== true) {
      issues.push({
        severity: 'error',
        code: 'COMPANION_MISSING_AI_DISCLOSURE',
        path: 'aiIdentityDisclosure',
        message: 'companion 角色包必须强制声明 aiIdentityDisclosure: true（§七 第 1 条）',
      });
    }
    if (minorProtection !== 'required') {
      issues.push({
        severity: 'error',
        code: 'COMPANION_MISSING_MINOR_PROTECTION',
        path: 'minorProtection',
        message: 'companion 角色包必须声明 minorProtection: required（§七 第 4 条）',
      });
    }
  }
}

/**
 * 校验 L2 策略键（§六 v1 键集）
 *
 * 键级渐进（§五）：未知阶段/未知键 warning + 忽略；已知键但取值越界 = error
 * （策略维度是预定义枚举，角色只"选择"不"定义"）。
 *
 * @param strategyNode manifest.strategy 节点
 * @param issues 收集校验问题
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
      message: 'strategy 必须是嵌套对象（{ prepare/act/reflect/global }，§六）',
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
        message: `未知策略阶段 "${stage}"（已知：prepare/act/reflect/global），忽略（§五）`,
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
          message: `未知策略键 "${keyPath}"（L2 键级渐进：已知生效、未知忽略，§六）`,
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
            message: `${keyPath} 取值 ${String(value)} 不在枚举 ${rule.values.join(' / ')}（§六）`,
          });
        }
      } else if (!rule.check(value)) {
        issues.push({
          severity: 'error',
          code: 'INVALID_STRATEGY_VALUE',
          path: keyPath,
          message: `${keyPath} 取值 ${String(value)} 不符合约束（§六）`,
        });
      }
    }
  }
}

/**
 * 校验内容路径注册（persona / rules）
 *
 * 新形态下 persona 允许缺省（§2.2），rules 同样可选。声明值必须为文件路径字符串
 * （相对包根）；null 表示未声明（合法）。其他类型（数字/对象/布尔）为 error。
 *
 * @param manifest 嵌套 manifest 对象
 * @param issues 收集校验问题
 */
function validateContentPaths(
  manifest: Record<string, unknown>,
  issues: RolePackValidationIssue[],
): void {
  for (const key of ['persona', 'rules'] as const) {
    const value = manifest[key];
    if (value === undefined || value === null) continue; // 未声明/显式 null：合法缺省
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push({
        severity: 'error',
        code: 'INVALID_CONTENT_PATH',
        path: key,
        message: `${key} 必须为文件路径字符串（相对角色包根，声明则为必填；未声明或 null 表示缺省）`,
      });
    }
  }
}

/**
 * 校验互斥声明格式（exclusiveWith，§13 粘性匹配）
 *
 * exclusiveWith 应为字符串数组（互斥角色包名列表）。声明为其他形状
 * （字符串/数值/对象）为 error；空数组合法（= 无互斥声明）。
 * 声明格式的**集合级**一致性（悬空引用/不对称）见 validateExclusiveSymmetry。
 *
 * @param manifest 嵌套 manifest 对象
 * @param issues 收集校验问题
 */
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
      message: 'exclusiveWith 必须是字符串数组（互斥角色包名列表，§13 粘性匹配）',
    });
  }
}

/**
 * 校验 skills 注册（manifest.skills 对象数组，§4）
 *
 * 新形态下 skills 以**对象数组**注册，支持多个添加。每项结构：
 *   `{ file?, name?, description?, capability? }`，file（生态指针）或 capability（能力声明）**至少其一**。
 * capability 可选；声明则须匹配 `域:动作`（中立能力命名空间）。
 *
 * @param skillsNode manifest.skills 节点
 * @param issues 收集校验问题
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
      message: 'skills 必须是对象数组（每项 { file?, name?, description?, capability? }，§4）',
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

    // file 或 capability 至少其一（§4：生态指针 / 能力声明）
    const file = record['file'];
    const capability = record['capability'];
    const hasFile = typeof file === 'string' && file.trim() !== '';
    const hasCapability = typeof capability === 'string' && capability.trim() !== '';
    if (!hasFile && !hasCapability) {
      issues.push({
        severity: 'error',
        code: 'INVALID_MANIFEST_SKILL',
        path: itemPath,
        message: `skills[${index}] 必须声明 file（技能文件路径/已注册技能名）或 capability（能力声明 \`域:动作\`）至少其一（§4）`,
      });
    }

    // name / description 可选字符串
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

    // capability 可选，声明则须匹配 `域:动作`
    if (!hasCapability) return;
    if (typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability)) {
      issues.push({
        severity: 'error',
        code: 'INVALID_CAPABILITY',
        path: `${itemPath}.capability`,
        message:
          `capability 必须匹配中立能力名 "域:动作"（如 file:write / web:search），当前：${String(capability)}（§四）`,
      });
    }
  });
}

// ════════════════════════════════════════════════════════════
// 公共入口
// ════════════════════════════════════════════════════════════

/**
 * 校验 manifest.json（角色包文件夹形态唯一核心控制文件，§2.2）
 *
 * 校验维度：必填字段（name/formatVersion）、版本语义、合规分档（§七）、
 * L2 策略键（§六）、内容路径注册、skills 注册格式（§4）。
 * 未知键 / 未知策略键 warning + 忽略（§五 键级渐进）。
 *
 * @param manifest 解析后的 manifest.json 对象
 * @returns 校验结果（valid = 无 error；warning 提示但不阻塞装载）
 */
export function validateManifest(
  manifest: Record<string, unknown>,
): RolePackValidationResult {
  const issues: RolePackValidationIssue[] = [];

  validateTopLevelKeys(manifest, issues);
  validateMetaFields(manifest, issues);
  validateComplianceFields(manifest, issues);
  validateStrategy(manifest['strategy'], issues);
  validateContentPaths(manifest, issues);
  validateExclusiveWith(manifest, issues);
  validateManifestSkills(manifest['skills'], issues);

  return { valid: issues.every((i) => i.severity !== 'error'), issues };
}

/**
 * 便捷入口：校验原始 manifest.json 文本
 *
 * @param raw manifest.json 原始文本
 * @returns 校验结果
 */
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

/**
 * 校验 companion 角色包内容红线段（§七 第 5 条）
 *
 * 正文在独立内容文件（persona.md/rules.md），本校验器为纯函数不读文件，
 * 故红线检测由装载方在读取内容后调用本函数。仅 companion 角色包需执行；
 * tool_assistant 豁免（§七 分档）。
 *
 * @param content 已读取的 persona + rules 拼接内容
 * @returns 红线违规问题列表（无违规返回空数组）
 */
export function checkCompanionContentRedline(content: string): RolePackValidationIssue[] {
  if (!content) return [];
  if (INTIMATE_REDLINE_PATTERN.test(content)) {
    return [
      {
        severity: 'error',
        code: 'COMPANION_INTIMATE_REDLINE',
        path: 'persona',
        message: 'companion 角色包不得携带虚拟亲属/虚拟伴侣特征（内容红线，§七 第 5 条）',
      },
    ];
  }
  return [];
}