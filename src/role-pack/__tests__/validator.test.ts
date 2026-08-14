/**
 * 角色包格式校验器测试（role-pack-spec §八：必填字段 / 章节 / 键名 / 版本 / 合规分档 / 单一真理源）
 */
import { describe, it, expect } from 'vitest';
import { validateRolePack, validateRolePackText, validateManifest } from '@/role-pack/validator.js';
import type { RolePackValidationIssue } from '@/role-pack/validator.js';

/** 合法 L2 策略（§六 v1 键集，类型化常量供展开覆写） */
const validStrategy = {
  prepare: { contextAssembly: 'hybrid', recentRounds: 3, memoryRecall: 'full', summaryRecall: 'on' },
  act: { toolMode: 'allow', temperature: 0.7, streaming: 'streaming' },
  reflect: { summary: 'on', handoff: 'wait' },
  global: { askOn: ['ambiguity', 'decision'], askLimit: 3, errorHandling: 'retry' },
};

/** 合法基础 frontmatter（§2.3 样例形状：嵌套 strategy + skills 数组 + 合规字段） */
const validFrontmatter: Record<string, unknown> = {
  name: '测试角色包',
  formatVersion: '1.0.0',
  version: '1.0.0',
  interactionType: 'tool_assistant',
  strategy: validStrategy,
  skills: [
    { capability: 'file:write', description: '写文件' },
    { capability: 'web:search' },
  ],
};

/** 合法基础正文（含 L1 必读章节 Persona + Rules） */
const validBody = '## Persona\n\n你是一个测试角色。\n\n## Rules\n\n- 不生成违法内容\n';

/** 合法基础 manifest（§2.4 字段集：元数据 + 合规；strategy/skills 归属 role-pack.md 不在此处） */
const validManifest: Record<string, unknown> = {
  name: '测试角色包',
  formatVersion: '1.0.0',
  version: '1.0.0',
  description: '测试角色包描述',
  author: '萧然',
  homepage: 'https://example.com',
  repository: 'https://github.com/example/role-pack',
  license: 'MIT',
  keywords: ['角色包', 'agent'],
  interactionType: 'tool_assistant',
  aiIdentityDisclosure: true,
  minorProtection: 'required',
  extensions: { 'com.example': { enabled: true } },
};

/** 便捷构造：给定 frontmatter 覆写 + body 覆写，返回校验结果；replaceAll=true 时整体替换 frontmatter */
function validate(overrides: Record<string, unknown> = {}, body = validBody, form: 'single-file' | 'folder' = 'single-file', replaceAll = false) {
  const frontmatter = replaceAll ? overrides : { ...validFrontmatter, ...overrides };
  return validateRolePack({ frontmatter, body, form });
}

/** 便捷构造：给定 manifest 覆写，返回校验结果；replaceAll=true 时整体替换 manifest */
function validateManifestOf(overrides: Record<string, unknown> = {}, replaceAll = false) {
  const manifest = replaceAll ? overrides : { ...validManifest, ...overrides };
  return validateManifest(manifest);
}

/** 提取指定 code 的问题列表 */
function findByCode(issues: readonly RolePackValidationIssue[], code: string) {
  return issues.filter((i) => i.code === code);
}

describe('validateRolePack：合法角色包', () => {
  it('§2.3 完整样例（单文件形态）校验通过', () => {
    const result = validate();
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('文件夹形态：frontmatter 仅 strategy + skills 时校验通过', () => {
    const result = validate({ strategy: validStrategy, skills: validFrontmatter['skills'] }, validBody, 'folder', true);
    expect(result.valid).toBe(true);
  });

  it('弃用键 reflect.insightExtraction：warning（可装载）+ DEPRECATED_STRATEGY_KEY', () => {
    const result = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, insightExtraction: 'on' } },
    });
    expect(result.valid).toBe(true); // 弃用键是 warning，不阻塞装载
    const dep = findByCode(result.issues, 'DEPRECATED_STRATEGY_KEY');
    expect(dep).toHaveLength(1);
    expect(dep[0]!.severity).toBe('warning');
    expect(dep[0]!.path).toBe('strategy.reflect.insightExtraction');
  });
});

describe('validateRolePack：必填字段', () => {
  it('缺少 name → MISSING_NAME error（拒绝加载）', () => {
    const result = validate({ name: undefined });
    expect(findByCode(result.issues, 'MISSING_NAME')).toHaveLength(1);
    expect(result.issues[0]?.severity).toBe('error');
  });

  it('空字符串 name → MISSING_NAME error', () => {
    const result = validate({ name: '   ' });
    expect(findByCode(result.issues, 'MISSING_NAME')).toHaveLength(1);
  });
});

describe('validateRolePack：L1 必读章节', () => {
  it('缺少 ## Persona → MISSING_PERSONA error', () => {
    const result = validate({}, '## Rules\n\n- 规则\n');
    expect(findByCode(result.issues, 'MISSING_PERSONA')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('缺少 ## Rules → MISSING_RULES error（§七 第 2 条 内容红线载体）', () => {
    const result = validate({}, '## Persona\n\n你是一个角色。\n');
    expect(findByCode(result.issues, 'MISSING_RULES')).toHaveLength(1);
  });
});

describe('validateRolePack：版本语义', () => {
  it('formatVersion 非 semver → INVALID_FORMAT_VERSION error', () => {
    const result = validate({ formatVersion: '1.0' });
    expect(findByCode(result.issues, 'INVALID_FORMAT_VERSION')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('formatVersion 缺省合法（按 1.0.0 处理，§五）', () => {
    const result = validate({ formatVersion: undefined });
    expect(findByCode(result.issues, 'INVALID_FORMAT_VERSION')).toHaveLength(0);
  });

  it('version 非 semver → INVALID_VERSION warning（不阻塞装载）', () => {
    const result = validate({ version: 'v2' });
    const issue = findByCode(result.issues, 'INVALID_VERSION');
    expect(issue).toHaveLength(1);
    expect(issue[0]?.severity).toBe('warning');
    expect(result.valid).toBe(true);
  });
});

describe('validateRolePack：键名合法性', () => {
  it('未知顶层键 → UNKNOWN_TOP_LEVEL_KEY warning + 忽略', () => {
    const result = validate({ unknownKey: 'x' });
    const issue = findByCode(result.issues, 'UNKNOWN_TOP_LEVEL_KEY');
    expect(issue).toHaveLength(1);
    expect(issue[0]?.severity).toBe('warning');
    expect(result.valid).toBe(true);
  });

  it('未知策略阶段 → UNKNOWN_STRATEGY_STAGE warning', () => {
    const result = validate({ strategy: { ...validStrategy, postAct: { x: 1 } } });
    expect(findByCode(result.issues, 'UNKNOWN_STRATEGY_STAGE')).toHaveLength(1);
  });

  it('未知策略键 → UNKNOWN_STRATEGY_KEY warning（键级渐进，§五）', () => {
    const result = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, foo: 'bar' } },
    });
    const issue = findByCode(result.issues, 'UNKNOWN_STRATEGY_KEY');
    expect(issue).toHaveLength(1);
    expect(issue[0]?.path).toBe('strategy.act.foo');
    expect(issue[0]?.severity).toBe('warning');
  });

  it('strategy 非对象 → INVALID_STRATEGY error', () => {
    const result = validate({ strategy: 'hybrid' });
    expect(findByCode(result.issues, 'INVALID_STRATEGY')).toHaveLength(1);
  });
});

describe('validateRolePack：L2 策略取值越界（角色只"选择"不"定义"）', () => {
  it('contextAssembly 越界枚举 → INVALID_STRATEGY_VALUE error', () => {
    const result = validate({
      strategy: { ...validStrategy, prepare: { ...validStrategy.prepare, contextAssembly: 'weird' } },
    });
    const issue = findByCode(result.issues, 'INVALID_STRATEGY_VALUE');
    expect(issue).toHaveLength(1);
    expect(issue[0]?.path).toBe('strategy.prepare.contextAssembly');
    expect(result.valid).toBe(false);
  });

  it('recentRounds 非正整数 → error', () => {
    const result = validate({
      strategy: { ...validStrategy, prepare: { ...validStrategy.prepare, recentRounds: 0 } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('memoryRecallQuota 合法正整数 → 通过（P0 提炼进标准的键）', () => {
    const result = validate({
      strategy: { ...validStrategy, prepare: { ...validStrategy.prepare, memoryRecallQuota: 2000 } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('memoryRecallQuota 非正整数 → error', () => {
    const result = validate({
      strategy: { ...validStrategy, prepare: { ...validStrategy.prepare, memoryRecallQuota: -1 } },
    });
    const issue = findByCode(result.issues, 'INVALID_STRATEGY_VALUE');
    expect(issue).toHaveLength(1);
    expect(issue[0]?.path).toBe('strategy.prepare.memoryRecallQuota');
    expect(result.valid).toBe(false);
  });

  it('旧实现键 act.toolCalls → 未知策略键 warning（键级渐进，不阻塞）', () => {
    const result = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, toolCalls: 'block' } },
    });
    const issue = findByCode(result.issues, 'UNKNOWN_STRATEGY_KEY');
    expect(issue.length).toBeGreaterThan(0);
    expect(issue[0]?.path).toBe('strategy.act.toolCalls');
    // 未知键 warning 不阻塞装载；标准键 toolMode 不受影响
    expect(result.valid).toBe(true);
  });

  it('temperature 越界（> 2.0）→ error', () => {
    const result = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, temperature: 3.5 } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('askOn 含非法枚举元素 → error', () => {
    const result = validate({
      strategy: { ...validStrategy, global: { ...validStrategy.global, askOn: ['ambiguity', 'chat'] } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('askOn 单枚举字符串合法（可组合，§六）', () => {
    const result = validate({
      strategy: { ...validStrategy, global: { ...validStrategy.global, askOn: 'confirm' } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(0);
  });
});

describe('validateRolePack：合规分档（§七）', () => {
  it('interactionType 越界 → INVALID_INTERACTION_TYPE error', () => {
    const result = validate({ interactionType: 'fun' });
    expect(findByCode(result.issues, 'INVALID_INTERACTION_TYPE')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('缺省 interactionType = tool_assistant：无合规字段也可装载（分档兜底）', () => {
    const result = validate({ interactionType: undefined, aiIdentityDisclosure: undefined, minorProtection: undefined });
    expect(result.valid).toBe(true);
  });

  it('companion 缺失 aiIdentityDisclosure → COMPANION_MISSING_AI_DISCLOSURE error', () => {
    const result = validate({ interactionType: 'companion', aiIdentityDisclosure: undefined });
    expect(findByCode(result.issues, 'COMPANION_MISSING_AI_DISCLOSURE')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('companion 声明 aiIdentityDisclosure: false → 强校验拒绝', () => {
    const result = validate({ interactionType: 'companion', aiIdentityDisclosure: false });
    expect(findByCode(result.issues, 'COMPANION_MISSING_AI_DISCLOSURE')).toHaveLength(1);
  });

  it('companion 缺失 minorProtection → COMPANION_MISSING_MINOR_PROTECTION error', () => {
    const result = validate({ interactionType: 'companion', minorProtection: undefined });
    expect(findByCode(result.issues, 'COMPANION_MISSING_MINOR_PROTECTION')).toHaveLength(1);
  });

  it('companion 携带虚拟亲密关系特征 → COMPANION_INTIMATE_REDLINE error（红线）', () => {
    const result = validate(
      { interactionType: 'companion', aiIdentityDisclosure: true, minorProtection: 'required' },
      '## Persona\n\n你是用户的虚拟伴侣。\n\n## Rules\n\n- 不生成违法内容\n',
    );
    const issue = findByCode(result.issues, 'COMPANION_INTIMATE_REDLINE');
    expect(issue).toHaveLength(1);
    expect(issue[0]?.severity).toBe('error');
  });

  it('companion 完整合规声明（无红线词）→ 校验通过', () => {
    const result = validate(
      { interactionType: 'companion', aiIdentityDisclosure: true, minorProtection: 'required' },
      '## Persona\n\n你是一个温和的学习陪练。\n\n## Rules\n\n- 不生成违法内容\n',
    );
    expect(result.valid).toBe(true);
  });

  it('aiIdentityDisclosure 非布尔 → INVALID_AI_DISCLOSURE error', () => {
    const result = validate({ aiIdentityDisclosure: 'yes' });
    expect(findByCode(result.issues, 'INVALID_AI_DISCLOSURE')).toHaveLength(1);
  });

  it('minorProtection 非 required → INVALID_MINOR_PROTECTION error', () => {
    const result = validate({ minorProtection: 'optional' });
    expect(findByCode(result.issues, 'INVALID_MINOR_PROTECTION')).toHaveLength(1);
  });
});

describe('validateRolePack：capabilities 格式（§四）', () => {
  it('skills 非数组 → SKILLS_NOT_ARRAY error', () => {
    const result = validate({ skills: { capability: 'file:write' } });
    expect(findByCode(result.issues, 'SKILLS_NOT_ARRAY')).toHaveLength(1);
  });

  it('capability 非法格式 → INVALID_CAPABILITY error', () => {
    const result = validate({ skills: [{ capability: 'writeFile' }, { capability: 'Web:Search' }] });
    const issues = findByCode(result.issues, 'INVALID_CAPABILITY');
    expect(issues).toHaveLength(2);
    expect(result.valid).toBe(false);
  });

  it('capability 缺省/空串 → INVALID_CAPABILITY error', () => {
    const result = validate({ skills: [{ description: '无能力名' }] });
    expect(findByCode(result.issues, 'INVALID_CAPABILITY')).toHaveLength(1);
  });

  it('description 非字符串 → INVALID_CAPABILITY_DESCRIPTION warning', () => {
    const result = validate({ skills: [{ capability: 'file:write', description: 42 }] });
    const issue = findByCode(result.issues, 'INVALID_CAPABILITY_DESCRIPTION');
    expect(issue).toHaveLength(1);
    expect(issue[0]?.severity).toBe('warning');
    expect(result.valid).toBe(true);
  });
});

describe('validateRolePack：文件夹形态单一真理源（§2.4 修正 A）', () => {
  it('文件夹形态 frontmatter 含 name → METADATA_IN_FRONTMATTER error（拒绝加载）', () => {
    const result = validate({}, validBody, 'folder');
    expect(findByCode(result.issues, 'METADATA_IN_FRONTMATTER').length).toBeGreaterThan(0);
    expect(result.valid).toBe(false);
  });

  it('文件夹形态 frontmatter 含 formatVersion → 同样报 METADATA_IN_FRONTMATTER', () => {
    const result = validate({}, validBody, 'folder');
    const codes = findByCode(result.issues, 'METADATA_IN_FRONTMATTER').map((i) => i.path);
    expect(codes).toContain('formatVersion');
    expect(codes).toContain('interactionType');
  });
});

describe('validateManifest：元数据与合规（§2.4/§七，双文件闭环的 manifest 层）', () => {
  it('§2.4 完整 manifest 字段集校验通过', () => {
    const result = validateManifestOf();
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('缺少 name → MISSING_NAME error（manifest 必填，§2.4）', () => {
    const result = validateManifestOf({ name: undefined });
    expect(findByCode(result.issues, 'MISSING_NAME')).toHaveLength(1);
    expect(result.issues[0]?.severity).toBe('error');
    expect(result.valid).toBe(false);
  });

  it('formatVersion 非 semver → INVALID_FORMAT_VERSION error', () => {
    const result = validateManifestOf({ formatVersion: 'v1' });
    expect(findByCode(result.issues, 'INVALID_FORMAT_VERSION')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('未知键 → UNKNOWN_TOP_LEVEL_KEY warning + 忽略（§五 键级渐进）', () => {
    const result = validateManifestOf({ unknownField: 'x' });
    const issue = findByCode(result.issues, 'UNKNOWN_TOP_LEVEL_KEY');
    expect(issue).toHaveLength(1);
    expect(issue[0]?.severity).toBe('warning');
    expect(result.valid).toBe(true);
  });

  it('strategy/skills 出现在 manifest → UNKNOWN_TOP_LEVEL_KEY warning（归属 role-pack.md，§2.4 单一真理源）', () => {
    const result = validateManifestOf({ strategy: { act: {} }, skills: [] });
    const paths = findByCode(result.issues, 'UNKNOWN_TOP_LEVEL_KEY').map((i) => i.path);
    expect(paths).toContain('strategy');
    expect(paths).toContain('skills');
  });

  it('interactionType 越界 → INVALID_INTERACTION_TYPE error', () => {
    const result = validateManifestOf({ interactionType: 'fun' });
    expect(findByCode(result.issues, 'INVALID_INTERACTION_TYPE')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('缺省 interactionType = tool_assistant：无合规字段也可装载（分档兜底）', () => {
    const result = validateManifestOf({ interactionType: undefined, aiIdentityDisclosure: undefined, minorProtection: undefined });
    expect(result.valid).toBe(true);
  });

  it('companion 缺失 aiIdentityDisclosure → COMPANION_MISSING_AI_DISCLOSURE error（强校验）', () => {
    const result = validateManifestOf({ interactionType: 'companion', aiIdentityDisclosure: undefined });
    expect(findByCode(result.issues, 'COMPANION_MISSING_AI_DISCLOSURE')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('companion 缺失 minorProtection → COMPANION_MISSING_MINOR_PROTECTION error', () => {
    const result = validateManifestOf({ interactionType: 'companion', minorProtection: undefined });
    expect(findByCode(result.issues, 'COMPANION_MISSING_MINOR_PROTECTION')).toHaveLength(1);
  });

  it('companion 完整合规声明 → 校验通过（manifest 层无正文，红线归属 role-pack.md 层）', () => {
    const result = validateManifestOf({ interactionType: 'companion', aiIdentityDisclosure: true, minorProtection: 'required' });
    expect(result.valid).toBe(true);
    expect(findByCode(result.issues, 'COMPANION_INTIMATE_REDLINE')).toHaveLength(0);
  });
});

describe('validateRolePack：文件夹形态红线注入（§七 第 5 条，双文件闭环）', () => {
  /** folder 形态合法 role-pack.md frontmatter（仅 strategy + skills，§2.4） */
  const folderFrontmatter = { strategy: validStrategy, skills: validFrontmatter['skills'] };

  it('manifest 注入 companion + body 含红线词 → COMPANION_INTIMATE_REDLINE error', () => {
    const result = validateRolePack({
      frontmatter: folderFrontmatter,
      body: '## Persona\n\n你是用户的虚拟伴侣。\n\n## Rules\n\n- 不生成违法内容\n',
      form: 'folder',
      manifestInteractionType: 'companion',
    });
    const issue = findByCode(result.issues, 'COMPANION_INTIMATE_REDLINE');
    expect(issue).toHaveLength(1);
    expect(issue[0]?.severity).toBe('error');
    expect(result.valid).toBe(false);
  });

  it('manifest 注入 companion + body 无红线词 → 校验通过', () => {
    const result = validateRolePack({
      frontmatter: folderFrontmatter,
      body: validBody,
      form: 'folder',
      manifestInteractionType: 'companion',
    });
    expect(result.valid).toBe(true);
  });

  it('manifest 注入 tool_assistant + body 含红线词 → 不报红线（工具型豁免）', () => {
    const result = validateRolePack({
      frontmatter: folderFrontmatter,
      body: '## Persona\n\n你是一位写作助手，负责描写虚拟伴侣题材短篇。\n\n## Rules\n\n- 不生成违法内容\n',
      form: 'folder',
      manifestInteractionType: 'tool_assistant',
    });
    expect(findByCode(result.issues, 'COMPANION_INTIMATE_REDLINE')).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('无注入（合规判定属调用方组合职责）→ 不报红线', () => {
    const result = validateRolePack({
      frontmatter: folderFrontmatter,
      body: '## Persona\n\n你是用户的虚拟伴侣。\n\n## Rules\n\n- 不生成违法内容\n',
      form: 'folder',
    });
    expect(findByCode(result.issues, 'COMPANION_INTIMATE_REDLINE')).toHaveLength(0);
  });
});

describe('validateRolePackText：原始文本便捷入口', () => {
  it('解析并校验完整 markdown 文本', () => {
    const raw = `---
name: 翻译助手
formatVersion: 1.0.0
strategy:
  act:
    toolMode: block
skills:
  - capability: file:read
---
## Persona

你是一位专业翻译。

## Rules

- 保持术语一致
`;
    const result = validateRolePackText(raw);
    expect(result.valid).toBe(true);
  });

  it('无 frontmatter 块 → MISSING_NAME + 章节缺失 error', () => {
    const result = validateRolePackText('## Persona\n\n你好\n');
    expect(findByCode(result.issues, 'MISSING_NAME').length).toBeGreaterThan(0);
    expect(findByCode(result.issues, 'MISSING_RULES').length).toBeGreaterThan(0);
  });
});
