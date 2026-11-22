/**
 * 助手窗微信心智对齐（ASSISTANT-WECHAT-UX-1）
 *
 * 三项形态差异 + 一项复用确认，全部只作用于 body[data-form='assistant']，
 * self 形态逐字不变：
 *   ① 底栏只留「复制整链」——重新生成 / 分叉 / 删除三个轮级动作不露面
 *      （真源 ROUND_ACTIONS 与右键菜单不改，避免改判据带伤）；
 *   ② 连续输入 / 补充上屏——交互行挂消息流可见终位，不再被 CSS 收起的过程容器连坐隐藏；
 *   ③ 微信气泡不标来源——「由 X 发送」标签在本形态隐藏；
 *   ④ 「添加到输入区」复用既有右键「引用回复」，零新协议 / 零新菜单项。
 *
 * ⑤ ⑥ 为源码守卫：底栏减法不碰真源表、底栏 hover 显现 + 单边靠右（ASSISTANT-FOOTER-HOVER-1）。
 * 变异验证：三处判据各改坏一次，确认精确命中后恢复（见台账条目）。
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { dispatch, mountChatView } from './helpers/chatViewTestEnv.js';

const SRC = join(__dirname, '..', 'scripts', 'chatView.ts');
const FOOTER_SRC = join(__dirname, '..', 'scripts', 'roundFooterView.ts');
const CSS_SRC = join(__dirname, '..', 'styles', 'chatStyles.ts');

/** 驱动一轮「用户提问 → meta → 补充 → 终态」的最小事件序 */
function driveRoundWithSupplement(form: 'self' | 'assistant', roundId: string): void {
  mountChatView(form);
  dispatch({ type: 'user', text: '帮我做件事', ts: '2026-11-17T10:00:00.000Z' });
  dispatch({
    type: 'process_event',
    event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
  });
  dispatch({
    type: 'user',
    text: '我补充一句',
    ts: '2026-11-17T10:00:01.000Z',
    kind: 'supplement',
    roundId,
  });
  dispatch({
    type: 'chunk',
    content: '已完成',
    ts: '2026-11-17T10:00:02.000Z',
    roundId,
  });
  dispatch({ type: 'done', roundId });
}

describe('助手窗微信心智对齐（ASSISTANT-WECHAT-UX-1）', () => {
  it('① 底栏：助手形态只留复制，self 形态三个轮级动作一个不少', () => {
    driveRoundWithSupplement('assistant', 'r1');
    const aFooter = document.querySelector<HTMLElement>(
      '.round-group[data-round-id="r1"] .round-group__footer',
    );
    expect(aFooter).not.toBeNull();
    expect(aFooter!.querySelector('.msg-copy-icon')).not.toBeNull();
    expect(aFooter!.querySelectorAll('[data-round-action]').length).toBe(0);

    // self 形态：同一事件序，三个轮级动作照常出现（不带伤）
    driveRoundWithSupplement('self', 'r2');
    const sFooter = document.querySelector<HTMLElement>(
      '.round-group[data-round-id="r2"] .round-group__footer',
    );
    expect(sFooter!.querySelectorAll('[data-round-action]').length).toBe(3);
    expect(sFooter!.querySelector('.msg-delete-icon')).not.toBeNull();
  });

  it('② 补充输入上屏：ASSISTANT-INPUT-BUBBLE-1 助手形态与普通用户气泡同形（self 形态过程行不变）', () => {
    driveRoundWithSupplement('assistant', 'r3');
    // 2026-11-22 真机：助手窗的「你补充」过程行像系统提示，不像用户说的话；
    // 现统一走 append('user')，形态与首句用户输入完全一致（含引用按钮）。
    const bubbles = [...document.querySelectorAll<HTMLElement>('.msg.user')];
    const bubble = bubbles.find((el) => el.textContent?.includes('我补充一句'));
    expect(bubble).toBeDefined();
    expect(bubble!.closest('.round-block, .process-flow')).toBeNull();
    expect(bubble!.parentElement?.classList.contains('msg-wrapper')).toBe(true);
    expect(bubble!.parentElement?.querySelector('.msg-copy-icon')).not.toBeNull();
    expect(document.querySelector('.round-block__input')).toBeNull();

    // 工作模式逐字不变：仍按 ts 归位进过程容器的「你补充」行
    driveRoundWithSupplement('self', 'r3-self');
    const row = [...document.querySelectorAll<HTMLElement>('.round-block__input')].find((el) =>
      el.textContent?.includes('我补充一句'),
    );
    expect(row).toBeDefined();
    // 当前 l10n 默认语言下 tag = "You added"；工作模式保留原过程行形态（断言 tag 存在即可）
    expect(row!.querySelector('.round-block__input-tag')).not.toBeNull();
  });

  it('② 源码守卫：助手形态挂载根置空 + 跳过 details 重建 + 不回收上屏行（三处同判据）', () => {
    const src = readFileSync(SRC, 'utf8');
    // 挂载根：助手形态置空
    expect(src).toMatch(/const flow = !assistantForm && flowEl\?\.isConnected/);
    expect(src).toMatch(/const assistantForm = document\.body\.dataset\.form === 'assistant'/);
    // details 重建跳过
    expect(src).toMatch(
      /if \(document\.body\.dataset\.form !== 'assistant'\) \{\s*const renderedInputTs/,
    );
    // 回收删除两处都带 form 判据（出现两次）
    const guardedRemoves = [
      ...src.matchAll(
        /roundBlockEl\?\.isConnected && document\.body\.dataset\.form !== 'assistant'[\s\S]{0,120}?round-block__input\[data-round-id/g,
      ),
    ];
    expect(guardedRemoves.length).toBe(2);
  });

  it('③ 来源标签：DOM 保留节点，CSS 在助手作用域隐藏（jsdom 不算样式故走源码守卫）', () => {
    // hosted 来源的用户消息仍渲染标签节点（不删 DOM，切回 self 即恢复）
    mountChatView('assistant');
    dispatch({
      type: 'user',
      text: '转达一句',
      ts: '2026-11-17T11:00:00.000Z',
      origin: 'hosted',
      senderName: '小助手',
    });
    const tag = document.querySelector('.msg-origin-tag');
    expect(tag).not.toBeNull();

    const css = readFileSync(CSS_SRC, 'utf8');
    expect(css).toMatch(
      /body\[data-form='assistant'\] \.msg-origin-tag \{ display: none !important; \}/,
    );
    // 交互行恢复可选中（右键引用回复的前提）
    expect(css).toMatch(
      /body\[data-form='assistant'\] \.round-block__input \{ user-select: text; \}/,
    );
  });

  it('④ 添加到输入区：助手形态右键选区仍有引用回复项，点击落到引用胶囊（复用既有能力）', () => {
    mountChatView('assistant');
    dispatch({ type: 'user', text: '问题', ts: '2026-11-17T12:00:00.000Z' });
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({
      type: 'chunk',
      content: '答案原文',
      ts: '2026-11-17T12:00:05.000Z',
      roundId: 'r4',
    });
    dispatch({ type: 'done', roundId: 'r4' });

    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '答案原文',
    } as unknown as Selection);
    document.querySelector('.msg.assistant')?.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      }),
    );
    const item = document.querySelector<HTMLElement>('[data-ctxmenu-id="quote-reply"]');
    expect(item).not.toBeNull();
    item!.click();
    const chipRow = document.getElementById('refChips') as HTMLElement;
    expect(chipRow.textContent).toContain('Quote: 答案原文');
  });

  it('② 重启重放：历史轮里的补充输入仍上屏（不被回收删除抹掉）', () => {
    mountChatView('assistant');
    dispatch({
      type: 'turn_update',
      rounds: [
        {
          id: 'round-replay-1',
          status: 'complete',
          createdAt: '2026-11-17T13:00:00.000Z',
          userMessage: {
            id: 'm1',
            role: 'user',
            content: '帮我做件事',
            timestamp: '2026-11-17T13:00:00.000Z',
          },
          processEvents: [{ type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } }],
          interactiveInputs: [
            { content: '重启前的补充', ts: '2026-11-17T13:00:03.000Z', kind: 'supplement' },
          ],
          assistantMessage: {
            content: '已完成',
            timestamp: '2026-11-17T13:00:05.000Z',
          },
        },
      ],
      state: { phase: 'idle' },
      replay: true,
    });
    // 重放与运行时共用 appendInteractiveInput 入口 ⇒ 历史补充也收敛成普通用户气泡
    const bubbles = [...document.querySelectorAll<HTMLElement>('.msg.user')];
    const hit = bubbles.find((r) => r.textContent?.includes('重启前的补充'));
    expect(hit).toBeDefined();
    expect(hit!.closest('.round-block, .process-flow')).toBeNull();
    expect(hit!.parentElement?.classList.contains('msg-wrapper')).toBe(true);
  });

  it('⑤ 源码守卫：footer 减法只改呈现层，真源表与右键菜单消费不变', () => {
    const footer = readFileSync(FOOTER_SRC, 'utf8');
    // form 判据在呈现层，self 为缺省：新增按钮仍从真源 foreach 派生
    expect(footer).toMatch(/form = 'self'/);
    expect(footer).toMatch(/if \(form === 'self'\) \{[\s\S]*?ROUND_ACTIONS\.forEach/);
  });

  it('⑥ 底栏 hover 显现 + 单边靠右：助手形态与用户操作栏同构，self 两端分布逐字不变', () => {
    const css = readFileSync(CSS_SRC, 'utf8');
    // 助手形态：底栏默认隐去（is-pending 除外，恒不显示）
    // BUBBLE-QUOTE-1（2026-11-18 订正锚）：用户新拍板「左对齐 + 取消虚线」，覆盖 11-17
    // ASSISTANT-FOOTER-HOVER-1 的「单边靠右」——此处 flex-end→flex-start 是订正非造伤，
    // 台账 ASSISTANT-WECHAT-UX-1 已记变更来源；hover 显隐 / focus-within / 零 margin 其余判据不变。
    expect(css).toMatch(
      /body\[data-form='assistant'\] \.round-group__footer:not\(\.is-pending\) \{\s*justify-content: flex-start;\s*border-top: none;\s*opacity: 0;/,
    );
    // hover 整轮 / focus-within 两路显形，复刻用户操作栏的交互范式
    expect(css).toMatch(
      /body\[data-form='assistant'\] \.round-group:hover \.round-group__footer:not\(\.is-pending\),\s*body\[data-form='assistant'\] \.round-group__footer:not\(\.is-pending\):focus-within \{\s*opacity: 1;/,
    );
    // 单边成立关键：覆盖基础两端分布的 auto margin 为 0
    expect(css).toMatch(
      /body\[data-form='assistant'\] \.round-group__footer \.msg-time \{ margin-left: 0; \}/,
    );
    // 不带伤：self 的两端分布基础规则仍在（chatView 终态守卫亦守此条）
    expect(css).toMatch(/\.round-group__footer \.msg-time \{ margin-left: auto; \}/);
    expect(css).toMatch(
      /\.round-group__footer \{\s*display: flex; align-items: center; justify-content: space-between;/,
    );
  });

  it('⑧ BUBBLE-QUOTE-1：助手形态用户气泡 hover 栏有引用按钮，点击整条落到引用胶囊（复用 applyQuote）', () => {
    mountChatView('assistant');
    dispatch({ type: 'user', text: '请帮我做一件事', ts: '2026-11-18T10:00:00.000Z' });
    const actions = document.querySelector<HTMLElement>('.msg-user-actions');
    expect(actions).not.toBeNull();
    const copy = actions!.querySelector('.msg-copy-icon');
    const quote = actions!.querySelector<HTMLButtonElement>('.msg-quote-icon');
    expect(copy).not.toBeNull();
    expect(quote).not.toBeNull();
    expect(quote!.getAttribute('aria-label')).toBe('Quote this message');
    // 点击 → 整条正文进 quoteDraft → 引用胶囊上屏（与右键引用同一出口）
    quote!.click();
    const chipRow = document.getElementById('refChips') as HTMLElement;
    expect(chipRow.textContent).toContain('Quote: 请帮我做一件事');
    expect(document.getElementById('input') === document.activeElement).toBe(true);
  });

  it('⑨ BUBBLE-QUOTE-1：助手形态回答底栏有引用按钮，点击落引用胶囊；self 形态两处都不加（不带伤）', () => {
    mountChatView('assistant');
    dispatch({ type: 'user', text: '问题', ts: '2026-11-18T11:00:00.000Z' });
    dispatch({
      type: 'chunk',
      content: '回答正文第二行',
      ts: '2026-11-18T11:00:05.000Z',
      roundId: 'rq1',
    });
    dispatch({ type: 'done', roundId: 'rq1' });
    const aFooter = document.querySelector<HTMLElement>(
      '.round-group[data-round-id="rq1"] .round-group__footer',
    );
    expect(aFooter).not.toBeNull();
    const aQuote = aFooter!.querySelector<HTMLButtonElement>('.msg-quote-icon');
    expect(aQuote).not.toBeNull();
    expect(aQuote!.getAttribute('aria-label')).toBe('Quote this answer');
    aQuote!.click();
    const chipRow = document.getElementById('refChips') as HTMLElement;
    expect(chipRow.textContent).toContain('Quote: 回答正文第二行');

    // self 形态逐字不变：用户气泡栏与底栏均无引用按钮
    mountChatView('self');
    dispatch({ type: 'user', text: '自助提问', ts: '2026-11-18T12:00:00.000Z' });
    dispatch({
      type: 'chunk',
      content: '自助回答',
      ts: '2026-11-18T12:00:05.000Z',
      roundId: 'rs1',
    });
    dispatch({ type: 'done', roundId: 'rs1' });
    expect(document.querySelector('.msg-user-actions .msg-quote-icon')).toBeNull();
    expect(document.querySelector('.round-group__footer .msg-quote-icon')).toBeNull();
  });

  it('⑦ 代码块复制条：助手形态源码守卫隐藏、DOM 保留，self 基础规则逐字不变', () => {
    mountChatView('assistant');
    dispatch({ type: 'user', text: '写段代码', ts: '2026-11-18T10:00:00.000Z' });
    dispatch({
      type: 'chunk',
      content: '```ts\nconst a = 1;\n```',
      ts: '2026-11-18T10:00:01.000Z',
      roundId: 'r7',
    });
    dispatch({ type: 'done', roundId: 'r7' });
    // 助手形态 DOM 仍保留复制按钮（仅 CSS 隐藏，切回 self 即恢复）
    expect(document.querySelector('.code-block__copy')).not.toBeNull();
    expect(document.querySelector('.code-block__lang')?.textContent).toBe('ts');

    const css = readFileSync(CSS_SRC, 'utf8');
    expect(css).toMatch(
      /body\[data-form='assistant'\] \.code-block__copy \{ display: none !important; \}/,
    );
    // 不带伤：self 基础规则逐字不变（复制条在自助形态仍可见）
    expect(css).toMatch(
      /\.code-block__copy \{\s*padding: var\(--sp-0, 2px\) var\(--sp-2, 6px\);[\s\S]{0,220}?cursor: pointer;/,
    );
  });
});
