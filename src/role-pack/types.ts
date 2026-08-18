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

/**
 * Loop 续跑轮次（Phase 9：自审查轮次可配置）
 *
 * number 语义：0=关闭自审查续跑 / N=LLM 纯文本回复后最多自审查 N 轮。
 * 由 `on|off` 自然生长为 number（旧值 'on' 视作 1 轮、'off' 视作 0 轮，见 agent.ts 归一化）。
 */
export type LoopContinue = number;

/** 摘要生成开关（on=生成摘要 / off=不生成） */
export type Summary = 'on' | 'off';

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
  /**
   * 理解确认模式（默认 off）
   *
   * ⚠️ **预留键，不承诺当前生效**：
   * 此字段仅用于设计空间预留，内核当前不消费此配置。
   * 角色包可声明，但当前行为不受其影响。
   */
  readonly understandingConfirm?: UnderstandingConfirm;
  /** 上下文装配策略（默认 hybrid） */
  readonly contextAssembly?: ContextAssembly;
  /** 固定加载的最近轮次数（默认 3） */
  readonly recentRounds?: number;
  /** 记忆召回模式（默认 full） */
  readonly memoryRecall?: MemoryRecallMode;
  /** 记忆占用上限 token 数（默认 2000） */
  readonly memoryRecallQuota?: number;
  /** 摘要召回开关（默认 on）[Phase 2 已消费] */
  readonly summaryRecall?: SummaryRecall;
  /** 召回保底下限：语义召回不足时用最近记忆补足至该条数（0=关闭，默认 2） */
  readonly minFallback?: number;
  /** 召回结果相似度阈值 0.0~1.0（默认 0.6）[Phase 2 已消费] */
  readonly recallConfidence?: number;
  /**
   * 任务分类方式（默认 keyword）
   *
   * ⚠️ **预留键，不承诺当前生效**：
   * 此字段仅用于设计空间预留，内核当前不消费此配置。
   * 角色包可声明，但当前行为不受其影响。
   */
  readonly taskClassification?: TaskClassification;
  /**
   * 角色包提炼视角（可选，默认 undefined=通用浓缩）
   *
   * 控制 round-summary 生成时「值得记什么」的判断视角（提炼侧视角下沉）。
   * 领域无关机制：内核不预设内容，由角色包注入领域重视的信息维度与保留形式
   * （如编程卡声明保留代码/diff/表格，覆盖意图/决策等维度；替换通用"意图/回答/
   * 决策"归纳框架，JSON 输出与 SummaryType 硬契约保留）。非结构化领域不声明 →
   * 摘要行为与现状完全一致。
   */
  readonly summaryFocus?: string;
  /** 自动匹配开关（默认 on）[Tier 3 已消费] */
  readonly autoSwitch?: AutoSwitch;
}

/**
 * 回答中（Act）行动策略集合
 */
export interface ActStrategy {
  /** 工具调用模式（默认 allow；标准键 act.toolMode，§六） */
  readonly toolMode?: ToolMode;
  /** 工具批准模式（默认 auto）[Phase 3 已消费] */
  readonly toolApproval?: ToolApproval;
  /** 工具操作范围（默认 full）[Phase 3 已消费] */
  readonly toolReadonly?: ToolReadonly;
  /** 单轮工具调用步数上限（默认 20） */
  readonly toolStepLimit?: number;
  /** 生成流式模式（默认 streaming） */
  readonly streaming?: StreamingMode;
  /** 生成温度 0.0~2.0（默认 0.7） */
  readonly temperature?: number;
  /** 单轮回答长度上限 token 数（默认 4096） */
  readonly outputLimit?: number;
  /** Provider 路由策略（默认 auto）[Tier 3 已消费] */
  readonly providerRouting?: ProviderRouting;
  /** 多步推理模式（默认 auto）[Phase 1 已消费] */
  readonly multiStepReasoning?: MultiStepReasoning;
  /** 输入中断策略（默认 allow）[Tier 3 已消费] */
  readonly inputInterrupt?: InputInterrupt;
}

/**
 * 回答后（Reflect）沉淀策略集合
 */
export interface ReflectStrategy {
  /** 结束衔接模式（默认 wait；标准键 reflect.handoff，§六） */
  readonly handoff?: Handoff;
  /** Loop 续跑轮次（默认 0=关闭；0=关闭自审查 / N=最多自审查 N 轮） */
  readonly loopContinue?: LoopContinue;
  /** 摘要生成开关（默认 on；标准键 reflect.summary） */
  readonly summary?: Summary;
  /**
   * 记忆写入模式（默认 auto）
   *
   * ⚠️ **预留键，不承诺当前生效**：
   * 此字段仅用于设计空间预留，内核当前不消费此配置。
   * 角色包可声明，但当前行为不受其影响。
   */
  readonly memoryWrite?: MemoryWriteMode;
  /**
   * 会话归档模式（默认 auto）
   *
   * ⚠️ **预留键，不承诺当前生效**：
   * 此字段仅用于设计空间预留，内核当前不消费此配置。
   * 角色包可声明，但当前行为不受其影响。
   */
  readonly sessionArchive?: SessionArchiveMode;
  /** 用户追问策略（默认 silent） */
  readonly userFollowup?: UserFollowup;
}

/**
 * 跨阶段全局策略集合
 */
export interface GlobalStrategy {
  /** 每轮总 token 上限（默认 8000）[Tier 3 已消费] */
  readonly tokenBudget?: number;
  /** 每轮工具步数上限（默认 50）[Tier 3 已消费] */
  readonly stepBudget?: number;
  /**
   * 单任务总成本上限，0=不限制（默认 0）
   *
   * ⚠️ **预留键，不承诺当前生效**：
   * 此字段仅用于设计空间预留，内核当前不消费此配置。
   * 角色包可声明，但当前行为不受其影响。
   */
  readonly costBudget?: number;
  /** 异常时的处理策略（默认 retry） */
  readonly errorHandling?: ErrorHandling;
  /**
   * 是否允许角色覆盖全局安全规则（默认 inherit=不可覆盖）
   *
   * ⚠️ **预留键，不承诺当前生效**：
   * 此字段仅用于设计空间预留，内核当前不消费此配置。
   * 角色包可声明，但当前行为不受其影响。
   */
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
 *
 * ⚠️ **诚实化声明（预留键治理，role-pack-spec §五）**：
 * 本集合是"设计空间"，不是"承诺面"——**以下字段被内核实际消费并影响行为**：
 *   - prepare：recentRounds / memoryRecall / memoryRecallQuota / minFallback / summaryFocus / contextAssembly / autoSwitch / recallConfidence / summaryRecall
 *   - act：toolMode / temperature / outputLimit / streaming / toolStepLimit / providerRouting / inputInterrupt / multiStepReasoning / toolReadonly / toolApproval
 *   - reflect：summary / handoff / loopContinue / userFollowup
 *   - global：askOn / askLimit / errorHandling / tokenBudget / stepBudget
 *
 * **以下字段为"预留键"，内核当前不消费，声明不生效**：
 *   - prepare.understandingConfirm / prepare.taskClassification
 *   - reflect.memoryWrite / reflect.sessionArchive
 *   - global.costBudget / global.safetyRule
 *
 * 预留键仅用于未来行为分支的设计空间预留，角色包作者可声明但不应期待当前版本生效。
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
 * 能力声明（manifest.skills 中带 capability 的项派生）
 *
 * 对齐 role-pack-spec §四：以中立能力命名空间声明（`file:write` / `web:search`），
 * 由各实现映射到自有工具；不绑具体实现（见 capabilityMap.ts SSOT 映射表）。
 * 由 RolePackManager 从 manifest.skills 中筛选出声明了 capability 的项派生。
 */
export interface RolePackCapability {
  /** 中立能力名（如 `file:write` / `web:search` / `llm:summarize`） */
  readonly capability: string;
  /** 可选：能力说明（供 LLM 与校验器理解） */
  readonly description?: string;
}

/**
 * 角色包元数据（manifest.json 解析结果）
 *
 * 用于匹配、传播、版本管理。
 */
export interface RolePackMeta {
  /** 角色包名称（唯一标识） */
  readonly name: string;
  /**
   * UI 展示名（可选，manifest.displayName）
   *
   * 与 name 的职责分离：name 是内部唯一标识（可英文），displayName 是面向用户的
   * 本地化展示名。缺省回退 name（SSOT：显示名单一来源 = displayName ?? name）。
   * 插件宿主从 listMeta() 读取，替代 UI 层硬编码角色名映射。
   */
  readonly displayName?: string;
  /** 角色包描述 */
  readonly description?: string;
  /** 版本号 */
  readonly version?: string;
  /** 触发关键词（用于自动匹配） */
  readonly keywords?: readonly string[];
  /**
   * 触发词（role-pack-spec §二/§三 字段）
   *
   * 与 keywords 语义互补：解析时合并进匹配词，保证仅声明 trigger 的角色包
   * 也能被自动匹配命中（单一真理源：匹配词只有一个来源 keywords）。
   * 本字段保留 spec 原始值供展示/校验，消费方统一读 keywords。
   *
   * 注意：角色包 trigger 为**字符串数组**（精确/包含匹配），不是正则。
   * 正则匹配能力仅在 Skill 系统中存在（skill.trigger → parseTrigger → RegExp.test）。
   * 角色包匹配场景为"模糊语义角色切换"，关键词匹配已足够；
   * Skill 匹配场景为"精确工具/技能触发"，需要正则精度。
   */
  readonly trigger?: readonly string[];
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
  /**
   * 互斥角色包名列表（agent-design-philosophy §6.2 粘性匹配）
   *
   * 声明与该角色包互斥的其他角色包。粘性锁定时，仅当输入命中当前激活包
   * 的互斥包（exclusiveWith 双向声明其一）才自动切换；非互斥命中不切换
   * （多角色合并裁决为远期，见 role-pack-spec §14.2）。
   */
  readonly exclusiveWith?: readonly string[];
  /**
   * 接手衔接提示词（可选，角色包自洽声明）
   *
   * 该角色包被宿主「带入对话」（激活 + 聚焦）时，预填输入框的特色衔接话术。
   * 与跨包移交（handoff target）无关——角色包只描述自己，不引用其他角色包
   * （角色包独立自洽，§11 插卡解耦）。缺省由宿主回退通用话术。
   */
  readonly handoffPrompt?: string;
}

/**
 * 角色包（Role Pack）—— L1 内容层 + L2 策略层
 *
 * 设计文档第十三章定义的三层结构，当前实现 L1 + L2。
 * L3 代码层为远期预留，当前不设计。
 *
 * 装载形状：从角色包文件夹的 manifest.json（核心控制文件）+ 独立内容文件
 * （persona.md / rules.md / skills/*）装配而成。manifest 是元数据与策略的唯一权威，
 * 内容文件按路径注册装载，用户可独立移植内容文档，也可整体装载角色包。
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
  /** 来源文件路径（manifest.json 绝对路径，满足 ConfigResource 约束） */
  readonly filePath: string;

  /** 角色包元数据（manifest.json） */
  readonly meta: RolePackMeta;

  // ── L1 内容层（独立内容文件装载） ──

  /** 角色身份设定正文（来自 persona.md；persona 允许缺省，此时为空串） */
  readonly personaContent: string;
  /**
   * 角色性格特征（traits），供宿主情感计算（如 affectController）
   * 从 persona.md 的 frontmatter 中解析（traits.xxx = 0-1 数值）
   * 示例：{ playfulness: 0.9, warmth: 0.7, formality: 0.3 }
   */
  readonly traits?: Record<string, number>;
  /**
   * 确定性规则列表（来自 rules.md，逐行解析）
   * 安全规则，装载时全量注入，不可丢失
   */
  readonly rules: readonly string[];
  /**
   * 内嵌技能注册（manifest.skills 对象数组，支持多个添加）
   * 每个对象引用包内技能文件（file 路径），可选声明 name/description。
   * 能力声明已独立为顶层 capabilities（2026-08-18 C2）——skills 回归纯技能文件引用。
   */
  readonly skills: readonly RolePackManifestSkill[];
  /**
   * 能力声明（manifest.capabilities 顶层数组，2026-08-18 C2）
   *
   * 独立于 skills 的一级字段：声明角色可调用的中立能力（工具白名单面），
   * 与技能文件解耦——「能力面（权限）」与「内容面（技能正文）」分离。
   */
  readonly capabilities: readonly RolePackCapability[];

  // ── L2 策略层 ──

  /**
   * 行为策略声明（manifest.strategy）
   * 未配置的维度使用全局默认值。角色包可以只声明它想改变的部分。
   */
  readonly strategy?: BehaviorStrategy;

  /**
   * 装配结果缓存（Bug 5 修复：getActive/get 返回缓存，避免重复 mergeStrategy + prompt 构建）
   *
   * 由 parseManifestPack 在创建 RolePack 时预计算并缓存。
   * 角色包装载后不可变，缓存安全。
   */
  readonly _cachedAssembly?: RolePackAssembly;
}

// ════════════════════════════════════════════════════════════
// 运行时类型
// ════════════════════════════════════════════════════════════

/**
 * 角色包装载结果
 *
 * 装配层将角色包解析为可直接注入 system prompt 的片段。
 * 与原始 RolePack 的区别：strategy 字段已合并默认值成为完整策略，
 * capabilities 已从 skills 中派生为能力声明列表。
 */
export interface RolePackAssembly {
  /** 角色包元数据 */
  readonly meta: RolePackMeta;
  /** 合并后的 persona prompt（含规则注入与主动提问指令） */
  readonly personaPrompt: string;
  /** 内嵌技能注册（manifest.skills，对象数组，支持多个） */
  readonly skills: readonly RolePackManifestSkill[];
  /** 能力声明列表（由 skills 中声明了 capability 的项派生） */
  readonly capabilities: readonly RolePackCapability[];
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
// manifest.json 内容注册（文件夹形态核心控制文件）
// ════════════════════════════════════════════════════════════

/**
 * manifest.json 中注册的技能对象（角色包文件夹形态 §2.2）
 *
 * 新形态下 skills 以**对象数组**注册，支持多个添加。每个对象引用包内技能文件
 * （相对包根的路径）或已注册技能名，并可选携带中立能力声明（capability）与说明。
 * 与旧 `RolePackSkillRef`（仅 name+contextHint）的关系：本类型是 manifest 层的
 * 注册形状，装载时由 RolePackManager 转译为 RolePackSkillRef / RolePackCapability。
 */
export interface RolePackManifestSkill {
  /**
   * 技能文件路径（相对角色包文件夹根）或已注册技能名（可选）
   *
   * 生态兼容指针（role-pack-spec §四）：供主流 skills 生态互认/移植，内核**不装载正文**。
   * 技能正文经渐进披露 L2（read_skill）按需装载（2026-08-18 两级技能统一）。
   * 能力声明已独立为 manifest 顶层 capabilities（C2）——skills 项不再携带 capability。
   */
  readonly file?: string;
  /** 技能名（可选，缺省取文件名去扩展名） */
  readonly name?: string;
  /** 技能说明（可选，供 LLM 与校验器理解） */
  readonly description?: string;
  /**
   * L3 层数据（资源 + 脚本，可选）
   *
   * 由 scanPackSkills 在装载时自动发现（扫描技能目录下的 resources/ 和 scripts/）。
   * 三级渐进披露：L3 内容不进 system prompt，由 read_resource / run_skill_script 按需调用。
   */
  readonly layer3?: {
    readonly resources: ReadonlyArray<{ readonly path: string; readonly size: number }>;
    readonly scripts: ReadonlyArray<{ readonly path: string; readonly runtime: 'node' | 'python' | 'shell'; readonly size: number }>;
  };
  /**
   * 技能正文缓存（Bug 4 修复：与全局技能一致，load 时预装载）
   *
   * 由 parseManifestPack 在装载时读取并缓存，readSkillContent 直接返回缓存。
   * null = 未缓存（读失败或文件不存在），undefined = 未装载（懒加载策略）。
   */
  readonly content?: string | null;
}

/**
 * manifest.json 解析结果（文件夹形态核心控制文件）
 *
 * manifest 是文件夹形态角色包的**唯一权威**（单一真理源）：承载元数据 + L2 策略 +
 * 内容路径注册。内容文件（persona.md / rules.md / skills/*）独立于 manifest，
 * 由 manifest 按路径注册装载——用户既可独立移植这些文档，也可整体装载角色包。
 *
 * persona 允许缺省（角色包可无身份设定，仅靠策略驱动行为）。
 */
export interface RolePackManifestFile {
  /** 元数据（名称 / 版本 / 关键词 / 合规字段等） */
  readonly meta: RolePackMeta;
  /** 行为策略声明（L2，未配置维度由 mergeStrategy 补默认值） */
  readonly strategy?: BehaviorStrategy;
  /**
   * persona 文件路径（相对包根；null = 未声明）
   *
   * 2026-08-18 简化：persona 约定俗成为 `persona.md`（与 rules.md 对称）——
   * 未声明时装载层回退约定名（rolePackManager DEFAULT_PERSONA_FILENAME）。
   * persona 仍允许缺省（无身份设定，仅靠策略驱动行为）。
   */
  readonly persona: string | null;
  /**
   * rules 文件路径（相对包根；null = 未声明）
   *
   * 2026-08-18 简化：rules 约定俗成为 `rules.md`——未声明时装载层回退约定名
   * （rolePackManager DEFAULT_RULES_FILENAME），manifest 声明仅为向后兼容的自由命名。
   */
  readonly rules: string | null;
  /** 内嵌技能注册（对象数组，支持多个添加） */
  readonly skills: readonly RolePackManifestSkill[];
}

// 策略解析与默认值已迁移至 strategyResolver.ts
// 为保持向后兼容，重新导出所有公开 API
export {
  DEFAULT_RECENT_HISTORY_ROUNDS,
  DEFAULT_BEHAVIOR_STRATEGY,
  resolveRecentRounds,
  resolveHandoff,
  resolveMemoryRecallMode,
  resolveMinFallback,
  resolveSummaryFocus,
  resolveToolMode,
  resolveSummary,
  resolveContextAssembly,
  resolveToolStepLimit,
  resolveErrorHandling,
  resolveAutoSwitch,
  resolveProviderRouting,
  resolveInputInterrupt,
  resolveTokenBudget,
  resolveStepBudget,
  resolveMemoryWrite,
  resolveSessionArchive,
  resolveMultiStepReasoning,
  resolveRecallConfidence,
  resolveSummaryRecall,
  resolveToolReadonly,
  resolveToolApproval,
  mergeStrategy,
  assembleRolePack,
} from './strategyResolver.js';
