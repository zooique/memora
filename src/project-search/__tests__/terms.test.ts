/**
 * 放宽词表构造测试（「显式片段优先」）
 *
 * 这三条是**不变量**（方案文档「显式片段优先」节），不变量被违反就是带伤回潮：
 *   1. 空白分隔片段是一等公民：不含 CJK 的片段**原样保留、不二次切分**（`Next.js` 不得变成 `next` + `js`）；
 *   2. 含 CJK 的片段走内核分词 SSOT（`extractKeywords`）——本文件用"同源断言"把这条钉死；
 *   3. 词表中**不得出现原查询里不存在的 ASCII 碎片**。
 *
 * 背景（实测反例）：`extractKeywords` 的英文补充 `/[a-z]{2,}/gi` 会在 `.` 处切断 `Next.js`，
 * 而碎片 `js` 会命中一切 `JSON` / `Node.js` 写法 —— 20 条放宽命中里 10 条纯靠 `js` 命中，
 * 即"假阴性换成了假阳性"。
 */
import { describe, it, expect } from 'vitest';
import { extractKeywords } from '@/memory/keywordsTouch.js';
import { buildSearchTerms } from '@/project-search/terms.js';

describe('buildSearchTerms（R5 · 显式片段优先）', () => {
  it('不变量 1 + 3：ASCII 片段原样保留，且不产生原查询中不存在的碎片', () => {
    const terms = buildSearchTerms('技术栈 FastAPI Next.js PostgreSQL');
    // 不变量 3：`next` / `js` 是 extractKeywords 切出来的碎片，必须不出现
    expect(terms).not.toContain('js');
    expect(terms).not.toContain('next');
    // 不变量 1：`Next.js` 整体保留
    expect(terms).toContain('Next.js');
    expect(terms).toContain('FastAPI');
    expect(terms).toContain('PostgreSQL');
    // 锁定实测产出（方案文档 §四·D1b 的样例）——分词器若变动，此处会响
    expect(terms).toEqual(['技术', 'FastAPI', 'Next.js', 'PostgreSQL']);
  });

  it('单段 ASCII 查询不被切开（`Next.js` 不是 `next` + `js`）', () => {
    expect(buildSearchTerms('Next.js')).toEqual(['Next.js']);
    // 对照组：内核分词器本身确实会切（这就是不能直接复用它当词表的原因）
    expect(extractKeywords('Next.js')).toEqual(['next.js', 'next', 'js']);
  });

  it('不变量 2：含 CJK 的片段与内核分词 SSOT 同源', () => {
    // 单段纯 CJK：词表必须**逐字等于** extractKeywords 的输出（证明没新造第二套分词器）
    for (const query of ['读者会体验', '一、这个项目到底要做什么', '技术栈']) {
      expect(buildSearchTerms(query)).toEqual(extractKeywords(query));
    }
  });

  it('分隔符写法等价：`核心|愿景` / `核心 愿景` / `核心/愿景` 得到同一词表', () => {
    // 验收 §六.1 的前提：三种写法在宿主侧会展开成同一个 OR 正则
    const expected = ['核心', '愿景'];
    expect(buildSearchTerms('核心|愿景')).toEqual(expected);
    expect(buildSearchTerms('核心 愿景')).toEqual(expected);
    expect(buildSearchTerms('核心/愿景')).toEqual(expected);
    expect(buildSearchTerms('核心、愿景')).toEqual(expected);
  });

  it('单字符 ASCII 片段被滤（否则 `a b` 会退化成命中几乎每一行的 `a|b`）', () => {
    expect(buildSearchTerms('a b 核心')).toEqual(['核心']);
    expect(buildSearchTerms('a')).toEqual([]);
  });

  it('大小写不敏感去重，保留首次出现的写法（供文案展示）', () => {
    expect(buildSearchTerms('TODO todo')).toEqual(['TODO']);
    expect(buildSearchTerms('tech Tech')).toEqual(['tech']);
  });

  it('多段查询的词表 = 片段集合（与整串不等价 → 放宽轮才会被触发）', () => {
    const terms = buildSearchTerms('FastAPI PostgreSQL');
    expect(terms).toEqual(['FastAPI', 'PostgreSQL']);
    // 与整串不等价：调用方的剔除守卫（`t.toLowerCase() !== query.trim().toLowerCase()`）不会把它剔空
    expect(terms.map((t) => t.toLowerCase())).not.toContain('fastapi postgresql');
  });

  it('空串 / 纯空白返回空词表（不抛错）', () => {
    expect(buildSearchTerms('')).toEqual([]);
    expect(buildSearchTerms('   ')).toEqual([]);
  });
});
