/**
 * TypedEventBus 单元测试（AUDIT-H6 新增）
 *
 * 覆盖：
 * - 单订阅（覆盖）语义：on() 重复注册同一事件覆盖前者（对齐旧 onXxx 赋值契约）
 * - emit 返回值透传：void / 同步非 void / Promise 三种形态
 * - 未注册 emit 返回 undefined（调用方 ?? 兜底语义）
 * - off / has / clear 生命周期能力
 */
import { describe, it, expect, vi } from 'vitest';
import { TypedEventBus } from '../../../electron/renderer/helpers/typedEventBus.js';
import type { MemoryPanelEventMap } from '../../../electron/renderer/panels/memoryPanelEventMap.js';

function createBus(): TypedEventBus<MemoryPanelEventMap> {
  return new TypedEventBus<MemoryPanelEventMap>();
}

describe('TypedEventBus（MemoryPanelEventMap 实例）', () => {
  it('on + emit 应触发回调并透传参数', () => {
    const bus = createBus();
    const cb = vi.fn();
    bus.on('memory-search', cb);
    bus.emit('memory-search', '测试');
    expect(cb).toHaveBeenCalledWith('测试');
  });

  it('单订阅覆盖语义：重复 on 同一事件应覆盖前者（等价旧 onXxx 赋值）', () => {
    const bus = createBus();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    bus.on('memory-discuss', cb1);
    bus.on('memory-discuss', cb2);
    bus.emit('memory-discuss', '记忆A');
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledWith('记忆A');
  });

  it('未注册事件 emit 应返回 undefined（调用方 ?? 兜底语义）', () => {
    const bus = createBus();
    const result = bus.emit('cleanup-request', 'duplicates');
    expect(result).toBeUndefined();
    expect(result ?? []).toEqual([]);
  });

  it('emit 应透传同步非 void 返回值（cleanup-request → string[]）', () => {
    const bus = createBus();
    bus.on('cleanup-request', (type) => type === 'duplicates' ? ['a', 'b'] : []);
    const ids = bus.emit('cleanup-request', 'duplicates');
    expect(ids).toEqual(['a', 'b']);
  });

  it('emit 应透传 Promise 返回值（await 语义）', async () => {
    const bus = createBus();
    const result: string[] = [];
    bus.on('cleanup-confirm', async (ids) => {
      result.push(...ids);
    });
    await bus.emit('cleanup-confirm', ['x']);
    expect(result).toEqual(['x']);
  });

  it('off 应移除回调（emit 后不再触发，返回 undefined）', () => {
    const bus = createBus();
    const cb = vi.fn();
    bus.on('memory-click', cb);
    bus.off('memory-click');
    bus.emit('memory-click', 'id-1');
    expect(cb).not.toHaveBeenCalled();
  });

  it('has 应反映注册状态', () => {
    const bus = createBus();
    expect(bus.has('memory-click')).toBe(false);
    bus.on('memory-click', () => {});
    expect(bus.has('memory-click')).toBe(true);
    bus.off('memory-click');
    expect(bus.has('memory-click')).toBe(false);
  });

  it('clear 应清空全部回调（cleanup 场景）', () => {
    const bus = createBus();
    const cb = vi.fn();
    bus.on('memory-click', cb);
    bus.on('memory-filter', cb);
    bus.clear();
    bus.emit('memory-click', 'id');
    bus.emit('memory-filter', 'src');
    expect(cb).not.toHaveBeenCalled();
    expect(bus.has('memory-click')).toBe(false);
  });

  it('多参数事件应完整透传（relation-edit 4 参数）', () => {
    const bus = createBus();
    const cb = vi.fn();
    bus.on('relation-edit', cb);
    bus.emit('relation-edit', 'a', 'b', 'related', 0.8);
    expect(cb).toHaveBeenCalledWith('a', 'b', 'related', 0.8);
  });
});
