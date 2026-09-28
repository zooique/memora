/**
 * 折叠展开态「用户意图保护」回归钉（chatView 运行时渲染）
 *
 * 真机症状：运行时工具组/工具行折叠展开「点了没反应」、
 * 展开历史思考块「瞬间被折叠回去」。根因族 = 运行期增量渲染（renderProcessFlow
 * 每条 process_event 全量跑一遍）覆盖/销毁用户已交互的 <details> 状态：
 *   ① updateToolRowState 对既有工具行强制回写 `row.open`（用户展开态被打回）；
 *   ② refreshToolBatchSummary 每次清空重建 summary 子节点（点击被吞/命中错位）；
 *   ③ 骨架壳（flowShellEl）拆除连带销毁其内的过程平铺容器 → 全部折叠块重建归零。
 *
 * 本文件只断言**期望行为**（用户展开/收起后不被打回、DOM 身份稳定、默认值仍生效），
 * 各用例分别钉住上述机制之一；用户手势统一走 `userToggle`（点 summary = 接管开合）。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatch, mountChatView } from './helpers/chatViewTestEnv.js';

/** 分发一条运行时过程事件（process_event 单形态投影通道） */
function dispatchEv(event: Record<string, unknown>): void {
  dispatch({ type: 'process_event', event });
}

/** 起一轮：meta 建骨架（TTFT 前即时反馈） */
function startRound(): void {
  dispatchEv({
    type: 'meta',
    seq: 1,
    ts: '2026-09-28T10:00:01.000Z',
    payload: { role: 'AI', llm: 'm' },
  });
}

/** 思考增量片段（stepIndex 归属 step；碎片按 seq 原样拼接） */
function thought(seq: number, content: string, stepIndex?: number): Record<string, unknown> {
  return {
    type: 'thought',
    seq,
    ts: `2026-09-28T10:00:${String(seq).padStart(2, '0')}.000Z`,
    payload: { content, stepIndex },
  };
}

/** 工具开始（toolCallId = 行配对键） */
function toolStart(seq: number, toolCallId: string, name = 'read_file'): Record<string, unknown> {
  return {
    type: 'tool_start',
    seq,
    ts: `2026-09-28T10:00:${String(seq).padStart(2, '0')}.000Z`,
    payload: { toolCallId, name, args: '{}', stepIndex: 1 },
  };
}

/** 工具结果（ok=true 成功 → 默认收起；ok=false 失败 → 默认展开） */
function toolResult(seq: number, toolCallId: string, ok = true): Record<string, unknown> {
  return {
    type: 'tool_result',
    seq,
    ts: `2026-09-28T10:00:${String(seq).padStart(2, '0')}.000Z`,
    payload: { toolCallId, name: 'read_file', ok, summary: 'done' },
  };
}

/**
 * 用户手势模拟：点 summary 切换开合（浏览器原生 toggle + 派生 click → 意图闩）。
 * jsdom 已实现 summary 点击的原生 details 开合——只派发 click，不手动翻转 open
 * （手动翻转会与原生 toggle 叠加成翻两次）。
 */
function userToggle(row: HTMLDetailsElement): void {
  row.querySelector('summary')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** 取当前轮运行时工具行（按 toolCallId） */
function toolRow(toolCallId: string): HTMLDetailsElement {
  const row = document.querySelector<HTMLDetailsElement>(
    `.round-block__tool[data-tool-call-id="${toolCallId}"]`,
  );
  expect(row).not.toBeNull();
  return row!;
}

/** 取当前轮思考折叠块（按 step 分桶 key） */
function thoughtRow(bucketKey: string): HTMLDetailsElement {
  const row = document.querySelector<HTMLDetailsElement>(
    `.process-flow__thought[data-step-bucket="${bucketKey}"]`,
  );
  expect(row).not.toBeNull();
  return row!;
}

describe('chatView 折叠展开态用户意图保护', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('工具行（已成功）用户展开后，后续过程事件不得把展开态打回收起', () => {
    mountChatView();
    startRound();
    // 工具调用 + 结果（成功 → 行默认收起）
    dispatchEv(toolStart(2, 't1'));
    dispatchEv(toolResult(3, 't1', true));
    const row = toolRow('t1');
    expect(row.open).toBe(false); // 默认收起（成功）

    // 用户点开想看看
    userToggle(row);
    expect(row.open).toBe(true);

    // 后续任意过程事件（思考增量最常见）到达 → 展开态必须保持
    dispatchEv(thought(4, '接下来读下一个文件', 1));
    expect(toolRow('t1')).toBe(row); // 同一元素（未重建）
    expect(row.open).toBe(true); // 用户意图不被打回
  });

  it('工具行用户收起后，失败结果的「默认展开」不得把行弹开', () => {
    mountChatView();
    startRound();
    dispatchEv(toolStart(2, 't1'));
    const row = toolRow('t1');
    expect(row.open).toBe(true); // 进行中默认展开

    // 用户手动收起
    userToggle(row);
    expect(row.open).toBe(false);

    // 失败结果到达（默认动作 = 展开直显错误）→ 用户已表达收起意图，不得弹开
    dispatchEv(toolResult(3, 't1', false));
    expect(toolRow('t1')).toBe(row);
    expect(row.open).toBe(false);
  });

  it('反向守卫：用户未触碰时默认值仍生效（成功收起 / 失败展开 / 进行中展开）', () => {
    mountChatView();
    startRound();
    dispatchEv(toolStart(2, 't1')); // 进行中
    dispatchEv(toolStart(3, 't2'));
    dispatchEv(toolStart(4, 't3'));
    dispatchEv(toolResult(5, 't1', true)); // 成功
    dispatchEv(toolResult(6, 't2', false)); // 失败
    // t3 保持进行中
    expect(toolRow('t1').open).toBe(false); // 成功默认收起
    expect(toolRow('t2').open).toBe(true); // 失败默认展开
    expect(toolRow('t3').open).toBe(true); // 进行中默认展开
  });

  it('工具批块 summary 子节点在增量刷新时保持同一节点（不整体重建，防点击被吞）', () => {
    mountChatView();
    startRound();
    // 相邻两个工具 → 合并为多工具批块
    dispatchEv(toolStart(2, 't1'));
    dispatchEv(toolStart(3, 't2'));
    const block = document.querySelector<HTMLDetailsElement>('.round-block__tool-batch');
    expect(block).not.toBeNull();
    const summary = block!.querySelector(':scope > .round-block__tool-batch-summary');
    expect(summary).not.toBeNull();
    const titleBefore = summary!.querySelector('.round-block__tool-batch-title');
    expect(titleBefore).not.toBeNull();

    // 结果后到（批标题统计刷新）→ 标题 span 保持同一节点，只允许文本变化
    dispatchEv(toolResult(4, 't2', true));
    const titleAfter = summary!.querySelector('.round-block__tool-batch-title');
    expect(titleAfter).toBe(titleBefore); // 节点身份稳定 = 点击目标不被销毁

    // 失败提示首次出现再消失：warn span 生命周期受控（出现一次、无提示即移除），title 仍稳定
    dispatchEv(toolResult(5, 't1', false));
    expect(summary!.querySelector('.round-block__tool-batch-warn')).not.toBeNull();
    expect(summary!.querySelector('.round-block__tool-batch-title')).toBe(titleBefore);
  });

  it('思考块用户展开后，同 step 后续碎片只追加正文，不重建、不打回展开态', () => {
    mountChatView();
    startRound();
    dispatchEv(thought(2, '先看目录结构', 1));
    const row = thoughtRow('1');
    userToggle(row); // 用户展开
    expect(row.open).toBe(true);

    // 同 step 新碎片 + 别的事件到达
    dispatchEv(thought(3, '，再读核心文件', 1));
    dispatchEv(toolStart(4, 't1'));
    expect(thoughtRow('1')).toBe(row); // 同一元素
    expect(row.open).toBe(true); // 展开态保持
    expect(row.querySelector('.process-flow__thought-body')?.textContent).toContain('再读核心文件');
  });

  it('裁决点优先级：用户折叠的任务项分组在交互输入落地时强制展开（用户输入恒可见 > 意图闩）', () => {
    mountChatView();
    startRound();
    // 任务项边界 + 真工具 → 任务项分组建立
    dispatchEv({
      type: 'plan_item_boundary',
      seq: 2,
      ts: '2026-09-28T10:00:02.000Z',
      payload: { planItemId: 'item-1', title: '第一步' },
    });
    dispatchEv(toolStart(3, 't1'));
    dispatchEv(toolResult(4, 't1', true));
    const group = document.querySelector<HTMLDetailsElement>('.round-block__plan-item');
    expect(group).not.toBeNull();

    // 用户手动折叠任务项分组（分组默认收起，先置展开态再折叠 = 意图闩生效）
    group!.open = true;
    userToggle(group!);
    expect(group!.open).toBe(false);

    // 用户自己的问答落地归位进该组 → 裁决点（openForUserVisibility）强制展开：
    // 用户输入被折叠隐藏 = 「发了没反应」事故，可见性在此让意图闩让位（唯一例外通道）
    dispatch({
      type: 'user',
      text: '是',
      ts: '2026-09-28T10:00:30.000Z',
      kind: 'question-answer',
      question: '确认执行？',
    });
    expect(document.querySelector('.round-block__plan-item')).toBe(group); // 同一节点
    expect(group!.open).toBe(true); // 强制展开 = 优先级裁决生效
  });

  it('纯工具轮（骨架未转正）插话补充 + 续跑 meta 后，思考块身份与展开态保持', () => {
    mountChatView();
    startRound();
    // 纯工具/思考阶段（无 text chunk → 骨架壳未转正，过程容器挂在骨架壳内）
    dispatchEv(thought(2, '先规划', 1));
    dispatchEv(toolStart(3, 't1'));
    dispatchEv(toolResult(4, 't1', true));
    const row = thoughtRow('1');
    userToggle(row); // 用户展开历史思考
    expect(row.open).toBe(true);

    // 用户插话补充（打断）→ 续跑 meta（宿主每个 runFlow 重发 meta）
    dispatch({
      type: 'user',
      text: '补充一句',
      ts: '2026-09-28T10:01:00.000Z',
      kind: 'supplement',
    });
    dispatchEv({
      type: 'meta',
      seq: 9,
      ts: '2026-09-28T10:01:01.000Z',
      payload: { role: 'AI', llm: 'm' },
    });

    // 过程容器与折叠块不得因骨架壳拆除而整树重建（展开态归零 = 「瞬间折叠回去」）
    expect(thoughtRow('1')).toBe(row);
    expect(row.open).toBe(true);
  });
});
