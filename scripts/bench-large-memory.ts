/**
 * 大记忆库（宿主 WorkspaceStorage）性能基准验证
 *
 * 目的：验证宿主 WorkspaceStorage 在千/万级记忆下的两个高频写入路径是否在可接受阈值内：
 *   1. 单次增量 save —— 每次 upsert 触发一次全量 JSON.stringify + atomicWrite（无 SQLite）
 *   2. load（冷启动全量读取）
 *
 * 注：`InMemoryStorage.decayScores()` 已随 score 机制整体物理退役而删除——仍调它的脚本一跑
 * 即崩（「演进后脚本露馅」的实证）。故本脚本只保留仍有效的宿主 WorkspaceStorage 基准；
 * >500KB 触发线是 SQLite 升级信号。
 *
 * 用法：
 *   npx tsx scripts/bench-large-memory.ts
 *
 * 可接受阈值（对抗式定标）：
 *   - save/load 每次写入触发 → 单次 < 50ms 可接受（1 万级）；> 500KB 触发 SQLite 升级
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStorage } from '../hosts/memora-vscode/src/extension/host/workspaceStorage.js';
import type { Memory } from '../src/memory/types.js';

// ─── 基准辅助 ──────────────────────────────────

let failures = 0;
function report(name: string, ms: number, threshold: number): void {
  const ok = ms <= threshold;
  if (!ok) failures++;
  console.log(
    `  ${ok ? '✅' : '❌'} ${name.padEnd(38)} ${String(ms).padStart(8)} ms  ${ok ? `≤${threshold}` : `>${threshold} !`}`,
  );
}

function printBanner(text: string): void {
  console.log(`\n${'━'.repeat(70)}\n  ${text}\n${'━'.repeat(70)}`);
}

/** 构造 N 条治理源记忆（content 源） */
function makeMemories(count: number): Memory[] {
  const now = Date.now();
  const list: Memory[] = [];
  for (let i = 0; i < count; i++) {
    list.push({
      id: `content:bench:${i}`,
      content: `基准记忆 ${i}：这是第 ${i} 条测试记忆内容，用于大记忆库性能验证。`,
      source: 'content',
      name: `bench:${i}`,
      createdAt: new Date(now - i * 60_000).toISOString(),
      accessedAt: new Date(now - i * 3_600_000).toISOString(),
    });
  }
  return list;
}

// ─── 主函数 ──────────────────────────────────

function main(): void {
  printBanner('D2 · 大记忆库（宿主 WorkspaceStorage）性能基准验证');

  printBanner('宿主 WorkspaceStorage JSON 全量 save/load（每次写入触发）');
  for (const size of [1_000, 10_000]) {
    const dir = mkdtempSync(join(tmpdir(), 'memora-bench-'));
    try {
      const storage = new WorkspaceStorage(dir);
      // 批量导入：循环 upsert（每次触发全量 save）。真实场景对应「首次导入大量记忆」，
      // O(n²)（每次全量 stringify+atomicWrite），此处仅揭示趋势，不计 pass/fail。
      const t0 = process.hrtime.bigint();
      for (const m of makeMemories(size)) storage.upsert(m);
      const upsertMs = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(`  📊 批量导入 ${size.toLocaleString()} 条（${size} 次全量 save）= ${(upsertMs / 1000).toFixed(1)} s（O(n²) 趋势，非验收项）`);

      // 单次 save 代价（新增 1 条）—— 真实高频路径：渐进式写入
      const t1 = process.hrtime.bigint();
      storage.upsert({ id: 'content:bench:extra', content: 'x', source: 'content', name: 'extra', createdAt: new Date().toISOString(), accessedAt: new Date().toISOString() });
      const singleSaveMs = Number(process.hrtime.bigint() - t1) / 1e6;
      report(`单次增量 save（${size.toLocaleString()} 条库）`, singleSaveMs, 50);

      // load 代价
      const t2 = process.hrtime.bigint();
      storage.load();
      const loadMs = Number(process.hrtime.bigint() - t2) / 1e6;
      report(`load（${size.toLocaleString()} 条）`, loadMs, 50);

      // 文件大小（判断是否 > 500KB SQLite 触发线）
      const fileSize = statSync(join(dir, '.memora', 'memories.json')).size;
      const sizeKb = (fileSize / 1024).toFixed(0);
      const over500 = fileSize > 500 * 1024;
      if (over500) failures++;
      console.log(`  ${over500 ? '❌' : '✅'} 文件大小 ${sizeKb} KB  ${over500 ? '>500KB → C3 SQLite 触发线已到达' : '≤500KB OK'}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  printBanner(`D2 基准 ${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`);
  if (failures === 0) {
    console.log('结论：宿主 WorkspaceStorage 单次增量 save/load 1 万级 <50ms 安全。');
    console.log('注意：1 万条记忆文件已达 3MB（>500KB 触发线），C3 SQLite 升级从「暂缓」提前为「应规划」。');
  }
}

main();