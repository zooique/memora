/**
 * esbuild 构建配置 — 将 @zooique/memora 内核内联，vscode 标为 external
 *
 * 目的：
 *   - 解决 file: 依赖的 junction 导致 vsix 把整个项目打包进去的问题
 *   - 减少 vsix 大小（从 150MB+ 降到百 KB 级）
 *   - 加快插件加载速度（单文件，无需 node_modules 解析）
 *
 * 输出结构：
 *   dist/
 *   ├── extension/extension.js    ← 主入口（内联内核 + 插件代码）
 *   ├── shared/protocol.js        ← 类型声明（webview 编译用，不打包）
 *   ├── webview (各面板)          ← webview 侧代码（不打包，不依赖内核）
 *   └── skills (各 .md)           ← skill 文件（esbuild 不动，copy 处理）
 */
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');
const SRC = join(__dirname, 'src');

/** 复制 skills 目录（.md 文件，esbuild 不处理） */
function copySkills() {
  const skillsDir = join(SRC, 'extension', 'skills');
  const outDir = join(DIST, 'extension', 'skills');
  if (!existsSync(skillsDir)) return;
  mkdirSync(outDir, { recursive: true });
  for (const file of readdirSync(skillsDir)) {
    if (file.endsWith('.md')) {
      copyFileSync(join(skillsDir, file), join(outDir, file));
    }
  }
}

async function main() {
  // 1. 复制 skills（esbuild 不处理 .md）
  copySkills();

  // 2. esbuild 打包 extension 入口（内联 @zooique/memora）
  // 输入与输出为同一文件会冲突，先输出到临时文件再替换
  const entry = join(DIST, 'extension', 'extension.js');
  const tmp = join(DIST, 'extension', 'extension.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile: tmp,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    minify: false,
    keepNames: true,
    // vscode / pino 为宿主或可选依赖，不打包
    external: ['vscode', 'pino'],
  });
  // 用打包产物替换原生编译产物
  renameSync(tmp, entry);

  console.log('✅ esbuild 打包完成：dist/extension/extension.js');
}

main().catch((err) => {
  console.error('❌ esbuild 构建失败:', err);
  process.exit(1);
});