#!/usr/bin/env python3
"""Dependency-free web chat and streaming proxy for a local llama.cpp server."""
from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import os
import secrets
import signal
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.0.0"
MODEL = os.environ.get("CHAT_MODEL", "huihui-qwen3.8-27b-gsq-rco-iq3_s-mtp")
UPSTREAM = os.environ.get("CHAT_UPSTREAM", "http://127.0.0.1:8080").rstrip("/")
WEB = Path(__file__).resolve().parent / "web"
CONTEXT_SIZE = int(os.environ.get("CHAT_CONTEXT_SIZE", "262144"))
MAX_OUTPUT = 65536
MAX_BODY = 32 * 1024 * 1024
ACCESS_KEY = os.environ.get("CHAT_ACCESS_KEY", "")
ALLOWED_ORIGINS = {origin.strip().rstrip("/") for origin in os.environ.get("CHAT_CORS_ORIGIN", "").split(",") if origin.strip()}
LOG = logging.getLogger("huihui-chat")
NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def upstream_json(path: str, payload=None, timeout=30):
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
    request = urllib.request.Request(UPSTREAM + path, data=data,
                                     headers={"Content-Type": "application/json"})
    with NO_PROXY.open(request, timeout=timeout) as response:
        return json.load(response)


class ChatHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "HuihuiChat/" + VERSION

    def log_message(self, fmt, *args):
        LOG.info("%s %s", self.client_address[0], fmt % args)

    def reply_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.add_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def error_json(self, message, status=400):
        self.reply_json({"error": {"message": message, "code": status}}, status)

    def origin_allowed(self):
        origin = self.headers.get("Origin", "").rstrip("/")
        return not origin or not ALLOWED_ORIGINS or origin in ALLOWED_ORIGINS

    def add_cors_headers(self):
        origin = self.headers.get("Origin", "").rstrip("/")
        if origin and self.origin_allowed():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def do_OPTIONS(self):
        if not urllib.parse.urlsplit(self.path).path.startswith("/api/") or not self.origin_allowed():
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(204)
        self.add_cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/config":
            self.reply_json({"model": MODEL, "context_size": CONTEXT_SIZE,
                             "max_output_tokens": MAX_OUTPUT,
                             "default_output_tokens": 32768, "version": VERSION,
                             "requires_access_key": bool(ACCESS_KEY)})
            return
        if path == "/api/health":
            try:
                state = upstream_json("/health", timeout=5)
                models = upstream_json("/v1/models", timeout=5)
                available = next((m for m in models.get("data", [])
                                  if MODEL == m.get("id") or MODEL in m.get("aliases", [])), None)
                ready = state.get("status") == "ok" and available is not None
                context = (available or {}).get("meta", {}).get("n_ctx", 0)
                self.reply_json({"status": "ok" if ready else "unavailable",
                                 "model": MODEL, "context_size": context}, 200 if ready else 503)
            except (OSError, ValueError, urllib.error.URLError) as error:
                LOG.warning("upstream health unavailable: %s", type(error).__name__)
                self.error_json("模型服务暂时无法连接，请稍后重试。", 503)
            return
        if path.startswith("/api/"):
            self.error_json("接口不存在。", 404)
            return
        try:
            file = (WEB / ("index.html" if path == "/" else urllib.parse.unquote(path).lstrip("/"))).resolve()
            if not file.is_relative_to(WEB.resolve()) or not file.is_file():
                self.error_json("页面不存在。", 404)
                return
            content = file.read_bytes()
            content_type = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type == "application/javascript":
                content_type += "; charset=utf-8"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        if urllib.parse.urlsplit(self.path).path != "/api/chat":
            self.error_json("接口不存在。", 404)
            return
        if not self.origin_allowed():
            self.error_json("此网页来源未获允许。", 403)
            return
        if ACCESS_KEY:
            authorization = self.headers.get("Authorization", "")
            supplied = authorization[7:] if authorization.startswith("Bearer ") else ""
            if not secrets.compare_digest(supplied, ACCESS_KEY):
                self.error_json("访问密钥无效或尚未设置。", 401)
                return
        started = time.monotonic()
        response = None
        streaming = False
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                self.error_json("请求大小无效或超过 32 MiB。", 413)
                return
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("请求需要使用 JSON 对象。")
            messages = body.get("messages")
            if not isinstance(messages, list) or not messages:
                raise ValueError("请至少发送一条消息。")
            for message in messages:
                if not isinstance(message, dict) or message.get("role") not in ("system", "user", "assistant"):
                    raise ValueError("消息格式无效。")
                if not isinstance(message.get("content"), str):
                    raise ValueError("当前版本支持文字消息。")
            if not any(m["role"] == "user" and m["content"].strip() for m in messages):
                raise ValueError("请输入消息。")
            temperature = float(body.get("temperature", 1.0))
            if not 0 <= temperature <= 2:
                raise ValueError("温度需要在 0 到 2 之间。")
            requested = int(body.get("max_tokens", 32768))
            if not 1 <= requested <= MAX_OUTPUT:
                raise ValueError("回复长度需要在 1 到 65536 tokens 之间。")
            thinking = body.get("thinking", False)
            if not isinstance(thinking, bool):
                raise ValueError("思考开关格式无效。")
            template_options = {"enable_thinking": thinking}
            rendered = upstream_json("/apply-template", {
                "messages": messages, "add_generation_prompt": True,
                "chat_template_kwargs": template_options}, timeout=120)
            tokens = upstream_json("/tokenize", {
                "content": rendered["prompt"], "add_special": True,
                "parse_special": True}, timeout=120)
            prompt_tokens = len(tokens["tokens"])
            remaining = CONTEXT_SIZE - prompt_tokens - 32
            if remaining <= 0:
                self.error_json(f"当前对话约 {prompt_tokens:,} tokens，已超过 256K 上下文。请新建对话或删减内容；历史没有被自动丢弃。")
                return
            max_tokens = min(requested, remaining)
            payload = {"model": MODEL, "messages": messages,
                       "temperature": temperature, "max_tokens": max_tokens,
                       "stream": True, "stream_options": {"include_usage": True},
                       "chat_template_kwargs": template_options, "cache_prompt": True}
            request = urllib.request.Request(UPSTREAM + "/v1/chat/completions",
                data=json.dumps(payload, ensure_ascii=False).encode(),
                headers={"Content-Type": "application/json"})
            response = NO_PROXY.open(request, timeout=600)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("X-Prompt-Tokens", str(prompt_tokens))
            self.send_header("X-Context-Limit", str(CONTEXT_SIZE))
            self.send_header("X-Max-Output-Tokens", str(max_tokens))
            self.add_cors_headers()
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            streaming = True
            while True:
                chunk = response.read1(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
            LOG.info("chat completed messages=%s prompt_tokens=%s output_budget=%s time=%.2fs",
                     len(messages), prompt_tokens, max_tokens, time.monotonic() - started)
        except (BrokenPipeError, ConnectionResetError):
            LOG.info("client disconnected; closing generation stream")
        except urllib.error.HTTPError as error:
            try:
                details = json.loads(error.read(65536))
                message = details.get("error", {}).get("message", "模型服务返回错误。")
            except (ValueError, AttributeError):
                message = "模型服务返回错误，请重试。"
            if not streaming:
                self.error_json(message, error.code if 400 <= error.code < 600 else 502)
        except (ValueError, TypeError, KeyError) as error:
            if not streaming:
                self.error_json(str(error), 400)
        except (OSError, urllib.error.URLError) as error:
            LOG.warning("upstream failed: %s", type(error).__name__)
            if not streaming:
                self.error_json("模型连接暂时中断，请重试。", 502)
            else:
                try:
                    self.wfile.write(("data: " + json.dumps({"error": {"message": "模型连接中断，请重试。"}}, ensure_ascii=False) + "\n\n").encode())
                    self.wfile.flush()
                except OSError:
                    pass
        finally:
            if response is not None:
                response.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("CHAT_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("CHAT_PORT", "8088")))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    httpd = ThreadingHTTPServer((args.host, args.port), ChatHandler)
    httpd.daemon_threads = True
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=httpd.shutdown, daemon=True).start())
    LOG.info("Huihui Chat %s http://%s:%s context=%s upstream=%s access_key=%s cors_origins=%s", VERSION, args.host, args.port, CONTEXT_SIZE, UPSTREAM, bool(ACCESS_KEY), len(ALLOWED_ORIGINS))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
