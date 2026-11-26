/**
 * 工具行文件链接守卫（TOOL-FILE-LINK-1）
 *
 * 对话记录里 read_file / write_file 的路径来自模型提交的 tool_start.args，只有配对
 * tool_result 判成功时才是「宿主真的读写过」的指针。本文件钉四条边界：
 *   ① 成功态路径切成链接、文案仍由 toolActionLabel 单点产出；
 *   ② 失败 / 进行中 / 非白名单 / 非规范形恒纯文本（不造假 affordance）；
 *   ③ 点击只上报既有 open_ref 意图（零新协议 type、零第二套路径守卫）；
 *   ④ 实时链 result 后到也能从 pending 行升级为链接（与重放链同判据）。
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { ProcessEvent } from '@zooique/memora';
import type { MemoryHitsBlock } from '../scripts/memoryHitsBlock.js';
import { createProcessFlowCells, updateToolRowState } from '../scripts/processFlowCells.js';
import { dispatch, mountChatView } from './helpers/chatViewTestEnv.js';

type ToolStart = Extract<ProcessEvent, { type: 'tool_start' }>;
type ToolResult = Extract<ProcessEvent, { type: 'tool_result' }>;

const memoryHits: MemoryHitsBlock = {
  buildItems: () => [],
  buildBlock: () => document.createElement('div'),
  createBadge: () => document.createElement('span'),
};

function start(id: string, name: string, args: string): ToolStart {
  return { type: 'tool_start', seq: 1, ts: '', payload: { toolCallId: id, name, args } };
}

function result(id: string, name: string, ok: boolean): ToolResult {
  return {
    type: 'tool_result',
    seq: 2,
    ts: '',
    payload: { toolCallId: id, name, ok, summary: 'done' },
  };
}

function labelOf(row: HTMLElement): HTMLElement {
  const label = row.querySelector<HTMLElement>('.round-block__tool-label');
  expect(label).not.toBeNull();
  return label!;
}

function linkOf(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>('.round-block__tool-filelink');
}

describe('工具行成功态文件链接（TOOL-FILE-LINK-1，单元格直测）', () => {
  it('read_file 成功：路径切成链接，文本逐字不变，点击上行路径且不吃掉 summary 开合', () => {
    const open = vi.fn();
    const cells = createProcessFlowCells({ document, memoryHits, onOpenFile: open });
    const s = start('t1', 'read_file', '{"path":"docs/a.md","offset":"1"}');
    const row = cells.renderToolRow(s, [s, result('t1', 'read_file', true)]);
    const label = labelOf(row);
    expect(label.textContent).toBe('Read file: docs/a.md');

    const link = linkOf(row);
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe('docs/a.md');
    expect(link!.getAttribute('role')).toBe('button');
    expect(link!.tabIndex).toBe(0);

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link!.dispatchEvent(click);
    expect(open).toHaveBeenCalledWith('docs/a.md');
    expect(click.defaultPrevented).toBe(true);
    expect(row.open).toBe(false); // 成功行默认收起；点链接不展开
  });

  it('键盘 Enter / Space 与鼠标同构（role=button 的真键盘可达）', () => {
    const open = vi.fn();
    const cells = createProcessFlowCells({ document, memoryHits, onOpenFile: open });
    const s = start('t2', 'write_file', '{"path":"src/x.ts"}');
    const row = cells.renderToolRow(s, [s, result('t2', 'write_file', true)]);
    const link = linkOf(row);
    expect(link).not.toBeNull();
    link!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    link!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    link!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(1, 'src/x.ts');
  });

  it('失败 / 进行中 / 非白名单 / 非规范形恒纯文本', () => {
    const open = vi.fn();
    const cells = createProcessFlowCells({ document, memoryHits, onOpenFile: open });

    const failed = start('f1', 'write_file', '{"path":"b.md"}');
    expect(
      linkOf(cells.renderToolRow(failed, [failed, result('f1', 'write_file', false)])),
    ).toBeNull();

    const running = start('r1', 'read_file', '{"path":"a.md"}');
    expect(linkOf(cells.renderToolRow(running, [running]))).toBeNull();

    const other = start('o1', 'delete_file', '{"path":"tmp.mjs"}');
    expect(
      linkOf(cells.renderToolRow(other, [other, result('o1', 'delete_file', true)])),
    ).toBeNull();

    const badPath = start('b1', 'read_file', '{"path":"/abs/a.md"}');
    const badRow = cells.renderToolRow(badPath, [badPath, result('b1', 'read_file', true)]);
    expect(linkOf(badRow)).toBeNull();
    expect(labelOf(badRow).textContent).toBe('Read file: /abs/a.md');
    expect(open).not.toHaveBeenCalled();
  });

  it('实时链：pending 行无链接，成功回执到齐后原地升级（与重放链同判据）', () => {
    const open = vi.fn();
    const cells = createProcessFlowCells({ document, memoryHits, onOpenFile: open });
    const s = start('p1', 'read_file', '{"path":"docs/live.md"}');
    const row = cells.renderToolRow(s, [s]);
    expect(linkOf(row)).toBeNull();

    const container = document.createElement('div');
    container.appendChild(row);
    updateToolRowState(container, result('p1', 'read_file', true), open);
    expect(linkOf(row)?.textContent).toBe('docs/live.md');
    // 幂等：重复投递不重建链接节点
    const link = linkOf(row);
    updateToolRowState(container, result('p1', 'read_file', true), open);
    expect(linkOf(row)).toBe(link);
  });
});

describe('工具行链接 → open_ref 上行（零新协议）', () => {
  it('点链接 postMessage 只带协议字段；失败行不挂链接', () => {
    const { postMessage } = mountChatView();
    const at = (seq: number, type: string, payload: Record<string, unknown>): void =>
      dispatch({ type: 'process_event', event: { type, seq, ts: '', payload } });
    at(1, 'meta', { role: 'AI', llm: 'm' });
    at(2, 'tool_start', {
      toolCallId: 'e1',
      name: 'read_file',
      args: '{"path":"docs/e2e.md"}',
    });
    at(3, 'tool_result', { toolCallId: 'e1', name: 'read_file', ok: true, summary: 'ok' });
    at(4, 'tool_start', {
      toolCallId: 'e2',
      name: 'write_file',
      args: '{"path":"docs/fail.md"}',
    });
    at(5, 'tool_result', { toolCallId: 'e2', name: 'write_file', ok: false, summary: 'no' });

    const rows = document.querySelectorAll<HTMLDetailsElement>('.round-block__tool');
    expect(rows).toHaveLength(2);
    expect(linkOf(rows[0])?.textContent).toBe('docs/e2e.md');
    expect(linkOf(rows[1])).toBeNull();

    postMessage.mockClear();
    linkOf(rows[0])!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(postMessage).toHaveBeenCalledWith({
      type: 'open_ref',
      ref: { path: 'docs/e2e.md', kind: 'file' },
    });
  });
});
