/**
 * 远程契约 fixture 生成器运行器
 *
 * 为什么用 esbuild 现打包而不是引 tsx / vite-node：宿主已有 esbuild（构建同源），
 * 另加一个 TS 运行器依赖只为跑一个脚本，是把工具链复杂度换成了依赖债。
 *
 * 用法（宿主包目录）：
 *   npm run fixtures:gen            # 写盘（唯一写入口）
 *   npm run fixtures:check          # 只读校验：已提交样本是否与当前桥一致（门禁用）
 *
 * `--check` 是跨仓契约新鲜度的唯一可信判据：真源在宿主，手机仓离开宿主无法自证样本是否过期。
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
  if (process.argv.includes('--check')) {
    // 只读校验：不写盘；不一致即非零退出，交给门禁判定
    const mismatched = mod.check({ hostDir });
    if (mismatched.length > 0) {
      console.error(`STALE ${mismatched.length} file(s) — 运行 npm run fixtures:gen 重新生成`);
      for (const file of mismatched) console.error(`  ${file}`);
      process.exitCode = 1;
    } else {
      console.log('FIXTURES_OK 样本与当前桥一致');
    }
  } else {
    const written = mod.generate({ hostDir });
    console.log(`WROTE ${written.length} files`);
    for (const file of written) console.log(`  ${file}`);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
