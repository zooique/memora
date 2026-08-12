/**
 * 角色包（Role Pack）类型定义
 *
 * 角色包是以"角色"为单位的固定文本范式，把身份设定、技能、规则组织成可装载的整体。
 * 设计灵感来自插卡式游戏机：内核提供固定卡槽，角色包自含全部内容，插卡即玩、换卡即变。
 *
 * 三层结构（设计文档 docs/agent-design/README.md §13.3）：
 *   L1 内容层（文本）：persona / rule / skill / 知识引用
 *   L2 策略层（枚举）：行为开关，角色只"选择"不"定义"
 *   L3 代码层（扩展）：自定义钩子 —— 远期，需沙箱隔离，当前仅预留
 *
 * M1 过渡状态（2026-08-11）：
 *   装配层引入"角色包清单"数据形状，把"角色 + 技能 + 规则"从三个独立源
 *   收拢为一个清单的读取抽象。行为不变，但装配层只认"清单"不认"来源"。
 */

// ════════════════════════════════════════════════════════════
// L2 策略层：行为策略枚举
// ════════════════════════════════════════════════════════════
// 设计纪律第 4 条：所有策略维度的名称与可选值，定型后不得随意修改，
// 因为它是未来角色包文件格式的字段契约。

// ── 回答前（Prepare）：认知策略 ──

/** 理解确认模式：off=直接生成 / echo=复述但不等待 / confirm=预检停顿后确认 */
export type UnderstandingConfirm = 'off' | 'echo' | 'confirm';

/** 上下文装配策略：fixed=固定最近N轮 / query=按输入召回 / hybrid=两者 */
export type ContextAssembly = 'fixed' | 'query' | 'hybrid';

/** 记忆召回模式：full=全量召回 / limited=限额召回 / none=不召回 */
export type MemoryRecallMode = 'full' | 'limited' | 'none';

/** 摘要召回开关 */
export type SummaryRecall = 'on' | 'off';

/** 任务分类方式：keyword=关键词匹配 / semantic=语义分析 / llm=LLM 判断 */
export type TaskClassification = 'keyword' | 'semantic' | 'llm';

/** 角色自动匹配开关 */
export type AutoSwitch = 'on' | 'off';

// ── 回答中（Act）：行动策略 ──

/** 工具调用模式：allow=允许 / block=只回答不执行（role-pack-spec §六 标准键 act.toolMode） */
export type ToolMode = 'allow' | 'block';

/** @deprecated 旧实现命名（P0 键集对齐前），标准键为 act.toolMode，见 ToolMode */
export type ToolCalls = ToolMode;

/** 工具批准模式：auto=自动执行 / confirm=执行前征询用户 */
export type ToolApproval = 'auto' | 'confirm';

/** 工具操作范围：readonly=仅允许只读操作 / full=完整权限 */
export type ToolReadonly = 'readonly' | 'full';

/** 生成流式模式 */
export type StreamingMode = 'streaming' | 'non-streaming';

/** Provider 路由策略：auto=按任务类型换模型 / fixed=固定模型 */
export type ProviderRouting = 'auto' | 'fixed';

/** 多步推理模式：auto=自动深度思考 / manual=快速回答 */
export type MultiStepReasoning = 'auto' | 'manual';

/** 输入中断策略：allow=执行中可接受新输入 / block=排队到下一轮 */
export type InputInterrupt = 'allow' | 'block';

// ── 回答后（Reflect）：沉淀策略 ──

/** 结束衔接模式（对齐 Handoff 三选一，role-pack-spec §六 标准键 reflect.handoff）：wait=等待用户 / loop=自动续跑 / end=终止 */
export type Handoff = 'wait' | 'loop' | 'end';

/** @deprecated 旧实现命名（P0 键集对齐前），标准键为 reflect.handoff，见 Handoff */
export type EndingHandoff = Handoff;

/** Loop 续跑开关 */
export type LoopContinue = 'on' | 'off';

/** 洞察提取开关 */
export type InsightExtraction = 'on' | 'off';

/** 摘要生成开关 */
export type SummaryGeneration = 'on' | 'off';

/** 记忆写入模式：auto=自动写入 / confirm=写入前确认 */
export type MemoryWriteMode = 'auto' | 'confirm';

/** 会话归档模式：auto=自动归档 / manual=手动归档 */
export type SessionArchiveMode = 'auto' | 'manual';

/** 用户追问策略：ask=主动引导对话 / silent=只等输入 */
export type UserFollowup = 'ask' | 'silent';

// ── 跨阶段：全局策略 ──

/** 错误处理策略：retry=重试 / degrade=降级 / stop=终止 */
export type ErrorHandling = 'retry' | 'degrade' | 'stop';

/** 安全规则覆盖策略：inherit=不可被角色覆盖 / override=允许覆盖 */
export type SafetyRuleMode = 'inherit' | 'override';

/** 主动提问触发场景：ambiguity=模糊 / decision=需决策 / missing_info=缺信息 / confirm=确认 */
export type AskOnTrigger = 'ambiguity' | 'decision' | 'missing_info' | 'confirm';

// ── 策略集合接口 ──

/**
 * 回答前（Prepare）认知策略集合
 *
 * 所有字段可选，未配置的维度使用全局默认值。
 * 设计纪律：角色只"选择"不"定义"。
 */
export interface PrepareStrategy {
  /** 理解确认模式（默认 off） */
  readonly understandingConfirm?: UnderstandingConfirm;
  /** 上下文装配策略（默认 hybrid） */
  readonly contextAssembly?: ContextAssembly;
  /** 固定加载的最近轮次数（默认 3） */
  readonly recentRounds?: number;
  /** 记忆召回模式（默认 full） */
  readonly memoryRecall?: MemoryRecallMode;
  /** 记忆占用上限 token 数（默认 2000） */
  readonly memoryRecallQuota?: number;
  /** 摘要召回开关（默认 on） */
  readonly summaryRecall?: SummaryRecall;
  /** 召回结果相似度阈值 0.0~1.0（默认 0.6） */
  readonly recallConfidence?: number;
  /** 任务分类方式（默认 keyword） */
  readonly taskClassification?: TaskClassification;
  /** 角色自动匹配开关（默认 on） */
  readonly autoSwitch?: AutoSwitch;
}

/**
 * 回答中（Act）行动策略集合
 */
export interface ActStrategy {
  /** 工具调用模式（默认 allow；标准键 act.toolMode，§六） */
  readonly toolMode?: ToolMode;
  /** 工具白名单，空数组=全部允许（默认 []） */
  readonly toolWhitelist?: readonly string[];
  /** 工具黑名单，空数组=无禁止（默认 []） */
  readonly toolBlacklist?: readonly string[];
  /** 工具批准模式（默认 auto） */
  readonly toolApproval?: ToolApproval;
  /** 工具操作范围（默认 full） */
  readonly toolReadonly?: ToolReadonly;
  /** 单轮工具调用步数上限（默认 20） */
  readonly toolStepLimit?: number;
  /** 生成流式模式（默认 streaming） */
  readonly streaming?: StreamingMode;
  /** 生成温度 0.0~2.0（默认 0.7） */
  readonly temperature?: number;
  /** 单轮回答长度上限 token 数（默认 4096） */
  readonly outputLimit?: number;
  /** Provider 路由策略（默认 auto） */
  readonly providerRouting?: ProviderRouting;
  /** 多步推理模式（默认 auto） */
  readonly multiStepReasoning?: MultiStepReasoning;
  /** 输入中断策略（默认 allow） */
  readonly inputInterrupt?: InputInterrupt;
}

/**
 * 回答后（Reflect）沉淀策略集合
 */
export interface ReflectStrategy {
  /** 结束衔接模式（默认 wait；标准键 reflect.handoff，§六） */
  readonly handoff?: Handoff;
  /** Loop 续跑开关（默认 off） */
  readonly loopContinue?: LoopContinue;
  /** 洞察提取开关（默认 on） */
  readonly insightExtraction?: InsightExtraction;
  /** 摘要生成开关（默认 on） */
  readonly summaryGeneration?: SummaryGeneration;
  /** 记忆写入模式（默认 auto） */
  readonly memoryWrite?: MemoryWriteMode;
  /** 会话归档模式（默认 auto） */
  readonly sessionArchive?: SessionArchiveMode;
  /** 用户追问策略（默认 silent） */
  readonly userFollowup?: UserFollowup;
}

/**
 * 跨阶段全局策略集合
 */
export interface GlobalStrategy {
  /** 每轮总 token 上限（默认 8000） */
  readonly tokenBudget?: number;
  /** 每轮工具步数上限（默认 50） */
  readonly stepBudget?: number;
  /** 单任务总成本上限，0=不限制（默认 0） */
  readonly costBudget?: number;
  /** 异常时的处理策略（默认 retry） */
  readonly errorHandling?: ErrorHandling;
  /** 是否允许角色覆盖全局安全规则（默认 inherit=不可覆盖） */
  readonly safetyRule?: SafetyRuleMode;
  /** 主动提问触发场景（默认 ['ambiguity', 'decision', 'missing_info']） */
  readonly askOn?: AskOnTrigger | readonly AskOnTrigger[];
  /** 每轮主动提问次数上限（默认 3） */
  readonly askLimit?: number;
}

/**
 * L2 行为策略全集
 *
 * 角色包通过此集合声明行为偏好，未配置的维度使用全局默认值。
 * 设计纪律：所有维度都是预定义的可选值，角色只做"选择"不做"定义"。
 */
export interface BehaviorStrategy {
  /** 回答前认知策略 */
  readonly prepare?: PrepareStrategy;
  /** 回答中行动策略 */
  readonly act?: ActStrategy;
  /** 回答后沉淀策略 */
  readonly reflect?: ReflectStrategy;
  /** 跨阶段全局策略 */
  readonly global?: GlobalStrategy;
}

// ════════════════════════════════════════════════════════════
// L1 内容层：角色包内容类型
// ════════════════════════════════════════════════════════════

/**
 * 技能引用（角色包中的 skill 段）
 *
 * 角色包不内嵌技能内容，而是引用已注册的技能名称。
 * 运行时由装配层解析引用，从 SkillManager 获取实际内容。
 */
export interface RolePackSkillRef {
  /** 技能名称（对应 SkillManager 中的技能名） */
  readonly name: string;
  /**
   * 可选：角色包中的上下文补充
   * 不覆盖技能内容，仅补充角色上下文（如"以工程师视角使用此技能"）
   */
  readonly contextHint?: string;
}

/**
 * 能力声明（frontmatter.skills 数组项，新格式）
 *
 * 对齐 role-pack-spec §四：以中立能力命名空间声明（`file:write` / `web:search`），
 * 由各实现映射到自有工具；不绑具体实现。与 RolePackSkillRef（旧 ## Skills 正文
 * 引用已注册技能）并存：frontmatter.skills 优先，旧正文引用兼容解析。
 */
export interface RolePackCapability {
  /** 中立能力名（如 `file:write` / `web:search` / `llm:summarize`） */
  readonly capability: string;
  /** 可选：能力说明（供 LLM 与校验器理解） */
  readonly description?: string;
}

/**
 * 知识引用（角色包中的知识引用段）
 *
 * 角色包可声明外部知识来源，按需召回。
 */
export interface RolePackKnowledgeRef {
  /** 引用类型：path=文件路径 / memory=记忆标识 */
  readonly type: 'path' | 'memory';
  /** 引用目标 */
  readonly target: string;
  /** 可选描述 */
  readonly description?: string;
}

/**
 * 角色包元数据（frontmatter 解析结果）
 *
 * 用于匹配、传播、版本管理。
 */
export interface RolePackMeta {
  /** 角色包名称（唯一标识） */
  readonly name: string;
  /** 角色包描述 */
  readonly description?: string;
  /** 版本号 */
  readonly version?: string;
  /** 触发关键词（用于自动匹配） */
  readonly keywords?: readonly string[];
  /** 可选：作者/来源 */
  readonly author?: string;
  /** 格式版本（role-pack-spec §五：schema URL 锚定，缺省按 1.0.0 处理） */
  readonly formatVersion?: string;
  /** 拟人化场景声明（合规 §七：tool_assistant=工具型默认 / companion=拟人化陪伴） */
  readonly interactionType?: 'tool_assistant' | 'companion';
  /** AI 身份标注（合规 §七：默认强制 true） */
  readonly aiIdentityDisclosure?: boolean;
  /** 未成年人保护（合规 §七：默认 required） */
  readonly minorProtection?: 'required';
}

/**
 * 角色包（Role Pack）—— L1 内容层 + L2 策略层
 *
 * 设计文档第十三章定义的三层结构，当前实现 L1 + L2。
 * L3 代码层为远期预留，当前不设计。
 *
 * 实现 ConfigResource 约束（name/keywords/content/filePath）：
 * name 和 keywords 从 meta 派生，content 从 personaContent 派生，
 * 满足基类关键词匹配和 lifecycle 的需求。
 */
export interface RolePack {
  /** 角色包名称（派生自 meta.name，满足 ConfigResource 约束） */
  readonly name: string;
  /** 关键词列表（派生自 meta.keywords，满足 ConfigResource 约束） */
  readonly keywords: string[];
  /** 内容正文（派生自 personaContent，满足 ConfigResource 约束） */
  readonly content: string;
  /** 来源文件路径（满足 ConfigResource 约束） */
  readonly filePath: string;

  /** 角色包元数据（frontmatter） */
  readonly meta: RolePackMeta;

  // ── L1 内容层 ──

  /** 角色身份设定正文（对应当前 Persona 的 content 字段） */
  readonly personaContent: string;
  /**
   * 确定性规则列表
   * 安全规则，装载时全量注入，不可丢失
   */
  readonly rules: readonly string[];
  /**
   * 技能引用列表
   * 运行时按输入匹配激活，通过 SkillManager 解析
   */
  readonly skills: readonly RolePackSkillRef[];
  /**
   * 能力声明列表（frontmatter.skills，新格式）
   * 中立能力命名空间，由实现映射到自有工具
   */
  readonly capabilities: readonly RolePackCapability[];
  /**
   * 知识引用列表
   * 外部资料引用，按需召回
   */
  readonly knowledgeRefs: readonly RolePackKnowledgeRef[];

  // ── L2 策略层 ──

  /**
   * 行为策略声明
   * 未配置的维度使用全局默认值。角色包可以只声明它想改变的部分。
   */
  readonly strategy?: BehaviorStrategy;
}

// ════════════════════════════════════════════════════════════
// 运行时类型
// ════════════════════════════════════════════════════════════

/**
 * 角色包装载结果
 *
 * 装配层将角色包解析为可直接注入 system prompt 的片段。
 * 与原始 RolePack 的区别：strategy 字段已合并默认值成为完整策略。
 */
export interface RolePackAssembly {
  /** 角色包元数据 */
  readonly meta: RolePackMeta;
  /** 合并后的 persona prompt（含规则注入） */
  readonly personaPrompt: string;
  /** 解析后的技能引用列表（已去重） */
  readonly resolvedSkills: readonly RolePackSkillRef[];
  /** 能力声明列表（新格式，与 resolvedSkills 并存） */
  readonly capabilities: readonly RolePackCapability[];
  /** 知识引用列表 */
  readonly knowledgeRefs: readonly RolePackKnowledgeRef[];
  /**
   * 完整行为策略（已合并默认值）
   * 与 RolePack.strategy 不同，此字段所有维度都有值（未声明的维度使用默认值）。
   */
  readonly strategy: BehaviorStrategy;
}

/**
 * 角色包清单（M1 装配层抽象）
 *
 * 装配层只认"清单"不认"来源"。
 * 当前实现从 PersonaManager + SkillManager 聚合，未来可切到角色包文件。
 */
export interface RolePackManifest {
  /** 当前激活的角色包 */
  readonly active: RolePackAssembly | null;
  /** 所有可用角色包列表 */
  readonly available: readonly RolePackAssembly[];
  /** 当前装载的卡槽数量（M2 多卡槽预留） */
  readonly slotCount: number;
}

// ════════════════════════════════════════════════════════════
// 策略默认值收敛
// ════════════════════════════════════════════════════════════

/**
 * 行为策略全局默认值
 *
 * 设计纪律第 2 条：未配置的行为维度使用全局默认值。
 * 角色包可以只声明它想改变的部分——最小角色包即一个含 frontmatter 的声明文件。
 * 作为 const 断言，确保类型推导为字面量值。
 */
export const DEFAULT_BEHAVIOR_STRATEGY: BehaviorStrategy = {
  prepare: {
    understandingConfirm: 'off',
    contextAssembly: 'hybrid',
    recentRounds: 3,
    memoryRecall: 'full',
    memoryRecallQuota: 2000,
    summaryRecall: 'on',
    recallConfidence: 0.6,
    taskClassification: 'keyword',
    autoSwitch: 'on',
  },
  act: {
    toolMode: 'allow',
    toolWhitelist: [],
    toolBlacklist: [],
    toolApproval: 'auto',
    toolReadonly: 'full',
    toolStepLimit: 20,
    streaming: 'streaming',
    temperature: 0.7,
    outputLimit: 4096,
    providerRouting: 'auto',
    multiStepReasoning: 'auto',
    inputInterrupt: 'allow',
  },
  reflect: {
    handoff: 'wait',
    loopContinue: 'off',
    insightExtraction: 'on',
    summaryGeneration: 'on',
    memoryWrite: 'auto',
    sessionArchive: 'auto',
    userFollowup: 'silent',
  },
  global: {
    tokenBudget: 8000,
    stepBudget: 50,
    costBudget: 0,
    errorHandling: 'retry',
    safetyRule: 'inherit',
    askOn: ['ambiguity', 'decision', 'missing_info'],
    askLimit: 3,
  },
} as const;

/**
 * 合并行为策略：角色包声明值覆盖默认值
 *
 * @param base 基础策略（通常传入 DEFAULT_BEHAVIOR_STRATEGY）
 * @param override 角色包声明的覆盖值，未配置的维度保持默认值不变
 * @returns 合并后的完整策略
 */
export function mergeStrategy(
  base: BehaviorStrategy,
  override: BehaviorStrategy | undefined,
): BehaviorStrategy {
  if (!override) return base;

  return {
    prepare: { ...base.prepare, ...override.prepare },
    act: { ...base.act, ...override.act },
    reflect: { ...base.reflect, ...override.reflect },
    global: { ...base.global, ...override.global },
  };
}

/**
 * 将 RolePack 解析为 RolePackAssembly
 *
 * 将原始角色包解析为含完整策略的装载结果，供装配层直接使用。
 * 同时根据策略中的 userFollowup/askOn/askLimit 注入主动提问指令到 persona prompt。
 *
 * @param pack 原始角色包
 * @returns 含完整策略的装载结果
 */
export function assembleRolePack(pack: RolePack): RolePackAssembly {
  // 先合并策略，后续构建 persona prompt 时需读取策略值
  const strategy = mergeStrategy(DEFAULT_BEHAVIOR_STRATEGY, pack.strategy);

  // 构建 persona prompt：身份设定 + 规则注入
  const promptParts: string[] = [pack.personaContent];

  if (pack.rules.length > 0) {
    promptParts.push(`## 规则\n${pack.rules.map((r) => `- ${r}`).join('\n')}`);
  }

  // 主动提问指令注入：userFollowup=ask 时，将 askOn/askLimit 转为 LLM 指令
  if (strategy.reflect?.userFollowup === 'ask') {
    const askOn = strategy.global?.askOn;
    const askLimit = strategy.global?.askLimit ?? 3;
    const triggerLabels: string[] = [];
    const triggers = Array.isArray(askOn) ? askOn : (askOn ? [askOn] : []);
    for (const t of triggers) {
      switch (t) {
        case 'ambiguity': triggerLabels.push('遇到模糊不清的情况'); break;
        case 'decision': triggerLabels.push('需要用户做决策'); break;
        case 'missing_info': triggerLabels.push('缺少关键信息'); break;
        case 'confirm': triggerLabels.push('需要用户确认'); break;
      }
    }
    if (triggerLabels.length > 0) {
      promptParts.push(
        `## 主动提问规则\n${triggerLabels.map((l) => `- 当${l}时，主动向用户提问`).join('\n')}\n- 每轮最多提问 ${askLimit} 次`,
      );
    }
  }

  const personaPrompt = promptParts.join('\n\n');

  return {
    meta: pack.meta,
    personaPrompt,
    resolvedSkills: pack.skills,
    capabilities: pack.capabilities,
    knowledgeRefs: pack.knowledgeRefs,
    strategy,
  };
}

// ════════════════════════════════════════════════════════════
// L3 代码层预留（远期）
// ════════════════════════════════════════════════════════════

/**
 * 自定义钩子（L3 代码层预留）
 *
 * 远期设计：允许角色包携带自定义逻辑，如预处理钩子、后处理钩子。
 * 当前不实现，仅定义接口形状以预留生长点。
 * 实现时需沙箱隔离（如 vm2/isolated-vm）防恶意代码。
 */
export interface RolePackHooks {
  /** 回答前钩子：可修改装配后的上下文 */
  beforePrepare?: (context: unknown) => unknown;
  /** 回答后钩子：可修改提炼结果 */
  afterReflect?: (result: unknown) => unknown;
}