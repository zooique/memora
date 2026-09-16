/**
 * 分词器行为实测（S1 前置钉死 · 2026-09-15）
 *
 * 目的：S1 实现 buildSearchTerms(R5) 前，先确认内核分词器对「无空格混合串」的真实行为，
 *       避免实现出来的 R5 与方案文档 §六.1 验收（核心|愿景 / 核心 愿景 / 核心/愿景 三种写法同结果）不符。
 *
 * 运行：node tasks/探针-分词与R5行为-20260915.cjs
 * 依赖：memora dist/（真分词器）。只读，不写项目。
 */
const KERNEL_RECALL = 'F:/zooique/memora/dist/memory/recall.js';
const KERNEL_SEG = 'F:/zooique/memora/dist/utils/segmenter.js';

const { extractKeywords } = require(KERNEL_RECALL);
const seg = require(KERNEL_SEG);
console.log('segmenter 导出:', Object.keys(seg).join(', '));
const { segmentLower, segmentText, STOPWORDS } = seg;

const hasCJK = (s) => /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(s);
const isAscii = (s) => /^[\x20-\x7e]+$/.test(s);

/** R5 · 与 tasks/探针-SEARCH-1-验证-20260915.cjs 段④ 逐字一致 */
const R5 = (q) => {
  const segs = q.split(/\s+/).filter(Boolean);
  const words = [];
  for (const s of segs) {
    if (hasCJK(s)) for (const w of extractKeywords(s)) words.push(w);
    else words.push(s);
  }
  if (segs.length > 1) for (const w of extractKeywords(q)) if (hasCJK(w)) words.push(w);
  return [...new Set(words)];
};

const CASES = [
  '核心|愿景',
  '核心/愿景',
  '核心 愿景',
  '核心、愿景',
  '技术栈',
  '技术栈 FastAPI Next.js PostgreSQL',
  '读者会体验',
  '一、这个项目到底要做什么',
  'TODO',
  '**/*.ts',
  'Next.js',
  'APIKey',
];

console.log('\n══ 分词器原始行为 ══');
for (const q of CASES) {
  console.log(`query = ${JSON.stringify(q)}`);
  console.log(`   segmentText      = ${JSON.stringify(segmentText(q))}`);
  console.log(`   segmentLower     = ${JSON.stringify(segmentLower(q))}`);
  console.log(`   extractKeywords  = ${JSON.stringify(extractKeywords(q))}`);
  console.log(`   hasCJK=${hasCJK(q)} isAscii=${isAscii(q)}`);
  console.log(`   R5               = ${JSON.stringify(R5(q))}`);
}

console.log('\n══ STOPWORDS 是否含 会 / 什么 ══');
for (const w of ['会', '什么', '这个', '到底']) console.log(`   ${w} → ${STOPWORDS.has(w)}`);
