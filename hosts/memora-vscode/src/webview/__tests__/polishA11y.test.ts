/**
 * 润色按钮 loading 无障碍双通道守卫（POLISH-A11Y-1）
 *
 * 视觉态 `.loading`（旋转 + 降透明）此前是唯一忙信号，读屏用户无从得知润色在进行；
 * 本守卫钉住 `aria-busy` 与 class 同置位、同清除（成功与失败回执都清），且零协议 / 零新 DOM。
 * 采用真实 DOM 行为测试而非源码字符串：夹具已有 polishBtn / input / activityBar，
 * 缺任一即静默失测（P6 纪律），故直接点按钮、直接分发回执判语义。
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { dispatch, mountChatView } from './helpers/chatViewTestEnv.js';

describe('润色空态禁用（POLISH-EMPTY-1）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('空输入 → 按钮禁用，点击不发 polish_input', () => {
    const { postMessage } = mountChatView();
    const btn = document.getElementById('polishBtn') as HTMLButtonElement;

    expect(btn.disabled).toBe(true);
    btn.click();
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'polish_input', text: '' });
  });

  it('输入事件 → 按钮点亮；清空 → 重新禁用（与发送键同翻转）', () => {
    mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    const send = document.getElementById('send') as HTMLButtonElement;
    const btn = document.getElementById('polishBtn') as HTMLButtonElement;

    input.value = '有内容了';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(btn.disabled).toBe(false);
    expect(send.disabled).toBe(false);

    input.value = '   ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(btn.disabled).toBe(true);
    expect(send.disabled).toBe(true);
  });

  it('程序化回填（润色结果）也同步可用态，不等用户再敲一个键', () => {
    mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    const btn = document.getElementById('polishBtn') as HTMLButtonElement;
    input.value = '待润色';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();
    dispatch({ type: 'polish_input_result', ok: false, message: 'boom' });

    expect(input.value).toBe('待润色');
    expect(btn.disabled).toBe(false);
  });
});

describe('润色 loading 无障碍双通道（POLISH-A11Y-1）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('点击 → aria-busy=true 与 loading class 同置位，post polish_input', () => {
    const { postMessage } = mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    const btn = document.getElementById('polishBtn') as HTMLButtonElement;
    input.value = '这段需要润色';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();

    expect(postMessage).toHaveBeenCalledWith({ type: 'polish_input', text: '这段需要润色' });
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.classList.contains('loading')).toBe(true);
  });

  it('成功回执 → aria-busy 与 loading 同清，文本回填', () => {
    mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    const btn = document.getElementById('polishBtn') as HTMLButtonElement;
    input.value = '这段需要润色';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();
    expect(btn.getAttribute('aria-busy')).toBe('true');

    dispatch({ type: 'polish_input_result', ok: true, text: '润色后的文本' });

    expect(btn.hasAttribute('aria-busy')).toBe(false);
    expect(btn.classList.contains('loading')).toBe(false);
    expect(input.value).toBe('润色后的文本');
  });

  it('失败回执 → 同样清 busy，不留「忙」态（可重试）', () => {
    mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    const btn = document.getElementById('polishBtn') as HTMLButtonElement;
    input.value = '这段需要润色';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();

    dispatch({ type: 'polish_input_result', ok: false, message: 'boom' });

    expect(btn.hasAttribute('aria-busy')).toBe(false);
    expect(btn.classList.contains('loading')).toBe(false);
    expect(input.value).toBe('这段需要润色');
  });
});
