#!/usr/bin/env node
/**
 * 台账检索器 —— 消「台账无检索面」缺口（G3 · 2026-11-23）
 *
 * 为什么存在：台账 1300+ 行 / 近 200 条，找一条账靠全文阅读或裸 grep —— grep 只给行号，
 *   不给「这条属于哪个区 / 什么状态 / 正文边界在哪」，多行条目还要手工回看上下文。
 *
 * 设计边界（刻意）：
 *   - **不落索引文件**：每次直接解析台账文本（单文件 < 100KB，解析 < 50ms），不生成第二真源。
 *   - **只读不判**：结构与归档校验归 verify-ledger-hygiene.mjs / verify-ledger-fold.mjs，
 *     本脚本只做定位与展示，不输出任何「合规 / 违规」结论。
 *     同理**不复制**hygiene 的豁免判据（已收口 / 🗄 封存免时钟）⇒ 到期分布按**全量**展示：
 *     宁可多列封存条目的僵尸日期，也不在这边造第二份判据。「真有多少活跃到期项」以门为准。
 *   - **口径与台账格式契约同源**：`## ` = 区、`- **ID**` = 条目、`｜` = 状态段分隔
 *     （格式真源 = 台账头部「形态说明」）。
 *
 * 用法：
 *   node scripts/ledger-query.mjs <关键词…>             # 全文检索（AND：全部关键词都命中）
 *   node scripts/ledger-query.mjs --id <ID>             # 按 ID 精确查（输出完整条目）
 *   node scripts/ledger-query.mjs --due <YYYY-MM[-DD]>  # 按到期复查日期前缀查
 *   node scripts/ledger-query.mjs --stats               # 分区 / 状态 / 到期日分布
 * 退出码：有结果 0；查无结果 1（便于脚本化判断）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本脚本位于 scripts/ 下一层） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 台账相对路径（唯一真理源） */
const LEDGER_REL = 'tasks/待完成任务.md';
/**
 * 到期复查日期形态 —— **必须与 verify-ledger-hygiene.mjs 的 EXPIRY_RE 逐字一致**（本文件是复制方）。
 * 台账改日期写法时两处要同时改：本脚本不是判据，只改一处不会有任何门变红，
 * 只会让检索结果**静默少列**（漂移无报警 ⇒ 故写成动作指令，而不是「同源」这类状态描述）。
 */
const EXPIRY_RE = /到期复查\s*(\d{4}-\d{2}-\d{2})/;
/** 条目首行形态：`- **ID** — 标题｜状态`（ID 捕获组去见 parseLedger） */
const ITEM_RE = /^- \*\*(.+?)\*\*/;

/**
 * 读取台账并切成「区 → 条目」两级结构。
 *
 * 条目边界 = 下一个 `- **` 首行或区尾（**完整正文**，与判据脚本的「body 真实边界」不同：
 * 那是为了不让区级说明混进判据输入，检索则要看到条目相关的全部文字）。
 * @returns {{lines:string[], sections:{title:string,start:number,end:number,items:{id:string,head:string,start:number,end:number}[]}[]}}
 */
function parseLedger() {
  const text = readFileSync(join(ROOT, LEDGER_REL), 'utf8');
  // 去尾部换行再切分：与 verify-ledger-hygiene.mjs 的 diagnose() 同口径，
  // 否则文件以 \n 结尾时本脚本自报行数比判据脚本多 1（同一事实两个数字 = 必然漂移）。
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);

  // ① 大区切分：`## ` 标题到下一个 `## ` 标题（或 EOF）
  const heads = [];
  lines.forEach((l, i) => {
    if (/^## /.test(l)) heads.push({ title: l.replace(/^##\s*/, ''), start: i });
  });
  const sections = heads.map((h, k) => ({
    ...h,
    end: k + 1 < heads.length ? heads[k + 1].start : lines.length,
    items: [],
  }));

  // ② 条目切分：区内的 `- **ID**` 首行 → 下一个条目首行 / 区尾
  for (const sec of sections) {
    const starts = [];
    for (let i = sec.start; i < sec.end; i++) {
      if (ITEM_RE.test(lines[i])) starts.push(i);
    }
    sec.items = starts.map((s, k) => ({
      id: ITEM_RE.exec(lines[s])?.[1] ?? '',
      head: lines[s],
      start: s,
      end: k + 1 < starts.length ? starts[k + 1] : sec.end,
    }));
  }
  return { lines, sections };
}

/**
 * 条目在台账里的绝对行号（1-based）与区名，拼成单行定位前缀。
 * @param {{start:number}} item 条目
 * @param {{title:string}} sec 区
 * @returns {string} 形如 `[观察 / 待拍板] L120`
 */
function locate(item, sec) {
  return `[${sec.title}] L${item.start + 1}`;
}

/**
 * 全文检索（AND 语义）：全部关键词都出现在条目块内才命中。
 * 输出 = 一条一行首行 + 明细命中行，避免把 40 行条目整块刷屏。
 *
 * 条目外的文字（台账头部「登记规范」/ 区头说明 / 表格）单独扫：
 * 判据与条目内不同——要求**同一行**含全部关键词（头部条文的跨行语义无法机械切分，
 * 多关键词搜头部请拆成单关键词分别搜）。
 * @param {string[]} keywords 关键词（大小写不敏感）
 * @returns {number} 命中条目数 + 条目外命中行数
 */
function search(keywords) {
  const { lines, sections } = parseLedger();
  const lowered = keywords.map((k) => k.toLowerCase());
  let hits = 0;
  /** 属于某个条目的行号集合（0-based），用于反向收集条目外命中 */
  const inItem = new Set();
  for (const sec of sections) {
    for (const it of sec.items) {
      for (let i = it.start; i < it.end; i++) inItem.add(i);
      const block = lines.slice(it.start, it.end);
      const body = block.join('\n').toLowerCase();
      if (!lowered.every((k) => body.includes(k))) continue;
      hits++;
      console.log(`\n${locate(it, sec)}  ${it.head.trim().slice(0, 160)}`);
      // 明细命中行：最多 6 行，防超长条目把输出淹掉
      const detail = block
        .map((l, i) => ({ l, ln: it.start + i + 1 }))
        .filter(({ l }) => lowered.some((k) => l.toLowerCase().includes(k)))
        .slice(0, 6);
      for (const { l, ln } of detail) console.log(`   L${ln}: ${l.trim().slice(0, 150)}`);
    }
  }
  // 条目外命中（同一条行含全部关键词，最多 10 行）
  const outside = lines
    .map((l, i) => ({ l, ln: i + 1 }))
    .filter(({ l, ln }) => !inItem.has(ln - 1) && lowered.every((k) => l.toLowerCase().includes(k)))
    .slice(0, 10);
  if (outside.length) {
    console.log('\n条目外命中（台账头部 / 区头说明 / 表格）：');
    for (const { l, ln } of outside) console.log(`   L${ln}: ${l.trim().slice(0, 150)}`);
    hits += outside.length;
  }
  console.log(`\n命中 ${hits} 处（关键词：${keywords.join(' + ')}）`);
  return hits;
}

/**
 * 按 ID 精确查（输出完整条目，保留台账行号）。
 * @param {string} id 条目 ID（不区分大小写）
 * @returns {number} 命中条目数
 */
function byId(id) {
  const { lines, sections } = parseLedger();
  const want = id.toLowerCase();
  let hits = 0;
  for (const sec of sections) {
    for (const it of sec.items) {
      if (it.id.toLowerCase() !== want) continue;
      hits++;
      console.log(`\n${locate(it, sec)}  ${it.head.trim()}`);
      for (let i = it.start + 1; i < it.end; i++) console.log(`   L${i + 1}: ${lines[i]}`);
    }
  }
  if (!hits) console.log(`未找到 ID：${id}`);
  return hits;
}

/**
 * 按到期复查日期前缀查（如 `2026-12` / `2027-01-12`）——配合 ⑭ 到期处置使用。
 * @param {string} prefix 日期前缀
 * @returns {number} 命中条目数
 */
function byDue(prefix) {
  const { lines, sections } = parseLedger();
  let hits = 0;
  for (const sec of sections) {
    for (const it of sec.items) {
      const m = EXPIRY_RE.exec(lines.slice(it.start, it.end).join('\n'));
      if (!m || !m[1].startsWith(prefix)) continue;
      hits++;
      console.log(`${m[1]}  ${locate(it, sec)}  ${it.head.trim().slice(0, 130)}`);
    }
  }
  console.log(
    `\n到期 ${prefix}* 共 ${hits} 条（全量口径：含已收口 / 🗄 封存条目的历史日期，它们不设时钟——活跃口径以 hygiene 门为准）`,
  );
  return hits;
}

/**
 * 统计：区 / 条目 / 行数 + 状态粗分 + 到期日分布。
 * 「状态粗分」只做展示口径（按首行符号），不是判据——判据真源在 verify-ledger-hygiene.mjs。
 * @returns {number} 条目总数
 */
function stats() {
  const { lines, sections } = parseLedger();
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  console.log(`台账：${sections.length} 区 / ${total} 条 / ${lines.length} 行\n区分布：`);
  for (const sec of sections) {
    if (sec.items.length)
      console.log(`  ${sec.title}  ${sec.items.length} 条（L${sec.start + 1}-L${sec.end}）`);
  }
  // 状态粗分：只认首行状态段的第一个符号/词
  const buckets = { 观察: 0, 待执行: 0, 已完成: 0, 封存: 0, 其它: 0 };
  const dueCount = new Map();
  for (const sec of sections) {
    for (const it of sec.items) {
      if (/⏳|👁|🔵|⏸|🔄|🟡/.test(it.head)) buckets.观察++;
      else if (/📌/.test(it.head)) buckets.待执行++;
      else if (/✅/.test(it.head)) buckets.已完成++;
      else if (/🗄/.test(it.head)) buckets.封存++;
      else buckets.其它++;
      const m = EXPIRY_RE.exec(lines.slice(it.start, it.end).join('\n'));
      if (m) dueCount.set(m[1], (dueCount.get(m[1]) ?? 0) + 1);
    }
  }
  console.log(
    `\n状态粗分（首行符号，非判据）：观察 ${buckets.观察} / 待执行 ${buckets.待执行} / 已完成 ${buckets.已完成} / 封存 ${buckets.封存} / 其它 ${buckets.其它}`,
  );
  console.log('\n到期日分布（全量口径：含已收口 / 🗄 封存条目的历史日期；门 ⑯ 只计活跃条目）：');
  for (const [d, n] of [...dueCount].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    console.log(`  ${d}  ${n} 条`);
  }
  return total;
}

/** 主入口：解析参数并分发（无参数 = 用法提示） */
function main() {
  const argv = process.argv.slice(2);
  const flagAt = argv.indexOf('--id');
  const dueAt = argv.indexOf('--due');
  let hits = 0;

  if (argv.includes('--stats')) hits = stats();
  else if (flagAt >= 0) hits = byId(argv[flagAt + 1] ?? '');
  else if (dueAt >= 0) hits = byDue(argv[dueAt + 1] ?? '');
  else if (argv.length) hits = search(argv);
  else {
    console.log(
      '用法：node scripts/ledger-query.mjs <关键词…> | --id <ID> | --due <YYYY-MM[-DD]> | --stats',
    );
    process.exitCode = 1;
    return;
  }
  // 查无结果 ⇒ 1：让「查一条账」能在脚本里当条件用
  if (hits === 0) process.exitCode = 1;
}

main();
