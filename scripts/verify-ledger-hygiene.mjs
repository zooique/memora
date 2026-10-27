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
 *   ⑤ **版本索引三方一致**（2026-10-27 补）：「版本索引」表每行必须同时满足——
 *      归档文件存在 ∧ 该文件 H1 **声明了本行版本** ∧ **git tag 存在**。
 *      为什么补：①②③ 的投放面是「区」，归元后主台账不再有版本区 ⇒ ①②③ 恒空恒绿。
 *       TableRow↔归档文件↔git tag 三方是**不依赖区名**的稳定坐标，哪怕台账再重组也仍然可判。
 *   ⑥ **待执行无完成判据**（2026-10-27 补）：📌 待执行条目正文**必须含一行 `完成判据：`**。
 *      「待执行」= 已拍板待人/机落地，没有完成判据就无法判断做完没有，会变成永久占位条目。
 *   ⑦ **版本索引 ↔ README 归档表一致**（2026-10-27 补）：同一份「哪些归档文件在册」的事实，
 *      主台账「版本索引」与 `tasks/archive/README.md` 各登记一份 ⇒ 两处文件名集合**必须双向相等**。
 *      为什么补：两处登记无机器校验就是注定漂移的第二真源（治理技能曾把这条列为已知风险）。
 *   ⑧ **已落态跨过发版线却无归档副本**（2026-10-27 补）：观察区里已收口（✅/❌…）的条目，
 *      若其标题行**在 HEAD 里的最后改动时间早于该轴最近 tag**（且整条 tag 后未被改过）、
 *      又**没有任何归档副本** ⇒ 该版发版时就该收进归档，没没收 = 漏归档（L3 四例的实际形态）。
 *      「跨过发版线」用 git 时间判定，不靠条目标记措辞——统计口径不依赖作者记得写什么。
 *      ⚠️ 边界（fail-open，刻意）：① 标题行在工作树与 HEAD 不一致（正在改写）⇒ 跳过，
 *      以提交后判据为准；② 新条目在 HEAD 中不存在 ⇒ 跳过；③ 该轴尚无 tag ⇒ 跳过。
 *
 *   ⑨ **刻意不设**：观察态条目「必须字面含『触发』」——**否决**（2026-10-27 实测）。
 *      存量 95 条观察态里 19 条字面不含「触发」，逐条读正文后多数已用散文写明升档出口
 *      （「等用户说…再动」/「仅在用户实际体验后仍感…才需补齐」/「到期 2026-11-19」/「与 G35 同批评估」）。
 *      词面门判的是**写法不是内容**，只会催生「触发：无」这类合规空话，且逼真条目改写成套话
 *      ⇒ 比不设更差。判断「这条有没有升档出口」属人工审核，不机器代判；此处留痕防后人重提。
 *
 * 档位（2026-10-27 由告警升硬闸，兑现上一版写明的升档条件）：
 *   当初挂 required:false 是为 0.2.0 区的存量欠账/假指针让路，避免门一建就被绕。
 *   该存量已于 2026-10-27 清零：①②③④⑥ 五类 0 命中，⑤ 三方一致全绿。
 *   ⇒ local-ci 的 `ledger:hygiene` 步已改 `required: true`，此后任一命中 = 真回归。
 *   ⚠️ 今后若再生存量：**先清零**，不要把 required 改回 false（改回即重演「门被绕过」）。
 *
 * 空集语义（fail-closed）：
 *   台账缺失 / 区解析为 0 / 条目解析为 0 ⇒ **判据失明比假绿更危险**，一律判红。
 *
 * 用法：
 *   node scripts/verify-ledger-hygiene.mjs            # 分诊并列出命中
 *   node scripts/verify-ledger-hygiene.mjs --self-test # 自检：注入变异确认各判据都能红（⑧ 另含反例控制）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { arcHasEntryForId } from './lib/ledger-archive.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_REL = 'tasks/待完成任务.md';

/**
 * 收口标记 —— 命中即视为「该归档」（与归档纪律的「已关闭」口径同族）。
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

/**
 * 观察区标题判据 —— ⑧ 的投放面。
 * 归元后主台账里**只有这个区长期承载条目**（注记类 / 明确不推进不属待办，不参与归档判定）。
 */
const OBSERVATION_RE = /观察\s*\/\s*待拍板/;

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
  return raw.map((c) => ({
    id: c.id,
    head: c.head,
    start: c.start,
    end: c.end,
    lines: c.end - c.start,
  }));
}

/** 版本索引表的数据行：| 版本轴 | 版本 | 发布日期 | 归档（真理源） | */
function parseVersionIndex(lines) {
  const rows = [];
  let inTable = false;
  for (const line of lines) {
    if (/^\|\s*版本轴/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!/^\|/.test(line)) break;
    if (/^\|[\s:|-]+\|$/.test(line)) continue; // 表头下的分隔行
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((s) => s.trim());
    if (cells.length >= 4) {
      rows.push({ line, axis: cells[0], version: cells[1], date: cells[2], archiveCell: cells[3] });
    }
  }
  return rows;
}

/**
 * ⑤ 版本索引三方一致：行 ↔ 归档文件 ↔ git tag。
 *
 * 为什么用这三方（2026-10-27）：归元后主台账**不再有版本区**，而 ①②③ 的投放面就是「区」
 * ⇒ ①②③ 恒空恒绿（那是「查无可查」，不是「查过都合规」）。版本索引表 / 归档文件 H1 / git tag
 * 三者都不依赖区名，台账再怎么重组也仍然可判，是唯一稳定的坐标。
 */
function checkVersionIndex(lines, tags, readmeText) {
  const rows = parseVersionIndex(lines);
  const issues = [];
  // 版本索引里出现过的归档文件名（basename），供 ⑦ 与 README 归档表对账
  const indexFiles = new Set();
  if (rows.length === 0) return [{ row: null, why: '版本索引解析为 0 行（判据失明比假绿更危险）' }];

  for (const r of rows) {
    const target = /archive\/[A-Za-z0-9._/-]+\.md/.exec(r.archiveCell)?.[0] ?? null;
    if (!target) {
      issues.push({ row: r, why: '归档单元格无 archive/*.md 链接目标' });
      continue;
    }
    indexFiles.add(target.replace(/^archive\//, ''));
    const abs = join(ROOT, 'tasks', target);
    if (!existsSync(abs)) {
      issues.push({ row: r, why: `归档文件不存在：${target}` });
      continue;
    }
    const arc = readFileSync(abs, 'utf8');
    const h1 = /^#\s+(.*)$/m.exec(arc)?.[1] ?? '';
    const primary = r.version.split('（')[0].trim();
    if (!h1.includes(primary)) {
      issues.push({ row: r, why: `文件 H1 未声明版本 ${primary}（实际「${h1.slice(0, 28)}」）` });
    }
    const versions = r.version.match(/\d+\.\d+\.\d+/g) ?? [];
    if (versions.length === 0) {
      issues.push({ row: r, why: `版本单元格解析不出版本号：${r.version}` });
      continue;
    }
    for (const v of versions) {
      // `memora@` 是**已废弃的 tag 命名**（见 memora-kernel-release 技能「`memora@` 漂移」：不会触发
      // 发布链，禁止再打）。此处保留为候选是历史事实，不是放开口子——实测 tag 列表确有
      // `memora@3.0.0 / memora@3.0.1 / memora@4.0.0`，去掉它 ⇒ 3.0.x 与 4.0.0 两行当场假红。
      // ⚠️ 想清理它，必须先给这三行找到别的验收判据，而不是直接删候选。
      const cands = /宿主/.test(r.axis) ? [`vscode@${v}`] : [`v${v}`, `memora@${v}`];
      if (!cands.some((t) => tags.has(t))) {
        issues.push({ row: r, why: `版本 ${v} 无 git tag（候选 ${cands.join(' / ')}）` });
      }
    }
  }

  // ⑦ 版本索引 ↔ archive/README.md 归档表：两处登记同一份「在册归档文件」事实 ⇒ 集合必须双向相等。
  //    只认表格首列被反引号包裹的 `*.md`，且**排除带路径的条目**（README 另有「审查报告」等
  //    指向 tasks/*.md 的行，它们不是 tasks/archive 下的归档文件，掺进来即假红）。
  const readme = readmeText ?? readFileSync(join(ROOT, 'tasks', 'archive', 'README.md'), 'utf8');
  const readmeFiles = new Set();
  for (const line of readme.split(/\r?\n/)) {
    const m = /^\|\s*`([^`]+\.md)`/.exec(line);
    if (m && !m[1].includes('/')) readmeFiles.add(m[1]);
  }
  if (readmeFiles.size === 0) {
    issues.push({ row: null, why: 'archive/README.md 归档表解析为 0 行（判据失明比假绿更危险）' });
  }
  for (const f of indexFiles) {
    if (!readmeFiles.has(f)) {
      issues.push({ row: null, why: `版本索引引用了 ${f}，但 archive/README.md 归档表未登记` });
    }
  }
  for (const f of readmeFiles) {
    if (!indexFiles.has(f)) {
      issues.push({ row: null, why: `archive/README.md 登记了 ${f}，但版本索引无对应行` });
    }
  }
  return issues;
}

/** ⑥ 待执行条目的完成判据：📌 段首即「已拍板待人/机落地」，无完成判据 = 永久占位。 */
const PENDING_SEG_RE = /｜\s*📌/u;
// 加粗位置不限（`**完成判据：**` 与 `**完成判据**：` 都算），但必须是显式写法而非顺口提及。
const DONE_CRITERION_RE = /完成判据\**\s*：/;

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

/** 收口态的单点判据（① 与 ⑧ 共用一份拼写；开放态优先——🔄/⏳/📌 一律不算收口）。 */
const isClosedHead = (head) =>
  CLOSED_RE.test(head) && !NOT_CLOSED_RE.test(head) && !OPEN_SEG_RE.test(head);

/** 条目所属子区（最近的上层 `###` 标题），用于把条目映射到版本轴。 */
function axisAt(lines, sec, idx) {
  for (let i = idx; i >= sec.start; i--) {
    const m = /^###\s+(.+)$/.exec(lines[i]);
    if (m) return m[1].trim();
  }
  return null;
}

/** 所有归档文件的副本查询（缓存文本，逐 ID 复用 `lib/ledger-archive.mjs` 的同一判据）。 */
function archiveCopies() {
  const dir = join(ROOT, 'tasks', 'archive');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
  const texts = files.map((f) => readFileSync(join(dir, f), 'utf8'));
  return { has: (id) => texts.some((t) => arcHasEntryForId(t, id)) };
}

/**
 * ⑧ 的判据输入：发版线时间 + HEAD 版本台账的逐行改动时间。
 *
 * 为什么时间取自 HEAD、归档副本取自工作树：条目「何时落态」只能问已提交历史（未提交改动没有时间），
 * 而「有没有归档副本」是当前结构事实（与 ①②③ 同源）。
 * 为什么一次 blame 取全文件：逐条 `-L` 会产生 N 次子进程；行数对不齐即判据失明，宁可抛错。
 */
function ledgerTiming() {
  const refs = execFileSync(
    'git',
    [
      'for-each-ref',
      '--sort=-creatordate',
      '--format=%(refname:short) %(creatordate:unix)',
      'refs/tags',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  // 两条版本轴各取最近一条：内核轴 = `v<semver>`（`memora@` 是已废弃命名，不计），宿主轴 = `vscode@`。
  let kernelTagTime = null;
  let hostTagTime = null;
  for (const r of refs) {
    const [name, ts] = r.split(/\s+/);
    const t = Number(ts);
    if (!Number.isFinite(t)) continue;
    if (hostTagTime === null && name.startsWith('vscode@')) hostTagTime = t;
    if (kernelTagTime === null && /^v\d+\.\d+\.\d+$/.test(name)) kernelTagTime = t;
    if (kernelTagTime !== null && hostTagTime !== null) break;
  }

  const headText = execFileSync('git', ['show', `HEAD:${LEDGER_REL}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const porcelain = execFileSync('git', ['blame', '--line-porcelain', 'HEAD', '--', LEDGER_REL], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const times = [];
  for (const line of porcelain.split(/\r?\n/)) {
    const m = /^committer-time (\d+)$/.exec(line);
    if (m) times.push(Number(m[1]));
  }
  const headLines = headText.replace(/\r?\n$/, '').split(/\r?\n/);
  if (headLines.length !== times.length) {
    throw new Error(
      `blame 行数 ${times.length} ≠ HEAD 台账行数 ${headLines.length}（判据失明比假绿更危险）`,
    );
  }

  const byId = new Map();
  for (const sec of parseSections(headLines)) {
    for (const it of parseItems(headLines, sec)) {
      byId.set(it.id, {
        headTime: times[it.start],
        lastTime: Math.max(...times.slice(it.start, it.end)),
        headLine: it.head,
      });
    }
  }
  return { kernelTagTime, hostTagTime, byId };
}

/** 秒级时间戳 → `YYYY-MM-DD HH:mm`（UTC，够判先后，不用来展示时区）。 */
function stamp(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * ⑧ 已落态跨过发版线却无归档副本。
 * 三个跳过分支都是**刻意 fail-open**（见文件头 ⑧ 的边界说明），不是遗漏。
 */
function checkArchiveTiming(cands, timing, archives) {
  const out = [];
  for (const c of cands) {
    if (archives.has(c.id)) continue; // 任一归档文件有副本 ⇒ 已归档
    const t = timing.byId.get(c.id);
    if (!t) continue; // 新条目：HEAD 里不存在，无时间可判
    if (t.headLine !== c.head) continue; // 标题行正在改写（工作树 ≠ HEAD），以提交后判据为准
    const tagTime =
      c.axis === '内核轴' ? timing.kernelTagTime : c.axis === '宿主轴' ? timing.hostTagTime : null;
    if (tagTime === null) continue; // 该轴尚无发版线
    // 双条件：标题行落态时间与整条最后改动都早于 tag ⇒ 该版发版时它已定型却没收进归档
    if (t.headTime < tagTime && t.lastTime < tagTime) {
      out.push({
        ...c,
        why: `落态 ${stamp(t.headTime)} 早于 ${c.axis} 发版线 ${stamp(tagTime)}，且无归档副本`,
      });
    }
  }
  return out;
}

function diagnose(text, opts = {}) {
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
  const pending = [];
  const closedCands = []; // ⑧ 的候选：观察区内已收口、且标题行无归档指针
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
      if (released && !ptr && isClosedHead(it.head)) {
        debt.push({ ...it, sec: sec.title });
      }

      // ③ 开放态错置：已发布区 + 状态段以开放标记起头 + **无归档指针**。
      //    有指针者视为「已归档的历史态」，不再要求迁出（见 OPEN_SEG_RE 注释）。
      if (released && !ptr && OPEN_SEG_RE.test(it.head)) {
        misplaced.push({ ...it, sec: sec.title });
      }
      // ⑥ 待执行无完成判据
      if (PENDING_SEG_RE.test(it.head)) {
        const body = lines.slice(it.start + 1, it.end).join('\n');
        if (!DONE_CRITERION_RE.test(body)) {
          pending.push({ ...it, sec: sec.title, why: '📌 待执行条目缺「完成判据：」行' });
        }
      }
      // ⑧ 候选：观察区（主台账里唯一长期承载条目的区）内已收口、标题行无归档指针。
      //    判据本体（跨发版线 + 无副本）在 checkArchiveTiming 里，故此处只收集，不判定。
      if (OBSERVATION_RE.test(sec.title) && !ptr && isClosedHead(it.head)) {
        closedCands.push({ ...it, sec: sec.title, axis: axisAt(lines, sec, it.start) });
      }
    }
  }

  const blanks = hasBlankRuns(lines);
  const tags = new Set(
    execFileSync('git', ['tag', '--list'], { cwd: ROOT, encoding: 'utf8' })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const indexIssues = checkVersionIndex(lines, tags, opts.readmeText);
  // ⑧ 的时间来源默认取自 git（真实运行时）；自检注入的探针不在 HEAD 中，靠 opts.timing 的桩数据驱动
  const timing = checkArchiveTiming(closedCands, opts.timing ?? ledgerTiming(), archiveCopies());
  return {
    sections,
    itemTotal,
    debt,
    fake,
    misplaced,
    pending,
    indexIssues,
    timing,
    releasedSections,
    blanks,
    lines,
  };
}

function report(r) {
  const problems = [];
  if (r.debt.length) problems.push(['①欠账', r.debt]);
  if (r.fake.length) problems.push(['②假指针', r.fake]);
  if (r.misplaced.length) problems.push(['③开放态错置', r.misplaced]);
  if (r.blanks.length) problems.push(['④连续空行', r.blanks]);
  if (r.indexIssues.length)
    problems.push(['⑤⑦版本索引不一致（三方 / README 归档表）', r.indexIssues]);
  if (r.pending.length) problems.push(['⑥待执行无完成判据', r.pending]);
  if (r.timing.length) problems.push(['⑧落态跨发版线但无归档副本', r.timing]);

  console.log(
    `\n[ledger-hygiene] 台账结构分诊：${r.sections.length} 区 / ${r.itemTotal} 条目 / ${r.lines.length} 行`,
  );
  console.log(
    '  已发布区：' +
      (r.releasedSections.length
        ? r.releasedSections
            .map((s) => `${s.title.slice(0, 18)} ${s.lines}行/${s.items}条`)
            .join(' · ')
        : '(无 · 归元后主台账不再按版本分区 ⇒ ①②③ 无投放面，结构事实改由 ⑤⑥⑦⑧ 承担)'),
  );

  if (problems.length === 0) {
    console.log(
      '✅ [ledger-hygiene] 八类判据全部通过（欠账 0 / 假指针 0 / 错置 0 / 连续空行 0 / 版本索引三方一致 / 待执行均有完成判据 / 版本索引↔README 归档表一致 / 无落态跨版未归档）',
    );
    return 0;
  }

  for (const [label, list] of problems) {
    console.log(`\n❌ ${label}：${list.length} 处`);
    for (const h of list.slice(0, MAX_PRINT)) {
      if (h.n !== undefined) {
        console.log(`   行${h.end - h.n + 1}..${h.end}  ${h.n} 个连续空行`);
      } else if (h.start !== undefined) {
        console.log(
          `   行${h.start + 1}  [${h.id.slice(0, 30)}]  ${h.lines}行  ${h.why ?? h.sec.slice(0, 24)}`,
        );
      } else {
        console.log(`   ${h.why ?? ''}`);
        if (h.row) console.log(`      ${h.row.line.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    if (list.length > MAX_PRINT) console.log(`   … 另有 ${list.length - MAX_PRINT} 处`);
  }
  console.log(
    '\n   处置：①②③ 见 `tasks/archive/README.md` 七条纪律（原 `archive-discipline.md` 副本已于 2026-10-27 删除，' +
      '其纪律 7 与真源字面相反，勿从 git 历史转抄）；' +
      '\n   ④ 连续空行压成 1 行（写盘前须断言非空行序列不变）；' +
      '\n   ⑤ 校准「版本索引」表 ↔ 归档文件 H1 ↔ git tag 三方；⑥ 给 📌 待执行条目补「完成判据：」行；' +
      '\n   ⑦ 让「版本索引」与 `tasks/archive/README.md` 归档表的文件名集合双向相等（改一处必须同步另一处）；' +
      '\n   ⑧ 把该条目搬进对应版本归档（发版时就该做），或在标题行注明归档去向。' +
      '\n   本闸已是硬闸（local-ci required:true）——存量回涨时先把存量清零，不许把档位调回去。',
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
  const baseReadme = readFileSync(join(ROOT, 'tasks', 'archive', 'README.md'), 'utf8');
  // ⑧ 的真实时间输入只取一次；各用例用桩覆盖探针的时间，避免逐例重跑 blame
  const baseTiming = ledgerTiming();
  const baseR = diagnose(base, { timing: baseTiming });
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
  // ⑧ 的探针必须落在**版本轴**下（axisAt 向上找最近的 `###`），否则 axis=null ⇒ 被跳过 ⇒ 自检假绿
  const axisAnchor = base.includes('### 内核轴') ? '### 内核轴' : null;
  if (!axisAnchor) {
    console.error('❌ 自检锚点 `### 内核轴` 不存在，⑧ 探针无法定位版本轴 —— 自检前提失效');
    return 1;
  }
  /** ⑧ 探针的注入行（与桩数据里的 headLine 必须逐字一致，否则被「标题行正在改写」分支跳过） */
  const probeTimeLine = (id) => `- **${id}** — 自检注入｜✅ 完成`;

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
    {
      // ⑤ 的探针不是 ID 而是 version：注入一个三方全假的索引行，必须被「文件不存在」拦下。
      label: '⑤版本索引三方不一致',
      probe: '9.9.9',
      mutate: (t) =>
        t.replace(
          /(\| 内核 npm \| 3\.0\.x[^\n]*\n)/,
          '$1| 内核 npm | 9.9.9 | 2026-10-27 | [archive/9.9.9-kernel.md](./archive/9.9.9-kernel.md) |\n',
        ),
      pick: (r) => new Set(r.indexIssues.map((x) => x.why ?? '')),
    },
    // ⑤b：指向**存在**的归档文件但版本号对不上 ⇒ 同时探「H1 未声明版本」与「无 git tag」两个分支。
    {
      label: '⑤b版本索引 H1/tag 不符',
      probe: '9.9.8',
      mutate: (t) =>
        t.replace(
          /(\| 内核 npm \| 3\.0\.x[^\n]*\n)/,
          '$1| 内核 npm | 9.9.8 | 2026-10-27 | [archive/5.1.0-kernel.md](./archive/5.1.0-kernel.md) |\n',
        ),
      pick: (r) => new Set(r.indexIssues.map((x) => x.why ?? '')),
    },
    {
      label: '⑥待执行无完成判据',
      probe: 'ZZ-PEND-1',
      mutate: (t) => t.replace(anchor, `${anchor}\n\n- **ZZ-PEND-1** — 自检注入｜📌 待执行\n`),
      pick: (r) => idsOf(r.pending),
    },
    // ⑧ 正向：探针落到内核轴下、无归档副本、落态时间早于发版线 ⇒ 必须命中。
    //    时间由桩注入（探针不在 HEAD，真实 blame 里查不到它）。
    {
      label: '⑧落态跨发版线无归档',
      probe: 'ZZ-TIME-1',
      mutate: (t) => t.replace(axisAnchor, `${axisAnchor}\n\n${probeTimeLine('ZZ-TIME-1')}`),
      timing: (b) => {
        const tag = b.kernelTagTime ?? 1000; // 无 tag 时给个确定的假发版线，保证判据可判
        return {
          ...b,
          kernelTagTime: tag,
          // 桩：标题行与整条最后改动都早于 tag
          byId: new Map(b.byId).set('ZZ-TIME-1', {
            headTime: tag - 1,
            lastTime: tag - 1,
            headLine: probeTimeLine('ZZ-TIME-1'),
          }),
        };
      },
      pick: (r) => idsOf(r.timing),
    },
    // ⑧ 反例控制（invert）：落态时间在发版线**之后** ⇒ 不该报（防「凡已收口就报」的过度拦截）。
    {
      label: '⑧b落态在发版线后不误报',
      probe: 'ZZ-TIME-2',
      invert: true,
      mutate: (t) => t.replace(axisAnchor, `${axisAnchor}\n\n${probeTimeLine('ZZ-TIME-2')}`),
      timing: (b) => {
        const tag = b.kernelTagTime ?? 1000;
        return {
          ...b,
          kernelTagTime: tag,
          byId: new Map(b.byId).set('ZZ-TIME-2', {
            headTime: tag + 1,
            lastTime: tag + 1,
            headLine: probeTimeLine('ZZ-TIME-2'),
          }),
        };
      },
      pick: (r) => idsOf(r.timing),
    },
    // ⑦a：README 归档表删掉 0.1.0 行 ⇒ 版本索引引用了但表未登记（只改 README，不改台账）
    {
      label: '⑦a归档表漏登记',
      probe: '0.1.0-host.md',
      mutate: (t) => t,
      readmeMutate: (rm) => rm.replace(/^\|\s*`0\.1\.0-host\.md`[^\n]*\n/m, ''),
      pick: (r) => new Set(r.indexIssues.map((x) => x.why ?? '')),
    },
    // ⑦b：README 归档表多出一行 ⇒ 表登记了但版本索引无对应行
    {
      label: '⑦b归档表多登记',
      probe: 'zz-probe.md',
      mutate: (t) => t,
      readmeMutate: (rm) =>
        rm.replace(
          /(\| --- \| --- \| --- \| --- \| --- \|\n)/,
          '$1| `zz-probe.md` | 9.9.9 | 内核 npm | 自检注入 | 无 |\n',
        ),
      pick: (r) => new Set(r.indexIssues.map((x) => x.why ?? '')),
    },
  ];

  let allOk = true;
  for (const c of cases) {
    const after = c.mutate(base);
    const afterReadme = c.readmeMutate ? c.readmeMutate(baseReadme) : baseReadme;
    if (after === base && afterReadme === baseReadme) {
      console.log(`  ❌ ${c.label} 注入未生效（文本未变）`);
      allOk = false;
      continue;
    }
    const r = diagnose(after, {
      readmeText: afterReadme,
      // ⑧ 的时间输入：有桩用桩（探针不在 HEAD），无桩沿用基线（避免逐例重跑 blame）
      timing: c.timing ? c.timing(baseTiming) : baseTiming,
    });
    // ⑤ 的投放面是「描述字符串」而非条目 ID ⇒ 命中判定用包含而非等值（见 pick 的返回形态）。
    const contains = (set) =>
      [...set].some((x) => String(x) === c.probe || String(x).includes(c.probe));
    const hit = contains(c.pick(r));
    const clean = !contains(c.pick(baseR));
    // invert = 反例控制：判据**不该**命中（防过度拦截），故只要求 not hit
    const ok = c.invert ? !hit : hit && clean;
    if (!ok) allOk = false;
    console.log(
      c.invert
        ? `  ${ok ? '✅' : '❌'} ${c.label} 探针 ${c.probe} ${ok ? '未被误报' : '被误报'}`
        : `  ${ok ? '✅' : '❌'} ${c.label} 探针 ${c.probe} ${ok ? '被捕获' : '未被捕获'}（基线含=${!clean}）`,
    );
  }

  // ④ 连续空行：比较空块数增量
  const afterBlank = diagnose(base.replace(anchor, `${anchor}\n\n\n\n`), { timing: baseTiming });
  const blankOk = afterBlank.blanks.length === baseR.blanks.length + 1;
  if (!blankOk) allOk = false;
  console.log(
    `  ${blankOk ? '✅' : '❌'} ④空行 注入后空块 ${baseR.blanks.length} → ${afterBlank.blanks.length}（期望 +1）`,
  );

  console.log(
    allOk ? '\n✅ 自检通过：八类判据（①②③④⑤⑥⑦⑧）均可捕获新命中' : '\n❌ 自检失败：存在失明判据',
  );
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
