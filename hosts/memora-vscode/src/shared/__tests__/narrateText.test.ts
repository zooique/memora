/**
 * deriveNarrateText —— 「一轮的过程叙述拼起来是什么」的单点直测
 *
 * 这个函数有两个消费者，产物都直接进用户视野：
 *   ① webview：中断轮「复制」的 `dataset.rawText`；
 *   ② 宿主：崩溃残留轮打捞时写进恢复后的 `assistantMessage.content`。
 * 两处若各写一遍，复制出来的文本与重启后恢复出来的文本会不一致，且**不会有任何报错**。
 * 故此处按纯函数直测，锁死「换行分隔 + 按 seq 排序 + 空轮空串」三条口径。
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { ProcessEvent } from '@zooique/memora';
import { deriveNarrateText } from '../narrateText.js';

/** 叙述段（真实形态：内核每轮工具迭代 emit 一段**经 trim 的完整叙述**，不是增量分片） */
function narrate(seq: number, content: string): ProcessEvent {
  return {
    type: 'narrate',
    seq,
    ts: `2026-10-30T00:00:0${seq}.000Z`,
    payload: { content },
  } as ProcessEvent;
}

/** 非叙述过程事件（不得进入派生文本） */
function thinking(seq: number): ProcessEvent {
  return {
    type: 'thinking',
    seq,
    ts: `2026-10-30T00:00:0${seq}.000Z`,
    payload: { phase: 'analyzing' },
  } as unknown as ProcessEvent;
}

describe('deriveNarrateText（过程叙述派生单点）', () => {
  it('多段叙述按 seq 升序、换行分隔（不是空串拼接——段间空白已被内核 trim）', () => {
    expect(deriveNarrateText([narrate(1, '先读文档'), narrate(3, '再改配置')])).toBe(
      '先读文档\n再改配置',
    );
  });

  it('乱序输入也按 seq 排序（不依赖上游数组顺序契约）', () => {
    expect(deriveNarrateText([narrate(5, '后段'), narrate(2, '前段')])).toBe('前段\n后段');
  });

  it('只取 narrate：思考/工具等其它事件不进入文本', () => {
    expect(deriveNarrateText([thinking(1), narrate(2, '正文'), thinking(3)])).toBe('正文');
  });

  it('无 narrate 或未落盘 ⇒ 空串（调用方据此不写 assistantMessage / 不设 rawText）', () => {
    expect(deriveNarrateText(undefined)).toBe('');
    expect(deriveNarrateText([])).toBe('');
    expect(deriveNarrateText([thinking(1)])).toBe('');
  });

  it('不改入参数组（内部排序在过滤后的副本上做）', () => {
    const events = [narrate(3, 'b'), narrate(1, 'a')];
    deriveNarrateText(events);
    expect(events.map((e) => e.seq)).toEqual([3, 1]);
  });
});
