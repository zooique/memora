/**
 * 项目内容搜索的「放宽词表」构造 —— R5 · 显式片段优先（SEARCH-1 · D1b）
 *
 * 用途：`search_project mode=content` 采用「精确优先 + 零命中回退」（D1）——先按整串字面量搜，
 * 整串零命中才用本函数产出的词表做一次 OR 放宽。词表由内核产出、宿主执行（判定留在宿主）。
 *
 * 为什么不能直接复用 `extractKeywords(query)`（记 R0）——实测反例：
 * ```
 * extractKeywords("技术栈 FastAPI Next.js PostgreSQL")
 *   → ["技术","fastapi","next.js","postgresql","next","js"]
 *                                          ^^^^^^ ^^^^  原查询中不存在的碎片
 * ```
 * 根因：`extractKeywords` 的英文补充 `input.match(/[a-z]{2,}/gi)` 在 `.` 处切断 `Next.js`；
 * 而碎片 `js` 会命中一切 `JSON` / `Node.js` 写法 —— 实测 20 条放宽命中里 **10 条纯靠 `js` 命中**
 * （假阴性换成假阳性，同样违反诚实化）。R5 把「空白分隔的片段」当一等公民，碎片噪声 10/20 → 0/20。
 *
 * R5 不变量（测试断言对象）：
 *   1. 空白分隔片段是一等公民：**不含 CJK 的片段原样保留**（`Next.js` 仍是 `Next.js`，不二次切分）；
 *   2. 含 CJK 的片段走内核分词 SSOT（`extractKeywords`），**不新造第二套分词器**；
 *   3. 词表中**不得出现原查询里不存在的 ASCII 碎片**（`next` / `js`）。
 */
import { extractKeywords } from '@/memory/keywordsTouch.js';

/** 含 CJK（汉字/扩展区 + CJK 标点 + 全角形式）的片段 → 需分词；其余（ASCII、拉丁扩展）原样保留 */
const CONTAINS_CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

/**
 * 最短词长（对齐 `extractKeywords` 自己的 `length >= 2` 守卫，同一标准不再造第二条）
 *
 * 为什么必须挡单字符 ASCII 片段：`"a b"` 会产出 `a|b` 级正则，命中几乎每一行 —— 放宽变成噪声。
 */
const MIN_TERM_LEN = 2;

/**
 * 构造内容搜索的放宽词表（R5 · 显式片段优先）
 *
 * @param query 原始查询串（LLM 传入，可能多词/含分隔符）
 * @returns 去重后的词表；**不含**整串本身（整串是「精确优先」那一轮用的，重复下发无意义）
 *
 * @example
 * buildSearchTerms('技术栈 FastAPI Next.js PostgreSQL')
 *   // → ['技术', 'FastAPI', 'Next.js', 'PostgreSQL']   （无 next / js 碎片）
 * buildSearchTerms('核心|愿景')
 *   // → ['核心', '愿景']   （分隔符写法与空格写法同解，见分词 SSOT）
 */
export function buildSearchTerms(query: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  // 大小写不敏感去重（匹配本就是大小写不敏感的），但**保留首次出现的写法**供文案展示
  // （`Next.js` 比 `next.js` 更像原查询；`TODO todo` 不应产出两条等价分支）
  const push = (term: string): void => {
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(term);
  };

  for (const segment of query.split(/\s+/).filter(Boolean)) {
    if (CONTAINS_CJK.test(segment)) {
      // 含 CJK：交给内核分词原语（标点/分隔符由它切）
      for (const term of extractKeywords(segment)) push(term);
    } else if (segment.length >= MIN_TERM_LEN) {
      // 纯 ASCII / 拉丁扩展：原样保留，不二次切分（保 `Next.js` 完整）
      push(segment);
    }
  }
  return terms;
}
