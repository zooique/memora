/**
 * 远程契约 fixture 生成器运行器
 *
 * 为什么用 esbuild 现打包而不是引 tsx / vite-node：宿主已有 esbuild（构建同源），
 * 另加一个 TS 运行器依赖只为跑一个脚本，是把工具链复杂度换成了依赖债。
 *
 * 用法（宿主包目录）：npm run fixtures:gen
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 脚本必须从宿主包目录执行（npm run 会保证这一点）
const hostDir = process.cwd();
const tempDir = mkdtempSync(path.join(os.tmpdir(), 'memora-remote-fixtures-'));
const outfile = path.join(tempDir, 'gen.mjs');

try {
  await build({
    entryPoints: [path.join(hostDir, 'scripts', 'gen-remote-fixtures.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href);
  const written = mod.generate({ hostDir });
  console.log(`WROTE ${written.length} files`);
  for (const file of written) console.log(`  ${file}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
