/**
 * SEARCH-1 拍板依据 · 可重跑探针（2026-09-15）
 *
 * 用途：一次性复现 `tasks/方案-SEARCH-1修复-20260915.md` 里的全部实锤数字。
 * 运行：node tasks/探针-SEARCH-1-验证-20260915.cjs
 * 依赖：memora 内核 `dist/`（真分词器）+ 一个真实项目目录（含 `.memora/rounds`）。
 *
 * 四段：
 *   ① 从真机 rounds 抽取 search_project 调用并与结果配对 → 得"真零命中"清单
 *   ② 零命中分型：多词(F1) vs 近义措辞差（逐词存在性 + 连续串探测）
 *   ③ A/B/C 三策略对拍（现状整串 / 纯OR / 精确优先+零命中回退）
 *   ④ 回退词表 R0(extractKeywords) vs R5(显式片段优先) 的碎片噪声对比
 *
 * 注：不写入任何项目文件，只读。
 */
const fs = require('fs');
const path = require('path');

// ── 可调参数 ──────────────────────────────────────────────
/** 真机项目根（含 .memora/rounds 与待搜语料） */
const ROOT = 'F:/用户目录/Desktop/互动叙事平台方案';
/** memora 内核 dist 入口（提供真分词器 extractKeywords） */
const KERNEL = 'F:/zooique/memora/dist/memory/recall.js';
// ──────────────────────────────────────────────────────────

const IGNORE = new Set(['.git', 'node_modules', '.memora', 'dist', 'coverage', '.next', '.workbuddy']);
const MAX_FILE_BYTES = 64 * 1024;   // = 宿主 MAX_FILE_BYTES
const MAX_MATCHES_PER_FILE = 3;     // = 宿主 MAX_MATCHES_PER_FILE
const MAX_RESULTS = 20;             // 探针固定档（宿主默认 20）
const MAX_FILES_SCANNED = 500;      // = 宿主 MAX_FILES_SCANNED

const { extractKeywords } = require(KERNEL);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isAscii = (s) => /^[\x20-\x7e]+$/.test(s);
const hasCJK = (s) => /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(s);

// ── 语料装载（复刻 walkText 的忽略语义）─────────────────────
const FILES = [];
(function walk(d) {
  let names; try { names = fs.readdirSync(d); } catch { return; }
  names.sort();
  for (const n of names) {
    if (IGNORE.has(n)) continue;
    const p = path.join(d, n); let s;
    try { s = fs.lstatSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p);
    else if (s.size <= MAX_FILE_BYTES) FILES.push([path.relative(ROOT, p).replace(/\\/g, '/'), p]);
  }
})(ROOT);

const CACHE = new Map();
const readLines = (abs) => {
  if (!CACHE.has(abs)) { let t = ''; try { t = fs.readFileSync(abs, 'utf8'); } catch {} CACHE.set(abs, t.split('\n')); }
  return CACHE.get(abs);
};

/** 复刻宿主 matchFileText + walkText 停止条件 */
function scanAlt(terms, cap) {
  const alt = new RegExp(terms.map(escapeRegExp).join('|'), 'i');
  const out = [];
  for (const [rel, abs] of FILES) {
    if (out.length >= cap) break;
    const lines = readLines(abs); let hits = 0;
    for (let i = 0; i < lines.length && hits < MAX_MATCHES_PER_FILE; i++) {
      if (!alt.test(lines[i])) continue;
      out.push([rel + ':' + (i + 1), rel, i + 1]); hits++;
      if (out.length >= cap) break;
    }
  }
  return out;
}
const scanWhole = (q) => scanAlt([q], MAX_RESULTS);

// ── 策略 ─────────────────────────────────────────────────
const strWhole = (q) => ({ terms: [q], hits: scanWhole(q), fellBack: false, termsUsed: null });

/** A · 纯 OR（分词恒放宽） */
const strA = (q) => {
  const terms = [...new Set([q, ...extractKeywords(q)])];
  return { terms, hits: scanAlt(terms, MAX_RESULTS), fellBack: true, termsUsed: terms };
};

/** C · 精确优先 + 零命中回退（拍板方案） */
const strC = (q) => {
  const whole = scanWhole(q);
  if (whole.length > 0) return { terms: [q], hits: whole, fellBack: false, termsUsed: null };
  const terms = [...new Set([q, ...extractKeywords(q)])];
  return { terms, hits: scanAlt(terms, MAX_RESULTS), fellBack: true, termsUsed: terms };
};

// ── 段① 真机 query 抽取 ───────────────────────────────────
console.log('══ 段① 真机 search_project 调用（按 toolCallId 配对）══');
const spCalls = [];
{
  const dir = path.join(ROOT, '.memora', 'rounds');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith('round-')).sort(); } catch {}
  for (const f of files) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const starts = new Map();
    for (const ev of j.processEvents || []) {
      const p = ev.payload || {};
      if (ev.type === 'tool_start') {
        let a = {}; try { a = JSON.parse(p.args || '{}'); } catch {}
        starts.set(p.toolCallId, { name: p.name, args: a });
      } else if (ev.type === 'tool_result') {
        const st = starts.get(p.toolCallId);
        if (st && st.name === 'search_project') spCalls.push({ ...st, summary: p.summary || '' });
      }
    }
  }
}
const ALL_CONTENT = spCalls.filter((c) => c.args.mode === 'content');
const ZEROS = ALL_CONTENT.filter((c) => /未在项目中找到/.test(c.summary));
console.log(`  调用总数 ${spCalls.length}（content ${ALL_CONTENT.length} / name ${spCalls.length - ALL_CONTENT.length}）`);
console.log(`  content 有命中 ${ALL_CONTENT.length - ZEROS.length} 条，零命中 ${ZEROS.length} 条`);
const QUERIES = ALL_CONTENT.map((c) => String(c.args.query));   // 全部 content query（含零命中）
console.log('  零命中 query: ' + JSON.stringify(ZEROS.map((c) => c.args.query)));
if (!QUERIES.length) { console.log('\n（未取到真机 query，后续段跳过）'); process.exit(0); }

// ── 段② 零命中分型 ───────────────────────────────────────
console.log('\n══ 段② 零命中分型（多词 F1 vs 近义措辞差）══');
/** 逐词存在性：优先用"空白分隔的显式词"（对齐方案文档口径），无空白则用分词结果 */
const probeWords = (q) => {
  const segs = q.split(/\s+/).filter(Boolean);
  return segs.length > 1 ? segs : [...new Set(extractKeywords(q))];
};
const fileCount = (w) => FILES.filter(([, a]) => readLines(a).some((l) => l.includes(w))).length;
for (const z of ZEROS) {
  const q = String(z.args.query);
  const hasSpace = /\s/.test(q.trim());
  console.log(`  ${JSON.stringify(q)}  [${hasSpace ? '多词·F1' : '无空格·近义措辞差候选'}]`);
  console.log('     逐词命中文件数: ' + probeWords(q).map((w) => `${w}=${fileCount(w)}`).join('  '));
  console.log(`     整串命中文件数: ${fileCount(q)}`);
}

// ── 段③ A/B/C 对拍 ──────────────────────────────────────
console.log('\n══ 段③ 三策略对拍（零命中 / 前缀一致性 / 回退面 / 打满）══');
let z0 = 0, zA = 0, zC = 0, cPrefix = 0, cFell = 0, cFull = 0;
for (const q of QUERIES) {
  const o = strWhole(q), a = strA(q), c = strC(q);
  if (!o.hits.length) z0++; if (!a.hits.length) zA++; if (!c.hits.length) zC++;
  if (o.hits.every((h, i) => c.hits[i] && c.hits[i][0] === h[0])) cPrefix++;
  if (c.fellBack) cFell++; if (c.hits.length >= MAX_RESULTS) cFull++;
}
const T = QUERIES.length;
console.log(`  零命中：现状 ${z0} → 纯OR ${zA} → C ${zC}   （共 ${T} 条真机 content query）`);
console.log(`  C 前缀一致性（零精度退化）: ${cPrefix}/${T}`);
console.log(`  C 回退触发: ${cFell}   （理想 = 现状零命中数 ${z0}）`);
console.log(`  C 打满 ${MAX_RESULTS} 条: ${cFull}/${T}`);
console.log('  —— 纯 OR 精度退化实例（现状 → 纯OR）——');
for (const q of QUERIES) {
  const o = strWhole(q), a = strA(q);
  if (a.hits.length > o.hits.length) console.log(`     ${JSON.stringify(q)} ${o.hits.length} → ${a.hits.length}`);
}

// ── 段④ 词表 R0 vs R5（碎片噪声）────────────────────────
console.log('\n══ 段④ 回退词表：R0 extractKeywords vs R5 显式片段优先 ══');
const R0 = (q) => [...new Set(extractKeywords(q))];
const R5 = (q) => {
  const segs = q.split(/\s+/).filter(Boolean); const words = [];
  for (const s of segs) { if (hasCJK(s)) for (const w of extractKeywords(s)) words.push(w); else words.push(s); }
  if (segs.length > 1) for (const w of extractKeywords(q)) if (hasCJK(w)) words.push(w);
  return [...new Set(words)];
};
for (const z of ZEROS) {
  const q = String(z.args.query);
  const tk = q.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  console.log(`  ${JSON.stringify(q)}`);
  for (const [nm, fn] of [['R0', R0], ['R5', R5]]) {
    const terms = fn(q);
    const frag = terms.filter((w) => isAscii(w) && !tk.includes(w.toLowerCase()));
    const hits = scanAlt(terms, MAX_RESULTS);
    let noise = 0;
    for (const [, rel, ln] of hits) {
      const line = readLines(path.join(ROOT, rel))[ln - 1] || '';
      const real = terms.filter((w) => !frag.includes(w)).filter((w) => new RegExp(escapeRegExp(w), 'i').test(line));
      if (!real.length) noise++;
    }
    console.log(`     ${nm} terms=${JSON.stringify(terms)}`);
    console.log(`        命中 ${hits.length} 条 · 碎片词 ${JSON.stringify(frag)} · 纯碎片命中 ${noise}`);
  }
}
console.log('\n完成。以上数字即方案文档所引实测值。');
