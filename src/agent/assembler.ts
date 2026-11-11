/**
 * Agent 组件组装器 — 从 Agent 门面类拆出的工厂逻辑
 *
 * 职责：
 *   - 创建并连接所有运行时组件（MessageHistory / AgentLoop / Managers）
 *   - 返回组装结果供 Agent 门面类持有
 *
 * 设计原则：
 *   - 纯工厂逻辑，不持有状态
 *   - Agent 门面类通过 assembleComponents() 获取组件引用
 *   - 组件间的依赖关系在此处显式声明
 *   - 角色相关功能统一由 RolePackManager 承载
 */

import { join } from 'node:path';
import { AgentLoop } from '@/agent/loop.js';
import { ToolExecutor } from '@/agent/toolExecutor.js';
// 子会话减法真源（deny 轴）、派发请求类型与结构化结果类型
import {
  SUBAGENT_DENIED_TOOLS,
  type DelegateTaskPortResult,
  type DelegateTaskRequest,
  type DelegateTaskResult,
  type DelegateTaskStatus,
} from '@/agent/toolExecutor.js';
// 执行流消费纯逻辑（子会话与父会话同一份正文累积/终态分类）
import {
  classifyExecutionStreamError,
  createExecutionStreamState,
  observeExecutionChunk,
  type ExecutionStreamState,
} from '@/agent/executionStream.js';
import type { SecurityGuard } from '@/security/pathGuard.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import type { IWebSearchProvider } from '@/web-search/types.js';
import type { IFetchProvider } from '@/web-fetch/types.js';
import type { IProjectSearchProvider } from '@/project-search/types.js';
import type { ImageReadPort } from '@/agent/types.js';
import { MessageHistory } from '@/agent/messageHistory.js';
import type { ProjectContext } from '@/memory/projectManager.js';
import { SkillManager } from '@/skill/skillManager.js';
import { WorkProjectionManager } from '@/agent/managers/workProjection.js';
import { ResidentRulesManager } from '@/agent/managers/residentRules.js';
import { SessionArchiver } from '@/agent/managers/sessionArchiver.js';
import { MemoryInspector } from '@/agent/managers/memoryInspector.js';
import { TextPolishManager } from '@/agent/managers/textPolishManager.js';
import { RoundSummaryGenerator } from '@/agent/managers/roundSummaryGenerator.js';
import { SessionManager } from '@/agent/managers/sessionManager.js';
// 输入增强管线（角色/记忆/技能增强的叶子逻辑）
import { ContextPreparer } from '@/agent/contextPreparer.js';
import { estimateTokensMessages } from '@/agent/contextManager.js';
// 工具幂等契约（接线下沉：onToolExecuted / preExecutionCheck 依赖幂等表 + 补偿判断）
import { BUILTIN_TOOL_IDEMPOTENCY, shouldSkipForIdempotency } from '@/agent/builtinTools.js';
// 任务表渲染（接线下沉：loop.getTaskTable 依赖）
import { renderTaskTable, buildCompletionVerifyNudge } from '@/agent/taskTableRenderer.js';
import { logger } from '@/logging/logger.js';

/** 截断优先复用 round-summary 的最大条数 */
const ROUND_SUMMARY_LOADER_MAX = 5;
import type { LlmProvider } from '@/llm/provider.js';
import { resolveBackgroundProvider } from '@/llm/backgroundProvider.js';
import type { ProviderRouter } from '@/llm/types.js';
import type {
  AgentConfig,
  PreExecutionResult,
  ToolExecutionRecord,
  IdempotencyLevel,
  HostEnvironmentInfo,
} from '@/agent/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
import { AGENT_EVENTS, type AgentEventName } from '@/utils/eventEmitter.js';
import { configError, toolError, ToolErrorCode } from '@/utils/errors.js';
// 角色包管理器（唯一角色真理源）
import { RolePackManager } from '@/role-pack/rolePackManager.js';
// run_team_meeting 会议实现（工具内嵌 LLM 调用；装配层持 provider + rolePackManager 闭包注入）
import { runTeamMeetingAssessment } from '@/agent/builtinToolHandlers.js';
// L3 脚本执行器（静态导入，避免每次调用动态加载）
import { runSkillScript } from '@/skill/skillScriptRunner.js';
// 技能脚本 runtime 类型（resolveSkillScriptTarget 返回值标注；执行面判据同一形态）
import type { ScriptRuntime } from '@/utils/scanner.js';
import { BackgroundTaskRegistry } from '@/agent/backgroundTasks.js';
import { BackgroundTaskScheduler } from '@/utils/backgroundTask.js';

/**
 * Turn 起始策略固定段（内核行为约束）。
 *
 * 约束式极简：只画"何时该查 / 何时该规划"的行为边界，不写步骤脚本
 * （对齐 Anthropic「目标+约束」指南——脚本化指示降低输出质量）。输出形态由 LLM 裁量。
 * 边界：与 search_memories 工具描述 / loop「记忆回想」软引导**不重复**——此处不点名"先回忆"
 * （记忆引导已两处，三处重复即带伤）。SSOT：本常量唯一真源，仅 buildSystemPromptPrefix 消费。
 */
const TURN_START_STRATEGY_PROMPT = `## Turn 起始策略
需要外部信息时，先调用工具调查再回答，不要凭记忆猜测；
任务需要多步推进时，使用任务表工具规划执行；
简单问题直接回答。`;

/**
 * 技能写入落点提示（固定段，≤5 行）
 *
 * 目的：让模型知道技能该写在哪、同名怎么处理——避免写到扩展内置目录（只读）
 * 或静默覆盖用户已有技能。
 * ⚠️ 事实同源：项目级目录只在**工作区已信任**时由宿主注入（信任门），未信任时该位置
 * 不生效，故段内显式标注，不做「恒可写」的谎报（prompt 事实须与执行路径同源）。
 */
const SKILL_WRITE_LOCATION_PROMPT = `## 技能落点
只写项目级 <工作区>/.memora/skills（需工作区受信任）。
不要直接写入用户级资产；不要静默覆盖用户已有的同名资产，需要改动时交由用户处理。
你能通过执行代码绕过路径限制，但不应绕过。`;

/**
 * 将宿主环境快照格式化为 system prompt 注入段（纯函数，命令执行能力方案 §10.4-②）
 *
 * 零解释转发：只做字段 → 文本的机械映射，不添加行为引导（环境事实自己会说话，
 * 「由模型自己决定」——Cline/Claude Code 共同点，见方案 §10.1）。
 * 全字段缺省/空 → 返回空串（调用方 filter(Boolean) 自动跳过，prompt 无空段）。
 *
 * @param env 宿主环境快照（IEnvironmentProvider.getEnvironment() 产出）
 * @param platform 平台判定（缺省 process.platform；参数化与 resolveShellCommand 同先例，供测试）
 * @returns 「## 运行环境」段落（可能为空串）
 */
export function buildEnvironmentContextBlock(
  env: HostEnvironmentInfo | null,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!env) return '';
  const lines: string[] = [];
  if (env.os) lines.push(`- 操作系统：${env.os}`);
  if (env.shell) lines.push(`- 默认 Shell：${env.shell}`);
  // Windows 编码事实（内核自陈执行器行为，非宿主快照字段）：run_command 的 cmd
  // 管道输出按系统 OEM 代码页写出（2026-10-08 实证：简中系统 chcp 65001 下仍输出
  // GBK 字节 d6d0-cec4…），而内核执行器恒按 UTF-8 解码（skillScriptRunner 收流点）
  // → 非 ASCII 输出乱码、ASCII 不受影响。只写事实链不写行为引导（对齐本函数
  // 「零解释」纪律，模型据「Node 脚本输出为 UTF-8」可自行推出中文场景的选型）。
  if (platform === 'win32') {
    lines.push(
      '- 命令输出编码：cmd 管道输出按系统 OEM 代码页写出（简中系统为 GBK），内核按 UTF-8 解码——' +
        '非 ASCII 输出会显示为乱码（ASCII 不受影响）；Node 脚本输出为 UTF-8',
    );
  }
  if (env.runtimes && env.runtimes.length > 0) {
    lines.push(`- 可用运行时：${env.runtimes.join('、')}`);
  }
  // 宿主自定的回答语言指令行：**零解释转发**（措辞与语言判定全在宿主，内核不解析、
  // 不裁决、不追加引导语）。置于段末 = 最接近用户消息，模型注意力位。
  // 与上文「环境事实自己会说话、不写行为引导」的纪律不冲突：本行不是内核写的行为引导，
  // 而是宿主上报的原文；上面三个字段的格式化路径一字未改。
  if (env.responseLanguageDirective) lines.push(env.responseLanguageDirective);
  // 无任何有效字段 → 不产生空壳标题（防 prompt 出现「## 运行环境」下无内容的谎言段）
  if (lines.length === 0) return '';
  return `## 运行环境\n\n${lines.join('\n')}`;
}

/**
 * 构建 systemPromptPrefix 的共享函数（SSOT）
 *
 * 初始化时和刷新时都必须使用此函数，确保前缀包含：
 *   1. 角色包 L1 persona + 技能清单（rolePackPrompt）
 *   2. 项目规则段（residentRulesContext，可选：清单里 resident=true 的条目正文）
 *   3. 全局技能 L1 清单（globalSkillList）
 *   4. 技能落点固定段（SKILL_WRITE_LOCATION_PROMPT）
 *   5. 作品投影装配注入块（workProjectionContext，可选：极简元数据清单，AI 按需 read_file）
 *   6. 运行环境事实段（environmentContext，可选：宿主上报的 OS/shell/运行时）
 *   7. 当前时间戳
 *   8. Turn 起始策略固定段
 *   9. 分隔线
 *
 * 必须包含全局技能清单和时间戳——若只拼接 rolePackPrompt，
 * 首次角色切换后全局技能永久不可见。
 * 本函数作为唯一真理源，两处调用均走此处。
 *
 * @param rolePackPrompt 角色包构建的 prompt（含 L1 persona + 角色包技能清单）
 * @param globalSkillList 全局技能清单（SkillManager.buildSkillList()）
 * @param locale 时间格式化 locale
 * @param workProjectionContext 作品投影装配注入块（可选；由 WorkProjectionManager.loadAndGetContextBlock() 产出）
 * @param environmentContext 运行环境事实段（可选；由 buildEnvironmentContextBlock 格式化宿主快照产出）
 * @param residentRulesContext 项目规则段（可选；由 ResidentRulesManager.contextBlock() 产出，空串不注入）
 * @returns 完整的 systemPromptPrefix
 */
export function buildSystemPromptPrefix(
  rolePackPrompt: string,
  globalSkillList: string,
  locale?: string,
  workProjectionContext?: string,
  environmentContext?: string,
  residentRulesContext?: string,
): string {
  const systemPrefixParts = [
    rolePackPrompt,
    // 项目规则段：紧跟角色包之后 —— 段内自陈「本段 > 角色包规则 > 技能清单等资料」，
    // 位置即优先级声明的一部分；未信任 / 无常驻条目时空串，filter(Boolean) 自动跳过。
    residentRulesContext,
    globalSkillList,
    // 技能落点提示（固定事实段）：紧贴技能清单，模型看完「有哪些技能」即看到「新技能写哪」。
    // 无条件注入（无技能时用户仍可能要求创建技能）；SSOT = SKILL_WRITE_LOCATION_PROMPT。
    SKILL_WRITE_LOCATION_PROMPT,
    workProjectionContext,
    environmentContext,
  ].filter(Boolean);
  const now = new Date();
  const timeStr = now.toLocaleString(locale ?? AGENT_CONSTANTS.DEFAULT_LOCALE, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  systemPrefixParts.push(`当前时间：${timeStr}（${tz}）`);
  // 内核固定行为段：Turn 起始策略，放时间戳后（最接近用户消息，LLM 注意力位）。
  // 单点注入（SSOT）：TURN_START_STRATEGY_PROMPT 常量唯一真源，本函数是唯一消费点；
  // 初始化/刷新共用本函数，角色切换不丢失。
  systemPrefixParts.push(TURN_START_STRATEGY_PROMPT);
  // 时间戳与 Turn 起始策略无条件 push，systemPrefixParts 恒非空（len ≥ 2）——
  // 分隔线无条件追加（各段均无条件 push，无需 filter(Boolean) 兜底）。
  return systemPrefixParts.join('\n\n') + '\n\n---\n\n';
}

// ─── 子会话（delegate_task）装配 ─────────────────────────────

/**
 * 可在子会话中按 capabilities 授予的联网能力 → 工具名映射
 *
 * 唯一允许的两种能力（其余值一律拒绝，不做「尽力而为之」的降级）。
 * 未来新增能力必须同时在此登记并在 `ToolExecutor` 对应的条件工具上接线。
 */
const SUBAGENT_GRANTABLE_CAPABILITIES: ReadonlyMap<string, string> = new Map([
  ['web:search', 'web_search'],
  ['web:fetch', 'web_fetch'],
]);

/** 子会话结果正文截断上限（字符）：防止一次派发把父上下文撑爆（评估文档定案 20,000） */
const SUBAGENT_RESULT_MAX_CHARS = 20_000;

/**
 * 同一步并发子会话上限（派发端口信号量硬限，超出直接报错而非排队）
 *
 * 导出仅供测试与调用方文档引用，避免上限值在注释 / 用例里各写一遍。
 */
export const SUBAGENT_MAX_CONCURRENT = 2;

/**
 * 子会话装配参数（父装配期捕获的快照，逐次派发复用）
 *
 * 刻意与 `AssembleInput` 分开：子会话只取「只读世界」所需的最小面，
 * 不携带宿主自定义工具注册表 / preExecutionCheck / onToolExecuted（那些会写父状态）。
 */
export interface SubagentRuntimeParams {
  /** 前台 LLM provider（子会话与父同一模型路由） */
  provider: LlmProvider;
  /** 项目根目录（路径闸与工具根） */
  projectPath: string;
  /** 路径安全守卫（与父共用只读能力，不新建第二套路径规则） */
  security: SecurityGuard;
  /** 记忆索引（只读检索 + accessedAt 元数据更新） */
  memoryIndex: IMemoryStorage;
  /** 会话存储（只读能力：search_memories 的排除集与溯源） */
  sessionStore?: ISessionStore;
  /** 联网搜索提供者（仅 web:search 能力授予时装配） */
  webSearchProvider?: IWebSearchProvider;
  /** 网页抓取提供者（仅 web:fetch 能力授予时装配） */
  fetchProvider?: IFetchProvider;
  /** 项目检索提供者（只读，默认注入） */
  projectSearchProvider?: IProjectSearchProvider;
  /** 图片按路径摄取端口（只读，透传） */
  imageReadPort?: ImageReadPort;
  /** 脚本 node 路径（子会话仍禁用脚本工具，保留仅为构造签名一致） */
  scriptNodePath?: string;
  /** 上下文窗口上限（继承父配置口径） */
  maxContextTokens?: number;
  /** 输出预算（继承父配置口径） */
  maxTokens?: number;
  /** 步数预算（可选：父可收紧子会话步数；缺省走 loop 默认值） */
  maxIterations?: number;
  /** 角色包管理器（子会话按 rolePack 取 persona 与规则） */
  rolePackManager: RolePackManager;
  /** 全局技能管理器（子会话唯一可见的技能来源） */
  skillManager: SkillManager;
  /** 作品投影装配块（父装配期快照） */
  workProjectionContext?: string;
  /** 运行环境事实段（父装配期快照） */
  environmentContext?: string;
  /** 项目规则段（父装配期快照；未信任/无条目时为空） */
  residentRulesContext?: string;
  /** 时间戳 locale（父装配同源） */
  locale?: string;
}

/**
 * 校验并展开 capabilities（唯一语义校验点）
 *
 * @param capabilities 工具入参原值
 * @returns 授予的工具名列表（供 toolWhitelist）
 * @throws 出现未登记能力时抛 toolError（回喂模型，不静默忽略）
 */
function resolveSubagentCapabilities(capabilities: readonly string[] | undefined): string[] {
  if (!capabilities || capabilities.length === 0) return [];
  const granted: string[] = [];
  for (const capability of capabilities) {
    const toolName = SUBAGENT_GRANTABLE_CAPABILITIES.get(capability);
    if (!toolName) {
      throw toolError(
        `delegate_task 不支持的 capabilities：「${capability}」`,
        `只接受 ${[...SUBAGENT_GRANTABLE_CAPABILITIES.keys()].join(' / ')}`,
        ['移除该能力，或改用支持的能力名'],
        undefined,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }
    if (!granted.includes(toolName)) granted.push(toolName);
  }
  return granted;
}

/**
 * 创建子会话的独立工具执行器
 *
 * 结构性约束（不是靠 deny 兜底）：
 *   - **全新实例**，不继承宿主的 customTools / MCP 注册表（否则 MCP 写工具一道都不在 deny 名单里）；
 *   - `denyTools = SUBAGENT_DENIED_TOOLS`（常量清单，唯一减法真源）；
 *   - `toolWhitelist` 只放 capabilities 映射出的工具（无能力时为空 = 只剩常驻只读集）；
 *   - 不注入代码执行 provider、不注入 delegate_task 端口（深度 1）。
 *
 * @param params 子会话装配参数
 * @param request 本次派发请求（task/rolePack/capabilities）
 */
export function createSubagentToolExecutor(
  params: SubagentRuntimeParams,
  request: DelegateTaskRequest,
): ToolExecutor {
  const grantedTools = resolveSubagentCapabilities(request.capabilities);
  const capabilities = new Set(request.capabilities ?? []);

  const exec = new ToolExecutor(
    params.projectPath,
    params.security,
    params.memoryIndex,
    // 联网能力按需装配：未授予即不注入 provider ⇒ 条件工具结构上不存在
    capabilities.has('web:search') ? params.webSearchProvider : undefined,
    params.sessionStore,
    capabilities.has('web:fetch') ? params.fetchProvider : undefined,
    // 代码执行属特权（code:execute）：子会话永不装配
    undefined,
    // 项目检索只读，默认可用（等价于编辑器的全局搜索）
    params.projectSearchProvider,
    params.scriptNodePath,
  );

  // 减法轴：写盘/执行/交互/父状态工具一律不可见
  exec.setDenyTools(SUBAGENT_DENIED_TOOLS);
  // 加法轴：只把能力档映射出的工具加进白名单（空数组 = 只有常驻只读集）
  exec.setToolWhitelist(grantedTools);
  if (params.imageReadPort) exec.setImageReadPort(params.imageReadPort);

  // 技能面：**只留全局技能**（不查角色包内嵌技能，v1 定案）。
  // 这里改的是装配入口的数据源，不动 read_skill 的解析链。
  exec.readSkill = async (skillName: string) => {
    const globalSkill = params.skillManager.get(skillName);
    return globalSkill ? globalSkill.content : null;
  };
  exec.readResource = async (skillName: string, resourcePath: string) =>
    params.skillManager.readResource(skillName, resourcePath);
  exec.listResources = async (skillName: string) =>
    JSON.stringify(
      params.skillManager.listResources(skillName).map((r) => ({ path: r.path, size: r.size })),
      null,
      2,
    );
  exec.listSkills = async () => {
    const lines: string[] = ['【全局通用技能】'];
    for (const skill of params.skillManager.listAvailable()) {
      const formatted = SkillManager.formatSkillForPrompt(skill);
      if (formatted) lines.push(formatted);
    }
    return lines.join('\n');
  };

  return exec;
}

/** 无正文时按终态给一行说明（避免父模型把空正文误读成「完成但无内容」） */
const SUBAGENT_EMPTY_BODY_NOTE: Record<DelegateTaskStatus, string> = {
  completed: '（子会话未返回正文）',
  incomplete: '（子会话未完成，未产出正文）',
  interrupted: '（子会话被中止，未产出正文）',
  failed: '（子会话执行失败，未产出正文）',
};

/** 正文行首伪标签被降级时追加的说明行（只在真的降级过时出现） */
const SUBAGENT_TAG_DOWNGRADE_NOTICE =
  '（说明：正文中行首的 [SUBAGENT:…] 已降级为 [subagent:…]，不代表终态）';

/**
 * 上下文压缩 / 历史截断的事实说明行（**只在真发生过时**追加）。
 *
 * 不是状态位、不参与四态判定——只是如实告诉父模型「这份结论基于摘要，细节可能缺失」。
 * 触发条件由子 loop 的粘性事实位 `hasContextCompaction()` 决定；没发生的会话一个字都不加。
 */
const SUBAGENT_CONTEXT_COMPACTED_NOTE =
  '（说明：本次子会话中途经历过上下文压缩/截断，结论基于摘要，细节可能缺失）';

/**
 * 按子会话执行流的终态生成工具结果文本
 *
 * **第一行必须是内核生成的 `[SUBAGENT:*]` 标识**——它来自流终态标志，绝不允许子模型自己写
 * （否则模型可以自封「完成」骗过队长）。四态见 `DelegateTaskStatus`。
 *
 * 正文里**行首**出现的同名标签会降级成小写 `[subagent:`：否则父 LLM / 人扫标签会看到
 * 「第二个终态」。只处理行首，不做全局转义（正文里的普通代码内容不动）。
 *
 * @param status 终态
 * @param content 子会话累积正文
 * @param contextCompacted 子会话是否真发生过上下文压缩/截断（默认 false ⇒ 不出现事实说明行）
 */
export function formatSubagentResult(
  status: DelegateTaskStatus,
  content: string,
  contextCompacted = false,
): string {
  // 首行标签的模板**必须**写成 `[SUBAGENT:${status}]` 的字面形态：
  // `toolFailurePrefixGuard` 靠它把四态展开并做双向对账（用常量拼接会让扫描器失明 ⇒ 假绿）
  const header = `[SUBAGENT:${status}]`;
  // 前缀从 header 派生（不另写一份 `[SUBAGENT:` 字面量：孤立前缀会被首标签守卫记成盲区标记）
  const tagPrefix = header.slice(0, header.indexOf(':') + 1);
  // 事实说明行追加在**正文末尾**（截断之后），保证它不会被字符上限切掉；未发生则空串
  const compactionNote = contextCompacted ? `\n${SUBAGENT_CONTEXT_COMPACTED_NOTE}` : '';
  const body = content.trim();
  if (!body) return `${header}\n${SUBAGENT_EMPTY_BODY_NOTE[status]}${compactionNote}`;

  // 行首伪标签降级：逐行判断，只改行首（正文中间的提及、代码块内容一律不动）
  const downgraded = body
    .split('\n')
    .map((line) =>
      line.startsWith(tagPrefix)
        ? `${tagPrefix.toLowerCase()}${line.slice(tagPrefix.length)}`
        : line,
    )
    .join('\n');
  const notice = downgraded === body ? '' : `${SUBAGENT_TAG_DOWNGRADE_NOTICE}\n`;

  // 截断在头部之后做：头部与说明行永远完整，正文按字符上限截断并显式标注
  const truncated =
    downgraded.length > SUBAGENT_RESULT_MAX_CHARS
      ? `${downgraded.slice(0, SUBAGENT_RESULT_MAX_CHARS)}\n…（结果超过 ${SUBAGENT_RESULT_MAX_CHARS} 字符，已截断）`
      : downgraded;
  return `${header}\n${notice}${truncated}${compactionNote}`;
}

/**
 * 创建子会话的 AgentLoop（独立 messages / 独立执行器 / 强制只读 / 深度 1）
 *
 * 为什么与 `createAgentLoopAndDeps` 同模块：父侧以后新增安全选项（新的端口、新的只读判据、
 * 新的 deny 轴）时，同文件的子装配必须一起看一遍——放到别的模块就会漏配且无人发现。
 *
 * @param params 子会话装配参数
 * @param request 本次派发请求
 * @returns 子 loop 与它的执行器（执行器一并返回供测试断言暴露面）
 */
export function createSubagentLoop(
  params: SubagentRuntimeParams,
  request: DelegateTaskRequest,
): { loop: AgentLoop; toolExec: ToolExecutor; systemPromptPrefix: string } {
  // rolePack 传了就**必须存在**：静默退回空白会让队长以为「按角色派活」而实际没有
  let rolePackPrompt = '';
  if (request.rolePack) {
    const packExists = params.rolePackManager
      .listMeta()
      .some((meta) => meta.name === request.rolePack);
    if (!packExists) {
      throw toolError(
        `delegate_task 指定的角色包不存在：「${request.rolePack}」`,
        '角色包名拼写错误或该包未装载',
        ['检查角色包名，或省略 rolePack 使用空白子会话'],
        undefined,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }
    const assembly = params.rolePackManager.get(request.rolePack);
    // 规则 3：角色包声明 toolMode=block 时拒绝（子会话必须能执行只读工具）
    if (assembly?.strategy?.act?.toolMode === 'block') {
      throw toolError(
        `delegate_task 不能使用禁止工具的角色包：「${request.rolePack}」`,
        '该角色包的策略 toolMode=block，子会话无法执行任何工具',
        ['换一个允许工具的角色包，或省略 rolePack'],
        undefined,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }
    // 只取 persona 与规则：跳过内嵌技能清单，并抑制「主动提问规则」（子会话禁用 ask_user）
    rolePackPrompt = params.rolePackManager.buildSystemPrompt(request.rolePack, {
      includeSkills: false,
      suppressFollowupAsk: true,
    });
  }

  // 与父同一 SSOT：全局技能清单 / 项目规则 / 作品投影 / 环境 / 时间戳 / Turn 起始策略
  const systemPromptPrefix = buildSystemPromptPrefix(
    rolePackPrompt,
    params.skillManager.buildSkillList(),
    params.locale,
    params.workProjectionContext,
    params.environmentContext,
    params.residentRulesContext,
  );

  const toolExec = createSubagentToolExecutor(params, request);

  const loop = new AgentLoop({
    provider: params.provider,
    // 独立 messages：不继承父对话历史与父记忆
    bootstrapMemories: [],
    systemPromptPrefix,
    toolExecutor: (name, args, emitOutcome, toolCallId, signal) =>
      toolExec.execute(name, args, undefined, emitOutcome, toolCallId, signal),
    // 暴露面快照来自子执行器（不含宿主自定义工具）
    toolDefinitions: toolExec.list,
    allTools: () => toolExec.allToolDefinitions,
    maxContextTokens: params.maxContextTokens,
    defaultMaxTokens: params.maxTokens,
    // 未给定时传 undefined ⇒ loop 用 DEFAULT_MAX_ITERATIONS（与父会话同口径）
    maxIterations: params.maxIterations,
    imageReadPort: params.imageReadPort,
  });

  // 强制只读：工具可见不等于可写；只读闸是第二道独立保证
  loop.setStrategy({ toolReadonly: 'readonly' });

  return { loop, toolExec, systemPromptPrefix };
}

/** 子会话一次派发的运行句柄 */
export interface SubagentRun {
  /** 流累积态（`content` 实时更新：abort 时端口据它带回「不完整但可用」的正文） */
  readonly state: ExecutionStreamState;
  /**
   * 子会话是否**真发生过**上下文压缩/历史截断（事实位，粘性）。
   * 端口在 abort 立即收口时也用它决定要不要追加事实说明行——与终态判定无关。
   */
  readonly hasContextCompaction: () => boolean;
  /** 终态结果（内部吞掉异常，**永不 reject**；端口提前返回后仍继续跑到收场） */
  readonly finished: Promise<DelegateTaskResult>;
}

/**
 * 启动子会话，返回实时累积态与终态 Promise（**不等待收场**）
 *
 * 为什么不在这里直接 await：父 turn abort 后，父侧 `raceToolWithSignal` 只给 1.8s 宽限、
 * 先到先赢。若端口一直等子会话自己的工具收场，父会先拿到 `[ERR:TOOL:ABORTED]`，
 * 子会话的真终态 `[SUBAGENT:interrupted]` 被 `Promise.race` 丢弃；且并发名额要等子 loop
 * 真 settle 才释放，工具永不返回时该 Agent 会永久判「并发超限」。
 * 故拆成「启动 + 收场」两段：端口在 abort 一到就用当前正文立即返回，后台 loop 继续收同一
 * signal 自己收场（异常在 `finished` 内部吞掉，不会变成 unhandled rejection）。
 *
 * 终态判据全部来自子会话执行流标志（读标志，不匹配文案）：
 *   - paused / 抛错 → `failed`（子递归里 paused 应不可达，真出现按失败收口）；
 *   - aborted / 父 signal 中止 → `interrupted`；
 *   - 流终态 `failed`（内核兜底文案 / 流提前 EOF 丢弃半截 tool_calls）→ `failed`；
 *   - 撞步数上限 / `done.incomplete`（输出预算截断、正文工具意图剔除后为空）→ `incomplete`；
 *   - 其余 → `completed`。
 * 上下文压缩/截断**不改终态**，只可能在正文末尾追加一行事实说明。
 *
 * @param params 子会话装配参数
 * @param request 本次派发请求
 * @param signal 父 turn 中止信号（**直接透传**：父被中止 → 子同步中止）
 * @throws createSubagentLoop 的参数校验错误（rolePack 不存在 / toolMode=block / 非法 capabilities）
 */
export function startSubagent(
  params: SubagentRuntimeParams,
  request: DelegateTaskRequest,
  signal?: AbortSignal,
): SubagentRun {
  // 参数错误在启动前同步抛出：子会话根本没起来，不存在终态（由工具层按标准工具错误回喂）
  const { loop } = createSubagentLoop(params, request);
  const state = createExecutionStreamState();

  const finished: Promise<DelegateTaskResult> = (async (): Promise<DelegateTaskResult> => {
    try {
      // 父 abort 直接透传同一个 signal（processUserInput 会一路传到 provider 与工具执行）
      for await (const chunk of loop.processUserInput(request.task, signal)) {
        observeExecutionChunk(state, chunk);
      }
    } catch (err) {
      // 与父会话同一分类真源：用户取消 → interrupted；内部中断 / 异常 → failed
      const classified = classifyExecutionStreamError(err, signal);
      if (classified.kind === 'internal-abort') {
        logger.warn({ err }, '子会话 LLM 请求非用户取消原因中断，判为连接中断');
      }
      const status: DelegateTaskStatus = classified.aborted ? 'interrupted' : 'failed';
      return {
        status,
        text: formatSubagentResult(status, state.content, loop.hasContextCompaction()),
      };
    }

    // paused 在子递归里应不可达（子会话禁用了 ask_user，也没有父的暂停入口）：
    // 真出现按 failed 收口并留日志，不静默当成完成
    if (state.paused) {
      logger.warn({ task: request.task }, '子会话出现 paused（预期不可达），按 failed 收口');
      return {
        status: 'failed',
        text: formatSubagentResult('failed', state.content, loop.hasContextCompaction()),
      };
    }
    if (state.aborted) {
      return {
        status: 'interrupted',
        text: formatSubagentResult('interrupted', state.content, loop.hasContextCompaction()),
      };
    }
    // 不可交付优先：内核兜底文案（空响应重试耗尽）/ 流提前 EOF 丢弃半截 tool_calls
    // 都不是子模型结论 ⇒ failed，不许以 completed 交付
    if (state.failed) {
      return {
        status: 'failed',
        text: formatSubagentResult('failed', state.content, loop.hasContextCompaction()),
      };
    }
    // 撞步数上限 / 输出预算截断 / 正文工具意图剔除后为空 ⇒ 内容可用但不完整，
    // 否则父拿到 completed + 半截回答，会把没做完的活当成交付
    const status: DelegateTaskStatus =
      state.limitReached || state.incomplete ? 'incomplete' : 'completed';
    return {
      status,
      text: formatSubagentResult(status, state.content, loop.hasContextCompaction()),
    };
  })();

  return { state, hasContextCompaction: () => loop.hasContextCompaction(), finished };
}

/**
 * 跑完一次子会话，返回已格式化的工具结果文本（`startSubagent` 的「等收场」形态）
 *
 * @param params 子会话装配参数
 * @param request 本次派发请求
 * @param signal 父 turn 中止信号（直接透传）
 */
export async function runSubagent(
  params: SubagentRuntimeParams,
  request: DelegateTaskRequest,
  signal?: AbortSignal,
): Promise<string> {
  const { finished } = startSubagent(params, request, signal);
  return (await finished).text;
}

/**
 * 创建 delegate_task 派发端口（并发闸 + abort 立即收口）
 *
 * 两条硬约束都在这里，不散落到装配回调里：
 *   - **并发硬限**：同一步最多 `SUBAGENT_MAX_CONCURRENT` 个。判据在端口入口**同步**执行
 *     （计数自增发生在第一个 await 之前），故同一批并发的第三个调用必然看到满额后报错。
 *     **超出直接快速失败、不排队**：父 turn 是同步递归等待子会话的，排队会让父无限等；
 *     而父没有取消单个子任务的能力，等不到也断不掉，只能把整轮拖死。快速失败把选择权
 *     交回父模型（等前面的完成后重派）。
 *   - **abort 立即返回真终态**：父 turn 中止时立刻用已累积正文返回 `interrupted`，
 *     后台子 loop 继续收同一 signal 自己收场；名额在端口 promise 返回时释放，不等子 loop settle。
 *
 * @param params 子会话装配参数
 * @returns 端口实现 + 在途计数读取器（诊断/测试用；**不参与深度判定**）
 */
export function createDelegateTaskPort(params: SubagentRuntimeParams): {
  port: (request: DelegateTaskRequest, signal?: AbortSignal) => Promise<DelegateTaskPortResult>;
  /** 当前在途子会话数（并发闸内部状态） */
  inFlight: () => number;
} {
  /** 在途子会话数：只管并发，不管深度（深度由「子装配不注入端口」结构性保证） */
  let inFlight = 0;

  const port = async (
    request: DelegateTaskRequest,
    signal?: AbortSignal,
  ): Promise<DelegateTaskPortResult> => {
    if (inFlight >= SUBAGENT_MAX_CONCURRENT) {
      // 文案自解释：上限 / 当前在跑数 / 该怎么办。这句会进 tool_result，
      // 父模型读到后才知道该等前面完成再派，而不是盲目重试或直接放弃。
      throw toolError(
        'delegate_task 并发超限',
        `同一步最多 ${SUBAGENT_MAX_CONCURRENT} 个子会话同时执行，当前已有 ${inFlight} 个在跑`,
        ['等已派发的子会话返回后再派发新的任务'],
        undefined,
        ToolErrorCode.ARGUMENT_ERROR,
      );
    }
    inFlight++;
    /** 执行计时起点：拿到名额（即端口开始执行）之后 */
    const execStart = Date.now();
    /** 把执行耗时叠加到收场结果（唯一计时产地） */
    const withTiming = (result: DelegateTaskResult): DelegateTaskPortResult => ({
      ...result,
      durationMs: Date.now() - execStart,
    });
    try {
      const run = startSubagent(params, request, signal);
      // 无外部 signal：正常等子会话收场
      if (!signal) return withTiming(await run.finished);

      // abort 时的「立即终态」：正文取**当前**累积内容（不完整但可用）
      const interruptedResult = (): DelegateTaskResult => ({
        status: 'interrupted',
        text: formatSubagentResult('interrupted', run.state.content, run.hasContextCompaction()),
      });
      if (signal.aborted) return withTiming(interruptedResult());

      /** 解除 abort 监听（race 结束后必须执行，否则父 signal 上的监听会累积） */
      let removeAbortListener = (): void => {};
      try {
        return withTiming(
          await Promise.race([
            run.finished,
            new Promise<DelegateTaskResult>((resolve) => {
              const onAbort = (): void => resolve(interruptedResult());
              signal.addEventListener('abort', onAbort, { once: true });
              removeAbortListener = () => signal.removeEventListener('abort', onAbort);
            }),
          ]),
        );
      } finally {
        removeAbortListener();
      }
    } finally {
      // 名额在端口 promise 返回时释放（不等子 loop settle）
      inFlight--;
    }
  };

  return { port, inFlight: () => inFlight };
}

/**
 * Agent 门面注入的稳定能力（接线下沉载体）
 *
 * 接线回调收进单一 `hooks`：Agent 只传稳定能力（emit/守卫/暂停），
 * 接线闭包语义在组装器内唯一实现（装配逻辑单一真理源）——回调平铺散落多处
 * 会逐字段重复声明、各自漂移。
 *
 * 边界：只传 Agent 的稳定能力（非私有状态），避免反向依赖泄漏；
 * hooks 可选——缺省时按 no-op 接线，供纯工厂单测使用。
 */
export interface AgentHooks {
  /**
   * 发射 Agent 事件（宿主订阅广播；由 Agent 侧按 AGENT_EVENT_SET 校验事件名合法性）。
   * 载荷放宽为 unknown：事件数据形状由 AgentEventMap 定（多数为对象，questionPending 为数组），
   * 桥接侧负责强类型断言。
   */
  emit: (event: AgentEventName, data: unknown) => void;
  /** 会话忙状态查询（SessionManager 守卫） */
  isChatBusy: () => boolean;
  /** 主动提问时请求软暂停（ask_user question_pending 触发） */
  requestPause: (reason: string, source: 'user' | 'agent' | 'system') => void;
  /**
   * 宿主工具执行前检查回调（统一执行入口 · 单点聚合检查）
   *
   * 审批/审计/参数改写/幂等去重途经的宿主闸门。放行后由组装器内部幂等检查续接。
   */
  preExecutionCheck?: (name: string, args: string) => PreExecutionResult;
  /**
   * 角色包激活后应用工具暴露面（检查点恢复协议角色契约重注入触发）
   *
   * 走 Agent 生命周期（toolMode/能力白名单 → setToolWhitelist → loop 快照 + system prompt 同步）；
   * 缺省 no-op（纯工厂单测不触发）。
   */
  applyRolePackToolExposure?: () => void;
  /**
   * 角色包激活后刷新 loop 前缀（检查点恢复协议角色契约重注入触发）
   *
   * 走 Agent 生命周期（buildSystemPromptPrefix 真理源 → loop.refreshRolePackPrefix + ChatOptions）；
   * 缺省 no-op（纯工厂单测不触发）。
   */
  refreshRolePackPrefixOnLoop?: () => void;
  /**
   * 会议逐项切换：按当前 active 任务项的 rolePack 刷新本轮装配视角。
   *
   * 由 taskTable 每轮注入时驱动——与任务表渲染同源（同读「当前 active 任务项」），
   * 保证后继任务项换角色即时生效（装配视角不能只在 prepare.run 设一次，否则展示层正确/装配层冻结）。
   * 内部防重：视角未变化则跳过，避免每轮迭代重复重建前缀。缺省 no-op（纯工厂单测不触发）。
   */
  applyActivePlanItemAssembly?: () => void;
}

/**
 * 与 AgentConfig 同源的组装运行时参数
 *
 * Pick 派生自 AgentConfig（而 AgentConfig 又派生自 AgentOptions），
 * 消除 AssembleInput 与 AgentConfig 之间 10 个字段的逐一手写重复。
 */
type AssembleRuntimeParams = Pick<
  AgentConfig,
  | 'projectPath'
  | 'configDir'
  | 'activeRolePack'
  | 'rolePackTeams'
  | 'builtinFallbackRole'
  | 'maxContextTokens'
  | 'maxTokens'
  | 'sessionStore'
  | 'roundStore'
  | 'tracer'
  | 'messages'
  | 'enableContextSummary'
  | 'webSearchProvider'
  | 'fetchProvider'
  | 'codeExecutionProvider'
  | 'projectSearchProvider'
  | 'imageReadPort'
  | 'denyTools'
  | 'environmentProvider'
  | 'workspaceTrusted'
  | 'scriptNodePath'
  | 'disabledSkills'
>;

/** 组装器输入参数 */
export interface AssembleInput extends AssembleRuntimeParams {
  provider: LlmProvider;
  backgroundProvider: LlmProvider | null;
  /** Provider 路由选择器（多模型路由基础，可选） */
  providerRouter?: ProviderRouter | null;
  /** 已有的 SkillManager（首次为 null，后续复用） */
  existingSkillManager: SkillManager | null;
  /**
   * systemPrompt 时间注入的 locale（默认 AGENT_CONSTANTS.DEFAULT_LOCALE = 'zh-CN'）。
   * 注入此字段可覆盖默认 locale，实现国际化时间格式。
   */
  locale?: string;
  /** Agent 门面注入的稳定能力（接线下沉载体；缺省按 no-op 接线，供纯工厂单测） */
  hooks?: AgentHooks;
}

/**
 * 子工厂参数：AssembleInput 共享字段 Pick 派生 + 阶段产物
 *
 * 共享字段经 Pick 派生自 AssembleInput，不在子工厂另写重复声明——
 * 并列声明会让新后加字段（如 locale）须同时改多处。派生后
 * 共享字段的类型由 AssembleInput 单一继承——新增字段只改 AssembleInput 一处，
 * 且同一字段两处类型不可能漂移（tsc 锁死）。
 */
type LoopAndDepsParams = Pick<
  AssembleInput,
  | 'provider'
  | 'backgroundProvider'
  | 'providerRouter'
  | 'maxContextTokens'
  | 'maxTokens'
  | 'tracer'
  | 'messages'
  | 'enableContextSummary'
  | 'sessionStore'
  | 'locale'
  | 'hooks'
  | 'imageReadPort'
> & {
  pctx: ProjectContext;
  /** 激活角色包的 L1 persona prompt（档 2-1 后角色包唯一；无激活角色包时为空串） */
  rolePackPrompt: string;
  /** 全局技能管理器（构建通用技能清单 + read_skill 全局源，两级技能渐进披露） */
  skillManager: SkillManager;
  toolExec: ToolExecutor;
  /** 会话管理器（先于 loop 创建，工具执行回调可直接写入，消除暂存队列补丁） */
  sessionManager: SessionManager;
  /** 作品投影装配注入块（L1 name+description+source 清单；**不含正文**，正文由模型按需 read_file） */
  workProjectionContext: string;
  /** 项目规则段（可选；assembleComponents 装配期首次求值产出，空串/undefined 不注入） */
  residentRulesContext?: string;
  /** 运行环境事实段（可选；assembleComponents 从 environmentProvider 快照格式化产出，空串/undefined 不注入） */
  environmentContext?: string;
};

/**
 * 子工厂参数：AssembleInput 共享字段 Pick 派生 + 阶段产物
 *
 * 同 LoopAndDepsParams（收敛的第二半）。
 */
type LoopDependentParams = {
  pctx: ProjectContext;
  loop: AgentLoop;
  history: MessageHistory;
};

/** 组装器输出（所有创建的组件引用） */
export interface AssembleOutput {
  history: MessageHistory;
  loop: AgentLoop;
  toolExec: ToolExecutor;
  /** 后台任务槽位调度器（实例级，Agent 持有 → 注入 SeedDeps + BuiltinToolHandlers，close 单点等待） */
  backgroundTasks: BackgroundTaskScheduler;
  workProjection: WorkProjectionManager;
  /** 项目规则管理器（每轮 refresh 缓存，同步 contextBlock 供 system prompt 注入） */
  residentRules: ResidentRulesManager;
  skillManager: SkillManager;
  memoryInspector: MemoryInspector;
  /** 会话归档器（负责生成/更新 SessionMeta） */
  sessionArchiver: SessionArchiver;
  /** 文本润色管理器（LLM 语法修正 + 表达优化） */
  textPolisher: TextPolishManager;
  /** 角色包管理器（角色+技能+规则的唯一真理源） */
  rolePackManager: RolePackManager;
  /** 轮次摘要生成器（记忆即摘要架构） */
  roundSummaryGenerator: RoundSummaryGenerator;
  /** 会话管理器（接线下沉后由组装器创建并返回，Agent 直接持有） */
  sessionManager: SessionManager;
  /** 输入增强管线（角色/记忆/技能增强，Agent 门面保留编排调用点） */
  contextPreparer: ContextPreparer;
}

/**
 * 组装所有运行时组件
 *
 * 组件创建顺序（解决循环依赖）：
 *   1. 无依赖组件：history, workProjection, toolExec
 *   2. 依赖 Provider 的组件：skillManager, rolePackManager
 *   3. AgentLoop（依赖 toolExec + systemPromptPrefix）
 *   4. 依赖 Loop 的组件：memoryInspector
 *
 * @param pctx 项目上下文
 * @param input 组装参数
 * @returns 所有组件引用
 */

// ── 子工厂函数 ─────────────────────────────────────────────

/**
 * 装配 loop 运行时回调 + 任务表管理（接线下沉：onPendingQuestion/onPlanItemBoundary/getTaskTable/planManager）
 *
 * 这些闭包回填在组装器——接线本质是组件间协作，
 * 属装配职责（装配逻辑单一真理源）。
 * 注：loop.onPaused 不在此装配——pauseMeta 唯一写入点是 SessionManager.pause()；
 *     consumeExecutionStream 只负责从状态机 pendingPause 取原因/来源并调 pause()，不自行写 pauseMeta。
 * 注：任务表停滞检测内嵌在单 turn step 循环中（无多 turn 编排）。
 *
 * @param loop AgentLoop（装配其 onPendingQuestion/onPlanItemBoundary/getTaskTable）
 * @param toolExec 工具执行器（装配其 planManager）
 * @param sessionManager 会话管理器（全部闭包的操作落点）
 * @param hooks Agent 门面注入的稳定能力（emit/requestPause；可选，缺省 no-op）
 * @param history 消息历史（裁决证据 appendEvidence 的落点）
 */
function wireRuntimeCallbacks(
  loop: AgentLoop,
  toolExec: ToolExecutor,
  sessionManager: SessionManager,
  hooks: AgentHooks | undefined,
  history: MessageHistory,
): void {
  // 主动提问（ask_user 工具检出）：发射 questionPending 事件（宿主渲染提问 UI）+
  // 注册软暂停申请（requestPause(reason, 'agent') → 状态机 pendingPause）。
  // 注：pauseMeta 是**判据**（clearPlanOnTurnEnd 据此决定任务表清不清），不是展示字段；
  //     旧注释所称「供重启恢复展示」已随跨重启恢复退役而失效，勿据此理解其用途。
  loop.onPendingQuestion = (questions) => {
    if (questions.length === 0) return;
    // 在途提问先落盘（E2E-ASK-LOSS-1）：本回调在 loop.handleAskUser yield paused 之前触发，
    // markPendingAsk 方法体无 await（同步 save），调用返回即盘面已写——「挂起进入 paused 之前
    // 持久化」的时序判据在此闭合。消费点 = appendInterrupted 收场转化（unanswered 交互输入）。
    void history.markPendingAsk(
      loop.getCurrentRoundId(),
      questions.map((q) => ({
        question: q.question,
        ...(q.options ? { options: q.options } : {}),
      })),
    );
    hooks?.emit(AGENT_EVENTS.questionPending, questions);
    // 触发软暂停：handleAskUser 检出 ask_user 返回 'paused' 后由 consumeExecutionStream 翻 PAUSED
    const reason = `需要澄清：${questions.map((q) => q.question).join('; ')}`;
    hooks?.requestPause(reason, 'agent');
  };

  // 任务项边界回调（每次 LLM 迭代完成后、工具执行前触发）：只写 planItemLog 关联任务表当前 active
  // 任务项（时间轴投影）。plan 状态推进唯一写者 =
  // LLM 的 task_table_update（updatePlanItem → updatePlanItemStatus 单一写点）；LLM 未显式 update
  // 的最后一个任务项由 turn 收尾兜底（orchestrator → concludeActivePlanItemIfPlanFullyReached）补上。
  loop.onPlanItemBoundary = (planItemInfo) => {
    const activePlanItemId = sessionManager
      .getCheckpoint()
      ?.plan.find((s) => s.status === 'active')?.id;
    sessionManager.logPlanItemBoundary({
      planItemId: activePlanItemId,
      summary: planItemInfo.summary,
    });
  };

  // active 任务项元信息回调（任务项级折叠）：loop 经 _maybeEmitPlanItemBoundary
  // 在**迭代开始**（LLM 调用前）取当前 active 任务项 { planItemId, title }，供 loop 对比推进产
  // plan_item_boundary 事件——边界语义是「以下内容属于该任务项」，故须早于本迭代的思考与工具。
  // 无任务表返回 null，宿主端据此不产边界（静默）。
  // 与 onPlanItemBoundary 读同一 checkpoint.plan 真源，但读取时刻不同（时序分叉是设计语义，
  // 定案锚 ADR-034）：后者读 LLM 调用后、工具前的 active（本迭代 LLM 实际服务的任务项，
  // 只写 planItemLog 不推进），本回调读迭代开始时的 active（以下内容将归属的那个任务项）。
  loop.getActivePlanItemMeta = () => {
    const cp = sessionManager.getCheckpoint();
    const active = cp?.plan.find((s) => s.status === 'active');
    return active
      ? { planItemId: active.id, title: active.description ?? active.id, rolePack: active.rolePack }
      : null;
  };

  // 裁决证据落盘钩子（悬案取证）：loop 写点（空响应兜底 / 台账替身回显）产个案证据，
  // 归属当前闭环轮随 Round 落盘（消费方 = 人工/抽样裁决，非 UI 重放）
  loop.appendRoundEvidence = (ev) => {
    void history.appendEvidence(loop.getCurrentRoundId(), ev);
  };

  // 在途任务表判定回调（单一真理源 = SessionManager.hasInflightPlan）：loop 注入 needsPlanning
  // nudge 前询问「是否已有在途任务表」。与 prepare 的会议骨架守卫共用同一谓词——同一命题
  // 禁两处各自实现（prepare 内联谓词与 loop 借 getActivePlanItemMeta 存在性判定必须合一）。
  loop.hasInflightPlan = () => sessionManager.hasInflightPlan();

  // 装配任务表注入回调：每次迭代 LLM 调用前统一注入
  loop.getTaskTable = () => {
    const cp = sessionManager.getCheckpoint();
    if (!cp) return '';
    // 会议逐项切换：每轮按当前 active 任务项派生装配视角（与任务表渲染同源；防重见 agent.applyActivePlanItemAssemblyIfChanged）
    hooks?.applyActivePlanItemAssembly?.();
    const table = renderTaskTable(cp.plan, cp.planItemLog);
    if (!table) return '';
    // 未完成硬约束：仍有任务项未标记 done 时追加「不得提前收尾」执行要求。
    // 实证（round-1790068191972）：ask 回答后续跑轮，LLM 已提出「重新标记任务项4」却未调
    // task_table_update 就纯文本收尾——任务表在 turn 内进行中持续存在（checkpoint.plan 内存态，
    // 由 clearPlanOnTurnEnd 在 turn 结束才清空），收尾兜底不会自动补状态，故在每次注入时把
    // 「未完成 ⇏ 收尾」作为明示纪律。
    // 语义边界：约束 = 「先更新任务表、交代未完成任务项再收尾」，不强制完成任务本身——
    // 放弃/降级任务仍是合法用户决策（可 task_table_update 置 blocked 后收尾），防锁死。
    // 与 buildCompletionVerifyNudge（全 done 防假完成）互补：一个卡「没做完」、一个卡「做完没验证」。
    const unfinished = cp.plan.filter((s) => s.status !== 'done');
    if (unfinished.length > 0) {
      return (
        table +
        '\n\n（执行约束，非历史信息）仍有任务项未标记「已完成」，不得就此结束回合：' +
        '请继续用 task_table_update 推进并标记结果；确需中止该任务时，请先用 task_table_update ' +
        '将未完成任务项标记为 blocked（已阻塞），并在收尾汇报中说明原因。'
      );
    }
    return table;
  };

  // 装配任务表工具回调（planManager）
  toolExec.planManager = {
    writePlan: (mode, items) => {
      // 分发归位 SessionManager.writePlan（计划写入口 SSOT，可被单测直接覆盖）
      const newPlan = sessionManager.writePlan(mode, items);
      return `任务表已更新（${mode}），当前共 ${newPlan.length} 个任务项：\n${newPlan
        .map(
          (s) =>
            `  - [${s.id.slice(0, 8)}] ${s.description}${s.rolePack ? `（角色：${s.rolePack}）` : ''}`,
        )
        .join('\n')}`;
    },
    updatePlanItem: (planItemId, status) => {
      // 状态变更收口 SessionManager.updatePlanItemStatus（内部刷心跳，唯一写点）。
      // 必须经此写点 touchCheckpoint，否则计划变更可能绕过心跳刷新（纯内存态）
      if (!sessionManager.updatePlanItemStatus(planItemId, status)) {
        // 任务项寻址失败 = 执行失败事实 → 结构化抛错（经 runOne catch → failedOutcome）。
        // 不裸文本 return：B5 后 runOne 兜底=ok，裸失败前缀会被吞成成功（B5-e 消亡口径）。
        throw toolError(
          `未找到任务项 ${planItemId}`,
          'task_table_update 的 plan_item_id 在当前任务表中不存在',
          [
            '用 task_table_write 返回的 8 位短 id 或任务表行首序号定位',
            '先核对任务表注入内容中的现有任务项',
          ],
          undefined,
          ToolErrorCode.ARGUMENT_ERROR,
        );
      }
      // updatePlanItemStatus 返回 true ⇒ checkpoint/plan 必存在（SessionManager.updatePlanItemStatus 早退契约），用非空断言保证
      const plan = sessionManager.getCheckpoint()!.plan;
      const planItem = plan.find((s) => s.id === planItemId);
      // 收尾验证 nudge：把最后一个任务项标 done = LLM 宣称任务完成——
      // 若全 done 且无执行性验证任务项，追加提示引导补真验证（触发条件确定性，内容交 LLM）。
      // 仅 done 路径触发（blocked 是中止宣告，无需 nudge）；判定函数返回 null = 零打扰。
      const result = `任务项 [${planItemId.slice(0, 8)}] "${planItem!.description}" 已标记为 ${status}`;
      if (status === 'done') {
        return result + (buildCompletionVerifyNudge(plan) ?? '');
      }
      return result;
    },
    getPlan: () => {
      const cp = sessionManager.getCheckpoint();
      return (cp?.plan ?? []).map((s) => ({
        id: s.id,
        description: s.description,
        status: s.status,
        order: s.order,
        rolePack: s.rolePack,
      }));
    },
  };
}

/**
 * 创建 AgentLoop 及其直接依赖
 */
async function createAgentLoopAndDeps(params: LoopAndDepsParams) {
  const {
    provider,
    backgroundProvider,
    providerRouter,
    pctx,
    rolePackPrompt,
    skillManager,
    toolExec,
    maxContextTokens,
    // per-LLM 输出预算默认值（T1）：宿主 per-LLM 配置透传 → loop.defaultMaxTokens
    maxTokens,
    tracer,
    messages,
    enableContextSummary,
    sessionStore,
    locale,
    sessionManager,
    hooks,
    imageReadPort,
    workProjectionContext,
    environmentContext,
    residentRulesContext,
  } = params;

  // 系统前缀：使用共享函数构建（SSOT：buildSystemPromptPrefix）
  // 包含角色包 L1 persona + 项目规则段 + 全局技能清单 + 作品投影装配块（L1 清单）+ 运行环境事实段 + 当前时间戳
  const globalSkillList = skillManager.buildSkillList();
  const systemPromptPrefix = buildSystemPromptPrefix(
    rolePackPrompt,
    globalSkillList,
    locale,
    workProjectionContext,
    environmentContext,
    residentRulesContext,
  );
  // 角色包底盘占用（system prompt 总体 token）= 装配此刻即确定的真值，早于 prepare；
  // 冷启动 / 重启首屏即可显示真实占比。与运行时 prepare 用同一 estimateTokensMessages 估算器（口径一致）。
  const rolePackBaseTokens = estimateTokensMessages([{ content: systemPromptPrefix }]);

  // 后台通道 Provider = 「显式后台 Provider + 前台失败升级」唯一解析点（SSOT：见 backgroundProvider.ts）。
  // 装配期三个后台消费者（归档 / 润色 / 摘要）共用本次解析结果，不在各自内部复制升级判据。
  // 热切换（agent.setBackgroundProvider）会重新解析一份并注入同一组三个消费者——
  // 新增第四个消费者时两处都要登记，只登装配期 = 热切换对它不生效。
  const backgroundChannelProvider = resolveBackgroundProvider(backgroundProvider, provider);
  const sessionArchiver = new SessionArchiver(backgroundChannelProvider, sessionStore);
  const textPolisher = new TextPolishManager(backgroundChannelProvider);
  const roundSummaryGenerator = new RoundSummaryGenerator(backgroundChannelProvider, pctx.index);

  // 截断时优先复用已存 round-summary，避免现调 LLM 生成上下文摘要
  // 仅取当前会话 roundIds 对应的摘要（round-based：会话由 roundIds 列表定义，摘要以 roundId 溯源）——
  // 防止其他会话（分叉分支/会话切换遗留）的摘要渗入当前上下文"遗忘补偿"。
  // sessionStore 缺失或当前会话未就绪时降级返回空（防渗入优先），回退 LLM 现场摘要；不阻断截断。
  // （必须返回 '' 而非降级放行全库会话摘要：别会话内容渗入会与「防跨会话渗入」使命语义反转。）
  const roundSummaryLoader = (): string => {
    try {
      // 惰性求取当前会话 roundIds：限定摘要只取本会话。
      // sessionStore 缺失或 checkpoint 未就绪（sessionId 空）→ 降级返回空而非全量，
      // 杜绝跨会话/分叉分支摘要渗入当前上下文"遗忘补偿"，交由 LLM 现场摘要兜底。
      const sessionId = sessionManager?.getCheckpoint()?.sessionId ?? '';
      if (!sessionStore || !sessionId) return '';
      const ids = sessionStore.getRoundIds(sessionId);
      const allowedRoundIds = new Set(Array.isArray(ids) ? ids : []);
      if (allowedRoundIds.size === 0) return '';
      const summaries = pctx.index
        .getBySource(SOURCE_LABELS.ROUND_SUMMARY)
        .filter((s) => s.roundId !== undefined && allowedRoundIds.has(s.roundId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, ROUND_SUMMARY_LOADER_MAX);
      if (summaries.length === 0) return '';
      return `[Earlier conversation summaries]\n${summaries.map((s) => `- ${s.content}`).join('\n')}`;
    } catch (err) {
      // 记忆索引异常时降级为空（回退 LLM 摘要生成），不阻断截断
      logger.debug({ err }, 'roundSummaryLoader：记忆索引异常，降级为空');
      return '';
    }
  };

  const loop = new AgentLoop({
    provider,
    providerRouter: providerRouter ?? undefined,
    bootstrapMemories: pctx.bootstrapMemories,
    // 第 5 参透传：ToolRunner 的原生 outcome 回调必须直达 ToolExecutor（不透传 = 已切族静默回落文本判据）；
    // toolCallId 透传 = web_search 证据按调用唯一 ID 配对（宿主渲染不再按 query 文本猜）；
    // signal 透传 = turn 中止时子进程执行面先杀进程树再返回（TOOL-ABORT-KILL-1）
    toolExecutor: (name: string, args: string, emitOutcome, toolCallId, signal) =>
      toolExec.execute(name, args, undefined, emitOutcome, toolCallId, signal),
    systemPromptPrefix,
    rolePackBaseTokens,
    toolDefinitions: toolExec.list,
    // 图片摄取端口：loop 的 resolveActiveTools 据此 + 路由后 provider 视觉位逐 step 裁剪 read_image
    imageReadPort,
    // 全部工具定义注入只读闸（toolReadonly 查询 readonly 标记；含自定义工具，与暴露面无关）。
    // 传提供者而非快照：宿主可在 loop 构造后 registerTool，闸必须实时看到新注册的工具。
    allTools: () => toolExec.allToolDefinitions,
    maxContextTokens,
    // per-LLM 输出预算默认值（token）：buildChatOptions 填底座，策略覆盖项（chatOptions）后压
    defaultMaxTokens: maxTokens,
    tracer,
    messages,
    enableContextSummary,
    // 卸载式压缩落盘目录：项目级 .memora/outputs。两条约束同时满足——在 SecurityGuard 信任根
    // （memoraDir）内 → read_file 可回取；`.memora` 属 IGNORED_DIR_NAMES → search_project/list_dir
    // 不命中，不污染项目检索（故不落用户级 ~/.memora，那在信任根外，引用读不回）
    offloadDir: join(pctx.memoraDir, 'outputs'),
    // 替换式压缩第一级：按 roundId 取已存 round-summary（无摘要返回 null，该轮不替换交第二级压缩）
    getRoundSummary: (roundId: string): string | null => {
      try {
        const found = pctx.index
          .getBySource(SOURCE_LABELS.ROUND_SUMMARY)
          .find((s) => s.roundId === roundId);
        return found ? found.content : null;
      } catch (err) {
        // 记忆索引异常时降级为 null（替换层 no-op），不阻断压缩链
        logger.debug({ err, roundId }, 'getRoundSummary：记忆索引异常，降级为 null');
        return null;
      }
    },
    // 上下文截断 → 广播 contextTruncated 事件（宿主可提示用户）
    onContextTruncated: (skippedCount, keptCount) => {
      hooks?.emit(AGENT_EVENTS.contextTruncated, { skippedCount, keptCount });
    },
    // LLM 主动压缩完成 → 广播 contextCompressed 事件（宿主可提示"为保持专注已压缩"）
    onContextCompressed: (target, replacedCount, summaryLength) => {
      hooks?.emit(AGENT_EVENTS.contextCompressed, { target, replacedCount, summaryLength });
    },
    // 工具执行完成回调（幂等 outbox 落点）：记录执行到检查点供恢复排重
    // sessionManager 先于 loop 创建，此处可直接写入——无需暂存队列补丁
    onToolExecuted: (name, args, toolResult, ok) => {
      // 幂等级别查内置映射表，自定义工具默认非幂等
      const idempotent: IdempotencyLevel = BUILTIN_TOOL_IDEMPOTENCY[name] ?? 'non-idempotent';
      const record: ToolExecutionRecord = {
        name,
        argsSignature: args,
        executedAt: Date.now(),
        resultSummary: toolResult.slice(0, 100),
        ok,
        idempotent,
      };
      sessionManager.logToolExecution(record);
      // completedToolCalls 仅内存态（不落盘）：「工具重跑排重 / 补偿」仅在单进程存活期内生效，
      // 崩溃/重启后失效（走中断轮补全）。曾经此处的 flushNow() 为 no-op 清脏（宣称落盘、实无动作），
      // 已随 CHKPT-2 减法删除——幂等分级（non-idempotent/idempotent-key）仍决定日志是否保留。
    },
    // 工具执行前检查（统一执行入口·单点聚合）：宿主审批优先（denied 短路返回），放行后再做内部幂等检查。
    // ⚠️ 宿主未注入 preExecutionCheck 时 → 完全降级为仅内部幂等检查。
    // 这是单用户信任模型下的显式决策（intentionally left blank），
    // 多用户/服务端部署必须在宿主层注入真实审批策略（权限/路径/只读等）。
    preExecutionCheck: (name, args): PreExecutionResult => {
      // 1. 宿主审批（审批/审计/参数改写/白名单/只读拦截）
      const hostResult = hooks?.preExecutionCheck?.(name, args);
      if (hostResult?.denied) return hostResult; // 拒绝：直接短路，阻止工具意图
      if (hostResult?.skip) return hostResult; // 跳过：宿主决定不执行
      // 2. 内部幂等检查（补偿机制·仅一次语义）：仅对幂等工具生效，非幂等工具不跳过
      // 幂等契约委托 shouldSkipForIdempotency（SSOT）：non-idempotent 不跳过（失败可重试）；
      // 幂等工具仅上次执行成功（ok=true）时跳过
      const idempotent: IdempotencyLevel = BUILTIN_TOOL_IDEMPOTENCY[name] ?? 'non-idempotent';
      const idemResult = shouldSkipForIdempotency(
        sessionManager.getCheckpoint()?.completedToolCalls,
        name,
        args,
        idempotent,
      );
      return {
        skip: idemResult.skip,
        previousResult: idemResult.previousResult,
        overrideArgs: hostResult?.overrideArgs,
      };
    },
    roundSummaryLoader,
  });

  toolExec.setOnToolsChanged(() => loop.refreshToolDefinitions(toolExec.list));

  // 预算联动：search_project 执行期读取 loop 最近一轮 prepare 的剩余预算，
  // 预算紧张时自动下探结果条数上限（loop 创建后注入，与 read_skill 同款时序解耦）
  toolExec.setBudgetProvider(() => loop.getLastBudget()?.remainingTokens);

  // 观测留痕接线（SEARCH-QUALITY-1 P1-1）：「搜不准」归因取证——toolExecutor 观察
  // web_search 执行事实 → loop.recordWebSearchEvidence 构造证据事件（ts/meetingRound
  // 归 loop）→ appendRoundEvidence 落当前轮随 Round 持久化。
  // 与 setBudgetProvider 同款时序解耦（loop 创建后才可注入）；漏接 = 搜索照跑、证据归零。
  toolExec.setSearchResultObserver((info) => loop.recordWebSearchEvidence(info));

  // 后台任务注册表（run_command background / kill_command 与后台回流的共享单点）：
  // 一个实例同时接两端——toolExec 写（start / kill）、loop 读（完成回流 + turn 终态脱管）。
  // **实例非单例**：每次装配新建一张任务表，多会话各自隔离（否则 kill_command 能杀别的会话的进程）。
  const backgroundTasks = new BackgroundTaskRegistry();
  toolExec.setBackgroundTasks(backgroundTasks);
  loop.setBackgroundTasks(backgroundTasks);

  return { loop, sessionArchiver, textPolisher, roundSummaryGenerator };
}

/**
 * 创建依赖 Loop 的组件
 */
function createLoopDependentComponents(params: LoopDependentParams) {
  const { pctx, loop, history } = params;

  // 删后注记（2026-10-18 · GOVERNANCE-SRC-1 方案②）：此处曾装配 MemoryAdvisor +
  // DedupManager 并 emit dedupCompleted 事件。两者唯一消费方是已退役的 MemoryGovernance
  // 门面，且其取样源 GOVERNANCE_SOURCES 恒为空 ⇒ 拆后无能力损失。勿加回。
  const memoryInspector = new MemoryInspector(pctx.index, loop, history);

  return { memoryInspector };
}

// ── 主组装函数 ─────────────────────────────────────────────

export async function assembleComponents(
  pctx: ProjectContext,
  input: AssembleInput,
): Promise<AssembleOutput> {
  const {
    provider,
    backgroundProvider,
    projectPath,
    configDir,
    activeRolePack,
    rolePackTeams,
    builtinFallbackRole,
    maxContextTokens,
    maxTokens,
    sessionStore,
    roundStore,
    tracer,
    messages,
    enableContextSummary,
    existingSkillManager,
    locale,
    // 宿主传入的工作区信任态快照：只用于常驻规则层的 fail-closed 闸（判据唯一实现 =
    // residentRules 的 isResidentLayerEnabled；非 true 一律按未信任）
    workspaceTrusted,
  } = input;
  const hooks = input.hooks;

  // ── 无依赖组件 ──

  // Agent 层总是注入 createSecurityGuard，此处显式校验并收窄类型
  if (!pctx.security) {
    throw configError('security guard 未注入', undefined, [
      '检查 AgentOptions.permission 或 createSecurityGuard 配置',
    ]);
  }

  const history = new MessageHistory(sessionStore, undefined, undefined, roundStore);

  // 作品投影登记/更新 → 广播 workProjectionGenerated 事件（宿主可展示通知）
  // 投影落项目级目录（pctx.memoraDir/work-projections.json）而非记忆库：随项目隔离，换项目即消失（记忆系统纯化）
  // 作品投影 = 用户主动触发的极简索引（JSON 单文件），AI 按需 read_file 读取原文
  const workProjection = new WorkProjectionManager(
    pctx.memoraDir,
    (sourcePath, description) => {
      hooks?.emit(AGENT_EVENTS.workProjectionGenerated, { sourcePath, summary: description });
    },
    projectPath,
    // 信任态入参：唯一消费面 = setResident 的第一道闸（非 true 一律按未信任）
    workspaceTrusted,
  );

  // 项目规则管理器：清单来源**复用**作品投影（同一份 JSON、同一份刷新缓存），不新开第二份清单读取实现。
  // 依赖经闭包注入而非持有实例：listEntries 每次调用都走 workProjection.refresh()，
  // 保证「常驻段」与「索引块」看到的是同一次读盘的同一份条目（含 resident 字段）。
  // workspaceTrusted 非 true ⇒ 整层不装配且不读任何正文（fail-closed，见 residentRules 常量注释）。
  const residentRules = new ResidentRulesManager({
    projectDir: projectPath,
    workspaceTrusted,
    listEntries: () => workProjection.refresh(),
    isListMalformed: () => workProjection.isFileMalformed,
  });

  const toolExec = new ToolExecutor(
    projectPath,
    pctx.security,
    pctx.index,
    input.webSearchProvider,
    sessionStore,
    input.fetchProvider,
    input.codeExecutionProvider,
    input.projectSearchProvider,
    // 脚本执行 node 路径（可选）：透传 run_project_script 分支
    input.scriptNodePath,
  );

  // ── 后台任务槽位调度器（实例级）──
  // 归属本 Agent 实例（SSOT：一个 Agent = 一个项目）：摘要（round-summary）/ 会话命名（session-title）
  // 经 SeedDeps 注入 seed 使用；命中 touch（search_memories.touch）经 toolExec 注入 builtinHandlers——
  // **两路共用同一实例**，故 close() 单点等待即可覆盖全部后台副作用（旧模块级单例已按 SSOT 归位到实例）。
  const backgroundTasks = new BackgroundTaskScheduler();
  toolExec.setBackgroundTaskScheduler(backgroundTasks);

  // 图片按路径摄取端口（可选）：透传给 read_image 的宿主实现。
  // 不注入 ⇒ resolveActiveTools 不暴露 read_image（能力缺失，不摆一个必失败的工具）
  if (input.imageReadPort) {
    toolExec.setImageReadPort(input.imageReadPort);
  }

  // 工具 deny 集（工具面第二根轴 · 减法，v1 子会话专用）：装配期一次性注入。
  // 时序**不是硬约束**：`setDenyTools` 会经 onToolsChanged → loop.refreshToolDefinitions 重建
  // toolDefinitions 快照，晚注入同样生效（有测试覆盖该重建路径）。此处提前注入只是让
  // createAgentLoopAndDeps 首次读取 `toolExec.list` 时一次到位，少一次无谓重建。
  // 默认空数组不调用 ⇒ 父会话行为零变化（不触发一次多余的暴露面通知）。
  if (input.denyTools && input.denyTools.length > 0) {
    toolExec.setDenyTools(input.denyTools);
  }

  // ── 会话管理器（先于 loop 创建）──

  // SessionManager 构造只存 getter（getHistory/getLoop 惰性取用），不访问 history/loop 本体——
  // 因此可先于 loop 创建，使 loop 的工具执行回调（onToolExecuted/preExecutionCheck）装配期即可
  // 直接写入，无需工具执行期再借助暂存窗口。
  // loop 经闭包变量后赋引用；装配期不会触发 getLoop。
  let loopRef: AgentLoop | null = null;
  const sessionManager = new SessionManager(
    () => history,
    () => loopRef!,
    sessionStore,
    () => hooks?.isChatBusy() ?? false,
    // 会话事件转发：桥接到 Agent 强类型 emit（Agent 侧按 AGENT_EVENT_SET 校验，避免不安全断言）
    (event, data) => hooks?.emit(event, data),
  );

  // ── 依赖 Provider 的组件 ──

  const skillManager = existingSkillManager ?? new SkillManager(configDir);
  await skillManager.load();
  // 禁用技能过滤（配置形态启停）：load 后再设禁用集（load 的 loadItems 会整体替换 items，
  // 顺序无冲突；复用 existingSkillManager 时若有旧禁用集会被本轮覆盖——装配期一次性注入）
  if (input.disabledSkills && input.disabledSkills.length > 0) {
    skillManager.setDisabledSkills(input.disabledSkills);
  }

  // 角色包清单：创建角色包管理器，角色相关功能的唯一真理源
  // activeRolePack：宿主注入**该会话记录的角色包名**（方案 A：随会话文件落盘、装配期一次性解析）；
  // 未配置/包不存在落兜底包（非 items[0]），解析失败由宿主 UI 显式告知（不许静默）
  const rolePackManager = new RolePackManager(configDir);
  // 宿主装配级参数注入：兜底角色覆盖（须存在，否则回退内核常量）+ 组数据（会议名单容器）
  rolePackManager.setBuiltinFallbackRole(builtinFallbackRole ?? null);
  // rolePackTeams 为必选参数（Agent 构造 ?? [] 归一化），直接透传无 null 传播；
  // 漏传在编译期即报错
  rolePackManager.setRolePackTeams(rolePackTeams);
  await rolePackManager.load(activeRolePack);

  // 激活角色包的 L1 persona（角色包唯一；无激活角色包时为空串）
  const rolePackPrompt = rolePackManager.buildSystemPrompt();

  // run_team_meeting：注入评估/评审型会议回调（工具内嵌一次 LLM 调用）
  // rolePackManager 建于 toolExec 之后，用回调注入解耦时序（同 readSkill/registerWork 模式）。
  // 闭包收敛 rolePackManager（getTeam 组解析 + buildSystemPrompt persona 全文）与前台 provider（单次 chat）。
  toolExec.runTeamMeeting = async (group: string, topic: string) =>
    runTeamMeetingAssessment({
      resolveTeam: (g) => rolePackManager.getTeam(g),
      buildPersona: (n) => rolePackManager.buildSystemPrompt(n),
      provider,
      group,
      topic,
    });

  // 渐进披露 L2：注入 read_skill 技能正文读取回调（read_skill 工具数据源）
  // 两级技能统一渐进披露：先查激活角色包内嵌技能，再查全局通用技能池。
  // rolePackManager 在 toolExec 之后创建，用回调注入解耦时序（见 toolExecutor.readSkill 注释）
  toolExec.readSkill = async (skillName: string) => {
    const rolePackContent = await rolePackManager.readSkillContent(skillName);
    if (rolePackContent) return rolePackContent;
    // 全局通用技能：SkillManager 条目正文（已由 load() 装载）
    const globalSkill = skillManager.get(skillName);
    return globalSkill ? globalSkill.content : null;
  };

  // 渐进披露 L3：注入 read_resource 资源读取回调
  // 两级技能统一 L3：先查激活角色包内嵌技能的资源，再查全局通用技能
  toolExec.readResource = async (skillName: string, resourcePath: string) => {
    const rolePackResource = await rolePackManager.readSkillResource(skillName, resourcePath);
    if (rolePackResource) return rolePackResource;
    return skillManager.readResource(skillName, resourcePath);
  };

  // 渐进披露 L3：技能脚本目标解析（角色包 → 全局池，唯一解析点 · CMD-1-CONTENT）
  //
  // 执行闭包（runSkillScript）与裁决面回调（resolveSkillScript）共用本函数 ⇒
  // 「哪个技能目录的哪个脚本」的解析顺序天然单点——两处各写一遍即是漂移回归
  // （同序守卫：assembler.test.ts 断言 resolver 返的路径 = 执行实际 spawn 的文件，
  // 两分支各一例；另有一例锚「同名技能角色包压过全局池」——顺序反了同源断言不会红，
  // 只有优先级用例能抓到）。
  // 防逃逸由两侧解析器自身保证（角色包 layer3 白名单 + resolveSafePath 边界前缀；
  // 全局 resolveLayer3ScriptPath + existsSyncSafe），本函数不做第二套路径校验。
  const resolveSkillScriptTarget = (
    skillName: string,
    scriptPath: string,
  ): { absolutePath: string; runtime: ScriptRuntime } | null => {
    // 先查激活角色包内嵌技能的脚本路径
    const rolePackPath = rolePackManager.getSkillScriptPath(skillName, scriptPath);
    if (rolePackPath) {
      const scriptInfo = rolePackManager.getSkillScriptInfo(skillName, scriptPath);
      if (scriptInfo) return { absolutePath: rolePackPath, runtime: scriptInfo.runtime };
    }
    // 再查全局通用技能
    const globalPath = skillManager.getScriptPath(skillName, scriptPath);
    if (globalPath) {
      const scripts = skillManager.listScripts(skillName);
      const scriptInfo = scripts.find((s) => s.path === scriptPath);
      if (scriptInfo) return { absolutePath: globalPath, runtime: scriptInfo.runtime };
    }
    return null;
  };

  // 渐进披露 L3：注入 run_skill_script 脚本执行回调
  toolExec.runSkillScript = async (
    skillName: string,
    scriptPath: string,
    args: string[],
    // 中断信号透传（TOOL-ABORT-KILL-1）：技能脚本是子进程面，abort 后先杀树再返回
    signal?: AbortSignal,
  ) => {
    // cwd=项目根（SKILL-CWD-1，2026-10-14）：与 run_project_script 同款供给——修因不修果，
    // 改喂给判据的事实：脚本内相对路径 / 省略 --dir 走默认，落点一律受 projectPath 约束。
    // 修复前此处传 undefined → 子进程继承宿主进程 cwd（VS Code 安装目录）→ 写文件可逃出项目根。
    // projectPath 恒存在（AgentOptions 必填），无「未打开项目」分支。
    const target = resolveSkillScriptTarget(skillName, scriptPath);
    if (!target) return null;
    // 执行超时走内核默认（60s，上限 600s，见 skillScriptRunner 常量）——脚本级超时无配置通道
    // nodePath 沿用宿主注入：技能脚本 node runtime 分支可走真实 node 路径
    // B2-a：返回结构化事实，formatScriptResult 由 ToolExecutor 单点收口
    return runSkillScript(
      target.absolutePath,
      target.runtime,
      args,
      undefined,
      projectPath,
      input.scriptNodePath,
      signal,
    );
  };

  // 渐进披露 L3：注入 run_skill_script 路径解析回调（CMD-1-CONTENT 裁决面）
  //
  // 与执行回调是**同一个解析函数的两面**：只返绝对路径、不执行。toolExecutor 确认点
  // 用它定位技能脚本文件读正文，经 confirmByEntry 的 content 参喂同一个
  // classifyCommand（deny 恒拦 / always-ask 恒弹 / normal 回落档位）——技能脚本执行
  // 面此前面向「来源可信」免检（CMD-1-BYPASS 最后一面），现与 run_code /
  // run_project_script 对齐黑名单底线。未注入（纯 ToolExecutor 单测等场景）=
  // 不传正文，执行面行为不变。
  toolExec.resolveSkillScript = (skillName: string, scriptPath: string): string | null =>
    resolveSkillScriptTarget(skillName, scriptPath)?.absolutePath ?? null;

  // 渐进披露 L3：注入 list_resources 资源清单回调
  toolExec.listResources = async (skillName: string) => {
    // 先查激活角色包，再查全局通用技能
    const roleResources = rolePackManager.listSkillResources(skillName);
    if (roleResources.length > 0) {
      return JSON.stringify(
        roleResources.map((r) => ({ path: r.path, size: r.size })),
        null,
        2,
      );
    }
    const globalResources = skillManager.listResources(skillName);
    return JSON.stringify(
      globalResources.map((r) => ({ path: r.path, size: r.size })),
      null,
      2,
    );
  };

  // 渐进披露 L1 补充：注入 list_skills 技能清单回调 (使用 SkillManager.formatSkillForPrompt SSOT)
  toolExec.listSkills = async () => {
    const lines: string[] = ['【全局通用技能】'];
    // 过滤**收口于 SkillManager.listAvailable**（LLM 可见集唯一真理源，与 L1 枚举侧共用）：
    // 可用性（缺 description 模型不知何时激活）+ 禁用（对模型语义不存在）两条判据
    // 都在那里。此处**不得**自写 filter——两侧同为 LLM 消费，判据分叉即双轨镜像。
    // ⚠️ 漏过滤即带伤：若只过滤 description、漏掉禁用过滤，禁用技能仍对模型可见；
    // 注释声明的「过滤标准必须一致」必须与实现同源。
    const availableGlobalSkills = skillManager.listAvailable();
    for (const skill of availableGlobalSkills) {
      const formatted = SkillManager.formatSkillForPrompt(skill);
      if (formatted) lines.push(formatted);
    }
    // 技能清单跟随本轮装配视角（会议内 = 任务项角色；非会议 = activePack）
    const perspectiveName = rolePackManager.roundAssemblyPerspective ?? rolePackManager.activeName;
    if (perspectiveName) {
      lines.push('');
      lines.push(`【装配角色技能（${perspectiveName}）】`);
      // 直接用结构化数据（RolePackAssembly.skills），不再正则解析 prompt 文本
      const assembly = rolePackManager.get(perspectiveName);
      const skills = assembly?.skills ?? [];
      for (const skill of skills) {
        const fallbackName = skill.file
          ? rolePackManager.deriveSkillNameFromFile(skill.file)
          : undefined;
        const formatted = SkillManager.formatSkillForPrompt(skill, fallbackName);
        if (formatted) lines.push(formatted);
      }
    }
    return lines.join('\n');
  };

  // 作品投影登记：注入 register_work 工具回调（用户主动触发，写 JSON 索引）
  // 复用 read_skill 的注入回调模式——ToolExecutor 不持有 WorkProjectionManager，装配层解耦时序
  toolExec.registerWork = async (sourcePath: string, description: string) => {
    const entry = await workProjection.registerWork(sourcePath, description);
    return entry
      ? `✅ 已登记作品索引：${entry.name}（${entry.description}）\n源文件：${entry.source}`
      : '[ERR:REGISTER_FAILED] 作品索引登记失败';
  };

  // ── AgentLoop + 其直接依赖 ──

  // 作品投影装配注入：使用 SSOT 读取路径（刷新 + 读取合为单一操作）
  // 刷新失败不阻断装配——loadAndGetContextBlock 内部已容错，返回空串即不注入（投影是可选项，非装配硬依赖）
  const workProjectionContext = await workProjection.loadAndGetContextBlock();

  // 项目规则装配首次求值（每轮 turn 入口还会再刷一次，见 SeedDeps.refreshResidentRulesContext）。
  // 注意顺序：本调用内部经 listEntries 再刷一次作品投影缓存（装配期一次性多一次读盘），
  // 不应依赖「上一步的 loadAndGetContextBlock 已经刷过」——两个 manager 各自自足，
  // 否则 setResident / 单测单独使用 residentRules 时会读到陈旧清单。
  // 读盘失败一律降级（不抛错），装配不因常驻段失败而中断。
  await residentRules.refresh();

  // 运行环境事实段（命令执行能力方案 §10.4-②）：从宿主环境提供者同步取快照并格式化。
  // getEnvironment 同步返回（探测节奏宿主自理，内核零等待）；未注入/返回 null → 空串不注入。
  // 环境事实只进 prompt（给模型看），不进任何内核判据（命令执行能力方案 §10.5 刻意不做）。
  const environmentContext = buildEnvironmentContextBlock(
    input.environmentProvider?.getEnvironment() ?? null,
  );

  const { loop, sessionArchiver, textPolisher, roundSummaryGenerator } =
    await createAgentLoopAndDeps({
      provider,
      backgroundProvider,
      pctx,
      rolePackPrompt,
      skillManager,
      toolExec,
      maxContextTokens,
      maxTokens,
      tracer,
      messages,
      enableContextSummary,
      sessionStore,
      locale,
      sessionManager,
      hooks,
      imageReadPort: input.imageReadPort,
      workProjectionContext,
      environmentContext,
      // 项目规则段：同步读上一步 refresh 得到的段（未信任 / 无条目 / 读失败时为空串，不注入）
      residentRulesContext: residentRules.contextBlock(),
    });
  loopRef = loop;

  // ── delegate_task 派发端口（子会话 v1）──
  // 子装配与本模块 createAgentLoopAndDeps 同源：父侧新增安全选项时同文件可见、不会漏配。
  // 并发硬限：同一步最多 SUBAGENT_MAX_CONCURRENT 个（信号量；超出直接报错，不排队——
  // 排队会把父 step 拖成长尾，父又无法取消单个子任务）。
  const subagentParams: SubagentRuntimeParams = {
    provider,
    projectPath,
    security: pctx.security,
    memoryIndex: pctx.index,
    sessionStore,
    webSearchProvider: input.webSearchProvider,
    fetchProvider: input.fetchProvider,
    projectSearchProvider: input.projectSearchProvider,
    imageReadPort: input.imageReadPort,
    scriptNodePath: input.scriptNodePath,
    maxContextTokens,
    maxTokens,
    rolePackManager,
    skillManager,
    workProjectionContext,
    environmentContext,
    residentRulesContext: residentRules.contextBlock(),
    locale,
  };
  // 在途子会话计数：只用于并发闸，不参与深度判定（深度由「子装配不注入端口」结构性保证）
  toolExec.setDelegateTask(createDelegateTaskPort(subagentParams).port);

  // 装配 loop 运行时回调 + 任务表管理（onPendingQuestion/onPlanItemBoundary/getTaskTable/planManager）
  wireRuntimeCallbacks(loop, toolExec, sessionManager, hooks, history);

  // ── 依赖 Loop 的组件 ──

  const { memoryInspector } = createLoopDependentComponents({
    pctx,
    loop,
    history,
  });

  // 绑定记忆写入回调：round-summary 沉淀后广播 memoryAdded 事件
  roundSummaryGenerator.setOnMemoryAdded((info) => {
    hooks?.emit(AGENT_EVENTS.memoryAdded, info);
  });
  // 接线 search_memories 后端：toolExec 先于 memoryInspector 构造，故此处后注入；
  // 注入后 search_memories 走 searchByKeyword（关键词+superseded 过滤+accessedAt/溯源揭示，§3.3；纯关键词单通道，无语义通道）
  toolExec.setMemoryInspector(memoryInspector);
  // 接线 memoryRecalled 事件（§2.4 保留改语义定案）：search_memories 命中记忆 → 宿主广播
  // 「LLM 查询记忆命中 N 条」。唯一发射位 = search_memories 命中
  // （无 warmRecall 等其他发射路径）。
  // MEM-EVENT-3：同一次发射再落一份证据（Round.evidence），让重放历史轮能重建命中明细——
  // 事件是实时专属（不进 processEvents），只广播不落盘 ⇒ 回看时明细永久不可考。
  // 两者同源一次触发（不同消费面：实时可见 / 落盘可回看），不是两条观测通道。
  toolExec.setOnMemoryRecalled((info) => {
    hooks?.emit(AGENT_EVENTS.memoryRecalled, info);
    loop.recordMemoryHitsEvidence(info);
  });
  // 接线工具召回与装配期内容互斥（§5.1）：search_memories 排除「正文或摘要已在眼前」的轮次
  // round-summary，避免 LLM 拿回眼前内容的摘要重复。排除集从 loop 工作记忆视图精确派生
  // （getExclusionRoundIds = 视图内 ∪ 被替换 ∪ 在途），与模型窗口无关，不用固定轮数代理量。
  toolExec.setExclusionRoundIdsProvider(() => loop.getExclusionRoundIds());

  // ── 输入增强管线 ──

  // ContextPreparer 依赖已装配的 loop/history/rolePackManager；策略推导走 rolePackManager（SSOT）。
  const contextPreparer = new ContextPreparer({
    loop,
    rolePackManager,
    getIndex: () => pctx.index,
    config: {
      // 组装器可选字段（undefined）收窄为 deps 的显式 null（关闭语义）
      tracer: tracer ?? null,
      messages,
      // 上下文预算装配的容量来源（动态轮数派生基准）
      maxContextTokens,
    },
    // 事件发射桥接到 Agent 强类型 emit（Agent 侧按 AGENT_EVENT_SET 校验）
    emit: (event, data) => hooks?.emit(event, data),
  });

  return {
    history,
    loop,
    toolExec,
    backgroundTasks,
    workProjection,
    residentRules,
    skillManager,
    memoryInspector,
    sessionArchiver,
    textPolisher,
    rolePackManager,
    roundSummaryGenerator,
    sessionManager,
    contextPreparer,
  };
}
