/**
 * live 正文回抽单测（§6.4.1 第二真源漂移修复）
 *
 * 判据对齐内核 `observeExecutionChunk`：后缀匹配才扣、不匹配忽略（宁可多留不误删），
 * 且不得误伤其他轮正文。变异任一判据必须红。
 */
import { describe, expect, it } from 'vitest';
import { withdrawLiveText } from '../liveTextWithdraw.js';

describe('withdrawLiveText — narrate.withdrawn 后缀扣除', () => {
  it('后缀匹配只扣本轮该段，其他轮不动', () => {
    const map = new Map([
      ['r1', '先找一下项目里有没有这个文件。'],
      ['r2', '另一轮正文'],
    ]);
    withdrawLiveText(map, 'r1', '先找一下项目里有没有这个文件。');
    expect(map.get('r1')).toBe('');
    expect(map.get('r2')).toBe('另一轮正文');
  });

  it('正文含后续追加时不扣（契约要求 withdrawn 必是后缀）', () => {
    const map = new Map([['r1', '先正文后续']]);
    withdrawLiveText(map, 'r1', '先');
    expect(map.get('r1')).toBe('先正文后续');
  });

  it('无 roundId / 空 withdrawn / 无该轮记录均零操作', () => {
    const map = new Map([['r1', '正文']]);
    withdrawLiveText(map, undefined, '正文');
    withdrawLiveText(map, 'r1', '');
    withdrawLiveText(map, 'rX', '正文');
    expect(map.get('r1')).toBe('正文');
    expect(map.has('rX')).toBe(false);
  });
});
