冷啟首跑（必要）：
  pnpm install
  pnpm build:core           # 生 core dist/cjs+esm（dev:server 依賴）
  pnpm build:shared         # 生 shared dist
                                                                                                                                                                                              
  之後 dev（按需開）：
  pnpm dev:core             # core watch (改 core 才需)                                                                                                                                       
  pnpm dev:server           # server，端口 3456（讀 ~/.claude-code-router/config.json）
  pnpm dev:cli              # cli ts-node
  pnpm dev:ui               # UI Vite，預設 5173
  pnpm dev:docs             # docs 英文預覽，3000
  pnpm --filter claude-code-router-docs start:zh   # docs 中文預覽


