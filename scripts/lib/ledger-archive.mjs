/**
 * 台账归档副本判定的**单点实现** —— 供 `verify-ledger-hygiene.mjs`（工作树语义）与
 * `verify-ledger-fold.mjs`（git 区间语义）共用。
 *
 * 为什么抽出来（2026-10-27）：折叠结清门要判「这条是否在归档里有副本」，而这是 hygiene
 * 早已反复订正过的一组启发式（下设三条血训）。照抄一份 = 第二真源，两处必然漂移 ⇒
 * 宁可多一个模块，也不复制逻辑。
 */

/**
 * 归档里是否存在该条目的副本。
 *
 * 为什么不能只认 `- **ID**` 一行（2026-10-26 实测假红）：`VERIFY-REALDEVICE-1`
 * 在归档里是 `## 2026-10-10 · VERIFY-REALDEVICE-1 真机验收形态 SSOT 沉淀（规则文件落地）`
 * ——按**章节标题**归档，没有 `- **ID**` 条目行 ⇒ 被误报「无副本」。
 * 故副本形态认两类：① 条目行 `- **ID**`；② 章节标题 `## … ID …`。
 * 反过来，**正文里顺带提及不算**（`TERM-FDBK-1` 只在别的条目正文被提到）⇒ 仍报，
 * 交人工确认——宁可留 1 条真人肉，也不要放宽到「提过就算」而让门失明。
 */
export function arcHasEntry(arc, id) {
  const esc = id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return (
    new RegExp(`^-\\s+\\*\\*${esc}\\*\\*`, 'm').test(arc) ||
    new RegExp(`^#{1,4}\\s.*${esc}`, 'm').test(arc)
  );
}

/**
 * 从「汇总指针」ID 里拆出子 ID。
 * 形如 `宿主已闭环项（UI-CONFIRM-P10 / P10B / …）` 是把一揽子收口项压成一行的批量指针，
 * 归档里落档的是**子项**而非这个汇总名，故按整串去归档找必假红。
 * 触发条件：ID 含 CJK 开括号 `（`（普通单条 ID 绝不含）。
 */
export function extractSubIds(id) {
  if (!/（/.test(id)) return [];
  const cleaned = id.replace(/（[^）]*）/g, ' ').replace(/\([^)]*\)/g, ' ');
  const toks = cleaned.split(/[\/·|，,、；：、「」\s]+/).filter(Boolean);
  return toks.filter((t) => /^[A-Za-z][A-Za-z0-9-]*(?:[-.]\d[\d.]*)?$/.test(t) && t.length >= 3);
}

/** 归档是否含某条目副本；汇总指针（含 CJK 括号的多子 ID）只要任一子 ID 有副本即有效。 */
export function arcHasEntryForId(arc, id) {
  if (arcHasEntry(arc, id)) return true;
  return extractSubIds(id).some((s) => arcHasEntry(arc, s));
}
