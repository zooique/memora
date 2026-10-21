/**
 * 注入型上下文（`HOST-CTX-4`）webview 侧验收：chip / 汇总回执 / 发送 / 复位
 *
 * 守的是拍板四问在 webview 的落点：
 *   ① 身份判据 = 来源枚举（同 source 幂等一枚，不按内容哈希）；
 *   ② 承载位 = `injection_summary` 按源分项（活动文件 chip 的微记也读它，渲染两处、数据一次）；
 *   ③ 生命周期 = 注入 chip **无 🔒**、发送后无条件清（常驻 = 每轮悄悄塞内容，违背「不泛化」）；
 *   ④ 采集时机 = 挂载只记标记、发送时刻才取数 ⇒ 上行载荷只带通道名、**绝不携带内容**。
 *
 * 与引用 chip 的边界（CTX-4 前置不变量）：引用只挂指针、注入带内容——二者并排在同一行，
 * 故 chip 用形状 + 颜色双通道区分（`.injection-chip`，视觉层由 tokensClosure / 真机守）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { dispatch, mountChatView } from './helpers/chatViewTestEnv.js';

/** 注入 chip 的查询锚（与生产 `buildInjectionChip` 的 data-injection 同源） */
const injectionChips = (): NodeListOf<HTMLElement> =>
  document.querySelectorAll('#refChips .injection-chip');

const receipt = (): HTMLElement => document.getElementById('occInjection') as HTMLElement;

/** 走一遍「输入框有内容 → 点发送」的标准动作 */
function sendText(text: string): void {
  const input = document.getElementById('input') as HTMLTextAreaElement;
  const send = document.getElementById('send') as HTMLButtonElement;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  send.click();
}

describe('注入型上下文 chip（HOST-CTX-4 · @problems 第一笔）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('add_injection → 附件行出现注入 chip，文案明说「内容已注入」', () => {
    mountChatView();
    dispatch({ type: 'add_injection', source: 'problems' });
    expect(injectionChips().length).toBe(1);
    const chip = injectionChips()[0];
    expect(chip.dataset.injection).toBe('problems');
    // 与引用 chip 的「仅挂指针」语义相反，必须在可见面说清
    expect(chip.querySelector('.skill-chip__note')?.textContent).toBe('内容已注入');
    // chip 可见名 = injectionSourceMeta 的 segmentLabel 单点（2026-10-21 SSOT 化回填时补：
    // 此前只断言 note/title，变异 segmentLabel 仅回执一例红——chip 可见名面零覆盖）
    expect(chip.querySelector('.skill-chip__name')?.textContent).toBe('工作区诊断');
    expect(chip.querySelector('.skill-chip__name')?.getAttribute('title')).toContain('已注入');
    expect(document.getElementById('refChips')?.hasAttribute('hidden')).toBe(false);
  });

  it('幂等：同一 source 重复挂载恒一枚（身份判据 = 来源枚举，非内容哈希）', () => {
    mountChatView();
    dispatch({ type: 'add_injection', source: 'problems' });
    dispatch({ type: 'add_injection', source: 'problems' });
    expect(injectionChips().length).toBe(1);
  });

  it('无 🔒 常驻锁（发送后保留 = 每轮悄悄塞内容，违背「不泛化」）', () => {
    mountChatView();
    dispatch({ type: 'add_injection', source: 'problems' });
    expect(injectionChips()[0].querySelector('.skill-chip__pin')).toBeNull();
  });

  it('× 移除 → chip 消失、行收起（SSOT = currentInjections 数组）', () => {
    mountChatView();
    dispatch({ type: 'add_injection', source: 'problems' });
    (injectionChips()[0].querySelector('.skill-chip__remove') as HTMLElement).click();
    expect(injectionChips().length).toBe(0);
    expect(document.getElementById('refChips')?.hasAttribute('hidden')).toBe(true);
  });

  it("via='mention' → 撤掉触发 QuickPick 的那个 '@'（只选关键字项时 @ 不该残留正文）", () => {
    mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.value = '帮我看';
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '@', bubbles: true }));
    input.value = '帮我看@';
    input.setSelectionRange(4, 4);
    dispatch({ type: 'add_injection', source: 'problems', via: 'mention' });
    expect(input.value).toBe('帮我看');
    expect(injectionChips().length).toBe(1);
  });

  it('不带 via 的 add_injection 不动正文（防误删邮箱等合法 @ 字样）', () => {
    mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.value = '联系 foo@bar.com';
    dispatch({ type: 'add_injection', source: 'problems' });
    expect(input.value).toBe('联系 foo@bar.com');
  });

  it('引用被清空后注入 chip 仍在（显隐判据只写一次，不互相连坐）', () => {
    mountChatView();
    dispatch({ type: 'addRef', refs: [{ path: 'src/a.ts', kind: 'file' }] });
    dispatch({ type: 'add_injection', source: 'problems' });
    (document.querySelector('#refChips .ref-chips__clear') as HTMLElement).click();
    // 「清空全部引用」只清引用（标题即写明引用），注入 chip 各有自己的 ✕
    expect(injectionChips().length).toBe(1);
    expect(document.getElementById('refChips')?.hasAttribute('hidden')).toBe(false);
  });
});

describe('发送：只声明通道，不携带内容（HOST-CTX-4 ④）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('上行 payload 带 injections（通道标记），发送后 chip 无条件清', () => {
    const { postMessage } = mountChatView();
    dispatch({ type: 'add_injection', source: 'problems' });
    sendText('帮我修这些错');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'input',
      kind: 'send',
      text: '帮我修这些错',
      injections: ['problems'],
    });
    // 无 🔒 ⇒ 发送即清（不留「每轮都塞一份」的隐形负担）
    expect(injectionChips().length).toBe(0);
  });

  it('无挂载时载荷不含 injections 字段（不污染纯文本消息）', () => {
    const { postMessage } = mountChatView();
    sendText('普通提问');
    expect(postMessage).toHaveBeenCalledWith({ type: 'input', kind: 'send', text: '普通提问' });
  });

  it('发送即作废上一轮回执（数字只属于刚发出那一轮，不跨轮残留）', () => {
    mountChatView();
    dispatch({
      type: 'injection_summary',
      summary: { segments: [{ source: 'problems', injected: true, tokens: 120 }], total: 120 },
    });
    expect(receipt().hidden).toBe(false);
    sendText('再来一轮');
    expect(receipt().hidden).toBe(true);
    expect(receipt().textContent).toBe('');
  });
});

describe('本轮注入回执行（HOST-CTX-4 ② · 圆环 hover 卡片底部）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('发送后回推 → 回执行显「本轮注入 N」，分项明细同屏（不再藏 title）', () => {
    mountChatView();
    dispatch({
      type: 'injection_summary',
      summary: {
        segments: [
          { source: 'active-file', injected: true, tokens: 3258 },
          { source: 'problems', injected: true, tokens: 120 },
        ],
        total: 3378,
      },
    });
    expect(receipt().hidden).toBe(false);
    // 数字口径与卡片其余行统一（fmtTokens 精确式：非整千走千分位）
    expect(receipt().textContent).toBe(
      '本轮注入 3,378（当前文件正文 3,258 · 工作区诊断 120）· 发送时刻估算，下一轮覆盖',
    );
  });

  it('本轮零注入 → 回执行保持隐藏（「本轮注入 0」是纯噪音且像「挂了没生效」）', () => {
    mountChatView();
    dispatch({
      type: 'injection_summary',
      summary: { segments: [{ source: 'active-file', injected: false }], total: 0 },
    });
    expect(receipt().hidden).toBe(true);
    expect(receipt().textContent).toBe('');
  });

  it('清空会话（clear_ok）→ 注入 chip 与回执行一并复位（不跨会话残留）', () => {
    mountChatView();
    dispatch({ type: 'add_injection', source: 'problems' });
    dispatch({
      type: 'injection_summary',
      summary: { segments: [{ source: 'problems', injected: true, tokens: 120 }], total: 120 },
    });
    expect(injectionChips().length).toBe(1);
    expect(receipt().hidden).toBe(false);
    dispatch({ type: 'clear_ok' });
    expect(injectionChips().length).toBe(0);
    expect(receipt().hidden).toBe(true);
  });

  it('回执行挂圆环 hover 卡片内、状态行无徽记（2026-10-21 真机反馈后的防回潮守卫）', () => {
    mountChatView();
    dispatch({
      type: 'injection_summary',
      summary: { segments: [{ source: 'problems', injected: true, tokens: 120 }], total: 120 },
    });
    // 承载位 = 圆环 hover 卡片（预算域），不在状态行（稳定身份徽章的行）
    expect(receipt().closest('.context-ring__tip')).not.toBeNull();
    // 旧徽记整模移除：状态行再出现数字 pill 即回潮
    expect(document.getElementById('injectionBadge')).toBeNull();
  });
});
