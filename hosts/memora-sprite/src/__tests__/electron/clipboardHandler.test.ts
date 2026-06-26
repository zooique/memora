/**
 * ClipboardHandler 单元测试
 *
 * 验证三重保护流程：被动检测 + 主动触发 + 敏感过滤。
 * 通过 mock clipboard 接口实现纯逻辑测试，不依赖 Electron 运行时。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClipboardHandler, isSensitive, SENSITIVE_PATTERNS } from '../../electron/clipboardHandler.js';
import type { Clipboard } from 'electron';

/** Mock Clipboard 类型：Clipboard 接口 + 测试辅助方法 */
type MockClipboard = Clipboard & { setText: (text: string) => void };

/** Mock Clipboard（模拟 Electron clipboard 模块） */
function createMockClipboard(initialText = ''): MockClipboard {
  let currentText = initialText;
  // vi.fn() 返回的 Mock 类型与 Clipboard 接口方法签名不完全兼容，
  // 用 as unknown as MockClipboard 显式断言（比 as any 更安全，要求显式转换）
  return {
    readText: vi.fn(() => currentText),
    writeText: vi.fn((text: string) => { currentText = text; }),
    readHTML: vi.fn(() => ''),
    writeHTML: vi.fn(),
    readRTF: vi.fn(() => ''),
    writeRTF: vi.fn(),
    readImage: vi.fn(),
    writeImage: vi.fn(),
    readBookmark: vi.fn(),
    writeBookmark: vi.fn(),
    clear: vi.fn(() => { currentText = ''; }),
    availableFormats: vi.fn(() => []),
    has: vi.fn(() => false),
    read: vi.fn(() => ''),
    readFindText: vi.fn(() => ''),
    writeFindText: vi.fn(),
    // 测试辅助方法
    setText: (text: string) => { currentText = text; },
  } as unknown as MockClipboard;
}

describe('isSensitive 纯函数', () => {
  describe('Token 检测', () => {
    it('检测 Bearer Token', () => {
      expect(isSensitive('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx')).toEqual({
        sensitive: true,
        type: 'token',
      });
    });

    it('检测 sk- 前缀的 API Key', () => {
      expect(isSensitive('sk-1234567890abcdef')).toEqual({
        sensitive: true,
        type: 'token',
      });
    });

    it('检测 api_key= 前缀', () => {
      expect(isSensitive('api_key=ABC123XYZ')).toEqual({
        sensitive: true,
        type: 'token',
      });
    });
  });

  describe('信用卡检测', () => {
    it('检测 16 位连续数字', () => {
      expect(isSensitive('4111111111111111')).toEqual({
        sensitive: true,
        type: 'credit-card',
      });
    });

    it('检测带空格的信用卡号', () => {
      expect(isSensitive('4111 1111 1111 1111')).toEqual({
        sensitive: true,
        type: 'credit-card',
      });
    });

    it('检测带连字符的信用卡号', () => {
      expect(isSensitive('4111-1111-1111-1111')).toEqual({
        sensitive: true,
        type: 'credit-card',
      });
    });
  });

  describe('密码检测', () => {
    it('检测强密码（大小写+数字+特殊字符）', () => {
      expect(isSensitive('Password123!')).toEqual({
        sensitive: true,
        type: 'password',
      });
    });

    it('不误判普通文本', () => {
      expect(isSensitive('Hello World')).toEqual({ sensitive: false });
    });

    it('不误判短文本', () => {
      expect(isSensitive('abc')).toEqual({ sensitive: false });
    });
  });

  describe('私钥检测', () => {
    it('检测 RSA 私钥', () => {
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...';
      expect(isSensitive(pem)).toEqual({
        sensitive: true,
        type: 'private-key',
      });
    });

    it('检测 EC 私钥', () => {
      const pem = '-----BEGIN EC PRIVATE KEY-----\nMHQCAQEE...';
      expect(isSensitive(pem)).toEqual({
        sensitive: true,
        type: 'private-key',
      });
    });

    it('检测 OPENSSH 私钥', () => {
      const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE...';
      expect(isSensitive(pem)).toEqual({
        sensitive: true,
        type: 'private-key',
      });
    });
  });

  describe('AWS Access Key 检测', () => {
    it('检测 AWS Access Key', () => {
      expect(isSensitive('AKIAIOSFODNN7EXAMPLE')).toEqual({
        sensitive: true,
        type: 'aws-key',
      });
    });
  });

  describe('非敏感内容', () => {
    it('普通代码片段不敏感', () => {
      expect(isSensitive('function hello() { return "world"; }')).toEqual({
        sensitive: false,
      });
    });

    it('普通文本不敏感', () => {
      expect(isSensitive('这是一段普通文本，用于测试')).toEqual({
        sensitive: false,
      });
    });

    it('URL 不敏感', () => {
      expect(isSensitive('https://example.com/path?query=value')).toEqual({
        sensitive: false,
      });
    });

    it('邮箱不敏感', () => {
      expect(isSensitive('user@example.com')).toEqual({
        sensitive: false,
      });
    });
  });
});

describe('ClipboardHandler', () => {
  let mockClipboard: ReturnType<typeof createMockClipboard>;
  let emitHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockClipboard = createMockClipboard('initial content');
    emitHandler = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('轮询检测', () => {
    it('启动轮询后定时检测变化', () => {
      vi.useFakeTimers();
      const handler = new ClipboardHandler(mockClipboard, { emit: emitHandler });

      handler.startPolling();
      expect(handler.isPolling()).toBe(true);

      // 内容未变化，不应触发事件
      vi.advanceTimersByTime(2000);
      expect(emitHandler).not.toHaveBeenCalled();

      // 内容变化，应触发 changed 事件
      mockClipboard.setText('new content');
      vi.advanceTimersByTime(2000);
      expect(emitHandler).toHaveBeenCalledWith('changed');

      handler.stopPolling();
    });

    it('changed 事件不携带内容（隐私保护）', () => {
      vi.useFakeTimers();
      const handler = new ClipboardHandler(mockClipboard, { emit: emitHandler });

      handler.startPolling();
      mockClipboard.setText('secret content');
      vi.advanceTimersByTime(2000);

      // 验证事件载荷不含内容
      const call = emitHandler.mock.calls[0];
      expect(call[0]).toBe('changed');
      expect(call[1]).toBeUndefined();

      handler.stopPolling();
    });

    it('重复启动轮询不会重复注册（幂等保护）', () => {
      const handler = new ClipboardHandler(mockClipboard, { emit: emitHandler });

      handler.startPolling();
      handler.startPolling();

      expect(handler.isPolling()).toBe(true);
      handler.stopPolling();
    });

    it('停止轮询后不再检测变化', () => {
      vi.useFakeTimers();
      const handler = new ClipboardHandler(mockClipboard, { emit: emitHandler });

      handler.startPolling();
      handler.stopPolling();
      expect(handler.isPolling()).toBe(false);

      mockClipboard.setText('changed after stop');
      vi.advanceTimersByTime(5000);
      expect(emitHandler).not.toHaveBeenCalled();
    });

    it('启动时记录当前哈希，避免立即触发变化事件', () => {
      vi.useFakeTimers();
      const handler = new ClipboardHandler(mockClipboard, { emit: emitHandler });

      handler.startPolling();
      // 内容未变化，第一次轮询不应触发
      vi.advanceTimersByTime(2000);
      expect(emitHandler).not.toHaveBeenCalled();

      handler.stopPolling();
    });
  });

  describe('analyze 分析流程', () => {
    it('空内容不处理', () => {
      mockClipboard.setText('');
      const handler = new ClipboardHandler(mockClipboard, { emit: emitHandler });

      const result = handler.analyze();

      expect(result).toBe(false);
      expect(emitHandler).not.toHaveBeenCalled();
    });

    it('纯空白内容不处理', () => {
      mockClipboard.setText('   \n\t  ');
      const handler = new ClipboardHandler(mockClipboard, { emit: emitHandler });

      const result = handler.analyze();

      expect(result).toBe(false);
      expect(emitHandler).not.toHaveBeenCalled();
    });

    it('敏感内容静默忽略，不触发 analysis-ready', () => {
      mockClipboard.setText('Bearer eyJhbGciOiJIUzI1NiJ9');
      const handler = new ClipboardHandler(mockClipboard, { emit: emitHandler });

      const result = handler.analyze();

      expect(result).toBe(false);
      expect(emitHandler).toHaveBeenCalledWith('sensitive-ignored', { type: 'token' });
      expect(emitHandler).not.toHaveBeenCalledWith('analysis-ready', expect.anything());
    });

    it('非敏感内容通过检测，触发 analysis-ready', () => {
      const content = 'function hello() { return "world"; }';
      mockClipboard.setText(content);
      const handler = new ClipboardHandler(mockClipboard, { emit: emitHandler });

      const result = handler.analyze();

      expect(result).toBe(true);
      expect(emitHandler).toHaveBeenCalledWith('analysis-ready', { content });
    });

    it('配置输入护栏时，被拦截的内容触发 analysis-rejected', () => {
      const content = 'some content';
      mockClipboard.setText(content);
      const inputGuard = vi.fn(() => ({ blocked: true, reason: '内容过长' }));
      const handler = new ClipboardHandler(mockClipboard, {
        emit: emitHandler,
        inputGuard,
      });

      const result = handler.analyze();

      expect(result).toBe(false);
      expect(inputGuard).toHaveBeenCalledWith(content);
      expect(emitHandler).toHaveBeenCalledWith('analysis-rejected', { reason: '内容过长' });
    });

    it('配置输入护栏时，通过的内容触发 analysis-ready', () => {
      const content = 'some content';
      mockClipboard.setText(content);
      const inputGuard = vi.fn(() => ({ blocked: false }));
      const handler = new ClipboardHandler(mockClipboard, {
        emit: emitHandler,
        inputGuard,
      });

      const result = handler.analyze();

      expect(result).toBe(true);
      expect(inputGuard).toHaveBeenCalledWith(content);
      expect(emitHandler).toHaveBeenCalledWith('analysis-ready', { content });
    });

    it('未配置输入护栏时跳过护栏检查', () => {
      const content = 'normal content';
      mockClipboard.setText(content);
      const handler = new ClipboardHandler(mockClipboard, { emit: emitHandler });

      const result = handler.analyze();

      expect(result).toBe(true);
      expect(emitHandler).toHaveBeenCalledWith('analysis-ready', { content });
    });
  });

  describe('自定义轮询间隔', () => {
    it('支持自定义轮询间隔', () => {
      vi.useFakeTimers();
      const handler = new ClipboardHandler(mockClipboard, {
        emit: emitHandler,
        pollIntervalMs: 500,
      });

      handler.startPolling();
      mockClipboard.setText('changed');

      // 500ms 后应触发（默认是 2000ms）
      vi.advanceTimersByTime(500);
      expect(emitHandler).toHaveBeenCalledWith('changed');

      handler.stopPolling();
    });
  });
});

describe('SENSITIVE_PATTERNS 常量', () => {
  it('包含 5 种敏感模式', () => {
    expect(SENSITIVE_PATTERNS.length).toBe(5);
  });

  it('每种模式包含 type/pattern/label', () => {
    for (const pattern of SENSITIVE_PATTERNS) {
      expect(pattern.type).toBeTruthy();
      expect(pattern.pattern).toBeInstanceOf(RegExp);
      expect(pattern.label).toBeTruthy();
    }
  });
});
