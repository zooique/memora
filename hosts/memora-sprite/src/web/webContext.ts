/**
 * Web 模式 HTML 适配器（DWM-01：双模式 Web 调试）
 *
 * 职责：
 *   1. 在 renderer/index.html 中注入 Web 版 preload 脚本
 *   2. 启动时用 esbuild 转译 preloadWeb.ts 为浏览器可执行 JS
 *   3. 缓存转译结果，避免每次请求重复转译
 *
 * 设计原则：
 *   - preloadWeb.ts 保持 TypeScript 源码（类型安全 + 可测试）
 *   - 转译只在启动时执行一次，结果缓存在内存
 *   - 转译失败时降级为内联空脚本 + 控制台警告
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 当前模块所在目录 */
const __dirname = dirname(fileURLToPath(import.meta.url));

/** preloadWeb.ts 源码路径 */
const PRELOAD_SOURCE_PATH = resolve(__dirname, 'preloadWeb.ts');

/** 转译后的浏览器 JS 缓存（启动时转译一次） */
let cachedPreloadScript: string | null = null;

/**
 * 启动时转译 preloadWeb.ts 为浏览器可执行 JS
 *
 * 使用 esbuild（tsx 的间接依赖）将 TypeScript 转译为浏览器 ES module。
 * 转译结果缓存在内存中，后续请求直接返回缓存。
 *
 * 转译失败时降级为空脚本 + 控制台警告，不阻塞服务启动。
 *
 * @returns 转译后的浏览器 JS 代码
 */
export async function buildPreloadScript(): Promise<string> {
  // 已缓存则直接返回
  if (cachedPreloadScript !== null) {
    return cachedPreloadScript;
  }

  // 检查源码文件是否存在
  if (!existsSync(PRELOAD_SOURCE_PATH)) {
    console.warn('[Web] preloadWeb.ts 不存在，electronAPI 将不可用');
    cachedPreloadScript = '';
    return cachedPreloadScript;
  }

  try {
    // 读取 preloadWeb.ts 源码
    const sourceCode = await readFile(PRELOAD_SOURCE_PATH, 'utf-8');

    // 尝试用 esbuild 转译（esbuild 是 tsx 的间接依赖）
    const esbuild = await tryImportEsbuild();
    if (esbuild) {
      const result = await esbuild.transform(sourceCode, {
        loader: 'ts',
        format: 'esm',
        target: 'es2022',
        // 移除 TypeScript 类型注解，保留运行时代码
        define: {
          'import.meta.url': JSON.stringify(''),
        },
      });
      cachedPreloadScript = result.code;
      console.log('[Web] preloadWeb.ts 转译成功（esbuild）');
    } else {
      // esbuild 不可用：降级为简单正则去除类型注解
      // 注意：正则转译不完美，仅作为 Phase 1 降级方案
      cachedPreloadScript = stripTypeAnnotations(sourceCode);
      console.warn('[Web] esbuild 不可用，降级为正则转译（可能不完美）');
    }
  } catch (error) {
    console.warn(`[Web] preloadWeb.ts 转译失败: ${error instanceof Error ? error.message : String(error)}`);
    cachedPreloadScript = '';
  }

  return cachedPreloadScript;
}

/**
 * esbuild 最小化类型声明（仅声明 Web 模式使用的 transform API）
 *
 * esbuild 是 tsx 的间接依赖，不作为直接依赖，
 * 因此不引入 @types/esbuild，仅定义本地使用的最小接口。
 */
interface EsbuildTransformResult {
  code: string;
  map?: string;
  warnings?: unknown[];
}

interface EsbuildApi {
  transform(input: string, options?: Record<string, unknown>): Promise<EsbuildTransformResult>;
}

/**
 * 尝试动态导入 esbuild
 *
 * esbuild 是 tsx 的间接依赖，可能可用也可能不可用。
 * 使用动态 import + try/catch 避免硬依赖。
 *
 * @returns esbuild 模块对象，不可用时返回 null
 */
async function tryImportEsbuild(): Promise<EsbuildApi | null> {
  try {
    return await import('esbuild');
  } catch {
    return null;
  }
}

/**
 * 简单正则去除 TypeScript 类型注解（降级方案）
 *
 * 仅处理最常见的类型注解：
 *   - interface/type 声明块
 *   - import type 语句
 *   - 变量/参数/返回值的类型注解
 *   - as 类型断言
 *
 * 不处理：泛型、条件类型、映射类型等复杂场景。
 * Phase 2 用 Vite 后此函数可删除。
 *
 * @param source TypeScript 源码
 * @returns 转译后的 JS 代码
 */
function stripTypeAnnotations(source: string): string {
  return source
    // 移除 import type 语句
    .replace(/^\s*import\s+type\s+.*$/gm, '')
    // 移除 export type 语句
    .replace(/^\s*export\s+type\s+.*$/gm, '')
    // 移除 interface 声明块（从 interface 到下一个 }）
    .replace(/^\s*(export\s+)?interface\s+\w+.*?\{[^}]*\}/gms, '')
    // 移除变量类型注解（如 const x: Type = ... → const x = ...）
    .replace(/(\b(?:const|let|var)\s+\w+)\s*:\s*[^=]+(=)/g, '$1 $2')
    // 移除函数参数类型注解（如 (param: Type) → (param)）
    .replace(/(\w+)\s*:\s*[\w<>\[\]|&",\s]+(?=[,\)])/g, '$1')
    // 移除函数返回值类型注解（如 function foo(): Type → function foo()）
    .replace(/\)\s*:\s*[\w<>\[\]|&",\s]+(?=\s*[{=>])/g, ')')
    // 移除 as 类型断言
    .replace(/\s+as\s+[\w<>\[\]|&",\s]+/g, '')
    // 移除非空断言（!）
    .replace(/(\w)!/g, '$1');
}

/**
 * 适配 index.html 为 Web 模式
 *
 * 在 </head> 前注入 <script> 标签加载 Web 版 preload。
 * 渲染进程代码通过 window.electronAPI 调用 API，与 Electron 模式完全一致。
 *
 * @param html 原始 index.html 内容
 * @returns 适配后的 HTML（注入了 preload 脚本标签）
 */
export function adaptHtmlForWeb(html: string): string {
  // 在 </head> 前注入 preload 脚本（模块化加载）
  const scriptTag = '<script type="module" src="/web/preload-web.mjs"></script>';
  return html.replace('</head>', `${scriptTag}\n</head>`);
}
