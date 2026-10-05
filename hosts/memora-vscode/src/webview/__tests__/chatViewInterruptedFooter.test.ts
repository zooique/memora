/**
 * 异常终态轮容器 footer 显形测试（settleRoundFooter 单点收口）
 *
 * 旧伤：容器 footer（复制整链/分叉/删除 + 时间戳）的显形由 finalizeStreaming 顺带移除
 * is-pending，前提 = 正文块已入容器——中断发生在首 chunk 前（骨架未归位）时
 * closest('.round-group') 命中 null，显形信号静默丢失 → 中断轮只剩停止行、无底部栏
 * （重放中断轮走 renderInterruptedRound pending=false 直接显形，故「重渲染能显示、
 * 直接点终止不能」）。修复后：终态显形真源 = 终态消息到达 + roundId 锚，单点收口。
 *
 * 覆盖三相位：
 *   ① 正文流中中断（容器已建）→ settle 走「已建」分支：移除 is-pending + 时间戳存在
 *      （footer 由流式期 ensureRoundGroupFooter 按首段 dataset.ts 直接生成时间戳元素）
 *   ② 早相位中断（骨架未入容器）→ settle 走「建容器」分支（与重放 renderInterruptedRound 同构）
 *   ③ done 正常回归 → footer 照常显形（收口点不破坏正常轮）
 *
 * ⚠ 真相对齐（2026-10-05 复核）：`settleRoundFooter` 的时间戳元素由流式期
 * `ensureRoundGroupFooter` 按首段 dataset.ts 直接生成，并不依赖 `commitTurnTs` 前置——
 * 故下方 `.msg-time` 断言锁定的是「footer 显形 + 时间戳元素存在」（收口点不丢栏），
 * 而非「commitTurnTs→settleRoundFooter 顺序契约」。`settleRoundWithFooter` 将 commitTurnTs
 * （删除按钮 ts 锚）与 footer 显形捆绑，属防御性收口（防未来某终态路径未回填 ds 致删除按钮
 * 恒禁用），其效果由删按钮可用态承载，本组不重复断言。
 *
 * 复制源断言两用例共用：中断 = 半截正文作废，rawText 覆盖为 narrate 拼接
 * （narrateChainText 单点，与重放同源——旧注释「运行时同源同形」只对「不显示正文」成立，
 * rawText 拼接运行时缺失属注释谎报位点，本组断言将其锁定为事实契约）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { dispatch, mountChatView } from './helpers/chatViewTestEnv.js';

/** 驱动一轮「用户提问 → meta 骨架 →（可选 narrate）→（可选 chunk）→ 终态」的最小事件序 */
function driveRound(opts: {
  userTs: string;
  roundId: string;
  narrate?: string;
  chunk?: string;
  end: { type: 'interrupted' | 'done' };
}): void {
  dispatch({ type: 'user', text: '介绍一下这个项目', ts: opts.userTs });
  dispatch({
    type: 'process_event',
    event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
  });
  if (opts.narrate !== undefined) {
    dispatch({
      type: 'process_event',
      event: { type: 'narrate', seq: 2, ts: opts.userTs, payload: { content: opts.narrate } },
    });
  }
  if (opts.chunk !== undefined) {
    dispatch({ type: 'chunk', content: opts.chunk, ts: opts.userTs, roundId: opts.roundId });
  }
  dispatch({ type: opts.end.type, roundId: opts.roundId });
}

describe('异常终态轮容器 footer 显形（chatView · settleRoundFooter 单点收口）', () => {
  beforeEach(() => {
    mountChatView();
  });

  it('正文流中中断 → 容器 footer 显形 + 时间戳补建 + 复制源=narrate 拼接', () => {
    driveRound({
      userTs: '2026-10-05T10:00:00.000Z',
      roundId: 'round-1',
      narrate: '过程叙述甲',
      chunk: '半截正文（已随中断作废）',
      end: { type: 'interrupted' },
    });
    const group = document.querySelector<HTMLElement>('.round-group[data-round-id="round-1"]');
    expect(group).not.toBeNull();
    const footer = group!.querySelector<HTMLElement>('.round-group__footer');
    expect(footer).not.toBeNull();
    // 显形核心断言：is-pending 已移除（变异：删 settle 调用且恢复 finalizeStreaming 旧职责 → 本断言仍绿，
    // 但下方时间戳断言红——旧路径无补建能力）
    expect(footer!.classList.contains('is-pending')).toBe(false);
    // 时间戳补建：运行时建 footer 时首段 ts 恒空 → 元素未创建；settle 按 commitTurnTs 回填的 ts 补
    expect(footer!.querySelector('.msg-time')).not.toBeNull();
    // 复制源 = narrate 拼接（半截正文已删；变异：删 rawText 覆盖 → dataset 缺失断言红）
    const seg = group!.querySelector<HTMLElement>('.msg.assistant');
    expect(seg?.dataset.rawText).toBe('过程叙述甲');
    // 停止行仍在（显形收口不丢异常原因呈现）
    expect(group!.querySelector('[data-interrupted-row]')).not.toBeNull();
  });

  it('早相位中断（无 chunk，骨架未入容器）→ settle 建容器建 footer（与重放同构）', () => {
    driveRound({
      userTs: '2026-10-05T11:00:00.000Z',
      roundId: 'round-2',
      narrate: '叙述乙',
      end: { type: 'interrupted' },
    });
    const group = document.querySelector<HTMLElement>('.round-group[data-round-id="round-2"]');
    expect(group).not.toBeNull();
    const footer = group!.querySelector<HTMLElement>('.round-group__footer');
    expect(footer).not.toBeNull();
    expect(footer!.classList.contains('is-pending')).toBe(false);
    expect(footer!.querySelector('.msg-time')).not.toBeNull();
    const seg = group!.querySelector<HTMLElement>('.msg.assistant');
    expect(seg?.dataset.rawText).toBe('叙述乙');
    expect(group!.querySelector('[data-interrupted-row]')).not.toBeNull();
  });

  it('done 正常结束 → footer 照常显形（回归：收口点不破坏正常轮）', () => {
    driveRound({
      userTs: '2026-10-05T12:00:00.000Z',
      roundId: 'round-3',
      chunk: '正常完整回答',
      end: { type: 'done' },
    });
    const group = document.querySelector<HTMLElement>('.round-group[data-round-id="round-3"]');
    expect(group).not.toBeNull();
    const footer = group!.querySelector<HTMLElement>('.round-group__footer');
    expect(footer).not.toBeNull();
    expect(footer!.classList.contains('is-pending')).toBe(false);
    expect(footer!.querySelector('.msg-time')).not.toBeNull();
    // done 无停止行（正文保留）
    expect(group!.querySelector('[data-interrupted-row]')).toBeNull();
  });
});
