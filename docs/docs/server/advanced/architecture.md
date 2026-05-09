---
title: Architecture & Request Flow
sidebar_position: 2
---

# Architecture & Request Flow

This document explains the high-level architecture of Claude Code Router (CCR) and the end-to-end path of a single request — from the Claude Code client all the way to an upstream LLM provider.

## What CCR is

CCR is a **routing / proxy layer**:

- It speaks the Anthropic Messages API (`POST /v1/messages`) so Claude Code can talk to it transparently.
- It rewrites, transforms and forwards each request to whichever upstream provider the routing rules pick (DeepSeek, Gemini, OpenRouter, Ollama, …).
- Around that core it ships a configuration service, a Web UI, status line integration and a preset marketplace.

## Monorepo layout

| Package | Path | Responsibility |
| --- | --- | --- |
| `@musistudio/claude-code-router` | `packages/cli` | `ccr` CLI, process management, Claude Code integration |
| `@CCR/server` | `packages/server` | Fastify server, lifecycle hooks, SSE rewriting, agents |
| `@CCR/core` | `packages/core` | Router, Provider service, Transformer service, Config service, HTTP utils |
| `@CCR/shared` | `packages/shared` | Cross-package constants, preset import/export/merge, sensitive-field handling |
| `@CCR/ui` | `packages/ui` | React + Vite Web management UI |

Dependency graph:

```
cli → server → core → shared
ui  →  (independent SPA, talks to server over HTTP)
```

## End-to-end request flow

```
Claude Code (anthropic client)
        │  POST /v1/messages
        ▼
┌───────────────────────────────────┐
│ Fastify Server (packages/server)  │
│  preHandler: routing decision     │
│  Agent detection (e.g. imageAgent)│
└───────────────────────────────────┘
        │ marks req.provider / req.body.model
        ▼
┌───────────────────────────────────┐
│ Inbound transformer chain         │
│  anthropic → openai schema        │
│  + maxtoken / enhancetool / ...   │
└───────────────────────────────────┘
        │ unified ChatRequest
        ▼
┌───────────────────────────────────┐
│ sendUnifiedRequest                │
│  - build Authorization header     │
│  - resolve proxy via              │
│    resolveProviderProxy()         │
│  - dispatch with undici ProxyAgent│
└───────────────────────────────────┘
        │ HTTPS
        ▼
   Upstream provider
        │ SSE / JSON
        ▼
┌───────────────────────────────────┐
│ Outbound transformer chain        │
│  provider schema → anthropic      │
│  rewriteStream intercepts tools   │
└───────────────────────────────────┘
        │
        ▼
     Claude Code client
```

### 1. Routing (`packages/core/src/utils/router.ts`)

For every request the `Router` picks a `<provider, model>` pair:

1. **Project-level** override at `~/.claude/projects/<project-id>/claude-code-router.json`.
2. **Custom router**: when `CUSTOM_ROUTER_PATH` is set, a user-supplied JS function is called.
3. **Scenario routing** (priority order): `background`, `think`, `longContext` (token count via `tiktoken` cl100k_base, threshold from `longContextThreshold`), `webSearch`, `image`.
4. **Default**: `Router.default`.

Sub-agents may override the choice by tagging their prompt:

```
<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>
```

### 2. Transformers

CCR uses the Transformer framework provided by the external `@musistudio/llms` package. Each Transformer adapts the wire format in one or both directions:

- inbound: Anthropic-style request → upstream (OpenAI / Gemini / custom) request
- outbound: upstream SSE response → Anthropic-style SSE

Built-in transformers include `anthropic`, `deepseek`, `gemini`, `openrouter`, `groq`, `maxtoken`, `tooluse`, `reasoning`, `enhancetool`, …

Two scopes of application:

```json
{
  "transformer": {
    "use": ["openrouter"],          // provider scope
    "deepseek-chat": {              // model scope
      "use": ["tooluse"]
    }
  }
}
```

### 3. SSE stream rewriting

The server pipelines a pair of custom Transform streams:

- `SSEParserTransform` parses the byte stream into event objects.
- `SSESerializerTransform` re-serializes events into SSE bytes.
- `rewriteStream` sits in the middle so agents can intercept events (e.g. divert a `tool_use` event to a built-in tool and splice the result back).

### 4. Agents (`packages/server/src/agents/`)

Pluggable feature modules with three hooks:

| Hook | Purpose |
| --- | --- |
| `shouldHandle` | Decide whether the agent owns this request |
| `reqHandler` | Mutate the request body before it leaves |
| `tools` | Inject extra tools the agent can call |

Built-in: **imageAgent** (routes image-generation prompts to a model with image capability).

### 5. Config (`packages/core/src/services/config.ts`)

- File: `~/.claude-code-router/config.json`
- Format: JSON5 (comments + trailing commas)
- Env-var interpolation: `$VAR` and `${VAR}`
- Last 3 versions backed up automatically
- A change requires `ccr restart`
- If `Providers` is non-empty, `HOST` and `APIKEY` must be set; otherwise the server binds `0.0.0.0` without auth

## Networking & proxies

### Global proxy

`ConfigService.getHttpsProxy()` resolves the global proxy in this order:

1. `HTTPS_PROXY`
2. `https_proxy`
3. `httpsProxy`
4. `PROXY_URL`

The HTTP client (undici `ProxyAgent`) honours that URL for every outbound call.

### Per-provider proxy override

Each provider can define its own `proxy` field to override or bypass the global proxy:

| `proxy` value | Behavior |
| --- | --- |
| Not set (`undefined`) | **Inherit** the global `PROXY_URL` |
| String URL | **Override**: this provider uses that proxy |
| `false` or `""` | **Bypass**: connect directly even when a global proxy is set |

Example:

```json
{
  "PROXY_URL": "http://127.0.0.1:7890",
  "Providers": [
    {
      "name": "openai",
      "api_base_url": "https://api.openai.com/v1/chat/completions",
      "api_key": "$OPENAI_API_KEY",
      "models": ["gpt-4o"]
      // inherits global proxy
    },
    {
      "name": "deepseek",
      "api_base_url": "https://api.deepseek.com/chat/completions",
      "api_key": "$DEEPSEEK_API_KEY",
      "models": ["deepseek-chat"],
      "proxy": false
      // skip the global proxy, connect directly
    },
    {
      "name": "private-llm",
      "api_base_url": "https://internal.corp/v1/chat/completions",
      "api_key": "$INTERNAL_KEY",
      "models": ["llama-3.1-70b"],
      "proxy": "http://corp-gateway:3128"
      // dedicated corporate egress
    }
  ]
}
```

Implemented in `packages/core/src/utils/request.ts` (`resolveProviderProxy`) and consumed by `packages/core/src/api/routes.ts` (`sendRequestToProvider`). The Web UI exposes the same control under **Providers → Edit** as a "Proxy URL" input plus a "Bypass global proxy" checkbox.

## Logging

Two log streams in parallel:

| Source | Path | Contents |
| --- | --- | --- |
| Pino (server) | `~/.claude-code-router/logs/ccr-*.log` | HTTP, upstream calls, server events |
| Application | `~/.claude-code-router/claude-code-router.log` | Routing decisions, business events |

Level controlled by `LOG_LEVEL` (`fatal` / `error` / `warn` / `info` / `debug` / `trace`). Debug-level request logs include `useProxy`, useful when debugging the new per-provider proxy.

## CLI cheat sheet

```bash
ccr start          # start the server
ccr stop           # stop it
ccr restart        # restart
ccr status         # status snapshot
ccr code           # launch Claude Code wired through CCR
ccr model          # interactive model picker
ccr preset ...     # export / install / list / info / delete presets
ccr ui             # open the Web UI
ccr statusline     # status line (reads JSON from stdin)
ccr activate       # print shell env vars for integration
```

## Presets

A preset is a self-contained, shareable configuration bundle stored at `~/.claude-code-router/presets/<name>/manifest.json`:

- `api_key` and other sensitive values are replaced with `{{field}}` placeholders on export
- An optional `schema` collects user input on install (e.g. API keys)
- Conflict-resolution strategies on merge: `ask` / `overwrite` / `merge` / `skip`

Implementation lives in `packages/shared/src/preset/`: `export.ts`, `install.ts`, `merge.ts`, `sensitiveFields.ts`.

## Next

- [Provider configuration](/docs/server/config/providers) — full field table including `proxy`
- [Custom router](/docs/server/advanced/custom-router) — write routing logic in JavaScript
