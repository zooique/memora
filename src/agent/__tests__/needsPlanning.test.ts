/**
 * needsPlanning 判定单元测试（2026-09-14 层1：任务表触发确定性化）。
 *
 * 验证 detectNeedsPlanning 的确定性命中/不命中边界：多步/工程命令 → true；
 * 简单问答/闲聊 → false（宁漏判不打扰，对齐 Codex「简单任务不灌 padding」）。
 */
import { describe, it, expect } from 'vitest';
import { detectNeedsPlanning, PLAN_NUDGE_PROMPT } from '@/agent/needsPlanning.js';

describe('needsPlanning · 确定性判定', () => {
  it('改动类动词命中 → true（更新/修改/修复，承接自规划轮的明确改动指令）', () => {
    expect(detectNeedsPlanning('基于上述结论，执行更新')).toBe(true);
    expect(detectNeedsPlanning('修改这个文档的缺口状态')).toBe(true);
    expect(detectNeedsPlanning('修复刚发现的 bug')).toBe(true);
  });

  it('强工程命令词命中 → true（重构/迁移/搭建/批量等）', () => {
    expect(detectNeedsPlanning('重构这个模块的登录逻辑')).toBe(true);
    expect(detectNeedsPlanning('把数据从 A 迁移到 B')).toBe(true);
    expect(detectNeedsPlanning('从零搭建一个认证系统')).toBe(true);
    expect(detectNeedsPlanning('批量修复所有测试失败')).toBe(true);
  });

  it('多步结构信号命中 → true（承接词 / 并列动作 / 步骤拆解）', () => {
    expect(detectNeedsPlanning('先看现有实现，再设计改造方案')).toBe(true);
    expect(detectNeedsPlanning('分步骤实现：先建表，再写接口，最后补前端')).toBe(true);
    expect(detectNeedsPlanning('刷新界面、修接口、补测试')).toBe(true);
  });

  it('简单问答 / 闲聊 → false（宁漏判不打扰）', () => {
    expect(detectNeedsPlanning('你好')).toBe(false);
    expect(detectNeedsPlanning('谢谢')).toBe(false);
    expect(detectNeedsPlanning('请解释一下什么是单一真理源')).toBe(false);
    expect(detectNeedsPlanning('帮我写一个 add 函数')).toBe(false);
    expect(detectNeedsPlanning('现在几点了')).toBe(false);
  });

  it('空输入 → false', () => {
    expect(detectNeedsPlanning('')).toBe(false);
    expect(detectNeedsPlanning('   ')).toBe(false);
  });
});

describe('PLAN_NUDGE_PROMPT', () => {
  it('应为命令式强引导（唤醒用 task 表 + 命令词，不回述工具用法细节）', () => {
    expect(PLAN_NUDGE_PROMPT).toContain('task_table_write');
    // 命令式而非建议式：出现明确指令词
    expect(PLAN_NUDGE_PROMPT).toMatch(/先用|必须|禁止/);
    // SSOT：how（如何标记状态）不在 nudge 复述——统一指向工具描述（builtinTools 是任务表操作唯一真源）
    expect(PLAN_NUDGE_PROMPT).not.toContain('task_table_update 标记');
  });
});