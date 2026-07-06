/**
 * electron-builder 打包包装脚本
 *
 * 功能：
 *   1. 解析命令行参数，转发给 electron-builder
 *   2. 配置国内镜像源（npmmirror）+ 显式缓存路径，解决 ETIMEDOUT
 *   3. Windows EPERM 错误自动重试（杀软扫描锁文件是间歇性的）
 *   4. 每次重试前清理 win-unpacked.tmp 残留，避免脏状态
 *   5. 打包成功后自动执行产物完整性验证
 *
 * 用法：
 *   node scripts/package.mjs --win --x64
 *   node scripts/package.mjs --mac
 *   node scripts/package.mjs --linux
 *   node scripts/package.mjs --win --mac --linux
 *
 * 注意：
 *   Windows 下若频繁遇到 EPERM 错误，根因是杀毒软件（腾讯电脑管家、360 等）
 *   实时扫描 electron.exe（213MB）期间锁文件。需在杀软设置里把项目目录加入
 *   信任区/白名单：
 *   - 腾讯电脑管家：病毒查杀 → 信任区 → 添加文件夹
 *   - 360 安全卫士：安全防护 → 信任与阻止 → 添加文件夹
 *   - Windows Defender（若启用）：Add-MpPreference -ExclusionPath "F:\zooique\memora"
 */

import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 项目根目录 */
const projectRoot = join(import.meta.dirname, '..');
/** release 输出目录 */
const releaseDir = join(projectRoot, 'release');

/**
 * 构建环境变量，显式指定 electron 和 electron-builder 缓存路径
 * 避免每次打包重新下载 electron 二进制
 *
 * 同时配置国内镜像源，解决 GitHub 网络访问超时问题（ETIMEDOUT 20.205.243.166:443）
 * - ELECTRON_BUILDER_BINARIES_MIRROR：winCodeSign / nsis / 7zip 等工具的镜像
 * - ELECTRON_MIRROR：electron 二进制本身的镜像
 */
function buildEnv() {
  const env = { ...process.env };
  // Windows: %LOCALAPPDATA%\electron\Cache, macOS: ~/Library/Caches/electron, Linux: ~/.cache/electron
  const platform = process.platform;
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    env.ELECTRON_CACHE = env.ELECTRON_CACHE || join(localAppData, 'electron', 'Cache');
    env.ELECTRON_BUILDER_CACHE = env.ELECTRON_BUILDER_CACHE || join(localAppData, 'electron-builder', 'Cache');
  } else if (platform === 'darwin') {
    env.ELECTRON_CACHE = env.ELECTRON_CACHE || join(homedir(), 'Library', 'Caches', 'electron');
    env.ELECTRON_BUILDER_CACHE = env.ELECTRON_BUILDER_CACHE || join(homedir(), 'Library', 'Caches', 'electron-builder');
  } else {
    env.ELECTRON_CACHE = env.ELECTRON_CACHE || join(homedir(), '.cache', 'electron');
    env.ELECTRON_BUILDER_CACHE = env.ELECTRON_BUILDER_CACHE || join(homedir(), '.cache', 'electron-builder');
  }
  // 镜像源：electron-builder 在 packaging 阶段会去 GitHub 校验/下载 winCodeSign 等工具
  // 即使本地有缓存也会触发网络请求，国内网络经常 ETIMEDOUT
  // 配置 npmmirror 镜像后，请求会走国内 CDN，避免超时
  env.ELECTRON_MIRROR = env.ELECTRON_MIRROR || 'https://registry.npmmirror.com/-/binary/electron/';
  env.ELECTRON_BUILDER_BINARIES_MIRROR =
    env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/';
  console.log(`[package] ELECTRON_CACHE=${env.ELECTRON_CACHE}`);
  console.log(`[package] ELECTRON_BUILDER_CACHE=${env.ELECTRON_BUILDER_CACHE}`);
  console.log(`[package] ELECTRON_MIRROR=${env.ELECTRON_MIRROR}`);
  console.log(`[package] ELECTRON_BUILDER_BINARIES_MIRROR=${env.ELECTRON_BUILDER_BINARIES_MIRROR}`);
  return env;
}

/** 最大重试次数（Windows EPERM 是杀软锁文件导致的间歇性问题，多试几次大概率成功） */
const MAX_RETRIES = 5;
/** 重试间隔（毫秒）—— 给杀软扫描留出时间 */
const RETRY_DELAY_MS = 5000;

/**
 * 清理 release 目录下的残留产物
 *
 * electron-builder 失败时可能留下 win-unpacked.tmp（半成品）或 win-unpacked（脏状态）。
 * 这些残留会让下次重试从脏状态开始，导致后续验证产物不完整。
 * 每次重试前必须彻底清理，让 electron-builder 从头开始解压 + 复制应用文件。
 */
function cleanupResidue() {
  const tmpDir = join(releaseDir, 'win-unpacked.tmp');
  const unpackedDir = join(releaseDir, 'win-unpacked');

  for (const dir of [tmpDir, unpackedDir]) {
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
        console.log(`[package] 已清理残留: ${dir}`);
      } catch {
        console.warn(`[package] 清理失败（可能被占用）: ${dir}`);
        // 清理失败不阻断流程，electron-builder 自己会处理
      }
    }
  }
}

/**
 * 执行 electron-builder 命令
 * @param args 命令行参数数组
 * @returns 是否成功（失败时返回 false，由调用方决定是否重试）
 */
function runElectronBuilder(args) {
  const cmd = `npx electron-builder ${args.join(' ')} --publish=never`;
  console.log(`[package] 执行: ${cmd}`);
  try {
    // stdio: 'inherit' 让 electron-builder 输出直接显示在终端
    execSync(cmd, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: buildEnv(),
    });
    return true;
  } catch {
    // execSync 失败时，检查是否为 Windows EPERM 问题
    // 特征：release/win-unpacked.tmp 目录存在但未成功重命名
    const tmpExists = existsSync(join(releaseDir, 'win-unpacked.tmp'));
    if (tmpExists) {
      console.warn('[package] 检测到 win-unpacked.tmp 残留，疑似 EPERM rename 错误（杀软扫描锁文件）');
    } else {
      console.warn('[package] electron-builder 执行失败（非 EPERM 错误）');
    }
    return false;
  }
}

/**
 * 执行产物验证
 * @param platform 目标平台
 * @returns 是否通过
 */
function verifyPackage(platform) {
  console.log('\n[package] 开始产物验证...');
  try {
    execSync(`node scripts/verify-package.mjs --platform=${platform}`, {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 主函数
 */
async function main() {
  // 解析命令行参数（去掉 node 和 script 路径）
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('[package] 缺少平台参数，用法: node scripts/package.mjs --win --x64');
    process.exit(1);
  }

  // 提取平台信息（用于验证脚本）
  const platformArg = args.find((a) => a.startsWith('--'));
  const platformMap = { '--win': 'win', '--mac': 'mac', '--linux': 'linux' };
  const verifyPlatform = platformMap[platformArg] || 'win';

  // 带重试的打包循环
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`\n[package] === 第 ${attempt}/${MAX_RETRIES} 次打包 ===\n`);

    // 每次重试前清理残留，避免从脏状态开始
    if (attempt > 1) {
      cleanupResidue();
    }

    const success = runElectronBuilder(args);

    if (success) {
      console.log('[package] electron-builder 执行成功');
      if (verifyPackage(verifyPlatform)) {
        console.log('\n[package] 打包流程完成 ✓');
        process.exit(0);
      } else {
        console.error('\n[package] 产物验证失败');
        process.exit(1);
      }
    }

    if (attempt < MAX_RETRIES) {
      console.warn(`[package] ${RETRY_DELAY_MS / 1000}秒后重试...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  console.error(`\n[package] ${MAX_RETRIES} 次重试均失败`);
  console.error('[package] 根因：杀毒软件（腾讯电脑管家、360 等）实时扫描 electron.exe 锁文件');
  console.error('[package] 解决：在杀软设置里把 F:\\zooique\\memora 加入信任区/白名单');
  console.error('[package]   - 腾讯电脑管家：病毒查杀 → 信任区 → 添加文件夹');
  console.error('[package]   - 360 安全卫士：安全防护 → 信任与阻止 → 添加文件夹');
  console.error('[package]   - Windows Defender（若启用）：Add-MpPreference -ExclusionPath "F:\\zooique\\memora"')
  process.exit(1);
}

main();
