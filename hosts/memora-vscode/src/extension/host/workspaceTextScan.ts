/**
 * workspace 用户可见文本文件内容快照（opaque 写工具执行前后 diff 用）
 *
 * 自 `chatPanel.ts` 外置（IMG-12 同批腾行）：本函数是**零 `this` 依赖的纯扫描**——
 * 只吃模块级常量与 vscode workspace 根，不碰面板任何状态，属「纯函数外置」纪律的
 * 标准对象（同 `helpers/occupancyHistory.ts` 先例）。调用面（scriptSnapshots 写前/
 * 写后快照）留在 chatPanel，编排不迁移。
 *
 * 排除 `IGNORED_DIRS`（构建产物 / memora 内部数据），跳过 >2MB 文件与二进制（含 NUL）文件；
 * 返回 `路径→内容` 快照。耗时与 workspace 文本文件数成正比——脚本类工具（run_code 等）低频触发，
 * 且 run_code 跑测试通常不改文件 ⇒ 多数情况快照 diff 为空、零噪音。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { IGNORED_DIR_NAMES } from '@zooique/memora';

/**
 * 目录快照遍历时跳过的目录（缩小扫描范围、避开 memora 自身数据噪音）
 *
 * 基线**派生自内核 `IGNORED_DIR_NAMES`**（构建产物 / memora 内部数据，非用户可见源码）——
 * 与 `list_dir` / `search_project` 共用同一套忽略规则，禁并列维护第二份基线（两份必漂移：
 * 内核新增忽略目录时宿主快照仍扫它 ⇒ 内部数据混进改动可见性）。
 * 追加项是本快照**独有**的宿主工具链产物目录（内核工具面不需要，故不并入内核基线）。
 */
const IGNORED_DIRS: ReadonlySet<string> = new Set<string>([
  ...IGNORED_DIR_NAMES,
  'out',
  'build',
  '.vscode',
  '.workbuddy',
  'target',
  '.nuxt',
  '.svelte-kit',
  '.cache',
]);

/** 单文件扫描上限（2MB）：超大文件跳过，避免快照 IO 失控 */
const SNAPSHOT_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 全量快照总字节上限（64MB）：超过则放弃内容快照、降级为「提示用户 git 核对」，
 *  避免大仓库同步扫描卡死 extension host（opaque 写工具低频触发，正常仓库远在阈值下） */
const SNAPSHOT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** 全量快照文件数上限（8000）：海量小文件场景同样降级 */
const SNAPSHOT_MAX_FILES = 8000;

/**
 * 扫描 workspace 下所有用户可见文本文件内容（opaque 写工具执行前后快照用）
 *
 * @returns `路径→内容` 快照；触发总量上限时返回 `null`（调用方降级为「提示用户 git 核对」）
 */
export function scanWorkspaceTextFiles(): Map<string, string> | null {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) return new Map();
  const result = new Map<string, string>();
  let totalBytes = 0;
  let fileCount = 0;
  let aborted = false;
  const walk = (dir: string): void => {
    if (aborted) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (aborted) return;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        try {
          const size = statSync(abs).size;
          if (size > SNAPSHOT_MAX_FILE_BYTES) continue;
          // 上限守卫（止血）：总字节 / 文件数任一超阈值 → 放弃内容快照，
          // 调用方降级为「提示用户 git 核对」，避免大仓库同步扫描卡死 extension host
          if (totalBytes + size > SNAPSHOT_MAX_TOTAL_BYTES || fileCount + 1 > SNAPSHOT_MAX_FILES) {
            aborted = true;
            result.clear();
            return;
          }
          const content = readFileSync(abs, 'utf-8');
          if (content.includes('\u0000')) continue; // 二进制
          totalBytes += size;
          fileCount += 1;
          result.set(abs, content);
        } catch {
          // 不可读 / 权限失败：跳过（不影响其余文件）
        }
      }
    }
  };
  walk(ws);
  return aborted ? null : result;
}
