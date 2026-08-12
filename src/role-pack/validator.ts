/**
 * 角色包格式校验器（跨实现一致性，role-pack-spec §八）
 *
 * 定位：
 *   - **独立于任何实现**：不依赖 RolePackManager / types.ts 的运行时类型，
 *     只吃"解析后的 frontmatter + body"，按 role-pack-spec §五/§七 判定；
 *   - 消费方：角色包作者（CLI/IDE 校验）、各实现的装载前预检；
 *   - 与 rolePackManager 的关系：manager 是 memora 装载实现（宽松容错），
 *     本校验器是标准判定（严格按 spec），二者互补——manager 可先校验再装载。
 *
 * 校验维度（对应 spec §八）：
 *   1. 必填字段：name（唯一标识）
 *   2. 章节存在：L1 必读章节 ## Persona（身份）与 ## Rules（内容红线载体，§七 第 2 条）
 *   3. 键名合法性：顶层已知键 + strategy 各阶段已知键（§六 v1 键集），未知键 warning + 忽略（§五）
 *   4. 版本语义：formatVersion / version 需 semver
 *   5. 合规分档（§七）：interactionType 缺省 tool_assistant；仅显式 companion 时
 *      全量强校验（aiIdentityDisclosure / minorProtection / 虚拟亲密关系红线）
 *   6. 文件夹形态单一真理源（§2.4）：frontmatter 仅允许 strategy + skills，
 *      元数据键出现在 role-pack.md 即报错（拒绝加载）
 *   7. capabilities 格式（§四）：capability 必填且匹配 `域:动作`，description 可选
 *
 * 零依赖、纯函数：不 import 任何 node 模块，仅复用同模块的 frontmatter 解析器。
 */

import { parseRolePackFrontmatter } from '@/role-pack/frontmatter.js';

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

/** 校验输入 */
export interface RolePackValidateInput {
  /** 解析后的嵌套 frontmatter（parseRolePackFrontmatter 产物） */
  frontmatter: Record<string, unknown>;
  /** frontmatter 之后的 Markdown 正文（含 ## 章节） */
  body: string;
  /** 形态：single-file=单文件（frontmatter 即 manifest）/ folder=文件夹包（manifest.json 为唯一权威，§2.4） */
  form?: 'single-file' | 'folder';
  /**
   * 文件夹形态下的合规注入（§七 第 5 条 红线双文件闭环）：
   * companion 状态在 manifest.json（由 validateManifest 校验），role-pack.md 层无此字段；
   * 调用方先 validateManifest 取得 interactionType，再经本字段注入 validateRolePack，
   * 使 role-pack.md 的 body 红线检测生效。单文件形态无需传入（frontmatter 自带）。
   */
  manifestInteractionType?: string;
}

// ════════════════════════════════════════════════════════════
// 规则常量（对齐 role-pack-spec §五/§六/§七）
// ════════════════════════════════════════════════════════════

/** 顶层已知键（§2.3/§2.4 manifest 字段集 + strategy/skills） */
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'name', 'formatVersion', 'version', 'description', 'keywords', 'trigger',
  'author', 'homepage', 'repository', 'license',
  'interactionType', 'aiIdentityDisclosure', 'minorProtection',
  'strategy', 'skills',
]);

/** 文件夹形态下 role-pack.md frontmatter 允许的键（§2.4 单一真理源，修正 A） */
const FOLDER_FRONTMATTER_KEYS: ReadonlySet<string> = new Set(['strategy', 'skills']);

/** manifest.json 字段集（§2.4，对齐 Agent Plugins plugin.json；文件夹形态元数据唯一权威） */
const MANIFEST_KEYS: ReadonlySet<string> = new Set([
  'name', 'formatVersion', 'version', 'description', 'author', 'homepage',
  'repository', 'license', 'keywords',
  'interactionType', 'aiIdentityDisclosure', 'minorProtection',
  'extensions',
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
    recentRounds: { kind: 'check', check: isPositiveInt }, // [草案]
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
    insightExtraction: { kind: 'enum', values: ['on', 'off'] },
    handoff: { kind: 'enum', values: ['wait', 'loop', 'end'] },
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
 * 顶层键校验模式：strict-allowed=不允许键集外的键（error）/ warn-unknown=未知键警告并忽略（§五）
 */
type TopLevelKeyMode = 'strict-allowed' | 'warn-unknown';

/**
 * 校验顶层键合法性
 *
 * 单文件 frontmatter / manifest：未知键 warning + 忽略（§五 键级渐进）；
 * 文件夹形态 role-pack.md frontmatter：仅允许 strategy/skills，其余键 error（§2.4 修正 A）。
 *
 * @param obj 待校验对象（frontmatter 或 manifest）
 * @param knownKeys 已知顶层键集合
 * @param mode 键集外键的处理模式
 * @param issues 收集校验问题
 */
function validateTopLevelKeys(
  obj: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  mode: TopLevelKeyMode,
  issues: RolePackValidationIssue[],
): void {
  for (const key of Object.keys(obj)) {
    if (knownKeys.has(key)) continue;
    if (mode === 'strict-allowed') {
      issues.push({
        severity: 'error',
        code: 'METADATA_IN_FRONTMATTER',
        path: key,
        message:
          `文件夹形态下元数据权威在 manifest.json，role-pack.md frontmatter 不允许出现 "${key}"（§2.4 单一真理源）`,
      });
    } else {
      issues.push({
        severity: 'warning',
        code: 'UNKNOWN_TOP_LEVEL_KEY',
        path: key,
        message: `未知顶层键 "${key}"，忽略（§五 未知键警告并忽略）`,
      });
    }
  }
}

/**
 * 校验必填字段与版本语义
 *
 * 仅单文件形态执行（frontmatter 即 manifest）；文件夹形态下元数据权威在
 * manifest.json（§2.4），role-pack.md frontmatter 不允许出现元数据键，
 * 由 validateTopLevelKeys 的 METADATA_IN_FRONTMATTER 兜底。
 *
 * @param frontmatter 嵌套 frontmatter
 * @param form 角色包形态
 * @param issues 收集校验问题
 */
function validateMetaFields(
  frontmatter: Record<string, unknown>,
  form: 'single-file' | 'folder',
  issues: RolePackValidationIssue[],
): void {
  if (form === 'folder') return;

  // name 必填（唯一标识）
  const name = frontmatter['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    issues.push({
      severity: 'error',
      code: 'MISSING_NAME',
      path: 'name',
      message: '缺少必填字段 name（唯一标识，§2.3）',
    });
  }

  // formatVersion：缺省按 1.0.0（§五），声明则必须 semver
  const formatVersion = frontmatter['formatVersion'];
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
  const version = frontmatter['version'];
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
 * 校验 L1 必读章节存在性
 *
 * ## Persona：身份设定（最小兼容面）；## Rules：内容红线载体（§七 第 2 条）。
 *
 * @param body Markdown 正文
 * @param issues 收集校验问题
 */
function validateSections(body: string, issues: RolePackValidationIssue[]): void {
  if (!/^##\s*Persona\s*$/m.test(body)) {
    issues.push({
      severity: 'error',
      code: 'MISSING_PERSONA',
      path: 'body',
      message: '缺少 L1 必读章节 "## Persona"（身份设定，最小兼容面）',
    });
  }
  if (!/^##\s*Rules\s*$/m.test(body)) {
    issues.push({
      severity: 'error',
      code: 'MISSING_RULES',
      path: 'body',
      message: '缺少 L1 必读章节 "## Rules"（内容红线载体，§七 第 2 条）',
    });
  }
}

/**
 * 校验 L2 策略键（§六 v1 键集）
 *
 * 键级渐进（§五）：未知阶段/未知键 warning + 忽略；已知键但取值越界 = error
 * （策略维度是预定义枚举，角色只"选择"不"定义"）。
 *
 * @param strategyNode frontmatter.strategy 节点
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
 * 校验 skills 能力声明数组格式（§四）
 *
 * capability 必填且匹配 `域:动作`（中立能力命名空间）；description 可选字符串。
 *
 * @param skillsNode frontmatter.skills 节点
 * @param issues 收集校验问题
 */
function validateCapabilities(
  skillsNode: unknown,
  issues: RolePackValidationIssue[],
): void {
  if (skillsNode === undefined) return;
  if (!Array.isArray(skillsNode)) {
    issues.push({
      severity: 'error',
      code: 'SKILLS_NOT_ARRAY',
      path: 'skills',
      message: 'skills 必须是能力声明数组（§四）',
    });
    return;
  }

  skillsNode.forEach((item, index) => {
    const itemPath = `skills[${index}]`;
    if (typeof item !== 'object' || item === null) {
      issues.push({
        severity: 'error',
        code: 'INVALID_CAPABILITY',
        path: itemPath,
        message: `skills[${index}] 必须是对象`,
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
          `capability 必须匹配中立能力名 "域:动作"（如 file:write / web:search），当前：${String(capability)}（§四）`,
      });
    }
    const description = record['description'];
    if (description !== undefined && typeof description !== 'string') {
      issues.push({
        severity: 'warning',
        code: 'INVALID_CAPABILITY_DESCRIPTION',
        path: `${itemPath}.description`,
        message: 'description 应为字符串（可选）',
      });
    }
  });
}

/**
 * 校验合规元数据字段（§七，分档校验）
 *
 * 仅在"frontmatter 即 manifest"的场景执行（单文件形态 / validateManifest）；
 * 文件夹形态下合规字段归属 manifest.json（§2.4 单一真理源），role-pack.md 层
 * 不检查——frontmatter 中即使出现合规键，也会被 METADATA_IN_FRONTMATTER 拒绝。
 * 标准级可选（缺省 tool_assistant）；仅显式 companion 时全量强校验：
 *   1. aiIdentityDisclosure 必须为 true（缺失即拒绝）
 *   2. minorProtection 必须为 required
 * （正文虚拟亲密关系红线检测另见 validateIntimateRedline，归属 role-pack.md 层）
 *
 * @param frontmatter 嵌套 frontmatter（或 manifest 对象）
 * @param issues 收集校验问题
 */
function validateComplianceFields(
  frontmatter: Record<string, unknown>,
  issues: RolePackValidationIssue[],
): void {
  // interactionType 枚举（缺省 tool_assistant）
  const interactionType = frontmatter['interactionType'];
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
  const disclosure = frontmatter['aiIdentityDisclosure'];
  if (disclosure !== undefined && typeof disclosure !== 'boolean') {
    issues.push({
      severity: 'error',
      code: 'INVALID_AI_DISCLOSURE',
      path: 'aiIdentityDisclosure',
      message: 'aiIdentityDisclosure 应为布尔值（缺省 true）',
    });
  }

  // minorProtection 取值（§七 第 4 条）
  const minorProtection = frontmatter['minorProtection'];
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
 * companion 虚拟亲密关系红线检测（§七 第 5 条）
 *
 * 红线特征在正文（body）里，归属 role-pack.md 层：
 *   - 单文件形态：companion 状态来自 frontmatter，本函数直接判定；
 *   - 文件夹形态：companion 状态在 manifest.json，由调用方经
 *     RolePackValidateInput.manifestInteractionType 注入后，本函数对
 *     role-pack.md 的 body 执行——两文件组合才构成完整合规闭环。
 *
 * @param isCompanion 是否为 companion 角色包
 * @param body Markdown 正文
 * @param issues 收集校验问题
 */
function validateIntimateRedline(
  isCompanion: boolean,
  body: string,
  issues: RolePackValidationIssue[],
): void {
  if (!isCompanion) return;
  if (INTIMATE_REDLINE_PATTERN.test(body)) {
    issues.push({
      severity: 'error',
      code: 'COMPANION_INTIMATE_REDLINE',
      path: 'body',
      message: 'companion 角色包不得携带虚拟亲属/虚拟伴侣特征（内容红线，§七 第 5 条）',
    });
  }
}

// ════════════════════════════════════════════════════════════
// 公共入口
// ════════════════════════════════════════════════════════════

/**
 * 校验解析后的角色包（frontmatter + body）
 *
 * @param input 校验输入
 * @returns 校验结果（valid = 无 error；warning 提示但不阻塞装载）
 */
export function validateRolePack(input: RolePackValidateInput): RolePackValidationResult {
  const { frontmatter, body, form = 'single-file' } = input;
  const issues: RolePackValidationIssue[] = [];

  // 文件夹形态：role-pack.md frontmatter 键集严格限定（§2.4 单一真理源）；
  // 单文件形态：未知顶层键警告忽略（§五 键级渐进）
  validateTopLevelKeys(
    frontmatter,
    form === 'folder' ? FOLDER_FRONTMATTER_KEYS : TOP_LEVEL_KEYS,
    form === 'folder' ? 'strict-allowed' : 'warn-unknown',
    issues,
  );
  validateMetaFields(frontmatter, form, issues);
  validateSections(body, issues);
  validateStrategy(frontmatter['strategy'], issues);
  validateCapabilities(frontmatter['skills'], issues);
  // 合规分档（§七）：单文件形态下 frontmatter 即 manifest，全量字段校验；
  // 文件夹形态下合规字段归属 manifest.json（validateManifest 负责），本层仅做
  // 红线检测——companion 状态由 manifest 经 manifestInteractionType 注入（双文件闭环）
  if (form !== 'folder') {
    validateComplianceFields(frontmatter, issues);
  }
  const isCompanion =
    (input.manifestInteractionType ?? frontmatter['interactionType']) === 'companion';
  validateIntimateRedline(isCompanion, body, issues);

  return { valid: issues.every((i) => i.severity !== 'error'), issues };
}

/**
 * 校验 manifest.json（文件夹形态元数据唯一权威，§2.4）
 *
 * 与 validateRolePack 的分工构成双文件校验闭环：
 *   - validateManifest = manifest.json 元数据层：必填字段（name/formatVersion）、
 *     版本语义、合规分档（§七 interactionType/disclosure/minorProtection + companion 强校验）；
 *   - validateRolePack(folder) = role-pack.md 内容层：strategy/skills/章节/frontmatter 键集；
 *   - 跨文件组合：validateManifest 判定 companion 状态后，经
 *     RolePackValidateInput.manifestInteractionType 注入 validateRolePack，
 *     完成 role-pack.md 正文的红线检测——单文件形态由 validateRolePack 一票全包。
 *
 * 复用说明：manifest 即"单文件形态下的 frontmatter"（§2.4 manifest 双形态同构），
 * 因此复用 validateMetaFields / validateComplianceFields 的单文件分支；manifest
 * 层无正文，红线检测天然不适用（归属 role-pack.md 层）。
 *
 * @param manifest 解析后的 manifest.json 对象
 * @returns 校验结果（valid = 无 error；warning 提示但不阻塞装载）
 */
export function validateManifest(manifest: Record<string, unknown>): RolePackValidationResult {
  const issues: RolePackValidationIssue[] = [];

  // 未知键 warning + 忽略（§五 键级渐进；manifest 键集 §2.4）
  validateTopLevelKeys(manifest, MANIFEST_KEYS, 'warn-unknown', issues);
  // 必填字段与版本语义：name 必填 / formatVersion 必填且 semver / version 建议 semver
  validateMetaFields(manifest, 'single-file', issues);
  // 合规分档（§七）：interactionType 枚举（缺省 tool_assistant）+ companion 全量强校验
  validateComplianceFields(manifest, issues);

  return { valid: issues.every((i) => i.severity !== 'error'), issues };
}

/**
 * 校验原始 role-pack.md 文本（便捷入口，内部复用 frontmatter 解析器）
 *
 * @param raw 完整 markdown 文本（含 --- frontmatter）
 * @param form 角色包形态（默认 single-file）
 * @returns 校验结果
 */
export function validateRolePackText(
  raw: string,
  form: 'single-file' | 'folder' = 'single-file',
): RolePackValidationResult {
  const { frontmatter, body } = parseRolePackFrontmatter(raw);
  return validateRolePack({ frontmatter, body, form });
}
