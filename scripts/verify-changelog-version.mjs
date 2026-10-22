#!/usr/bin/env node
/**
 * 发布前置护栏：CHANGELOG 目标版本标题不得再带「未发布」
 *
 * 为什么存在（缺口 · 2026-10-23 实证，台账 RELEASE-CHLOG-DATE-1）：
 *   `@zooique/memora@5.0.0` 出包时，`CHANGELOG.md` 的版本标题仍是 `## [5.0.0] · 未发布`。
 *   `CHANGELOG.md` 在 `package.json` 的 `files` 白名单内 ⇒ **随包发出**，而 npm tarball
 *   **不可变**、已发布版本**不可重发** ⇒ npm 消费者看到的 5.0.0 版本区**永久缺发布日期**。
 *   根因不是「忘了改」，而是**该项只写在 deliverables 的人工待办行里，未进任何会跑的清单**
 *   ——`release.yml` 只校验 tag ↔ `package.json` version，对 CHANGELOG 零校验
 *   （又一次：「闸门有实现 ≠ 闸门会跑」，且此处是**闸门压根没覆盖这一步**）。
 *   ⇒ 本脚本把这条人工纪律变成机器闸。
 *
 * 挂点（**刻意只挂 release.yml**）：
 *   不进 `local-ci`（pre-push）：开发期版本区**合法地**写着「未发布」（`deliverables/内核变更报告-4.0.0发布后至今-20261017.md`
 *   明确「保持不动——5.0.0 未发布，『未发布』是事实」），进 pre-push 会**稳定假红** ⇒ 噪音门禁必腐烂。
 *   正确挂点 = 「版本确定要出包」这一刻，即 release.yml。
 *
 * 判据（窄口 · fail-closed）：
 *   ① 目标版本 = 根 `package.json` 的 version（与 release.yml「tag ↔ version」护栏同源，不另立真源）。
 *   ② `CHANGELOG.md` 须**恰好一行**以 `## [<version>]` 开头的版本标题：
 *        0 行 = 该版本无 CHANGELOG 区 ⇒ 红；≥2 行 = 同版本多区 ⇒ 红（歧义，交人工分诊）。
 *      行首锚定避免命中正文里形如「见 [5.0.0]」的引用；`]` 参与匹配避免误吞 `## [5.0.0-beta.1]`。
 *   ③ 该标题行**不得含「未发布」/ `Unreleased`**（本仓中文标题与 Keep a Changelog 英文惯例都出现过）。
 *
 * 用法：
 *   node scripts/verify-changelog-version.mjs            # 校验当前 package.json version
 *   node scripts/verify-changelog-version.mjs --selfTest  # 闸门自检（样例：绿 / 未发布 / 缺区 / 边界）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 「未发布」两类写法：本仓中文标题 + Keep a Changelog 的英文惯例，二者都算漏改 */
const UNRELEASED_TOKENS = ['未发布', 'Unreleased'];

/**
 * 判据本体（纯函数，不碰文件系统 ⇒ 可被自检样例直接调用）。
 * @param {string} changelogText CHANGELOG 全文
 * @param {string} version 目标版本（如 `5.0.0`）
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function evaluateChangelogVersion(changelogText, version) {
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
  for (const line of hits) {
    const token = UNRELEASED_TOKENS.find((t) => line.toLowerCase().includes(t.toLowerCase()));
    if (token) {
      reasons.push(
        `版本标题仍带「${token}」：\`${line}\` —— 出包前须改为实际发布日期（` +
          `已发布版本不可重发，tarball 不可变）`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/** 闸门自检：证明本闸**真能红**（只绿不红的闸门等于没有闸门） */
function selfTest() {
  const V = '9.9.9';
  const cases = [
    { name: '已带发布日期（应绿）', text: `## [${V}] · 2026-10-23\n`, expectOk: true },
    { name: '中文「未发布」（应红）', text: `## [${V}] · 未发布\n`, expectOk: false },
    { name: '英文 Unreleased（应红）', text: `## [${V}] - Unreleased\n`, expectOk: false },
    { name: '该版本无区（应红）', text: `## [9.9.8] · 2026-10-01\n`, expectOk: false },
    {
      name: '同版本多区（应红）',
      text: `## [${V}] · 2026-10-23\n\n## [${V}] · 2026-10-24\n`,
      expectOk: false,
    },
    {
      name: '正文引用不误判（应绿）',
      text: `## [${V}] · 2026-10-23\n\n见 [${V}] 的说明\n`,
      expectOk: true,
    },
    {
      name: '预发布区不算目标版本（应红：`]` 边界）',
      text: `## [${V}-beta.1] · 未发布\n`,
      expectOk: false,
    },
  ];

  let passed = 0;
  for (const c of cases) {
    const { ok } = evaluateChangelogVersion(c.text, V);
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
const { ok, reasons } = evaluateChangelogVersion(changelogText, version);

if (ok) {
  console.log(`✅ [changelog-version] CHANGELOG.md 的 [${version}] 标题已带发布日期`);
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
