/**
 * 角色包格式校验器测试（manifest.json 唯一核心控制文件）
 */
import { describe, it, expect } from 'vitest';
import {
  validateManifest,
  validateManifestText,
  checkCompanionContentRedline,
} from '@/role-pack/validator.js';
import type { RolePackValidationIssue } from '@/role-pack/validator.js';

/** 合法 L2 策略（已消费键集，类型化常量供展开覆写） */
const validStrategy = {
  prepare: { memoryRecall: 'full', memoryRecallPercent: 0.4, minFallback: 2, summaryFocus: '聚焦核心逻辑' },
  act: { toolMode: 'allow', temperature: 0.7, outputLimit: 4096, streaming: 'streaming' },
  reflect: { summary: 'on', handoff: 'wait', loopContinue: 0, userFollowup: 'silent' },
  global: { askOn: ['ambiguity', 'decision'], askLimit: 3 },
};

/** 合法基础 manifest（元数据 + 合规 + strategy + skills） */
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
  skills: [
    { file: 'skills/write.md', name: 'write', description: '写文件' },
    { file: 'skills/search.md', name: 'search' },
  ],
  capabilities: [
    { capability: 'file:write', description: '写文件' },
    { capability: 'web:search', description: '搜索' },
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
  it('完整 manifest（元数据 + 策略 + 多技能注册）校验通过', () => {
    const result = validate();
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
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

  it('formatVersion 缺省合法（按 1.0.0 处理）', () => {
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

  it('已知键（strategy/skills/trigger/exclusiveWith）不报未知键', () => {
    const result = validate({ trigger: ['测试'], exclusiveWith: ['其他包'] });
    expect(findByCode(result.issues, 'UNKNOWN_TOP_LEVEL_KEY')).toHaveLength(0);
  });

  it('keywords 双写法：字符串数组与逗号分隔字符串均为合法', () => {
    const asArray = validate({ keywords: ['文档', 'API'] });
    const asString = validate({ keywords: '文档, API' });
    expect(asArray.valid).toBe(true);
    expect(asString.valid).toBe(true);
    expect(findByCode(asArray.issues, 'INVALID_KEYWORDS')).toHaveLength(0);
    expect(findByCode(asString.issues, 'INVALID_KEYWORDS')).toHaveLength(0);
  });

  it('keywords 非法形状（数值/对象/数组含非字符串元素）→ INVALID_KEYWORDS error', () => {
    const asNumber = validate({ keywords: 12 });
    const asObject = validate({ keywords: { a: 1 } });
    const asArrayWithNonString = validate({ keywords: ['文档', 12] });
    for (const result of [asNumber, asObject, asArrayWithNonString]) {
      expect(result.valid).toBe(false);
      expect(findByCode(result.issues, 'INVALID_KEYWORDS')).toHaveLength(1);
    }
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

  it('未知策略键 → UNKNOWN_STRATEGY_KEY warning（键级渐进）', () => {
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
  it('已开启键 contextAssembly 非法值 → INVALID_STRATEGY_VALUE error（Tier 2 已消费）', () => {
    const result = validate({
      strategy: { ...validStrategy, prepare: { ...validStrategy.prepare, contextAssembly: 'weird' } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
    expect(result.valid).toBe(false); // error 阻断
  });

  it('已开启键 contextAssembly 合法值 → 通过（Tier 2 已消费）', () => {
    const result = validate({
      strategy: { ...validStrategy, prepare: { ...validStrategy.prepare, contextAssembly: 'query' } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(0);
    expect(findByCode(result.issues, 'UNKNOWN_STRATEGY_KEY')).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('memoryRecallPercent 合法百分比（0.0~1.0）→ 通过（cap 非 quota 键）', () => {
    const result = validate({
      strategy: { ...validStrategy, prepare: { ...validStrategy.prepare, memoryRecallPercent: 0.6 } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(0);
    expect(findByCode(result.issues, 'UNKNOWN_STRATEGY_KEY')).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('memoryRecallPercent 越界（> 1 / < 0）→ INVALID_STRATEGY_VALUE error', () => {
    const over = validate({
      strategy: { ...validStrategy, prepare: { ...validStrategy.prepare, memoryRecallPercent: 1.5 } },
    });
    const under = validate({
      strategy: { ...validStrategy, prepare: { ...validStrategy.prepare, memoryRecallPercent: -0.1 } },
    });
    expect(findByCode(over.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
    expect(findByCode(under.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('summaryFocus 合法非空字符串 → 通过（结构化保真提炼键）', () => {
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

  it('act.outputLimit 非正整数 → error', () => {
    const result = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, outputLimit: -1 } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('act.streaming 越界枚举 → error', () => {
    const result = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, streaming: 'invalid' } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('reflect.summary 越界枚举 → error', () => {
    const result = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, summary: 'invalid' } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('minFallback 负数 → error', () => {
    const result = validate({
      strategy: { ...validStrategy, prepare: { ...validStrategy.prepare, minFallback: -1 } },
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

describe('validateManifest：skills 注册（对象数组）', () => {
  it('skills 非数组 → SKILLS_NOT_ARRAY error', () => {
    const result = validate({ skills: { file: 'x.md' } });
    expect(findByCode(result.issues, 'SKILLS_NOT_ARRAY')).toHaveLength(1);
  });

  it('skills 项非对象 → INVALID_MANIFEST_SKILL error', () => {
    const result = validate({ skills: ['skills/a.md'] });
    expect(findByCode(result.issues, 'INVALID_MANIFEST_SKILL')).toHaveLength(1);
  });

  it('skills 项缺 file → INVALID_MANIFEST_SKILL error（skills 仅文件引用）', () => {
    const result = validate({ skills: [{ name: 'no-file' }] });
    expect(findByCode(result.issues, 'INVALID_MANIFEST_SKILL').length).toBeGreaterThan(0);
  });

  it('纯能力声明在顶层 capabilities 合法', () => {
    const result = validate({ capabilities: [{ capability: 'file:read' }] });
    expect(result.valid).toBe(true);
    expect(findByCode(result.issues, 'INVALID_CAPABILITY')).toHaveLength(0);
    expect(findByCode(result.issues, 'INVALID_MANIFEST_SKILL')).toHaveLength(0);
  });

  it('name/description 非字符串 → warning（不阻塞）', () => {
    const result = validate({ skills: [{ file: 'a.md', name: 1, description: 2 }] });
    expect(result.valid).toBe(true);
    expect(findByCode(result.issues, 'INVALID_MANIFEST_SKILL').length).toBeGreaterThan(0);
  });

  it('capabilities 非法格式 → INVALID_CAPABILITY error（顶层校验）', () => {
    const result = validate({ capabilities: [{ capability: 'writeFile' }] });
    expect(findByCode(result.issues, 'INVALID_CAPABILITY')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('多个技能项（对象数组）均可注册', () => {
    const result = validate({
      skills: [
        { file: 'skills/a.md' },
        { file: 'skills/b.md' },
        { file: 'skills/c.md' },
      ],
      capabilities: [
        { capability: 'file:write' },
        { capability: 'web:search' },
      ],
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateManifest：合规分档', () => {
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

describe('checkCompanionContentRedline：companion 内容红线', () => {
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