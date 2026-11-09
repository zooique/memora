/**
 * 作品投影行派生测试 — 设置页「显示形状」唯一判据面
 *
 * 判据来源：`host/workProjectionRows.ts` 的 `deriveWorkProjectionView`（纯函数）。
 * 本文件钉的是**派生关系**（内核快照 → 行/空态/失效徽标），不碰 vscode、不碰内核、
 * 不拉起扩展宿主。
 *
 * 🔴 反假绿纪律：每条断言都钉具体字段值（description / statusText / resident / hasFailure / tooltip），
 * 禁止只断言「函数被调用」或「返回了数组」——那类断言在实现退化成空数组时依然绿。
 * 侧边栏树退役后，图标 id 与 contextValue 一并从派生形状移除（渲染面各归一侧），
 * 本套件改钉语义二元组，不再断言任何 ThemeIcon 字面量。
 */
import { describe, it, expect } from 'vitest';
import {
  deriveWorkProjectionView,
  type ResidentFailureReason,
  type ResidentFailureView,
  type ResidentReportView,
  type WorkEntryView,
} from '../workProjectionRows.js';

/** 造一条内核清单快照（字段与 `ManagedWorkEntry` 对齐；resident 已归一为布尔） */
function entry(source: string, resident: boolean, description = ''): WorkEntryView {
  return { name: source.replace(/\.md$/, ''), description, source, resident };
}

/**
 * 造一条失效记录（默认给一句可辨识的 message，用来验证「进 tooltip、不进后缀」）
 *
 * @param source 失效条目路径
 * @param reason 内核原因码
 * @param message 内核人读文案
 */
function failure(
  source: string,
  reason: ResidentFailureReason,
  message = `${source} 的失效说明`,
): ResidentFailureView {
  return { source, reason, message };
}

/**
 * 造一份求值报告
 *
 * @param failures 完整失效集
 * @param dropped 合计超限被丢弃的条目
 * @param listReadable 本轮清单是否读到
 */
function reportView(
  failures: ResidentFailureView[] = [],
  dropped: ResidentFailureView[] = [],
  listReadable = true,
): ResidentReportView {
  return { failures, dropped, listReadable };
}

describe('派生：非行状态（三种「拿不到行」的原因必须分开）', () => {
  it('无 Agent ⇒ no-agent（空清单也不得显示成「还没有登记作品投影」）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: false,
      listMalformed: false,
      entries: [],
      residentReport: null,
    });
    expect(state.kind).toBe('no-agent');
    if (state.kind !== 'no-agent') throw new Error('state 收窄失败');
    expect(state.message).toContain('尚未创建任何会话');
  });

  it('清单格式异常 ⇒ malformed（优先级高于空清单：改 JSON 与去登记是两种自救动作）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: true,
      entries: [entry('a.md', false)],
      residentReport: null,
    });
    expect(state.kind).toBe('malformed');
    if (state.kind !== 'malformed') throw new Error('state 收窄失败');
    expect(state.message).toContain('work-projections.json');
  });

  it('清单为空 ⇒ empty（文案必须指向登记入口，否则用户不知道下一步）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [],
      residentReport: null,
    });
    expect(state.kind).toBe('empty');
    if (state.kind !== 'empty') throw new Error('state 收窄失败');
    expect(state.message).toContain('登记作品投影');
  });
});

describe('派生：行字段', () => {
  it('常驻条目的行：状态后缀 / description / resident / hasFailure / tooltip 逐字段钉死', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('rules.md', true, '仓库硬约束')],
      residentReport: reportView(),
    });
    expect(state.kind).toBe('rows');
    if (state.kind !== 'rows') throw new Error('state 收窄失败');

    expect(state.rows).toHaveLength(1);
    const row = state.rows[0]!;
    expect(row.name).toBe('rules');
    expect(row.source).toBe('rules.md');
    expect(row.statusText).toBe('项目规则');
    expect(row.resident).toBe(true);
    expect(row.hasFailure).toBe(false);
    // 说明进卡片字段（不靠 hover）；tooltip 只留源路径，避免同一句话两处显示
    expect(row.description).toBe('仓库硬约束');
    expect(row.tooltip).toBe('rules.md');
    expect(row.tooltip).not.toContain('仓库硬约束');
  });

  it('非常驻条目的行：未设为项目规则 + resident=false（不得被画成规则）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('notes.md', false, '随手记')],
      residentReport: reportView(),
    });
    if (state.kind !== 'rows') throw new Error('state 收窄失败');
    const row = state.rows[0]!;
    expect(row.statusText).toBe('未设为项目规则');
    expect(row.resident).toBe(false);
    expect(row.hasFailure).toBe(false);
  });

  it('说明为空 ⇒ 原样透传空串、tooltip 只留源路径（不留空行尾巴）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('plain.md', false)],
      residentReport: reportView(),
    });
    if (state.kind !== 'rows') throw new Error('state 收窄失败');
    expect(state.rows[0]!.description).toBe('');
    expect(state.rows[0]!.tooltip).toBe('plain.md');
  });

  it('行序 = 清单数组顺序（注入段「靠前者优先」同一份顺序，禁止另排序）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('b.md', true), entry('a.md', false), entry('c.md', true)],
      residentReport: reportView(),
    });
    if (state.kind !== 'rows') throw new Error('state 收窄失败');
    expect(state.rows.map((r) => r.source)).toEqual(['b.md', 'a.md', 'c.md']);
  });
});

describe('派生：失效徽标（内核报告 → 行后缀 / hasFailure / tooltip）', () => {
  it('读盘失败家族 ⇒ 未注入（读取失败）；文案进 tooltip 而不是后缀', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('rules.md', true, '仓库硬约束')],
      residentReport: reportView([failure('rules.md', 'missing', '源文件不存在：rules.md')]),
    });
    if (state.kind !== 'rows') throw new Error('state 收窄失败');
    const row = state.rows[0]!;
    expect(row.statusText).toBe('项目规则 · 未注入（读取失败）');
    expect(row.hasFailure).toBe(true);
    // 后缀只说分类，内核那句带路径 / 计量的说明放 tooltip（不截断、不改写）
    expect(row.statusText).not.toContain('源文件不存在');
    expect(row.tooltip).toContain('源文件不存在：rules.md');
    // 说明已搬进卡片字段；失效原文仍留 tooltip，两者不重复
    expect(row.description).toBe('仓库硬约束');
    expect(row.tooltip).not.toContain('仓库硬约束');
  });

  it('五类读盘原因码都归到「读取失败」（不逐码造词：用户动作都是去修文件）', () => {
    for (const reason of [
      'outside-workspace',
      'blocked-path',
      'not-textual',
      'missing',
      'read-error',
    ] as const) {
      const state = deriveWorkProjectionView({
        hasAgent: true,
        listMalformed: false,
        entries: [entry('r.md', true)],
        residentReport: reportView([failure('r.md', reason)]),
      });
      if (state.kind !== 'rows') throw new Error('state 收窄失败');
      expect(state.rows[0]!.statusText).toBe('项目规则 · 未注入（读取失败）');
    }
  });

  it('单条超限 ⇒ 未注入（单条超限）（处置是拆文件，不得说成「下轮重试」）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('big.md', true)],
      residentReport: reportView([failure('big.md', 'too-long', '超过单条 5000 上限 320 字符')]),
    });
    if (state.kind !== 'rows') throw new Error('state 收窄失败');
    const row = state.rows[0]!;
    expect(row.statusText).toBe('项目规则 · 未注入（单条超限）');
    expect(row.statusText).not.toContain('下轮重试');
    expect(row.tooltip).toContain('超过单条 5000 上限 320 字符');
  });

  it('合计超限被丢弃（dropped 通道）⇒ 未注入（合计超限）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('a.md', true), entry('b.md', true)],
      residentReport: reportView(
        [],
        [failure('b.md', 'total-exceeded', '本条按清单顺序靠后被丢弃')],
      ),
    });
    if (state.kind !== 'rows') throw new Error('state 收窄失败');
    expect(state.rows.map((r) => r.statusText)).toEqual([
      '项目规则',
      '项目规则 · 未注入（合计超限）',
    ]);
  });

  it('非布尔 resident 误配 ⇒ 未设为项目规则 · 配置有误（该条本来就不是规则）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('bad.md', false)],
      residentReport: reportView([
        failure('bad.md', 'resident-not-boolean', '该条 resident 字段值为 "true"（非布尔）'),
      ]),
    });
    if (state.kind !== 'rows') throw new Error('state 收窄失败');
    const row = state.rows[0]!;
    expect(row.statusText).toBe('未设为项目规则 · 配置有误');
    expect(row.hasFailure).toBe(true);
    expect(row.tooltip).toContain('"true"');
  });

  it('只有失效条目变化：同清单里的正常行不得被牵连（无后缀、hasFailure 仍为 false）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('bad.md', true), entry('ok.md', false)],
      residentReport: reportView([failure('bad.md', 'missing')]),
    });
    if (state.kind !== 'rows') throw new Error('state 收窄失败');
    expect(state.rows[1]!.statusText).toBe('未设为项目规则');
    expect(state.rows[1]!.hasFailure).toBe(false);
  });
});

describe('派生：报告层面的说明行（不得把「没求值 / 没读到」显示成零失效）', () => {
  it('报告为 null 且配了常驻条目 ⇒ info 说明行 + 行内无失效徽标', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('rules.md', true)],
      residentReport: null,
    });
    if (state.kind !== 'rows') throw new Error('state 收窄失败');
    expect(state.notice?.level).toBe('info');
    expect(state.notice?.text).toContain('尚未求值');
    // 关键：没求值过不得被画成「已生效」或「零失效」，行保持原样
    expect(state.rows[0]!.statusText).toBe('项目规则');
    expect(state.rows[0]!.hasFailure).toBe(false);
  });

  it('报告为 null 且没有任何常驻条目 ⇒ 不出说明行（没配规则时这句话是噪音）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('notes.md', false)],
      residentReport: null,
    });
    if (state.kind !== 'rows') throw new Error('state 收窄失败');
    expect(state.notice).toBeUndefined();
  });

  it('listReadable === false ⇒ warning 说明行（本轮整段不注入，不是零失效）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('rules.md', true)],
      residentReport: reportView([], [], false),
    });
    if (state.kind !== 'rows') throw new Error('state 收窄失败');
    expect(state.notice?.level).toBe('warning');
    expect(state.notice?.text).toContain('未读到清单');
    // 报告读不到清单时不得给出任何「已生效」暗示：行后缀保持中性
    expect(state.rows[0]!.statusText).toBe('项目规则');
  });

  it('报告已求值且零失效 ⇒ 无说明行（此时沉默才是准确的）', () => {
    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [entry('rules.md', true)],
      residentReport: reportView(),
    });
    if (state.kind !== 'rows') throw new Error('state 收窄失败');
    expect(state.notice).toBeUndefined();
  });
});
