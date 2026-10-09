# Huihui Chat

A lightweight Chinese chat interface for a self-hosted Huihui Qwen model.

The public site is deployed automatically from [`web/`](web/) to GitHub Pages:

**https://ljzylinpr.github.io/conversation/**

Every push to `main` runs [the Pages workflow](.github/workflows/pages.yml). The workflow reads the repository variable `PUBLIC_API_BASE` and writes it into the generated `api-config.js` in the Pages artifact. Set that variable to the HTTPS URL of the model chat API.

The model server is separate from GitHub Pages. It should be exposed through an HTTPS tunnel or reverse proxy, with `CHAT_ACCESS_KEY` set and `CHAT_CORS_ORIGIN=https://ljzylinpr.github.io`. The browser asks for the access key at first use and holds it only in session storage. Never commit model weights, access keys, SSH credentials, or private server configuration.

The front end is plain HTML, CSS, and JavaScript. `server.py` is a Python standard-library streaming proxy for a local llama.cpp-compatible API. The browser stores conversations in its own local storage.
