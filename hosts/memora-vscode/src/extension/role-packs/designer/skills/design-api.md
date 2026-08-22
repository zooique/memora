---
name: RESTful API 接口设计
description: 辅助设计符合 RESTful 规范的 API 接口，包括路由、参数、请求体和响应结构。
keywords: ['API', 'RESTful', '接口', '端点', '请求', '响应']
---

## 技能：RESTful API 接口设计

这个技能用于设计清晰、一致、符合 RESTful 规范的 API 接口。

### 工作流程

1.  **资源定义**：
    *   **识别资源**：根据 PRD 和领域模型，识别出系统中的核心资源（如 User, Order, Product 等）。
    *   **复数命名**：资源名使用小写复数形式，如 `/users`, `/orders`。
2.  **CRUD 操作与路由**：
    *   为每个核心资源定义其支持的 CRUD 操作，并映射到标准的 HTTP 方法和路由上：
        *   `GET /resources`：获取资源列表（支持分页、过滤）。
        *   `GET /resources/:id`：获取单个资源详情。
        *   `POST /resources`：创建新资源。
        *   `PUT /resources/:id`：全量更新一个资源。
        *   `PATCH /resources/:id`：部分更新一个资源。
        *   `DELETE /resources/:id`：删除一个资源。
3.  **请求与响应规范**：
    *   **请求参数**：清晰定义每个接口的路径参数、查询参数和请求体结构。
    *   **响应结构**：统一响应结构（如 `{ code, message, data }`），并详细定义成功和不同错误情况下的响应示例。
    *   **错误码**：设计一套清晰的业务错误码体系。
4.  **高级特性**：
    *   **分页**：为列表接口设计分页机制。
    *   **过滤与搜索**：支持通过查询参数进行资源过滤和搜索。
    *   **版本控制**：在 URL 或 Header 中支持 API 版本控制。
5.  **生成 API 文档**：使用 OpenAPI (Swagger) 风格生成 `[项目名]-API设计-v1.yaml` 或 Markdown 文档。

### 执行要点

*   **HTTP 方法语义**：严格遵循 HTTP 方法的语义（GET 安全幂等，POST 非幂等等）。
*   **一致性**：所有 API 的命名、参数风格、错误处理、响应格式都必须保持高度一致。
*   **状态码**：正确使用 HTTP 状态码（200 OK, 201 Created, 400 Bad Request, 404 Not Found 等）。
*   **示例**：提供具体的请求和响应示例，便于开发者理解。

### 输出模板

生成 API 设计文档时，请遵循以下标准结构：

```markdown
# {{项目名}} API 接口设计文档

> **版本**：v1.0  
> **作者**：{{作者}}  
> **创建日期**：{{日期}}  
> **关联架构文档**：[链接到架构设计文档]  
> **Base URL**：`https://api.example.com/v1`

---

## 1. 通用规范

### 1.1 认证
<!-- 描述认证方式：Bearer Token / API Key / OAuth 2.0 等 -->

### 1.2 通用响应格式
```json
{
  "code": 0,           // 0 表示成功，非 0 表示错误
  "message": "success", // 描述信息
  "data": {},          // 业务数据
  "timestamp": 1234567890
}
```

### 1.3 通用错误码
| 错误码 | HTTP 状态码 | 说明 |
|--------|-------------|------|
| 0 | - | 成功 |
| 40000 | 400 | 参数错误 |
| 40100 | 401 | 未授权 |
| 40300 | 403 | 禁止访问 |
| 40400 | 404 | 资源不存在 |
| 50000 | 500 | 服务器内部错误 |

### 1.4 分页规范
- 请求参数：`page` (从 1 开始), `page_size` (默认 20, 最大 100)
- 响应结构：
```json
{
  "data": [...],
  "pagination": {
    "total": 100,
    "page": 1,
    "page_size": 20,
    "total_pages": 5
  }
}
```

---

## 2. 用户模块

### 2.1 用户注册
**POST** `/users`

**请求体**：
```json
{
  "username": "string (必填，3-20 位)",
  "email": "string (必填，邮箱格式)",
  "password": "string (必填，8-20 位)"
}
```

**成功响应** (201 Created)：
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "uuid",
    "username": "john_doe",
    "email": "john@example.com",
    "created_at": "2024-01-01T00:00:00Z"
  }
}
```

**错误响应** (400 Bad Request)：
```json
{
  "code": 40000,
  "message": "邮箱已注册",
  "data": null
}
```

---

### 2.2 获取用户列表
**GET** `/users`

**查询参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| page | int | 否 | 页码，默认 1 |
| page_size | int | 否 | 每页条数，默认 20 |
| keyword | string | 否 | 搜索关键词 |

**成功响应** (200 OK)：
```json
{
  "code": 0,
  "message": "success",
  "data": [
    {
      "id": "uuid",
      "username": "john_doe",
      "email": "john@example.com"
    }
  ],
  "pagination": {
    "total": 50,
    "page": 1,
    "page_size": 20,
    "total_pages": 3
  }
}
```

---

### 2.3 获取用户详情
**GET** `/users/:id`

**路径参数**：
| 参数 | 类型 | 说明 |
|------|------|------|
| id | string | 用户 ID |

**成功响应** (200 OK)：
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "uuid",
    "username": "john_doe",
    "email": "john@example.com",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  }
}
```

**错误响应** (404 Not Found)：
```json
{
  "code": 40400,
  "message": "用户不存在",
  "data": null
}
```

---

### 2.4 更新用户
**PUT** `/users/:id`

**请求体**：
```json
{
  "username": "string (可选)",
  "email": "string (可选)",
  "password": "string (可选)"
}
```

**成功响应** (200 OK)：
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "uuid",
    "username": "john_updated",
    "email": "john@example.com"
  }
}
```

---

### 2.5 删除用户
**DELETE** `/users/:id`

**成功响应** (204 No Content)：无响应体

---

## 附录
<!-- 相关文档、术语表、变更记录 -->

### 变更记录
| 版本 | 日期 | 变更说明 |
|------|------|----------|
| v1.0 | {{日期}} | 初始版本 |
```