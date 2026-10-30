#!/usr/bin/env node
/**
 * 宿主 CHANGELOG 生成器 —— 从仓库根 `CHANGELOG.md` 抽取「宿主区」，产出扩展根目录的
 * `CHANGELOG.md`（vsce 打包后进 vsix，Marketplace / Open VSX / VS Code 扩展详情页的
 * 「Changelog」标签即由此渲染）。
 *
 * 为什么需要它（缺口 · 2026-10-30 实测）：
 *   0.4.0 已发布 vsix 解包后根目录只有 `readme.md` / `package.json` / `LICENSE.txt`，
 *   **没有 changelog.md** ⇒ 扩展详情页的 Changelog 标签为空。两个原因叠加：
 *   ① `hosts/memora-vscode/` 自己从来没有 CHANGELOG.md（只有仓库根有，根文件写的是内核
 *      npm 包 + 宿主混合内容）；② `.vscodeignore` 的 `*.md` 会排除一切 md，只放行 README。
 *
 * 为什么不手写一份：根 `CHANGELOG.md` 已是「改了什么」的唯一真源，手抄第二份必然漂移
 * （同族教训：同一事实两处登记必漂移）。故本文件是**生成物**，不入版本库
 * （见 `hosts/memora-vscode/.gitignore`），每次打包前重建。
 *
 * 抽取判据：标题行形如 `## [0.4.0] · 2026-10-29 · 宿主`（`· 宿主` 后缀 = 该区属宿主）。
 *   区块终止于下一个 `^## ` —— 与根文件的区结构同源，不另立一套解析规则。
 *
 * 空集 fail-closed：根文件里一个宿主区都抽不到 ⇒ **判红退出 1**，不生成空文件。
 *   静默产出「空 changelog」会让市场页显示一个空标签，比没有更糟（用户以为项目死了）。
 *
 * 用法：
 *   node scripts/gen-changelog.mjs            # 生成 CHANGELOG.md
 *   node scripts/gen-changelog.mjs --check    # 只校验能否抽到（不写盘）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = join(HERE, '..');
const REPO_ROOT = join(HOST_ROOT, '..', '..');
const SRC = join(REPO_ROOT, 'CHANGELOG.md');
const OUT = join(HOST_ROOT, 'CHANGELOG.md');

/** 宿主区标题：`## [x.y.z] · <date> · 宿主`（`· 宿主` 是根文件既有的轴标记，ADR-033） */
const HOST_SECTION_RE = /^## \[\d+\.\d+\.\d+\][^\n]*·\s*宿主\s*$/;

const HEADER = `# Changelog · memora-vscode（宿主）

> **本文件是生成物，不要手改** —— 由 \`scripts/gen-changelog.mjs\` 从仓库根 \`CHANGELOG.md\`
> 的**宿主区**（标题带 \`· 宿主\`）自动抽取。改内容请改根文件，否则下次打包被覆盖。
>
> **只含宿主（VS Code 扩展）变更**；内核 \`@zooique/memora\` 的条目不在本文件——两个包各按
> 自己的版本号成区（ADR-033），本文件随 \`vsce package\` 定版。
>
> 条目里出现的 \`IMG-1\` / \`COPY-1\` 这类大写短标识是内部缺陷追踪号，读者可忽略；
> 每条末尾的「**对消费者**」一段才是使用者关心的行为变化。
`;

function extractHostSections(text) {
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

function main() {
  const checkOnly = process.argv.includes('--check');
  let src;
  try {
    src = readFileSync(SRC, 'utf8');
  } catch (err) {
    console.error(`❌ [gen-changelog] 读不到根 CHANGELOG：${SRC}（${err.message}）`);
    process.exit(1);
  }

  const blocks = extractHostSections(src);
  if (blocks.length === 0) {
    console.error(
      '❌ [gen-changelog] 根 CHANGELOG 里抽不到任何宿主区（标题需形如 `## [0.4.0] · 2026-10-29 · 宿主`）' +
        '——判据失明比假绿更危险，拒绝生成空文件',
    );
    process.exit(1);
  }

  const body = `${HEADER}\n${blocks.join('\n\n')}\n`;
  if (checkOnly) {
    console.log(`✅ [gen-changelog] 可抽到 ${blocks.length} 个宿主区（--check 未写盘）`);
    return;
  }
  writeFileSync(OUT, body, 'utf8');
  console.log(
    `✅ [gen-changelog] 已生成 ${OUT}（${blocks.length} 个宿主区 / ${body.split('\n').length} 行）`,
  );
}

main();
