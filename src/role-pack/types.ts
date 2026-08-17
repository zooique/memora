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
// 召回保底下限默认值：跨层共享（role-pack 与 memory 均引用），SSOT 单一来源
import { DEFAULT_MIN_FALLBACK } from '@/utils/recallDefaults.js';

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
  /** 召回保底下限：语义召回不足时用最近记忆补足至该条数（0=关闭，默认 2） */
  readonly minFallback?: number;
  /** 召回结果相似度阈值 0.0~1.0（默认 0.6） */
  readonly recallConfidence?: number;
  /** 任务分类方式（默认 keyword） */
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
  /** 角色自动匹配开关（默认 on） */
  readonly autoSwitch?: AutoSwitch;
}

/**
 * 回答中（Act）行动策略集合
 */
export interface ActStrategy {
  /** 工具调用模式（默认 allow；标准键 act.toolMode，§六） */
  readonly toolMode?: ToolMode;
  /**
   * @deprecated 僵尸键（未接入，role-pack-spec §五）：内核工具暴露面由 capabilities
   * 派生（agent.ts applyRolePackToolExposure），不读本字段。空数组语义不参与运行时。
   */
  readonly toolWhitelist?: readonly string[];
  /**
   * @deprecated 僵尸键（未接入，role-pack-spec §五）：同上，不参与运行时工具暴露。
   */
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
  /** Loop 续跑轮次（默认 0=关闭；0=关闭自审查 / N=最多自审查 N 轮） */
  readonly loopContinue?: LoopContinue;
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
 *
 * ⚠️ 诚实化声明（僵尸键治理，role-pack-spec §五）：
 * 本集合是"设计空间"，不是"承诺面"——**仅以下字段被内核实际消费并影响行为**：
 *   - prepare：recentRounds / memoryRecall / memoryRecallQuota
 *   - act：toolMode
 *   - reflect：handoff / loopContinue / userFollowup
 *   - global：askOn / askLimit
 * 其余字段（含 toolWhitelist / toolBlacklist 已标 @deprecated）均为**僵尸键**：
 * 角色包可声明，但内核当前不读取、声明不生效——它们承载未来行为分支的
 * 设计空间全景（见 agent-design-philosophy 设计空间表格），尚未接入。消费方
 * 参照此清单，避免误以为"声明即生效"。
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
   * 交接声明（宿主侧键，对齐 VS Code custom agents handoffs）
   *
   * 作者静态声明「任务完成后可移交给谁」（RolePackHandoff）。内核透传不消费，
   * 宿主渲染交接按钮 + 预填衔接文本（target 不存在时按钮不渲染）。
   */
  readonly handoffs?: readonly RolePackHandoff[];
}

/**
 * 角色包交接声明（manifest.handoffs，宿主侧键，对齐 VS Code custom agents handoffs）
 *
 * 语义：角色包作者静态声明「我完成任务后可以把任务移交给谁」。内核**只透传不消费**
 * （单 Agent 模型下无 Agent 间转移语义，§10），由宿主消费——渲染交接按钮 + 预填衔接文本。
 * 与 strategy.reflect.handoff（wait/loop/end，单轮闭环内衔接决策）是两种不同维度：
 * 前者是「空间」——任务移交给另一个角色包；后者是「时间」——本轮闭环内下一步。
 *
 * 渐进兼容（§五）：不认识的实现按未知键 warn+ignore 装载，不阻塞。
 * target 指向的角色包在宿主环境不存在时，宿主**不渲染**该交接按钮（存在性过滤，
 * 非报错）；send 字段 MVP 宿主不消费（保持不自动发送），仅透传+校验 boolean。
 */
export interface RolePackHandoff {
  /** 按钮文案（必填，宿主渲染交接按钮） */
  readonly label: string;
  /** 目标角色包名（必填，跨包移交） */
  readonly target: string;
  /** 预填衔接文本（可选，宿主 prefill 输入框；缺省由宿主回退通用话术） */
  readonly prompt?: string;
  /** 是否自动发送（可选，默认 false；MVP 宿主不消费，仅透传+校验） */
  readonly send?: boolean;
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
   * 确定性规则列表（来自 rules.md，逐行解析）
   * 安全规则，装载时全量注入，不可丢失
   */
  readonly rules: readonly string[];
  /**
   * 内嵌技能注册（manifest.skills 对象数组，支持多个添加）
   * 每个对象引用包内技能文件（file 路径），可选声明 name/description/capability
   */
  readonly skills: readonly RolePackManifestSkill[];

  // ── L2 策略层 ──

  /**
   * 行为策略声明（manifest.strategy）
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
   * 内核唯一行为入口是 `capability`（派生工具暴露面）；file 仅作元信息，不承诺执行。
   * 支持**纯能力声明**（仅 capability、无 file）：声明角色可调用某中立能力，无具体技能文件。
   * file 与 capability 至少其一（§四）。
   */
  readonly file?: string;
  /** 技能名（可选，缺省取文件名去扩展名） */
  readonly name?: string;
  /** 技能说明（可选，供 LLM 与校验器理解） */
  readonly description?: string;
  /** 可选：中立能力声明（capability: '域:动作'，§四，如 file:write） */
  readonly capability?: string;
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
  /** persona 文件路径（相对包根；null = 未声明，persona 允许缺省） */
  readonly persona: string | null;
  /** rules 文件路径（相对包根；null = 未声明） */
  readonly rules: string | null;
  /** 内嵌技能注册（对象数组，支持多个添加） */
  readonly skills: readonly RolePackManifestSkill[];
}

// ════════════════════════════════════════════════════════════
// 策略默认值收敛
// ════════════════════════════════════════════════════════════

/**
 * 上下文固定加载轮数 N 的内核默认值（SSOT 单一默认真理源）
 *
 * 语义（memory-as-summary §4.3）：N ≡ 上下文固定加载的完整对话轮数，
 * 互斥窗口（排除正文已加载轮次的摘要）与最近对话注入共享同一 N，
 * 保证"正文加载 N 轮 ⟺ 互斥排除 N 轮"严格一致。
 * 角色包可经 `prepare.recentRounds` 覆盖；仅在角色包未声明或声明非法时
 * 降级回本默认。agent 层 `AGENT_CONSTANTS.DEFAULT_RECENT_HISTORY_ROUNDS`
 * 引用本常量，避免同一维度出现两套平行默认值。
 */
export const DEFAULT_RECENT_HISTORY_ROUNDS = 3;

/**
 * 解析上下文固定加载轮数 N（SSOT 单一来源）
 *
 * 规则：角色包声明的 `prepare.recentRounds` 为合法的"0 以上正整数"时，
 * **一律采用角色包定义**；仅在缺失/不存在、非整数、<=0 等非法情形才降级
 * 为内核默认 `DEFAULT_RECENT_HISTORY_ROUNDS`。
 *
 * 互斥窗口（`getRecentRoundIds`）与最近对话注入（`getRecentHistory`）必须共用
 * 本函数返回值——二者任一单独取数都会造成"正文加载轮数与互斥排除轮数不一致"，
 * 导致第 N 轮内摘要与正文重复注入（memory-as-summary §4.3 的严格相等被破坏）。
 *
 * @param strategy 已合并默认值的完整行为策略（无激活角色包时传 undefined）
 * @returns 合法的固定加载轮数 N（>0 的整数）
 */
export function resolveRecentRounds(strategy: BehaviorStrategy | undefined): number {
  // 角色包定义优先：仅当声明的 recentRounds 是"0 以上正整数"才采用
  const candidate = strategy?.prepare?.recentRounds;
  const valid = typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0;
  return valid ? candidate : DEFAULT_RECENT_HISTORY_ROUNDS;
}

/**
 * 枚举值合法性收窄（SSOT 兜底）
 *
 * 角色包 L2 键是枚举开关，非法拼写/错误取值不应静默透传（handoff 会直接
 * yield 给宿主，其他枚举会污染行为分支）。统一在此归位到内核默认。
 *
 * @param value 角色包声明的原始值
 * @param allowed 合法枚举值集合
 * @param fallback 非法/缺失时的内核默认
 * @returns 合法值或内核默认
 */
function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * 解析衔接策略（SSOT）：非法值（非 wait/loop/end）归位 'wait'
 *
 * handoff 是唯一会作为 chunk 直接暴露给宿主的枚举——非法值必须归位，
 * 避免宿主收到无法识别的衔接决策。
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的 handoff 枚举值
 */
export function resolveHandoff(strategy: BehaviorStrategy | undefined): Handoff {
  return normalizeEnum(strategy?.reflect?.handoff, ['wait', 'loop', 'end'], 'wait');
}

/**
 * 解析记忆召回模式（SSOT）：非法值归位 'full'
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的记忆召回模式
 */
export function resolveMemoryRecallMode(strategy: BehaviorStrategy | undefined): MemoryRecallMode {
  return normalizeEnum(strategy?.prepare?.memoryRecall, ['full', 'limited', 'none'], 'full');
}

/**
 * 解析召回保底下限（SSOT）：非负整数才采用，非法/缺失回退内核默认
 *
 * 角色包 `prepare.minFallback` 控制"语义召回不足时用最近记忆补足至该条数"的行为。
 * 归位规则：仅当声明值是"非负整数"才采用；缺失、非整数、负数均回退
 * `DEFAULT_MIN_FALLBACK`（默认 2）。置 0 表示彻底关闭保底。
 *
 * @param strategy 合并后的行为策略
 * @returns 合法召回保底下限（>=0 的整数）
 */
export function resolveMinFallback(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.prepare?.minFallback;
  const valid = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0;
  return valid ? candidate : DEFAULT_MIN_FALLBACK;
}

/**
 * 解析角色包提炼视角（SSOT）：合法非空字符串采用，缺失/空白归位 undefined（通用浓缩）
 *
 * 领域无关机制：内核只提供"摘要提炼视角可被角色包注入"的通用能力，视角全文由角色包
 * 提供（如编程卡声明代码/diff/表格 + 意图/决策等维度）。声明时替换通用"意图/回答/
 * 决策"归纳框架（JSON 硬契约保留）；未声明 → undefined，round-summary 摘要行为与现状一致。
 *
 * @param strategy 合并后的行为策略
 * @returns 角色包提炼视角（无则 undefined=通用浓缩）
 */
export function resolveSummaryFocus(strategy: BehaviorStrategy | undefined): string | undefined {
  const candidate = strategy?.prepare?.summaryFocus;
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

/**
 * 解析工具调用模式（SSOT）：非法值归位 'allow'
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的工具调用模式
 */
export function resolveToolMode(strategy: BehaviorStrategy | undefined): ToolMode {
  return normalizeEnum(strategy?.act?.toolMode, ['allow', 'block'], 'allow');
}

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
    recentRounds: DEFAULT_RECENT_HISTORY_ROUNDS,
    memoryRecall: 'full',
    memoryRecallQuota: 2000,
    summaryRecall: 'on',
    minFallback: DEFAULT_MIN_FALLBACK,
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
    loopContinue: 0,
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

  // 能力声明：由 manifest.skills 中声明了 capability 的项派生（未声明能力 → 全部暴露）
  const capabilities: RolePackCapability[] = pack.skills
    .filter((s) => s.capability)
    .map((s) => ({ capability: s.capability!, description: s.description }));

  return {
    meta: pack.meta,
    personaPrompt,
    skills: pack.skills,
    capabilities,
    strategy,
  };
}