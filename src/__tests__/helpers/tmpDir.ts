/**
 * 测试临时目录统一入口（内核包 · **唯一建目录点**）
 *
 * 为什么存在：本仓测试曾直接 `mkdtempSync` 建目录、建完不删——实测 `%TEMP%` 累积
 * 562,713 个 `memora-*` 条目（其中 `memora-data-*` 168,412 个）。清理逻辑若散落在
 * 每个测试文件的 `afterEach` 里，下一个测试文件天然漏配且**没有任何测试会红**
 * （这是「纪律写在调用方手里就必漏」的同型伤）。故收成一个入口 + 模块顶层注册清理：
 * **任何 import 本模块的测试文件都自动获得清理守护**，调用方不写清理代码。
 *
 * 与宿主包同名文件的边界（勿合并成一个跨包 helper）：内核与宿主是**两个独立测试工程**
 * （`vitest.config.ts` 各自一份、`--no-file-parallelism` 策略不同），共享需引入 workspace
 * 包，属过度设计。SSOT 在此按**包边界**切——每包一份，**语义同构**（判据一致；
 * 注释措辞与行数不同，不是逐字同构）。
 *
 * 两种语义（迁移时按原测试的目录生命周期二选一，不能一刀切）：
 * - `makeTempDir`：**用例级**——通常写在 `beforeEach`，本用例结束即删；
 * - `makeSuiteTempDir`：**套级**——写在 `beforeAll`，本文件全部用例跑完才删
 *   （用例级清理会把它删掉，后续用例再访问即失败，故刻意分成两个函数而非加参数猜）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach } from 'vitest';

/** 用例级目录登记表（afterEach 清空；每个测试 worker 各持一份，文件级并发安全） */
const caseDirs: string[] = [];
/** 套级目录登记表（afterAll 清空；与用例级分开，避免被提前删掉） */
const suiteDirs: string[] = [];

/**
 * 删除登记表里的全部目录
 *
 * 清理失败**不抛错**：临时目录残留是卫生问题，不能反过来把绿测试打成红
 * （否则「清理」成了新的不稳定源）。失败走 `console.warn` 留痕，不静默。
 *
 * @param dirs  待删目录清单（函数返回后会被清空）
 * @param scope 作用域标签（仅用于告警文案，便于定位是哪一层的清理失败）
 */
function disposeRegistered(dirs: string[], scope: string): void {
  // 先取出再清空：清理过程中若抛错，登记表不会残留「已尝试过」的条目
  const pending = dirs.splice(0, dirs.length);
  for (const dir of pending) {
    try {
      // maxRetries：Windows 上被扫描/索引短暂占用时重试，避免偶发残留
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (err) {
      console.warn(`[tmpDir] ${scope} 临时目录清理失败，已跳过：${dir}`, err);
    }
  }
}

// 模块顶层注册：import 即生效，不依赖调用方记得写 afterEach/afterAll
afterEach(() => disposeRegistered(caseDirs, 'case'));
afterAll(() => disposeRegistered(suiteDirs, 'suite'));

/**
 * 建一个**用例级**临时目录（本用例结束自动删除）
 *
 * @param prefix 目录名前缀（沿用各测试原有前缀，便于从残留反查来源）
 * @returns 新建目录的绝对路径
 */
export function makeTempDir(prefix = 'memora-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  caseDirs.push(dir);
  return dir;
}

/**
 * 建一个**套级**临时目录（本文件全部用例跑完自动删除）
 *
 * 用于原写法「`beforeAll` 建一次、整个 describe 共用」的场景。
 *
 * @param prefix 目录名前缀
 * @returns 新建目录的绝对路径
 */
export function makeSuiteTempDir(prefix = 'memora-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  suiteDirs.push(dir);
  return dir;
}
