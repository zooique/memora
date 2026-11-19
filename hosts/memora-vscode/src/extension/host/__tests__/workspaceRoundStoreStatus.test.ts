/**
 * WorkspaceRoundStore 索引态读取单元测试（P1 会话终态投影）
 *
 * 锁定的不变式：
 *   ① `getStatus` 返回索引里记录的轮状态，未知轮返回 `undefined`（不猜状态）；
 *   ② `getStatus` **只读内存索引、不读盘**——盘上轮文件被改成别的状态后，
 *      索引值仍是 `save()` 时的值（终态投影的读取代价必须与列表规模无关）；
 *   ③ `hasRoundStatusIndex` 是结构化能力探测：具备该方法才放行，否则调用方不投影。
 *   ④ `getDispatch` 同样**只读索引**：派发归属随索引跨重启保留，旧轮缺字段返回 `undefined`
 *      （工作台重建的反查依赖它，代价必须与「会话数 × 轮数」的磁盘读脱钩）。
 *
 * 变异靶标：把 `getStatus` 改成 `this.getById(roundId)?.status`（读盘）⇒ 用例② 转红；
 * 把 `hasRoundStatusIndex` 改成恒 true ⇒ 用例③ 的负例转红；
 * 把 `getDispatch` 改成 `this.getById(roundId)?.dispatchedBy` ⇒ 用例④ 的「只读索引」段转红。
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
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

  it('getDispatch 只读索引：随索引跨重启保留，旧轮缺字段返回 undefined（不猜来源）', () => {
    const dir = makeTempDir('memora-round-dispatch-test-');
    const store = new WorkspaceRoundStore(dir);
    store.load();

    // 新轮：派发归属随 save() 进索引（与 status 同等对待）
    const delegated: Round = {
      ...makeRound('round-d', 'complete'),
      dispatchedBy: { from: 'session-creator', via: 'delegate' },
    };
    store.save(delegated);
    // 旧轮：没有该字段 ⇒ undefined（等于「不知道创建者」，不许编一个）
    store.save(makeRound('round-legacy', 'complete'));
    expect(store.getDispatch('round-d')).toEqual({ from: 'session-creator', via: 'delegate' });
    expect(store.getDispatch('round-legacy')).toBeUndefined();
    expect(store.getDispatch('round-missing')).toBeUndefined();

    // 只读索引、不读盘：盘上轮文件被改成别的创建者，索引值不变（反查代价与会话数无关）
    const roundPath = join(resolveProjectDataDir(dir), 'rounds', 'round-d.json');
    writeFileSync(
      roundPath,
      JSON.stringify({
        ...makeRound('round-d', 'complete'),
        dispatchedBy: { from: 'session-other', via: 'create' },
      }),
      'utf-8',
    );
    expect(store.getDispatch('round-d')).toEqual({ from: 'session-creator', via: 'delegate' });

    // 重启（重新 load 读索引文件）⇒ 归属仍在：工作台重建靠这条读路径
    const reloaded = new WorkspaceRoundStore(dir);
    reloaded.load();
    expect(reloaded.getDispatch('round-d')).toEqual({ from: 'session-creator', via: 'delegate' });
    expect(reloaded.getDispatch('round-legacy')).toBeUndefined();
  });

  it('删掉索引文件也能从轮文件全量重建 dispatchedBy（判据：是缓存，不是第二真相源）', () => {
    const dir = makeTempDir('memora-round-dispatch-cache-test-');
    const store = new WorkspaceRoundStore(dir);
    store.load();
    store.save({
      ...makeRound('round-cache', 'complete'),
      dispatchedBy: { from: 'session-creator', via: 'create' },
    });
    store.save(makeRound('round-plain', 'complete'));

    // 索引整份丢失（删文件 / 换机器只拷 rounds 目录）
    unlinkSync(join(resolveProjectDataDir(dir), 'rounds', 'index.json'));

    const rebuilt = new WorkspaceRoundStore(dir);
    rebuilt.load();
    // 补读只发生在「索引缺条目」这一支：status 与 dispatchedBy 必须都被补出来，
    // 否则旧派发记录会在索引缺失时被判成「没派过」而无声消失
    expect(rebuilt.getDispatch('round-cache')).toEqual({ from: 'session-creator', via: 'create' });
    expect(rebuilt.getStatus('round-cache')).toBe('complete');
    expect(rebuilt.getDispatch('round-plain')).toBeUndefined();
  });
});

/**
 * D1（ROUND-CACHE-NOINVALIDATE-1）：派发前的「引用完整性」核对
 *
 * 锁定不变式：判据是**盘上直系 `*.json` 目录列举**，不是正文 cache / 状态 index
 * （那两者对外部删文件不失效）；`.trash` 与 index.json 都不是活轮；
 * 目录整体不存在时所有引用都算缺失（fail-closed，不臆造可用）。
 */
describe('WorkspaceRoundStore.findMissingRounds（D1 引用完整性）', () => {
  it('缺文件 / 移入 .trash 均报缺失；index.json 与空引用不算', () => {
    const dir = makeTempDir('memora-round-presence-test-');
    const store = new WorkspaceRoundStore(dir);
    store.load();
    store.save(makeRound('round-a', 'complete'));
    store.save(makeRound('round-b', 'complete'));
    const roundsDir = join(resolveProjectDataDir(dir), 'rounds');

    // 引用齐全：磁盘目录列举能证明两者都在（此时正文 cache 也在，但判据不依赖它）
    expect(store.findMissingRounds(['round-a', 'round-b'])).toEqual([]);

    // 真机复现动作：把轮文件从盘上移走（addRoundId 仍引用它）
    unlinkSync(join(roundsDir, 'round-a.json'));
    expect(store.findMissingRounds(['round-a', 'round-b'])).toEqual(['round-a']);

    // 移入回收站 = 不在活轮集合（.trash 是目录，不是直系 *.json）
    mkdirSync(join(roundsDir, '.trash'), { recursive: true });
    writeFileSync(join(roundsDir, '.trash', 'round-b.json'), '{}', 'utf-8');
    unlinkSync(join(roundsDir, 'round-b.json'));
    expect(store.findMissingRounds(['round-a', 'round-b'])).toEqual(['round-a', 'round-b']);

    // 无引用 = 无缺失（新建会话首轮派发不列举）
    expect(store.findMissingRounds([])).toEqual([]);
  });

  it('rounds 目录整体不存在 ⇒ 所有引用都报缺失（不把「读不到」当完整）', () => {
    const dir = makeTempDir('memora-round-presence-nodir-');
    const store = new WorkspaceRoundStore(dir);
    expect(store.findMissingRounds(['round-x', 'round-y'])).toEqual(['round-x', 'round-y']);
  });
});
