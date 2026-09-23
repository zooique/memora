/**
 * capabilities → 特权工具映射测试（M2.1 → tool-exposure-model 特权声明模型）
 *
 * capabilities = 角色包声明的超越默认边界的特权（web / code / task），
 * 不映射本地能力——file:* / memory:recall / project:search 等为
 * 默认常驻工具（见 toolExecutor.DEFAULT_EXPOSED_TOOLS），不产生白名单映射。
 */
import { describe, it, expect } from 'vitest';
import { resolveCapabilityTools } from '@/role-pack/capabilityMap.js';

describe('resolveCapabilityTools（中立能力 → memora 特权工具白名单）', () => {
  it('映射项目总监角色包：web:search 生效，file:* 为常驻工具不映射', () => {
    const caps = [
      { capability: 'file:read' },
      { capability: 'file:write' },
      { capability: 'web:search' },
      { capability: 'llm:summarize' },
    ];
    const tools = resolveCapabilityTools(caps);
    // 特权映射只剩 web_search；read/write 是默认常驻工具，不入白名单
    expect(tools).toEqual(['web_search']);
    // llm:summarize 是内核内部能力，无工具映射
    expect(tools).not.toContain('summarize');
    // 去重
    expect(new Set(tools).size).toBe(tools.length);
  });

  it('映射技术文档工程师角色包：仅 llm:summarize → 空特权集', () => {
    const tools = resolveCapabilityTools([{ capability: 'llm:summarize' }]);
    expect(tools).toEqual([]);
  });

  it('无 capabilities → 空特权集（常驻豁免集仍全暴露，由 list() 控制）', () => {
    expect(resolveCapabilityTools([])).toEqual([]);
    expect(resolveCapabilityTools(undefined)).toEqual([]);
  });

  it('已清理能力键与未知能力均跳过不阻塞（file:* 本地能力已默认常驻）', () => {
    const tools = resolveCapabilityTools([
      { capability: 'file:read' },
      { capability: 'unknown:xyz' },
      { capability: 'file:list' },
    ]);
    expect(tools).toEqual([]);
  });

  it('task:plan 不再映射工具（2026-09-16：任务表已是常驻工具，映射表不为它保留条目）', () => {
    const tools = resolveCapabilityTools([{ capability: 'task:plan' }]);
    // 任务表直接暴露（DEFAULT_EXPOSED_TOOLS），不入白名单 → task:plan 无工具映射。
    // 与 llm:summarize 的区别：后者在映射表内有空数组占位，前者连条目都没有——但**行为等价**（均不产出工具）
    expect(tools).toEqual([]);
  });

  it('web:fetch 映射到 web_fetch 工具（搜索→抓取闭环第二段）', () => {
    const tools = resolveCapabilityTools([{ capability: 'web:fetch' }]);
    expect(tools).toEqual(['web_fetch']);
  });

  it('code:execute 映射到 run_code 工具（通用计算底座）', () => {
    const tools = resolveCapabilityTools([{ capability: 'code:execute' }]);
    expect(tools).toEqual(['run_code']);
  });
});
