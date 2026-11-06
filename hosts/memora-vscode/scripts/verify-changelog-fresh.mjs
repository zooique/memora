#!/usr/bin/env node
/**
 * 宿主 CHANGELOG 新鲜度闸 —— 产物必须包含根 CHANGELOG 宿主区当轮全部 `### Breaking` 小节
 *
 * 为什么存在（缺口 · 2026-11-07 实测）：
 *   根 `CHANGELOG.md` 已写入 `### Breaking（宿主 · 6.0.0）`，而
 *   `hosts/memora-vscode/CHANGELOG.md` 是 `gen-changelog.mjs` 的**生成物**（被 .gitignore 排除）。
 *   该文件**存在但陈旧**时，`verify-package-manifest` 只判「在不在 vsix 清单里」，
 *   判不出「Breaking 段丢了」⇒ 缺破坏说明的旧 Changelog 会随包上架，
 *   用户升级前看不到破坏点。这是「文件存在 ≠ 内容新鲜」的典型静默失效。
 *
 * 判据（内容比对，不用 mtime）：
 *   源 = 根 CHANGELOG 中标题带 `· 宿主` 的 `##` 块内的所有 `### Breaking…` 标题；
 *   产物 = 宿主 CHANGELOG 内的所有 `### Breaking…` 标题；
 *   要求 **产物集合 ⊇ 源集合**（产物可多，不可少）。
 *
 * 为什么选内容比对而非时间戳比对：
 *   判据要回答的是「**用户能不能看到 Breaking 段**」——标题集合直接对应市场页的段落存在性；
 *   时间戳只说明「文件被 touch 过」，checkout / 复制 / 手工 touch 都能让它变新而内容仍旧，
 *   判据与目的不同源。代价是「正文写错字」查不出——那由根文件与人工评审承担，本闸只守结构。
 *
 * 为什么不会在正常开发误红：
 *   本闸**不进 local-ci / pre-push**（生成物被 gitignore，日常开发本来就不重建）；
 *   只挂在打包链路（`vscode:prepublish` / `package`，两者都先跑 `gen-changelog` 再跑本闸）
 *   与显式 `npm run verify:changelog-fresh`。只有「源有 Breaking、产物无」才红——
 *   那正是要拦的陈旧；生成器自身抽不到 Breaking 时也会在此红，属预期（fail-closed）。
 *
 * 用法：
 *   node scripts/verify-changelog-fresh.mjs              # 主跑
 *   node scripts/verify-changelog-fresh.mjs --self-test  # 自检：变异必须红
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectBreakingHeadings, extractHostSections } from './changelog-host-sections.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = join(HERE, '..');
const REPO_ROOT = join(HOST_ROOT, '..', '..');
/** 根 CHANGELOG（唯一真源） */
const SRC = join(REPO_ROOT, 'CHANGELOG.md');
/** 宿主 CHANGELOG（gen-changelog.mjs 的生成物） */
const OUT = join(HOST_ROOT, 'CHANGELOG.md');

/**
 * 判据本体（纯函数，便于自检注入）。
 *
 * @param {string} sourceText 根 CHANGELOG 全文
 * @param {string} generatedText 宿主 CHANGELOG 全文（可为空 = 文件缺失/空文件）
 * @returns {{ ok: boolean; issues: string[]; expected: string[] }}
 */
export function auditChangelogFresh(sourceText, generatedText) {
  const issues = [];

  // 源侧：先抽宿主区，再收集区内的 Breaking 标题。
  // 一个宿主区都抽不到 = 判据失明（生成器也会 fail-closed）⇒ 直接红，不当作「无 Breaking 可要求」。
  const hostBlocks = extractHostSections(sourceText);
  if (hostBlocks.length === 0) {
    issues.push('根 CHANGELOG 抽不到任何 `· 宿主` 区（标题需形如 `## [x.y.z] · <date> · 宿主`）');
  }
  const expected = collectBreakingHeadings(hostBlocks.join('\n'));

  // 产物侧：生成物只含宿主内容，故其全部 Breaking 标题都算宿主面。
  const actual = new Set(collectBreakingHeadings(generatedText));
  for (const heading of expected) {
    if (!actual.has(heading)) {
      issues.push(`宿主 CHANGELOG 缺根文件宿主区的 Breaking 小节：\`${heading}\``);
    }
  }

  return { ok: issues.length === 0, issues, expected };
}

/**
 * 自检：向判据注入变异，证明「源有、产物无」会红，且合法形态保持绿。
 * @returns {boolean} 全部样例符合预期
 */
function selfTest() {
  /** 宿主区 + 内核区的混合源（内核区 Breaking 不应被要求进宿主产物） */
  const source = [
    '## [Unreleased] · 宿主',
    '### Breaking（宿主 · 6.0.0）',
    '- 宿主破坏项',
    '',
    '## [6.0.0] · 内核',
    '### Breaking（内核 · 6.0.0）',
    '- 内核破坏项',
    '',
  ].join('\n');
  const generatedGood = [
    '# Changelog · memora-vscode（宿主）',
    '## [Unreleased] · 宿主',
    '### Breaking（宿主 · 6.0.0）',
    '- 宿主破坏项',
    '',
  ].join('\n');

  const cases = [
    // ── 应绿 ──
    { name: '源/产物一致（应绿）', src: source, gen: generatedGood, expectOk: true },
    {
      name: '产物多出历史 Breaking（⊇ 语义，应绿）',
      src: source,
      gen: `${generatedGood}\n## [0.7.0] · 宿主\n### Breaking（宿主 · 0.7.0）\n- 历史项\n`,
      expectOk: true,
    },
    {
      name: '源无 Breaking（应绿）',
      src: '## [Unreleased] · 宿主\n- 普通改动\n',
      gen: '# Changelog\n\n## [Unreleased] · 宿主\n- 普通改动\n',
      expectOk: true,
    },
    // ── 应红 ──
    {
      name: '源有宿主 Breaking、产物无（应红 · 本条要拦的形态）',
      src: source,
      gen: '# Changelog\n\n## [Unreleased] · 宿主\n- 只有普通改动\n',
      expectOk: false,
    },
    {
      name: '产物只有内核 Breaking（轴错配，应红）',
      src: source,
      gen: '# Changelog\n\n## [6.0.0]\n### Breaking（内核 · 6.0.0）\n- 内核项\n',
      expectOk: false,
    },
    {
      name: '产物为空文件（应红 · fail-closed）',
      src: source,
      gen: '',
      expectOk: false,
    },
    {
      name: '源抽不到宿主区（应红 · 判据失明）',
      src: '## [6.0.0] · 内核\n### Breaking（内核 · 6.0.0）\n- 内核项\n',
      gen: generatedGood,
      expectOk: false,
    },
  ];

  let passed = 0;
  for (const c of cases) {
    const { ok } = auditChangelogFresh(c.src, c.gen);
    if (ok === c.expectOk) {
      passed += 1;
    } else {
      console.log(`  ✗ ${c.name}：期望 ${c.expectOk ? '绿' : '红'}，实际 ${ok ? '绿' : '红'}`);
    }
  }
  console.log(`[changelog-fresh] 闸门自检: ${passed}/${cases.length} 样例符合预期`);
  return passed === cases.length;
}

function main() {
  if (process.argv.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 1);
  }

  let src;
  try {
    src = readFileSync(SRC, 'utf8');
  } catch (err) {
    console.error(`❌ [changelog-fresh] 读不到根 CHANGELOG：${SRC}（${err.message}）`);
    process.exit(1);
  }

  if (!existsSync(OUT)) {
    console.error(
      '❌ [changelog-fresh] 宿主 CHANGELOG.md 不存在——先跑 `node scripts/gen-changelog.mjs` 生成',
    );
    process.exit(1);
  }
  const generated = readFileSync(OUT, 'utf8');

  const { ok, issues, expected } = auditChangelogFresh(src, generated);
  console.log(
    `[changelog-fresh] 根文件宿主区 Breaking ${expected.length} 段；宿主产物 ${
      collectBreakingHeadings(generated).length
    } 段`,
  );
  if (ok) {
    console.log('✅ [changelog-fresh] 宿主 CHANGELOG 含根文件宿主区全部 Breaking 小节');
    return 0;
  }
  console.error(`❌ [changelog-fresh] ${issues.length} 处新鲜度问题：`);
  for (const s of issues) console.error(`   ${s}`);
  console.error('   处置：改根 CHANGELOG → 重跑 `node scripts/gen-changelog.mjs` → 再跑本闸。');
  return 1;
}

process.exit(main());
