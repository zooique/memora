/**
 * 守卫抽象（GuardRail）—— loop 运行时前置拦截型护栏的统一真理源
 *
 * 背景：联网搜索上限 / 提问上限 / 同路径连写止损 / 读取失败硬闸 / 重复读取拦截
 * 这 5 种前置拦截型护栏统一走注册式 guard，避免以「内联 if + 独立计数字段 + 各自文案 +
 * 各自阈值」散落在主循环里、每加一种护栏就改一遍主循环。
 *
 * 本模块收敛目标：**新增一种护栏 = 注册一个 guard（matches/shouldBlock/文案/阈值/life/可选 write 钩子），
 * 主循环零改动**。护栏判定逻辑、判定顺序、提示词、阈值全部收敛到本文件，消除散落重复。
 *
 * 防重双轨正交登记（二者粒度不同不可合并）：
 * - a（批级·软提示）：duplicateToolCallInterceptor，作用于**整批工具调用**（跨迭代哈希），
 *   语义 = 叙事级死循环提醒（默认实现只返 ok/warn，永不 block），见 loop.handleIteration；
 * - b（主体级·硬拦）：本文件 read_dedup 护栏，作用于**同一读取主体**（闭环内同工具+同参数），
 *   语义 = 事实级去重拦截（命中后回填 `[ALREADY_READ]`），前提前 `isCachedResultStillInContext`。
 *   两套去重同一时刻开启、判据/阈值/生命周期互不共享，靠本条登记维系语义边界。
 *
 * 收敛边界（不硬吞的异构护栏，维持各自为政）：
 * - duplicateToolCallInterceptor（批级·软提示，见上「防重双轨正交登记」a 轨）；
 * - maxIterations/stepBudget（循环终止）、self_review（后处理）——`contextLimit` 已不属此类（它只缩放有效窗口，不终止）；
 * - interruptQueue/pause/ask 续跑（暂停-质问-续跑设计，另有定稿文档，不动）；
 * - 文件覆盖度台账（fileExposure 分支②回显，见 toolLedger.ts）——形态不同，不收敛。
 *
 * 收敛现状：本模块已按注册序对 5 闸做**真拦截判定**（evaluateBlocked 由 loop 调用，命中回填拒绝文案），
 * loop 只保留最小职责（组 GuardContext + 调 evaluateBlocked 判定 + 调 notifyExec 写侧喂数、
 * reset 归零内部计数状态）。「## 行为护栏」节由 buildPromptSection 收敛注入。
 */
import {
  DEDUP_SUBJECT_EXTRACTORS,
  formatDedupSubject,
  failureSubjectKey,
  normalizePathKey,
  ToolResultCache,
  type CacheEntry,
  type DedupSubject,
} from '@/agent/toolResultCache.js';

/** 护栏类型 id（收敛集合，新增护栏在此扩联合） */
export type GuardRailId =
  | 'search_limit' //  联网搜索硬上限（命中后停搜，带 afterBlock 副钩）
  | 'ask_limit' //    单次用户输入内提问上限（life:'perInput'，跨续跑累计）
  | 'write_loop' //   同一文件路径连续重写止损
  | 'read_failed' //  同一读取主体连续失败硬闸（幻觉文件重读风暴）
  | 'read_dedup'; //  闭环内同一读取主体去重拦截

/** 命中提示词 id（与 GuardRailPromptId 一一对应，文案收敛到 GUARD_RAIL_PROMPTS） */
export type GuardRailPromptId =
  | 'search_limit'
  | 'ask_limit'
  | 'write_loop_stop'
  | 'read_failed_limit'
  | 'already_read';

/** 护栏运行态计数（loop 注入，仅承载 search_limit / ask_limit 两枚；write_loop 连写 / read_failed 失败
 *  计数内聚进各自 guard 实例闭包，经 onExec 自持更新） */
export interface GuardCounters {
  /** 本闭环内 web_search 调用次数（含被拒绝的）—— search_limit 用 */
  searchCallCount: number;
  /** 本用户输入的提问累计数（life:'perInput'）—— ask_limit 用 */
  askCountThisTurn: number;
}

/** onExec 写侧喂数上下文：结果处理阶段由 loop 构造，仅承载 feeds 所需字段 + 本次执行结果 */
export interface GuardExecContext {
  toolName: string;
  /** 原始工具参数 JSON 串（用于 path/subject 提取） */
  argsJson: string;
  toolCallId: string;
  /** 本次执行结果：ok=真实成功 / failed=执行失败 / blocked=被护栏或台账拦截（未真正执行） */
  outcome: 'ok' | 'failed' | 'blocked';
}

/** 护栏阈值（运行时由调用方注入 GuardContext；真源分配见下） */
export interface GuardThresholds {
  /** 同路径连写止损阈值（原 WRITE_LOOP_THRESHOLD = 5）：第 N 次触发硬拦 —— 静态真源 GUARD_THRESHOLDS */
  writeLoop: number;
  /** 同主体连续失败硬闸阈值（原默认 3）—— 静态真源 GUARD_THRESHOLDS */
  readFailed: number;
  /** 单次用户输入提问上限（life:'perInput'）—— 动态真源 role-pack strategy.askLimit（不塞静态默认） */
  askLimit: number;
  /** 单闭环联网搜索硬上限 —— 动态真源 LOOP_CONSTANTS.MAX_WEB_SEARCH_CALLS（不塞静态默认） */
  maxWebSearch: number;
}

/** 静态阈值真源（SSOT）：只承载「纯静态、无动态覆盖」的阈值。
 *  writeLoop / readFailed 以此为唯一真源；askLimit / maxWebSearch 属动态注入
 *  （角色包 strategy / LOOP_CONSTANTS，历史曾把 20/8 塞进静态默认作死值、与运行时覆盖矛盾，经审查清除）。
 *  调用方构造 GuardContext.thresholds 时须以本表为基底补齐两枚动态键。 */
export const GUARD_THRESHOLDS = {
  writeLoop: 5,
  readFailed: 3,
} as const satisfies Pick<GuardThresholds, 'writeLoop' | 'readFailed'>;

/** 单工具 + 本 turn 运行态的护栏判定上下文 */
export interface GuardContext {
  toolName: string;
  /** 原始工具参数 JSON 串（用于 subject 提取） */
  argsJson: string;
  toolCallId: string;
  /** 工具结果防重缓存（read_dedup 分支①核查用） */
  toolResultCache: ToolResultCache;
  /** 分支①「结果仍是否在上下文」判定（loop 注入：读上下文内容） */
  isCachedResultStillInContext: (hit: CacheEntry) => boolean;
  /** 护栏阈值（loop 构造时填实际值；缺省回落 GUARD_THRESHOLDS） */
  thresholds: GuardThresholds;
  /** 运行态计数（loop 注入，供 search_limit/ask_limit 用；write_loop/read_failed 的计数已在 guard 闭包内） */
  counters: GuardCounters;
}

/** 护栏定义（注册一条，主循环零改动） */
export interface GuardRailDef {
  /** 护栏类型 id */
  id: GuardRailId;
  /** 适用工具判定 */
  matches: (c: GuardContext) => boolean;
  /** 前置拦截判定：true = 需拦截 */
  shouldBlock: (c: GuardContext) => boolean;
  /** true = 真拦截（回填拒绝文案）/ false = 软提示 */
  blocked: boolean;
  /** 命中文案 key（引用 GUARD_RAIL_PROMPTS，勿内联文案） */
  promptId: GuardRailPromptId;
  /** 模板插值参数（路径 / 次数 / 阈值等） */
  promptArgs?: (c: GuardContext) => Record<string, unknown>;
  /** 生命周期：perInput=按一次用户输入累计 / perStep=按闭环累计 */
  life: 'perInput' | 'perStep';
  /** 副钩（仅 search）：命中后置 searchDisabled + rebuild system message；须幂等 */
  afterBlock?: (c: GuardContext) => void;
  /** 写侧钩子：结果处理阶段由 loop 对每个 toolCall 调 notifyExec 分发本钩子喂计数
   *  （失败+1 / 成功清0 / 连写递增 / 拦截不计）。守卫自持闭包状态的统一入口。 */
  onExec?: (c: GuardExecContext) => void;
  /** 归零 guard 自身内部计数状态（life 过期 / 轮边界由 GuardRail.reset 统一调用） */
  reset?: () => void;
  /** 注入 systemPrompt「## 行为护栏」节的通用约束声明（不强塞逐轮计数） */
  promptGuideline?: string;
}

/** 命中结果：命中的护栏 + 渲染后的拒绝文案 */
export interface GuardHit {
  guardId: GuardRailId;
  message: string;
}

/** 提取给定工具的请求主体（无该工具的 subject 提取器 → undefined，即非 info 型工具） */
export function extractSubject(toolName: string, argsJson: string): DedupSubject | undefined {
  const extractor = DEDUP_SUBJECT_EXTRACTORS[toolName];
  return extractor ? extractor(argsJson) : undefined;
}

/** 解析 write_file 参数里的路径并归一（非 JSON / 空路径 → null，即不参与连写判定） */
function parseWritePath(argsJson: string): string | null {
  try {
    const a = JSON.parse(argsJson) as { path?: string };
    if (typeof a?.path === 'string' && a.path.trim()) return normalizePathKey(a.path);
  } catch {
    /* 参数非 JSON → 不参与连写 */
  }
  return null;
}

// ---------------------------------------------------------------------------
// 衔接提示词统一真理源（SSOT）：命中文案收敛于此，格式统一 `[TAG] 已…/请…`
// 运行时命中时 renderPrompt(promptId, promptArgs) 即时渲染；systemPrompt 只放通用声明、不放命中文案。
// ---------------------------------------------------------------------------
export const GUARD_RAIL_PROMPTS: Readonly<Record<GuardRailPromptId, string>> = {
  // 占位：{limit}=搜索上限；{tail}=补充指引（由 promptArgs 提供）
  search_limit:
    `[SEARCH_LIMIT_REACHED] 已执行 {limit} 次联网搜索，信息应已足够；` +
    `请停止调用 web_search，直接基于现有搜索结果作答。`,
  // 占位：{limit}=提问上限
  ask_limit: `[ASK_LIMIT] 本问答闭环已提问 {limit} 次（上限），请基于现有信息继续，不要再调用 ask_user。`,
  // 占位：{n}=连续重写次数；{subject}=被反复重写的文件路径
  write_loop_stop:
    `[WRITE_LOOP_STOP] 你已连续 {n} 次重写同一文件 {subject}，` +
    `疑似在自环清理/重建内容。请先 list_dir/read_file 确认真实文件状态，或明确重写章法后再动手；` +
    `不要对同一文件反复 write_file。`,
  // 占位：{n}=连续失败次数；{limit}=失败阈值
  read_failed_limit:
    `[READ_FAILED_LIMIT] 该目标已连续失败 {n} 次（阈值 {limit}），` +
    `可能不存在。请先用 list_dir 确认路径，或改用其它目标。`,
  // 占位：{n}=首次获取步序；{format}=去重主体可读描述；{tail}=续读引导（read_file 专用）
  already_read:
    `[ALREADY_READ] 该结果仍在你的当前上下文中（第 {n} 步获取：{format}），无需重复获取。` +
    `{tail}`,
};

/** 渲染护栏命中文案（占位符替换；未知键原样保留） */
export function renderPrompt(
  promptId: GuardRailPromptId,
  args: Record<string, unknown> = {},
): string {
  let out = GUARD_RAIL_PROMPTS[promptId];
  for (const [k, v] of Object.entries(args)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}

/** 各护栏的通用约束声明（聚合进 buildSystemPrompt 的「## 行为护栏」节）。
 *  只写**描述性约束，不嵌入运行时拒绝文案的 `[TAG]` 字面量**：system prompt 是常驻消息，
 *  若直接暴露 `[ALREADY_READ]` 等发送令牌，会让「按令牌定位运行时拒绝消息」的消费方（测试/宿主）
 *  误命 system prompt；令牌只在拦截真正命中时由 renderPrompt 即时产出。 */
const GUIDELINES: Readonly<Record<GuardRailId, string | undefined>> = {
  read_dedup:
    '重复读取同一文件/搜索同一主体将被拦截并提示；如需文件其它部分请用 offset/limit 指定行区间。',
  read_failed:
    '同一目标连续读取失败达阈值会被硬拦；请先 list_dir 确认路径或改用其它目标。',
  write_loop:
    '同一文件被反复重写会触发写作死循环保护；请先 read_file/list_dir 确认真实状态再落笔。',
  ask_limit: '每个问答闭环仅允许有限次提问；基于现有信息继续，不要反复追问。',
  search_limit: '联网搜索达上限后视为信息已足；直接基于已有结果作答。',
};

/**
 * 守卫容器（注册表容器 + 统一判定入口）
 *
 * 判定纪律：`evaluateBlocked` 按注册顺序遍历，返回**首个** `matches && shouldBlock` 的硬拦命中。
 * 注册顺序即判定优先级（read_failed 必须先于 read_dedup——失败先于去重判定，与 loop 既有语义一致）。
 *
 * 判定与状态均为真拦截/真状态：evaluateBlocked 由 loop 调用并回填拒绝文案；
 * write_loop/read_failed 的计数状态内聚进 guard 实例闭包，由 notifyExec 写侧喂数、reset 归零。
 */
export class GuardRail {
  /** 有序注册表（注册序即判定序） */
  private readonly registry: GuardRailDef[] = [];

  /** 注册一条护栏（返回 this 便于链式） */
  register(def: GuardRailDef): this {
    this.registry.push(def);
    return this;
  }

  /** 注册表（只读视图，供测试/审计盘点） */
  get guards(): ReadonlyArray<GuardRailDef> {
    return this.registry;
  }

  /** 统一判定入口：按注册序返回首个硬拦命中；无命中返回 undefined */
  evaluateBlocked(c: GuardContext): GuardHit | undefined {
    for (const g of this.registry) {
      if (!g.blocked) continue;
      if (!g.matches(c)) continue;
      if (!g.shouldBlock(c)) continue;
      const args = g.promptArgs?.(c) ?? {};
      return { guardId: g.id, message: renderPrompt(g.promptId, args) };
    }
    return undefined;
  }

  /** 写侧喂数钩子分发：结果处理阶段由 loop 对每个 toolCall 调此方法。
   *  matches 校验复用 GuardContext 判定（构造最小临时 ctx）；命中即调 g.onExec 喂计数。 */
  notifyExec(c: GuardExecContext): void {
    // 构造最小临时 GuardContext：matches 仅依赖 toolName，其余字段占位即可
    const matchCtx: GuardContext = {
      toolName: c.toolName,
      argsJson: c.argsJson,
      toolCallId: c.toolCallId,
      toolResultCache: new ToolResultCache(),
      isCachedResultStillInContext: () => false,
      thresholds: GUARD_THRESHOLDS as GuardThresholds,
      counters: { searchCallCount: 0, askCountThisTurn: 0 },
    };
    for (const g of this.registry) {
      if (g.matches(matchCtx)) g.onExec?.(c);
    }
  }

  /** 归零指定生命周期 guard 的内部计数状态（life 轮边界由 loop 调 resetTurnState 统一触发） */
  reset(life: 'perInput' | 'perStep'): void {
    for (const g of this.registry) {
      if (g.life === life) g.reset?.();
    }
  }

  /** 生成「## 行为护栏」通用声明节（注入 buildSystemPrompt；只放通用约束，不暴露逐轮计数） */
  buildPromptSection(): string {
    const lines = this.registry
      .map((g) => GUIDELINES[g.id])
      .filter((s): s is string => Boolean(s));
    if (lines.length === 0) return '';
    return `\n\n## 行为护栏\n${lines.map((s) => `- ${s}`).join('\n')}`;
  }
}

/**
 * 组装一份缺省护栏注册表：覆盖 5 种前置拦截型护栏，判定序 = read_failed 先于 read_dedup。
 *
 * 提供静态判定的**纯函数默认集**，loop 接入时可整表注册；阈值经 ctx.thresholds 由 loop 覆盖为实际值。
 */
export function createDefaultGuards(): GuardRail {
  // write_loop / read_failed 的计数状态各归本函数闭包（createDefaultGuards 每实例一份，
  // loop 每个实例都 new 一个守卫容器 → 状态每实例独立，安全），经 onExec 喂数、reset 归零。
  let write = { lastWritePath: null as string | null, samePathWriteStreak: 0 };
  const readFailBySubject = new Map<string, number>();
  // 期望连写递增后值（读闭包 write，不做状态迁移；迁移交给 onExec）
  const nextWriteStreak = (p: string): number =>
    write.lastWritePath === p ? write.samePathWriteStreak + 1 : 1;
  // read_failed 的 subject-key 提取（无 subject → null）
  const readFailKey = (toolName: string, argsJson: string): string | null => {
    const subject = extractSubject(toolName, argsJson);
    return subject ? failureSubjectKey(toolName, subject) : null;
  };
  return new GuardRail()
    .register({
      id: 'search_limit',
      matches: (c) => c.toolName === 'web_search',
      // 现有 loop 语义：`searchCallCount > MAX_WEB_SEARCH_CALLS`（超上限才拦）
      shouldBlock: (c) => c.counters.searchCallCount > c.thresholds.maxWebSearch,
      blocked: true,
      promptId: 'search_limit',
      promptArgs: (c) => ({ limit: c.thresholds.maxWebSearch }),
      life: 'perStep',
    })
    .register({
      id: 'ask_limit',
      matches: (c) => c.toolName === 'ask_user',
      // 现有 loop 语义：`askCountThisTurn >= askLimit`（达上限即拦）
      shouldBlock: (c) => c.counters.askCountThisTurn >= c.thresholds.askLimit,
      blocked: true,
      promptId: 'ask_limit',
      promptArgs: (c) => ({ limit: c.thresholds.askLimit }),
      life: 'perInput',
    })
    .register({
      id: 'write_loop',
      matches: (c) => c.toolName === 'write_file',
      // 现有 loop 语义：同路径则 streak+1、换路径则复位为 1，达到阈值拦。
      // 计数读闭包 write，只读推断期望递增后值、不改自身状态（迁移交给 onExec）。
      shouldBlock: (c) => {
        const p = parseWritePath(c.argsJson);
        if (!p) return false;
        return nextWriteStreak(p) >= c.thresholds.writeLoop;
      },
      blocked: true,
      promptId: 'write_loop_stop',
      promptArgs: (c) => {
        const p = parseWritePath(c.argsJson);
        if (!p) return { n: c.thresholds.writeLoop, subject: '' };
        return { n: Math.max(nextWriteStreak(p), c.thresholds.writeLoop), subject: p };
      },
      onExec: (c) => {
        // blocked = 未真正执行，不累计连写（否则被拒后的同路径重写会把 streak 虚抬，误伤后续合法写入）
        if (c.outcome === 'blocked') return;
        const p = parseWritePath(c.argsJson);
        if (p) {
          write.samePathWriteStreak = nextWriteStreak(p);
          write.lastWritePath = p;
        }
      },
      reset: () => {
        write = { lastWritePath: null, samePathWriteStreak: 0 };
      },
      life: 'perStep',
    })
    .register({
      id: 'read_failed',
      matches: (c) => DEDUP_SUBJECT_EXTRACTORS[c.toolName] !== undefined,
      // 计数读闭包 readFailBySubject，状态迁移交给 onExec
      shouldBlock: (c) => {
        const key = readFailKey(c.toolName, c.argsJson);
        if (key === null) return false;
        const failCount = readFailBySubject.get(key);
        return failCount !== undefined && failCount >= c.thresholds.readFailed;
      },
      blocked: true,
      promptId: 'read_failed_limit',
      promptArgs: (c) => {
        const key = readFailKey(c.toolName, c.argsJson);
        return { n: key ? (readFailBySubject.get(key) ?? 0) : 0, limit: c.thresholds.readFailed };
      },
      onExec: (c) => {
        const key = readFailKey(c.toolName, c.argsJson);
        if (key === null) return;
        if (c.outcome === 'ok') readFailBySubject.delete(key);
        else if (c.outcome === 'failed') readFailBySubject.set(key, (readFailBySubject.get(key) ?? 0) + 1);
        // blocked 不计失败（未真正执行）
      },
      reset: () => readFailBySubject.clear(),
      life: 'perStep',
    })
    .register({
      id: 'read_dedup',
      matches: (c) => DEDUP_SUBJECT_EXTRACTORS[c.toolName] !== undefined,
      // 仅在「结果确实仍在上下文」时才拦（CTX-1 防死锁：否则内容已压缩/裁剪，告知"基于已有"=指令撒谎）
      shouldBlock: (c) => {
        const subject = extractSubject(c.toolName, c.argsJson);
        if (!subject) return false;
        const hit = c.toolResultCache.check(c.toolName, subject);
        return hit !== undefined && c.isCachedResultStillInContext(hit);
      },
      blocked: true,
      promptId: 'already_read',
      promptArgs: (c) => {
        const subject = extractSubject(c.toolName, c.argsJson);
        const hit = subject
          ? c.toolResultCache.check(c.toolName, subject)
          : undefined;
        return {
          n: hit?.cachedAtIteration ?? 0,
          format: subject ? formatDedupSubject(c.toolName, subject) : '',
          // 「offset/limit 引导」仅对 read_file 有意义（文件可分区间续读）；URL/会话/query 等主体无此语义
          tail:
            c.toolName === 'read_file'
              ? `如需该文件的其它部分，请用 offset/limit 指定行区间。`
              : `直接基于已有内容继续即可。`,
        };
      },
      life: 'perStep',
    });
}