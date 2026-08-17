/**
 * 角色包格式校验器测试（role-pack-spec §八 / §2.2 manifest.json 唯一核心控制文件）
 */
import { describe, it, expect } from 'vitest';
import {
  validateManifest,
  validateManifestText,
  checkCompanionContentRedline,
} from '@/role-pack/validator.js';
import type { RolePackValidationIssue } from '@/role-pack/validator.js';

/** 合法 L2 策略（§六 v1 键集，类型化常量供展开覆写） */
const validStrategy = {
  prepare: { contextAssembly: 'hybrid', recentRounds: 3, memoryRecall: 'full', summaryRecall: 'on' },
  act: { toolMode: 'allow', temperature: 0.7, streaming: 'streaming' },
  reflect: { summary: 'on', handoff: 'wait' },
  global: { askOn: ['ambiguity', 'decision'], askLimit: 3, errorHandling: 'retry' },
};

/** 合法基础 manifest（§2.2：元数据 + 合规 + strategy + 内容注册 + skills） */
const validManifest: Record<string, unknown> = {
  name: '测试角色包',
  formatVersion: '1.0.0',
  version: '1.0.0',
  description: '测试角色包描述',
  author: '萧然',
  keywords: ['角色包', 'agent'],
  interactionType: 'tool_assistant',
  aiIdentityDisclosure: true,
  minorProtection: 'required',
  strategy: validStrategy,
  persona: 'persona.md',
  rules: 'rules.md',
  skills: [
    { file: 'skills/write.md', name: 'write', description: '写文件', capability: 'file:write' },
    { file: 'skills/search.md', name: 'search' },
  ],
};

/** 便捷构造：给定 manifest 覆写，返回校验结果；replaceAll=true 时整体替换 */
function validate(overrides: Record<string, unknown> = {}, replaceAll = false) {
  const manifest = replaceAll ? overrides : { ...validManifest, ...overrides };
  return validateManifest(manifest);
}

/** 提取指定 code 的问题列表 */
function findByCode(issues: readonly RolePackValidationIssue[], code: string) {
  return issues.filter((i) => i.code === code);
}

describe('validateManifest：合法 manifest', () => {
  it('§2.2 完整 manifest（元数据 + 策略 + 内容路径 + 多技能注册）校验通过', () => {
    const result = validate();
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('persona/rules 缺省（null / undefined）为合法（persona 允许缺省）', () => {
    const result = validate({ persona: null, rules: undefined });
    expect(findByCode(result.issues, 'INVALID_CONTENT_PATH')).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('skills 未声明为合法（无内嵌技能）', () => {
    const result = validate({ skills: undefined });
    expect(result.valid).toBe(true);
  });
});

describe('validateManifest：必填字段', () => {
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

describe('validateManifest：版本语义', () => {
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

describe('validateManifest：键名合法性', () => {
  it('未知顶层键 → UNKNOWN_TOP_LEVEL_KEY warning + 忽略', () => {
    const result = validate({ unknownKey: 'x' });
    const issue = findByCode(result.issues, 'UNKNOWN_TOP_LEVEL_KEY');
    expect(issue).toHaveLength(1);
    expect(issue[0]?.severity).toBe('warning');
    expect(result.valid).toBe(true);
  });

  it('已知键（strategy/skills/persona/rules/trigger/exclusiveWith）不报未知键', () => {
    const result = validate({ trigger: ['测试'], exclusiveWith: ['其他包'] });
    expect(findByCode(result.issues, 'UNKNOWN_TOP_LEVEL_KEY')).toHaveLength(0);
  });

  it('exclusiveWith 非法形状（字符串/数值）→ INVALID_EXCLUSIVE_WITH error', () => {
    const asString = validate({ exclusiveWith: '代码助手' });
    const asNumber = validate({ exclusiveWith: 12 });
    expect(asString.valid).toBe(false);
    expect(asNumber.valid).toBe(false);
    expect(
      [...asString.issues, ...asNumber.issues].filter(
        (i) => i.code === 'INVALID_EXCLUSIVE_WITH',
      ),
    ).toHaveLength(2);
  });

  it('exclusiveWith 合法字符串数组 / 空数组 → 通过', () => {
    const validArr = validate({ exclusiveWith: ['代码助手', '翻译助手'] });
    const emptyArr = validate({ exclusiveWith: [] });
    expect(validArr.valid).toBe(true);
    expect(emptyArr.valid).toBe(true);
    expect(findByCode(validArr.issues, 'INVALID_EXCLUSIVE_WITH')).toHaveLength(0);
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

describe('validateManifest：L2 策略取值越界（角色只"选择"不"定义"）', () => {
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

  it('summaryFocus 合法非空字符串 → 通过（P1 结构化保真提炼键）', () => {
    const result = validate({
      strategy: { ...validStrategy, prepare: { ...validStrategy.prepare, summaryFocus: '高价值代码片段' } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(0);
    expect(findByCode(result.issues, 'UNKNOWN_STRATEGY_KEY')).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('summaryFocus 空白字符串 → INVALID_STRATEGY_VALUE error（非空才合法）', () => {
    const result = validate({
      strategy: { ...validStrategy, prepare: { ...validStrategy.prepare, summaryFocus: '   ' } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
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

  it('loopContinue 非负整数合法（0=关闭 / N=最多 N 轮）→ 通过（雷-3b）', () => {
    const r0 = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, loopContinue: 0 } },
    });
    const r2 = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, loopContinue: 2 } },
    });
    expect(r0.valid).toBe(true);
    expect(r2.valid).toBe(true);
    expect(findByCode(r0.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(0);
  });

  it('loopContinue 负数/字符串 → INVALID_STRATEGY_VALUE error（雷-3b）', () => {
    const neg = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, loopContinue: -1 } },
    });
    const str = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, loopContinue: 'on' } },
    });
    expect(findByCode(neg.issues, 'INVALID_STRATEGY_VALUE').length).toBeGreaterThan(0);
    expect(findByCode(str.issues, 'INVALID_STRATEGY_VALUE').length).toBeGreaterThan(0);
  });

  it('userFollowup 枚举合法（ask/silent）且非枚举 error（雷-3b）', () => {
    const ok = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, userFollowup: 'ask' } },
    });
    const bad = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, userFollowup: 'chat' } },
    });
    expect(ok.valid).toBe(true);
    expect(findByCode(bad.issues, 'INVALID_STRATEGY_VALUE').length).toBeGreaterThan(0);
  });
});

describe('validateManifest：内容路径注册（persona / rules）', () => {
  it('persona 非字符串 → INVALID_CONTENT_PATH error', () => {
    const result = validate({ persona: 42 });
    expect(findByCode(result.issues, 'INVALID_CONTENT_PATH')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('rules 为空串 → INVALID_CONTENT_PATH error', () => {
    const result = validate({ rules: '   ' });
    expect(findByCode(result.issues, 'INVALID_CONTENT_PATH')).toHaveLength(1);
  });
});

describe('validateManifest：skills 注册（对象数组，§4）', () => {
  it('skills 非数组 → SKILLS_NOT_ARRAY error', () => {
    const result = validate({ skills: { file: 'x.md' } });
    expect(findByCode(result.issues, 'SKILLS_NOT_ARRAY')).toHaveLength(1);
  });

  it('skills 项非对象 → INVALID_MANIFEST_SKILL error', () => {
    const result = validate({ skills: ['skills/a.md'] });
    expect(findByCode(result.issues, 'INVALID_MANIFEST_SKILL')).toHaveLength(1);
  });

  it('skills 项缺 file 且缺 capability → INVALID_MANIFEST_SKILL error', () => {
    const result = validate({ skills: [{ name: 'no-file' }] });
    expect(findByCode(result.issues, 'INVALID_MANIFEST_SKILL').length).toBeGreaterThan(0);
  });

  it('纯 capability 声明（无 file 有 capability）合法（雷-3a）', () => {
    const result = validate({ skills: [{ capability: 'file:read' }] });
    expect(result.valid).toBe(true);
    expect(findByCode(result.issues, 'INVALID_MANIFEST_SKILL')).toHaveLength(0);
  });

  it('name/description 非字符串 → warning（不阻塞）', () => {
    const result = validate({ skills: [{ file: 'a.md', name: 1, description: 2 }] });
    expect(result.valid).toBe(true);
    expect(findByCode(result.issues, 'INVALID_MANIFEST_SKILL').length).toBeGreaterThan(0);
  });

  it('capability 非法格式 → INVALID_CAPABILITY error', () => {
    const result = validate({ skills: [{ file: 'a.md', capability: 'writeFile' }] });
    expect(findByCode(result.issues, 'INVALID_CAPABILITY')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('多个技能项（对象数组）均可注册', () => {
    const result = validate({
      skills: [
        { file: 'skills/a.md' },
        { file: 'skills/b.md', capability: 'file:write' },
        { file: 'skills/c.md', capability: 'web:search' },
      ],
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateManifest：合规分档（§七）', () => {
  it('interactionType 越界 → INVALID_INTERACTION_TYPE error', () => {
    const result = validate({ interactionType: 'fun' });
    expect(findByCode(result.issues, 'INVALID_INTERACTION_TYPE')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('缺省 interactionType = tool_assistant：无合规字段也可装载（分档兜底）', () => {
    const result = validate({
      interactionType: undefined,
      aiIdentityDisclosure: undefined,
      minorProtection: undefined,
    });
    expect(result.valid).toBe(true);
  });

  it('companion 缺失 aiIdentityDisclosure → COMPANION_MISSING_AI_DISCLOSURE error', () => {
    const result = validate({ interactionType: 'companion', aiIdentityDisclosure: undefined });
    expect(findByCode(result.issues, 'COMPANION_MISSING_AI_DISCLOSURE')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('companion 缺失 minorProtection → COMPANION_MISSING_MINOR_PROTECTION error', () => {
    const result = validate({ interactionType: 'companion', minorProtection: undefined });
    expect(findByCode(result.issues, 'COMPANION_MISSING_MINOR_PROTECTION')).toHaveLength(1);
  });

  it('companion 完整合规声明 → 校验通过（红线检测归属内容文件层）', () => {
    const result = validate({ interactionType: 'companion' });
    expect(result.valid).toBe(true);
    expect(findByCode(result.issues, 'COMPANION_INTIMATE_REDLINE')).toHaveLength(0);
  });
});

describe('validateManifestText：原始文本便捷入口', () => {
  it('合法 JSON → 校验通过', () => {
    const raw = JSON.stringify({ name: '测试', formatVersion: '1.0.0' });
    expect(validateManifestText(raw).valid).toBe(true);
  });

  it('非合法 JSON → INVALID_JSON error', () => {
    const result = validateManifestText('{ not json');
    expect(findByCode(result.issues, 'INVALID_JSON')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });
});

describe('checkCompanionContentRedline：companion 内容红线（§七 第 5 条）', () => {
  it('内容含虚拟伴侣特征 → COMPANION_INTIMATE_REDLINE error', () => {
    const issues = checkCompanionContentRedline('你是用户的虚拟伴侣。');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('COMPANION_INTIMATE_REDLINE');
    expect(issues[0]?.severity).toBe('error');
  });

  it('干净内容 → 无红线', () => {
    expect(checkCompanionContentRedline('你是一位温和的学习陪练。')).toEqual([]);
  });

  it('空内容 → 无红线', () => {
    expect(checkCompanionContentRedline('')).toEqual([]);
  });
});

describe('validateManifest：handoffPrompt 接手衔接提示词（自洽声明）', () => {
  it('合法字符串 → 无问题', () => {
    const result = validate({ handoffPrompt: '我已准备好，请告诉我主题与要求。' });
    expect(findByCode(result.issues, 'INVALID_HANDOFF_PROMPT')).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('非字符串（数字/对象）→ INVALID_HANDOFF_PROMPT warning（不阻塞装载）', () => {
    const result = validate({ handoffPrompt: 42 });
    const issues = findByCode(result.issues, 'INVALID_HANDOFF_PROMPT');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(result.valid).toBe(true);
  });

  it('未声明 → 合法（可选）', () => {
    const result = validate({ handoffPrompt: undefined });
    expect(result.valid).toBe(true);
    expect(findByCode(result.issues, 'INVALID_HANDOFF_PROMPT')).toHaveLength(0);
  });
});