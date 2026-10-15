/**
 * 登录墙识别（isLoginWallPage）单元测试 — SEARCH-QUALITY-1 P2-1
 *
 * 背景：HTTP 200 的登录页被 stripHtmlToText 洗成「正文」——LLM 拿到登录表单碎片
 * 还以为是目标页面内容（搜不准第二种形态：搜到了、抓到了，但抓到的是一堵墙）。
 *
 * 判据设计（保守取向——漏判 = 现状可读页照常交付；误判 = 藏起可读页，故宁漏勿误）：
 * 1. URL 强信号：host/path 段边界分隔含 login/signin/logon/passport/sso。
 * 2. 弱信号组合：标题登录词 + 正文密码词 + 短正文（< 600 字符）三条件同时满足。
 *
 * 突变验证：判据两侧（URL 正则 / 弱信号组合）任一被摘 → 对应组用例变红。
 */
import { describe, it, expect } from 'vitest';
import { isLoginWallPage } from '@/web-fetch/loginWall.js';

describe('isLoginWallPage · 登录墙识别', () => {
  describe('URL 强信号（段边界匹配，防子串误判）', () => {
    it('路径段 /login → 判墙', () => {
      expect(isLoginWallPage('https://example.com/login', '示例站点', '欢迎来到示例站点')).toBe(
        true,
      );
    });

    it('路径段 /signin /logon /passport /sso → 判墙', () => {
      expect(isLoginWallPage('https://example.com/signin', 't', 'c')).toBe(true);
      expect(isLoginWallPage('https://example.com/user/logon', 't', 'c')).toBe(true);
      expect(isLoginWallPage('https://example.com/passport/cas', 't', 'c')).toBe(true);
      expect(isLoginWallPage('https://sso.example.com/auth', 't', 'c')).toBe(true);
    });

    it('sign-in 连字符形态 → 判墙', () => {
      expect(isLoginWallPage('https://example.com/users/sign-in', 't', 'c')).toBe(true);
    });

    it('查询串中的登录段 /en/login/help → 判墙', () => {
      expect(isLoginWallPage('https://example.com/en/login/help?x=1', 't', 'c')).toBe(true);
    });

    it('子串不误判：how-to-login / blogging / mylogin → 不判墙（词内/连字符前缀不算段边界）', () => {
      expect(
        isLoginWallPage('https://example.com/how-to-login', '登录教程', '正文'.repeat(500)),
      ).toBe(false);
      expect(isLoginWallPage('https://example.com/mylogin', '标题', '正文')).toBe(false);
    });

    it('查询参数值里的 login 不算（?redirect=login → 不判墙）', () => {
      expect(isLoginWallPage('https://example.com/article?redirect=login', '文章', '正文')).toBe(
        false,
      );
    });

    it('#fragment 锚点里的 login 不算（article#login 是文章不是登录页 · 落地自审 D-1）', () => {
      // 锚点是**页内位置**不是页面身份——搜索结果带 #login 锚点跳转的文章 URL
      // 不应被整页藏掉（剥 fragment 后强信号只认 host/path/查询串）。
      expect(
        isLoginWallPage('https://example.com/article#login', '会员体系白皮书', '正文'.repeat(500)),
      ).toBe(false);
      // fragment 剥除后路径仍带登录段 → 照常判墙（剥锚点不掩盖真墙）
      expect(isLoginWallPage('https://example.com/login#top', '登录', 'c')).toBe(true);
    });

    it('空 URL 不炸：强信号自然不命中，弱信号组合与 URL 无关（仍独立成立）', () => {
      // 空 URL 只关掉强信号路径；标题+密码词+短正文的弱信号组合不依赖 URL
      expect(isLoginWallPage('', '普通标题', '普通正文内容')).toBe(false);
      expect(isLoginWallPage('', '登录', '请输入密码')).toBe(true);
    });
  });

  describe('弱信号组合（标题登录词 + 正文密码词 + 短正文，三条件同时满足）', () => {
    it('典型登录页（标题登录词 + 密码词 + 短正文）→ 判墙', () => {
      const content = '用户名 密码 登录 忘记密码 注册新账号 扫码登录';
      expect(isLoginWallPage('https://example.com/member', '用户登录 - 示例站点', content)).toBe(
        true,
      );
    });

    it('contentCap < 弱信号阈值时禁用弱信号（截断上限制造伪「短正文」· 落地自审 D-3）', () => {
      const content = '用户名 密码 登录 忘记密码 注册新账号';
      // cap=300（LLM 传小 limit）：600 字阈值下的「短正文」可能是截断假象 → 弱信号不可信
      expect(
        isLoginWallPage('https://example.com/long-guide', '如何登录示例站点', content, 300),
      ).toBe(false);
      // cap ≥ 阈值：短正文是真实特征 → 弱信号照常生效
      expect(
        isLoginWallPage('https://example.com/long-guide', '如何登录示例站点', content, 8000),
      ).toBe(true);
      // cap 缺省（向后兼容：既有调用形状不变）→ 弱信号照常
      expect(isLoginWallPage('https://example.com/long-guide', '如何登录示例站点', content)).toBe(
        true,
      );
    });

    it('长正文教程（标题谈登录但正文长）→ 不判墙（教程可读）', () => {
      const content = `如何登录系统的详细指南。${'步骤说明'.repeat(300)} 忘记密码怎么办`.slice(
        0,
        2000,
      );
      expect(isLoginWallPage('https://example.com/guide', '如何登录示例站点', content)).toBe(false);
    });

    it('标题无登录词（仅正文提密码的文章）→ 不判墙', () => {
      expect(
        isLoginWallPage(
          'https://example.com/article',
          '密码安全指南',
          '设置强密码的方法'.repeat(20),
        ),
      ).toBe(false);
    });

    it('短正文但无密码词（标题登录词的错误页）→ 不判墙', () => {
      expect(
        isLoginWallPage('https://example.com/404', '页面不存在 - 登录', '您访问的页面不存在'),
      ).toBe(false);
    });

    it('英文登录页（Sign in + password）→ 判墙', () => {
      expect(
        isLoginWallPage(
          'https://example.com/account',
          'Sign in to continue',
          'Username Password Sign in',
        ),
      ).toBe(true);
    });
  });

  describe('保守取向总验', () => {
    it('普通正文页（长内容、无登录信号）→ 不判墙', () => {
      expect(
        isLoginWallPage(
          'https://example.com/blog/post-1',
          'Memora 架构设计',
          '本文介绍内核与宿主的双轨架构。'.repeat(100),
        ),
      ).toBe(false);
    });
  });
});
