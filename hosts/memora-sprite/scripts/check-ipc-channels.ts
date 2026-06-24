/**
 * P2-R2-02 IPC 通道同步校验脚本
 *
 * 构建时校验 preload.ts 内联的 IPC 通道常量与 ipc/channels.ts 是否一致。
 * 如果 ipc/channels.ts 新增/修改通道但 preload.ts 未同步，此脚本会报错。
 *
 * 集成方式：在 package.json 的 prebuild 或 lint 脚本中调用
 *   "check-ipc": "npx tsx scripts/check-ipc-channels.ts"
 *
 * 用法：npx tsx scripts/check-ipc-channels.ts
 * 退出码：0 = 一致，1 = 不一致
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── 配置 ─────────────────────────────────────────────────

/** 源文件路径（ipc/channels.ts 是真理源，D-07 从 ipcChannels.ts 迁移而来） */
const IPC_CHANNELS_PATH = resolve(import.meta.dirname, '../src/electron/ipc/channels.ts');
/** 目标文件路径（preload.ts 需要与源文件同步） */
const PRELOAD_PATH = resolve(import.meta.dirname, '../src/electron/preload.ts');

// ─── 解析工具 ─────────────────────────────────────────────

/**
 * 从 TypeScript 源码中提取 const 对象的所有键值对
 *
 * 使用正则匹配 `KEY: 'value'` 或 `KEY: "value"` 模式，
 * 跳过注释行和空行。
 *
 * @param source 源码字符串
 * @param objectName 对象变量名（如 'IPC_CHANNELS'）
 * @returns 键值对 Map
 */
function extractChannels(source: string, objectName: string): Map<string, string> {
  const channels = new Map<string, string>();

  // 匹配模式：KEY: 'value' 或 KEY: "value"（忽略注释和空格）
  const regex = /(\w+):\s*['"]([^'"]+)['"]/g;

  // 找到对象定义的起始位置
  const objectStart = source.indexOf(`const ${objectName}`);
  if (objectStart === -1) {
    console.error(`[check-ipc-channels] 错误：未找到 ${objectName} 定义`);
    process.exit(1);
  }

  // 找到对象定义的结束位置（下一个 export 或 const 之前）
  const afterObject = source.slice(objectStart);
  // 简单策略：找到下一个独立 const/export 声明作为边界
  const nextBoundary = afterObject.search(/\n(?:export\s+)?(?:const|interface|type)\s/);
  const objectBlock = nextBoundary === -1 ? afterObject : afterObject.slice(0, nextBoundary);

  // 提取所有键值对
  let match: RegExpExecArray | null;
  while ((match = regex.exec(objectBlock)) !== null) {
    const key = match[1];
    const value = match[2];
    // 跳过 TypeScript 关键字（如 as const）
    if (key === 'as') continue;
    channels.set(key, value);
  }

  return channels;
}

// ─── 主逻辑 ───────────────────────────────────────────────

function main(): void {
  console.log('[check-ipc-channels] 开始校验 IPC 通道同步...');

  // 读取源文件和目标文件
  const ipcSource = readFileSync(IPC_CHANNELS_PATH, 'utf-8');
  const preloadSource = readFileSync(PRELOAD_PATH, 'utf-8');

  let hasErrors = false;

  // 校验两个对象：IPC_CHANNELS 和 MAIN_TO_RENDERER_CHANNELS
  for (const objectName of ['IPC_CHANNELS', 'MAIN_TO_RENDERER_CHANNELS']) {
    const ipcChannels = extractChannels(ipcSource, objectName);
    const preloadChannels = extractChannels(preloadSource, objectName);

    if (ipcChannels.size === 0) {
      console.error(`[check-ipc-channels] 错误：未能从 ipc/channels.ts 提取 ${objectName}`);
      hasErrors = true;
      continue;
    }

    if (preloadChannels.size === 0) {
      console.error(`[check-ipc-channels] 错误：未能从 preload.ts 提取 ${objectName}`);
      hasErrors = true;
      continue;
    }

    // 检查 1：ipc/channels.ts 中的每个通道是否在 preload.ts 中存在且值一致
    for (const [key, value] of ipcChannels) {
      const preloadValue = preloadChannels.get(key);
      if (preloadValue === undefined) {
        console.error(`[check-ipc-channels] 缺失：preload.ts 缺少 ${objectName}.${key} ('${value}')`);
        hasErrors = true;
      } else if (preloadValue !== value) {
        console.error(
          `[check-ipc-channels] 不一致：${objectName}.${key} 值不匹配 —— ipc/channels.ts='${value}' vs preload.ts='${preloadValue}'`,
        );
        hasErrors = true;
      }
    }

    // 检查 2：preload.ts 中是否有 ipc/channels.ts 不存在的通道（多余）
    for (const [key] of preloadChannels) {
      if (!ipcChannels.has(key)) {
        console.error(`[check-ipc-channels] 多余：preload.ts 包含 ipc/channels.ts 不存在的 ${objectName}.${key}`);
        hasErrors = true;
      }
    }
  }

  if (hasErrors) {
    console.error('\n[check-ipc-channels] 校验失败！请同步 preload.ts 与 ipc/channels.ts 的通道定义。');
  console.error('  提示：修改 ipc/channels.ts 后，必须同步更新 preload.ts 中内联的通道常量。');
    process.exit(1);
  }

  console.log('[check-ipc-channels] 校验通过：所有 IPC 通道一致。');
}

main();