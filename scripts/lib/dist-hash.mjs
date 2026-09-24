/**
 * 内核 dist 内容哈希 — 单一真理源（SSOT）
 *
 * 为什么单独成文件：
 *   「宿主 bundle 是否与内核 dist 同代」这一判据需要**两处**计算同一个量——
 *   ① 宿主构建期写入构建戳（`hosts/memora-vscode/esbuild.config.mjs`）
 *   ② 门禁校验期比对当前值（`scripts/verify-dist-contract.mjs`）
 *   若两处各自实现，即构成「同语义多实现」（legacy-contract-audit-rules「重复实现」），
 *   一处改口径就会静默产生永久假绿/假红。故收敛到本文件，两处只 import。
 *
 * 口径（改口径＝改判据，须带观测与退出条件）：
 *   - 只取 `dist/**` 下 `.js` 与 `.d.ts`：这是内核对外可消费的产物面；
 *     `.map`（sourcemap）含绝对路径等不稳定内容，纳入会让哈希随机漂移；
 *   - 排除 `__tests__`：测试产物不参与对外契约，纳入会让「只动测试」也判宿主陈旧；
 *   - 先按相对路径字典序排序，再逐文件喂 `relpath\0content\0`，保证顺序无关且无拼接歧义。
 *
 * @param {string} kernelRoot 内核仓库根（含 dist/ 与 package.json 的那一层）
 * @returns {string | null} 小写十六进制的 sha256；`dist/` 不存在时返回 null
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export function hashKernelDist(kernelRoot) {
  const distDir = join(kernelRoot, 'dist');
  if (!existsSync(distDir)) return null;

  /** @type {string[]} */
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts')) continue;
      files.push(full);
    }
  };
  walk(distDir);
  files.sort();

  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(distDir, file).split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}
