/**
 * SignalDetector 单元测试
 *
 * 覆盖：
 * - 强信号匹配（自我介绍 / 显式记忆 / 偏好 / 技术栈 / 决策 / 地理）
 * - 弱信号不命中（问候 / 询问 / 闲聊）
 * - 边界情况（空 / 过短 / 过长 / 非字符串）
 * - 信号名提取
 */
import { describe, it, expect } from 'vitest';
import { detectMemorableSignal, extractSignalName } from '@/agent/signal-detector.js';

describe('SignalDetector · detectMemorableSignal', () => {
  describe('应命中（强信号）', () => {
    it('自我介绍：我是 + 职业', () => {
      expect(detectMemorableSignal('我是一名软件工程师')).toBe(true);
    });

    it('自我介绍：我叫 + 名字', () => {
      expect(detectMemorableSignal('我叫张三')).toBe(true);
    });

    it('自我介绍：我的名字', () => {
      expect(detectMemorableSignal('我的名字是小明')).toBe(true);
    });

    it('显式记忆请求：记住', () => {
      expect(detectMemorableSignal('请记住我的生日是 5 月 20 号')).toBe(true);
    });

    it('显式记忆请求：记一下', () => {
      expect(detectMemorableSignal('帮我记一下我不吃香菜')).toBe(true);
    });

    it('不要忘记', () => {
      expect(detectMemorableSignal('别忘了明天 10 点开会')).toBe(true);
    });

    it('偏好：我喜欢', () => {
      expect(detectMemorableSignal('我喜欢简洁的代码风格')).toBe(true);
    });

    it('偏好：我讨厌', () => {
      expect(detectMemorableSignal('我讨厌过度工程')).toBe(true);
    });

    it('技术栈：我用 TypeScript', () => {
      expect(detectMemorableSignal('我主要用 TypeScript 写后端')).toBe(true);
    });

    it('决策：我们决定', () => {
      expect(detectMemorableSignal('我们决定采用微服务架构')).toBe(true);
    });

    it('决策：就这么定了', () => {
      expect(detectMemorableSignal('就这么定了，不用再讨论')).toBe(true);
    });

    it('地理：我在上海', () => {
      expect(detectMemorableSignal('我住在上海')).toBe(true);
    });
  });

  describe('应不命中（弱信号）', () => {
    it('问候', () => {
      expect(detectMemorableSignal('你好')).toBe(false);
    });

    it('询问', () => {
      expect(detectMemorableSignal('你叫什么名字？')).toBe(false);
    });

    it('闲聊', () => {
      expect(detectMemorableSignal('今天天气不错')).toBe(false);
    });

    it('请求帮助（无个人信息）', () => {
      expect(detectMemorableSignal('帮我写一个递归函数')).toBe(false);
    });

    it('技术问题（无个人信息）', () => {
      expect(detectMemorableSignal('TypeScript 怎么定义泛型？')).toBe(false);
    });
  });

  describe('边界情况', () => {
    it('空字符串', () => {
      expect(detectMemorableSignal('')).toBe(false);
    });

    it('只有空格', () => {
      expect(detectMemorableSignal('   ')).toBe(false);
    });

    it('过短（< 4 字符）', () => {
      expect(detectMemorableSignal('我叫')).toBe(false);
    });

    it('过长（> 500 字符）', () => {
      const long = '我' + '好'.repeat(500);
      expect(detectMemorableSignal(long)).toBe(false);
    });

    it('非字符串', () => {
      expect(detectMemorableSignal(null as unknown as string)).toBe(false);
      expect(detectMemorableSignal(undefined as unknown as string)).toBe(false);
      expect(detectMemorableSignal(123 as unknown as string)).toBe(false);
    });
  });
});

describe('SignalDetector · extractSignalName', () => {
  it('自我介绍类应返回"自我介绍"', () => {
    expect(extractSignalName('我叫张三')).toBe('自我介绍');
    expect(extractSignalName('我是一名工程师')).toBe('自我介绍');
    expect(extractSignalName('我的名字是小明')).toBe('自我介绍');
  });

  it('显式记忆类应返回"用户主动记忆"', () => {
    expect(extractSignalName('请记住我的生日')).toBe('用户主动记忆');
    expect(extractSignalName('帮我记一下')).toBe('用户主动记忆');
  });

  it('偏好类应返回"个人偏好"', () => {
    expect(extractSignalName('我喜欢简洁的代码')).toBe('个人偏好');
    expect(extractSignalName('我讨厌过度设计')).toBe('个人偏好');
  });

  it('技术栈应返回"技术栈"', () => {
    expect(extractSignalName('我用 TypeScript')).toBe('技术栈');
    expect(extractSignalName('项目是 React')).toBe('技术栈');
  });

  it('决策应返回"用户决策"', () => {
    expect(extractSignalName('我们决定用 PostgreSQL')).toBe('用户决策');
    expect(extractSignalName('就这么定了')).toBe('用户决策');
  });

  it('地理应返回"地理位置"', () => {
    expect(extractSignalName('我住在北京')).toBe('地理位置');
    expect(extractSignalName('我来自上海')).toBe('地理位置');
  });

  it('未分类应返回"实时记录"', () => {
    expect(extractSignalName('随便说点啥')).toBe('实时记录');
  });
});
