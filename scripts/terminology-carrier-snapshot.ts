/**
 * 术语载体 · 同族扫描快照（drift gate · 离线可复现）
 *
 * 定位：
 *   `terminology-anchor-rules.md` 定义了 `step` 的词义（loop 内一次迭代）与任务表阵营
 *   （`PlanItem` / `planItem`）的分离纪律。但同一个词根会落在多种载体上——
 *   标识符 / 事件名 / CSS 类 / DOM 属性 / UI 文案 / 错误码 / 注释 / 文档正文 / 文件名。
 *   历史三次「同族半补丁」的共同根因都是**载体清单不完整**：
 *     ① `.prettierignore` 只挡一半；② 函数名改了、它产出的事件名没改；③ CHANGELOG 过度声明。
 *   本脚本把载体清单机械化：扫全仓 → 抽词根载体 → 锁集合。清单不再靠记性。
 *
 * 关键设计（四项，皆为「为什么这么做」）：
 *   1. **脚本是锚点的执行器，不是第二份例外清单**：`frozen` 集由
 *      `.trae/rules/terminology-anchor-rules.md` §3 表格**解析**得到，不硬编码在本文件。
 *      锚点改了扫描跟着改；解析失败**报错退出**（防「静默返回空集 → 门禁永远绿」）。
 *   2. **只锁「集合」，不锁「次数 / 文件列表」**：次数会因任何一次注释改动而漂移，
 *      锁次数 = 门禁天天红 = 必然被绕过。锁集合只对「新词出现」「旧词消失」报警。
 *   3. **不判断语义对错**：机械判定「这个词用的是不是任务表语义」做不到。本脚本的产出是
 *      **漂移可见性**——新增 / 消失必须被显式确认（更新 BASELINE，git diff 即审计痕迹）。
 *   4. **分层基线（code / text 各锁一份集合，不共用）**：文档 / 台账 / CHANGELOG / ADR 按
 *      「历史不改写」纪律**永久保留旧词**（`step_id` / `PlanStep` / `perStep`…）。若与代码共锁
 *      一份集合，旧词被历史层「续命」，于是 ①「旧词消失」对已正名词永不报警 ②旧词**复活进代码**
 *      也不报警（集合没变）——与「脚本扫自身」是**同一失效模式的另一个载体**（`SELF_REL` 的教训，
 *      历史层是第二个续命源）。故 code 层（`src` / `hosts` / `scripts` = 现行契约）单独锁集合：
 *      旧词从 code 消失 = 正名完成信号；旧词出现在 code = 回归报警（门禁的牙在此）。
 *
 * 扫描的词根族：
 *   - `step`（正名族，术语锚点 §1）
 *   - `iteration` / `迭代` / `内循环`（§6 历史别名族：只可用于阅读理解，**禁用于命名新代码**）
 *
 * 载体形态：
 *   ASCII 标识符（驼峰 / 下划线，覆盖函数名、变量名、事件名、类型名）
 *   kebab 名（CSS 类、`data-*` 属性、文件名、目录名）
 *   中文词（`步骤` / `步级`；`第 N 步` 归一化为 `第N步`——N 是数字，不构成新载体）
 *
 * 范围边界与已知盲区（**不是**例外清单——不含逐词豁免）：
 *   - 录制 fixture 目录（`__tests__/fixtures/`）：内含当时的**真实输出**，改了即伪造证据。
 *   - 本脚本自身（`scripts/terminology-carrier-snapshot.ts`）：`BASELINE` 字面量会给自己续命，
 *     导致「旧词消失」检测结构性失效（只报新增不报消失）。
 *   - 依赖 / 版本库 / 构建产物 / 覆盖率 / 工具内部状态：node_modules · .git · dist · coverage · .workbuddy · .memora
 *   - 🔴 **bare「步」词根不收**（2026-09-25 拍板接受的取舍，勿当漏洞重复报告）：「某步 / 该步 /
 *     逐步 / 多步」这类裸「步」**不在词根表内**——纳入会把「同步 / 进步 / 地步」等通用词全部卷进来，
 *     噪声即刻淹没门禁。代价：此类误用只能靠人眼（每轮审查顺手勘），门禁天然不管。
 *   - 🔴 **text 层是弱判据**：text（文档 / 台账 / CHANGELOG / ADR）按纪律保留旧词 → 旧词**复活进
 *     文档**不会报警（历史层续命仍在 text 层内）。强判据只在 code 层，文档层回归靠审查。
 *
 * 用法：
 *   npx tsx scripts/terminology-carrier-snapshot.ts           # 打印分类报表
 *   npx tsx scripts/terminology-carrier-snapshot.ts --json    # 输出 JSON（供工具消费）
 *   npx tsx scripts/terminology-carrier-snapshot.ts --check   # 与分层 BASELINE 比集合，漂移则 exit 1
 *
 * 验收：--check 下两层集合各自一致 → exit 0；有新增 / 消失 → 按层打印两边清单 + 可直接粘贴的 BASELINE，exit 1。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── 路径与扫描范围 ───────────────────────────────

/** 仓库根（本文件位于 scripts/ 下，故向上一级） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 术语锚点：冻结例外（§3）的唯一真理源，本脚本只解析、不复制 */
const ANCHOR_PATH = join(ROOT, '.trae', 'rules', 'terminology-anchor-rules.md');

/**
 * 本脚本自身的相对路径（正斜杠）。
 * 为什么必须排除自己：`BASELINE` 里的字面量本身就是「step 族 token」，
 * 若扫描自己 → 基线里的旧词永远被自己续命 → **「旧词消失」这条检测结构性失效**（只报新增不报消失）。
 * 本文件是门禁工具（元数据），不属于被纪律的载体对象。
 */
const SELF_REL = relative(ROOT, fileURLToPath(import.meta.url))
  .split('\\')
  .join('/');

/** 不进入扫描的目录名（依赖 / 版本库 / 构建产物 / 覆盖率 / 工具内部状态 / 宿主持久化） */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.workbuddy', '.memora']);

// ─── 扫描分层（code = 现行契约强判据 / text = 文档台账弱判据） ──────────────

/** 载体所属层：code = 现行代码契约；text = 文档 / 台账 / 历史档（含保留旧词） */
type Layer = 'code' | 'text';

/**
 * code 层路径前缀（正斜杠相对路径）：`src` / `hosts` / `scripts` 是**现行代码契约**——
 * 正名后的旧词不允许回到这里，故对其单独锁集合（回归即报警，见「关键设计 4」）。
 * 其余一切（docs / .trae / tasks / CHANGELOG / role-packs / prompts / 根配置 / .github）归 text 层。
 */
const CODE_PREFIXES: readonly string[] = ['src/', 'hosts/', 'scripts/'];

/** 全部层（遍历顺序固定，保证输出跨机可复现） */
const LAYERS: readonly Layer[] = ['code', 'text'];

/** 相对路径归层（前缀匹配；调用方须已把路径归一为正斜杠） */
function layerOf(relPath: string): Layer {
  return CODE_PREFIXES.some((p) => relPath.startsWith(p)) ? 'code' : 'text';
}

/** 参与扫描的文本后缀：术语载体可能出现在代码、文档、样式、配置四类文件中 */
const SCAN_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.css',
  '.html',
  '.vue',
  '.yml',
  '.yaml',
]);

// ─── 词根与载体抽取规则 ───────────────────────────

/** 命中即视为「本族载体」的词根（大小写不敏感） */
const ROOT_PATTERNS: readonly RegExp[] = [/step/i, /iteration/i, /迭代/, /内循环/];

/** 历史别名专用词根（仅用于报表分组；与 step 不重叠） */
const ALIAS_PATTERNS: readonly RegExp[] = [/iteration/i, /迭代/, /内循环/];

/** ASCII 标识符：驼峰 / 下划线 / $ —— 覆盖函数名、变量名、事件名、类型名 */
const ASCII_TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** kebab 名：CSS 类 / `data-*` 属性 / 文件名 / 目录名（如 `data-step-bucket`、`step-atomic-persistence`） */
const KEBAB_TOKEN_RE = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g;

/** 中文直配载体（「迭代」「内循环」同属历史别名族） */
const CJK_LITERALS: readonly string[] = ['步骤', '步级', '迭代', '内循环'];

/** 「第 N 步」的形态（N 为任意数字，归一化后不产生新载体） */
const CJK_ORDINAL_RE = /第\s*\d+\s*步/g;

/** 「第 N 步」的归一化 token */
const CJK_ORDINAL_TOKEN = '第N步';

/** 冻结例外解析阈值：§3 现有 6 个 step 词根例外，解析数骤降 = 小节格式被改坏，宁可报错也不放行 */
const MIN_FROZEN = 6;

/** 每个载体最多留几个命中文件样本（够定位即可，避免报表被单文件刷屏） */
const SAMPLE_FILE_LIMIT = 5;

// ─── 数据结构 ──────────────────────────────────

/** 载体形态 */
type CarrierKind = 'ascii' | 'kebab' | 'cjk';

/** 一个载体的扫描记录 */
interface Carrier {
  /** 载体词本身 */
  token: string;
  /** 载体形态 */
  kind: CarrierKind;
  /** 出现总次数（仅报表展示，不参与 --check 比对） */
  count: number;
  /** 各层命中次数（分层基线的事实来源：某层 > 0 即该层集合成员） */
  layerCount: Record<Layer, number>;
  /** 命中文件样本（相对仓库根，正斜杠），最多 SAMPLE_FILE_LIMIT 个 */
  sampleFiles: string[];
}

/** 一次完整扫描的结果 */
interface Snapshot {
  /** 冻结例外（自锚点 §3 解析） */
  frozen: string[];
  /** 扫描到的全部载体，按 token 码位排序（保证跨机可复现） */
  carriers: Carrier[];
}

/** 扫描累加器：token → 记录 */
const sink = new Map<string, Carrier>();

// ─── 词根判定 ──────────────────────────────────

/** 该 token 是否命中任一词根族 */
function matchesRoot(token: string): boolean {
  return ROOT_PATTERNS.some((re) => re.test(token));
}

/** 该 token 是否属于历史别名族（iteration / 迭代 / 内循环） */
function isAliasToken(token: string): boolean {
  return ALIAS_PATTERNS.some((re) => re.test(token));
}

/** 统计子串出现次数（中文词不参与正则分词，直接计数） */
function countOccurrences(text: string, needle: string): number {
  let n = 0;
  let at = text.indexOf(needle);
  while (at >= 0) {
    n += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return n;
}

/** 按码位排序（localeCompare 依赖 ICU，跨机可能不一致，故不用） */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── 扫描实现 ──────────────────────────────────

/** 登记一次命中（layer 决定它计入哪层基线，见「关键设计 4」） */
function hit(token: string, kind: CarrierKind, layer: Layer, relPath: string, times = 1): void {
  let rec = sink.get(token);
  if (!rec) {
    rec = { token, kind, count: 0, layerCount: { code: 0, text: 0 }, sampleFiles: [] };
    sink.set(token, rec);
  }
  rec.count += times;
  rec.layerCount[layer] += times;
  if (rec.sampleFiles.length < SAMPLE_FILE_LIMIT && !rec.sampleFiles.includes(relPath)) {
    rec.sampleFiles.push(relPath);
  }
}

/** 从一段文本中抽取全部词根载体（文件名 / 目录名 / 文件正文都走这里） */
function collect(text: string, relPath: string, layer: Layer): void {
  for (const m of text.matchAll(ASCII_TOKEN_RE)) {
    if (matchesRoot(m[0])) hit(m[0], 'ascii', layer, relPath);
  }
  for (const m of text.matchAll(KEBAB_TOKEN_RE)) {
    if (matchesRoot(m[0])) hit(m[0], 'kebab', layer, relPath);
  }
  for (const lit of CJK_LITERALS) {
    const n = countOccurrences(text, lit);
    if (n > 0) hit(lit, 'cjk', layer, relPath, n);
  }
  const ordinals = text.match(CJK_ORDINAL_RE);
  if (ordinals && ordinals.length > 0)
    hit(CJK_ORDINAL_TOKEN, 'cjk', layer, relPath, ordinals.length);
}

/** 递归遍历仓库，抽取载体 */
function walk(dir: string): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      // 录制 fixture = 当时的真实输出，属证据而非纪律对象（改了即伪造证据）→ 整目录排除
      if (ent.name === 'fixtures' && dir.endsWith('__tests__')) continue;
      walk(abs);
      continue;
    }
    if (!SCAN_EXTS.has(extname(ent.name))) continue;
    // 相对路径统一为正斜杠（Windows 下 path.relative 给反斜杠，会污染样本展示）
    const rel = relative(ROOT, abs).split('\\').join('/');
    if (rel === SELF_REL) continue; // 不扫自己（否则 BASELINE 字面量自续命 → 消失检测失效）
    const layer = layerOf(rel); // 归层：决定命中计入 code 还是 text 基线
    // 文件名与目录名本身也是载体（如 `step-atomic-persistence.md`），故对路径再跑一遍抽取
    collect(rel, rel, layer);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue; // 读不动（二进制 / 权限）就跳过，不因单个文件中断整轮扫描
    }
    collect(text, rel, layer);
  }
}

// ─── 锚点解析（冻结例外） ─────────────────────────

/**
 * 从锚点 §3 表格解析冻结例外标识符。
 *
 * 为什么不硬编码：例外清单是锚点的**定案**。脚本若自带一份，两处会各自漂移
 * （锚点加了例外而门禁不知道；门禁删了例外而锚点仍是真理源）。
 * 解析失败必须抛错——静默返回空集会让硬闸退化成「永远绿」。
 */
function parseFrozenFromAnchor(): string[] {
  const md = readFileSync(ANCHOR_PATH, 'utf8');
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('## 3.'));
  if (start < 0) {
    throw new Error(`锚点未找到「## 3. 」小节标题，格式可能已变：${ANCHOR_PATH}`);
  }
  const cells: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('## ')) break; // 下一小节，§3 结束
    if (!line.startsWith('|')) continue;
    // 「| 名字 | 含义 | 原因 |」→ 取第 1 格
    const firstCell = line.slice(1).split('|')[0]!;
    if (/^[\s:|-]+$/.test(firstCell)) continue; // 表头分隔行 | --- | --- |
    if (firstCell.trim() === '名字') continue; // 表头行
    cells.push(firstCell);
  }
  if (cells.length === 0) {
    throw new Error(`锚点 §3 未解析到任何表格行：${ANCHOR_PATH}`);
  }
  const ids = new Set<string>();
  for (const cell of cells) {
    // 只取反引号包裹的标识符（自然语言描述不参与，避免把散文当例外）
    for (const m of cell.matchAll(/`([^`]+)`/g)) {
      if (matchesRoot(m[1]!)) ids.add(m[1]!);
    }
  }
  if (ids.size < MIN_FROZEN) {
    throw new Error(
      `锚点 §3 仅解析到 ${ids.size} 个词根例外（期望 ≥${MIN_FROZEN}），请核对小节表格格式：${ANCHOR_PATH}`,
    );
  }
  return [...ids].sort(byCodeUnit);
}

// ─── 快照构建 ──────────────────────────────────

function buildSnapshot(): Snapshot {
  sink.clear();
  walk(ROOT);
  const carriers = [...sink.values()];
  for (const c of carriers) c.sampleFiles.sort(byCodeUnit); // 样本顺序跨机稳定
  carriers.sort((a, b) => byCodeUnit(a.token, b.token));
  return { frozen: parseFrozenFromAnchor(), carriers };
}

/** 取某层的集合形态（--check 的比对载体：只集合，不含次数与文件；分层比对见「关键设计 4」） */
function layerTokenSet(s: Snapshot, layer: Layer): string[] {
  return s.carriers.filter((c) => c.layerCount[layer] > 0).map((c) => c.token);
}

// ─── 分层基准集合（--check 按层比对）──────────────────
// 说明：本常量是「载体集合基线」，不是「目标值 / 白名单」——它不判定语义对错，
//       只记录「当下存在的全部词根载体」。任何新增 / 消失都会让 --check 变红，
//       改动者需显式确认语义（是新机制？还是新代码误用了旧词？）并在此更新，git diff 即审计痕迹。
// 分层理由见「关键设计 4」：code 层是现行契约（强判据），text 层含按纪律保留旧词的历史档（弱判据）。
// 两份数组的并集 = 全部载体（每词可同时属多层）；漂移时 --check 会打印可直接粘贴的分层清单。
const BASELINE_CODE: readonly string[] = [
  'ALL_STEPS',
  'DEFAULT_MAX_ITERATIONS',
  'DEFAULT_MAX_ITERATIONS_REACHED_MARK',
  'MAX_STEP_BUDGET',
  'MAX_TOOL_STEP_LIMIT',
  'MIN_STEP_BUDGET',
  'MULTI_STEP_PATTERNS',
  'MULTI_STEP_REASONINGS',
  'MultiStepReasoning',
  'STEP',
  'STEP_TIMEOUT_MS',
  'Step',
  '_emitStepBoundary',
  '_settleStepOutcomeObservations',
  'a1b2c3d4-step-1',
  'alignment-iteration',
  'animation-iteration-count',
  'c9d0e1f2-step-3',
  'cachedAtIteration',
  'currentIteration',
  'currentStep',
  'data-step-bucket',
  'e5f6a7b8-step-2',
  'earliest_steps',
  'emitMaxIterationsReached',
  'findEarliestSteps',
  'handleIteration',
  'handleIterationResult',
  'inAutonomousStep',
  'isInAutonomousStep',
  'iteration',
  'iterations',
  'maxIterations',
  'maxIterationsReached',
  'multiStepReasoning',
  'new-step',
  'old-step',
  'per-step',
  'posByStep',
  'resolveMultiStepReasoning',
  'resolveStepBudget',
  'resolveToolStepLimit',
  'roundStepIndex',
  'runIteration',
  'runIterationLoop',
  'runStep',
  'selectSteps',
  'step',
  'step$',
  'step-0',
  'step-1',
  'step-active-1',
  'step-atomic-persistence',
  'step-pending-2',
  'step0',
  'step1',
  'step2',
  // P1 双轨设施：step 阵营合法词（按 loop 迭代归属，非任务表语义），2026-10-06 补基线
  'stepBlockedDisagreements',
  'stepBoundary',
  'stepBucket',
  'stepBudget',
  'stepCount',
  'stepIndex',
  // P1 双轨设施：step 阵营合法词（按 loop 迭代归属，非任务表语义），2026-10-06 补基线
  'stepOutcomes',
  'step_boundary',
  'steps',
  // P1 双轨设施：step 阵营合法词（按 loop 迭代归属，非任务表语义），2026-10-06 补基线
  'stepUnreportedOutcomes',
  'toolIdsInStep',
  'toolStepLimit',
  'withStepIndex',
  '步骤',
  '第N步',
  '迭代',
];
const BASELINE_TEXT: readonly string[] = [
  'ALL_STEPS',
  'DEFAULT_MAX_ITERATIONS',
  'MAX_STEP_BUDGET',
  'MIN_STEP_BUDGET',
  'PlanStep',
  'PlanStepDto',
  'STEP',
  'STEP_DESC_MAX_CHARS',
  'STEP_LOG_CAP',
  'STEP_LOG_PER_STEP_LIMIT',
  'STEP_NOT_FOUND',
  'STEP_STATUS_LABEL',
  'Step',
  '_emitIterationBoundary',
  '_emitStepBoundary',
  '_maybeEmitStepBoundary',
  // P1 双轨设施：step 阵营合法词（按 loop 迭代归属，非任务表语义），2026-10-06 补基线
  '_settleStepOutcomeObservations',
  'a1b2c3d4-step-1',
  'animation-iteration-count',
  'appendPlanStep',
  'block__step',
  'completeStep',
  'currentIteration',
  'currentStep',
  'currentPlanSteps',
  'data-step',
  'data-step-bucket',
  'earliest_steps',
  'ensureActiveStep',
  'getActiveStepMeta',
  'handleIteration',
  'handleIterationResult',
  'insertStepInOrder',
  'iteration',
  'iterationBoundary',
  'iteration_boundary',
  'maxIterations',
  'meetingSteps',
  'multiStepReasoning',
  'nextStep',
  'per-step',
  'perStep',
  'plan-step',
  'planStepId',
  'resolveMultiStepReasoning',
  'resolveStepBudget',
  'resolveToolStepLimit',
  'roundStepIndex',
  'runIterationLoop',
  'runStepSequence',
  'step',
  'step-atomic-persistence',
  'step-boundary',
  'step-end',
  'step1',
  'step2',
  'step5',
  'stepBoundary',
  'stepBucket',
  'stepBudget',
  'stepContainerFor',
  'stepGroup',
  'stepIndex',
  'stepLogLenBefore',
  // P1 双轨设施：step 阵营合法词（按 loop 迭代归属，非任务表语义），2026-10-06 补基线
  'stepOutcomes',
  'step_boundary',
  'step_id',
  'steps',
  'term-unify-turn-step-loop',
  'toolStep',
  'toolStepLimit',
  'updatePlanStepStatus',
  'updateStep',
  'withStepIndex',
  '内循环',
  '步级',
  '步骤',
  '第N步',
  '迭代',
];

// ─── 输出 ──────────────────────────────────────

/** 打印人类可读报表（分组：冻结例外 / 历史别名族 / step 正名族） */
function printReport(s: Snapshot): void {
  const frozenSet = new Set(s.frozen);
  const frozen = s.carriers.filter((c) => frozenSet.has(c.token));
  const alias = s.carriers.filter((c) => !frozenSet.has(c.token) && isAliasToken(c.token));
  const main = s.carriers.filter((c) => !frozenSet.has(c.token) && !isAliasToken(c.token));

  console.log('\n📐 术语载体 · 同族扫描\n');
  console.log(`扫描根：${ROOT}`);
  // 分层汇总：code / text 各自的集合规模（分层基线的事实来源，见「关键设计 4」）
  const layerSizes = LAYERS.map((l) => `${l} 层 ${layerTokenSet(s, l).length}`).join(' · ');
  console.log(
    `载体总数：${s.carriers.length}（正名族 ${main.length} · 别名族 ${alias.length} · 冻结例外 ${frozen.length}）｜分层：${layerSizes}`,
  );

  const dump = (title: string, list: Carrier[]): void => {
    console.log(`\n── ${title}（${list.length}）──`);
    for (const c of list) {
      console.log(
        `  ${c.token.padEnd(34)} ${c.kind.padEnd(6)} ${String(c.count).padStart(5)} 处  (code ${c.layerCount.code} / text ${c.layerCount.text})  ${c.sampleFiles.join(', ')}`,
      );
    }
  };

  dump('step 正名族（§1：loop 内一次迭代）', main);
  dump('历史别名族（§6：仅供阅读理解，禁用于命名新代码）', alias);
  dump('冻结例外（锚点 §3 派生）', frozen);

  // 僵尸例外：登记在锚点却已在本仓消失 —— 属「过度放行」，故仅告警不失败
  const present = new Set(s.carriers.map((c) => c.token));
  const stale = s.frozen.filter((t) => !present.has(t));
  if (stale.length > 0) {
    console.log(`\n⚠️  锚点 §3 登记但全仓未命中（例外已僵尸，可考虑清理）：${stale.join(', ')}`);
  }
  console.log('');
}

/** 生成可直接粘贴进本文件的分层 BASELINE 字面量（省去手抄，杜绝抄错） */
function baselineLiteral(name: string, tokens: readonly string[]): string {
  const body = tokens.map((t) => `  '${t}',`).join('\n');
  return `const ${name}: readonly string[] = [\n${body}\n];`;
}

/** 各层基线的取数口（layer → 基线集合；与 layerTokenSet 合成逐层比对的两端） */
const BASELINE_BY_LAYER: Record<Layer, readonly string[]> = {
  code: BASELINE_CODE,
  text: BASELINE_TEXT,
};

function main(): void {
  const argv = process.argv.slice(2);
  const snapshot = buildSnapshot();

  if (argv.includes('--json')) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  // --check 是门禁模式：逐层比集合（分层基线见「关键设计 4」），只输出裁决与漂移清单
  if (!argv.includes('--check')) {
    printReport(snapshot);
    return;
  }

  let drifted = false; // 任一层漂移即整体失败
  const literals: string[] = []; // 漂移时收集各层可粘贴基线
  for (const layer of LAYERS) {
    const current = layerTokenSet(snapshot, layer);
    const currentSet = new Set(current);
    const baseline = BASELINE_BY_LAYER[layer];
    const baselineSet = new Set(baseline);
    const added = current.filter((t) => !baselineSet.has(t));
    const removed = baseline.filter((t) => !currentSet.has(t));

    if (added.length === 0 && removed.length === 0) {
      console.log(`✅ ${layer} 层集合无漂移（${current.length} 个载体）`);
      continue;
    }

    drifted = true;
    console.log(`\n❌ ${layer} 层漂移：新增 ${added.length} / 消失 ${removed.length}`);
    if (added.length > 0) {
      console.log(
        layer === 'code'
          ? '【新增·code】先判断：新机制引入的新词，还是**旧词复活**/新代码误用 step 表示任务表语义（§4.1）？'
          : '【新增·text】多为文档新提及旧词；确认是「引用历史」还是「误用」再更新基线',
      );
      for (const t of added) console.log(`  + ${t}`);
    }
    if (removed.length > 0) {
      console.log(
        layer === 'code'
          ? '【消失·code】确认正名是否彻底：旧载体没清干净，还是本次确实移除？'
          : '【消失·text】历史档按纪律不改写，消失通常意味着文档被重写——确认非误删历史记录',
      );
      for (const t of removed) console.log(`  - ${t}`);
    }
    literals.push(baselineLiteral(layer === 'code' ? 'BASELINE_CODE' : 'BASELINE_TEXT', current));
  }

  if (!drifted) {
    console.log(`\n✅ 术语载体集合无漂移（冻结例外 ${snapshot.frozen.length} 个）\n`);
    return;
  }

  console.log('\n确认语义无误后，把本文件的分层 BASELINE 更新为：\n');
  console.log(literals.join('\n\n'));
  console.log('');
  process.exit(1);
}

main();
