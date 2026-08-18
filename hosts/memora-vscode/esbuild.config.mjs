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
 *   ├── extension/role-packs      ← 内置角色包（manifest.json + persona/rules/skills .md，copy 处理）
 *   └── extension/skills          ← 全局技能池（.md，所有角色共享，SkillManager 扫描）
 */
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, existsSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');
const SRC = join(__dirname, 'src');

/**
 * 递归复制资产目录（esbuild 不处理 .md/.json，插件内置角色包和全局技能需随 dist 分发）
 *
 * 角色包目录（src/extension/role-packs/<名>/）由内核 RolePackManager 从
 * configDir/role-packs/ 扫描装载（manifest.json + persona.md + rules.md + skills/）。
 * 全局技能目录（src/extension/skills/）由内核 SkillManager 从
 * configDir/skills/ 扫描装载（所有角色共享的通用技能）。
 *
 * @param srcDir 源资产目录
 * @param outDir 输出资产目录
 */
function copyAssetsRecursive(srcDir, outDir) {
  if (!existsSync(srcDir)) return;
  mkdirSync(outDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    const outPath = join(outDir, entry);
    if (statSync(srcPath).isDirectory()) {
      copyAssetsRecursive(srcPath, outPath);
    } else {
      copyFileSync(srcPath, outPath);
    }
  }
}

/** 复制内置角色包目录（manifest.json + persona.md + rules.md + skills/） */
function copyRolePacks() {
  copyAssetsRecursive(join(SRC, 'extension', 'role-packs'), join(DIST, 'extension', 'role-packs'));
}

/** 复制全局技能池（.md 文件，所有角色共享） */
function copyGlobalSkills() {
  copyAssetsRecursive(join(SRC, 'extension', 'skills'), join(DIST, 'extension', 'skills'));
}

async function main() {
  // 1. 复制内置角色包 + 全局技能（esbuild 不处理 .md/.json）
  copyRolePacks();
  copyGlobalSkills();

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

  // 3. esbuild 打包 webview 运行时脚本（browser/iife，供 webview.asWebviewUri 引用）
  //    阶段 B（P2-1）：以 *Main 入口打包「定义 + 自执行」IIFE（CSP 'self' 下无法用
  //    内联脚本调用工厂）；outfile 与面板引用的 chatView.js/settingsView.js 对齐，
  //    覆盖 tsc 的同名 ESM 编译产物（tsc 负责类型检查，esbuild 负责产出）。
  //    注：纯 tsc watch 开发模式下 webview 脚本不 bundle（生产 compile 才正确），
  //    如需 watch 可后续补 webview 脚本的 esbuild --watch。
  const webviewScripts = [
    { entry: 'chatViewMain.ts', out: 'chatView.js' },
    { entry: 'settingsViewMain.ts', out: 'settingsView.js' },
  ];
  for (const { entry, out } of webviewScripts) {
    await esbuild.build({
      entryPoints: [join(SRC, 'webview', 'scripts', entry)],
      outfile: join(DIST, 'webview', 'scripts', out),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      sourcemap: true,
      minify: false,
      keepNames: true,
    });
  }
  console.log('✅ esbuild webview 打包完成：dist/webview/scripts/');
}

main().catch((err) => {
  console.error('❌ esbuild 构建失败:', err);
  process.exit(1);
});