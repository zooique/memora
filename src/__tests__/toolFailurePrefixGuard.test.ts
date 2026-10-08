/**
 * 工具结果首标签 · **反向对账守卫**（SCRIPT-2 B5-e 补丁 · 重建于判据桥消亡之后）
 *
 * ## 为什么需要这个文件（B4/B5 删掉旧守卫后留下的两个实锤缺口）
 *
 * 旧版 `toolFailurePrefixGuard.test.ts` 随 `isToolFailure` 判据桥一起被物理删除，
 * 只留下 `toolRunner.test.ts` 里那条「裸失败前缀return 残留守卫」。后者有两个**实测**缺口：
 *
 * 1. **覆盖面倒退**：旧守卫扫 4 个 producer，现存守卫的 `PROD_FILES` 只有 3 个 ——
 *    `skillScriptRunner.ts`（`formatExecutionResult` 真理源，SCRIPT-1 长出
 *    `[SCRIPT_ERROR]` 的那个函数）与 `backgroundTasks.ts` 掉出扫描面。
 * 2. **拼接形式失明**：现存守卫的正则要求标签是**字面量**
 *    （`/return\s*['"`]\[(?:ERR…|(?:SCRIPT|CODE|COMMAND)_(?:ERROR|TIMEOUT))]/`），
 *    而 `skillScriptRunner.ts` 的真实产出是**模板拼接**：
 *    `return \`[${labels.kind}_TIMEOUT] …\`` ⇒ 正则不命中 ⇒ 直接逃过守卫。
 *
 * ## 判据反转：从「点名已知失败前缀」改成「扫出全部首标签 ⋷ 登记表」
 *
 * 已被证伪的那条教训决定了本文件的设计：当年契约测试宣称「新增护栏文案未登记即转红」，
 * 实测把返回值改写成全新的 `[NETWORK_ERROR]` 时 **62 passed 全绿** —— 它只钉死已登记前缀，
 * 测不出**新增未登记**的前缀。所以本守卫**不点名任何前缀**：
 *
 * · **扫描**：引号 / 注释感知的递归字面量提取 ⇒ 取**首字符即标签**的产出
 *   （字面量 `[XXX]` 与拼接 `[${…}]` 两种形式都抓）。
 * · **拼接归一化**：模板标签不按字面登记，而是**从真源展开**——
 *   `${labels.kind}` 取 `skillScriptRunner.ts` 里`kind:` 联合类型声明的成员，
 *   `${code}` 取 `errors.ts` 里 `ToolErrorCode` 常量的值。
 *   ⇒ 拼接位新增一个字面量成员会自动展开并参与对账（拼接盲区在文本层被堵）。
 * · **双向相等**（范式对齐 `src/agent/__tests__/confirmEntry.test.ts`）：
 *   实际提取集 **⊆** 登记表 ⇒ 新增未登记标签转红；
 *   登记表 **⊆** 实际提取集 ⇒ 登记了但生产已删的僵尸条目转红。
 *   两侧都断言才锁得住「新增」，单向清单锁不住（这正是旧契约段的死因）。
 *
 * ## 登记表怎么来的（§5.6「禁在测试里重算判据」的遵守方式）
 *
 * `TOOL_RESULT_TAGS` 记录的是**人工语义判定**（每个标签是失败事实还是软降级），
 * 属产品知识而非可推导量，故必须显式写在此处；但**标签全集本身**由扫描器从生产
 * 代码提取并与登记表双向对账 —— 即「判据的输入来自真源，判据的分类由人给出」。
 * 凡能自动对上的部分（`kind` 联合类型 / `ToolErrorCode` 值）一律**运行时从真源读取**，
 * 不在本文件里抄第二份（抄一份 = 假绿来源，见 testing_rules §5.6）。
 *
 * ## 扫描面（7 个 producer，逐个实证确认）
 *
 * 本文件不照抄任何人的清单，7 个producer 全部经`readFileSync` 实测确认产出工具结果首标签：
 *
 * | 文件 | 首标签 | 性质 |
 * | ---- | ------ | ---- |
 * | `agent/toolExecutor.ts` | 13 个（`ERR:*` 族 + 软降级 3 个） | 内置工具返回值（唯一内置工具执行面） |
 * | `agent/toolRunner.ts` | 5 个（`ERR:TOOL:*` + `SKIP:TOOL:IDEMPOTENT`） | 执行层包装（异常 / 只读 / 权限 / 幂等 / 中断） |
 * | `agent/assembler.ts` | `ERR:REGISTER_FAILED` | `register_work` 回调返回值 |
 * | `skill/skillScriptRunner.ts` | **2 个拼接位** | 三态格式化真理源（旧守卫扫不到） |
 * | `agent/backgroundTasks.ts` | 1 个**中文**拼接标签 | 后台任务回流通知（`formatBackgroundTaskNotice`） |
 * | `agent/builtinTools.ts` | `SKIP:TOOL:IDEMPOTENT` | outbox 幂等跳过的上轮结果回填 |
 * | `agent/toolLedger.ts` | `ALREADY_READ` | `formatLedgerStub` 回显（经 `blockedOutcome` 产 tool_result） |
 *
 * ⚠️ **本文件首版曾把 `backgroundTasks.ts` 登记成「零首标签产出」，被本守卫自己的
 * 零产出断言当场推翻**（实测它产出中文标签 `[后台命令完成]`）。那条断言的价值正在于此：
 * 靠「不在扫描列表里」沉默表达边界 = 留空白；钉成断言才可检出。**教训：零产出也是要证的命题。**
 *
 * **扫描面外但产出首标签的文件**由 `OUT_OF_SCOPE_TAGS` **显式登记并钉死**
 * （`guardRail.ts` / `loop.ts` 等 —— 它们产出 system prompt 注入与护栏拒绝文案，
 * 由 `guardRail.test.ts` / `loop.test.ts` 各自的正向断言覆盖）。
 * 钉死而非沉默的意义：有人在那些文件里加新标签时本守卫会响，迫使做出「纳入还是排除」的判断，
 * 而不是让新标签悄悄逃出视野。
 *
 * ## 已知边界（诚实登记，勿默认为已覆盖）
 *
 * · **首标签判据 ≠ 全串扫描**：本守卫只认「首字符即标签」（与 SCRIPT-1 判据同口径——
 *   判据本来就只读行首）。正文中提及某标签（stdout 内容里出现 `[ERR:TOOL:X]`）
 *   不算首标签产出，故不在范围内。
 * · **表达式内正则字面量不做词法消歧**：`${x.replace(/a'/,'b')}` 这种「正则里含引号」
 *   的写法会让提取边界失配（本扫描面实测零例）。若将来引入，须升级为完整 TS 词法器。
 * · **不覆盖宿主侧**：宿主只读内核 `outcome.status` 字段，不生产工具结果文本。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatExecutionResult } from '@/skill/skillScriptRunner.js';

/** 扫描根：`src/`（本文件在 `src/__tests__/`，故回退一级） */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 扫描面：工具结果产出者（8 个，逐个经实测确认——扩充前先跑探针确认它真的产出首标签）。
 *
 * ⚠️ `agent/managers/toolCallHelpers.ts` 于 4.0.0 入列：错误码前缀的产出已从 toolRunner /
 * toolExecutor 的散落字面量**收口**到 `failedOutcomeWithCode()`（`[ERR:TOOL:${code}]` 由
 * `errorCode` 派生），该模板现由此文件产出——不入列则守卫对这一族标签失明（反向对账假绿）。
 */
const PRODUCER_FILES = [
  'agent/toolExecutor.ts',
  'agent/toolRunner.ts',
  'agent/assembler.ts',
  'skill/skillScriptRunner.ts',
  'agent/backgroundTasks.ts',
  'agent/builtinTools.ts',
  'agent/toolLedger.ts',
  'agent/managers/toolCallHelpers.ts',
] as const;

/**
 * 扫描面**外**但产出首标签的文件 → 其首标签全集（显式登记 + 钉死）。
 *
 * 这些文件产出的是 system prompt 注入 / 护栏拒绝文案 / 调试回放 / 日志级别前缀，
 * 结构上不是工具结果首标签，由各自的正向断言覆盖。**显式登记而非沉默**的意义：
 * 有人在这里加新标签时本守卫会响，迫使其做出「纳入扫描面还是明确排除」的判断。
 *
 * ⚠️ 本表是**双向**的：`OUT_OF_SCOPE_TAGS` 的键集必须与「实际在扫描面外产出首标签的
 * 文件集」相等 —— 新文件漏登记即红（`扫描面完整性` 用例）。
 */
const OUT_OF_SCOPE_TAGS: Readonly<Record<string, readonly string[]>> = {
  'agent/builtinToolHandlers.ts': ['${m.role}'],
  'agent/compaction.ts': [
    '${SOFT_LIMIT_SUMMARY_MARKER_ROUND} ${roundId}',
    'Previous: used ${toolName}',
  ],
  'agent/guardRail.ts': [
    'ALREADY_READ',
    'ASK_LIMIT',
    'READ_FAILED_LIMIT',
    'SEARCH_LIMIT_REACHED',
    'WRITE_LOOP_STOP',
  ],
  'agent/loop.ts': [
    '${SOFT_LIMIT_SUMMARY_MARKER_COMPRESS} · 临时压缩摘要（loop 收尾即弃，细节可能丢失）',
    'ASK_ABORTED',
    'ASK_ANSWER',
    'ASK_SUSPENDED',
    'DUPLICATE_TOOL_CALL_BLOCKED',
    'DUPLICATE_TOOL_CALL_WARNING',
    'REFLECTION_HINT',
    'SEARCH_LIMIT',
    'SELF_REVIEW',
    'TOOL_ABORTED',
  ],
  'agent/taskTableRenderer.ts': [
    "任务进度: ${doneCount}/${total} 已完成${activePlanItem ? `，当前: ${activePlanItem.description}` : ''}",
  ],
  'agent/toolResultOffload.ts': [
    '省略 ${omitted} 字符。需要完整内容请用 read_file 读取上述路径，大文件可配合 offset/limit 分段读取',
    '预览（前 ${previewChars} 字符）',
    '预览（头 ${headChars} + 尾 ${tailChars} 字符）',
  ],
  'llm/openaiCompatible.ts': ['DONE'],
  'logging/logger.ts': ['${targetLevel.toUpperCase()}', 'REDACTED'],
};

/**
 * 工具结果首标签登记表（标签 → 语义归属）。
 *
 * ⚠️ **本表是「语义归属」的 SSOT**：每个**字面量**产出的工具结果首标签都必须在此登记，
 * 并写清「为什么是失败 / 为什么不是失败」—— 后者才是登记的全部价值
 * （例：主动挡下的 ≠ 工具跑挂了；被强杀的没有退出码，贴失败码即谎报）。
 *
 * 键形态 = 标签把冒号换下划线（`ERR:TOOL:NOT_AVAILABLE` → `ERR_TOOL_NOT_AVAILABLE`），
 * 与既有测试里 `toContain('[X_Y]')` 的书写形态同形。
 *
 * **拼接位产出的标签不在此表**（`${labels.kind}_ERROR` 这种字面量登记没有意义），
 * 它们的展开成员由 `expandTemplateTags()` 从真源推导 —— 抄第二份即假绿来源（§5.6）。
 */
const TOOL_RESULT_TAGS: Readonly<Record<string, string>> = {
  // ── 失败族：工具真的没跑成/ 跑挂了（LLM 须据此自纠参数或换路径）──
  ERR_INVALID_ARG: '参数非法（任务项短id 不唯一，改用行首序号定位）',
  ERR_PLAN_ITEM_NOT_FOUND: '任务项不存在（计划表寻址失败）',
  ERR_SCRIPT_DECLINE: '代码执行未获确认（fail-closed，未执行）',
  ERR_COMMAND_DECLINE: '命令未获许可（未获执行许可：黑名单 / 用户拒绝 / 未注入确认回调）',
  ERR_PATH_DENIED: '路径越界（脚本路径超出项目根，安全护栏拦截）',
  ERR_SKILL_NOT_FOUND: '技能不存在（角色包与全局池均无此名）',
  ERR_RESOURCE_NOT_FOUND: '技能资源不存在（L3 资源读取失败）',
  ERR_SCRIPT_NOT_FOUND: '技能脚本不存在（L3 脚本读取失败）',
  ERR_TASK_NOT_FOUND: '后台任务不存在（taskId 无效或注册表不跨重启）',
  ERR_REGISTER_FAILED: '作品索引登记失败（register_work 回调返回）',
  ERR_TOOL_ABORTED: '工具执行被中断（signal abort，走 emitOutcome 显式结算）',
  ERR_TOOL_NOT_AVAILABLE: '工具能力未装配（宿主未注入 provider / 回调）',
  ERR_TOOL_PERMISSION_DENIED: '宿主 preExecutionCheck 拒绝（权限闸拦截，未执行）',
  ERR_TOOL_READONLY_DENIED: '只读模式下写入工具被拦截（安全闸，未执行）',
  ERR_TOOL_UNKNOWN: '工具执行抛非 MemoraError 异常（兜底失败串）',

  // ── 软降级 / 非失败族：语义上**不是**失败（status 恒 ok / blocked，不该触发自纠）──
  KILLED: '主动终止（被强杀无退出码，贴失败码即谎报——刻意不走三态格式化）',
  TASK_ALREADY_SETTLED: '已终态回传（控制流事实；结局事实由结果体承载，status 恒 ok）',
  BACKGROUND_STARTED: '后台启动成功（命令转后台，不在本轮判成败）',
  SKIP_TOOL_IDEMPOTENT: '幂等跳过（主动挡下，未执行；status=blocked）',
  ALREADY_READ:
    '重复读取拦截回显（主动挡下，未执行；由 guardRail/ledgerStub 产出，status=blocked）',
  后台命令完成: '后台任务自然完成通知（系统事件来源标记，非失败；body 承载结局）',
  后台命令已终止: '后台任务被终止通知（系统事件来源标记，非失败；刻意不贴退出码）',
  后台命令超时: '后台任务超时被终止通知（系统事件来源标记，非失败；结局由 body 承载）',
  后台命令运行中: '后台任务运行中通知（系统事件来源标记，非失败；穷尽表防御键，通知仅在终态发出）',
};

/** 软降级族（语义非失败）—— 精度用例点名用，与登记表语义理由互为交叉验证 */
const SOFT_DEGRADE_KEYS = [
  'KILLED',
  'TASK_ALREADY_SETTLED',
  'BACKGROUND_STARTED',
  'SKIP_TOOL_IDEMPOTENT',
  'ALREADY_READ',
] as const;

/** 字面量标签：`[XXX]` / `[ERR:TOOL:XXX]`（`XXX` 为大写蛇形，可含冒号分段） */
const LITERAL_TAG = /^\[([A-Z][A-Z0-9_]*(?::[A-Z0-9_]+)*)\]/;
/** 拼接标签：`[${…}…]`（首字符即标签、含插值；语系不限大写——中文标签也抓，见 backgroundTasks） */
const TEMPLATE_TAG = /^\[([^\]\n]*\$\{[^\]\n]*)\]/;

/** 归一化：`ERR:TOOL:NOT_AVAILABLE` → `ERR_TOOL_NOT_AVAILABLE`（登记表键形态） */
function toRegistryKey(tag: string): string {
  return tag.replace(/:/g, '_');
}

/** 从真源读取 `kind` 联合类型成员（`skillScriptRunner.ts` 的接口声明） */
function deriveKindUnion(): readonly string[] {
  const src = readFileSync(join(SRC_ROOT, 'skill/skillScriptRunner.ts'), 'utf8');
  const decl = /kind:\s*((?:'[^']+'\s*\|\s*)*'[^']+');/.exec(src);
  // 提取失败必须响亮（§5.6：正则失配时不得静默跳过）
  if (!decl) throw new Error('deriveKindUnion 提取失败：找不到 kind: 联合类型声明');
  return [...decl[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** 从真源读取 `ToolErrorCode` 常量的值（`errors.ts`） */
function deriveToolErrorCodes(): readonly string[] {
  const src = readFileSync(join(SRC_ROOT, 'utils/errors.ts'), 'utf8');
  const block = /export const ToolErrorCode = \{([\s\S]*?)\} as const;/.exec(src);
  if (!block) throw new Error('deriveToolErrorCodes 提取失败：找不到 ToolErrorCode 常量');
  return [...block[1]!.matchAll(/^\s*[A-Z_]+:\s*'([^']+)'/gm)].map((m) => m[1]!);
}

/**
 * 后台通知标签模板（`backgroundTasks.ts` 首标签位，含中文语系）。
 *
 * ⚠️ **必须复用扫描器自身的提取路径**（`extractStringLiterals` + `TEMPLATE_TAG`），
 * 不得另写一条正则去 grep 同一段文本（旧守卫的血泪史第4 条，2026-10-06）。
 *
 * 判据 `${noticeTag`：生产侧以中间变量 `noticeTag` 承载查表结果再进模板——
 * `BACKGROUND_TASK_NOTICE_TAGS[task.status]` 嵌套下标直写进模板会被 TEMPLATE_TAG
 * 在内层 `]` 处提前截断，产出残缺键。**变量名改名须同批改此判据**，失明即本函数
 * throw（响亮红，§5.6：提取失败不得静默跳过）。
 */
function deriveBackgroundNoticeTemplate(): string {
  const src = readFileSync(join(SRC_ROOT, 'agent/backgroundTasks.ts'), 'utf8');
  const tag = extractStringLiterals(src)
    .map(firstTagOf)
    .find((t) => t?.startsWith('${noticeTag'));
  if (!tag) throw new Error('deriveBackgroundNoticeTemplate 提取失败：找不到后台通知标签模板');
  return tag;
}

/**
 * 后台通知首标签全集（从 `BACKGROUND_TASK_NOTICE_TAGS` 穷尽表**真源**读出，不手抄）。
 *
 * 展开成员 = 表值字面量：定位声明块（花括号配平取整块，跳过字符串防表值含 `}` 错切），
 * 抽块内单引号字符串（键为标识符不占字面量）。旧实现从「三元分支」展开，穷尽表落地后
 * 真源迁到表——提取路径随之改读表值（§5.6：期望值不手写，从真源读）。
 */
function deriveBackgroundNoticeTags(): readonly string[] {
  const src = readFileSync(join(SRC_ROOT, 'agent/backgroundTasks.ts'), 'utf8');
  const anchor = src.indexOf('BACKGROUND_TASK_NOTICE_TAGS: Record');
  if (anchor < 0) throw new Error('BACKGROUND_TASK_NOTICE_TAGS 声明未找到——真源变形，必须红');
  const open = src.indexOf('{', anchor);
  let close = -1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "'") {
      i++;
      while (i < src.length && src[i] !== "'") i++; // 跳过字符串字面量（防表值含花括号错切）
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) throw new Error('BACKGROUND_TASK_NOTICE_TAGS 块未闭合——真源变形，必须红');
  const tags = [...src.slice(open, close + 1).matchAll(/([\u4e00-\u9fa5][^']*)/g)].map(
    (m) => m[1]!,
  );
  if (tags.length === 0)
    throw new Error('BACKGROUND_TASK_NOTICE_TAGS 表值提取为空——真源变形，必须红');
  return tags;
}

/**
 * 拼接标签模板 → 从真源展开的标签集合（§5.6：期望值不手写，从真源读）。
 *
 * 后台通知的展开成员取自 `BACKGROUND_TASK_NOTICE_TAGS` 穷尽表值（真源推导，非手抄）。
 */
function expandTemplateTags(): ReadonlyMap<string, readonly string[]> {
  const kinds = deriveKindUnion();
  const codes = deriveToolErrorCodes();
  return new Map<string, readonly string[]>([
    ['${labels.kind}_ERROR', kinds.map((k) => `${k}_ERROR`)],
    ['${labels.kind}_TIMEOUT', kinds.map((k) => `${k}_TIMEOUT`)],
    ['ERR:TOOL:${code}', codes.map((c) => `ERR:TOOL:${c}`)],
    // 后台通知查表产出：模板键从扫描器路径提取，展开成员 = 穷尽表值全集
    [deriveBackgroundNoticeTemplate(), deriveBackgroundNoticeTags()],
  ]);
}

/** 跳过一个模板插值表达式 `${…}`（处理嵌套字符串 / 模板 / 注释 / 花括号） */
function skipInterpolation(src: string, start: number): number {
  let i = start;
  let braceDepth = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i = skipStringLiteral(src, i).end;
      continue;
    }
    if (c === '{') {
      braceDepth++;
      i++;
      continue;
    }
    if (c === '}') {
      if (braceDepth === 0) return i;
      braceDepth--;
      i++;
      continue;
    }
    i++;
  }
  return i;
}

/** 跳过一个字符串 / 模板字面量（递归处理 `${…}` 内嵌），返回结束下标（含右引号） */
function skipStringLiteral(src: string, start: number): { end: number } {
  const quote = src[start]!;
  let i = start + 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && c === '$' && src[i + 1] === '{') {
      i = skipInterpolation(src, i + 2) + 1;
      continue;
    }
    if (c === quote) return { end: i + 1 };
    i++;
  }
  return { end: i };
}

/**
 * 引号 / 注释感知的字符串字面量提取（递归版，处理 `${…}` 内嵌字符串）。
 *
 * 为什么不用「逐行正则」：模板串与调用参数里都有 `[`，逐行扫会把
 * `formatExecutionResult` 的调用**参数**误当产出（实测 `toolRunner.test.ts` 的
 * 变异样本 `` return (`[COMMAND_ERROR] …`); `` 就是这种形态）。
 *
 * 为什么必须递归：`${cond ? `[A]` : `"}"`}` 这种**嵌套模板**里，内层的 `}`
 * 会让朴素深度计数提前闭合模板串 → 其后的真实内容被当成新字面量。
 * 该缺陷由本文件「扫描器自证」describe 的嵌套用例实测抓到（首版即失败）。
 *
 * 注释必须先剥（§5.3）：旧注释里的反面样本（`// 原写法把 [TASK_ALREADY_SETTLED] 放行首…`）
 * 不算生产产出。引号内的 `//` 不剥（本扫描面无 URL 形态标签，实测零假阳性）。
 */
export function extractStringLiterals(src: string): readonly string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const { end } = skipStringLiteral(src, i);
      out.push(src.slice(i + 1, end - 1));
      i = end;
      continue;
    }
    i++;
  }
  return out;
}

/** 取一个字面量里的首标签（字面量或拼接），取不到返回 undefined */
function firstTagOf(literal: string): string | undefined {
  return LITERAL_TAG.exec(literal)?.[1] ?? TEMPLATE_TAG.exec(literal)?.[1];
}

/**
 * 扫出某文件组真实产出的工具结果首标签 → 标签 → 产出文件列表（供报错定位）。
 *
 * 判据：**首字符即标签** —— 与 SCRIPT-1 判据同口径（判据本来就只读行首）。
 * 正文中提及某标签（stdout 内容里出现）不算产出。
 */
function scanProducedTags(files: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const rel of files) {
    const src = readFileSync(join(SRC_ROOT, rel), 'utf8');
    for (const lit of extractStringLiterals(src)) {
      const tag = firstTagOf(lit);
      if (!tag) continue;
      const hits = found.get(tag) ?? [];
      hits.push(rel);
      found.set(tag, hits);
    }
  }
  return found;
}

/** 递归列出 `src/` 下所有非测试 `.ts` 文件（相对 `SRC_ROOT`，正斜杠分隔） */
function listSourceFiles(dir = SRC_ROOT, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (entry === '__tests__') continue;
      listSourceFiles(abs, acc);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      acc.push(
        abs
          .slice(SRC_ROOT.length + 1)
          .split(sep)
          .join('/'),
      );
    }
  }
  return acc;
}

describe('工具结果首标签 · 反向对账守卫（SCRIPT-2 B5-e 补丁）', () => {
  const templateTags = expandTemplateTags();
  const produced = scanProducedTags(PRODUCER_FILES);

  /** 归一化后的登记键全集（字面量登记 + 拼接展开） */
  const registryKeys = (): Set<string> => {
    const keys = new Set(Object.keys(TOOL_RESULT_TAGS));
    for (const tags of templateTags.values()) for (const t of tags) keys.add(toRegistryKey(t));
    return keys;
  };

  /** 归一化后的实际产出键全集（字面量产出 + 拼接展开） */
  const producedKeys = (): Set<string> => {
    const keys = new Set<string>();
    for (const tag of produced.keys()) {
      const expanded = templateTags.get(tag);
      if (!expanded) {
        // 未登记展开规则的拼接模板不该走到这里（另有专门用例挡），保守按字面归一化
        keys.add(toRegistryKey(tag));
        continue;
      }
      for (const t of expanded) keys.add(toRegistryKey(t));
    }
    return keys;
  };

  it('真源提取成功且非空（提取失败必须响亮红，§5.6：正则失配不得静默跳过）', () => {
    const kinds = deriveKindUnion();
    const codes = deriveToolErrorCodes();
    expect(kinds.length, 'kind 联合类型提取为空——判据输入失配，必须红').toBeGreaterThan(0);
    expect(codes.length, 'ToolErrorCode 提取为空——判据输入失配，必须红').toBeGreaterThan(0);
    // 三态族必须恰好覆盖 SCRIPT / CODE / COMMAND 三条执行链路，缺一即真源变形
    expect([...kinds].sort()).toEqual(['CODE', 'COMMAND', 'SCRIPT']);
    const bgTags = deriveBackgroundNoticeTags();
    expect(bgTags.length, '后台通知表值提取为空——判据输入失配，必须红').toBeGreaterThan(0);
  });

  it('扫描面非空（扫描器没坏，否则反向对账恒真通过 = 假绿）', () => {
    // 防「扫不出任何东西 ⇒ 未登记集合恒空 ⇒ 守卫假绿」：扫描器哑火是最危险的失效模式。
    expect(produced.size).toBeGreaterThan(0);
    // 分子分母都钉死：拼接位必须被抓到（它哑火 ⇒ skillScriptRunner 的三态标签全部逃逸，
    // 正是旧守卫被证伪的那个缺口）。此处用「每个登记模板都真的被扫到」双向钉死 ——
    // 新增拼接模板时本条会提醒同步（真正的漏登记由下一条对账用例抓）。
    const expectedTemplates = [...templateTags.keys()].sort();
    const patterns = [...produced.keys()].filter((t) => templateTags.has(t)).sort();
    expect(
      patterns,
      '拼接位必须被抓到（`skillScriptRunner.ts` 的 `[${labels.kind}_…]`、`toolRunner.ts` 的 `[ERR:TOOL:${code}]`、`backgroundTasks.ts` 的中文通知标签）。为空 ⇒ 拼接盲区复发',
    ).toEqual(expectedTemplates);
  });

  it('扫描面完整性：产出首标签的文件要么在扫描面内，要么已显式登记（漏登记即红）', () => {
    // 这是「覆盖面倒退」的根治点：任何人新增一个产出首标签的文件，都必须在此二选一，
    // 不允许沉默地落在两张名单之外。旧守卫的 4 文件名单就是靠沉默维持的，
    // B4/B5 删守卫时名单直接掉到 3 个而无人察觉。
    const inScope = new Set<string>(PRODUCER_FILES);
    const actual = listSourceFiles()
      .filter((rel) => scanProducedTags([rel]).size > 0)
      .sort();
    const unregistered = actual.filter((rel) => !inScope.has(rel) && !(rel in OUT_OF_SCOPE_TAGS));
    expect(
      unregistered,
      `以下文件产出工具结果首标签，但既不在 PRODUCER_FILES 也没登记进 OUT_OF_SCOPE_TAGS：\n  ${unregistered.join('\n  ')}` +
        `\n修法：① 确认它产出工具结果 → 移进 PRODUCER_FILES 并在 TOOL_RESULT_TAGS 登记语义归属` +
        `\n     ② 确认它是 system prompt 注入 / 内部标记 → 登记进 OUT_OF_SCOPE_TAGS 并钉死其标签全集`,
    ).toEqual([]);
  });

  it('OUT_OF_SCOPE_TAGS 的标签集与实际产出双向相等（排除项也不许腐化）', () => {
    // 排除名单必须钉死：既防「新增标签悄悄进排除名单」，也防「标签删了名单没删」。
    for (const [rel, tags] of Object.entries(OUT_OF_SCOPE_TAGS)) {
      const actual = [...scanProducedTags([rel]).keys()].sort();
      expect(actual, `${rel} 的实际首标签与 OUT_OF_SCOPE_TAGS 登记不符`).toEqual([...tags].sort());
    }
    // 反向：登记了却已不存在的文件（整文件被删/改名）—— 僵尸登记
    const all = new Set(listSourceFiles());
    const zombieFiles = Object.keys(OUT_OF_SCOPE_TAGS)
      .filter((rel) => !all.has(rel) || scanProducedTags([rel]).size === 0)
      .sort();
    expect(
      zombieFiles,
      `OUT_OF_SCOPE_TAGS 登记了不再产出标签的文件：\n  ${zombieFiles.join('\n  ')}`,
    ).toEqual([]);
  });

  it('生产产出的每个首标签都已在登记表（漏登记即红 · SCRIPT-1 复发锁）', () => {
    // 反向对账的核心：产出 ∖ 登记 = ∅。
    // 实锤过这条能抓什么：把 toolExecutor.ts 某处产出改写成全新 `[NETWORK_ERROR]`
    // 而不登记 ⇒ 本条转红（旧契约段对同一变异 62 passed 全绿）。
    const registry = registryKeys();
    const unregistered = [...producedKeys()].filter((k) => !registry.has(k)).sort();
    expect(
      unregistered,
      `以下工具结果首标签在生产代码中产出、但未在 TOOL_RESULT_TAGS 登记语义归属：\n` +
        unregistered.map((k) => `  [${k}]`).join('\n') +
        `\n修法：在 TOOL_RESULT_TAGS 登记并写清「为什么是失败 / 为什么不是失败」。` +
        `若它是拼接位产出的，请补 expandTemplateTags() 的展开规则（别去改展开源）`,
    ).toEqual([]);
  });

  it('登记表的每个标签都在生产中产出（防登记条目腐化成僵尸契约）', () => {
    // 正向对账：登记 ≠ 产出 ⇒ 条目已失效（标签被删/改名），留着是误导。
    // 缺这条，则「删掉生产标签」无人报警，登记表会静默膨胀成僵尸承诺。
    const keys = producedKeys();
    const zombie = [...registryKeys()].filter((k) => !keys.has(k)).sort();
    expect(
      zombie,
      `以下标签已登记但生产代码不再产出（标签被删或改名？）——请同步删除登记：\n  ${zombie.map((z) => `[${z}]`).join('\n  ')}`,
    ).toEqual([]);
  });

  it('登记表的每条语义归属非空（禁「只写非失败」的空壳登记）', () => {
    // §5.1 精神：登记即断言，且必须写清「为何不是同类」。空理由 = 没判定。
    const empty = Object.entries(TOOL_RESULT_TAGS)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([k]) => k);
    expect(empty, `以下登记条目没有写语义归属理由：\n  ${empty.join('\n  ')}`).toEqual([]);
  });

  it('精度：软降级标签已登记，且失败/软降两族由status 事实裁定（不靠关键词猜）', () => {
    // 这些标签语义上**不是**失败：主动终止 / 已终态回传 / 后台启动 / 幂等跳过 / 重复读拦截。
    // 它们的 status 恒为 ok 或 blocked（SCRIPT-2 结构化结算）；若被当成失败，
    // 正常降级路径会炸红（LLM 被误导去「修」一个没坏的工具）。
    for (const k of SOFT_DEGRADE_KEYS) {
      expect(TOOL_RESULT_TAGS[k], `软降级标签 ${k} 必须已登记`).toBeDefined();
    }
    // ⚠️ **不要用「理由文本含不含『失败』」来分类**（首版就是这么写的，实测被证伪）：
    // 判据一旦落在**自由文本**上，就成了可被措辞绕过的假闸门 ——
    // 变异验证里把失败族 `ERR_TASK_NOT_FOUND` 的理由改写成「已终态回传（…失败族被写成
    // 软降级语义）」，文本里仍含『失败』二字，**该用例全绿放行**（16 passed）。
    // 教训与本文件同源：**判据必须落在结构上，不能落在措辞上**。
    //
    // 改为结构化判据：`SOFT_DEGRADE_KEYS` 是**显式穷举的软降级名单**，
    // 两族互斥且并集恰为登记表全体 —— 「把某个标签偷偷改成软降级」会在下面
    // 「两族互斥且完备」这条响，措辞怎么改都躲不掉。
    const registryAll = Object.keys(TOOL_RESULT_TAGS).sort();
    const soft = [...SOFT_DEGRADE_KEYS].sort();
    const overlap = soft.filter((k) => registryAll.includes(k) === false);
    expect(overlap, `软降级名单里的标签未登记：\n  ${overlap.join('\n  ')}`).toEqual([]);

    // 两族互斥：软降级名单里不得混入任何 `ERR:` / `*_ERROR` / `*_TIMEOUT` 形态标签
    // （那些形态在结构上就是失败族，登记为软降级必是错配）。
    const FAILURE_SHAPE = /^(?:ERR[A-Z_]*|[A-Z]+_(?:ERROR|TIMEOUT))$/;
    const shapeViolation = soft.filter((k) => FAILURE_SHAPE.test(k));
    expect(
      shapeViolation,
      `以下标签形态上属失败族（ERR:* / *_ERROR / *_TIMEOUT），却被列入软降级名单：\n  ${shapeViolation.join('\n  ')}` +
        `\n修法：从 SOFT_DEGRADE_KEYS 移除（软降级标签不应长成失败形态）`,
    ).toEqual([]);
  });

  it('精度：失败族与软降级族互斥且并集完备（措辞改不动归属，§5.5变异实测）', () => {
    // 本条是上条的**闭环**：软降级名单由本用例与登记表对账，
    // 因此「把失败标签悄悄移进软降级名单以逃避失败语义」这条路被堵死。
    const registryAll = Object.keys(TOOL_RESULT_TAGS);
    const soft = SOFT_DEGRADE_KEYS as readonly string[];
    const notClassified = registryAll.filter((k) => !soft.includes(k));
    // 未进软降级名单 ⇒ 一律按失败族对待（保守方向：宁可多算失败，不可漏算）
    expect(
      notClassified.length + soft.length,
      '软降级名单与登记表必须有交集且并集等于登记表全体（防名单被改成空壳而无人察觉）',
    ).toBe(registryAll.length);
    // 名单非空：空名单会让上面那条恒真通过
    expect(
      soft.length,
      '软降级名单不得为空（空名单 = 全体按失败处理 = 正常降级路径全炸）',
    ).toBeGreaterThan(0);
  });
});

describe('拼接位行为闸：formatExecutionResult 真实产出（不靠文本扫描）', () => {
  // 上文的对账是**文本层**的。本 describe 是**行为层**的：直接调用三态格式化真理源，
  // 看它真的吐出什么首标签。
  //
  // 为什么两层都要：文本层的拼接归一化依赖「模板变量 → 真源成员」的推导链；
  // 行为层则完全不依赖任何推导 —— `formatExecutionResult` 返回什么，第一个字符是什么，
  // 就是什么。推导链若哪天失配（改了kind 声明写法 / 加了新标签形态），行为层会先响。
  const kinds = [
    { kind: 'SCRIPT', timeoutDetail: '脚本超时', errorDetail: '脚本失败' },
    { kind: 'CODE', timeoutDetail: '代码超时', errorDetail: '代码失败' },
    { kind: 'COMMAND', timeoutDetail: '命令超时', errorDetail: '命令失败' },
  ] as const;

  const registry = (): Set<string> => {
    const keys = new Set(Object.keys(TOOL_RESULT_TAGS));
    for (const tags of expandTemplateTags().values())
      for (const t of tags) keys.add(toRegistryKey(t));
    return keys;
  };

  it('超时态 ⇒ 首标签为 `[<kind>_TIMEOUT]`，且在登记集合内', () => {
    for (const k of kinds) {
      const out = formatExecutionResult(
        { stdout: '', stderr: '', exitCode: 0, timedOut: true },
        { ...k },
      );
      const tag = LITERAL_TAG.exec(out)?.[1];
      expect(tag, `超时产出未以状态标签开头：${out.slice(0, 60)}`).toBe(`${k.kind}_TIMEOUT`);
      expect(registry(), `${tag} 应在登记集合内`).toContain(toRegistryKey(tag!));
    }
  });

  it('非零退出 ⇒ 首标签为 `[<kind>_ERROR]`，且在登记集合内', () => {
    for (const k of kinds) {
      const out = formatExecutionResult(
        { stdout: '', stderr: '', exitCode: 1, timedOut: false },
        { ...k },
      );
      const tag = LITERAL_TAG.exec(out)?.[1];
      expect(tag, `失败产出未以状态标签开头：${out.slice(0, 60)}`).toBe(`${k.kind}_ERROR`);
      expect(registry(), `${tag} 应在登记集合内`).toContain(toRegistryKey(tag!));
    }
  });

  it('成功态 ⇒ 首标签**不是**任何状态标签（成功不贴失败码，防 LLM 误判）', () => {
    // 精度闸的反面：成功路径若也贴 `[X_ERROR]`，LLM 会以为命令挂了（谎报）。
    for (const k of kinds) {
      const out = formatExecutionResult(
        { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false },
        { ...k },
      );
      expect(LITERAL_TAG.test(out), `成功态不该以状态标签开头：${out.slice(0, 60)}`).toBe(false);
    }
  });
});

describe('扫描器自证（§5.4：先验证测量工具本身，再信它的结论）', () => {
  it('字面量提取：三种引号都抓，且不抓注释里的标签', () => {
    const src = [
      `const a = '[LITERAL_ONE]';`,
      `const b = "[LITERAL_TWO]";`,
      'const c = `[LITERAL_THREE] ${x}`;',
      `// const d = '[COMMENTED_OUT]';`,
      `/* const e = '[BLOCK_COMMENTED]'; */`,
      `const f = 'plain text';`,
    ].join('\n');
    const tags = extractStringLiterals(src)
      .map((l) => firstTagOf(l))
      .filter((x): x is string => x !== undefined);
    expect(tags).toEqual(['LITERAL_ONE', 'LITERAL_TWO', 'LITERAL_THREE']);
    // 注释里的两个标签必须一个都抓不到（§5.3：剥注释是硬要求）
    expect(tags).not.toContain('COMMENTED_OUT');
    expect(tags).not.toContain('BLOCK_COMMENTED');
  });

  it('字面量提取：模板串内嵌模板 + 引号 + 花括号不破坏边界（首版缺陷回归锁）', () => {
    // 朴素深度计数会让内层的 `}` 提前闭合模板串 ⇒尾部内容被误当新字面量。
    // 本用例在首版即失败（返回 2 段而非 1 段），是「先验证测量工具」纪律的实证。
    const src = 'const x = `[A_TAG] ${cond ? `[NESTED]` : `"}"`} tail ${y}`;';
    const lits = extractStringLiterals(src);
    expect(lits, '嵌套模板导致字面量边界破裂').toHaveLength(1);
    expect(LITERAL_TAG.exec(lits[0]!)![1]).toBe('A_TAG');
  });

  it('字面量提取：转义引号不提前闭合', () => {
    const src = String.raw`const s = '[A_TAG] it\'s fine'; const t = 'plain';`;
    const lits = extractStringLiterals(src);
    expect(lits).toHaveLength(2);
    expect(LITERAL_TAG.exec(lits[0]!)![1]).toBe('A_TAG');
    expect(lits[1]).toBe('plain');
  });

  it('首标签判据：不抓正文中提及的标签（与 SCRIPT-1 判据同口径，只读行首）', () => {
    const lits = extractStringLiterals(`const s = 'stdout 里提到 [ERR:TOOL:X] 但不是首标签';`);
    expect(LITERAL_TAG.test(lits[0]!)).toBe(false);
  });

  it('拼接标签判据：抓 `[${…}]` 形态（含中文语系），且不误抓普通模板串', () => {
    expect(TEMPLATE_TAG.test('[${labels.kind}_ERROR] 详情')).toBe(true);
    expect(TEMPLATE_TAG.test('[ERR:TOOL:${code}] 错误')).toBe(true);
    // 中文标签语系（backgroundTasks 的后台通知）也必须被抓到
    expect(TEMPLATE_TAG.test("[后台命令${s === 'k' ? '已终止' : '完成'}] taskId=x")).toBe(true);
    expect(TEMPLATE_TAG.test('普通文本 ${x} 无标签')).toBe(false);
    // 首字符即标签是前提：正文中间的插值不算
    expect(TEMPLATE_TAG.test('前缀 [${x}] 后缀')).toBe(false);
  });
});

describe('failedOutcome 调用点台账对账（裸失败构造点登记）', () => {
  /**
   * 台账：允许调用**裸** `failedOutcome()`（无 errorCode，重试分类只能走文本兜底）的
   * 文件 → 预期调用次数。定义处 `toolCallHelpers.ts` 不在册（它不是调用点）。
   *
   * 裸失败点必须自答「为什么这个失败给不出 errorCode」——toolRunner 的两处是 ABORTED
   * （中断事实故意不入错误码体系，见 `failedOutcome` JSDoc）；toolExecutor / loop 的
   * 存量点均为既定形态。新增调用点未登记即红；有码失败一律走 `failedOutcomeWithCode`。
   */
  const FAILED_OUTCOME_LEDGER: Readonly<Record<string, number>> = {
    'agent/toolExecutor.ts': 16,
    'agent/toolRunner.ts': 2,
    'agent/loop.ts': 2,
  };

  it('裸 failedOutcome 调用点逐文件计数与台账相等（新增点未登记 / 存量点漂移即红）', () => {
    const counts: Record<string, number> = {};
    // listSourceFiles 返回相对 SRC_ROOT 的正斜杠路径（本文件 :411 实现），直接作台账键
    for (const rel of listSourceFiles(SRC_ROOT)) {
      // 定义处不是调用点；测试文件已被 listSourceFiles 排除（__tests__ 不扫描）
      if (rel === 'agent/managers/toolCallHelpers.ts') continue;
      const src = readFileSync(join(SRC_ROOT, rel), 'utf8');
      const n = [...src.matchAll(/(?<![\w$])failedOutcome\(/g)].length;
      if (n > 0) counts[rel] = n;
    }
    expect(
      counts,
      'failedOutcome 调用点漂移——新增裸失败点须登记 FAILED_OUTCOME_LEDGER 并自答' +
        '「为何给不出 errorCode」（有码失败一律走 failedOutcomeWithCode）',
    ).toEqual(FAILED_OUTCOME_LEDGER);
  });
});
