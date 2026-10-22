#!/usr/bin/env node
/**
 * 发布前置护栏：随包文档不得陈述「发布态」
 *
 * 为什么存在（缺口 · 2026-10-23 实证，台账 RELEASE-DOCS-STATE-1）：
 *   `@zooique/memora@5.0.0` 的 tarball 里，`docs/memora-api-reference.md` 与 `docs/memora-接入指南.md`
 *   都写着「npm 已发布最新为 v4.0.0、v5.0.0 待发布」——而这两个文件在 `package.json` 的 `files`
 *   白名单内 ⇒ 装了 5.0.0 的人打开手册，第一行被告知「v5.0.0 待发布」。
 *   npm tarball **不可变**、已发布版本**不可重发** ⇒ 这是**永久**的自相矛盾。
 *
 * 根因（第一性原理，不是「忘了改」）：
 *   「最新已发版本是哪个」是**只在发布那一刻由外部系统（npm registry）决定**的事实，
 *   却被写进随包的**静态** md ⇒ 静态文本承载随时间失效的外部状态，**必然腐化**。
 *   与「人有没有记得核对」无关——人工核对只是把腐化概率降低，不消除它。
 *
 *   ⇒ 因此本仓的修法是**两层**，本闸只是第二层：
 *     ① 治本（已落地）：随包文档**不写发布态的值**，只**指向真源**
 *        （「最新已发布版本以 npm registry 为准」）——不陈述值，就无从腐化。
 *     ② 治标（本闸）：把「不准陈述发布态」变成机器闸，防回潮。
 *
 * 判据（双轨 · 按「断言的结构」而非纯词表）：
 *   一条发布态断言 = **主语（版本号）+ 谓语（相对发布态词）**。二者共现才构成断言，
 *   这个结构让「指向真源」的合法表述天然通过——它没有主语（不含版本号）。
 *
 *   ① 强信号轨：行内含**强发布态词**（待发布 / 未发布 / 尚未发布 / 即将发布 /
 *       待上架 / 即将上架 / Unreleased / upcoming / awaiting release）⇒ **红**，无需版本号。
 *       这些词本身就是「状态未定」的断言，主语隐含也成立。
 *       对应实证破法：`v5.0.0 待发布`。
 *   ② 弱信号轨：行内含**弱发布时间词**（最新 / latest）**且**含版本号（`v?X.Y.Z`）⇒ 红。
 *       单有「最新」而无版本号 ⇒ 绿（= 指向真源的合法句式，如
 *       「最新已发布版本以 npm registry 为准」）。
 *       对应实证破法：`npm 已发布最新为 v4.0.0`。
 *
 *   ⚠️ 刻意**不**把「已发布」等**绝对态词**列为禁词：`4.0.0（npm 已发布）` 陈述的是
 *   **历史既成状态**，永久为真，不随时间失效 ⇒ 不是本闸要防的腐化。禁了就是误伤。
 *   ⚠️ 判据是**行内**共现，不跨行：相邻两行各带一半不构成断言（避免跨段误伤）。
 *
 * 扫描面（自动发现，不硬编码文件清单）：
 *   从 `package.json` 的 `files` 白名单展开：目录递归收 `*.md`，文件按后缀收。
 *   ⇒ 将来往 `files` 里加文档，**自动进扫描面**，不会漏。
 *   `CHANGELOG.md` 排除：它有**专用闸** `verify-changelog-version.mjs`，且其历史区
 *   **合法地**写着发布态（如「3.0.0 尚未发布」是史料）。两闸分工，不重复覆盖。
 *
 * 诚实边界（不装万能）：
 *   本闸覆盖「版本号 + 相对态词」这一族——历史上真实出现过的破法都在其中。
 *   但**同义改写**（如「这个版本还没推上去」）任何正则都挡不住。真正的兜底是
 *   ① 治本层（随包文档根本不写发布态）+ 维护约定，不是把词表加到无限长。
 *
 * 挂点（**刻意只挂 release.yml**，与 verify-changelog-version 同族同理）：
 *   不进 `local-ci`（pre-push）——本闸只在「版本确定要出包」这一刻才有意义。
 *
 * 用法：
 *   node scripts/verify-publish-docs.mjs             # 校验随包 md
 *   node scripts/verify-publish-docs.mjs --selfTest  # 闸门自检（样例：绿 / 红 / 边界）
 *   node scripts/verify-publish-docs.mjs --list      # 只打印扫描面，不校验
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 强信号：这些词本身就是「状态未定」断言，无需版本号即可定性 */
const STRONG_STATE_TOKENS = [
  '待发布',
  '未发布',
  '尚未发布',
  '即将发布',
  '待上架',
  '即将上架',
  'Unreleased',
  'unreleased',
  'upcoming',
  'awaiting release',
];

/** 弱信号：必须与版本号共现才构成断言（单出现多是指向真源的合法句式） */
const WEAK_STATE_TOKENS = ['最新', 'latest', 'Latest'];

/** 版本号形态：`5.0.0` / `v5.0.0` / `5.0.0-beta.1` —— 断言的主语 */
const VERSION_RE = /\bv?\d+\.\d+\.\d+(?:-[\w.]+)?\b/;

/** CHANGELOG 走专用闸（其历史区合法记载发布态），本闸不重复覆盖 */
const EXCLUDED_BASENAMES = new Set(['CHANGELOG.md']);

/**
 * 判据本体（纯函数，不碰文件系统 ⇒ 可被自检样例直接调用）。
 * @param {string} text 单篇 md 全文
 * @param {string} relPath 相对仓库根的路径（仅用于报告定位）
 * @returns {{ ok: boolean, findings: string[] }}
 */
export function evaluatePublishDocs(text, relPath = '<inline>') {
  const findings = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    const strong = STRONG_STATE_TOKENS.find((t) => line.includes(t));
    if (strong) {
      findings.push(
        `${relPath}:${i + 1} 含「${strong}」——随包文档不得陈述发布态 ` +
          `(发布态真源 = npm registry；包内写它就是第二真源，必然腐化)\n      ${line.trim()}`,
      );
      return;
    }

    const weak = WEAK_STATE_TOKENS.find((t) => line.includes(t));
    if (weak && VERSION_RE.test(line)) {
      findings.push(
        `${relPath}:${i + 1} 同时出现「${weak}」与版本号——构成「某版本是当前最新」的断言，` +
          `该断言只在发布那一刻为真，随包发出即腐化。改为指向真源 ` +
          `(「最新已发布版本以 npm registry 为准」，不带版本号)\n      ${line.trim()}`,
      );
    }
  });

  return { ok: findings.length === 0, findings };
}

/**
 * 从 package.json 的 files 白名单展开随包 md（自动发现，不硬编码）。
 * @param {string} root 仓库根
 * @param {string[]} entries package.json 的 files 条目
 * @returns {string[]} 相对路径列表
 */
export function collectPackagedMarkdown(root, entries) {
  const out = [];
  const walk = (dirRel) => {
    let items;
    try {
      items = readdirSync(join(root, dirRel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const childRel = `${dirRel}/${it.name}`;
      if (it.isDirectory()) {
        if (it.name === 'node_modules' || it.name.startsWith('.')) continue;
        walk(childRel);
      } else if (extname(it.name).toLowerCase() === '.md') {
        out.push(childRel);
      }
    }
  };

  for (const e of entries) {
    const abs = join(root, e);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // 白名单指向尚不存在的路径：跳过，不红（files 由 pack 自己校验）
    }
    if (st.isDirectory()) {
      walk(e);
    } else if (extname(e).toLowerCase() === '.md') {
      out.push(e);
    }
  }

  return out
    .filter((p) => !EXCLUDED_BASENAMES.has(basename(p)))
    .map((p) => p.replace(/\\/g, '/'))
    .sort();
}

/** 闸门自检：证明本闸**真能红**（只绿不红的闸门等于没有闸门） */
function selfTest() {
  const cases = [
    {
      name: '合法 · 指向真源不带版本号（应绿）',
      text: '> **最新已发布版本**：以 npm registry 为准（`npm view @zooique/memora dist-tags.latest`），不在包内复述。',
      expectOk: true,
    },
    {
      name: '合法 · 历史绝对态不改值（应绿）',
      text: '> 数据口径：4.0.0（npm 已发布）与 5.0.0（本仓库）的 `dist/index.d.ts` 导出面',
      expectOk: true,
    },
    {
      name: '合法 · 只标自身版本无状态词（应绿）',
      text: '# Memora 内核 API 参考手册（v5.0.0）\n\n> **版本**：v5.0.0（对齐当前内核包版本 `package.json`）',
      expectOk: true,
    },
    {
      name: '红 · 5.0.0 实证破法：版本号 + 待发布（应红）',
      text: '> **当前内核版本**：v5.0.0（对齐 `package.json`；npm 已发布最新为 v4.0.0、v5.0.0 待发布）',
      expectOk: false,
    },
    {
      name: '红 · 弱信号：latest + 版本号（应红）',
      text: 'npm latest is v4.0.0, see registry.',
      expectOk: false,
    },
    {
      name: '红 · 英文 Unreleased 无需版本号（应红）',
      text: '## [Unreleased] · 宿主\n\n- 挂起渲染待补',
      expectOk: false,
    },
    {
      name: '边界 · 「最新」不带版本号应放行（应绿）',
      text: '详见最新文档与 npm registry。',
      expectOk: true,
    },
    {
      name: '边界 · 版本号与弱信号跨行不共现（应绿）',
      text: '## 版本 v4.0.0 说明\n\n见最新文档。',
      expectOk: true,
    },
  ];

  let passed = 0;
  for (const c of cases) {
    const { ok } = evaluatePublishDocs(c.text, '<selftest>');
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

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const files = Array.isArray(pkg.files) ? pkg.files : [];
const targets = collectPackagedMarkdown(ROOT, files);

if (args.includes('--list')) {
  console.log(`随包 md 扫描面（${targets.length} 个，来自 package.json files 白名单）：`);
  for (const t of targets) console.log(`  - ${t}`);
  process.exit(0);
}

if (targets.length === 0) {
  console.log(
    '::error::随包 md 扫描面为空 —— 判据失明比假绿更危险（检查 package.json 的 files 字段）',
  );
  process.exit(1);
}

let findings = [];
for (const rel of targets) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const r = evaluatePublishDocs(text, rel);
  findings = findings.concat(r.findings);
}

if (findings.length === 0) {
  console.log(`✅ [publish-docs] 随包 md ${targets.length} 个，无发布态陈述`);
  process.exit(0);
}

for (const f of findings) {
  console.log(`::error::${f.split('\n')[0]}`);
}
console.log(
  `❌ [publish-docs] 随包文档存在发布态陈述 ${findings.length} 处（扫 ${targets.length} 个 md）` +
    ` —— 发布态真源在 npm registry，包内复述即第二真源，必然腐化`,
);
process.exit(1);
