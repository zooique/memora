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
 *   ⑦ 轴分流 + 常开弱校验（2026-11-13 加固 · 台账 CHLOG-VERSION-HOST-AXIS-1）：
 *      内核区标题不带 `· 宿主`，宿主区标题带 `· 宿主`（与 `hosts/memora-vscode/scripts/
 *      changelog-host-sections.mjs` 同源约定）。两轴发布日期**不同步**：宿主区要么早于本次
 *      内核发版、要么还写着「未发布」（实证 v7.0.0 / v7.1.0 / v7.2.0 三个 tag 均如此）
 *      ⇒ 对宿主区直接套 ±1 天窗口是**恒假红**。故分两种模式：
 *        · 宿主模式（tag ref 前缀 `vscode@` 自动识别；`RELEASE_AXIS=host` 手动覆盖）：
 *          只校验宿主段，判据同 ②③④⑤（含 ±1 天窗口）。
 *        · 内核模式（其余）：内核段判据 ②③④⑤ **一字不改**；宿主段只做**常开弱校验**——
 *          日期须是合法日历日期、且不晚于发布日 +1（不设下限，宿主可能早于本次发版）；
 *          标题仍写「未发布」时跳过（内核先发、宿主未发是合法状态）。
 *      两种模式下 `[Unreleased]` 都豁免日期判断（它没有发布日）。
 *
 * ⚠️ CI 接线欠账（台账 CHLOG-VERSION-HOST-AXIS-1）：本脚本当前只挂 `release.yml`（内核轴），
 *   `host-release.yml` 尚未调用 ⇒ 宿主模式在 CI 里不会自动跑，只能手动执行：
 *   `RELEASE_AXIS=host RELEASE_DATE=YYYY-MM-DD node scripts/verify-changelog-version.mjs`。
 *
 * 挂点（**刻意只挂 release.yml**）：
 *   不进 `local-ci`（pre-push）：开发期版本区**合法地**写着「未发布」（`deliverables/内核变更报告-4.0.0发布后至今-20261017.md`
 *   明确「保持不动——5.0.0 未发布，『未发布』是事实」），进 pre-push 会**稳定假红** ⇒ 噪音门禁必腐烂。
 *   正确挂点 = 「版本确定要出包」这一刻，即 release.yml。
 *
 * 发版模式闸（2026-11-07 加固 · 修 `CHANGELOG-GATE-FAKE-RED-1`）：
 *   裸跑（无 `RELEASE=1` / 无 `RELEASE_DATE`）= **非发版模式** ⇒ 打印跳过原因并 **exit 0**。
 *   为什么：一个「非发版日必红」的闸，实际效果是被所有人无视——比没有闸更坏。
 *   发版模式 = `RELEASE=1`（发布日取当天 UTC）或 `RELEASE_DATE=YYYY-MM-DD`（确定性复盘）。
 *   release.yml 必须显式置 `RELEASE=1`，否则本闸会在发布流水线里静默跳过（等于没挂）。
 *
 * 用法：
 *   node scripts/verify-changelog-version.mjs                    # 裸跑：跳过（exit 0）
 *   RELEASE=1 node scripts/verify-changelog-version.mjs          # 发版模式：发布日取当天（UTC）
 *   RELEASE_DATE=2026-10-22 node scripts/verify-changelog-version.mjs   # 发版模式：注入发布日（复盘）
 *   RELEASE_AXIS=host RELEASE_DATE=2026-11-12 node scripts/verify-changelog-version.mjs  # 宿主轴（手动）
 *   node scripts/verify-changelog-version.mjs --selfTest          # 闸门自检（样例：绿 / 红 / 边界 / 轴分流）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 宿主版本号真源：与宿主发版产物同源，不在本脚本另立一份 */
const HOST_PKG_JSON = join(ROOT, 'hosts', 'memora-vscode', 'package.json');

/** 宿主区标题的轴标记（与 changelog-host-sections.mjs 的 HOST_SECTION_RE 同源约定） */
const HOST_SECTION_MARK = '· 宿主';

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
 * 版本令牌是否 `[Unreleased]`：它没有发布日，日期判据整体豁免（不适用，不是放宽）。
 * @param {string} version 版本令牌
 * @returns {boolean}
 */
export function isUnreleasedVersion(version) {
  return version === 'Unreleased';
}

/**
 * 找目标版本的标题行：内核轴按行首 `## [<version>]` 锚定；宿主轴额外要求带 `· 宿主`。
 * @param {string} changelogText CHANGELOG 全文
 * @param {string} version 目标版本
 * @param {{ hostOnly?: boolean }} [opts] hostOnly=true 时只认宿主区标题
 * @returns {string[]}
 */
function findVersionHeadings(changelogText, version, { hostOnly = false } = {}) {
  const heading = `## [${version}]`;
  return changelogText.split(/\r?\n/).filter((line) => {
    if (!line.startsWith(heading)) return false;
    return hostOnly ? line.includes(HOST_SECTION_MARK) : true;
  });
}

/**
 * 标题日期断言（内核 / 宿主共用；轴差异只在标题匹配与报错前缀）。
 * @param {string[]} hits 命中的标题行
 * @param {string} heading 标题前缀（用于报错示例）
 * @param {string} todayISO 发布日
 * @param {{ label?: string, requireWindow?: boolean, allowUnreleased?: boolean }} [opts]
 *   requireWindow=true ⇒ 日期须落在 ±1 天窗口（内核轴 / 宿主发版轴）；
 *   requireWindow=false ⇒ 只判合法日历日期 + 不晚于发布日 +1（宿主弱校验，允许更早）；
 *   allowUnreleased=true ⇒ 标题写着「未发布」时跳过（内核先发、宿主未发是合法状态）。
 * @returns {{ reasons: string[] }}
 */
function collectDateReasons(
  hits,
  heading,
  todayISO,
  { label = '', requireWindow = true, allowUnreleased = false } = {},
) {
  const reasons = [];

  const todayTs = parseUtcDate(todayISO.slice(0, 4), todayISO.slice(5, 7), todayISO.slice(8, 10));
  if (todayTs === null) {
    reasons.push(
      `${label}发布日 \`${todayISO}\` 不是合法日历日期（RELEASE_DATE 注入值有误，或取当天失败）→ 判据失明，按 fail-closed 判红`,
    );
    return { reasons };
  }

  for (const line of hits) {
    const token = UNRELEASED_TOKENS.find((t) => line.toLowerCase().includes(t.toLowerCase()));
    if (token) {
      if (allowUnreleased) continue;
      reasons.push(
        `${label}版本标题仍带「${token}」：\`${line}\` —— 出包前须改为实际发布日期（` +
          `已发布版本不可重发，tarball 不可变）`,
      );
      continue;
    }

    const m = DATE_RE.exec(line);
    if (!m) {
      reasons.push(
        `${label}版本标题未带发布日期：\`${line}\` —— 须形如 \`${heading} · YYYY-MM-DD\`。` +
          `（本次发布日 = ${todayISO}；只挡「未发布」两个词是失明的：\`· 待定\`、裸标题同样缺日期）`,
      );
      continue;
    }

    const ts = parseUtcDate(m[1], m[2], m[3]);
    if (ts === null) {
      reasons.push(
        `${label}版本标题日期 \`${m[0]}\` 不是合法日历日期：\`${line}\` —— 正则只保证形态，真伪须构造校验`,
      );
      continue;
    }

    const diffDays = Math.round((ts - todayTs) / MS_PER_DAY);
    if (requireWindow) {
      if (Math.abs(diffDays) > RELEASE_WINDOW_DAYS) {
        reasons.push(
          `${label}版本标题日期 \`${m[0]}\` 与发布日 \`${todayISO}\` 相差 ${Math.abs(diffDays)} 天` +
            `（容差 ±${RELEASE_WINDOW_DAYS} 天，只容本地时区与 UTC 的 1 天差）：\`${line}\``,
        );
      }
    } else if (diffDays > RELEASE_WINDOW_DAYS) {
      reasons.push(
        `${label}版本标题日期 \`${m[0]}\` 晚于发布日 \`${todayISO}\` 超过 ${RELEASE_WINDOW_DAYS} 天` +
          `（宿主段弱校验：不得写未来日期）：\`${line}\``,
      );
    }
  }

  return { reasons };
}

/**
 * 内核轴判据本体（纯函数，不碰文件系统 ⇒ 可被自检样例直接调用）。
 * @param {string} changelogText CHANGELOG 全文
 * @param {string} version 目标版本（如 `5.0.0`）
 * @param {string} todayISO 发布日 `YYYY-MM-DD`（CI 取当天 UTC；测试可注入）
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function evaluateChangelogVersion(changelogText, version, todayISO) {
  if (isUnreleasedVersion(version)) return { ok: true, reasons: [] };

  const heading = `## [${version}]`;
  const hits = findVersionHeadings(changelogText, version);
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

  reasons.push(...collectDateReasons(hits, heading, todayISO).reasons);
  return { ok: reasons.length === 0, reasons };
}

/**
 * 宿主轴整判据（宿主发版模式）：标题须带 `· 宿主`，日期判据同内核轴（含 ±1 天窗口）。
 * @param {string} changelogText CHANGELOG 全文
 * @param {string} hostVersion 宿主版本（来自 hosts/memora-vscode/package.json）
 * @param {string} todayISO 发布日
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function evaluateHostSection(changelogText, hostVersion, todayISO) {
  if (isUnreleasedVersion(hostVersion)) return { ok: true, reasons: [] };

  const heading = `## [${hostVersion}]`;
  const hits = findVersionHeadings(changelogText, hostVersion, { hostOnly: true });
  const reasons = [];

  if (hits.length === 0) {
    reasons.push(
      `CHANGELOG.md 找不到以 \`${heading}\` 开头且带「${HOST_SECTION_MARK}」的宿主版本标题（该宿主版本无 CHANGELOG 区）`,
    );
    return { ok: false, reasons };
  }
  if (hits.length > 1) {
    reasons.push(
      `CHANGELOG.md 有 ${hits.length} 行以 \`${heading}\` 开头且带「${HOST_SECTION_MARK}」的标题（同版本多区，须人工分诊）`,
    );
  }

  reasons.push(...collectDateReasons(hits, heading, todayISO, { label: '宿主段：' }).reasons);
  return { ok: reasons.length === 0, reasons };
}

/**
 * 宿主轴常开弱校验（内核模式也跟着跑）：只抓「日期写错」——非法日历日期或未来日期。
 * 刻意不判「区不存在 / 同版本多区 / 日期偏旧」：宿主发布日期本就可能早于本次内核发版。
 * @param {string} changelogText CHANGELOG 全文
 * @param {string} hostVersion 宿主版本
 * @param {string} todayISO 发布日
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function evaluateHostSectionWeak(changelogText, hostVersion, todayISO) {
  if (isUnreleasedVersion(hostVersion)) return { ok: true, reasons: [] };

  const hits = findVersionHeadings(changelogText, hostVersion, { hostOnly: true });
  if (hits.length === 0) return { ok: true, reasons: [] };

  const { reasons } = collectDateReasons(hits, `## [${hostVersion}]`, todayISO, {
    label: '宿主段：',
    requireWindow: false,
    allowUnreleased: true,
  });
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

  // ── 轴分流新增（2026-11-13）：Unreleased 豁免 / 宿主段日期 / 窗口边界 ──
  const hostCases = [
    {
      name: '宿主段 [Unreleased] 无日期（应绿 · 无发布日可判）',
      run: () => evaluateHostSection('## [Unreleased] · 宿主\n', 'Unreleased', T),
      expectOk: true,
    },
    {
      name: '宿主段缺日期（应红）',
      run: () => evaluateHostSection(`## [${V}] · 宿主\n`, V, T),
      expectOk: false,
    },
    {
      name: '宿主段未来日期（应红 · 弱校验）',
      run: () => evaluateHostSectionWeak(`## [${V}] · 2099-01-01 · 宿主\n`, V, T),
      expectOk: false,
    },
    {
      name: '宿主模式窗口内（应绿）',
      run: () => evaluateHostSection(`## [${V}] · 2026-10-22 · 宿主\n`, V, T),
      expectOk: true,
    },
    {
      name: '宿主模式窗口外（应红）',
      run: () => evaluateHostSection(`## [${V}] · 2026-10-18 · 宿主\n`, V, T),
      expectOk: false,
    },
    {
      name: '宿主段陈旧真实日期（弱校验应绿 · 宿主可能早于内核发版）',
      run: () => evaluateHostSectionWeak(`## [${V}] · 2026-10-01 · 宿主\n`, V, T),
      expectOk: true,
    },
    {
      name: '宿主段仍写未发布（弱校验应绿 · 内核先发、宿主未发）',
      run: () => evaluateHostSectionWeak(`## [${V}] · 未发布 · 宿主\n`, V, T),
      expectOk: true,
    },
  ];
  for (const c of hostCases) {
    const { ok } = c.run();
    if (ok === c.expectOk) {
      passed += 1;
    } else {
      console.log(`  ✗ ${c.name}：期望 ${c.expectOk ? '绿' : '红'}，实际 ${ok ? '绿' : '红'}`);
    }
  }

  const total = cases.length + hostCases.length;
  console.log(`闸门自检: ${passed}/${total} 样例符合预期`);
  return passed === total;
}

const args = process.argv.slice(2);

/** 作为模块被 import（回归脚本取纯函数）时不跑 CLI；直接执行才进闸门 */
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

/**
 * 把失败原因打印成 GitHub Actions 注解 + 收口行。
 * @param {string[]} reasons 失败原因
 * @param {string} scopeLabel 收口行的范围描述
 */
function emitReasons(reasons, scopeLabel) {
  for (const reason of reasons) {
    // GitHub Actions 会把它渲染成该步骤的注解，直接贴在红灯那一步上
    console.log(`::error::${reason}`);
  }
  console.log(
    `❌ [changelog-version] ${scopeLabel} 标题未通过发布前置校验（${reasons.length} 条）`,
  );
}

/**
 * CLI 主流程：按轴分流执行发版前日期校验。
 * @returns {number} 进程退出码（0 = 通过 / 跳过；1 = 未通过或无法判定）
 */
function main() {
  // 发版模式闸：裸跑只报「跳过」且 exit 0。
  // 非发版日版本区合法写着 [Unreleased]，按当天校验必红 ⇒ 稳定假红会让所有人无视本闸
  //（台账 CHANGELOG-GATE-FAKE-RED-1：比没有闸更坏）。仅发版流水线显式置 RELEASE=1
  // 或注入 RELEASE_DATE 时才做日期校验。
  const releaseDateEnv = process.env.RELEASE_DATE;
  const inReleaseMode = process.env.RELEASE === '1' || releaseDateEnv !== undefined;
  if (!inReleaseMode) {
    console.log(
      '⏭️ [changelog-version] 未处于发版模式，跳过日期校验' +
        '（发版流水线须置 RELEASE=1 或 RELEASE_DATE=YYYY-MM-DD）',
    );
    return 0;
  }

  const changelogText = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  // 发布日：发版模式取当天（UTC）；注入 RELEASE_DATE 可复现/复盘
  const todayISO = releaseDateEnv ?? new Date().toISOString().slice(0, 10);

  // 宿主版本号真源 = 宿主包 package.json；读不到就 fail-closed，不静默跳过宿主轴
  let hostVersion;
  try {
    hostVersion = JSON.parse(readFileSync(HOST_PKG_JSON, 'utf8')).version;
  } catch (error) {
    console.log(
      `::error::[changelog-version] 读取宿主版本失败（${HOST_PKG_JSON}）：${error.message} → fail-closed`,
    );
    return 1;
  }

  // 轴识别：tag ref 前缀 `vscode@` 自动进宿主模式；`RELEASE_AXIS=host/kernel` 可手动覆盖
  const axisOverride = (process.env.RELEASE_AXIS ?? '').trim().toLowerCase();
  const isHostMode =
    axisOverride === 'host' ||
    (axisOverride !== 'kernel' && /^vscode@/.test(process.env.GITHUB_REF_NAME ?? ''));

  if (isHostMode) {
    const { ok, reasons } = evaluateHostSection(changelogText, hostVersion, todayISO);
    if (ok) {
      console.log(
        `✅ [changelog-version] CHANGELOG.md 的宿主段 [${hostVersion}] 标题已带发布日期（发布日 ${todayISO}）`,
      );
      return 0;
    }
    emitReasons(reasons, `CHANGELOG.md 的宿主段 [${hostVersion}]`);
    return 1;
  }

  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  // 内核轴：原判据一字不改；宿主轴：常开弱校验（只抓错字与未来日期）
  const kernelResult = evaluateChangelogVersion(changelogText, version, todayISO);
  const hostWeakResult = evaluateHostSectionWeak(changelogText, hostVersion, todayISO);
  const reasons = [...kernelResult.reasons, ...hostWeakResult.reasons];

  if (reasons.length === 0) {
    console.log(
      `✅ [changelog-version] CHANGELOG.md 的 [${version}] 标题已带发布日期（发布日 ${todayISO}）`,
    );
    console.log(
      `✅ [changelog-version] CHANGELOG.md 的宿主段 [${hostVersion}] 标题日期合法且不晚于发布日（弱校验 · 发布日 ${todayISO}）`,
    );
    return 0;
  }

  emitReasons(reasons, `CHANGELOG.md 的 [${version}]`);
  return 1;
}

if (isDirectRun) {
  process.exit(args.includes('--selfTest') ? (selfTest() ? 0 : 1) : main());
}
