#!/usr/bin/env node
/**
 * 台账折叠结清门 —— 「折叠一个区之前，先确认没有条目被蒸发」
 *
 * 为什么存在（缺口 · 2026-10-26 实证）：
 *   台账归元（提交 `1b30669d`）把「内核 5.1.0 区 / 5.0.0 区 / 宿主 0.x 区」整区折叠为
 *   「版本索引」表的一行。那次自检的自信来自「104 个条目 ID 逐个回查、净丢失 0」，但它
 *   **只回查了还在册的标题 ID**——`rules-B2` 是因为有人在人工复读时发现它带「待迁」标记
 *   才被捞回来的，**差一点就随折叠永久消失**：
 *     折叠前：- **rules-B2** … ｜📌 待迁（2026-10-24 审计发现）：销项未入 5.0.0 发版归档…
 *     若不做补迁 ⇒ 归档里无任何副本，而主台账也没有它了 ⇒ **事实凭空蒸发**（无一处记载）。
 *
 *   根本原因 = **纪律是「人记得跑」而不是「机器必查」**。本门把它固化：任何从主台账消失的
 *   顶层条目 ID，**必须在 `tasks/archive/*.md` 里有副本**，否则判红。
 *
 * 与 `verify-ledger-hygiene.mjs` 的分工（勿重叠、勿合并）：
 *   hygiene = **工作树语义**（台账当前结构合不合纪律）；本门 = **git 区间语义**（这次改动
 *   **移走了什么**）。前者看不到「移走」这个动作，后者看不到结构本身，两者互补。
 *
 * 判据（窄口 —— 只拦一种形态）：
 *   取 `<base>` 版本与 `<head>` 版本的 `tasks/待完成任务.md`，各自解析**顶层条目 ID**
 *   （`- **ID**` 形态），差集 = 被移走的条目；每条必须能在任一 `tasks/archive/*.md`
 *   找到副本（判定逻辑复用 `lib/ledger-archive.mjs`，与 hygiene 同一份，不各写一份）。
 *
 * ⚠️ 为何不提供「允许逃逸名单」（2026-10-27 定案）：
 *   ID 被合并/改名也需要留痕（归档里加一行 `- **旧ID**` 或写进章节标题即可），否则
 *   「 disappeared 但说是合并了」就是不可验证的口头结论 ⇒ 一律判红，由人决定怎么留痕。
 *
 * 空集语义（fail-closed，同 `verify-ledger-receipt.mjs` 的教训）：
 *   任一端台账缺失 / 任一端条目解析为 0 ⇒ **判据失明比假绿更危险**，EXIT=1。
 *   差集为空 ⇒ 通过（本次改动没有移走任何顶层条目，确有此信息，非「查无可查」）。
 *
 * 用法：
 *   node scripts/verify-ledger-fold.mjs                       # HEAD~1 → 工作树（折叠后、提交前自查）
 *   node scripts/verify-ledger-fold.mjs --base=<ref>          # 指定基线（默认 HEAD~1）
 *   node scripts/verify-ledger-fold.mjs --base=A --head=B     # 复盘某个已发生的区间
 *   node scripts/verify-ledger-fold.mjs --since=origin/main   # pre-push 口径：待推区间的起点，终点=HEAD
 *   node scripts/verify-ledger-fold.mjs --self-test           # 自检：注入「消失且无副本」的变异
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arcHasEntryForId } from './lib/ledger-archive.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_REL = 'tasks/待完成任务.md';

/** 顶层条目首行：`- **ID** — …｜状态` ⇒ 只取 ID，不取缩进说明行。 */
function topLevelIds(text) {
  const ids = [];
  const re = /^-\s+\*\*(.+?)\*\*/gm;
  let m;
  while ((m = re.exec(text))) ids.push(m[1]);
  return ids;
}

function readArchiveFiles() {
  const dir = join(ROOT, 'tasks', 'archive');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));
}

/**
 * 纯函数核心（供自检直接调用，不经 git）：比较两份台账文本，返回「消失且无归档副本」的清单。
 */
export function auditFold({ baseText, headText, archives }) {
  const base = topLevelIds(baseText);
  const head = new Set(topLevelIds(headText));
  const gone = base.filter((id) => !head.has(id));
  const lost = gone.filter((id) => !archives.some((a) => arcHasEntryForId(a.text, id)));
  return {
    baseCount: new Set(base).size,
    headCount: head.size,
    goneBaseCount: gone.length,
    gone,
    lost,
  };
}

function gitShow(ref) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', 'show', `${ref}:${LEDGER_REL}`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function run() {
  // `--since` = pre-push 口径（同 `verify-ledger-receipt.mjs`）：比较**待推区间**的首尾，
  // 终点取 HEAD 的已提交版本；不传则默认 HEAD~1 → 工作树（给「折叠完还没提交」的自查用）。
  // ⚠️ 为什么 local-ci 必须显式传：只查 HEAD~1 意味着 multi-commit push 时只挡住最后一笔，
  //    中间几笔照漏 ⇒ 门卖出的是有限保证，不能用 bare 默认值上流水线。
  const since = argValue('since');
  const base = argValue('base') ?? since ?? 'HEAD~1';
  const head = argValue('head') ?? (since ? 'HEAD' : null);
  const baseText = gitShow(base);
  const headText = head ? gitShow(head) : readFileSync(join(ROOT, LEDGER_REL), 'utf8');

  const hr = head ? `--head=${head}` : '工作树';
  if (baseText === null) {
    console.error(`❌ [ledger-fold] 无法读取 ${base}:${LEDGER_REL} —— 判据失明，EXIT=1`);
    process.exit(1);
  }
  if (headText === null) {
    console.error(`❌ [ledger-fold] 无法读取 ${hr} 的台账 —— 判据失明，EXIT=1`);
    process.exit(1);
  }

  const archives = readArchiveFiles();
  if (archives.length === 0) {
    console.error('❌ [ledger-fold] tasks/archive/ 无 md 文件 —— 判据失明，EXIT=1');
    process.exit(1);
  }

  const r = auditFold({ baseText, headText, archives });
  if (r.baseCount === 0 || r.headCount === 0) {
    console.error(
      `❌ [ledger-fold] 条目解析为 0（base=${r.baseCount} / head=${r.headCount}）—— 判据失明，EXIT=1`,
    );
    process.exit(1);
  }

  console.log(
    `\n[ledger-fold] ${base} → ${hr}：移走顶层条目 ${r.gone.length} 条（${r.baseCount} → ${r.headCount}）`,
  );

  if (r.lost.length === 0) {
    console.log(`✅ [ledger-fold] 折叠结清：${r.gone.length} 条逐个在 archive/ 找到副本，净丢失 0`);
    return 0;
  }

  console.log(`\n❌ [ledger-fold] 折叠遗失：${r.lost.length} 条在主台账消失且归档无副本`);
  for (const id of r.lost.slice(0, 40)) console.log(`   - ${id}`);
  if (r.lost.length > 40) console.log(`   … 另有 ${r.lost.length - 40} 条`);
  console.log(
    '\n   处置：把该 ID 补进对应版本的 `tasks/archive/<version>-<kernel|host>.md`\n' +
      '   （加 `- **ID** — …` 条目行，或写进章节标题；合并/改名也要留痕，本门不接受口头结论）。',
  );
  return 1;
}

/** 自检：注入「消失且无归档副本」的变异，确认门真的会红。 */
function selfTest() {
  const baseText = [
    '# 台账',
    '',
    '- **KEEP-1** — 留守｜⏳ 观察',
    '- **GONE-1** — 被折叠｜✅ 已落地',
    '',
  ].join('\n');
  const headText = ['# 台账', '', '- **KEEP-1** — 留守｜⏳ 观察', ''].join('\n');
  const noArchive = [{ file: 'x.md', text: '# x\n' }];
  const withArchive = [{ file: 'x.md', text: '# x\n\n- **GONE-1** — 副本｜✅\n' }];

  const bad = auditFold({ baseText, headText, archives: noArchive });
  const good = auditFold({ baseText, headText, archives: withArchive });

  const ok1 = bad.lost.length === 1 && bad.lost[0] === 'GONE-1';
  const ok2 = good.lost.length === 0 && good.gone.length === 1;
  console.log(`  ${ok1 ? '✅' : '❌'} 消失且无副本 ⇒ 被捕获（lost=${bad.lost.join(',')}）`);
  console.log(
    `  ${ok2 ? '✅' : '❌'} 消失但有副本 ⇒ 放行（gone=${good.gone.length} / lost=${good.lost.length}）`,
  );
  console.log(ok1 && ok2 ? '\n✅ 自检通过：折叠遗失可被捕获' : '\n❌ 自检失败：存在失明判据');
  return ok1 && ok2 ? 0 : 1;
}

process.exit(process.argv.includes('--self-test') ? selfTest() : run());
