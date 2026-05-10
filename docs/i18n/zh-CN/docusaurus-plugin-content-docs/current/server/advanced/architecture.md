---
title: 项目原理与请求流程
sidebar_position: 2
---

# 项目原理与请求流程

本文档介绍 Claude Code Router（CCR）的整体架构、各模块职责，以及一次请求从 Claude Code 客户端到上游 LLM 提供商之间的完整流程。

## 总体定位

Claude Code Router 是一个**代理层 / 路由层**：

- 对外伪装成 Anthropic Messages API（`/v1/messages`），让 Claude Code 客户端可以无感接入；
- 对内根据规则把请求**改写、转换、转发**给任意一个上游 LLM 提供商（DeepSeek、Gemini、OpenRouter、Ollama 等）；
- 同时承担配置管理、Web UI、状态栏、预设市场等周边能力。

## Monorepo 包结构

| 包名 | 路径 | 职责 |
| --- | --- | --- |
| `@musistudio/claude-code-router` | `packages/cli` | 命令行入口（`ccr` 命令）、进程管理、与 Claude Code 集成 |
| `@CCR/server` | `packages/server` | Fastify 服务、生命周期、Hook、SSE 重写、Agent 注册 |
| `@CCR/core` | `packages/core` | 路由器、Provider 服务、Transformer 服务、配置服务、HTTP 工具 |
| `@CCR/shared` | `packages/shared` | 跨包共享的常量、Preset 导入/导出/合并、敏感字段处理 |
| `@CCR/ui` | `packages/ui` | React + Vite 实现的 Web 管理界面 |

依赖关系：

```
cli → server → core → shared
ui  →（独立前端，通过 HTTP 调 server）
```

## 一次请求的完整流程

下面以 `claude` CLI 通过 CCR 发起一条对话为例：

```
Claude Code (anthropic 客户端)
        │  POST /v1/messages
        ▼
┌──────────────────────────────────┐
│ Fastify Server (packages/server) │
│  ├─ preHandler: 路由决策          │
│  └─ Agent 检测（如 imageAgent）   │
└──────────────────────────────────┘
        │ 标记 req.provider / req.body.model
        ▼
┌──────────────────────────────────┐
│ Transformer 入站链（请求方向）   │
│  anthropic → openai schema       │
│  + maxtoken / enhancetool 等     │
└──────────────────────────────────┘
        │ 统一为 UnifiedChatRequest
        ▼
┌──────────────────────────────────┐
│ sendUnifiedRequest               │
│  - Headers: Authorization 等     │
│  - 解析代理: resolveProviderProxy│
│  - 通过 undici ProxyAgent 发送   │
└──────────────────────────────────┘
        │ HTTPS
        ▼
   上游 Provider（DeepSeek / Gemini / 自建 ...）
        │ SSE / JSON 响应
        ▼
┌──────────────────────────────────┐
│ Transformer 出站链（响应方向）   │
│  provider schema → anthropic     │
│  rewriteStream 拦截工具调用      │
└──────────────────────────────────┘
        │
        ▼
     Claude Code 客户端
```

### 1. 路由决策（`packages/core/src/utils/router.ts`）

`Router` 决定本次请求走哪个 provider+model：

1. **项目级路由**：先看 `~/.claude/projects/<project-id>/claude-code-router.json`；
2. **自定义路由**：若配置 `CUSTOM_ROUTER_PATH`，加载用户自定义 JS 函数；
3. **场景路由**（按优先级）：
   - `background`：后台任务，通常用便宜的小模型；
   - `think`：Plan Mode / 推理密集；
   - `longContext`：用 `tiktoken` (cl100k_base) 估算 token 数，超过 `longContextThreshold` 即切换；
   - `webSearch`：含联网搜索意图；
   - `image`：图像相关；
4. **默认路由**：`Router.default`。

子代理（subagent）可以在 prompt 里用 `<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>` 显式指定模型，优先级高于规则路由。

### 2. Transformer 系统

CCR 通过 `@musistudio/llms` 提供的 Transformer 框架适配各家 API 差异：

- **入站**（请求方向）：把 Anthropic Messages 协议转换成目标 provider 的 OpenAI/Gemini/自定义协议；
- **出站**（响应方向）：把 provider 返回的 SSE 流转回 Anthropic 风格事件流。

内置 Transformer：`anthropic` `deepseek` `gemini` `openrouter` `groq` `maxtoken` `tooluse` `reasoning` `enhancetool` 等。

支持两层粒度：

```json
{
  "transformer": {
    "use": ["openrouter"],          // provider 级别，对所有模型生效
    "deepseek-chat": {              // 模型级别，仅对该模型生效
      "use": ["tooluse"]
    }
  }
}
```

### 3. SSE 流重写

服务端用一对自定义 Transform 流处理事件流：

- `SSEParserTransform`：把字节流解析成事件对象；
- `SSESerializerTransform`：把事件对象序列化回 SSE 文本；
- `rewriteStream`：在中间拦截事件，比如 Agent 工具调用要"切走"上游响应，转去执行内置工具，再把结果拼回流里。

### 4. Agent 系统（`packages/server/src/agents/`）

Agent 是可插拔的功能模块：

| 钩子 | 作用 |
| --- | --- |
| `shouldHandle` | 判断本次请求是否归该 Agent 处理 |
| `reqHandler` | 在请求送出前修改 body |
| `tools` | 注入额外的可调用工具 |

内置：

- **imageAgent**：把"画图"指令路由到带图像能力的模型/接口；

工具调用流程：`preHandler` 标记 Agent → 注入工具 → `onSend` 拦截到 `tool_use` → 跑 Agent 自带工具 → 把结果作为新一轮 LLM 请求 → 流式返回。

### 5. 配置加载（`packages/core/src/services/config.ts`）

- 路径：`~/.claude-code-router/config.json`；
- 格式：JSON5（支持注释和尾逗号）；
- 支持环境变量插值：`$VAR_NAME` 或 `${VAR_NAME}`；
- 修改后自动备份最近 3 份；
- 修改后需要 `ccr restart` 才会生效。

校验规则：若 `Providers` 为空则只监听 `0.0.0.0` 且不鉴权；否则必须设置 `HOST` 与 `APIKEY`。

## 网络与代理

### 全局代理

`ConfigService.getHttpsProxy()` 按以下顺序解析全局代理：

1. `HTTPS_PROXY`
2. `https_proxy`
3. `httpsProxy`
4. `PROXY_URL`

请求最终通过 `undici` 的 `ProxyAgent` 透传。

### Provider 级代理覆盖

每个 provider 现在可以单独设置 `proxy` 字段，精确控制本 provider 的网络出口：

| `proxy` 取值 | 行为 |
| --- | --- |
| 不写（`undefined`） | **继承全局** `PROXY_URL` |
| 字符串 URL，如 `"http://127.0.0.1:7890"` | **覆盖**全局代理，本 provider 走该代理 |
| `false` 或空字符串 `""` | **忽略代理**，即使存在全局代理也直连 |

典型用法：

```json
{
  "PROXY_URL": "http://127.0.0.1:7890",
  "Providers": [
    {
      "name": "openai",
      "api_base_url": "https://api.openai.com/v1/chat/completions",
      "api_key": "$OPENAI_API_KEY",
      "models": ["gpt-4o"]
      // 未设置 proxy → 走全局代理 127.0.0.1:7890
    },
    {
      "name": "deepseek",
      "api_base_url": "https://api.deepseek.com/chat/completions",
      "api_key": "$DEEPSEEK_API_KEY",
      "models": ["deepseek-chat"],
      "proxy": false
      // 国内厂商，强制不走代理
    },
    {
      "name": "private-llm",
      "api_base_url": "https://internal.corp/v1/chat/completions",
      "api_key": "$INTERNAL_KEY",
      "models": ["llama-3.1-70b"],
      "proxy": "http://corp-gateway:3128"
      // 走专用的企业代理
    }
  ]
}
```

代理解析逻辑实现在 `packages/core/src/utils/request.ts` 的 `resolveProviderProxy()`，并在 `packages/core/src/api/routes.ts` 的 `sendRequestToProvider()` 调用，对每一次外发请求都生效。

UI 中也提供了对应的输入框：在「供应商 → 编辑」中可以填写"代理地址"或勾选"为该供应商忽略全局代理"。

## 日志系统

CCR 有两套并行日志：

| 来源 | 路径 | 内容 |
| --- | --- | --- |
| Pino（服务级） | `~/.claude-code-router/logs/ccr-*.log` | HTTP、上游调用、服务事件 |
| 应用级 | `~/.claude-code-router/claude-code-router.log` | 路由决策、业务事件 |

日志级别由 `LOG_LEVEL` 控制：`fatal` / `error` / `warn` / `info` / `debug` / `trace`。`debug` 级别的请求日志中包含 `useProxy` 字段，可用于排查代理是否生效。

## CLI 命令速查

```bash
ccr start          # 启动服务
ccr stop           # 停止服务
ccr restart        # 重启
ccr status         # 状态
ccr code           # 启动 Claude Code 并接入 CCR
ccr model          # 交互式选择模型
ccr preset ...     # 预设的导入、导出、查看、删除
ccr ui             # 打开 Web UI
ccr statusline     # 状态栏（从 stdin 读 JSON）
ccr activate       # 输出 shell 环境变量，便于集成
```

## 预设系统

预设是一份完整的、可复用的配置包，存放在 `~/.claude-code-router/presets/<name>/manifest.json`：

- 导出时会自动把 `api_key` 等敏感字段替换成 `{{field}}` 占位符；
- 安装时根据 `schema` 定义引导用户填入实际值（API Key 等）；
- 冲突合并策略：`ask` / `overwrite` / `merge` / `skip`。

实现位于 `packages/shared/src/preset/`：`export.ts` 负责导出，`install.ts` 负责加载与安装，`merge.ts` 负责字段级合并，`sensitiveFields.ts` 负责敏感数据识别。

## 下一步

- [提供商配置](/docs/server/config/providers) — 含 `proxy` 字段的完整字段表
- [自定义路由器](/docs/server/advanced/custom-router) — 自己写 JS 路由
- [预设格式](/docs/server/advanced/preset-format) — 制作可分享的预设包
