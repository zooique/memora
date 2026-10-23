#!/usr/bin/env node
// 内核/宿主发版归档加速脚本（memora-kernel-release / memora-host-release 技能共用）。
//
// 作用：按 `^- **<ID>**` 锚点，从主台账 `tasks/待完成任务.md` 把指定已关闭项整块
//       搬到 `tasks/archive/<version>-<kind>.md`（kind = kernel | host），并在主台账原位留指针行。
//
// 安全模型：
//   - 默认 --dry-run：只打印「将写入的归档文件」与「主台账替换预览」，不落盘。
//   - 必须显式 --apply 才写文件。首次使用务必 `git diff` 人工核对逐字节无损后再提交。
//   - 关闭项 ID 由人判（脚本只做机械切块，不替你决定哪些该归档）。
//
// 用法：
//   node archive-kernel-release.mjs --version 5.1.0 --ids ID1,ID2,ID3
//   node archive-kernel-release.mjs --version 5.1.0 --ids ID1 ID2 --apply
//   node archive-kernel-release.mjs --kind host --version 0.2.0 --ids ID1,ID2 --apply
//   node archive-kernel-release.mjs --kind host --version 0.2.0 --ids ID1,ID2 --append --batch-note "收尾闭合批（ARCH-DRAIN-1 · 2026-10-23）" --apply
//
// ⚠️ --append：归档文件**已存在**时**追加补批**（版本区是混合工作区，发版归档常漏扫混批条目，
//   补批是常态）。语义 = 保留原文件全部内容，仅把新 ID 并入文件头「迁移 ID」行、在文末追加
//   「批次引言 + 条目块」；**不碰原「状态」行**（已发布的不被改回「待上架」）。
//   不加 --append 时对已存在文件**整体覆盖**（仅适用于首次生成，误用会毁掉既有归档）。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

function parseArgs(argv) {
  const args = {
    ids: [],
    apply: false,
    version: null,
    kind: 'kernel',
    repoRoot: process.cwd(),
    append: false,
    batchNote: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--kind') args.kind = argv[++i];
    else if (a === '--append') args.append = true;
    else if (a === '--batch-note') args.batchNote = argv[++i] ?? '';
    else if (a === '--ids') {
      // 支持一次性逗号/空格分隔，也支持多次 --ids
      const v = argv[++i] ?? '';
      v.split(/[,\s]+/)
        .filter(Boolean)
        .forEach((id) => args.ids.push(id));
    } else if (a === '--repo-root') args.repoRoot = argv[++i];
    else if (a === '--ledger') args.ledger = argv[++i];
    else if (a === '--archive-dir') args.archiveDir = argv[++i];
  }
  return args;
}

function fail(msg) {
  process.stderr.write(`❌ ${msg}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.version || !/^\d+\.\d+\.\d+$/.test(args.version)) {
  fail('必须提供合法 --version X.Y.Z');
}
if (args.kind !== 'kernel' && args.kind !== 'host') {
  fail('--kind 只接受 kernel 或 host');
}
if (args.ids.length === 0) {
  fail('必须提供 --ids（逗号或空格分隔的关闭项 ID 列表）');
}

const repoRoot = resolve(args.repoRoot);
const ledgerPath = resolve(repoRoot, args.ledger ?? 'tasks/待完成任务.md');
const archiveDir = resolve(repoRoot, args.archiveDir ?? 'tasks/archive');
const archivePath = resolve(archiveDir, `${args.version}-${args.kind}.md`);

if (!existsSync(ledgerPath)) fail(`主台账不存在：${ledgerPath}`);
const ledgerText = readFileSync(ledgerPath, 'utf8');
const lines = ledgerText.split(/\r?\n/);

// 解析台账条目块：列 0 以 `- **<ID>**` 起，到下一个同形条目或文件末止。
const ENTRY_RE = /^-\s+\*\*([^*]+?)\*\*/;
const blocks = []; // { id, start, end }  end 含
let cur = null;
for (let i = 0; i < lines.length; i++) {
  const m = ENTRY_RE.exec(lines[i]);
  if (m) {
    if (cur) {
      cur.end = i - 1;
      blocks.push(cur);
    }
    cur = { id: m[1].trim(), start: i, end: i };
  }
}
if (cur) {
  cur.end = lines.length - 1;
  blocks.push(cur);
}

const byId = new Map(blocks.map((b) => [b.id, b]));

// 计算替换：要归档的块 → 主台账留指针行。
const toReplace = [];
const missing = [];
for (const id of args.ids) {
  const b = byId.get(id);
  if (!b) missing.push(id);
  else toReplace.push(b);
}
if (missing.length) {
  process.stderr.write(`⚠️ 未在主台账找到以下 ID（跳过）：${missing.join(', ')}\n`);
}
if (toReplace.length === 0) fail('没有任何可归档的 ID，退出。');

// 构建新主台账（替换命中块为指针行）。
const replaceSet = new Set(toReplace.map((b) => b.start));
const newLedgerLines = [];
const pointerSuffix = ` → 见 tasks/archive/${args.version}-${args.kind}.md`;
for (let i = 0; i < lines.length; i++) {
  const b = toReplace.find((x) => x.start === i);
  if (b) {
    newLedgerLines.push(lines[b.start] + pointerSuffix);
    i = b.end; // 跳过块内其余行
    continue;
  }
  if (replaceSet.has(i)) continue; // 保险（理论不触发）
  newLedgerLines.push(lines[i]);
}

// 构建归档文件内容（完整收据，按请求顺序）。
const entryBlocks = [];
for (const b of toReplace) {
  const blk = [];
  for (let i = b.start; i <= b.end; i++) blk.push(lines[i]);
  entryBlocks.push(blk.join('\n'));
}

const useAppend = args.append && existsSync(archivePath);
let archiveLines;
if (useAppend) {
  // 补批：保留原文件，仅更新「迁移 ID」行（并入新 ID），文末追加批次引言 + 条目块。
  const existing = readFileSync(archivePath, 'utf8').split(/\r?\n/);
  const sepIdx = existing.findIndex((l) => l.trim() === '---');
  if (sepIdx === -1) fail(`--append 模式但归档文件无「---」分隔行：${archivePath}`);
  let migratedLine = existing.findIndex((l) => l.startsWith('> 迁移 ID：'));
  if (migratedLine === -1) {
    // 手工头部（无迁移 ID 行）：在「---」前补插一行，并入新 ID。
    existing.splice(sepIdx, 0, `> 迁移 ID：${toReplace.map((b) => b.id).join(' / ')}`);
    migratedLine = sepIdx;
  } else {
    const prevIds = existing[migratedLine].replace(/^> 迁移 ID：/, '').trim();
    const allIds = [prevIds, toReplace.map((b) => b.id).join(' / ')].filter(Boolean).join(' / ');
    existing[migratedLine] = `> 迁移 ID：${allIds}`;
  }
  archiveLines = [
    ...existing,
    '',
    '---',
    '',
    ...(args.batchNote ? [`## ${args.batchNote}`, ''] : []),
    ...entryBlocks.map((e) => [e, '']).flat(),
  ];
} else {
  archiveLines = [
    `# ${args.version} ${args.kind === 'host' ? '宿主' : '内核'}归档`,
    '',
    `> 状态：待上架（发版动作跑完后订正为「已发布」）`,
    `> 本文件由 scripts/archive-kernel-release.mjs 生成（--kind ${args.kind}）；条目 ID 沿用主台账不改。`,
    `> 迁移 ID：${toReplace.map((b) => b.id).join(' / ')}`,
    '',
    '---',
    '',
    ...entryBlocks.map((e) => [e, '']).flat(),
  ];
}

const archiveText = archiveLines.join('\n');
const newLedgerText = newLedgerLines.join('\n');

// 输出。
process.stdout.write('\n========== 将写入归档文件 ==========\n');
process.stdout.write(`${archivePath}\n`);
process.stdout.write(archiveText + '\n');
process.stdout.write('========== 主台账替换预览（原块 → 指针行）==========\n');
for (const b of toReplace) {
  process.stdout.write(`\n[${b.id}] 原块（${b.end - b.start + 1} 行）→ 指针行：\n`);
  process.stdout.write(`  ${lines[b.start] + pointerSuffix}\n`);
}

if (!args.apply) {
  process.stdout.write(
    `\n🔍 当前为 dry-run，未落盘${useAppend ? '（--append 补批模式：保留原归档文件，仅并入迁移 ID + 文末追加）' : ''}。确认无误后加 --apply 执行（建议先 git diff 核对）。\n`,
  );
  process.exit(0);
}

mkdirSync(dirname(archivePath), { recursive: true });
writeFileSync(archivePath, archiveText, 'utf8');
writeFileSync(ledgerPath, newLedgerText, 'utf8');
process.stdout.write(
  `\n✅ 已写入 ${archivePath}\n✅ 已更新 ${ledgerPath}\n` +
    `   下一步：git 提交（归档文件 + 主台账指针），状态标「待上架」，发版后订正为「已发布」。\n`,
);
