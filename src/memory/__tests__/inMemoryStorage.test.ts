/**
 * InMemoryStorage 测试入口 —— 契约断言全部在共用套件 `storageContract.ts`（与 SQLite 实现对拍同一份）。
 * 本文件只保留 **InMemory 专属** 行为：`close()` 丢弃全部记忆（内存即存储介质，与落盘实现的
 * 「断连但数据保留」语义刻意不同）。
 */
import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import { makeMemory, runStorageContract } from './storageContract.js';

runStorageContract('InMemoryStorage', () => new InMemoryStorage());

describe('InMemoryStorage · 专属语义（close 丢弃）', () => {
  it('close 后应清空所有数据（内存即存储介质，不释放即泄漏）', () => {
    const storage = new InMemoryStorage();
    storage.upsert(makeMemory('m1', SOURCE_LABELS.RULE));
    storage.upsert(makeMemory('m2', SOURCE_LABELS.PERSONA));
    expect(storage.count()).toBe(2);

    storage.close();
    expect(storage.count()).toBe(0);
    expect(storage.getAllSources().size).toBe(0);
  });
});
