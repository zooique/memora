/**
 * WorkspaceRoundStore 索引态读取单元测试（P1 会话终态投影）
 *
 * 锁定的不变式：
 *   ① `getStatus` 返回索引里记录的轮状态，未知轮返回 `undefined`（不猜状态）；
 *   ② `getStatus` **只读内存索引、不读盘**——盘上轮文件被改成别的状态后，
 *      索引值仍是 `save()` 时的值（终态投影的读取代价必须与列表规模无关）；
 *   ③ `hasRoundStatusIndex` 是结构化能力探测：具备该方法才放行，否则调用方不投影。
 *
 * 变异靶标：把 `getStatus` 改成 `this.getById(roundId)?.status`（读盘）⇒ 用例② 转红；
 * 把 `hasRoundStatusIndex` 改成恒 true ⇒ 用例③ 的负例转红。
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IRoundStore, Round } from '@zooique/memora';
import { WorkspaceRoundStore, hasRoundStatusIndex } from '../workspaceRoundStore.js';
import { resolveProjectDataDir } from '../projectDataDir.js';
// 临时目录统一入口：建目录 + 模块顶层注册清理（禁止裸 mkdtempSync，见 helpers/tmpDir.ts）
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';

/**
 * 造一轮最小问答闭环
 *
 * @param id 轮 ID
 * @param status 轮状态（终态投影的输入）
 * @returns 可直接 `save()` 的 Round
 */
function makeRound(id: string, status: Round['status']): Round {
  return {
    id,
    userMessage: {
      id: `${id}-user`,
      role: 'user',
      content: '问',
      timestamp: '2026-11-13T10:00:00.000Z',
    },
    status,
    createdAt: '2026-11-13T10:00:00.000Z',
  };
}

describe('WorkspaceRoundStore 索引态读取（P1 会话终态投影）', () => {
  it('getStatus 只读索引（不读盘），未知轮返回 undefined；hasRoundStatusIndex 结构化探测', () => {
    const dir = makeTempDir('memora-round-status-test-');
    const store = new WorkspaceRoundStore(dir);
    store.load();

    // ① 基本读取：save() 同步写索引 ⇒ getStatus 立即可见；未知轮不臆造状态
    store.save(makeRound('round-1', 'complete'));
    expect(store.getStatus('round-1')).toBe('complete');
    expect(store.getStatus('round-missing')).toBeUndefined();

    // ② 只读索引、不读盘：盘上轮文件被改成 interrupted，索引值必须保持 complete。
    //    （若实现改成读盘，这里会读到 interrupted ⇒ 用例转红）
    const roundPath = join(resolveProjectDataDir(dir), 'rounds', 'round-1.json');
    writeFileSync(roundPath, JSON.stringify(makeRound('round-1', 'interrupted')), 'utf-8');
    expect(store.getStatus('round-1')).toBe('complete');

    // ③ 能力探测：真实 store 有 getStatus ⇒ true；缺该方法的普通 IRoundStore ⇒ false
    expect(hasRoundStatusIndex(store)).toBe(true);
    expect(hasRoundStatusIndex({} as unknown as IRoundStore)).toBe(false);
  });
});
