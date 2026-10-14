/**
 * 自定义搜索引擎：静态校验判据（SSOT）边界测试
 *
 * validateCustomEngines 定义在搜索引擎域（extension/host/searchEngines.ts）——「测试」与
 * 「保存」两条 UI 路径、装配侧 resolveSearchEndpoints 的消费侧过滤共用同一函数
 * （2026-10-14 审查：判据原先只守 UI 前门，手改 settings.json / 设置同步可绕过 ⇒ 已接到消费点）。
 * 本文件锁住它的边界口径：
 *   ① 名称为空 / 仅空白 → 拒
 *   ② URL 模板缺 {query} → 拒
 *   ③ 解析策略非预置项（绕过 UI 改 settings.json）→ 拒
 *   ④ 清单内名称重复 → 拒
 *   ⑤ 自定义名与内置引擎名重名 → 拒（否则下拉去重后静默遮蔽内置引擎）
 *   ⑥ URL 模板非 http(s)（file:// / javascript: / 协议相对）→ 拒
 *
 * 为何必须钉死：协议白名单是配置驱动 fetch 的**唯一入口护栏**——内核
 * FetchWebSearchProvider 与 web_fetch 均不做协议/主机过滤，宿主是策略层，
 * 敞口即等于「粘贴一份别人的配置就能诱导宿主进程发起非预期请求」。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { validateCustomEngines } from '../../extension/host/searchEngines.js';
import { HOST_PARSE_STRATEGIES } from '../../extension/host/searchEngines.js';
import type { CustomSearchEngineConfig } from '../../shared/protocol.js';

vi.mock('vscode', () => ({
  Uri: { joinPath: () => ({ toString: () => 'mock://uri' }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined), update: vi.fn() })),
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  commands: { executeCommand: vi.fn() },
  ConfigurationTarget: { Global: 1 },
}));

const OK: CustomSearchEngineConfig = {
  name: 'MySite',
  urlTemplate: 'https://mysite.com/s?q={query}',
  parseStrategy: 'jsonApi',
};

describe('validateCustomEngines — 边界口径', () => {
  it('全部合法 → undefined', () => {
    expect(validateCustomEngines([OK])).toBeUndefined();
    expect(validateCustomEngines([])).toBeUndefined();
  });

  it('名称为空 / 仅空白 → 拒', () => {
    expect(validateCustomEngines([{ ...OK, name: '' }])).toContain('引擎名称');
    expect(validateCustomEngines([{ ...OK, name: '   ' }])).toContain('引擎名称');
  });

  it('URL 模板缺 {query} → 拒', () => {
    expect(validateCustomEngines([{ ...OK, urlTemplate: 'https://mysite.com/s' }])).toContain('{query}');
  });

  it('解析策略非预置项 → 拒（防绕过 UI 直接改 settings.json）', () => {
    expect(
      validateCustomEngines([{ ...OK, parseStrategy: 'evil' as never }]),
    ).toContain('解析策略');
    // 派生契约（2026-10-14 修正）：旧断言把 HOST_PARSE_STRATEGIES 写死成字面量，
    // 加第三个策略时必红，与「由 HOST_PARSERS 键派生、零维护」的声称自相矛盾。
    // 现改为逐策略验证「每个清单项都被判据放行」——加策略时本测试自动跟随、不红。
    expect(HOST_PARSE_STRATEGIES.length).toBeGreaterThan(0);
    expect(new Set(HOST_PARSE_STRATEGIES).size).toBe(HOST_PARSE_STRATEGIES.length);
    for (const s of HOST_PARSE_STRATEGIES) {
      expect(validateCustomEngines([{ ...OK, parseStrategy: s }])).toBeUndefined();
    }
  });

  it('清单内名称重复 → 拒', () => {
    expect(validateCustomEngines([OK, { ...OK, urlTemplate: 'https://other.com/?q={query}' }])).toContain('重复');
  });

  it('自定义名与内置引擎重名 → 拒（防静默遮蔽内置）', () => {
    expect(validateCustomEngines([{ ...OK, name: 'bing' }])).toContain('内置引擎');
    expect(validateCustomEngines([{ ...OK, name: 'auto' }])).toContain('内置引擎');
    expect(validateCustomEngines([{ ...OK, name: 'duckduckgo' }])).toContain('内置引擎');
  });

  it('非 http(s) 模板 → 拒', () => {
    expect(validateCustomEngines([{ ...OK, urlTemplate: 'file:///etc/passwd?q={query}' }])).toContain('http');
    expect(validateCustomEngines([{ ...OK, urlTemplate: '//evil.com/?q={query}' }])).toContain('http');
  });
});
