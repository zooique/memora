#!/usr/bin/env node
/**
 * 台账结构卫生检查 —— 归档纪律的**四态分诊**从人工闸升级为机检
 *
 * 为什么存在（缺口 · 2026-10-26 实证）：
 *   归档脚本 `.trae/skills/memora-kernel-release/scripts/archive-kernel-release.mjs`
 *   按 `--ids` **人肉白名单**跑，补漏靠纪律里的一条「apply 后 commit 前逐条三态分诊」——
 *   **人工闸不是闸门**：`ARCH-DRAIN-1`（2026-10-23）补过 9 条，台账继续编辑就又漂回去。
 *   实测：0.2.0 区 140 个 ID，`archive/0.2.0-host.md` 里只有 40 个有副本。
 *
 *   2026-10-26 观察区归位迁移又暴露两条**无任何门拦截**的回归：
 *     ① 条目被切走后源区留下 **22 处连续空行**（最大 14 行），迁移前该指标为 0；
 *     ② 已发布区可**整区滞留**（5.1.0 171 行 / 5.0.0 111 行），违反纪律 6「发版整区迁入归档」。
 *
 * 判据（**工作树语义**，与 `verify-ledger-receipt.mjs` 的 git 区间语义不重叠）：
 *   本闸扫 `tasks/待完成任务.md` 的**当前内容**，不是提交区间 ⇒
 *   **不存在「推送后区间为空 = 恒绿假象」**（那是 ledger:receipt 的 ⚠️ 空集语义坑）。
 *
 *   ① **欠账态**：条目标题含收口标记、但**无 `archive/` 指针** ⇒ 已收口却没归档（纪律 41 行判据）。
 *   ② **假指针态**：标题含 `archive/…` 指针、但该归档文件里**查不到该条目 ID** —— 「加指针」
 *      被当成「已归档」的完成标记是最阴的一类：手工补指针只改标题行，**正文不会自动删除**，
 *      归档里也可能**根本无副本**。实证：0.2.0 区 10 条标指针条目里 9 条是假指针。
 *   ③ **开放态错置**：观察/挂起态条目出现在**已发布区** —— 纪律 3「观察项留主台账」
 *      ≠「留在版本区」；观察项永不随发版归档 ⇒ 留在已发布区会让该区**永远清不空**。
 *   ④ **格式态**：连续 ≥2 空行 —— 机械搬移条目后的空洞，无语义、纯膨胀。
 *
 * 为什么是告警档（required:false 挂 local-ci，见 scripts/local-ci.mjs）：
 *   「存量不清零前不建闸」同族教训（format:check 步的注释）——当前 0.2.0 区遗留 7 条欠账
 *   + 若干假指针，若直接建硬闸，第一次 pre-push 就会被拦 ⇒ 门必然被绕过。
 *   **升档条件（写明，勿凭感觉）**：①②③④ 四类存量**全部清零**后，把 local-ci 的
 *   `ledger:hygiene` 步 `required` 改 true。届时任一新命中 = 真回归，可安全 fail。
 *
 * 空集语义（fail-closed）：
 *   台账缺失 / 区解析为 0 / 条目解析为 0 ⇒ **判据失明比假绿更危险**，一律判红。
 *
 * 用法：
 *   node scripts/verify-ledger-hygiene.mjs            # 分诊并列出命中
 *   node scripts/verify-ledger-hygiene.mjs --self-test # 自检：注入变异确认四类判据都能红
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_REL = 'tasks/待完成任务.md';

/**
 * 收口标记 —— 命中即视为「该归档」（与 archive-discipline.md 的「已关闭」口径同族）。
 *
 * 🔴 **不含「已评估」**（2026-10-26 实测冲突）：`archive/5.0.0-kernel.md` 文件头明写
 *   「开放项（观察 / 进行中 / 未修 / **已评估**）一律留主台账」。首版判据把「已评估」
 *   当收口 ⇒ `MEM-GOV-1`（🟢 已评估）被判欠账、差点归档，**直接违反归档纪律本身**。
 */
const CLOSED_RE = /✅|❌|🟢|已销项|已落地|已关闭|已核\b|已解决|已执行|已迁出|证伪|已升档|已升入/;

/**
 * 收口的**否定条件** —— 命中即**不**算收口（2026-10-26）。
 * 只删 `CLOSED_RE` 里的「已评估」字样不够：`MEM-GOV-1` 标题是 `🟢 已评估`，`🟢` 仍命中
 * ⇒ 换个写法照样进欠账。故用显式否定：`🟢 已评估` 属归档纪律明列的「留主台账」开放项。
 */
const NOT_CLOSED_RE = /已评估/;

/**
 * 开放态的**段首**判据 —— 只看 `｜` 分隔后的状态段开头。
 *
 * 为什么不用整行匹配（2026-10-26 实测假红）：`PR-SWITCH-1` 标题是
 * `✅ 已落地 …（形态定案后升级为「建议删」，待拍板）→ 见 archive/…`，整行含「待拍板」
 * ⇒ 被误判开放态，但它**已归档**。`MEM-EVENT-1` 的 `⏳ 待 5.0.0 发版` 同理——
 * 那是发版前的临时标记，版本已发布后属历史态，不是「待办」。
 * 段首匹配只认状态段真正以开放标记起头的形态（`｜⏸ 观察`、`｜⏳ 远期`）。
 *
 * 🔴 **`🔄` 必须算开放态**（2026-10-26 补，此前漏判）：`🔄` 在台账里表示
 *   「进行中 / 待查 / 待处置 / 已定档但方案在推进」——**全都是未闭合**。实证：
 *   `D1-MCP 🔄 已定档`、`ENV-COV-1 🔄 待查`、`㉘ 🔄 待处置（P0 须发版前修）`、
 *   `LOOP-CONTRACT-1 🔄 进行中（仅剩 ④ 缓办）`。首版判据漏了它 ⇒ 5.1.0 区 151 行
 *   活条目被静默当成「可归档」，照单执行**会销毁在途信息**。
 *
 * 🔴 **必须写成「交替 + u 标志」，不能写成字符类 `[⏸⏳📌🟡👁🔵]`**（2026-10-26 实测血训）：
 *   📌/🟡/👁/🔵 是 U+1F4CC 等**非 BMP 字符**，在字符类里会被拆成**代理对的两个 code unit**
 *   ⇒ 字符类实际含裸 `D83D` ⇒ `｜🔄`(D83D DD04) / `｜🟢`(D83D DFE2) / `｜📝` / `｜🗄`
 *   **全部因高代理相同而假命中**（一轮刷出 22 处，其中 7+ 处是 🔄/🟢/📝/🗄 的假红）。
 *   写 `u` 标志或改用非捕获交替 `(?:⏸|⏳|…)`，按**码点**而非 code unit 匹配。
 */
const OPEN_SEG_RE = /｜\s*(?:⏸|⏳|📌|🟡|👁|🔵|🔄)/u;

/** 已发布区的标题判据 */
const RELEASED_RE = /已发布|已发版|已定案归档/;

const MAX_PRINT = 20;

function parseSections(lines) {
  const heads = [];
  lines.forEach((l, i) => {
    if (/^## /.test(l)) heads.push({ title: l.replace(/^##\s*/, ''), start: i });
  });
  return heads.map((h, k) => ({
    ...h,
    end: k + 1 < heads.length ? heads[k + 1].start : lines.length,
  }));
}

function parseItems(lines, sec) {
  const raw = [];
  let cur = null;
  for (let i = sec.start; i < sec.end; i++) {
    const m = /^- \*\*(.+?)\*\*/.exec(lines[i]);
    if (m) {
      if (cur) cur.end = i;
      cur = { id: m[1], head: lines[i], start: i, end: sec.end };
      raw.push(cur);
    }
  }
  if (cur) cur.end = sec.end;
  raw.forEach((c) => {
    let e = c.end;
    while (e > c.start && lines[e - 1].trim() === '') e--;
    c.end = e;
  });
  return raw.map((c) => ({ id: c.id, head: c.head, start: c.start, lines: c.end - c.start }));
}

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
function arcHasEntry(arc, id) {
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
function extractSubIds(id) {
  if (!/（/.test(id)) return [];
  const cleaned = id.replace(/（[^）]*）/g, ' ').replace(/\([^)]*\)/g, ' ');
  const toks = cleaned.split(/[\/·|，,、；：、「」\s]+/).filter(Boolean);
  return toks.filter((t) => /^[A-Za-z][A-Za-z0-9-]*(?:[-.]\d[\d.]*)?$/.test(t) && t.length >= 3);
}

/** 归档是否含某条目副本；汇总指针（含 CJK 括号的多子 ID）只要任一子 ID 有副本即有效。 */
function arcHasEntryForId(arc, id) {
  if (arcHasEntry(arc, id)) return true;
  return extractSubIds(id).some((s) => arcHasEntry(arc, s));
}

/**
 * 从标题行里取「归档指针」目标。
 *
 * 真实归档指针只有两种形态：
 *   ① markdown 链接目标：`见 [文本](./archive/x.md)` / `见 [tasks/archive/x.md](./archive/x.md)`
 *   ② 裸引用且紧跟「见」：`→ 见 tasks/archive/x.md`
 *
 * ⚠️ 行内散文引用（如 `(见 \`archive/completed-history.md\`「…」节)`）描述「该归档里的某一节」，
 *    不是「本条目归档于此处」的指针，必须排除——否则会误把散文文件名当指针目标
 *    （实测 TERM-FDBK-1 因此假红：散文 `archive/completed-history.md` 抢在真实指针前）。
 *    散文引用的 archive 名被反引号包裹，故「见」与 `archive` 之间夹着反引号，bare 形态正则自然不匹配。
 */
function pointerFile(head) {
  // ① 链接目标优先（真实指针恒在此）：`（./archive/x.md）` 或 `（archive/x.md）`
  const link = /\]\((\.?\/?archive\/[A-Za-z0-9._\/-]+\.md)\)/.exec(head);
  if (link) return link[1].replace(/^\.\//, '').replace(/^tasks\//, '');
  // ①b 链接文本含 archive 名（自检注入格式 `见 [archive/x.md](#x)`）
  const linkText = /见\s+\[[^\]]*?(archive\/[A-Za-z0-9._\/-]+\.md)\]/.exec(head);
  if (linkText) return linkText[1].replace(/^\.\//, '').replace(/^tasks\//, '');
  // ② 裸引用：`见` 后紧跟（可选 tasks/）`archive/x.md`，且非反引号包裹
  const bare = /见\s+(?:tasks\/)?archive\/[A-Za-z0-9._\/-]+\.md/.exec(head);
  if (bare) {
    const m = /archive\/[A-Za-z0-9._\/-]+\.md/.exec(bare[0]);
    return m ? m[0] : null;
  }
  return null;
}

function hasBlankRuns(lines) {
  const runs = [];
  let run = 0;
  lines.forEach((l, i) => {
    if (l.trim() === '') run++;
    else {
      if (run >= 2) runs.push({ end: i, n: run });
      run = 0;
    }
  });
  return runs;
}

function diagnose(text) {
  const lines = text.split(/\r?\n/);
  const sections = parseSections(lines);
  const arcCache = new Map();
  const readArc = (rel) => {
    if (!arcCache.has(rel)) {
      const p = join(ROOT, 'tasks', rel);
      arcCache.set(rel, existsSync(p) ? readFileSync(p, 'utf8') : null);
    }
    return arcCache.get(rel);
  };

  const debt = [];
  const fake = [];
  const misplaced = [];
  let itemTotal = 0;
  const releasedSections = [];

  for (const sec of sections) {
    const items = parseItems(lines, sec);
    itemTotal += items.length;
    const released = RELEASED_RE.test(sec.title);
    if (released) {
      releasedSections.push({ title: sec.title, items: items.length, lines: sec.end - sec.start });
    }
    for (const it of items) {
      const ptr = pointerFile(it.head);

      // ② 假指针：**只在已发布区判**。观察区 / 未发布区 / 非待办区的条目本就不该有指针，
      //    在那里判「归档无副本」是噪音（实测：观察区 `rules-B2` 被误判）。
      if (released && ptr) {
        const arc = readArc(ptr);
        if (arc === null) {
          fake.push({ ...it, sec: sec.title, why: `指针目标不存在：${ptr}` });
        } else if (!arcHasEntryForId(arc, it.id)) {
          fake.push({ ...it, sec: sec.title, why: `归档 ${ptr} 无该条目副本` });
        }
      }

      // ① 欠账：**只在已发布区判**。0.3.0（Unreleased）区与观察区的收口条目按纪律
      //    本就留在主台账（纪律 3、纪律 6 的前提是「已发布」），在那里报欠账 = 假红
      //    （实测：H0-1 / S1 / T4-FOLD-1 / 明确不推进区的 WRITE-APPROVAL-1 全被误判）。
      //    注意**开放态优先**：`LOOP-CONTRACT-1` 是 `🔄 进行中（①②③ 已落地，仅剩 ④ 缓办）`，
      //    既含「已落地」又是未闭合 ⇒ 只报错置、不报欠账（未闭合的先归位，不催归档）。
      if (
        released &&
        !ptr &&
        !OPEN_SEG_RE.test(it.head) &&
        !NOT_CLOSED_RE.test(it.head) &&
        CLOSED_RE.test(it.head)
      ) {
        debt.push({ ...it, sec: sec.title });
      }

      // ③ 开放态错置：已发布区 + 状态段以开放标记起头 + **无归档指针**。
      //    有指针者视为「已归档的历史态」，不再要求迁出（见 OPEN_SEG_RE 注释）。
      if (released && !ptr && OPEN_SEG_RE.test(it.head)) {
        misplaced.push({ ...it, sec: sec.title });
      }
    }
  }

  const blanks = hasBlankRuns(lines);
  return { sections, itemTotal, debt, fake, misplaced, releasedSections, blanks, lines };
}

function report(r) {
  const problems = [];
  if (r.debt.length) problems.push(['①欠账', r.debt]);
  if (r.fake.length) problems.push(['②假指针', r.fake]);
  if (r.misplaced.length) problems.push(['③开放态错置', r.misplaced]);
  if (r.blanks.length) problems.push(['④连续空行', r.blanks]);

  console.log(
    `\n[ledger-hygiene] 台账结构分诊：${r.sections.length} 区 / ${r.itemTotal} 条目 / ${r.lines.length} 行`,
  );
  console.log(
    '  已发布区：' +
      (r.releasedSections.length
        ? r.releasedSections
            .map((s) => `${s.title.slice(0, 18)} ${s.lines}行/${s.items}条`)
            .join(' · ')
        : '(无)'),
  );

  if (problems.length === 0) {
    console.log('✅ [ledger-hygiene] 四态分诊全部通过（欠账 0 / 假指针 0 / 错置 0 / 连续空行 0）');
    return 0;
  }

  for (const [label, list] of problems) {
    console.log(`\n❌ ${label}：${list.length} 处`);
    for (const h of list.slice(0, MAX_PRINT)) {
      if (h.n !== undefined) {
        console.log(`   行${h.end - h.n + 1}..${h.end}  ${h.n} 个连续空行`);
      } else {
        console.log(
          `   行${h.start + 1}  [${h.id.slice(0, 30)}]  ${h.lines}行  ${h.why ?? h.sec.slice(0, 24)}`,
        );
      }
    }
    if (list.length > MAX_PRINT) console.log(`   … 另有 ${list.length - MAX_PRINT} 处`);
  }
  console.log(
    '\n   处置：①②③ 见 `.trae/skills/memora-kernel-release/references/archive-discipline.md`；' +
      '\n   ④ 连续空行压成 1 行（写盘前须断言非空行序列不变）。' +
      '\n   本闸当前为告警档（local-ci required:false），四类存量清零后方可升硬闸。',
  );
  return 1;
}

/**
 * 自检：注入四类变异，确认判据**确实能捕获新命中**。
 *
 * ⚠️ 为什么用「注入前后差值」而不是「注入后 > 0」（2026-10-26 实测教训）：
 *   首版只断言 `命中数 > 0`，四类全部返回 41 —— 那是**基线存量**的数字，
 *   说明注入根本没生效、或判据根本没看见新东西，**门建了却失明，而自检还是绿的**。
 *   判据：① 注入后文本必须真的变了（`assertApplied`）；② 注入的探针 ID 必须出现在
 *   对应类别的命中里，且基线不含它。两条都过才算该判据有效。
 */
function selfTest() {
  const base = readFileSync(join(ROOT, LEDGER_REL), 'utf8');
  const baseR = diagnose(base);
  const idsOf = (list) => new Set(list.map((x) => x.id));

  // 注入锚点 = 观察区标题（2026-10-26 台账归元后，主台账不再常驻「已发布版本区」⇒
  // 自检必须**自建**一个已发布区，否则 ①②③ 判据无投放面 ⇒ 自检会因「锚点不存在」失明）
  const anchor = base.includes('## 观察 / 待拍板') ? '## 观察 / 待拍板' : null;
  if (!anchor) {
    console.error('❌ 自检锚点 `## 观察 / 待拍板` 不存在，无法注入 —— 自检前提失效');
    return 1;
  }
  // 自建已发布区标题（RELEASED_RE 命中「已发布」），供 ①②③ 探针落位
  const probeSection = '## ZZ-RELEASED 自检注入（已发布）';

  const cases = [
    {
      label: '①欠账',
      probe: 'ZZ-DEBT-1',
      mutate: (t) =>
        t.replace(
          anchor,
          `${probeSection}\n\n- **ZZ-DEBT-1** — 自检注入｜✅ 已落地（无指针）\n\n${anchor}`,
        ),
      pick: (r) => idsOf(r.debt),
    },
    {
      label: '②假指针',
      probe: 'ZZ-FAKE-1',
      mutate: (t) =>
        t.replace(
          anchor,
          `${probeSection}\n\n- **ZZ-FAKE-1** — 自检注入 → 见 [archive/0.2.0-host.md](#x)\n\n${anchor}`,
        ),
      pick: (r) => idsOf(r.fake),
    },
    {
      label: '③开放态错置',
      probe: 'ZZ-OPEN-1',
      mutate: (t) =>
        t.replace(anchor, `${probeSection}\n\n- **ZZ-OPEN-1** — 自检注入｜⏳ 观察\n\n${anchor}`),
      pick: (r) => idsOf(r.misplaced),
    },
  ];

  let allOk = true;
  for (const c of cases) {
    const after = c.mutate(base);
    if (after === base) {
      console.log(`  ❌ ${c.label} 注入未生效（文本未变）`);
      allOk = false;
      continue;
    }
    const r = diagnose(after);
    const hit = c.pick(r);
    const baseHit = c.pick(baseR);
    const ok = hit.has(c.probe) && !baseHit.has(c.probe);
    if (!ok) allOk = false;
    console.log(
      `  ${ok ? '✅' : '❌'} ${c.label} 探针 ${c.probe} ${ok ? '被捕获' : '未被捕获'}（基线含=${baseHit.has(c.probe)}）`,
    );
  }

  // ④ 连续空行：比较空块数增量
  const afterBlank = diagnose(base.replace(anchor, `${anchor}\n\n\n\n`));
  const blankOk = afterBlank.blanks.length === baseR.blanks.length + 1;
  if (!blankOk) allOk = false;
  console.log(
    `  ${blankOk ? '✅' : '❌'} ④空行 注入后空块 ${baseR.blanks.length} → ${afterBlank.blanks.length}（期望 +1）`,
  );

  console.log(allOk ? '\n✅ 自检通过：四类判据均可捕获新命中' : '\n❌ 自检失败：存在失明判据');
  return allOk ? 0 : 1;
}

function main() {
  const ledgerPath = join(ROOT, LEDGER_REL);
  if (!existsSync(ledgerPath)) {
    console.error(`❌ [ledger-hygiene] 台账缺失：${LEDGER_REL}`);
    process.exit(1);
  }
  const text = readFileSync(ledgerPath, 'utf8');

  if (process.argv.includes('--self-test')) {
    process.exit(selfTest());
  }

  const r = diagnose(text);
  if (r.sections.length === 0) {
    console.error('❌ [ledger-hygiene] 区标题解析为 0 —— 判据失明比假绿更危险');
    process.exit(1);
  }
  if (r.itemTotal === 0) {
    console.error('❌ [ledger-hygiene] 条目解析为 0 —— 条目格式可能已变，判据失明');
    process.exit(1);
  }
  process.exit(report(r));
}

main();
