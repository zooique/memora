/**
 * 短语类穷尽扫描器（scan-phrase-class）——「无 head 全量枚举 + 逐条分类」断根工具
 *
 * 为什么存在（血训 · 2026-10-18，同一会话内二次复发）：
 *   审计「回收站被自动清理」这类**短语级谎报**时，我用来验证「扫全」的手段是**带 `head_limit`
 *   截断**的临时 grep —— 命中被切掉即漏判，于是「已扫全 / 已清零」的结论两度被证伪（累计漏 5 处
 *   + 收紧 4 处）。根因不是「不够仔细」，而是**验证手段本身会静默截断**：看到一个 grep 结果就当作全集。
 *   本脚本把这个动作机械化：**先无截断全量枚举（并硬断言打印数 == 命中总数），再逐条分类放行** ——
 *   使「扫全」从口头自证变成可复跑、可对账的产物（缺口可观测，见台账 MEM-PURGE-1 复查补订）。
 *
 * 两段式（**不可合并**）：
 *   ① 枚举：对每个注册类，用触发词正则**无一截断**地列出全部 `file:line: 文本` + 总数。
 *   ② 分类：每条命中必须被某条 `allow` 规则归类（**带 reason**）；未归类者列入 UNCLASSIFIED。
 *   为什么不能靠正则一步判「是不是假话」：同一批触发词既命中假话（「30 天后物理清理」），也命中
 *   **否定式真源**（「回收站**不**自动清理」）与**他子系统同名动作**（「定时器兜底自动清理」）——
 *   语义相反却共用触发词，rg 又是 Rust regex（**无 lookbehind**，不能 `(?<!不)`）⇒ 自动区分做不到，
 *   必须「广枚举 + 逐条分类」两段式，分类是数据/人工步骤（与 check-rule-refs 同型的「不判断语义对错」纪律）。
 *
 * 三种模式：
 *   npx tsx scripts/scan-phrase-class.ts              # 默认：全部注册类，无截断枚举 + 逐条分类标记
 *   npx tsx scripts/scan-phrase-class.ts --class <id> # 只扫一个类（id 见 --list）
 *   npx tsx scripts/scan-phrase-class.ts --check      # 门禁：任一类存在 UNCLASSIFIED 命中即 exit 1
 *   npx tsx scripts/scan-phrase-class.ts --list       # 列出注册类、触发词与放行规则数
 *
 * 闸门自检（每次运行都跑，不可关闭）：对每个类的内置样例跑**同一套判据**
 *   （scanLine / classifyHit，与主扫描同源，非另写一套），未全过即 exit 2 ——
 *   防「触发词正则改坏 → 0 命中 → 门禁假绿」与「放行规则写太宽 → 无差别放行」两种反向失效。
 *
 * 设计纪律：纯 FS、零三方依赖、零网络、确定性（与 check-rule-refs.ts / terminology-carrier-snapshot.ts 同型），
 *           可进 CI。不修改任何文件；只读盘点 + 退出码。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── 路径与扫描范围 ───────────────────────────────

/** 仓库根（本文件位于 scripts/ 下，故向上一级） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 本脚本自身的相对路径（正斜杠）——必须排除。
 * 为什么：注册表里**触发词字面量**（如 `'自动清理'`）自身就是被扫的词形，
 * 扫描自己 ⇒ 每条触发词给自己续命、且恒自报命中（同 terminology 脚本的续命失效模式）。
 */
const SELF_REL = relative(ROOT, fileURLToPath(import.meta.url))
  .split('\\')
  .join('/');

/** 不入扫描的目录：依赖 / 版本库 / 构建产物 / 覆盖率 / 工具内部状态 / 宿主持久化 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.workbuddy', '.memora']);

/** 参与扫描的文本后缀：短语可落在代码注释、文档、规则、台账、样式、配置里 */
const SCAN_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.cjs',
  '.mjs',
  '.json',
  '.md',
  '.html',
  '.css',
  '.vue',
  '.yml',
  '.yaml',
]);

// ─── 类注册表（唯一数据源） ─────────────────────────

/** 一条触发词（LIE 形态）：命中即「疑似本类短语」 */
interface Trigger {
  /** 触发词标签（报表展示，如「自动清理」） */
  label: string;
  /** 触发词正则（广收，不做真假判定——真伪由分类段裁决） */
  re: RegExp;
}

/** 一条放行规则：给命中「归类」并写明理由（逐条分类的裁决载体） */
interface AllowRule {
  /** 规则名（报表展示） */
  id: string;
  /** 分类理由（必填：写清「为何这条命中不是本类缺陷」） */
  reason: string;
  /** 适用文件（仓库相对正斜杠）；省略 = 不限文件 */
  file?: RegExp;
  /** 适用行文本；省略 = 不限文本。file 与 text 不得同时省略（否则 = 无差别放行） */
  text?: RegExp;
}

/** 自检样例：用同一套判据跑，证明闸门「还看得见」（同 check-rule-refs 的失效模式防线） */
interface SelfCase {
  /** 探针行（须能让触发词命中或不命中） */
  probe: string;
  /** 探针所在文件（决定放行规则是否适用） */
  file: string;
  /** 期望命中数（0 = 反向护栏：触发词正则过宽会误抓） */
  hits: number;
  /** 命中时是否期望被归类（本条仅 hits>0 时生效） */
  classified?: boolean;
}

/** 一个短语类（= 一组同源谎报 + 其分类裁决清单） */
interface ScanClass {
  /** 类 id（`--class` 寻址用，kebab-case） */
  id: string;
  /** 类标题 */
  title: string;
  /** 存在理由：为什么这个类值得单独立闸 */
  why: string;
  /** 触发词（广收全集） */
  triggers: readonly Trigger[];
  /** 放行规则（逐条分类裁决） */
  allows: readonly AllowRule[];
  /** 闸门自检样例 */
  selfTest: readonly SelfCase[];
}

// 他子系统同名动作的**双层**判据（缺一层即有洞，见下）：
//   ① 文件面（子系统边界）：「自动/定期清理」在本仓另有多种正当用法（定时器兜底 / 锁 / GC / 构建），
//      同词异义按**子系统边界**分布，按文件面分类可复现、可审计。
//   ② 文本面（OFF_CLASS_TEXT_RE）：**仅靠文件面会吞掉「他子系统文件里新写的回收站假话」**（审查发现的结构洞 2）——
//      如有人在 loop.ts 写「回收站到期自动清理」，会被文件级放行误判为「他子系统」。故另加组合约束。
const OFF_CLASS_TIMER_RE =
  /^(hosts\/memora-vscode\/src\/(webview\/scripts\/chatView\.ts|extension\/host\/codeExecutor\.ts)|src\/(utils\/(safeTimer\.ts|__tests__\/safeTimer\.test\.ts)|agent\/(agent\.ts|loop\.ts|managers\/(sessionManager\.ts|__tests__\/sessionManager\.test\.ts)|__tests__\/uninterruptedWorkflow\.test\.ts)|llm\/__tests__\/abortSignal\.test\.ts|code-exec\/codeExecutionProvider\.ts))$/;
const OFF_CLASS_GC_LOCK_RE =
  /^(src\/memory\/(lockManager\.ts|gcService\.ts|__tests__\/(lockManager|projectManager)\.test\.ts)|docs\/architecture\/round-independent-storage-design\.md)$/;

/**
 * 他子系统同名词形（**正向限定**）：off-class 放行必须命中其一，证明确非回收站语境。
 * 词形按本仓他子系统实际写法收集（定时器兜底 / 暂停超时 / 锁残留 / Round GC / 构建脚本…）。
 */
const OFF_CLASS_MARKER_RE =
  /定时器|计时器|Timeout|Interval|Timer|注册表|超时|检查点|心跳|兜底|残留|孤儿|锁|引用计数|GC|暂停|unref|abort|dispose|postinstall|ABI/;

/**
 * 回收站/记忆清理语形（**负向限定**）：off-class 放行**必须不含**这些词——否则他子系统文件里的
 * 回收站假话会被文件级放行静默吞掉（结构洞 2 的根因）。用前瞻 `(?!…)` 表达「不含」：JS 正则支持前瞻
 * （rg 的 Rust regex 不支持 —— 这也是本判据用 TS 而非 rg 的实现理由之一）。
 */
const RECYCLE_SCOPE_RE =
  /回收站|软删|deletedAt|purgeExpired|writePurgeExpired|保留期|回收期|MEMORY_RECYCLE/;

/**
 * off-class 组合文本判据：行须**含他子系统词形 且 不含回收站语形**。
 * `^(?=.*标记)(?!.*回收站语形)` —— 两者同时满足才判定为「确实的他子系统同名动作」。
 */
const OFF_CLASS_TEXT_RE = new RegExp(
  `^(?=.*(?:${OFF_CLASS_MARKER_RE.source}))(?!.*(?:${RECYCLE_SCOPE_RE.source}))`,
);

/**
 * 类 1：memory-recycle-cleanup —— 「回收站/记忆清理被自动·周期·定时器驱动」的假话。
 * 真源（宿主 `shared/constants.ts` 与手册 §五）：内核**不持定时器**清理回收站，
 * 保留期策略归宿主，物理清理由宿主入口（`memora.cleanupMemories` 命令 / 设置面板「清理过期」）
 * **显式触发** —— 凡措辞暗示「自动 / 定期 / 定时」清理回收站即本类缺陷。
 */
const MEMORY_RECYCLE_CLEANUP: ScanClass = {
  id: 'memory-recycle-cleanup',
  title: '回收站/记忆清理被自动·周期·定时器驱动（假话）',
  why: '内核零自动清理回收站（保留期归宿主策略、清理须宿主入口显式触发）；暗示「自动/定期/定时」= 假话，会误导读者以为存在定时回收器。',
  triggers: [
    { label: '自动清理', re: /自动清理/ },
    { label: '自动回收', re: /自动回收/ },
    { label: '到期自动', re: /到期自动/ },
    { label: '定期…回收/清理', re: /定期.{0,12}(回收|清理|回收站)/ },
    { label: '定时…回收/清理/purge/过期', re: /定时.{0,12}(回收|清理|回收站|purge|过期)/i },
    { label: '宿主定时(器)', re: /宿主定时(器)?/ },
    { label: '保留 30 天', re: /保留\s*30\s*天/ },
    { label: '30 天回收期', re: /30\s*天回收期/ },
  ],
  allows: [
    {
      id: 'negation',
      text: /不自动清理|无自动清理|零自动清理|不自动回收|无自动回收|不持定时器|无定时器|零定时器|非自动清理|不自动清除/,
      reason: '否定式真源（明确否认「自动/定时」），与假话共用触发词但语义相反 ⇒ 非缺陷',
    },
    {
      id: 'history-changelog',
      file: /(^|\/)CHANGELOG\.md$/,
      reason:
        'CHANGELOG 为历史发布记录，按「历史不改写」纪律保留原措辞（其中「30 天自动清理」是当时实现的记述）',
    },
    {
      id: 'history-ledger',
      file: /^tasks\//,
      reason: '台账/归档自身引述该类短语（登记纪律、销项过程、复查留痕），是对过程而非对真源的断言',
    },
    {
      id: 'history-adr',
      file: /^\.trae\/decisions\/ADR-004-memory-unification\.md$/,
      reason:
        'ADR 历史决策正文 + 订正注记引述旧措辞，按 ADR 纪律不重写正文（注记已标「与现状不符」）',
    },
    {
      id: 'off-class-timer',
      file: OFF_CLASS_TIMER_RE,
      text: OFF_CLASS_TEXT_RE,
      reason:
        '他子系统同名动作：运行时定时器兜底清理 / 暂停超时清理检查点 / 工具等待轮询 / 进程退出兜底，均非回收站类（且该行不含回收站语形，见 OFF_CLASS_TEXT_RE）',
    },
    {
      id: 'off-class-gc-lock',
      file: OFF_CLASS_GC_LOCK_RE,
      text: OFF_CLASS_TEXT_RE,
      reason:
        '他子系统同名动作：Round GC（引用计数自动清理）/ 残留锁文件清理 / 孤儿对账，均非回收站类（且该行不含回收站语形）',
    },
    {
      id: 'off-class-build',
      file: /^\.trae\/decisions\/ADR-001-runtime-stack\.md$/,
      text: OFF_CLASS_TEXT_RE,
      reason:
        '他子系统同名动作：postinstall 构建脚本清理 ABI 冲突副本，非回收站类（且该行不含回收站语形）',
    },
    {
      id: 'skills-manual',
      file: /^\.trae\/skills\//,
      reason:
        'big-tree 技能手册（可移植模板，非本仓真源）；其中「定期清理枯枝」是对项目维护的比喻，非本仓回收站语义',
    },
  ],
  selfTest: [
    // [A] 假话形态且无放行 → 命中且未归类（正向：证明触发词在工作 + 无差别放行不存在）
    //     该行同时命中「到期自动」「自动清理」两词 ⇒ hits=2（按触发词条数计，非按行计）
    { probe: '回收站到期自动清理', file: 'src/memory/__probe__.ts', hits: 2, classified: false },
    // [B] 同一批触发词 + 否定式 → 命中且被 negation 归类（反向：证明否定式真源被正确放行）
    {
      probe: '回收站**不自动清理**：保留期由宿主策略决定（当前宿主为 30 天）',
      file: 'src/memory/__probe__.ts',
      hits: 1,
      classified: true,
    },
    // [C] 历史档里的旧措辞 → 被 history-changelog 归类（证明历史面放行生效）
    { probe: '30 天自动清理后的孤儿向量', file: 'CHANGELOG.md', hits: 1, classified: true },
    // [D] 普通文本无触发词 → 0 命中（反向护栏：触发词正则过宽会误抓一切文本）
    { probe: '这是一行与短语类无关的普通文本', file: 'src/__probe__.ts', hits: 0 },
    // [E] 回归护栏（结构洞 2）：回收站假话落在**他子系统文件**里 → 仍须未归类
    //     （证 off-class 的文件级放行不吞回收站语境；该行含「回收站」⇒ OFF_CLASS_TEXT_RE 负向失败）
    { probe: '回收站到期自动清理', file: 'src/agent/loop.ts', hits: 2, classified: false },
    // [F] 反向护栏：**真·他子系统同名动作**（定时器清理检查点）→ 仍须被 off-class 归类
    {
      probe: '暂停超时定时器清理检查点并重置状态机',
      file: 'src/agent/managers/sessionManager.ts',
      hits: 1,
      classified: true,
    },
  ],
};

/** 全部注册类（新增类在此登记；`--list` / `--check` / 默认枚举都消费本表） */
const CLASSES: readonly ScanClass[] = [MEMORY_RECYCLE_CLEANUP];

// ─── 判据（扫描 / 分类） ───────────────────────────

/** 命中记录 */
interface Hit {
  /** 文件（仓库相对正斜杠） */
  file: string;
  /** 行号（1-based） */
  line: number;
  /** 该行原文（trim 后） */
  text: string;
  /** 命中的触发词标签 */
  patterns: string[];
  /** 命中的放行规则理由（空 = 未归类） */
  reasons: string[];
}

/** 命中判定：返回该行命中的触发词标签（主扫描与自检共用，杜绝自检通过但判据已瞎） */
function scanLine(cls: ScanClass, line: string): string[] {
  const labels: string[] = [];
  for (const t of cls.triggers) {
    if (t.re.test(line)) labels.push(t.label);
  }
  return labels;
}

/** 分类判定：返回命中的放行规则理由（空 = UNCLASSIFIED） */
function classifyHit(cls: ScanClass, file: string, text: string): string[] {
  const reasons: string[] = [];
  for (const rule of cls.allows) {
    // 防御：无任何限定的规则 = 无差别放行，直接报错而非静默生效
    if (!rule.file && !rule.text) {
      throw new Error(`类 ${cls.id} 的放行规则 ${rule.id} 未设 file/text 限定 = 无差别放行，禁止`);
    }
    if (rule.file && !rule.file.test(file)) continue;
    if (rule.text && !rule.text.test(text)) continue;
    reasons.push(`[${rule.id}] ${rule.reason}`);
  }
  return reasons;
}

// ─── 闸门自检 ──────────────────────────────────

/** 跑全部类的自检；任一失败即打印原因。返回是否全过 */
function runSelfTest(): boolean {
  let ok = 0;
  let total = 0;
  for (const cls of CLASSES) {
    for (const c of cls.selfTest) {
      total += 1;
      const labels = scanLine(cls, c.probe);
      let pass = labels.length === c.hits;
      let detail = `hits=${labels.length}（期望 ${c.hits}）`;
      if (pass && c.hits > 0 && c.classified !== undefined) {
        const reasons = classifyHit(cls, c.file, c.probe);
        const classified = reasons.length > 0;
        pass = classified === c.classified;
        detail += ` classified=${classified}（期望 ${c.classified}）`;
      }
      if (pass) ok += 1;
      else console.error(`  自检失败: [${cls.id}] 「${c.probe}」@${c.file} ${detail}`);
    }
  }
  console.log(`闸门自检: ${ok}/${total} 样例符合预期`);
  return ok === total;
}

// ─── 扫描实现 ──────────────────────────────────

/** 收集待扫文本文件（递归；跳过 SKIP_DIRS 与本脚本自身） */
function collect(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      collect(abs, out);
      continue;
    }
    if (!SCAN_EXTS.has(extname(name))) continue;
    const rel = relative(ROOT, abs).split('\\').join('/');
    if (rel === SELF_REL) continue; // 自身排除：触发词字面量不得给自己续命/自报
    out.push(rel);
  }
}

/** 无截断枚举一个类的全部命中（**不设上限、不 slice**——这是本脚本存在的全部理由） */
function enumerateClass(cls: ScanClass, files: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, rel), 'utf8');
    } catch {
      continue; // 读不动（二进制 / 权限）就跳过，不因单个文件中断整轮
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const patterns = scanLine(cls, line);
      if (patterns.length === 0) return;
      const trimmed = line.trim();
      hits.push({
        file: rel,
        line: i + 1,
        text: trimmed,
        patterns,
        reasons: classifyHit(cls, rel, trimmed),
      });
    });
  }
  return hits;
}

/**
 * 完整性独立复核：**第二遍独立遍历**，只数命中行数（不接触 enumerateClass 的结果数组）。
 *
 * 为什么必须：`enumerateClass` 若被人在内部加 `.slice(0, N)`，它返回的数组长度**本身就已是截断后的数**，
 * 于是「printed === hits.length」恒真（断言与被断言同源）⇒ 本脚本「防静默截断」的承诺落空（结构洞 1）。
 * 本函数与 enumerateClass 的唯一共享面只有 `files` 与 `scanLine`（判据本身），故任何对**结果数组**的
 * 截断都会与它不等 → 爆红。**断根工具自己必须防截断**，这是该承诺的闭环。
 */
function countMatchLines(cls: ScanClass, files: readonly string[]): number {
  let n = 0;
  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, rel), 'utf8');
    } catch {
      continue; // 与 enumerateClass 同款容错：读不动就跳过，保证两遍扫描文件面一致
    }
    for (const line of text.split(/\r?\n/)) {
      if (scanLine(cls, line).length > 0) n += 1;
    }
  }
  return n;
}

/**
 * 完整性断言（结构洞 1 收口）：hits 长度 / 独立复核数 / 实际打印数 三者必须一致。
 * 任一不等 = 存在截断，直接 exit 2 —— 本脚本存在的理由即防此类静默失效。
 * @param printed 打印循环实际输出的条数；check 模式不逐条打印，传 hits.length 占位（仅核两路一致）
 */
function assertComplete(
  cls: ScanClass,
  hits: readonly Hit[],
  independent: number,
  printed: number,
): void {
  if (hits.length !== independent || hits.length !== printed) {
    console.error(
      `\n❌ 完整性断言失败 [${cls.id}]：hits=${hits.length} · 独立复核=${independent} · 打印=${printed}\n` +
        '   三者不等 = 存在截断（enumerateClass 或打印循环被加了上限）。',
    );
    process.exit(2);
  }
}

// ─── 输出 ──────────────────────────────────────

/** 打印一个类的枚举结果；返回**实际打印条数**（供主流程硬断言 == hits.length） */
function printEnumeration(cls: ScanClass, hits: readonly Hit[]): number {
  console.log(`\n═══ [${cls.id}] ${cls.title} ═══`);
  console.log(`   触发词 ${cls.triggers.length} 个 · 放行规则 ${cls.allows.length} 条`);
  console.log(`   命中 ${hits.length} 条（**全量枚举 · 无截断**）`);
  let printed = 0;
  for (const h of hits) {
    printed += 1;
    const mark = h.reasons.length > 0 ? '✅' : '❌';
    console.log(`  ${mark} ${h.file}:${h.line}  ${h.text}`);
    console.log(`      触发: ${h.patterns.join(' | ')}`);
    if (h.reasons.length > 0) {
      for (const r of h.reasons) console.log(`      归类: ${r}`);
    } else {
      console.log('      归类: ❌ UNCLASSIFIED（未命中任何放行规则）');
    }
  }
  return printed;
}

/** 打印一个类的门禁裁决（只列 UNCLASSIFIED + 汇总）；返回未归类条数 */
function printCheck(cls: ScanClass, hits: readonly Hit[]): number {
  const unclassified = hits.filter((h) => h.reasons.length === 0);
  if (unclassified.length === 0) {
    console.log(`✅ [${cls.id}] ${hits.length} 条命中全部归类`);
    return 0;
  }
  console.log(
    `\n❌ [${cls.id}] 存在 ${unclassified.length} 条未归类命中（应归入某放行规则，或改掉假话）：`,
  );
  for (const h of unclassified) {
    console.log(`  ❌ ${h.file}:${h.line}  ${h.text}`);
    console.log(`      触发: ${h.patterns.join(' | ')}`);
  }
  return unclassified.length;
}

/** `--list`：列出注册类与登记面 */
function printList(): void {
  console.log(`\n📢 短语类扫描 · 注册类 ${CLASSES.length} 个\n`);
  for (const cls of CLASSES) {
    console.log(`  ${cls.id}`);
    console.log(`    标题: ${cls.title}`);
    console.log(`    触发词: ${cls.triggers.map((t) => t.label).join(' / ')}`);
    console.log(`    放行规则: ${cls.allows.length} 条 · 自检样例: ${cls.selfTest.length} 条`);
  }
  console.log('');
}

// ─── 主流程 ──────────────────────────────────

function argOf(key: string): string | undefined {
  const argv = process.argv.slice(2);
  const hit = argv.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.slice(key.length + 3) : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);

  if (argv.includes('--list')) {
    printList();
    return;
  }

  // 自检先于一切：判据失明时「全归类 / 0 命中」皆不可信
  if (!runSelfTest()) {
    console.error('\n闸门自检未通过：判据可能已失明，此时裁决不可信。');
    process.exit(2);
  }

  // 选类：--class 指定单个；否则全部
  const onlyId = argOf('class');
  let selected: readonly ScanClass[];
  if (onlyId) {
    const found = CLASSES.find((c) => c.id === onlyId);
    if (!found) {
      console.error(`--class=${onlyId} 不是已注册类。可选：${CLASSES.map((c) => c.id).join(', ')}`);
      process.exit(2);
    }
    selected = [found];
  } else {
    selected = CLASSES;
  }

  const files: string[] = [];
  collect(ROOT, files);
  files.sort();
  console.log(
    `\n短语类扫描 · 文本文件 ${files.length} 个（排除 node_modules/.git/dist/coverage/.workbuddy/.memora 与本脚本）`,
  );

  if (argv.includes('--check')) {
    let totalUnclassified = 0;
    for (const cls of selected) {
      const hits = enumerateClass(cls, files);
      // 结构洞 1 收口：门禁模式同样必须先证「枚举完整」，否则「0 未归类」可能是截断后的假象
      assertComplete(cls, hits, countMatchLines(cls, files), hits.length);
      totalUnclassified += printCheck(cls, hits);
    }
    if (totalUnclassified > 0) {
      console.log(`\n门禁未通过：合计 ${totalUnclassified} 条未归类命中。`);
      console.log(
        '修法二选一：① 命中是他子系统/否定式/历史档 → 补一条 allow 规则（带 reason）；' +
          '② 命中确是本类假话 → 改掉措辞。',
      );
      process.exit(1);
    }
    console.log(`\nOK：${selected.length} 个类的命中全部归类。`);
    return;
  }

  // 默认：无截断枚举 + 逐条分类标记
  for (const cls of selected) {
    const hits = enumerateClass(cls, files);
    const printed = printEnumeration(cls, hits);
    // 结构洞 1 收口：独立复核数（第二遍遍历）+ 实际打印数 与 hits 长度三方对账 —— 任何截断都爆红
    assertComplete(cls, hits, countMatchLines(cls, files), printed);
  }
  console.log('');
}

main();
