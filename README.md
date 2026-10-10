# Huihui Chat

A lightweight Chinese chat interface for a self-hosted Huihui Qwen model.

The public site is deployed automatically from [`web/`](web/) to GitHub Pages:

**https://ljzylinpr.github.io/conversation/**

Every push to `main` runs [the Pages workflow](.github/workflows/pages.yml). The workflow reads the repository variable `PUBLIC_API_BASE` and writes it into the generated `api-config.js` in the Pages artifact. Set that variable to the HTTPS URL of the model chat API.

The model server is separate from GitHub Pages. Expose the chat proxy through an HTTPS tunnel or reverse proxy, with `CHAT_CORS_ORIGIN=https://ljzylinpr.github.io`. `CHAT_ACCESS_KEY` is optional: when enabled, the browser asks for it and holds it only in session storage. Never commit model weights, access keys, SSH credentials, or private server configuration.

The front end is plain HTML, CSS, and JavaScript. `server.py` is a Python standard-library streaming proxy for a local llama.cpp-compatible API. The browser stores conversations in its own local storage.

Mobile features include a single-line live thinking preview, expandable reasoning, four reasoning levels (fast / 2K / 4K / 8K), and a manual jump to the latest message. Streaming and completion preserve the reader's scroll position.

When the working context reaches 85%, the app can summarize older messages and retain the most recent three exchanges. Original messages stay in browser history. Short conversations avoid a separate token-count request; near the limit, the server applies the actual model template and counts tokens before compression. Failed or cancelled summaries never replace the conversation context.

The backend enforces the reasoning budget through llama.cpp's `reasoning_budget_tokens` sampler. It preserves assistant reasoning in recent history for prompt-cache reuse and closes upstream generation when the browser stops a request.
