/**
 * 发布边界 · 出货文档死链检查器（D8 · 2026-09-12）
 *
 * 定位（C7 收口后的防回归闸门）：
 *   `package.json#files` 白名单才是「进发布包」的实锤边界。出货 `.md` 里的相对链接若解析到
 *   白名单之外，npm 消费者点开即 404 —— 但**在仓库内它往往是好的**，所以人工审查极易漏判
 *   （C7 初版只数出 3 处，本检查器实测 10 处）。
 *
 * 双条件判据（缺一不可，只查一半会误判）：
 *   ① **目标在磁盘上存在** —— 不满足 = 连仓库内都是断的（真 bug，如路径深度写错）；
 *   ② **目标在发布白名单内** —— 不满足 = 仅 npm 消费者断（发布边界缺陷）。
 *   另：`package.json` 等属 npm **强制随包**文件（与 `files` 无关），不得误报。
 *
 * 用法：
 *   npx tsx scripts/check-publish-links.ts          # 打印报告，有问题 exit 1
 *
 * 设计纪律：纯 FS、零三方依赖、零网络、确定性（与 `eval:budget` 同型），可进 CI。
 *           不修改任何文件；只读盘点 + 退出码。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** npm 无论 `files` 如何配置都会随包的文件（误报源，必须豁免） */
const ALWAYS_SHIPPED = new Set([
  'package.json',
  'README.md',
  'README.en.md',
  'LICENSE',
  'CHANGELOG.md',
]);

/** 不入包且体量巨大的目录（遍历性能考虑；node_modules 永不随包） */
const SKIP_DIRS = new Set(['node_modules', '.git']);

interface Finding {
  file: string;
  line: number;
  raw: string;
  resolved: string;
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  files?: string[];
};
const ALLOW = (pkg.files ?? []).map((f) => f.replace(/\\/g, '/'));

function isShipped(rel: string): boolean {
  const r = rel.replace(/\\/g, '/');
  if (ALWAYS_SHIPPED.has(r)) return true;
  return ALLOW.some((e) => r === e || r.startsWith(`${e}/`));
}

/** 收集所有随包的 markdown 文件（遍历含 dist，避免 .md 落进 dist 时的盲区） */
function collectShippedMarkdown(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      collectShippedMarkdown(abs, out);
      continue;
    }
    if (!name.endsWith('.md')) continue;
    const rel = relative(ROOT, abs).replace(/\\/g, '/');
    if (isShipped(rel)) out.push(rel);
  }
}

const LINK_RE = /\]\(([^)]*)\)/g;

function isExternal(target: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(target);
}

/** 去片段、解码转义（如 %20），失败则原样返回 */
function normalizeTarget(raw: string): string {
  const noHash = raw.indexOf('#') >= 0 ? raw.slice(0, raw.indexOf('#')) : raw;
  const trimmed = noHash.trim();
  if (!trimmed) return '';
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

const missing: Finding[] = [];
const unshipped: Finding[] = [];

const shippedMd: string[] = [];
collectShippedMarkdown(ROOT, shippedMd);
shippedMd.sort();

for (const rel of shippedMd) {
  const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(line)) !== null) {
      const raw = m[1].trim();
      if (!raw || raw.startsWith('#') || isExternal(raw)) continue;
      const target = normalizeTarget(raw);
      if (!target) continue;
      const resolved = relative(ROOT, resolve(dirname(join(ROOT, rel)), target)).replace(/\\/g, '/');
      const rec: Finding = { file: rel, line: i + 1, raw, resolved };
      if (!existsSync(join(ROOT, resolved))) missing.push(rec);
      else if (!isShipped(resolved)) unshipped.push(rec);
    }
  });
}

const total = missing.length + unshipped.length;

console.log(`发布边界死链检查 · 随包 markdown ${shippedMd.length} 个 · 白名单 ${ALLOW.length} 项`);

if (missing.length) {
  console.log(`\n[A] 目标在磁盘上不存在（连仓库内都是断的）: ${missing.length}`);
  for (const f of missing) console.log(`  ${f.file}:${f.line}  ->  ${f.raw}   (解析为 ${f.resolved})`);
} else {
  console.log('\n[A] 目标在磁盘上不存在: 0');
}

if (unshipped.length) {
  console.log(`\n[B] 目标存在但不在发布包（仅 npm 消费者断）: ${unshipped.length}`);
  for (const f of unshipped) console.log(`  ${f.file}:${f.line}  ->  ${f.raw}   (解析为 ${f.resolved})`);
} else {
  console.log('\n[B] 目标存在但不在发布包: 0');
}

console.log(`\n合计: ${total}`);

if (total > 0) {
  console.log(
    '\n修法纪律：默认**不扩白名单**（扩 = 把内部分析文档重新塞回 npm 包，与「发布面收窄」相反）。\n' +
      '  · 指向内部文档 → 去链接化、使散文自足；\n' +
      '  · 出货文档已有内容 → 改指向随包 SSOT。',
  );
  process.exit(1);
}
console.log('\nOK：出货文档无越界链接。');
