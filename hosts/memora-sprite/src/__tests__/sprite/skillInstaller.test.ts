/**
 * 技能文件安装器单元测试
 *
 * 覆盖：
 * - validateSkillFile 纯函数：frontmatter 校验 / name 推导 / keywords+trigger 检查 / body 非空 / 安全过滤
 * - installSkill 集成：文件名安全 / 路径穿越防护 / 目录创建 / 写入成功
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateSkillFile, installSkill } from '../../sprite/skillInstaller.js';

describe('validateSkillFile', () => {
  // 合法技能文件模板
  const validSkill = `---
name: 读文件
keywords: 文件,读取,打开
---

# 读文件技能

当用户需要读取文件时，使用 read_file 工具。
`;

  it('合法技能文件通过校验', () => {
    const result = validateSkillFile(validSkill);
    expect(result.valid).toBe(true);
    expect(result.skillName).toBe('读文件');
  });

  it('缺少 frontmatter 时校验失败', () => {
    const content = '# 无 frontmatter 的技能\n正文内容';
    const result = validateSkillFile(content);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('frontmatter');
  });

  it('frontmatter 缺少 name 时从文件名推导', () => {
    const content = `---
keywords: 测试
---

技能正文
`;
    const result = validateSkillFile(content, '测试技能.md');
    expect(result.valid).toBe(true);
    expect(result.skillName).toBe('测试技能');
  });

  it('frontmatter 缺少 name 且无文件名时校验失败', () => {
    const content = `---
keywords: 测试
---

技能正文
`;
    const result = validateSkillFile(content);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('name');
  });

  it('同时缺少 keywords 和 trigger 时校验失败', () => {
    const content = `---
name: 无触发条件技能
---

技能正文
`;
    const result = validateSkillFile(content);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('keywords 或 trigger');
  });

  it('只有 trigger 无 keywords 时通过校验', () => {
    const content = `---
name: 正则触发技能
trigger: /读取|打开/i
---

技能正文
`;
    const result = validateSkillFile(content);
    expect(result.valid).toBe(true);
    expect(result.skillName).toBe('正则触发技能');
  });

  it('body 为空时校验失败', () => {
    const content = `---
name: 空技能
keywords: 测试
---

`;
    const result = validateSkillFile(content);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('正文为空');
  });

  it('body 包含 <script> 标签时校验失败', () => {
    const content = `---
name: 恶意技能
keywords: 测试
---

<script>alert('xss')</script>
`;
    const result = validateSkillFile(content);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('不安全的 HTML');
  });

  it('body 包含 <iframe> 标签时校验失败', () => {
    const content = `---
name: 恶意技能
keywords: 测试
---

<iframe src="evil.com"></iframe>
`;
    const result = validateSkillFile(content);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('不安全的 HTML');
  });

  it('文件过大时校验失败', () => {
    const largeContent = '---\nname: 大技能\nkeywords: 测试\n---\n' + 'x'.repeat(64 * 1024 + 1);
    const result = validateSkillFile(largeContent);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('过大');
  });

  it('包含中文 name 的技能文件通过校验', () => {
    const content = `---
name: 中文技能名称
keywords: 中文,测试
---

中文技能正文
`;
    const result = validateSkillFile(content);
    expect(result.valid).toBe(true);
    expect(result.skillName).toBe('中文技能名称');
  });
});

describe('installSkill', () => {
  let tempConfigDir: string;

  beforeEach(async () => {
    tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memora-skill-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempConfigDir, { recursive: true, force: true });
  });

  const validContent = `---
name: 测试技能
keywords: 测试
---

测试技能正文
`;

  it('合法文件安装成功', async () => {
    const result = await installSkill(validContent, '测试技能.md', tempConfigDir);
    expect(result.success).toBe(true);
    expect(result.skillName).toBe('测试技能');
    expect(result.installedPath).toContain('skills');

    // 验证文件实际写入
    const fileContent = await fs.readFile(result.installedPath!, 'utf-8');
    expect(fileContent).toBe(validContent);
  });

  it('自动创建 skills 目录', async () => {
    const result = await installSkill(validContent, '测试技能.md', tempConfigDir);
    expect(result.success).toBe(true);

    // 验证目录存在
    const stat = await fs.stat(path.join(tempConfigDir, 'skills'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('同名文件覆盖更新（幂等）', async () => {
    // 第一次安装
    await installSkill(validContent, '测试技能.md', tempConfigDir);

    // 第二次安装（内容更新）
    const updatedContent = `---
name: 测试技能
keywords: 测试,更新
---

更新后的正文
`;
    const result = await installSkill(updatedContent, '测试技能.md', tempConfigDir);
    expect(result.success).toBe(true);

    // 验证内容已更新
    const fileContent = await fs.readFile(result.installedPath!, 'utf-8');
    expect(fileContent).toBe(updatedContent);
  });

  it('非 .md 文件安装失败', async () => {
    const result = await installSkill(validContent, '技能.txt', tempConfigDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('.md');
  });

  it('文件名包含非法字符时安装失败', async () => {
    const result = await installSkill(validContent, '../escape.md', tempConfigDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('非法字符');
  });

  it('文件名包含路径分隔符时安装失败', async () => {
    const result = await installSkill(validContent, 'sub/dir/技能.md', tempConfigDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('非法字符');
  });

  it('内容校验失败时不安装', async () => {
    const invalidContent = '# 无 frontmatter';
    const result = await installSkill(invalidContent, '无效技能.md', tempConfigDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('frontmatter');

    // 验证文件未写入
    await expect(fs.access(path.join(tempConfigDir, 'skills', '无效技能.md'))).rejects.toThrow();
  });
});
