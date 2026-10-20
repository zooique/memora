/**
 * 会话大纲导航条（HOST-NAV-1）测试 — helpers/roundNav.ts
 *
 * 分层覆盖：
 *  - 纯函数直测（无 DOM）：extractPreview（预览归一）/ computeActiveIndex（当前轮判定）
 *  - DOM 集成（jsdom）：createRoundNav 控制器——条列构建、签名防重、显隐裁决、
 *    点击定位、注入前缀剥离、fail-fast 守卫
 *
 * jsdom 无布局：scrollHeight / scrollTop / getBoundingClientRect 按需打桩
 * （对齐 chatView.test.ts stubScroll 既有纪律）；高亮在未打桩 rect（恒 0）下的
 * 自然行为（全命中 → 尾条 is-active）也可断言，真实几何表现由真机验收兜。
 */

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildInjectedContextEnvelope, buildDocContextBlock } from '../docContext.js';
import {
  computeActiveIndex,
  computeDensity,
  createRoundNav,
  extractPreview,
  jumpToRound,
} from '../roundNav.js';

/** jsdom 默认视口高（测试内覆写后须还原，防跨用例污染） */
const ORIGINAL_INNER_HEIGHT = window.innerHeight;

/** 覆写视口高（压密预算随它变化） */
function stubInnerHeight(h: number): void {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
}

/** 还原视口高（用例收尾用） */
function restoreInnerHeight(): void {
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: ORIGINAL_INNER_HEIGHT,
  });
}

/** 打桩元素几何（configurable 覆写，测后可还原） */
function stubRect(el: Element, top: number): void {
  el.getBoundingClientRect = () =>
    ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;
}

/** 打桩滚动容器三件套（scrollHeight / clientHeight / scrollTop 读写闭包） */
function stubScrollBox(
  el: HTMLElement,
  box: { scrollHeight: number; clientHeight: number; scrollTop?: number },
): {
  scrollTop: number;
} {
  const state = { scrollTop: box.scrollTop ?? 0 };
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box.clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.scrollTop,
    set: (v: number) => {
      state.scrollTop = v;
    },
  });
  return state;
}

/** 建 #roundNav 外壳（与生产模板同构） */
function mountShell(parent: HTMLElement): HTMLElement {
  const nav = document.createElement('div');
  nav.id = 'roundNav';
  nav.className = 'round-nav';
  nav.hidden = true;
  nav.innerHTML = '<div class="round-nav__track"></div><div class="round-nav__panel"></div>';
  parent.appendChild(nav);
  return nav;
}

/** 建一个用户轮次气泡（与 append() 的 user 分支同构：wrapper > msg.user > msg-body） */
function mountUserBubble(messages: HTMLElement, text: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper';
  const bubble = document.createElement('div');
  bubble.className = 'msg user';
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text;
  bubble.appendChild(body);
  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  return wrapper;
}

describe('extractPreview（预览归一纯函数）', () => {
  it('剥掉宿主注入信封前缀，还原用户请求原文（重放路径形态）', () => {
    // 写入侧对偶构造：不硬编码前缀字符串，防前缀格式演化时测试失真
    const envelope = buildInjectedContextEnvelope(
      [buildDocContextBlock('文档正文……')],
      '帮我把第三节改短',
    );
    expect(extractPreview(envelope)).toBe('帮我把第三节改短');
  });

  it('多行多空格压缩成单行（气泡 textContent 保留换行，预览单行化）', () => {
    expect(extractPreview('第一行\n\n  第二行   文本')).toBe('第一行 第二行 文本');
  });

  it('超长截断到 60 字符加省略号', () => {
    const long = '长'.repeat(80);
    const out = extractPreview(long);
    expect(out.length).toBe(61); // 60 字符 + …
    expect(out.endsWith('…')).toBe(true);
  });

  it('无注入前缀的普通消息原样（仅单行化）', () => {
    expect(extractPreview('普通输入')).toBe('普通输入');
  });
});

describe('computeActiveIndex（当前轮判定纯函数）', () => {
  it('块顶滚入阈值内的最后一个为当前轮', () => {
    // tops 按文档序升序；10/50 已入阈值（96），120 未入 → 当前 = 1
    expect(computeActiveIndex([10, 50, 120], 0)).toBe(1);
  });

  it('全部块仍在视口顶下方阈值之外 → -1（无高亮）', () => {
    expect(computeActiveIndex([200, 300], 0)).toBe(-1);
  });

  it('全部块都已滚过 → 最后一个为当前轮', () => {
    expect(computeActiveIndex([10, 20, 30], 0)).toBe(2);
  });

  it('阈值取自调用方（可覆写默认 96）', () => {
    expect(computeActiveIndex([150], 0, 200)).toBe(0);
  });
});

describe('computeDensity（自适应压密纯函数）', () => {
  it('未就绪（轮数 0 或可用高 0）→ 宽松态默认，不误压', () => {
    expect(computeDensity(0, 500)).toEqual({ barH: 12, gap: 6 });
    expect(computeDensity(5, 0)).toEqual({ barH: 12, gap: 6 });
  });

  it('宽松布局装得下 → 保持宽松（绝大多数会话形态）', () => {
    // 5 轮宽松总高 = 5*12 + 4*6 = 84 ≤ 1000
    expect(computeDensity(5, 1000)).toEqual({ barH: 12, gap: 6 });
  });

  it('第一步：条高保持，先压间隙到下限之上', () => {
    // 10 轮宽松总高 174 > 150；gapFit = (150-120)/9 = 3.33 → 3 → {12,3}
    expect(computeDensity(10, 150)).toEqual({ barH: 12, gap: 3 });
  });

  it('第二步：间隙触底后再压条高（下限之上）', () => {
    // 10 轮 gapFit < 1 → barFit = (100-9)/10 = 9.1 → 9 → {9,1}
    expect(computeDensity(10, 100)).toEqual({ barH: 9, gap: 1 });
  });

  it('单轮且空间极小：直接压下条高（不过间隙分支）', () => {
    expect(computeDensity(1, 5)).toEqual({ barH: 5, gap: 1 });
  });

  it('极端轮数：压到双下限（barH=3 / gap=1），余量交条列滚动兜底', () => {
    // 100 轮 gapFit < 1 → barFit = (150-99)/100 = 0.51 → 0 → 取下限 3 → {3,1}
    expect(computeDensity(100, 150)).toEqual({ barH: 3, gap: 1 });
  });
});

describe('jumpToRound（点击定位）', () => {
  it('按 rect 差值把目标块顶滚到可视顶 inset 处，并显式重算吸底标记', () => {
    const messages = document.createElement('div');
    document.body.appendChild(messages);
    const target = document.createElement('div');
    messages.appendChild(target);
    stubRect(messages, 0); // 容器可视顶 = 视口 0
    stubRect(target, 300); // 目标块顶在视口 300
    const state = stubScrollBox(messages, {
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTop: 0,
    });
    // 期望 scrollTop += 300 - 0 - 12 = 288；吸底 = 2000 - 288 - 400 = 1312 > 48 → false
    const atBottom = jumpToRound(messages, target);
    expect(state.scrollTop).toBe(288);
    expect(atBottom).toBe(false);
    document.body.innerHTML = '';
  });

  it('定位到接近底部时吸底真值为 true（调用方据此隐「一键到底」）', () => {
    const messages = document.createElement('div');
    document.body.appendChild(messages);
    const target = document.createElement('div');
    messages.appendChild(target);
    stubRect(messages, 0);
    stubRect(target, 1600); // scrollTop += 1600 - 12 = 1588
    stubScrollBox(messages, {
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTop: 0,
    }); // 2000 - 1588 - 400 = 12 ≤ 48 → 吸底
    expect(jumpToRound(messages, target)).toBe(true);
    document.body.innerHTML = '';
  });
});

describe('createRoundNav（控制器集成）', () => {
  let root: HTMLElement;
  let messages: HTMLElement;
  let nav: HTMLElement;
  let track: HTMLElement;
  let panel: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.body;
    messages = document.createElement('div');
    messages.id = 'messages';
    root.appendChild(messages);
    nav = mountShell(root);
    track = nav.querySelector('.round-nav__track') as HTMLElement;
    panel = nav.querySelector('.round-nav__panel') as HTMLElement;
    // 一键到底按钮：点击定位后同步显隐（生产接线契约）
    const btn = document.createElement('button');
    btn.id = 'scrollToBottomBtn';
    root.appendChild(btn);
  });

  afterEach(() => {
    restoreInnerHeight();
  });

  it('fail-fast：外壳缺条列/浮层容器时抛清晰错误（夹具镜像失同步立即暴露）', () => {
    const broken = document.createElement('div');
    root.appendChild(broken);
    expect(() => createRoundNav(messages, broken)).toThrow(/round-nav__track/);
  });

  it('可滚动且 ≥2 轮 → 显形并按轮构建条列与浮层行（aria-label/预览同源）', () => {
    mountUserBubble(messages, '第一轮输入');
    mountUserBubble(messages, '第二轮\n多行输入');
    stubScrollBox(messages, { scrollHeight: 2000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    expect(nav.hidden).toBe(false);
    const bars = track.querySelectorAll('.round-nav__bar');
    const items = panel.querySelectorAll('.round-nav__item');
    expect(bars.length).toBe(2);
    expect(items.length).toBe(2);
    // 预览 = 上屏文本单行化；aria-label 与 title 同源
    expect((bars[1] as HTMLElement).title).toBe('第二轮 多行输入');
    expect(bars[1].getAttribute('aria-label')).toBe('第 2 轮：第二轮 多行输入');
    expect(items[1].textContent).toBe('第二轮 多行输入');
  });

  it('不足两轮或容器不可滚动 → 整条隐藏（平时几乎隐形，不占布局）', () => {
    mountUserBubble(messages, '唯一一轮');
    stubScrollBox(messages, { scrollHeight: 2000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    expect(nav.hidden).toBe(true); // 1 轮：无导航价值
    mountUserBubble(messages, '第二轮');
    sync();
    expect(nav.hidden).toBe(false); // 2 轮 + 可滚动 → 显形
    Object.defineProperty(messages, 'scrollHeight', {
      configurable: true,
      get: () => 400, // 与 clientHeight 相等 = 不可滚动
    });
    sync();
    expect(nav.hidden).toBe(true);
  });

  it('签名未变时跳过重建（流式期每帧 sync 不重建 DOM）；尾块文本增长则重建', () => {
    mountUserBubble(messages, '第一轮');
    mountUserBubble(messages, '第二轮');
    stubScrollBox(messages, { scrollHeight: 2000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    const barBefore = track.querySelector('.round-nav__bar');
    sync(); // 同 DOM 同内容 → 签名命中 → 引用不变
    expect(track.querySelector('.round-nav__bar')).toBe(barBefore);
    // 尾块文本增长（流式期用户气泡不会长，但重放/重建路径内容会变）→ 签名变 → 重建
    const lastBody = messages.querySelectorAll('.msg-body')[1] as HTMLElement;
    lastBody.textContent = '第二轮内容变长了';
    sync();
    expect(track.querySelector('.round-nav__bar')).not.toBe(barBefore);
    expect(track.querySelectorAll('.round-nav__bar').length).toBe(2);
  });

  it('点击条定位到对应轮：scrollTop 按目标轮寻址，并同步一键到底按钮显隐', () => {
    const w0 = mountUserBubble(messages, '第一轮');
    const w1 = mountUserBubble(messages, '第二轮');
    stubRect(messages, 0);
    stubRect(w0, 0);
    stubRect(w1, 1200); // 第 2 轮块顶在视口 1200
    stubScrollBox(messages, { scrollHeight: 3000, clientHeight: 400, scrollTop: 0 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    const bar1 = track.querySelectorAll('.round-nav__bar')[1] as HTMLElement;
    bar1.click();
    // scrollTop += 1200 - 0 - 12 = 1188；3000 - 1188 - 400 = 1412 > 48 → 不吸底 → 按钮显示
    const btn = document.getElementById('scrollToBottomBtn') as HTMLButtonElement;
    expect(btn.hidden).toBe(false);
  });

  it('注入前缀在上屏文本中的轮次（重放形态）预览被剥离，只露用户请求', () => {
    const envelope = buildInjectedContextEnvelope(
      [buildDocContextBlock('文档正文')],
      '重放轮的用户请求',
    );
    mountUserBubble(messages, envelope);
    mountUserBubble(messages, '第二轮');
    stubScrollBox(messages, { scrollHeight: 2000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    const bar0 = track.querySelectorAll('.round-nav__bar')[0] as HTMLElement;
    expect(bar0.title).toBe('重放轮的用户请求');
  });

  it('jsdom 未打桩 rect（恒 0）下 sync 后尾条高亮（几何表现由真机验收兜）', () => {
    mountUserBubble(messages, '第一轮');
    mountUserBubble(messages, '第二轮');
    stubScrollBox(messages, { scrollHeight: 2000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    const bars = track.querySelectorAll('.round-nav__bar');
    expect(bars[1].classList.contains('is-active')).toBe(true);
    expect(bars[0].classList.contains('is-active')).toBe(false);
  });

  it('指纹全量：仅中段预览变化也重建（堵重放/分叉「条数+首尾长」静默失效）', () => {
    mountUserBubble(messages, 'AAA');
    mountUserBubble(messages, 'BBB');
    mountUserBubble(messages, 'CCC');
    stubScrollBox(messages, { scrollHeight: 2000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    const barBefore = track.querySelector('.round-nav__bar');
    // 条数（3）与首尾长度（3/3）均不变，仅中段文本换字（同长度）——旧「首尾长」指纹会误判未变
    const midBody = messages.querySelectorAll('.msg-body')[1] as HTMLElement;
    midBody.textContent = 'ZZZ';
    sync();
    expect(track.querySelector('.round-nav__bar')).not.toBe(barBefore);
    expect((track.querySelectorAll('.round-nav__bar')[1] as HTMLElement).title).toBe('ZZZ');
  });

  it('压密接线：按视口高预算下发条列限高/间隙/条高（resize 复用 sync 重算）', () => {
    stubInnerHeight(300); // 预算 = 300 * 0.5 = 150
    for (let i = 0; i < 10; i++) mountUserBubble(messages, `第 ${i + 1} 轮`);
    stubScrollBox(messages, { scrollHeight: 4000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    // computeDensity(10, 150) = { barH: 12, gap: 3 }
    expect(track.style.maxHeight).toBe('150px');
    expect(track.style.gap).toBe('3px');
    expect((track.querySelector('.round-nav__bar') as HTMLElement).style.height).toBe('12px');
    // 缩小视口 → 预算变小 → 重算压密（模拟 resize）
    stubInnerHeight(80); // 预算 = 40 → barFit = (40-9)/10 = 3.1 → 取下限 3
    sync();
    expect(track.style.maxHeight).toBe('40px');
    expect((track.querySelector('.round-nav__bar') as HTMLElement).style.height).toBe('3px');
  });

  it('极端轮数：全量条不截断，压到双下限（gap=1 / barH=3）交条列滚动兜底', () => {
    stubInnerHeight(300);
    for (let i = 0; i < 100; i++) mountUserBubble(messages, `第 ${i + 1} 轮`);
    stubScrollBox(messages, { scrollHeight: 9000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    expect(track.querySelectorAll('.round-nav__bar').length).toBe(100);
    expect(track.style.gap).toBe('1px');
    expect((track.querySelector('.round-nav__bar') as HTMLElement).style.height).toBe('3px');
  });
});
