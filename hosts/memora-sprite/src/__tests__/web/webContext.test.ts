/**
 * Web 模式 HTML 适配器测试（DWM-01：双模式 Web 调试）
 *
 * 覆盖范围：
 * - adaptHtmlForWeb：在 </head> 前注入 preload 脚本；无 </head> 时原样返回
 * - buildPreloadScript：文件不存在 / esbuild 可用 / esbuild 不可用三种路径
 * - stripTypeAnnotations（私有函数）：通过 buildPreloadScript 降级路径间接验证
 *   - 移除 import type / export type 语句
 *   - 移除 interface 声明块
 *   - 移除变量类型注解
 *   - 移除 as 类型断言
 *   - 移除非空断言 !
 *
 * Mock 策略：
 * - 由于 buildPreloadScript 使用模块级缓存 cachedPreloadScript，
 *   每个测试用例用 vi.resetModules() + 动态 import 重新加载模块
 * - vi.doMock node:fs / node:fs/promises 控制 existsSync / readFile 行为
 * - vi.doMock esbuild 控制 esbuild 可用性
 *
 * 注意：stripTypeAnnotations 是 webContext.ts 内部私有函数（未导出），
 * 通过 buildPreloadScript 的 esbuild 不可用降级路径间接测试。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── 测试用例 ─────────────────────────────────────────────

describe('webContext', () => {
  beforeEach(() => {
    // 重置模块注册表，确保每个测试用例重新加载 webContext 模块
    // 这是必须的，因为 buildPreloadScript 使用模块级缓存 cachedPreloadScript
    vi.resetModules();
    vi.clearAllMocks();
  });

  // ─── adaptHtmlForWeb ───────────────────────────────────

  describe('adaptHtmlForWeb', () => {
    it('应在 </head> 前注入 preload 脚本标签', async () => {
      const { adaptHtmlForWeb } = await import('../../web/webContext.js');
      /** 含 </head> 的标准 HTML */
      const html = '<html><head><title>测试</title></head><body></body></html>';

      const result = adaptHtmlForWeb(html);

      // 验证 script 标签被注入到 </head> 之前
      expect(result).toContain('<script type="module" src="/web/preload-web.mjs"></script>\n</head>');
      // 验证原 head 内容保留
      expect(result).toContain('<title>测试</title>');
    });

    it('无 </head> 时应原样返回（不注入脚本）', async () => {
      const { adaptHtmlForWeb } = await import('../../web/webContext.js');
      /** 不含 </head> 的 HTML */
      const html = '<html><body></body></html>';

      const result = adaptHtmlForWeb(html);

      expect(result).toBe(html);
      expect(result).not.toContain('preload-web.mjs');
    });

    it('空字符串应原样返回', async () => {
      const { adaptHtmlForWeb } = await import('../../web/webContext.js');

      const result = adaptHtmlForWeb('');

      expect(result).toBe('');
    });

    it('多个 </head> 时应只在第一个之前注入', async () => {
      const { adaptHtmlForWeb } = await import('../../web/webContext.js');
      /** 异常 HTML（含多个 </head>，String.replace 默认只替换第一个） */
      const html = '<head></head><head></head>';

      const result = adaptHtmlForWeb(html);

      // 第一个 </head> 前应有 script 标签
      expect(result.indexOf('<script')).toBeLessThan(result.indexOf('</head>'));
      // 第二个 </head> 前不应有 script 标签
      const firstHeadEnd = result.indexOf('</head>');
      const secondHeadEnd = result.indexOf('</head>', firstHeadEnd + 1);
      const scriptCount = (result.match(/preload-web\.mjs/g) || []).length;
      expect(scriptCount).toBe(1);
      expect(secondHeadEnd).toBeGreaterThan(firstHeadEnd);
    });
  });

  // ─── buildPreloadScript ────────────────────────────────

  describe('buildPreloadScript', () => {
    it('源码文件不存在时应返回空字符串', async () => {
      // mock node:fs 的 existsSync 返回 false（文件不存在）
      vi.doMock('node:fs', () => ({
        existsSync: vi.fn(() => false),
      }));

      const { buildPreloadScript } = await import('../../web/webContext.js');
      const result = await buildPreloadScript();

      expect(result).toBe('');
    });

    it('esbuild 可用时应返回 esbuild 转译结果', async () => {
      // mock node:fs/promises 的 readFile 返回任意源码（具体内容由 esbuild mock 决定输出）
      vi.doMock('node:fs', () => ({
        existsSync: vi.fn(() => true),
      }));
      vi.doMock('node:fs/promises', () => ({
        readFile: vi.fn(async () => 'const x = 1;'),
      }));
      // mock esbuild 的 transform 返回固定结果
      vi.doMock('esbuild', () => ({
        transform: vi.fn(async () => ({ code: 'const y = 2;' })),
      }));

      const { buildPreloadScript } = await import('../../web/webContext.js');
      const result = await buildPreloadScript();

      expect(result).toBe('const y = 2;');
    });

    it('esbuild 不可用时应降级为 stripTypeAnnotations 结果', async () => {
      // mock esbuild import 抛错（模拟 esbuild 不可用）
      vi.doMock('node:fs', () => ({
        existsSync: vi.fn(() => true),
      }));
      vi.doMock('node:fs/promises', () => ({
        readFile: vi.fn(async () => 'const x: number = 1;'),
      }));
      vi.doMock('esbuild', () => {
        throw new Error('esbuild not available');
      });

      const { buildPreloadScript } = await import('../../web/webContext.js');
      const result = await buildPreloadScript();

      // 验证降级路径：变量类型注解 :number 被移除
      expect(result).toContain('const x = 1');
      expect(result).not.toContain(': number');
    });

    it('esbuild transform 抛错时应降级为空字符串', async () => {
      // mock esbuild 的 transform 抛错
      vi.doMock('node:fs', () => ({
        existsSync: vi.fn(() => true),
      }));
      vi.doMock('node:fs/promises', () => ({
        readFile: vi.fn(async () => 'const x = 1;'),
      }));
      vi.doMock('esbuild', () => ({
        transform: vi.fn(async () => {
          throw new Error('transform 失败');
        }),
      }));

      const { buildPreloadScript } = await import('../../web/webContext.js');
      const result = await buildPreloadScript();

      // 外层 try/catch 捕获后置为空字符串
      expect(result).toBe('');
    });

    it('模块级缓存：第二次调用应直接返回缓存结果', async () => {
      vi.doMock('node:fs', () => ({
        existsSync: vi.fn(() => true),
      }));
      vi.doMock('node:fs/promises', () => ({
        readFile: vi.fn(async () => 'const x = 1;'),
      }));
      /** esbuild transform 调用计数（验证缓存后不再调用） */
      const transformMock = vi.fn(async () => ({ code: 'cached-result' }));
      vi.doMock('esbuild', () => ({
        transform: transformMock,
      }));

      const { buildPreloadScript } = await import('../../web/webContext.js');

      // 第一次调用：执行转译
      const result1 = await buildPreloadScript();
      expect(result1).toBe('cached-result');
      expect(transformMock).toHaveBeenCalledTimes(1);

      // 第二次调用：应直接返回缓存，不再调用 transform
      const result2 = await buildPreloadScript();
      expect(result2).toBe('cached-result');
      expect(transformMock).toHaveBeenCalledTimes(1);
    });
  });

  // ─── stripTypeAnnotations（通过降级路径间接测试） ────────

  describe('stripTypeAnnotations（降级路径间接测试）', () => {
    /**
     * 辅助函数：mock esbuild 不可用 + 文件存在 + 指定源码，
     * 返回 buildPreloadScript 的结果（即 stripTypeAnnotations 输出）
     *
     * @param source 模拟的 TypeScript 源码
     * @returns stripTypeAnnotations 处理后的 JS 代码
     */
    async function stripViaBuild(source: string): Promise<string> {
      vi.doMock('node:fs', () => ({
        existsSync: vi.fn(() => true),
      }));
      vi.doMock('node:fs/promises', () => ({
        readFile: vi.fn(async () => source),
      }));
      vi.doMock('esbuild', () => {
        throw new Error('esbuild not available');
      });
      const { buildPreloadScript } = await import('../../web/webContext.js');
      return buildPreloadScript();
    }

    it('应移除 import type 语句', async () => {
      const source = 'import type { Foo } from "bar";\nconst x = 1;';
      const result = await stripViaBuild(source);
      expect(result).not.toContain('import type');
      expect(result).toContain('const x = 1');
    });

    it('应移除 export type 语句', async () => {
      const source = 'export type Foo = string;\nconst x = 1;';
      const result = await stripViaBuild(source);
      expect(result).not.toContain('export type');
      expect(result).toContain('const x = 1');
    });

    it('应移除 interface 声明块', async () => {
      const source = 'interface Foo { x: number }\nconst y = 1;';
      const result = await stripViaBuild(source);
      expect(result).not.toContain('interface');
      expect(result).toContain('const y = 1');
    });

    it('应移除 export interface 声明块', async () => {
      const source = 'export interface Foo { x: number }\nconst y = 1;';
      const result = await stripViaBuild(source);
      expect(result).not.toContain('interface');
    });

    it('应移除变量类型注解（const x: Type = ... → const x = ...）', async () => {
      const source = 'const x: number = 1;';
      const result = await stripViaBuild(source);
      expect(result).toContain('const x = 1');
      expect(result).not.toContain(': number');
    });

    it('应移除 let 变量类型注解', async () => {
      const source = 'let y: string = "hello";';
      const result = await stripViaBuild(source);
      expect(result).toContain('let y = "hello"');
      expect(result).not.toContain(': string');
    });

    it('应移除 as 类型断言', async () => {
      const source = 'const x = value as string;';
      const result = await stripViaBuild(source);
      expect(result).not.toContain('as string');
      expect(result).toContain('value');
    });

    it('应移除非空断言 !', async () => {
      const source = 'const x = obj!.prop;';
      const result = await stripViaBuild(source);
      // 验证非空断言被移除（obj! → obj）
      expect(result).toContain('obj.prop');
    });

    it('应保留运行时代码（普通 const 赋值）', async () => {
      const source = 'const x = 1;\nconst y = "hello";';
      const result = await stripViaBuild(source);
      expect(result).toContain('const x = 1');
      expect(result).toContain('const y = "hello"');
    });

    it('应处理多重类型注解混合场景', async () => {
      const source = [
        'import type { Foo } from "bar";',
        'export type Bar = number;',
        'interface Baz { x: number }',
        'const a: number = 1;',
        'const b = a as string;',
        'const c = obj!.prop;',
        'const d = 2;',
      ].join('\n');
      const result = await stripViaBuild(source);
      expect(result).not.toContain('import type');
      expect(result).not.toContain('export type');
      expect(result).not.toContain('interface');
      expect(result).not.toContain(': number');
      expect(result).not.toContain('as string');
      // 保留运行时代码
      expect(result).toContain('const a = 1');
      expect(result).toContain('const d = 2');
    });
  });
});
