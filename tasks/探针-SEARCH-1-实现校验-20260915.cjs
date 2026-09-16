/**
 * SEARCH-1 · 实现校验探针（2026-09-15）
 *
 * 与 `tasks/探针-SEARCH-1-验证-20260915.cjs` 的区别（**为什么必须有这一个**）：
 *   前者的策略 C 用的是**原型**算法（词表 = `[q, ...extractKeywords(q)]`，即 R0 且含整串）；
 *   而真机落地的是 `src/project-search/terms.ts` 的 R5 + toolExecutor 的"剔除与整串等价的词"守卫。
 *   两者不是同一套 → **方案文档里的数字不能直接搬用到实现上**，必须用真实现重算。
 *
 * 本探针逐字调用 **dist 里的真 buildSearchTerms**，并复刻 **dist 宿主实现的两轮逻辑**
 * （整串优先 → 零命中且词表非空 → OR 放宽），重算：
 *   ① 真机 13 条 content query：现状零命中 → 实现后零命中
 *   ② 前缀一致性（零精度退化）：现状命中的位置与顺序必须不变
 *   ③ 放宽轮实际触发次数 + 每次的词表
 *   ④ 词表碎片（原查询中不存在的 ASCII 碎片，如 js / next）—— 必须为空
 *
 * 运行：node tasks/探针-SEARCH-1-实现校验-20260915.cjs
 * 依赖：memora dist/（真分词器 + 真 buildSearchTerms）+ 真机项目目录。只读，不写项目。
 */
const fs = require('fs');
const path = require('path');

// ── 可调参数 ──────────────────────────────────────────────
const ROOT = 'F:/用户目录/Desktop/互动叙事平台方案';
const KERNEL_TERMS = 'F:/zooique/memora/dist/project-search/terms.js';
// ──────────────────────────────────────────────────────────

const IGNORE = new Set(['.git', 'node_modules', '.memora', 'dist', 'coverage', '.next', '.workbuddy']);
const MAX_FILE_BYTES = 64 * 1024;
const MAX_MATCHES_PER_FILE = 3;
const MAX_RESULTS = 20;

const { buildSearchTerms } = require(KERNEL_TERMS);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isAscii = (s) => /^[\x20-\x7e]+$/.test(s);

// ── 语料装载（复刻宿主 walkText 的忽略语义）────────────────
const FILES = [];
(function walk(d) {
  let names;
  try {
    names = fs.readdirSync(d);
  } catch {
    return;
  }
  names.sort();
  for (const n of names) {
    if (IGNORE.has(n)) continue;
    const p = path.join(d, n);
    let s;
    try {
      s = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(p);
    else if (s.size <= MAX_FILE_BYTES) FILES.push([path.relative(ROOT, p).replace(/\\/g, '/'), p]);
  }
})(ROOT);

const CACHE = new Map();
const readLines = (abs) => {
  if (!CACHE.has(abs)) {
    let t = '';
    try {
      t = fs.readFileSync(abs, 'utf8');
    } catch {}
    CACHE.set(abs, t.split('\n'));
  }
  return CACHE.get(abs);
};

/** 复刻宿主 scanText + matchFileText（单轮扫描） */
function scan(terms, cap) {
  const alt = new RegExp(terms.map(escapeRegExp).join('|'), 'i');
  const out = [];
  for (const [rel, abs] of FILES) {
    if (out.length >= cap) break;
    const lines = readLines(abs);
    let hits = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!alt.test(lines[i])) continue;
      if (hits >= MAX_MATCHES_PER_FILE) break;
      out.push(rel + ':' + (i + 1));
      hits++;
      if (out.length >= cap) break;
    }
  }
  return out;
}

/** 现状：整串字面量，无放宽 */
const current = (q) => scan([q], MAX_RESULTS);

/** 实现后的两轮逻辑（复刻 toolExecutor:剔除等价词 + 宿主:整串优先→零命中回退） */
function implemented(q) {
  const primary = scan([q], MAX_RESULTS);
  if (primary.length > 0) return { hits: primary, relaxed: false, terms: null };
  const terms = buildSearchTerms(q).filter((t) => t.toLowerCase() !== q.trim().toLowerCase());
  if (terms.length === 0) return { hits: [], relaxed: false, terms: [] };
  return { hits: scan(terms, MAX_RESULTS), relaxed: true, terms };
}

// ── 段① 抽取真机 content query ────────────────────────────
const spCalls = [];
{
  const dir = path.join(ROOT, '.memora', 'rounds');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('round-')).sort();
  } catch {}
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    const starts = new Map();
    for (const ev of j.processEvents || []) {
      const p = ev.payload || {};
      if (ev.type === 'tool_start') {
        let a = {};
        try {
          a = JSON.parse(p.args || '{}');
        } catch {}
        starts.set(p.toolCallId, { name: p.name, args: a });
      } else if (ev.type === 'tool_result') {
        const st = starts.get(p.toolCallId);
        if (st && st.name === 'search_project') spCalls.push({ ...st, summary: p.summary || '' });
      }
    }
  }
}
const ALL_CONTENT = spCalls.filter((c) => c.args.mode === 'content');
const QUERIES = ALL_CONTENT.map((c) => String(c.args.query));

console.log('══ 真机 content query 复算（真 buildSearchTerms + 两轮逻辑）══');
console.log(`  语料文件数（≤64KB、按宿主忽略语义）：${FILES.length}`);

let zCur = 0,
  zNew = 0,
  prefixOk = 0,
  fell = 0,
  fragTotal = 0;
const rows = [];

for (const q of QUERIES) {
  const cur = current(q);
  const impl = implemented(q);
  if (cur.length === 0) zCur++;
  if (impl.hits.length === 0) zNew++;
  const prefix = cur.every((h, i) => impl.hits[i] === h);
  if (prefix) prefixOk++;
  if (impl.relaxed) fell++;

  // 碎片：词表中"原查询里不存在的纯 ASCII 词"
  const rawTokens = q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
  const frags = (impl.terms || []).filter((w) => isAscii(w) && !rawTokens.includes(w.toLowerCase()));
  fragTotal += frags.length;

  rows.push({
    q,
    cur: cur.length,
    now: impl.hits.length,
    prefix,
    relaxed: impl.relaxed,
    terms: impl.terms,
    frags,
  });
}

const w = Math.max(...rows.map((r) => r.q.length)) + 2;
console.log('\n  query'.padEnd(w) + '现状  实现  前缀  放宽  词表');
for (const r of rows) {
  console.log(
    '  ' +
      r.q.padEnd(w - 2) +
      String(r.cur).padStart(4) +
      String(r.now).padStart(6) +
      (r.prefix ? '   ✓ ' : '   × ') +
      (r.relaxed ? '  放宽 ' : '      ') +
      JSON.stringify(r.terms),
  );
}

const T = QUERIES.length;
console.log('\n══ 汇总 ══');
console.log(`  零命中：现状 ${zCur} → 实现 ${zNew}        （共 ${T} 条真机 content query）`);
console.log(`  前缀一致性（零精度退化）：${prefixOk}/${T}`);
console.log(`  放宽轮实际触发：${fell} 次`);
console.log(`  词表碎片（原查询中不存在的 ASCII 碎片）：${fragTotal} 个  ${fragTotal === 0 ? '✅' : '❌'}`);
console.log('\n完成。以上即"实现后"的可复算数字（方案文档的数字来自原型算法，如需引用请引这一组）。');
