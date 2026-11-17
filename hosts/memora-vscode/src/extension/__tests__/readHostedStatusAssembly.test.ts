/**
 * `readHostedStatus` 装配结构守卫（2026-11-17 真机缺陷回归）
 *
 * 【缺陷形状】装配层给 `projectSessionStatus` 的读口漏了 `readMeta` 端口 ⇒ 托管优先
 * 分支（origin=hosted 时读 workStatus）静默不进，回落轮次投影——真机实证：对 working
 * 活会话 pause/stop 回 `kind:completed` 且操作落空，Worker 自行跑完。
 *
 * 【为什么用源码结构守卫】`extension.ts` 属零测试覆盖区（装配层无从单测），与
 * `lazyHostedSessionCreator.test.ts` 同法：读源码钉住接线形态，缺端口即红。
 */
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 截取 `readHostedStatus` 装配体源码（从声明到下一个顶层 const）
 *
 * @returns 该函数体的源码文本
 */
function readHostedStatusBody(): string {
  const source = readFileSync(new URL('../extension.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const readHostedStatus');
  const end = source.indexOf('const assemblyDeps');
  // 切片失败 = 结构大改（函数被搬走 / 改名），守卫必须红而不是静默跳过
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('readHostedStatus 装配体定位失败：函数被改名或搬离 extension.ts 顶层');
  }
  return source.slice(start, end);
}

describe('readHostedStatus 装配 — readMeta 端口守卫', () => {
  it('托管状态读口必须带 readMeta，且与工作台同一 getSessionMeta 真源', () => {
    const body = readHostedStatusBody();
    // 正面：readMeta 端口存在且指向 sessionStore.getSessionMeta（与工作台装配同源）
    expect(body).toContain('readMeta:');
    expect(body).toMatch(/readMeta:\s*\(id\)\s*=>\s*sessionStore\.getSessionMeta\(id\)/);
  });

  it('其余四个既有端口仍在（不因补端口丢接线）', () => {
    const body = readHostedStatusBody();
    expect(body).toContain('peekActivity:');
    expect(body).toContain('readRoundIds:');
    expect(body).toContain('readRoundStatus:');
    expect(body).toContain('readRound:');
  });
});
