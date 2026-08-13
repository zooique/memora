/**
 * 工具名中文映射 — Webview 渲染层纯函数（注入脚本）
 *
 * 说明：把工具原始英文名（如 read_file）映射为用户可理解的中文标签
 * （如「读取文件」），让工具卡片显示中文而非 snake_case 原值。
 * 未知工具降级为原值。以内联脚本字符串注入（CSP: script-src 'unsafe-inline'）。
 */
export const toolNameMapScript = `
function getToolDisplayName(name) {
  var map = {
    read_file: '读取文件',
    write_file: '写入文件',
    list_dir: '列出目录',
    search_memories: '搜索记忆',
    web_search: '网络搜索',
    memory_search: '记忆搜索',
    web_fetch: '抓取网页',
    create_persona: '创建角色',
    create_skill: '创建技能',
    create_rule: '创建规则'
  };
  return map[name] || name;
}`;