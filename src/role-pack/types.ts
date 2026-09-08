/**
 * 角色包（Role Pack）类型定义——以"角色"为单位，把身份/技能/规则组织成可装载的整体。
 *
 * 三层结构：L1 内容层（persona/rule/skill）、L2 策略层（枚举开关，角色只"选择"不"定义"）、
 * L3 代码层（远期预留）。装配层经"角色包清单"抽象，只认清单不认来源。
 */

// 策略维度名称与可选值定型后不得随意修改——它是未来角色包文件格式的字段契约

import type { RolePackValidationIssue } from './validator.js';

// ── 回答前（Prepare）：认知策略 ──

/** 理解确认模式：off=直接生成 / echo=复述但不等待 / confirm=预检停顿后确认 */
export type UnderstandingConfirm = 'off' | 'echo' | 'confirm';

/** 上下文装配策略：fixed=固定最近N轮 / query=按输入召回 / hybrid=两者 */
export type ContextAssembly = 'fixed' | 'query' | 'hybrid';

/** 记忆召回模式：full=全量召回 / limited=限额召回 / none=不召回 */
export type MemoryRecallMode = 'full' | 'limited' | 'none';

/** 摘要召回开关 */
export type SummaryRecall = 'on' | 'off';

// ── 回答中（Act）：行动策略 ──

/** 工具调用模式：allow=允许 / block=只回答不执行（标准键 act.toolMode） */
export type ToolMode = 'allow' | 'block';

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

// ── 回答后（Reflect）：沉淀策略 ──

/** 自审查轮数：0=关闭 / N=LLM 纯文本回复后最多自审查 N 轮 */
export type SelfReviewRounds = number;

/** 摘要生成开关（on=生成摘要 / off=不生成） */
export type Summary = 'on' | 'off';

/** 用户追问策略：ask=主动引导对话 / silent=只等输入 */
export type UserFollowup = 'ask' | 'silent';

// ── 跨阶段：全局策略 ──

/** 错误处理策略：retry=重试 / degrade=降级 / stop=终止 */
export type ErrorHandling = 'retry' | 'degrade' | 'stop';

/** 主动提问触发场景：ambiguity=模糊 / decision=需决策 / missing_info=缺信息 / confirm=确认 */
export type AskOnTrigger = 'ambiguity' | 'decision' | 'missing_info' | 'confirm';

// ── 策略集合接口 ──

/**
 * 回答前（Prepare）认知策略集合
 * 所有字段可选，未配置的维度使用全局默认值；角色只"选择"不"定义"。
 */
export interface PrepareStrategy {
  /** 理解确认模式（默认 off；内核已消费：assembleRolePack 注入 persona prompt 行为指令） */
  readonly understandingConfirm?: UnderstandingConfirm;
  /** 上下文装配策略（默认 hybrid） */
  readonly contextAssembly?: ContextAssembly;
  /** 记忆召回模式（默认 full） */
  readonly memoryRecall?: MemoryRecallMode;
  /**
   * 记忆召回占可用预算的百分比 cap（0.0~1.0，默认 0.4；cap 非 quota）。
   * 记忆摘要层 = 完整对话层填满后剩余空间的拾遗填充，≤ 剩余预算 × 该值；只装完整对话层未覆盖的旧摘要。
   * 取代旧绝对 token 配额语义（动态容量下绝对 token 不自洽）。
   */
  readonly memoryRecallPercent?: number;
  /** 摘要召回开关（默认 on；内核已消费） */
  readonly summaryRecall?: SummaryRecall;
  /** 召回保底下限：语义召回不足时用最近记忆补足至该条数（0=关闭，默认 2；内核已消费） */
  readonly minFallback?: number;
  /** 召回结果相似度阈值 0.0~1.0（默认 0.6；内核已消费） */
  readonly recallConfidence?: number;
  /** 角色包提炼视角（默认 undefined=通用浓缩；供 round-summary 生成判断「值得记什么」，内核已消费） */
  readonly summaryFocus?: string;
}

/** 回答中（Act）行动策略集合 */
export interface ActStrategy {
  /** 工具调用模式（默认 allow；标准键 act.toolMode） */
  readonly toolMode?: ToolMode;
  /** 工具批准模式（默认 auto；内核已消费） */
  readonly toolApproval?: ToolApproval;
  /** 工具操作范围（默认 full；内核已消费） */
  readonly toolReadonly?: ToolReadonly;
  /** 单轮工具调用步数上限（默认 20） */
  readonly toolStepLimit?: number;
  /** 生成流式模式（默认 streaming） */
  readonly streaming?: StreamingMode;
  /** 生成温度 0.0~2.0（默认 0.7） */
  readonly temperature?: number;
  /** 单轮回答长度上限 token 数（默认 4096） */
  readonly outputLimit?: number;
  /** Provider 路由策略（默认 auto；内核已消费） */
  readonly providerRouting?: ProviderRouting;
  /** 多步推理模式（默认 auto；内核已消费） */
  readonly multiStepReasoning?: MultiStepReasoning;
}

/** 回答后（Reflect）沉淀策略集合 */
export interface ReflectStrategy {
  /** 自审查轮数（默认 0=关闭；0=关闭 / N=最多自审查 N 轮） */
  readonly selfReview?: SelfReviewRounds;
  /** 历史别名（v0.13- 命名残留）：新键 selfReview 优先，旧键回退 */
  readonly loopContinue?: SelfReviewRounds;
  /** 摘要生成开关（默认 on；标准键 reflect.summary） */
  readonly summary?: Summary;
  /** 用户追问策略（默认 silent） */
  readonly userFollowup?: UserFollowup;
}

/** 跨阶段全局策略集合 */
export interface GlobalStrategy {
  /** 每轮总 token 上限（默认 200000；内核已消费） */
  readonly tokenBudget?: number;
  /** 每轮工具步数上限（默认 50；内核已消费） */
  readonly stepBudget?: number;
  /** 异常时的处理策略（默认 retry） */
  readonly errorHandling?: ErrorHandling;
  /** 主动提问触发场景（默认 ['ambiguity', 'decision', 'missing_info']） */
  readonly askOn?: AskOnTrigger | readonly AskOnTrigger[];
  /** 主动提问次数上限：按一次用户输入（turn 粒度）计，防单次输入被打断过多次（默认 3） */
  readonly askLimit?: number;
}

/**
 * L2 行为策略全集
 * 角色包经此集合声明行为偏好，未配置维度用全局默认值；所有维度为预定义可选值，角色只做"选择"。
 * 诚实化声明：本集合是"设计空间"非"承诺面"——被实际消费的字段为
 * prepare 的 understandingConfirm（注入 persona prompt 行为指令）/memoryRecall/memoryRecallPercent/minFallback/summaryFocus/contextAssembly/recallConfidence/summaryRecall；
 * act 的 toolMode/temperature/outputLimit/streaming/toolStepLimit/providerRouting/multiStepReasoning/toolReadonly/toolApproval；
 * reflect 的 summary/selfReview/userFollowup；global 的 askOn/askLimit/errorHandling/tokenBudget/stepBudget。
 * 边界纪律：understandingConfirm 内核已消费；costBudget 键已撤下（2026-08-28：内核无定价能力、宿主无执行者，无消费者的策略键不保留，遵循"预留键非承诺"纪律）。
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
 * L2 运行时策略（loop 运行态，单一策略对象）
 * 由 BehaviorStrategy 经 resolveL2Strategy 解析 + 默认值兜底后，一次性注入 AgentLoop；
 * 只含"角色包可影响"的行为维度，内核内部常数不在此列。
 */
export interface L2RuntimeStrategy {
  /** 工具调用是否被阻止（toolMode==='block' 时为 true） */
  readonly toolCallsBlocked: boolean;
  /** 自审查最大轮数（reflect.selfReview：0=关闭 / N=最多 N 轮） */
  readonly maxSelfReviewRounds: number;
  /** 单轮工具调用步数上限（act.toolStepLimit：0=无限制 / N=限制步数） */
  readonly toolStepLimit: number;
  /** 错误处理策略（global.errorHandling） */
  readonly errorHandling: ErrorHandling;
  /** Provider 路由策略（act.providerRouting） */
  readonly providerRouting: ProviderRouting;
  /** Token 预算上限（global.tokenBudget：0=不限制） */
  readonly tokenBudget: number;
  /** 步数预算上限（global.stepBudget：0=不限制） */
  readonly stepBudget: number;
  /** 多步推理模式（act.multiStepReasoning） */
  readonly multiStepReasoning: MultiStepReasoning;
  /** 主动提问次数上限（global.askLimit：turn 粒度防打扰；ask_user 硬护栏拦截超限调用） */
  readonly askLimit: number;
  /** 工具只读模式（act.toolReadonly） */
  readonly toolReadonly: ToolReadonly;
  /** 工具审批模式（act.toolApproval） */
  readonly toolApproval: ToolApproval;
}

/** 能力声明：以中立能力命名空间（`file:write`/`web:search`）声明，由各实现映射到自有工具（见 capabilityMap.ts 映射表） */
export interface RolePackCapability {
  /** 中立能力名（如 `file:write` / `web:search` / `llm:summarize`） */
  readonly capability: string;
  /** 可选：能力说明（供 LLM 与校验器理解） */
  readonly description?: string;
}

/**
 * 组（宿主装配级）：组长角色包 + 组员名单。会议名单容器，非选择对象。
 * 组长身份唯一（一个角色包只能是一个组的组长，宿主校验）；组员可被多组引用（引用共享）；
 * 成员名单非空（组员被删光 → 该组失效，仅影响会议不影响日常）；组员仅作小组会议参与者，不用于日常。
 */
export interface RolePackTeam {
  /** 组长角色包名（组的定义者；会议默认汇总者 = activePack） */
  readonly leader: string;
  /** 组员角色包名列表（非空；会议参与者） */
  readonly members: readonly string[];
}

/** 角色包元数据（manifest.json 解析结果），用于匹配、传播、版本管理 */
export interface RolePackMeta {
  /** 角色包名称（唯一标识） */
  readonly name: string;
  /** UI 展示名（与 name 分离：name 为内部唯一标识，displayName 为本地化展示名，缺省回退 name=displayName ?? name） */
  readonly displayName?: string;
  /** 角色包描述 */
  readonly description?: string;
  /** 版本号 */
  readonly version?: string;
  /** 可选：作者/来源 */
  readonly author?: string;
  /** 格式版本（缺省按 1.0.0 处理） */
  readonly formatVersion?: string;
  /** 拟人化场景声明（tool_assistant=工具型默认 / companion=拟人化陪伴） */
  readonly interactionType?: 'tool_assistant' | 'companion';
  /** AI 身份标注（默认强制 true） */
  readonly aiIdentityDisclosure?: boolean;
  /** 未成年人保护（默认 required） */
  readonly minorProtection?: 'required';
  /** 接手衔接提示词：被宿主「带入对话」时预填的特色话术；角色包只描述自己，缺省由宿主回退通用话术 */
  readonly handoffPrompt?: string;
}

/**
 * 角色包（Role Pack）—— L1 内容层 + L2 策略层
 * 从角色包文件夹的 manifest.json（唯一权威控制文件）+ 独立内容文件（persona.md/rules.md/skills/*）装配而成。
 * 实现 ConfigResource 约束：name 从 meta 派生，content 从 personaContent 派生。
 */
export interface RolePack {
  /** 角色包名称（派生自 meta.name，满足 ConfigResource 约束） */
  readonly name: string;
  /** 内容正文（派生自 personaContent，满足 ConfigResource 约束） */
  readonly content: string;
  /** 来源文件路径（manifest.json 绝对路径，满足 ConfigResource 约束） */
  readonly filePath: string;

  /** 角色包元数据（manifest.json） */
  readonly meta: RolePackMeta;

  // ── L1 内容层（独立内容文件装载） ──

  /** 角色身份设定正文（来自 persona.md；persona 允许缺省，此时为空串） */
  readonly personaContent: string;
  /** 角色性格特征（traits），从 persona.md frontmatter 解析（traits.xxx = 0-1 数值），供宿主情感计算 */
  readonly traits?: Record<string, number>;
  /** 确定性规则列表（来自 rules.md，逐行解析）。安全规则，装载时全量注入，不可丢失 */
  readonly rules: readonly string[];
  /** 内嵌技能注册（manifest.skills 对象数组，各自引用包内技能文件 file 路径；能力声明已独立为顶层 capabilities） */
  readonly skills: readonly RolePackManifestSkill[];
  /** 能力声明（manifest.capabilities 顶层数组，独立于 skills——「能力面（权限）」与「内容面（技能正文）」分离） */
  readonly capabilities: readonly RolePackCapability[];

  // ── L2 策略层 ──

  /** 行为策略声明（manifest.strategy）；未配置的维度使用全局默认值 */
  readonly strategy?: BehaviorStrategy;

  /** 装配结果缓存（由 parseManifestPack 预计算；角色包装载后不可变，缓存安全） */
  readonly _cachedAssembly?: RolePackAssembly;
}

// ════════════════════════════════════════════════════════════
// 运行时类型
// ════════════════════════════════════════════════════════════

/** 角色包装载结果：供装配层直接注入 system prompt；strategy 已合并默认值成为完整策略 */
export interface RolePackAssembly {
  /** 角色包元数据 */
  readonly meta: RolePackMeta;
  /** 来源文件路径（manifest.json 绝对路径，2026-08-30 透传，供宿主区分内置/用户来源） */
  readonly filePath: string;
  /** 合并后的 persona prompt（含规则注入与主动提问指令） */
  readonly personaPrompt: string;
  /** 内嵌技能注册（manifest.skills，对象数组，支持多个） */
  readonly skills: readonly RolePackManifestSkill[];
  /** 能力声明列表（manifest 顶层 capabilities） */
  readonly capabilities: readonly RolePackCapability[];
  /** 完整行为策略（所有维度都有值，未声明维度用默认值，异于 RolePack.strategy） */
  readonly strategy: BehaviorStrategy;
  /** 角色性格特征（traits），从 persona.md frontmatter 解析（traits.xxx = 0-1 数值），供宿主情感计算 */
  readonly traits?: Record<string, number>;
  /** manifest 校验问题（G29 健康徽章数据源）：装载时 validateManifest 全量 issues（含 warning）。
   *  可选向后兼容（旧装配无此字段）；宿主 UI 据此叠加健康徽章 + 问题列表，镜像技能 G22 徽章模式。 */
  readonly validationIssues?: readonly RolePackValidationIssue[];
}


// manifest.json 内容注册（文件夹形态核心控制文件）

/** manifest.json 中注册的技能对象：以对象数组引用包内技能文件（相对包根路径），可选 name/description */
export interface RolePackManifestSkill {
  /** 技能文件路径（相对角色包文件夹根）；生态兼容指针，内核不预装载正文，正文经渐进披露 L2（read_skill）按需装载 */
  readonly file?: string;
  /** 技能名（可选，缺省取文件名去扩展名） */
  readonly name?: string;
  /** 技能说明（可选，供 LLM 与校验器理解） */
  readonly description?: string;
  /** L3 层数据（资源 + 脚本）：由 scanPackSkills 装载时自动发现；L3 不进 system prompt，按需调用 */
  readonly layer3?: {
    readonly resources: ReadonlyArray<{
      readonly path: string;
      readonly size: number;
      /** 资源来源子目录（resources/references，B1 兼容主流 references/ 辅助文档目录），read_resource 据此选择读取基目录 */
      readonly subdir?: 'resources' | 'references';
    }>;
    readonly scripts: ReadonlyArray<{
      readonly path: string;
      readonly runtime: 'node' | 'python' | 'shell';
      readonly size: number;
    }>;
  };
  /** 技能正文缓存（load 时预装载，readSkillContent 直取；null=未缓存，undefined=未装载懒加载） */
  readonly content?: string | null;
}

