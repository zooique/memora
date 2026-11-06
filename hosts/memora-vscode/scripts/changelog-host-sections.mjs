/**
 * 根 CHANGELOG「宿主区」解析唯一真源（生成器与新鲜度闸共用）
 *
 * 为什么独立成模块：`gen-changelog.mjs`（写产物）与 `verify-changelog-fresh.mjs`（判产物）
 * 必须用**同一条**抽取规则——若各写一份，闸门就可能按另一套口径判绿，而产物按这套口径写成
 * 另一种形态（同族教训：同一事实两处实现必漂移，且没有测试会红）。
 *
 * 区标题判据：`## [x.y.z] · <date> · 宿主`（`· 宿主` 是根文件既有的轴标记，ADR-033）；
 * `[Unreleased]` 同样计入（未发版期宿主条目就住在这个块里）。
 */

/** 宿主区标题（`## [数字版本|Unreleased] … · 宿主`） */
const HOST_SECTION_RE = /^## \[(?:\d+\.\d+\.\d+|Unreleased)\][^\n]*·\s*宿主\s*$/;

/**
 * 轴一致性守卫：任何 `### …（宿主）` 小节都必须落在 `· 宿主` 的 `##` 块内。
 *
 * 为什么需要：`### Changed（宿主）` 若寄生在内核区，抽取器仍能从老版本块抽到内容并判绿
 * ⇒ 新写的宿主条目被静默当成内核条目。
 *
 * @param {string} text 根 CHANGELOG 全文
 * @returns {{ line: number; text: string }[]} 寄生的小节（行号为 1 基）
 */
export function findMisnestedHostSubsections(text) {
  const lines = text.split(/\r?\n/);
  /** 当前所在 `##` 块是否宿主块 */
  let inHostBlock = false;
  const offenders = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (/^## /.test(trimmed)) {
      inHostBlock = HOST_SECTION_RE.test(trimmed);
      return;
    }
    if (!inHostBlock && /^### .*（宿主）/u.test(trimmed)) {
      offenders.push({ line: i + 1, text: trimmed });
    }
  });
  return offenders;
}

/**
 * 抽取所有宿主区块（含标题行到下一个 `^## ` 之前的内容，原样保留）。
 * @param {string} text 根 CHANGELOG 全文
 * @returns {string[]} 宿主区块数组（按文件顺序）
 */
export function extractHostSections(text) {
  const lines = text.split(/\r?\n/);
  const starts = [];
  lines.forEach((line, i) => {
    if (HOST_SECTION_RE.test(line.trim())) starts.push(i);
  });
  const blocks = [];
  for (const start of starts) {
    let end = start + 1;
    while (end < lines.length && !/^## /.test(lines[end])) end++;
    blocks.push(lines.slice(start, end).join('\n').trimEnd());
  }
  return blocks;
}

/**
 * 收集文本里所有 `### Breaking…` 小节的标题行（trim 后精确比较用）。
 *
 * 只取标题不取正文：新鲜度判据要回答的是「用户能不能看到 Breaking 段存在」——
 * 标题是市场页锚点；正文逐字比对会把「重排版 / 改标点」误判成缺段。
 *
 * @param {string} text 任意 CHANGELOG 文本
 * @returns {string[]} Breaking 标题行（按出现顺序）
 */
export function collectBreakingHeadings(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^### Breaking/.test(line));
}
