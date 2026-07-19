/**
 * 跨包契约测试：sprite shared/toError 与 memora utils/toError 行为对齐
 *
 * 目的：防止未来行为漂移。两个实现应保持 5 分支结构 + 相同语义。
 *
 * 背景：
 *   - sprite src/shared/toError.ts 是渲染进程的 toError 真理源
 *   - memora src/utils/toError.ts 是内核的 toError 真理源
 *   - 两者注释互相引用"行为对齐"，但无机器化校验，存在漂移风险
 *   - 本测试通过 memora 公共 API (`from 'memora'`) 导入内核实现，与 sprite 本地实现逐用例对齐
 *
 * 测试策略：
 *   - Error 实例输入：两边应返回同一引用（message + stack + name 全等）
 *   - 非 Error 输入：两边应返回相同 message + name（stack 因调用栈不同不比较）
 *   - 覆盖 5 个分支：Error / string / 含 message 对象 / 普通对象 / 基础类型
 *
 * 设计依据：
 *   - sprite 不能直接 import memora 内部路径（架构边界），但可通过公共 API 导入
 *   - toError 已从 memora index.ts 导出（src/index.ts:166）
 */
import { describe, it, expect } from 'vitest';
// sprite 本地实现（src/shared/toError.ts）
import { toError as spriteToError } from '../../shared/toError.js';
// memora 内核公共 API（node_modules/memora，由 sync-memora.mjs 同步）
import { toError as memoraToError } from 'memora';

describe('toError 跨包契约对齐（sprite shared ↔ memora utils）', () => {
  // ─── 1. Error 实例输入：两边返回同一引用 ──────────────────

  it('Error 实例：两边返回同一引用（message + stack + name 全等）', () => {
    // Error 实例是引用类型，toError 第 1 分支直接返回入参
    const err = new Error('contract: error instance');
    const spriteResult = spriteToError(err);
    const memoraResult = memoraToError(err);
    // 同一引用 → message + stack + name 必然全等
    expect(spriteResult).toBe(err);
    expect(memoraResult).toBe(err);
    expect(spriteResult).toBe(memoraResult);
    // 显式断言三个属性相等（契约要求）
    expect(spriteResult.message).toBe(memoraResult.message);
    expect(spriteResult.stack).toBe(memoraResult.stack);
    expect(spriteResult.name).toBe(memoraResult.name);
  });

  it('Error 子类实例：两边返回同一引用且保留子类 name', () => {
    // 自定义 Error 子类，验证 name 属性保留
    class ContractError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'ContractError';
      }
    }
    const err = new ContractError('contract: subclass');
    const spriteResult = spriteToError(err);
    const memoraResult = memoraToError(err);
    expect(spriteResult).toBe(memoraResult);
    expect(spriteResult.name).toBe('ContractError');
    expect(memoraResult.name).toBe('ContractError');
  });

  // ─── 2. 非 Error 输入：两边 message + name 对齐 ───────────
  // 注意：非 Error 输入会 new Error()，stack 因调用栈不同不比较

  /**
   * 契约对齐用例集合
   *
   * 每个用例：[描述, 输入值, 期望 message 断言函数]
   * 期望 message 用函数表达，避免在用例表中硬编码易错的字面量
   */
  const contractCases: Array<{ desc: string; input: unknown; expectedMessage: string }> = [
    { desc: '字符串', input: 'contract: string', expectedMessage: 'contract: string' },
    { desc: '空字符串', input: '', expectedMessage: '' },
    { desc: '含 message 对象', input: { message: 'contract: obj msg' }, expectedMessage: 'contract: obj msg' },
    {
      desc: 'IPC 序列化错误对象（含 stack 字段）',
      input: { message: 'contract: ipc', stack: 'fake stack' },
      expectedMessage: 'contract: ipc',
    },
    {
      desc: 'message 非 string 的对象走 JSON 序列化',
      input: { message: 123 },
      expectedMessage: JSON.stringify({ message: 123 }),
    },
    {
      desc: '普通对象 JSON 序列化',
      input: { code: 500, detail: 'server error' },
      expectedMessage: JSON.stringify({ code: 500, detail: 'server error' }),
    },
    {
      desc: '嵌套对象',
      input: { outer: { inner: 'value' } },
      expectedMessage: JSON.stringify({ outer: { inner: 'value' } }),
    },
    { desc: 'number', input: 42, expectedMessage: '42' },
    { desc: 'boolean true', input: true, expectedMessage: 'true' },
    { desc: 'boolean false', input: false, expectedMessage: 'false' },
    { desc: 'null 降级到"未知错误"', input: null, expectedMessage: '未知错误' },
    { desc: 'undefined 降级到"未知错误"', input: undefined, expectedMessage: '未知错误' },
  ];

  for (const { desc, input, expectedMessage } of contractCases) {
    it(`${desc}：sprite 与 memora 返回相同 message`, () => {
      const spriteResult = spriteToError(input);
      const memoraResult = memoraToError(input);
      // 契约核心：两边 message 完全一致
      expect(spriteResult.message).toBe(memoraResult.message);
      // 与期望值对齐（双保险：既验证一致性，也验证正确性）
      expect(spriteResult.message).toBe(expectedMessage);
      expect(memoraResult.message).toBe(expectedMessage);
      // name 默认 'Error'，两边一致
      expect(spriteResult.name).toBe(memoraResult.name);
      expect(spriteResult.name).toBe('Error');
    });
  }

  // ─── 3. symbol 特殊处理（每次创建唯一，需独立用例）─────────

  it('symbol：两边返回相同 message（String(symbol)）', () => {
    // Symbol('test') 每次创建唯一，需在同一用例内复用
    const sym = Symbol('contract');
    const spriteResult = spriteToError(sym);
    const memoraResult = memoraToError(sym);
    expect(spriteResult.message).toBe(memoraResult.message);
    expect(spriteResult.message).toBe(sym.toString());
    expect(memoraResult.message).toBe(sym.toString());
  });

  // ─── 4. 循环引用降级（JSON.stringify 抛错 → String() 降级）───

  it('循环引用对象：两边降级路径一致（String(obj) → "[object Object]"）', () => {
    // 创建两个独立的循环引用对象（避免共享引用影响判断）
    const createCircular = (): Record<string, unknown> => {
      const obj: Record<string, unknown> = { name: 'circular' };
      obj.self = obj;
      return obj;
    };
    const spriteResult = spriteToError(createCircular());
    const memoraResult = memoraToError(createCircular());
    // String(circularObj) 输出 "[object Object]"，两边降级路径一致
    expect(spriteResult.message).toBe(memoraResult.message);
    expect(spriteResult.message).toContain('object');
  });
});
