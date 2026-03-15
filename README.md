# Escudos do Brasil — versão com ranking online

Este pacote adiciona ranking compartilhado ao jogo usando:
- Netlify Functions
- Netlify Blobs

## Estrutura
- `public/index.html` — jogo mobile-first
- `netlify/functions/leaderboard.js` — API do ranking
- `netlify.toml` — configuração do deploy
- `package.json` — dependência `@netlify/blobs`

## Como publicar
1. Extraia este pacote.
2. Suba a pasta inteira para um repositório Git.
3. Conecte esse repositório ao Netlify.
4. Faça o deploy pelo fluxo Git do Netlify.

## Importante
O ranking online depende de Functions. Para esse pacote, use deploy por Git no Netlify ou deploy via CLI/API. O modo de arrastar apenas a pasta do site não é adequado para publicar a parte server-side.
