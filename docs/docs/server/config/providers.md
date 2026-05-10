---
sidebar_position: 2
---

# Providers Configuration

Detailed guide for configuring LLM providers.

## Supported Providers

### DeepSeek

```json
{
  "NAME": "deepseek",
  "HOST": "https://api.deepseek.com",
  "APIKEY": "your-api-key",
  "MODELS": ["deepseek-chat", "deepseek-coder"],
  "transformers": ["anthropic"]
}
```

### Groq

```json
{
  "NAME": "groq",
  "HOST": "https://api.groq.com/openai/v1",
  "APIKEY": "your-api-key",
  "MODELS": ["llama-3.3-70b-versatile"],
  "transformers": ["anthropic"]
}
```

### Gemini

```json
{
  "NAME": "gemini",
  "HOST": "https://generativelanguage.googleapis.com/v1beta",
  "APIKEY": "your-api-key",
  "MODELS": ["gemini-1.5-pro"],
  "transformers": ["anthropic"]
}
```

### OpenRouter

```json
{
  "NAME": "openrouter",
  "HOST": "https://openrouter.ai/api/v1",
  "APIKEY": "your-api-key",
  "MODELS": ["anthropic/claude-3.5-sonnet"],
  "transformers": ["anthropic"]
}
```

## Provider Configuration Options

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `NAME` | string | Yes | Unique provider identifier |
| `HOST` | string | Yes | API base URL |
| `APIKEY` | string | Yes | API authentication key |
| `MODELS` | string[] | No | List of available models |
| `proxy` | string \| false | No | Per-provider proxy override (see below) |
| `transformers` | string[] | No | List of transformers to apply |

## Per-provider proxy

Each provider can override the global `PROXY_URL` via its own `proxy` field:

| `proxy` value | Behavior |
| --- | --- |
| Not set (`undefined`) | Inherit the global `PROXY_URL` / `HTTPS_PROXY` |
| String URL | Override: this provider uses that proxy |
| `false` or `""` | Bypass: connect directly even when a global proxy is set |

```json
{
  "PROXY_URL": "http://127.0.0.1:7890",
  "Providers": [
    { "name": "openai",     "api_base_url": "...", "api_key": "...", "models": ["gpt-4o"] },
    { "name": "deepseek",   "api_base_url": "...", "api_key": "...", "models": ["deepseek-chat"], "proxy": false },
    { "name": "internal",   "api_base_url": "...", "api_key": "...", "models": ["llama-3.1-70b"], "proxy": "http://corp-gateway:3128" }
  ]
}
```

## Model Selection

When selecting a model in routing, use the format:

```
{provider-name},{model-name}
```

For example:

```
deepseek,deepseek-chat
```

## Next Steps

- [Routing Configuration](/docs/server/config/routing) - Configure how requests are routed
- [Transformers](/docs/server/config/transformers) - Apply transformations to requests
