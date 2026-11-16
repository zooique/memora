/**
 * hostedStatusView · 助手座位顶部运行状态签
 *
 * 钉四条边界（不是「元素能创建」）：
 * ① 四档派生判据与「无轮在跑 = null」；② 工具在途与思考相位同判据于消息流
 * （复用 findRunningTool，防顶部与过程说法打架）；③ 幂等写入（流式高频不抖 DOM）；
 * ④ 形态隔离——切回自助即清空，助手恢复重算。
 */
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { ProcessEvent } from '@zooique/memora';
import type { UiForm } from '../../shared/protocol.js';
import type { SkeletonState } from '../helpers/turnUiState.js';
import { createHostedStatusView, deriveHostedStatus } from '../scripts/hostedStatusView.js';

function toolStart(id = 'call-1'): ProcessEvent {
  return {
    type: 'tool_start',
    seq: 1,
    ts: '2026-11-16T10:00:00.000Z',
    payload: { toolCallId: id, name: 'read_file', args: '{}' },
  } as ProcessEvent;
}

function toolResult(id = 'call-1'): ProcessEvent {
  return {
    type: 'tool_result',
    seq: 2,
    ts: '2026-11-16T10:00:01.000Z',
    payload: { toolCallId: id, name: 'read_file', ok: true, summary: 'ok' },
  } as ProcessEvent;
}

function thinking(phase: 'llm_calling' | 'assembling' | 'archiving'): ProcessEvent {
  return {
    type: 'thinking',
    seq: 1,
    ts: '2026-11-16T10:00:00.000Z',
    payload: { phase },
  } as ProcessEvent;
}

describe('deriveHostedStatus（顶部状态档派生）', () => {
  it('无轮在跑与已收场 → null（状态签清空，不摆占位）', () => {
    expect(deriveHostedStatus({ phase: 'idle' }, [])).toBeNull();
    expect(deriveHostedStatus({ phase: 'settled' }, [toolStart()])).toBeNull();
  });

  it('等待提问 / 等待暂停 → awaiting / paused', () => {
    expect(deriveHostedStatus({ phase: 'waiting', reason: 'ask' }, [])).toBe('awaiting');
    expect(deriveHostedStatus({ phase: 'waiting', reason: 'pause' }, [])).toBe('paused');
  });

  it('运行中有未配对工具 → advancing（与消息流相位行同一判据）', () => {
    expect(deriveHostedStatus({ phase: 'running' }, [toolStart()])).toBe('advancing');
    // 工具已配对 ⇒ 不再算在途，回落到其余运行中档
    expect(deriveHostedStatus({ phase: 'running' }, [toolStart(), toolResult()])).toBe('advancing');
  });

  it('运行中仅有非归档思考相位 → thinking', () => {
    expect(deriveHostedStatus({ phase: 'running' }, [thinking('llm_calling')])).toBe('thinking');
    expect(deriveHostedStatus({ phase: 'running' }, [thinking('assembling')])).toBe('thinking');
  });

  it('归档相位与空事件 → advancing（不拿「思考」冒充无证据的内部活动）', () => {
    expect(deriveHostedStatus({ phase: 'running' }, [thinking('archiving')])).toBe('advancing');
    expect(deriveHostedStatus({ phase: 'running' }, [])).toBe('advancing');
  });
});

describe('createHostedStatusView（DOM 施加）', () => {
  function setup() {
    const node = document.createElement('span');
    node.hidden = true;
    let form: UiForm = 'assistant';
    let state: SkeletonState = { phase: 'idle' };
    let events: ProcessEvent[] = [];
    const view = createHostedStatusView({
      node,
      getForm: () => form,
      getState: () => state,
      getEvents: () => events,
    });
    return {
      node,
      view,
      setForm: (next: UiForm) => {
        form = next;
      },
      setState: (next: SkeletonState) => {
        state = next;
      },
      setEvents: (next: ProcessEvent[]) => {
        events = next;
      },
    };
  }

  it('运行中显形并写文案，收场后清空（不残留上一轮的话）', () => {
    const ctx = setup();
    ctx.setState({ phase: 'running' });
    ctx.setEvents([toolStart()]);
    ctx.view.refresh();
    expect(ctx.node.hidden).toBe(false);
    expect(ctx.node.textContent).toBe('Advancing…');

    ctx.setState({ phase: 'settled' });
    ctx.view.refresh();
    expect(ctx.node.hidden).toBe(true);
    expect(ctx.node.textContent).toBe('');
  });

  it('幂等：同文案重复刷新不重写 DOM（流式高频事件不抖）', () => {
    const ctx = setup();
    ctx.setState({ phase: 'running' });
    ctx.view.refresh();
    const before = ctx.node.firstChild;
    ctx.setEvents([thinking('llm_calling')]);
    ctx.view.refresh();
    // 文案从 Advancing… 变 Thinking… ⇒ 会重写；再刷新同文案 ⇒ 节点不动
    const after = ctx.node.firstChild;
    ctx.view.refresh();
    expect(ctx.node.firstChild).toBe(after);
    expect(after).not.toBe(before);
  });

  it('形态隔离：切回自助清空，切回助手按当前骨架重算', () => {
    const ctx = setup();
    ctx.setState({ phase: 'running' });
    ctx.view.refresh();
    expect(ctx.node.textContent).toBe('Advancing…');

    ctx.setForm('self');
    ctx.view.refresh();
    expect(ctx.node.hidden).toBe(true);
    expect(ctx.node.textContent).toBe('');

    ctx.setForm('assistant');
    ctx.setEvents([thinking('llm_calling')]);
    ctx.view.refresh();
    expect(ctx.node.hidden).toBe(false);
    expect(ctx.node.textContent).toBe('Thinking…');
  });
});
