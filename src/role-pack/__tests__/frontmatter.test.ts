/**
 * 角色包 frontmatter 解析器测试（轻量 YAML 子集）
 */
import { describe, it, expect } from 'vitest';
import { parseRolePackFrontmatter } from '@/role-pack/frontmatter.js';

describe('parseRolePackFrontmatter（嵌套 YAML 子集）', () => {
  it('解析规范 §2.3 完整样例：嵌套 strategy + skills 数组', () => {
    const raw = `---
name: 小说写作
formatVersion: 1.0.0
description: 短篇小说与文案写作助手
keywords: [写作, 小说, 故事]
trigger: [写作, 写一篇, 写个故事]
author: memora
version: 1.0.0
strategy:
  prepare:
    contextAssembly: hybrid
    recentRounds: 5
    memoryRecall: full
  act:
    toolMode: allow
    temperature: 0.8
  reflect:
    summary: on
    handoff: wait
  global:
    askOn: [ambiguity, decision, missing_info]
    askLimit: 3
skills:
  - capability: file:write
    description: 把成稿写入本地文件
  - capability: file:read
    description: 读回文件自审
  - capability: web:search
    description: 写作查资料
---
## Persona

你是一位写作助手。
`;

    const { frontmatter, body } = parseRolePackFrontmatter(raw);

    // 元数据标量
    expect(frontmatter['name']).toBe('小说写作');
    expect(frontmatter['formatVersion']).toBe('1.0.0');

    // 内联数组
    expect(frontmatter['keywords']).toEqual(['写作', '小说', '故事']);

    // 嵌套 strategy（两层）
    const strategy = frontmatter['strategy'] as Record<string, unknown>;
    expect(strategy['prepare']).toEqual({
      contextAssembly: 'hybrid',
      recentRounds: 5,
      memoryRecall: 'full',
    });
    expect(strategy['act']).toEqual({ toolMode: 'allow', temperature: 0.8 });
    expect(strategy['global']).toEqual({
      askOn: ['ambiguity', 'decision', 'missing_info'],
      askLimit: 3,
    });

    // skills 数组（映射项）
    const skills = frontmatter['skills'] as Array<Record<string, unknown>>;
    expect(skills).toHaveLength(3);
    expect(skills[0]).toEqual({ capability: 'file:write', description: '把成稿写入本地文件' });
    expect(skills[1]).toEqual({ capability: 'file:read', description: '读回文件自审' });

    // body 保留
    expect(body.trim()).toContain('## Persona');
  });

  it('解析标量类型：数字 / 布尔 / 字符串', () => {
    const { frontmatter } = parseRolePackFrontmatter(`---
temperature: 0.8
streaming: true
name: 测试
---
`);
    expect(frontmatter['temperature']).toBe(0.8);
    expect(frontmatter['streaming']).toBe(true);
    expect(frontmatter['name']).toBe('测试');
  });

  it('空值键解析为 null（`key:` 后无内容且无子块）', () => {
    const { frontmatter } = parseRolePackFrontmatter(`---
empty:
name: 测试
---
`);
    expect(frontmatter['empty']).toBeNull();
  });

  it('行内注释被忽略', () => {
    const { frontmatter } = parseRolePackFrontmatter(`---
name: 测试  # 注释
description: 描述
---
`);
    expect(frontmatter['name']).toBe('测试');
    expect(frontmatter['description']).toBe('描述');
  });

  it('无 frontmatter 结构时返回空对象 + 原始内容', () => {
    const raw = '## Persona\n\n你好';
    const { frontmatter, body } = parseRolePackFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });

  it('空 frontmatter 块合法（`---\\n\\n---`，与 utils/frontmatter 约定一致）', () => {
    const { frontmatter, body } = parseRolePackFrontmatter(`---

---

body 内容
`);
    expect(frontmatter).toEqual({});
    expect(body.trim()).toBe('body 内容');
  });
});
