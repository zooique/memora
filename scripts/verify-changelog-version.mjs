#!/usr/bin/env node
/**
 * 发布前置护栏：CHANGELOG 目标版本标题须带**真实**的发布日期
 *
 * 为什么存在（缺口 · 2026-10-23 实证，台账 RELEASE-CHLOG-DATE-1）：
 *   `@zooique/memora@5.0.0` 出包时，`CHANGELOG.md` 的版本标题仍是 `## [5.0.0] · 未发布`。
 *   `CHANGELOG.md` 在 `package.json` 的 `files` 白名单内 ⇒ **随包发出**，而 npm tarball
 *   **不可变**、已发布版本**不可重发** ⇒ npm 消费者看到的 5.0.0 版本区**永久缺发布日期**。
 *   根因不是「忘了改」，而是**该项只写在 deliverables 的人工待办行里，未进任何会跑的清单**
 *   ——`release.yml` 只校验 tag ↔ `package.json` version，对 CHANGELOG 零校验
 *   （又一次：「闸门有实现 ≠ 闸门会跑」，且此处是**闸门压根没覆盖这一步**）。
 *
 * ⚠️ 判据修订（2026-10-23 第二次审查，勿回退）：
 *   初版判据是「标题不得含『未发布』/『Unreleased』」——**只挡住了 5.0.0 恰好踩中的那一种写法**。
 *   变异实测 6 个，5 个该红却全绿：裸标题 `## [5.0.0]`（无日期）、`· 待定`、
 *   `· 2026-13-45`（非法日期）、`· 2099-01-01`、`· 1970-01-01`。
 *   ⇒ 犯了「**断言口径与不变量同源**」的反例：输出文案说「已带**发布日期**」，
 *   判据查的却是「有没有那两个**关键词**」。不同源 ⇒ 闸门失明。
 *
 *   现行判据断言的是**不变量本身**：标题须含一个**合法日历日期**，且该日期落在**发布日窗口**内。
 *   这样「日期是发布这一刻的事实」才真正成为断言，而不是「别写那两个词」。
 *
 * 判据（窄口 · fail-closed）：
 *   ① 目标版本 = 根 `package.json` 的 version（与 release.yml「tag ↔ version」护栏同源，不另立真源）。
 *   ② `CHANGELOG.md` 须**恰好一行**以 `## [<version>]` 开头的版本标题：
 *        0 行 = 该版本无 CHANGELOG 区 ⇒ 红；≥2 行 = 同版本多区 ⇒ 红（歧义，交人工分诊）。
 *      行首锚定避免命中正文里形如「见 [5.0.0]」的引用；`]` 参与匹配避免误吞 `## [5.0.0-beta.1]`。
 *   ③ 该标题行须含 `YYYY-MM-DD` 形态的日期：无日期 ⇒ 红（这是「已带发布日期」的直接断言）。
 *   ④ 该日期须是**合法日历日期**（真构造校验，非正则）：`2026-13-45` 这类溢出日期 ⇒ 红。
 *   ⑤ 该日期须落在**发布日窗口**内：`|日期 − 发布日| ≤ 1 天` ⇒ 否则红。
 *      窗口为什么必须存在：CHANGELOG 日期是人在打 tag 时按**本地时区**写的，而本闸在 CI 上按
 *      **UTC** 取发布日 ⇒ 二者天然可能差 1 天。实证：5.0.0 的 tag 打于北京 2026-10-23 06:06，
 *      而 npm `time["5.0.0"] = 2026-10-22T21:57:14Z`（UTC 日期 = 10-22）——**正好差 1 天**。
 *      ⇒ 窗口是容**时区差**，不是容懒。写 `2099-01-01` / `1970-01-01` 一律红。
 *   ⑥ 「未发布」/ `Unreleased` 仍保留为**冗余检查**：带合法日期时它不可能同时出现，
 *      保留只为给出更直白的报错文案（「你还写着未发布」比「日期不在窗口」更好定位）。
 *
 * 挂点（**刻意只挂 release.yml**）：
 *   不进 `local-ci`（pre-push）：开发期版本区**合法地**写着「未发布」（`deliverables/内核变更报告-4.0.0发布后至今-20261017.md`
 *   明确「保持不动——5.0.0 未发布，『未发布』是事实」），进 pre-push 会**稳定假红** ⇒ 噪音门禁必腐烂。
 *   正确挂点 = 「版本确定要出包」这一刻，即 release.yml。
 *
 * 用法：
 *   node scripts/verify-changelog-version.mjs                    # 发布日取当天（UTC）
 *   RELEASE_DATE=2026-10-22 node scripts/verify-changelog-version.mjs   # 注入发布日（确定性 / 复盘）
 *   node scripts/verify-changelog-version.mjs --selfTest          # 闸门自检（样例：绿 / 红 / 边界）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 「未发布」两类写法：本仓中文标题 + Keep a Changelog 的英文惯例 */
const UNRELEASED_TOKENS = ['未发布', 'Unreleased'];

/** 标题行内的日期形态：`YYYY-MM-DD` */
const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;

/** 发布日窗口（天）：容本地时区 ↔ UTC 的 1 天差，不容陈旧/未来日期 */
const RELEASE_WINDOW_DAYS = 1;

const MS_PER_DAY = 86_400_000;

/**
 * 把 `YYYY-MM-DD` 解析为 UTC 零点时间戳；非法日历日期（如 2026-13-45）返回 null。
 * 真构造校验：用 Date.UTC 构造后回读年月日，不等即溢出 ⇒ 非法。正则只做形态，不判真假。
 * @param {string} y `YYYY`
 * @param {string} m `MM`
 * @param {string} d `DD`
 * @returns {number | null}
 */
function parseUtcDate(y, m, d) {
  const yi = Number(y);
  const mi = Number(m);
  const di = Number(d);
  const ts = Date.UTC(yi, mi - 1, di);
  if (!Number.isFinite(ts)) return null;
  const back = new Date(ts);
  if (back.getUTCFullYear() !== yi || back.getUTCMonth() !== mi - 1 || back.getUTCDate() !== di) {
    return null; // 溢出：如 2026-13-45 会滚到下一年
  }
  return ts;
}

/**
 * 判据本体（纯函数，不碰文件系统 ⇒ 可被自检样例直接调用）。
 * @param {string} changelogText CHANGELOG 全文
 * @param {string} version 目标版本（如 `5.0.0`）
 * @param {string} todayISO 发布日 `YYYY-MM-DD`（CI 取当天 UTC；测试可注入）
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function evaluateChangelogVersion(changelogText, version, todayISO) {
  const heading = `## [${version}]`;
  const hits = changelogText.split(/\r?\n/).filter((line) => line.startsWith(heading));
  const reasons = [];

  if (hits.length === 0) {
    reasons.push(`CHANGELOG.md 找不到以 \`${heading}\` 开头的版本标题（该版本无 CHANGELOG 区）`);
    return { ok: false, reasons };
  }
  if (hits.length > 1) {
    reasons.push(
      `CHANGELOG.md 有 ${hits.length} 行以 \`${heading}\` 开头的标题（同版本多区，须人工分诊）`,
    );
  }

  const todayTs = parseUtcDate(todayISO.slice(0, 4), todayISO.slice(5, 7), todayISO.slice(8, 10));
  if (todayTs === null) {
    reasons.push(
      `发布日 \`${todayISO}\` 不是合法日历日期（RELEASE_DATE 注入值有误，或取当天失败）→ 判据失明，按 fail-closed 判红`,
    );
    return { ok: false, reasons };
  }

  for (const line of hits) {
    const token = UNRELEASED_TOKENS.find((t) => line.toLowerCase().includes(t.toLowerCase()));
    if (token) {
      reasons.push(
        `版本标题仍带「${token}」：\`${line}\` —— 出包前须改为实际发布日期（` +
          `已发布版本不可重发，tarball 不可变）`,
      );
      continue;
    }

    const m = DATE_RE.exec(line);
    if (!m) {
      reasons.push(
        `版本标题未带发布日期：\`${line}\` —— 须形如 \`${heading} · YYYY-MM-DD\`。` +
          `（本次发布日 = ${todayISO}；只挡「未发布」两个词是失明的：\`· 待定\`、裸标题同样缺日期）`,
      );
      continue;
    }

    const ts = parseUtcDate(m[1], m[2], m[3]);
    if (ts === null) {
      reasons.push(
        `版本标题日期 \`${m[0]}\` 不是合法日历日期：\`${line}\` —— 正则只保证形态，真伪须构造校验`,
      );
      continue;
    }

    const diffDays = Math.round((ts - todayTs) / MS_PER_DAY);
    if (Math.abs(diffDays) > RELEASE_WINDOW_DAYS) {
      reasons.push(
        `版本标题日期 \`${m[0]}\` 与发布日 \`${todayISO}\` 相差 ${Math.abs(diffDays)} 天` +
          `（容差 ±${RELEASE_WINDOW_DAYS} 天，只容本地时区与 UTC 的 1 天差）：\`${line}\``,
      );
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/** 闸门自检：证明本闸**真能红**（只绿不红的闸门等于没有闸门） */
function selfTest() {
  const V = '9.9.9';
  const T = '2026-10-22'; // 注入发布日，保证样例与运行日期无关
  const cases = [
    // ── 应绿 ──
    { name: '日期 = 发布日（应绿）', text: `## [${V}] · 2026-10-22\n`, expectOk: true },
    {
      name: '日期 = 发布日 +1（跨时区，应绿）',
      text: `## [${V}] · 2026-10-23\n`,
      expectOk: true,
    },
    {
      name: '日期 = 发布日 −1（提前写好，应绿）',
      text: `## [${V}] · 2026-10-21\n`,
      expectOk: true,
    },
    {
      name: '正文引用不误判（应绿）',
      text: `## [${V}] · 2026-10-22\n\n见 [${V}] 的说明\n`,
      expectOk: true,
    },
    {
      name: '闰年 2 月 29 日合法（应绿）',
      text: `## [${V}] · 2024-02-29\n`,
      expectOk: true,
      today: '2024-02-29',
    },
    // ── 应红 ──
    { name: '中文「未发布」（应红）', text: `## [${V}] · 未发布\n`, expectOk: false },
    { name: '英文 Unreleased（应红）', text: `## [${V}] - Unreleased\n`, expectOk: false },
    {
      name: '裸标题无日期（应红 · 初版判据漏网）',
      text: `## [${V}]\n`,
      expectOk: false,
    },
    {
      name: '日期写成「待定」（应红 · 初版判据漏网）',
      text: `## [${V}] · 待定\n`,
      expectOk: false,
    },
    {
      name: '非法日历日期 2026-13-45（应红 · 初版判据漏网）',
      text: `## [${V}] · 2026-13-45\n`,
      expectOk: false,
    },
    {
      name: '未来日期 2099-01-01（应红 · 初版判据漏网）',
      text: `## [${V}] · 2099-01-01\n`,
      expectOk: false,
    },
    {
      name: '陈旧日期 1970-01-01（应红 · 初版判据漏网）',
      text: `## [${V}] · 1970-01-01\n`,
      expectOk: false,
    },
    {
      name: '差 2 天超窗口（应红）',
      text: `## [${V}] · 2026-10-20\n`,
      expectOk: false,
    },
    {
      name: '平年 2 月 29 日非法（应红）',
      text: `## [${V}] · 2026-02-29\n`,
      expectOk: false,
      today: '2026-02-28',
    },
    { name: '该版本无区（应红）', text: `## [9.9.8] · 2026-10-01\n`, expectOk: false },
    {
      name: '同版本多区（应红）',
      text: `## [${V}] · 2026-10-22\n\n## [${V}] · 2026-10-22\n`,
      expectOk: false,
    },
    {
      name: '预发布区不算目标版本（应红：`]` 边界）',
      text: `## [${V}-beta.1] · 2026-10-22\n`,
      expectOk: false,
    },
  ];

  let passed = 0;
  for (const c of cases) {
    const { ok } = evaluateChangelogVersion(c.text, V, c.today ?? T);
    if (ok === c.expectOk) {
      passed += 1;
    } else {
      console.log(`  ✗ ${c.name}：期望 ${c.expectOk ? '绿' : '红'}，实际 ${ok ? '绿' : '红'}`);
    }
  }
  console.log(`闸门自检: ${passed}/${cases.length} 样例符合预期`);
  return passed === cases.length;
}

const args = process.argv.slice(2);
if (args.includes('--selfTest')) {
  process.exit(selfTest() ? 0 : 1);
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const changelogText = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
// 发布日：CI 取当天（UTC）；注入 RELEASE_DATE 可复现/复盘
const todayISO = process.env.RELEASE_DATE ?? new Date().toISOString().slice(0, 10);

const { ok, reasons } = evaluateChangelogVersion(changelogText, version, todayISO);

if (ok) {
  console.log(
    `✅ [changelog-version] CHANGELOG.md 的 [${version}] 标题已带发布日期（发布日 ${todayISO}）`,
  );
  process.exit(0);
}

for (const reason of reasons) {
  // GitHub Actions 会把它渲染成该步骤的注解，直接贴在红灯那一步上
  console.log(`::error::${reason}`);
}
console.log(
  `❌ [changelog-version] CHANGELOG.md 的 [${version}] 标题未通过发布前置校验（${reasons.length} 条）`,
);
process.exit(1);
