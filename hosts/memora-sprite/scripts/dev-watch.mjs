/**
 * dev-watch.mjs — Electron 开发模式增量编译 + 自动重启
 *
 * 职责：
 * 1. 启动 tsc --watch（主进程 ESM 增量编译）
 * 2. 监听 src/electron/renderer/ 下 HTML/CSS/JSON 变更，自动复制到 dist-electron
 * 3. 首次编译完成后启动 electron
 * 4. 主进程 TS 变更且增量编译成功时，自动重启 electron
 *
 * 设计取舍（遵循自然生长原则）：
 * - 不监听 preload.ts：preload 编译后需经 build-preload.mjs 转 .cjs，
 *   watch 集成成本高；preload 变更频率低，修改后请手动 Ctrl+C 重启 dev:electron
 * - 不做 HMR：用 electron 整体重启代替，简单可靠，零新增依赖
 * - 零新增依赖：使用 Node 22 原生 fs.watch 递归监听（Windows 原生支持）
 *
 * 前置条件：dev:electron npm 脚本已执行 chcp 65001 + build:electron + 设置 NODE_ENV
 */

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── 路径常量 ─────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
/** 项目根目录 */
const ROOT = join(__dirname, '..');
/** electron 编译产物目录 */
const DIST_ELECTRON = join(ROOT, 'dist-electron', 'electron');
/** renderer 源码目录（监听静态资源变更） */
const RENDERER_SRC = join(ROOT, 'src', 'electron', 'renderer');

// ─── 运行时状态 ──────────────────────────────────────
/** 首次编译是否已完成（用于区分"首次启动"和"增量重启"） */
let firstCompileDone = false;
/** 当前 electron 子进程（重启时先 kill 再 spawn） */
let electronProc = null;

// ─── 1. 启动 tsc --watch（主进程增量编译）─────────────
// shell: true 让 Windows 能找到 tsc.cmd
const tscProc = spawn('tsc', ['-p', 'tsconfig.electron.json', '--watch'], {
  cwd: ROOT,
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: true,
});

// 监听 tsc stdout，检测编译完成信号
tscProc.stdout.on('data', (data) => {
  const out = data.toString();
  process.stdout.write(`[tsc] ${out}`);
  // TypeScript watch 模式编译完成信号："Found 0 errors. Watching for file changes."
  if (out.includes('Found 0 errors')) {
    onCompileSuccess();
  }
});

tscProc.stderr.on('data', (data) => {
  process.stderr.write(`[tsc] ${data}`);
});

tscProc.on('exit', (code) => {
  console.error(`[dev-watch] tsc 进程退出，code=${code}`);
  cleanupAndExit(code ?? 1);
});

// ─── 2. 编译成功回调 ─────────────────────────────────
/** 编译成功时触发：首次启动 electron，或增量重启 electron */
function onCompileSuccess() {
  if (!firstCompileDone) {
    firstCompileDone = true;
    console.log('[dev-watch] 首次编译完成，启动 electron...');
    startElectron();
  } else {
    console.log('[dev-watch] 增量编译完成，重启 electron...');
    restartElectron();
  }
}

// ─── 3. 启动 / 重启 electron ────────────────────────
/** 启动 electron 子进程（继承父进程 env，包含 NODE_ENV=development） */
function startElectron() {
  electronProc = spawn('electron', ['./dist-electron/electron/main.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true, // Windows 需 shell 找到 electron.cmd
  });

  electronProc.on('exit', (code) => {
    console.log(`[dev-watch] electron 退出，code=${code}`);
    // electron 退出（窗口关闭）→ 整个 dev 流程结束
    cleanupAndExit(code ?? 0);
  });
}

/** 重启 electron：先 kill 旧进程，等其退出后再启动新进程 */
function restartElectron() {
  if (!electronProc) {
    startElectron();
    return;
  }
  // 移除旧的 exit 监听器（避免触发 cleanupAndExit）
  electronProc.removeAllListeners('exit');
  // 注册一次性 exit 回调：旧进程退出后启动新进程
  electronProc.once('exit', () => {
    electronProc = null;
    startElectron();
  });
  // Windows 上 SIGTERM 会被翻译成 TerminateProcess（强制 kill）
  electronProc.kill('SIGTERM');
}

// ─── 4. 监听 renderer 静态资源变更 ──────────────────
// Node 22 原生 fs.watch recursive 在 Windows 上原生支持
watch(RENDERER_SRC, { recursive: true }, (eventType, filename) => {
  if (!filename) return;
  // 只处理 HTML/CSS/JSON 静态资源（.ts 由 tsc 处理）
  if (/\.(html|css|json)$/i.test(filename)) {
    console.log(`[dev-watch] 静态资源变更: ${filename}，触发复制...`);
    // 全量复制 renderer 目录到 dist-electron（操作轻量，不做防抖）
    spawn('node', ['scripts/copy-renderer.mjs'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
    });
  }
});

// ─── 5. 进程退出清理 ─────────────────────────────────
/** 清理所有子进程并退出主进程 */
function cleanupAndExit(code) {
  if (electronProc) {
    try {
      electronProc.kill('SIGTERM');
    } catch {
      // 进程可能已退出，忽略
    }
  }
  if (tscProc) {
    try {
      tscProc.kill('SIGTERM');
    } catch {
      // 进程可能已退出，忽略
    }
  }
  process.exit(code);
}

// Ctrl+C 触发（Node.js 在 Windows 上模拟 SIGINT 事件）
process.on('SIGINT', () => {
  console.log('\n[dev-watch] 收到 Ctrl+C，正在退出...');
  cleanupAndExit(0);
});

process.on('SIGTERM', () => {
  cleanupAndExit(0);
});

console.log('[dev-watch] 启动中：tsc --watch 监听 src/electron/ 变更...');
