# Responses 会话与服务器托管工具

自 v2.0.0 起支持。

Hydrogen 保存会话，执行模型与工具之间的循环。具体工具由你自己的 HTTP 转接服务实现，客户端不需要依赖某一家模型厂商的内置服务器工具。

## 注册和绑定

1. 在「服务器工具」页面注册工具，填写名称、描述和参数 JSON Schema（draft 7）。
2. 配置 POST URL、认证头、请求 JSON 模板和结果 JSON Pointer。
3. 展开「预览参数映射」，用示例参数和响应验证映射。预览不会发送 HTTP 请求。
4. 在 Model Service 或 Micro Agent 编辑器中勾选工具，选择流式方式与调用上限。保存后自动启用。

例如，注册 `search_documents`，参数定义：

```json
{
  "type": "object",
  "properties": { "query": { "type": "string", "description": "检索关键词" } },
  "required": ["query"],
  "additionalProperties": false
}
```

请求模板：

```json
{
  "tool": "{{tool.name}}",
  "arguments": "{{arguments}}",
  "session_id": "{{session.id}}",
  "call_id": "{{call.id}}"
}
```

转接服务收到固定 POST JSON。`call.id` 是 Hydrogen 为此次工具操作生成的唯一 ID；`session.id` 在会话续接期间保持稳定，可用于关联转接服务自己的状态。

也可引用 `{{arguments.query}}` 或数组索引路径。完整占位符保留对象、数字、布尔值等 JSON 类型；`"query={{arguments.query}}"` 这样的字符串插值只接受标量，不执行 JavaScript。

若 API 返回 `{"result":{"documents":[]}}`，结果路径填写 `/result`，模型收到 `{"documents":[]}`。留空返回完整 JSON。路径采用 JSON Pointer：`~1` 表示 `/`，`~0` 表示 `~`。

认证头加密保存，编辑时留空保留，填写 `{}` 清空。私有地址使用现有「可信私有上游」设置。工具请求独立于模型提供商的出站代理。

## Responses 续接

使用同一个 Hydrogen API Key：

```http
POST /v1/responses
Authorization: Bearer <Hydrogen API Key>
Content-Type: application/json

{"model":"开发助手","input":"搜索项目的部署说明"}
```

响应保留标准 `output`、`usage`，并附带：

```json
{
  "id": "resp_...",
  "hydrogen": {
    "response_id": "resp_...",
    "session_id": "resp_...",
    "tool_calls": []
  }
}
```

`tool_calls` 会记录本轮托管工具的开始、结果或错误。下一次只发送新输入：

```json
{"model":"开发助手","previous_response_id":"resp_...","input":"展开第二种部署方式"}
```

每轮得到新的响应 ID，`hydrogen.session_id` 保持稳定。上一轮的 `instructions` 不会自动继承，需要时每次显式发送。不同 Key 不能读取、删除或续接历史。

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| POST | `/v1/responses` | 创建响应、续接或启动后台任务 |
| GET / DELETE | `/v1/responses/:id` | 查询 / 删除已结束的响应 |
| GET | `/v1/responses/:id/input_items` | 分页查询本次模型输入 |
| POST | `/v1/responses/:id/cancel` | 取消后台任务 |
| POST | `/v1/conversations` | 创建会话 |
| GET / POST / DELETE | `/v1/conversations/:id` | 查询 / 更新元数据 / 删除会话 |
| GET / POST | `/v1/conversations/:id/items` | 查询 / 添加会话条目 |
| GET / DELETE | `/v1/conversations/:id/items/:itemId` | 查询 / 删除条目 |

分页参数：`limit`（1–100）、`order`（`asc` / `desc`）、`after`（上一页条目 ID）。会话条目支持 message、function_call、function_call_output 和 reasoning。

## Conversations

创建会话：

```http
POST /v1/conversations
Authorization: Bearer <Hydrogen API Key>
Content-Type: application/json

{"metadata":{"project":"example"},"items":[]}
```

然后调用 Responses：

```json
{"model":"开发助手","conversation":"conv_...","input":"开始分析"}
```

输入、工具轮次和模型输出会追加到会话。不能同时使用 `conversation` 与 `previous_response_id`。运行中的会话不能并发创建另一响应或修改条目，冲突返回 409。

## Anthropic 与混合工具

绑定后，`/v1/messages` 自动执行托管工具。普通客户端工具仍以标准 `tool_use` 返回。

同时调用两类工具时，Hydrogen 先完成托管工具，再返回客户端工具。客户端执行后，用服务器返回的 ID 和**新增**结果续接：

```json
{
  "model": "开发助手",
  "max_tokens": 1024,
  "hydrogen": { "previous_response_id": "resp_..." },
  "messages": [{
    "role": "user",
    "content": [{"type":"tool_result","tool_use_id":"client_call_id","content":"客户端执行结果"}]
  }]
}
```

需要补齐所有待处理客户端工具的结果。使用续接 ID 时不要重复发送完整历史。客户端工具与托管工具不能同名。

### 服务端工具往返（客户端协议）

工具定义里的可选 `serverTool` 契约，让客户端以**服务端工具**的形式拿到完整的调用与结果。没有这个契约时行为不变：模型照样用它，客户端只看到最终回答。

```json
{
  "name": "search",
  "description": "Search up to five short queries...",
  "parameters": { "type": "object", "properties": { "queries": { "type": "array" } } },
  "url": "http://hydrogen-tools-adapter:8080/tools/search",
  "bodyTemplate": { "...": "..." },
  "serverTool": {
    "name": "web_search",
    "resultType": "web_search_result",
    "resultPath": "/results"
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `name` | 客户端声明时使用的名称。以它为名的服务端工具声明会被路由到这个工具。 |
| `resultType` | 返回给客户端的结果块类型，默认 `web_search_result`。 |
| `resultPath` | 结果条目数组在适配器 JSON 中的 JSON Pointer；留空表示适配器直接返回数组。 |

**返回什么由你的适配器决定。** Hydrogen 不做字段映射、不认任何私有格式：它把 `resultPath` 选出的数组原样放进客户端协议要求的结果块里。字段名、条数、是否带摘要都归适配器。

适配器返回示例（`resultPath: "/results"`）：

```json
{ "engine": "…", "results": [{ "url": "https://…", "title": "…", "snippet": "…" }] }
```

Anthropic 客户端声明 `web_search_20250305` 后，会收到：

```json
[
  { "type": "server_tool_use", "id": "toolu_…", "name": "web_search", "input": { "queries": ["…"] } },
  { "type": "web_search_result", "tool_use_id": "toolu_…", "content": [{ "url": "https://…", "title": "…", "snippet": "…" }] },
  { "type": "text", "text": "最终回答" }
]
```

规则：

- 一次请求里的**每一轮**工具往返都会返回，不只最后一轮；顺序为「文字 → 调用 → 结果 → 最终答案」，与上游各轮一致，同一 assistant 轮内。
- 声明里的名称与绑定的工具名可以不同（客户端声明 `web_search`，你绑定 `search`），Hydrogen 按契约里的 `name` 匹配。
- 模型偶尔会调用**声明名**而不是真实工具名。这种调用不会到达任何适配器，Hydrogen 会丢弃它，避免让客户端去执行一个本该由服务端执行的工具。
- 客户端把收到的 `server_tool_use` / 结果块**回传**时会被保留，续接不会丢内容。
- 暴露范围仍由绑定决定：只有绑定了该工具的 Model Service / Micro Agent 才有这个能力。
- Responses 客户端声明 `{ "type": "web_search" }` 时，收到的是**单个 `web_search_call` item**（该协议的原生形态），来源 URL 放在 `action.sources`。

## 错误由适配器声明

失败**不是**用空数组表达，而是协议自己的错误对象。适配器通过同一个 `resultPath` 决定这件事：

- 返回**数组** → 正常结果条目。
- 返回**错误对象** → 采用你给的原因码：

```json
{ "results": { "type": "web_search_tool_result_error", "error_code": "max_uses_exceeded" } }
```

可用原因码（客户端协议定义的闭集，不能自造）：

| error_code | 含义 |
| --- | --- |
| `invalid_tool_input` | 参数不合法 |
| `unavailable` | 服务暂时不可用 |
| `max_uses_exceeded` | 超出调用次数上限 |
| `too_many_requests` | 被限流 |
| `query_too_long` | 查询过长 |
| `request_too_large` | 请求过大 |

**适配器没有声明原因时，Hydrogen 才填 `unavailable`** —— 包括指针选不到数组、返回非数组、JSON 无法解析、调用超出预算这些情况。原因码写进请求日志，便于定位到底是配置错还是上游故障。

绝不会有"失败被当成搜索无结果"的情况：Anthropic 线上失败是 `content` 位置的独立对象，Responses 线上是 `status: "failed"`。

## 已知限制

- **`encrypted_content` 无法产生。** Anthropic 的结果条目带一个不透明令牌，供模型复用上次检索而无需重搜；它是 Anthropic 生成的，Hydrogen 自己执行搜索时造不出该值。不读该字段的客户端（含 DeepSeek Harness 的搜索插件）不受影响。
- **`citations` 不发送。** 它要求"模型实际引用的原文与字符区间"，适配器提供不了，因此不伪造；表现为客户端拿到标题与链接、没有摘要片段。
- **服务端循环不会 `pause_turn`。** Hydrogen 在内部跑完整个工具循环；轮次上限到达时按失败处理，客户端没有"原样重发以续跑"的手段。

命名阶段引用已绑定工具的服务时，会先完成该阶段的工具循环，再返回阶段输出；各阶段共享顶层调用预算。Micro Agent 自己绑定的工具作用于其输出轮次。已有阶段缓冲和路由规则仍生效。

## 三种流式方式

客户端发送 `"stream":true`，服务配置决定呈现方式：

| 值 | 呈现 |
| --- | --- |
| `all` | 各轮模型 `hydrogen.model.delta`、工具开始与完成事件，最后输出标准协议答案 |
| `progress` | 实时工具进度，最后输出标准协议答案；默认模式 |
| `final` | 循环结束后，仅流式输出最终答案 |

过程事件含 `type`、`round`、`sequence_number`。工具事件为 `hydrogen.tool.started`、`hydrogen.tool.completed`，含 Hydrogen `call_id`、上游 `model_call_id`、工具名，以及参数或结果。

`hydrogen.model.delta` 的 `event` 是规范化模型事件，如 `text_delta`、`reasoning_delta`、`tool_start`。它属于过程记录；客户端应以标准 Responses/Anthropic 输出作为最终答案，避免重复拼入过程文本。「隐藏思考」设置同样作用于这些事件。

无托管工具的普通 Responses 仍实时返回标准文本事件。Reliable Streaming 与 Micro Agent 可能缓冲模型输出，`all` 不会取消这些执行规则，也不会补造模型没有提供的思考或进度。

## 后台任务与恢复读取

```json
{"model":"开发助手","input":"执行较长的检索任务","background":true,"stream":true}
```

后台任务在客户端断开后继续。GET 可查询 `queued`、`in_progress`、`completed`、`incomplete`、`failed` 或 `cancelled` 状态；也可带最后收到的序号恢复事件读取：

```http
GET /v1/responses/resp_...?stream=true&starting_after=123
```

取消使用 `POST /v1/responses/:id/cancel`，只接受后台任务。普通前台请求在客户端断开后终止。取消发出中止信号，但不能撤销外部工具已完成的操作。

进程重启或备份恢复后，未完成任务会标记失败，不会自动重发工具操作。一个 SQLite 数据目录应由一个 Hydrogen 进程使用。

## 保留与限制

- 设置页可调整闲置保留期，默认 30 天，0 表示永久保留。续接刷新期限，缩短期限会清理过期历史。
- `store:false` 使用执行期间的临时状态，交付后删除响应记录。后台任务要求 `store:true`；显式 Conversations 独立保留。
- 默认每个循环最多 8 轮模型、16 次工具调用，可在服务编辑器调整。嵌套共享调用预算，另有 128 个循环轮次的整体上限。
- 每个进程最多同时运行 32 个响应任务。会话上下文和流式事件存储有 25 MiB 上限。
- HTTP 超时、非成功状态、参数校验或结果路径错误，会作为明确的工具错误交给模型。HTTP 层不自动重试或跟随重定向。
- 工具业务逻辑、厂商内置工具类型模拟、转接服务自身的流式传输、提供商保存的 prompt 模板均不在此契约内。
