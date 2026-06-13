---
description: 代码项目样板验证指南
---

# 样板验证指南

> 用于第 6 步"样板验证"，指导如何用一个真实但最简单的 CRUD 模块验证刚生成的 rules。

---

## 推荐样板实体

> 以下推荐适用于关系型数据库 + RESTful
> API 场景。若使用文档型数据库（MongoDB）、图数据库或事件溯源架构，样板实体应反映该数据模型的典型结构。

| 项目类型 | 推荐样板实体                    |
| -------- | ------------------------------- |
| 管理后台 | 分类管理（name + description）  |
| 电商     | 商品标签（name + color）        |
| 内容管理 | 标签管理（name + slug）         |
| 企业服务 | 部门管理（name + parent_id）    |
| 通用     | 数据字典（type + code + value） |

---

## 后端全链路验证

根据后端框架选择对应的验证链路：

### Node.js + Express（分层中间件）

```
1. Route 层  → 检查 backend_layers_rules.md：路由注册、中间件链
2. Validator → 检查 backend_layers_rules.md + security_rules.md：验证规则
3. Controller → 检查 backend_layers_rules.md：是否薄层、是否零业务逻辑
4. Service → 检查 backend_layers_rules.md + error_handling_rules.md：业务逻辑+错误码
5. Model → 检查 backend_layers_rules.md + api_architecture_rules.md + database_operations_rules.md
6. DB (Schema/Migration) → 检查 database_operations_rules.md + api_architecture_rules.md
```

### Go + Gin / Python + FastAPI（精简分层）

```
1. Handler/Route → 检查 backend_layers_rules.md：路由注册、请求解析
2. Service → 检查 backend_layers_rules.md + error_handling_rules.md：业务逻辑+错误
3. Repository/Model → 检查 database_operations_rules.md + api_architecture_rules.md
4. DB (Schema/Migration) → 检查 database_operations_rules.md
```

### 其他框架通用原则

```
- 每层职责是否单一？
- 依赖方向是否从外到内（Route→Service→Repository→DB）？
- 错误处理是否使用了统一的错误类型/错误码？
- 数据转换是否发生在正确的层？
```

---

## 前端全链路验证（全栈项目）

```
1. 列表页
   ├── 检查 frontend_architecture_rules.md：页面创建方式
   ├── 检查 frontend_architecture_rules.md：表格、分页、搜索
   └── 检查 frontend_architecture_rules.md：刷新规范

2. 表单弹窗
   ├── 检查 frontend_architecture_rules.md：表单创建方式
   ├── 检查 frontend_architecture_rules.md：字段校验
   └── 检查 frontend_architecture_rules.md：提交和错误处理

3. 删除确认
   ├── 检查 frontend_architecture_rules.md：确认弹窗组件
   └── 检查 frontend_architecture_rules.md：Toast 提示组件
```

---

## 整体验证

```
1. 按照 new-module-guide.md 走完整流程
   └── 检查指南中的每一步是否准确描述了实际开发过程

2. 运行和测试
   ├── 后端 API 是否能正常响应
   ├── 前端页面是否能正常加载
   └── 完整的 CRUD 操作是否能成功
```
