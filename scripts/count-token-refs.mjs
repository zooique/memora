/**
 * 各令牌族「消费引用次数」机械计数（根治批量统计失真 · 2026-10-12）
 *
 * 背景：AXIS-1 维度计数反复人肉失真（24→17、27→14、61→69 多套矛盾数字，连"订正"都在失真）。
 * 本脚本是 tokensClosure.test.ts「各令牌族消费引用数反向守卫」的取数工具——
 * 守卫把数字钉死，本脚本提供人工取数口径，二者口径一致（occurrence，非行数，排除定义层 tokens.ts）。
 *
 * 用法：`node scripts/count-token-refs.mjs`
 * 改 CHANGELOG / 台账前先跑本脚本取数，禁止手数 / grep 行数估算。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STYLES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'hosts',
  'memora-vscode',
  'src',
  'webview',
  'styles',
);

// 与 tokensClosure.test.ts 的 EXPECTED 同源——改一边须同步另一边。
const FAMILIES = ['z-', 'lh-', 'op-', 'icon-', 'dot-', 'line-', 'sq-'];

console.log(`消费引用计数（排除定义层 tokens.ts）： dir=${STYLES_DIR}\n`);
let total = 0;
for (const f of FAMILIES) {
  const re = new RegExp(`var\\(--${f}`, 'g');
  let count = 0;
  for (const name of readdirSync(STYLES_DIR)) {
    if (!name.endsWith('.ts') || name === 'tokens.ts') continue;
    const text = readFileSync(join(STYLES_DIR, name), 'utf8');
    const m = text.match(re);
    if (m) count += m.length;
  }
  console.log(`  var(--${f.padEnd(5)} => ${count}`);
  total += count;
}
console.log(`\n合计（七族）：${total}`);
