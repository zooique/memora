/**
 * 单元测试：Frontmatter 解析/序列化
 *
 * 覆盖 parseFrontmatter 和 serializeFrontmatter 的核心路径：
 * - 标准 frontmatter 解析
 * - 边界情况（无 frontmatter、空值、多冒号）
 * - 序列化过滤
 */
import { describe, expect, it } from 'vitest';
import { parseFrontmatter, serializeFrontmatter } from '@/utils/frontmatter.js';

describe('Frontmatter 解析/序列化', () => {
  // ─── parseFrontmatter ──────────────────────────────────

  describe('parseFrontmatter', () => {
    it('应解析标准 frontmatter 块', () => {
      const raw = `---
id: test-001
type: rule
permanence: always
---
# 规则内容
这是正文`;
      const { frontmatter, body } = parseFrontmatter(raw);
      expect(frontmatter.id).toBe('test-001');
      expect(frontmatter.type).toBe('rule');
      expect(frontmatter.permanence).toBe('always');
      expect(body).toContain('# 规则内容');
      expect(body).toContain('这是正文');
    });

    it('无 frontmatter 时应返回空对象和原始内容', () => {
      const raw = '# 纯正文\n没有 frontmatter';
      const { frontmatter, body } = parseFrontmatter(raw);
      expect(frontmatter).toEqual({});
      expect(body).toBe(raw);
    });

    it('frontmatter 块不完整（只有开头 ---）时应返回空', () => {
      const raw = '---\nid: test\n没有闭合';
      const { frontmatter, body } = parseFrontmatter(raw);
      expect(frontmatter).toEqual({});
      expect(body).toBe(raw);
    });

    it('应忽略空行和无效行（无冒号）', () => {
      const raw = `---
id: test-002

这是无效行没有冒号
type: personality
---
body`;
      const { frontmatter } = parseFrontmatter(raw);
      expect(frontmatter.id).toBe('test-002');
      expect(frontmatter.type).toBe('personality');
      // 无效行不会出现在 frontmatter 中
      expect(Object.keys(frontmatter)).toHaveLength(2);
    });

    it('值中包含冒号时应正确处理（取第一个冒号分隔）', () => {
      const raw = `---
name: 规则: 子规则
---
body`;
      const { frontmatter } = parseFrontmatter(raw);
      // 第一个冒号分隔 key:value，值保留后续冒号
      expect(frontmatter.name).toBe('规则: 子规则');
    });

    it('空值字段应被忽略', () => {
      const raw = `---
id:
type: rule
---
body`;
      const { frontmatter } = parseFrontmatter(raw);
      // id 的值为空字符串，parseFrontmatter 中 v 为空则不写入
      expect(frontmatter.id).toBeUndefined();
      expect(frontmatter.type).toBe('rule');
    });

    it('应处理多行 body', () => {
      const raw = `---
id: test-003
---
第一行
第二行
第三行`;
      const { body } = parseFrontmatter(raw);
      expect(body).toBe('第一行\n第二行\n第三行');
    });

    // ─── 边界：空 body / 空 frontmatter 块 ─────────
    it('空 body（纯元数据文件）应返回 frontmatter 和空 body', () => {
      // 纯元数据文件：末尾就是 ---\n，无正文内容
      const raw = '---\nid: test-empty-body\nsource: rule\n---\n';
      const { frontmatter, body } = parseFrontmatter(raw);
      expect(frontmatter.id).toBe('test-empty-body');
      expect(frontmatter.source).toBe('rule');
      expect(body).toBe('');
    });

    it('空 frontmatter 块应返回空对象和原始 body', () => {
      // frontmatter 块内容为空（标准格式：---\n\n---\nbody，块内含空行）
      const raw = '---\n\n---\n正文内容';
      const { frontmatter, body } = parseFrontmatter(raw);
      expect(frontmatter).toEqual({});
      expect(body).toBe('正文内容');
    });

    it('M7 修复：结束 --- 无尾随换行时仍应正确解析（不丢失 frontmatter）', () => {
      // 文件以 --- 结尾且无换行：旧实现要求结束 --- 后必须跟 \n，否则整体落入 body
      const raw = '---\nid: test-001\ntype: rule\n---';
      const { frontmatter, body } = parseFrontmatter(raw);
      expect(frontmatter.id).toBe('test-001');
      expect(frontmatter.type).toBe('rule');
      expect(body).toBe('');
    });

    it('M7 修复：结束 --- 后仅一个换行（无 body）也应正确解析', () => {
      const raw = '---\nid: test-002\nsource: rule\n---\n';
      const { frontmatter, body } = parseFrontmatter(raw);
      expect(frontmatter.id).toBe('test-002');
      expect(frontmatter.source).toBe('rule');
      expect(body).toBe('');
    });
  });

  // ─── serializeFrontmatter ──────────────────────────────

  describe('serializeFrontmatter', () => {
    it('应序列化键值对为 YAML 行', () => {
      const result = serializeFrontmatter({
        id: 'test-001',
        type: 'rule',
        permanence: 'always',
      });
      expect(result).toContain('id: test-001');
      expect(result).toContain('type: rule');
      expect(result).toContain('permanence: always');
      // 三行，每行一个键值对
      expect(result.split('\n')).toHaveLength(3);
    });

    it('应过滤 undefined 和 null 值', () => {
      const result = serializeFrontmatter({
        id: 'test-002',
        name: undefined as unknown as string,
        extra: null as unknown as string,
      });
      expect(result).toBe('id: test-002');
    });

    it('空对象应返回空字符串', () => {
      expect(serializeFrontmatter({})).toBe('');
    });

    it('值中包含冒号应原样保留', () => {
      const result = serializeFrontmatter({ name: '规则: 子规则' });
      expect(result).toBe('name: 规则: 子规则');
    });
  });

  // ─── 往返测试（parse → serialize）──────────────────────

  describe('往返一致性', () => {
    it('解析后序列化应能还原键值对', () => {
      const original = `---
id: round-trip
type: session
permanence: domain
---
正文内容`;
      const { frontmatter, body } = parseFrontmatter(original);
      const serialized = serializeFrontmatter(frontmatter);
      // 重新组装并解析
      const roundTripped = parseFrontmatter(`---\n${serialized}\n---\n${body}`);
      expect(roundTripped.frontmatter).toEqual(frontmatter);
      expect(roundTripped.body).toBe(body);
    });
  });
});
