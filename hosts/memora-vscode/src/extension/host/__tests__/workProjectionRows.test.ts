/**
 * 作品投影行派生测试 — 树视图的「显示形状」唯一判据面
 *
 * 判据来源：`host/workProjectionRows.ts` 的 `deriveWorkProjectionView`（纯函数）。
 * 本文件钉的是**派生关系**（内核快照 → 行/空态），不碰 vscode、不碰内核、不拉起扩展宿主。
 *
 * 🔴 反假绿纪律：每条断言都钉具体字段值（label / description / icon / contextValue / tooltip），
 * 禁止只断言「函数被调用」或「返回了数组」——那类断言在实现退化成空数组时依然绿。
 */
import { describe, it, expect } from 'vitest';
import {
  deriveWorkProjectionView,
  WORK_PROJECTION_ITEM_CONTEXT,
  type WorkEntryView,
} from '../workProjectionRows.js';

/** 造一条内核清单快照（字段与 `ManagedWorkEntry` 对齐；resident 已归一为布尔） */
function entry(source: string, resident: boolean, description = ''): WorkEntryView {
  return { name: source.replace(/\.md$/, ''), description, source, resident };
}

describe('派生：非行状态（三种「拿不到行」的原因必须分开）', () => {
  it('无 Agent ⇒ no-agent（空清单也不得显示成「还没有登记作品投影」）', () => {
    const state = deriveWorkProjectionView({ hasAgent: false, listMalformed: false, entries: [] });
    expect(state.kind).toBe('no-agent');
    if (state.kind !== 'no-agent') throw new Error('state 收窄失败');
    expect(state.message).toContain('尚未创建任何会话');
  });

  it('清单格式异常 ⇒ malformed（优先级高于空清单：改 JSON 与去登记是两种自救动作）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: true,
      entries: [entry('a.md', false)],
    });
    expect(state.kind).toBe('malformed');
    if (state.kind !== 'malformed') throw new Error('state 收窄失败');
    expect(state.message).toContain('work-projections.json');
  });

  it('清单为空 ⇒ empty（文案必须指向登记入口，否则用户不知道下一步）', () => {
    const state = deriveWorkProjectionView({ hasAgent: true, listMalformed: false, entries: [] });
    expect(state.kind).toBe('empty');
    if (state.kind !== 'empty') throw new Error('state 收窄失败');
    expect(state.message).toContain('登记作品投影');
  });
});

describe('派生：行字段', () => {
  it('常驻条目的行：状态后缀 / 图标 / contextValue / tooltip 逐字段钉死', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('rules.md', true, '仓库硬约束')],
    });
    expect(state.kind).toBe('rows');
    if (state.kind !== 'rows') throw new Error('state 收窄失败');

    expect(state.rows).toHaveLength(1);
    const row = state.rows[0]!;
    expect(row.name).toBe('rules');
    expect(row.source).toBe('rules.md');
    expect(row.statusText).toBe('项目规则');
    expect(row.icon).toBe('shield');
    expect(row.contextValue).toBe(WORK_PROJECTION_ITEM_CONTEXT);
    // tooltip 同时带源路径与说明（不打开文件也能确认是哪一份、干什么的）
    expect(row.tooltip).toContain('rules.md');
    expect(row.tooltip).toContain('仓库硬约束');
  });

  it('非常驻条目的行：未设为项目规则 + file 图标（不得出现 shield）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('notes.md', false, '随手记')],
    });
    if (state.kind !== 'rows') throw new Error('state 收窄失败');
    const row = state.rows[0]!;
    expect(row.statusText).toBe('未设为项目规则');
    expect(row.icon).toBe('file');
    expect(row.icon).not.toBe('shield');
  });

  it('说明为空 ⇒ tooltip 只留源路径（不留空行尾巴）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('plain.md', false)],
    });
    if (state.kind !== 'rows') throw new Error('state 收窄失败');
    expect(state.rows[0]!.tooltip).toBe('plain.md');
  });

  it('行序 = 清单数组顺序（注入段「靠前者优先」同一份顺序，禁止另排序）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('b.md', true), entry('a.md', false), entry('c.md', true)],
    });
    if (state.kind !== 'rows') throw new Error('state 收窄失败');
    expect(state.rows.map((r) => r.source)).toEqual(['b.md', 'a.md', 'c.md']);
  });
});
