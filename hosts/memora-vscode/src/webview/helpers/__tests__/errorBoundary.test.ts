/**
 * Webview 全局错误边界测试（T1）
 *
 * 覆盖：
 *   ① error / unhandledrejection 事件 → host_diag 上报 + 错误卡片插入（textContent 防注入）；
 *   ② 风暴单例：卡片只插一次，但每条错误都上报（留痕不节流）；
 *   ③ 两个入口 Main 的装配守卫（源码级）：边界必须已装配、acquire 仅一次共用
 *      （裸传 acquireVsCodeApi 给工厂 = 二次 acquire 抛错的回归形态）。
 *
 * 驱动方式：注入 fake window 捕获 handler 后直接调用（不依赖 ErrorEvent /
 * PromiseRejectionEvent 构造器在测试环境的可用性）；document 用真实 jsdom。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installWebviewErrorBoundary, type ErrorBoundaryDeps } from '../errorBoundary.js';
import type { WebviewToExtensionMessage } from '../../../shared/protocol.js';

/** 捕获装配后的 handler 与上报流水（fake window 只拦 addEventListener） */
function installCapturing() {
  /** type → handler（error / unhandledrejection 各一） */
  const handlers = new Map<string, (e: Event) => void>();
  /** 上报流水（host_diag 消息） */
  const posted: WebviewToExtensionMessage[] = [];
  const deps: ErrorBoundaryDeps = {
    post: (msg) => posted.push(msg),
    window: {
      addEventListener: (type: string, handler: EventListener) => {
        handlers.set(type, handler as (e: Event) => void);
      },
    },
    document,
  };
  installWebviewErrorBoundary(deps);
  return { handlers, posted };
}

/** 构造 error 事件形态（plain 对象即可，handler 按字段读取不依赖类实例） */
function errorEvent(message: string, error?: Error): Event {
  return { type: 'error', message, error } as unknown as Event;
}

beforeEach(() => {
  // 卡片是 body 级单例：每例清场防跨用例串扰
  document.getElementById('memora-error-card')?.remove();
  document.body.innerHTML = '';
});

describe('installWebviewErrorBoundary', () => {
  it('error 事件 → host_diag 上报 + 卡片插入（含自救指引文本）', () => {
    const { handlers, posted } = installCapturing();
    const boom = new Error('渲染崩了');
    handlers.get('error')!(errorEvent('渲染崩了', boom));

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'host_diag', source: 'error', message: '渲染崩了' });
    const card = document.getElementById('memora-error-card');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('Memora 界面出错了');
    expect(card!.textContent).toContain('渲染崩了');
    expect(card!.textContent).toContain('重新打开面板可恢复');
  });

  it('风暴单例：第二次错误卡片不重复插，但上报仍然发生（留痕不节流）', () => {
    const { handlers, posted } = installCapturing();
    handlers.get('error')!(errorEvent('第一崩'));
    handlers.get('error')!(errorEvent('第二崩'));

    expect(posted).toHaveLength(2);
    expect(document.querySelectorAll('#memora-error-card')).toHaveLength(1);
    // 首卡内容不被后续覆盖（单例 = 只插不改）
    expect(document.getElementById('memora-error-card')!.textContent).toContain('第一崩');
  });

  it('unhandledrejection：Error reason 与非 Error reason 都能归一上报', () => {
    const { handlers, posted } = installCapturing();
    const rejectHandler = handlers.get('unhandledrejection')!;

    rejectHandler({
      type: 'unhandledrejection',
      reason: new Error('异步任务炸了'),
    } as unknown as Event);
    rejectHandler({
      type: 'unhandledrejection',
      reason: '字符串原因',
    } as unknown as Event);

    expect(posted).toHaveLength(2);
    expect(posted[0]).toMatchObject({
      type: 'host_diag',
      source: 'unhandledrejection',
      message: '异步任务炸了',
    });
    expect((posted[1] as { message: string }).message).toBe('字符串原因');
  });

  it('防注入：错误消息里的 HTML 只进文本，不进 DOM 结构', () => {
    const { handlers } = installCapturing();
    handlers.get('error')!(errorEvent('<img src=x onerror=alert(1)> 恶意消息'));

    const card = document.getElementById('memora-error-card')!;
    // textContent 原样保留字符串（不解析），DOM 中不得出现真实 img 元素
    expect(card.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelector('#memora-error-card img')).toBeNull();
    expect(card.querySelector('img')).toBeNull();
  });
});

describe('入口 Main 装配守卫（源码级）', () => {
  const mains = ['chatViewMain.ts', 'settingsViewMain.ts'];
  const scriptsDir = join(__dirname, '../../scripts');

  it.each(mains)('%s 已装配错误边界（删装配行 = 变异即红）', (main) => {
    const src = readFileSync(join(scriptsDir, main), 'utf-8');
    expect(src).toContain('installWebviewErrorBoundary(');
    // 边界必须先于工厂装配（初始化期错误可捕获）：源码中边界行出现在 create* 之前
    const boundaryIdx = src.indexOf('installWebviewErrorBoundary(');
    const factoryIdx = src.search(/create(Chat|Settings)View\(/);
    expect(boundaryIdx).toBeGreaterThan(-1);
    expect(factoryIdx).toBeGreaterThan(boundaryIdx);
  });

  it.each(mains)('%s acquire 仅一次：工厂收 thunk 共用实例（防二次 acquire 抛错）', (main) => {
    const src = readFileSync(join(scriptsDir, main), 'utf-8');
    // 单次纪律：Main 顶层 acquire 一次持有实例
    expect(src).toMatch(/const api = acquireVsCodeApi\(\)/);
    // 工厂必须收返回同一实例的 thunk——裸传 acquireVsCodeApi 会让工厂再 acquire 一次（VS Code 抛错）
    expect(src).toMatch(/acquireVsCodeApi: \(\) => api/);
    expect(src).not.toMatch(/create\w+View\(\{\s*acquireVsCodeApi\s*,/);
  });
});
