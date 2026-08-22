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