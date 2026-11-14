"""Vesper platform adapter for Hermes Agent: a private iMessage-style team chat. (The platform is named
``holler``, Vesper's working name: routines deliver with ``--deliver holler`` and settings start with HOLLER_.)

Each bot profile connects to the Vesper server on your Mac as itself (``HOLLER_BOT_TOKEN``), takes
its messages from a server-sent event stream and answers over HTTP. Stdlib asyncio only: the server is
local plain HTTP/1.1, so no client library is needed.

Profile ``.env`` keys (written by ``server/main.mjs --install-bot-tokens``): HOLLER_URL,
HOLLER_BOT_TOKEN, HOLLER_BOT_ID, HOLLER_ALLOWED_USERS, HOLLER_HOME_CHANNEL.

Room behavior: the server flags each message ``addressed`` or not. Unaddressed room messages are kept
here and handed to the bot as ``channel_context`` with its next addressed message, so every bot follows
the room without a model call per message. The room is sent as one shared thread so each bot keeps a
single conversation there, with Hermes's own ``[Name]`` speaker labels.
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime
import itertools
import json
import logging
import mimetypes
import os
import random
import time
import uuid
from collections import deque
from typing import Any, Optional
from urllib.parse import urlsplit

from gateway.config import Platform
from gateway.platforms._shared import get_scoped_secret as _get_scoped_secret
from gateway.platforms.base import (
    BasePlatformAdapter, ExecApprovalPrompt, SendResult, cache_document_from_bytes, cache_image_from_bytes)
from gateway.platforms.event import MessageEvent, MessageType, ProcessingOutcome
from gateway.platforms.helpers import MessageDeduplicator, cancel_task

logger = logging.getLogger(__name__)

PLATFORM = "holler"
ROOM_THREAD = "holler-room"
CONTEXT_MAX = 40  # unaddressed room lines kept per chat
CONTEXT_MAX_AGE_S = 6 * 3600
STREAM_IDLE_S = 75  # the server pings every 20 s
MAX_FETCH_BYTES = 25 * 1024 * 1024
APPROVAL_LABELS = {"once": "Approved once", "session": "Approved for this session",
                   "always": "Always approved", "deny": "Denied"}
# What a tapback from the owner means when it wakes the bot (the server only wakes for these three).
TAPBACK_MEANING = {
    "\U0001F44D": ("That is his yes. Go ahead with what you asked or offered there, then tell him it is done in a line. "
                   "Anything that needs an approval card still needs its card."),
    "\U0001F44E": "That is his no. Do not do what you asked or offered there. Acknowledge it in a line; ask what he wants instead only if you cannot carry on without it.",
    "\u2753": "He does not follow it, or wants to know more. Say it again in plain words, shorter, with the one fact that matters first.",
}
COMMANDS = {"/stop", "/new"}  # what the app's Stop and Start fresh buttons may send
# The gateway's own notices that say nothing the owner needs in the thread. "Redirected current run" (with a
# "First-time tip" every single time, since the seen flag is written to the wrong profile) answered each message he
# sent while a bot was working; the app already shows the bot working. A new conversation's banner is dropped too.
BUSY_NOTICES = ("\u21aa Redirected current run", "\u26a1 Interrupting current task", "\u23f3 Queued for the next turn",
                "\u23e9 Steered into current run")
RESET_NOTICES = ("\u2728 Session reset", "\u2728 New session started")
QUIET_WINDOW_S = 45
RECEIPT_STATE = {ProcessingOutcome.SUCCESS: "done", ProcessingOutcome.FAILURE: "failed", ProcessingOutcome.CANCELLED: "cancelled"}


def _env(key: str, extra: dict, extra_key: str, default: str = "") -> str:
    return (_get_scoped_secret(key) or extra.get(extra_key) or default or "").strip()


class _HttpError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:200]}")
        self.status = status


class _LocalHttp:
    """Minimal async HTTP/1.1 client for the local Holler server (Connection: close per request)."""

    def __init__(self, base_url: str, token: str):
        parts = urlsplit(base_url)
        if parts.scheme != "http" or not parts.hostname:
            raise ValueError("HOLLER_URL must be http://host:port")
        self.host, self.port, self.token = parts.hostname, parts.port or 80, token

    async def _open(self, timeout: float):
        return await asyncio.wait_for(asyncio.open_connection(self.host, self.port), timeout=timeout)

    def _head(self, method: str, path: str, headers: dict) -> bytes:
        lines = [f"{method} {path} HTTP/1.1", f"Host: {self.host}:{self.port}", f"Authorization: Bearer {self.token}"]
        lines += [f"{k}: {v}" for k, v in headers.items()]
        return ("\r\n".join(lines) + "\r\n\r\n").encode()

    @staticmethod
    async def _read_head(reader) -> tuple[int, dict]:
        status_line = await reader.readline()
        if not status_line:
            raise ConnectionError("empty response")
        status = int(status_line.split()[1])
        headers = {}
        while True:
            line = await reader.readline()
            if line in (b"\r\n", b"\n", b""):
                break
            k, _, v = line.decode("latin-1").partition(":")
            headers[k.strip().lower()] = v.strip()
        return status, headers

    @staticmethod
    async def _iter_body(reader, headers: dict):
        if headers.get("transfer-encoding", "").lower() == "chunked":
            while True:
                size_line = await reader.readline()
                if not size_line:
                    return
                size = int(size_line.split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    await reader.readline()
                    return
                data = await reader.readexactly(size)
                await reader.readexactly(2)
                yield data
        elif "content-length" in headers:
            n = int(headers["content-length"])
            if n:
                yield await reader.readexactly(n)
        else:
            while chunk := await reader.read(65536):
                yield chunk

    async def request(self, method: str, path: str, body: Any = None, *, raw: Optional[bytes] = None,
                      content_type: str = "application/json", extra_headers: Optional[dict] = None,
                      timeout: float = 20.0) -> Any:
        async def run():
            reader, writer = await self._open(timeout)
            try:
                payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else b"")
                headers = {"Connection": "close", "Content-Length": str(len(payload)), **(extra_headers or {})}
                if payload:
                    headers["Content-Type"] = content_type
                writer.write(self._head(method, path, headers) + payload)
                await writer.drain()
                status, rheaders = await self._read_head(reader)
                chunks, size = [], 0
                async for c in self._iter_body(reader, rheaders):
                    size += len(c)
                    if size > MAX_FETCH_BYTES:
                        raise _HttpError(413, "response too large")
                    chunks.append(c)
                data = b"".join(chunks)
                if status >= 400:
                    raise _HttpError(status, data.decode("utf-8", "replace"))
                if rheaders.get("content-type", "").startswith("application/json"):
                    return json.loads(data or b"null")
                return data
            finally:
                writer.close()
                with contextlib.suppress(Exception):
                    await writer.wait_closed()
        return await asyncio.wait_for(run(), timeout=timeout + 5)

    async def stream(self, path: str, last_event_id: int, on_open, on_event):
        """Open the SSE stream and call ``on_event(id, kind, data)`` per event until it drops."""
        reader, writer = await self._open(15.0)
        try:
            headers = {"Accept": "text/event-stream", "Cache-Control": "no-store"}
            if last_event_id:
                headers["Last-Event-ID"] = str(last_event_id)
            writer.write(self._head("GET", path, headers))
            await writer.drain()
            status, rheaders = await asyncio.wait_for(self._read_head(reader), timeout=15.0)
            if status != 200:
                body = b""
                with contextlib.suppress(Exception):
                    body = await asyncio.wait_for(reader.read(2048), timeout=2)
                raise _HttpError(status, body.decode("utf-8", "replace"))
            on_open()
            buf = b""
            body = self._iter_body(reader, rheaders)
            while True:
                chunk = await asyncio.wait_for(anext(body), timeout=STREAM_IDLE_S)
                buf += chunk.replace(b"\r\n", b"\n")
                while b"\n\n" in buf:
                    block, buf = buf.split(b"\n\n", 1)
                    ev_id, kind, data = 0, "message", []
                    for line in block.decode("utf-8", "replace").split("\n"):
                        if line.startswith("id:"):
                            with contextlib.suppress(ValueError):
                                ev_id = int(line[3:].strip())
                        elif line.startswith("event:"):
                            kind = line[6:].strip()
                        elif line.startswith("data:"):
                            data.append(line[5:].lstrip())
                    if data:
                        await on_event(ev_id, kind, json.loads("\n".join(data)))
        except StopAsyncIteration:
            return
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()


class HollerAdapter(BasePlatformAdapter):
    """Hermes adapter for Holler (one instance per bot profile)."""

    MAX_MESSAGE_LENGTH = 16000
    supports_code_blocks = True
    supports_status_text = True
    splits_long_messages = False

    def __init__(self, config, **kwargs):
        super().__init__(config=config, platform=Platform(PLATFORM))
        extra = getattr(config, "extra", {}) or {}
        self.base_url = _env("HOLLER_URL", extra, "url", "http://127.0.0.1:8802")
        self.bot_id = _env("HOLLER_BOT_ID", extra, "bot_id")
        self._token = _get_scoped_secret("HOLLER_BOT_TOKEN") or extra.get("token") or ""
        self._http: Optional[_LocalHttp] = None
        self._stream_task: Optional[asyncio.Task] = None
        self._opened = asyncio.Event()
        self._closing = False
        self._last_event_id = 0
        self._dedup = MessageDeduplicator()
        self._context: dict[str, deque] = {}
        self._chats: dict[str, dict] = {}
        self._approval_ids = itertools.count(1)
        self._approvals: dict[str, str] = {}  # approval id -> session_key
        self._clarify: dict[str, list] = {}  # clarify id -> choices
        self._typing_sent: dict[str, tuple] = {}
        self._background: set[asyncio.Task] = set()
        self._quiet_ids: set[str] = set()  # command message ids whose reply stays out of the thread
        self._quiet_until: dict[str, float] = {}  # chat id -> until when a reset banner there is dropped

    @property
    def name(self) -> str:
        return "Holler"

    def _fail(self, code: str, message: str, *, retryable: bool) -> bool:
        self._set_fatal_error(code, message, retryable=retryable)
        return False

    # ── lifecycle ────────────────────────────────────────────────────────────

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not (self._token and self.bot_id):
            return self._fail("config_missing", "HOLLER_BOT_TOKEN and HOLLER_BOT_ID must be set", retryable=False)
        try:
            self._http = _LocalHttp(self.base_url, self._token)
        except ValueError as e:
            return self._fail("config_invalid", str(e), retryable=False)
        if not self._acquire_platform_lock("holler", f"{self.base_url}:{self.bot_id}", f"Holler bot {self.bot_id}"):
            return False
        self._closing = False
        self._opened.clear()
        self._stream_task = asyncio.create_task(self._stream_loop())
        try:
            await asyncio.wait_for(self._opened.wait(), timeout=10.0)
        except TimeoutError:
            await self.disconnect()
            return self._fail("connect_failed", f"Holler server not reachable at {self.base_url}", retryable=True)
        if self._stream_task.done():
            await self.disconnect()
            return False
        self._mark_connected()
        self._wire_plugin_handlers(None)
        logger.info("Holler: %s connected to %s", self.bot_id, self.base_url)
        return True

    async def disconnect(self) -> None:
        self._closing = True
        with contextlib.suppress(Exception):
            self._release_platform_lock()
        self._mark_disconnected()
        await cancel_task(self._stream_task)
        self._stream_task = None

    async def _stream_loop(self) -> None:
        delay = 1.0
        while not self._closing:
            try:
                await self._http.stream("/bot/v1/events", self._last_event_id, self._on_open, self._on_event)
            except asyncio.CancelledError:
                raise
            except _HttpError as e:
                if e.status in (401, 403):
                    logger.error("Holler: server refused %s's token; stopping", self.bot_id)
                    self._set_fatal_error("auth_failed", "Holler rejected HOLLER_BOT_TOKEN", retryable=False)
                    return
                logger.warning("Holler: event stream error for %s: %s", self.bot_id, e)
            except Exception as e:  # dropped connection, server restart, idle timeout
                logger.info("Holler: event stream for %s dropped (%s); reconnecting", self.bot_id, type(e).__name__)
            else:
                delay = 1.0
            if self._closing:
                return
            await asyncio.sleep(delay + random.uniform(0, delay * 0.3))
            delay = min(delay * 2, 30.0)

    def _on_open(self) -> None:
        self._opened.set()

    # ── inbound ──────────────────────────────────────────────────────────────

    async def _on_event(self, ev_id: int, kind: str, data: dict) -> None:
        if ev_id:
            self._last_event_id = max(self._last_event_id, ev_id)
        try:
            if kind == "message":
                await self._on_message(data)
            elif kind == "press":
                await self._on_press(data)
            elif kind == "reaction":
                await self._on_reaction(data)
            elif kind == "command":
                await self._on_command(data)
        except Exception:
            logger.exception("Holler: failed to handle %s event %s", kind, ev_id)

    async def _chat(self, chat_id: str) -> dict:
        chat = self._chats.get(chat_id)
        if chat is None:
            chat = await self._http.request("GET", f"/bot/v1/chats/{chat_id}")
            self._chats[chat_id] = chat
        return chat

    async def _name(self, chat_id: str, member_id: str) -> str:
        with contextlib.suppress(Exception):
            for m in (await self._chat(chat_id)).get("members", []):
                if m.get("id") == member_id:
                    return m.get("name") or member_id
        return member_id

    async def _on_message(self, data: dict) -> None:
        chat, msg = data.get("chat") or {}, data.get("message") or {}
        chat_id, sender = str(chat.get("id") or ""), str(msg.get("sender") or "")
        # The server queues a message once more when it saw no sign of it ("redelivery": 0): the same key, so a
        # copy that did arrive is dropped here. A resend the owner asked for is numbered and is taken again.
        again = int(data.get("redelivery") or 0)
        key = f"m{msg.get('id')}" + (f":r{again}" if again > 0 else "")
        if not chat_id or sender == self.bot_id or self._dedup.is_duplicate(key):
            return
        name = await self._name(chat_id, sender)
        text = msg.get("text") or ""
        files = msg.get("attachments") or []
        if not data.get("addressed"):
            note = f" [{len(files)} attachment(s)]" if files else ""
            ctx = self._context.setdefault(chat_id, deque(maxlen=CONTEXT_MAX))
            ctx.append((time.time(), name, (text + note).strip()))
            return

        media_urls, media_types, message_type = [], [], MessageType.TEXT
        for f in files:
            try:
                blob = await self._http.request("GET", f.get("url") or f"/files/{f.get('id')}", timeout=60)
            except Exception as e:
                logger.warning("Holler: could not fetch attachment %s: %s", f.get("id"), e)
                continue
            ftype = f.get("type") or "application/octet-stream"
            if ftype.startswith("image/"):
                ext = mimetypes.guess_extension(ftype) or ".jpg"
                media_urls.append(cache_image_from_bytes(blob, ext))
                message_type = MessageType.PHOTO
            else:
                media_urls.append(cache_document_from_bytes(blob, f.get("name") or "file"))
                if message_type == MessageType.TEXT:
                    message_type = MessageType.DOCUMENT
            media_types.append(ftype)

        is_room = chat.get("kind") == "room"
        reply = msg.get("reply_to") or None
        source = self.build_source(
            chat_id=chat_id, chat_name=chat.get("title") or chat_id, chat_type="group" if is_room else "dm",
            user_id=sender, user_name=name, thread_id=ROOM_THREAD if is_room else None, message_id=str(msg.get("id")))
        event = MessageEvent(
            text=text, message_type=message_type, source=source, message_id=str(msg.get("id")),
            timestamp=datetime.datetime.fromtimestamp((msg.get("at") or time.time() * 1000) / 1000),
            media_urls=media_urls, media_types=media_types)
        if reply:
            event.reply_to_message_id = str(reply.get("id"))
            event.reply_to_text = reply.get("text") or ""
            event.reply_to_author_id = reply.get("sender")
            event.reply_to_author_name = await self._name(chat_id, reply.get("sender") or "")
            event.reply_to_is_own_message = reply.get("sender") == self.bot_id
        # What the server says this bot should know alongside the message: the tail of the thread after a new
        # conversation, cards the approvals service posted for it, what is still open (server store.turnContext).
        context = self._take_context(chat_id)
        told = str(data.get("context") or "").strip()
        if told:
            context = f"{told}\n\n{context}" if context else told
        if context:
            event.channel_context = context
        await self.handle_message(event)

    def _take_context(self, chat_id: str) -> Optional[str]:
        ctx = self._context.pop(chat_id, None)
        if not ctx:
            return None
        cutoff = time.time() - CONTEXT_MAX_AGE_S
        lines = [f"[{name}] {text}" for at, name, text in ctx if at >= cutoff and text]
        if not lines:
            return None
        return "[Earlier in this chat, not addressed to you]\n" + "\n".join(lines)

    def _source(self, chat: dict, user_id: str, user_name: str, message_id: str):
        chat_id = str(chat.get("id") or "")
        is_room = chat.get("kind") == "room"
        return self.build_source(
            chat_id=chat_id, chat_name=chat.get("title") or chat_id, chat_type="group" if is_room else "dm",
            user_id=user_id, user_name=user_name, thread_id=ROOM_THREAD if is_room else None, message_id=message_id)

    async def _on_reaction(self, data: dict) -> None:
        """The owner's tapback on one of this bot's messages. A wake (thumbs on something the bot asked, or a
        question mark) becomes a turn that quotes the message; anything else rides with his next message."""
        chat, msg, by = data.get("chat") or {}, data.get("message") or {}, data.get("by") or {}
        chat_id, emoji = str(chat.get("id") or ""), str(data.get("emoji") or "")
        if not chat_id or not emoji or not msg.get("id"):
            return
        who = by.get("name") or "The owner"
        quote = " ".join(str(msg.get("text") or "").split())
        short = quote[:240] + ("..." if len(quote) > 240 else "")
        meaning = TAPBACK_MEANING.get(emoji)
        if not data.get("wake") or not meaning:
            ctx = self._context.setdefault(chat_id, deque(maxlen=CONTEXT_MAX))
            ctx.append((time.time(), who, f'reacted {emoji} to your message: "{short}"'))
            return
        if self._dedup.is_duplicate(f"rx{msg.get('id')}:{emoji}:{int(time.time() // 60)}"):
            return
        message_id = f"rx-{msg.get('id')}-{int(time.time())}"
        event = MessageEvent(
            text=f'[{who} tapped {emoji} on your message: "{short}"]\n{meaning}',
            message_type=MessageType.TEXT, source=self._source(chat, by.get("id") or "owner", who, message_id),
            message_id=message_id, timestamp=datetime.datetime.now())
        event.reply_to_message_id = str(msg.get("id"))
        event.reply_to_text = quote[:2000]
        event.reply_to_author_id = self.bot_id
        event.reply_to_author_name = await self._name(chat_id, self.bot_id)
        event.reply_to_is_own_message = True
        context = self._take_context(chat_id)
        if context:
            event.channel_context = context
        await self.handle_message(event)

    async def _on_command(self, data: dict) -> None:
        """Stop or Start fresh from the app: a gateway slash command with no message in the thread."""
        chat, by, command = data.get("chat") or {}, data.get("by") or {}, str(data.get("command") or "")
        if not chat.get("id") or command not in COMMANDS:
            return
        message_id = f"cmd-{uuid.uuid4().hex[:12]}"
        if data.get("quiet"):
            self._quiet_ids.add(message_id)
            self._quiet_until[str(chat.get("id"))] = time.monotonic() + QUIET_WINDOW_S
        event = MessageEvent(
            text=command, message_type=MessageType.COMMAND,
            source=self._source(chat, by.get("id") or "owner", by.get("name") or "The owner", message_id),
            message_id=message_id, timestamp=datetime.datetime.now())
        await self.handle_message(event)

    # ── turn receipts ────────────────────────────────────────────────────────
    # The app shows "Delivered" until the bot picks a message up. These hooks tell the server exactly when a
    # turn for one of the owner's messages started and how it ended, so a turn that failed says so in the thread.

    def _receipt(self, event: MessageEvent, state: str) -> None:
        message_id = str(getattr(event, "message_id", "") or "")
        if not self._http or not message_id.isdigit():
            return

        async def post():
            with contextlib.suppress(Exception):
                await self._http.request("POST", "/bot/v1/receipt", {"message_id": int(message_id), "state": state}, timeout=5)
        task = asyncio.create_task(post())
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def on_processing_start(self, event: MessageEvent) -> None:
        self._receipt(event, "working")

    async def on_processing_complete(self, event: MessageEvent, outcome: ProcessingOutcome) -> None:
        self._receipt(event, RECEIPT_STATE.get(outcome, "done"))

    async def _on_press(self, data: dict) -> None:
        chat_id, message_id, value = str(data.get("chat_id")), str(data.get("message_id")), str(data.get("data") or "")
        kind, _, rest = value.partition(":")
        if kind == "ea":
            choice, _, approval_id = rest.partition(":")
            session_key = self._approvals.pop(approval_id, None)
            count = 0
            if session_key:
                try:
                    from tools.approval import resolve_gateway_approval
                    count = resolve_gateway_approval(session_key, choice)
                except Exception:
                    logger.exception("Holler: resolve_gateway_approval failed")
            if count:
                await self._patch(message_id, {"resolved": {"label": APPROVAL_LABELS.get(choice, "Answered")}})
            else:
                await self._patch(message_id, {"resolved": {"label": "Expired, nothing ran", "by": None}})
            if count:
                self.resume_typing_for_chat(chat_id)
        elif kind == "cl":
            clarify_id, _, idx = rest.rpartition(":")
            choices = self._clarify.get(clarify_id) or []
            try:
                if idx == "other":
                    from tools.clarify_gateway import mark_awaiting_text
                    mark_awaiting_text(clarify_id)
                    await self._patch(message_id, {"resolved": {"label": "Type your answer", "by": None}})
                    return
                answer = choices[int(idx)]
                from tools.clarify_gateway import resolve_gateway_clarify
                ok = resolve_gateway_clarify(clarify_id, answer)
                self._clarify.pop(clarify_id, None)
                await self._patch(message_id, {"resolved": {"label": answer} if ok else {"label": "Expired", "by": None}})
            except Exception:
                logger.exception("Holler: clarify press failed")

    # ── outbound ─────────────────────────────────────────────────────────────

    async def _post(self, body: dict, attempts: int = 3) -> SendResult:
        body = {**body, "client_id": body.get("client_id") or uuid.uuid4().hex}
        delay = 1.0
        for attempt in range(attempts):
            try:
                res = await self._http.request("POST", "/bot/v1/messages", body)
                return SendResult(success=True, message_id=str(res.get("id")), raw_response=res)
            except _HttpError as e:
                if e.status < 500:
                    return SendResult(success=False, error=str(e))
                err = str(e)
            except Exception as e:
                err = f"{type(e).__name__}: {e}"
            if attempt + 1 < attempts:
                await asyncio.sleep(delay)
                delay *= 2
        return SendResult(success=False, error=err, retryable=True)

    async def _patch(self, message_id: str, body: dict) -> SendResult:
        try:
            await self._http.request("PATCH", f"/bot/v1/messages/{int(message_id)}", body)
            return SendResult(success=True, message_id=str(message_id))
        except Exception as e:
            return SendResult(success=False, error=str(e))

    @staticmethod
    def _reply_id(chat_id: str, reply_to: Optional[str]) -> Optional[int]:
        # Quote replies only in the room, where several people talk; DMs read like iMessage.
        if chat_id == "room" and reply_to and str(reply_to).isdigit():
            return int(reply_to)
        return None

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[dict[str, Any]] = None) -> SendResult:
        if not self._http:
            return SendResult(success=False, error="Not connected")
        if not (content or "").strip():
            return SendResult(success=True, message_id=None)
        if self._is_noise(chat_id, content, reply_to):
            return SendResult(success=True, message_id=None)
        return await self._post({"chat_id": chat_id, "text": content[: self.MAX_MESSAGE_LENGTH],
                                 "reply_to": self._reply_id(chat_id, reply_to)})

    def _is_noise(self, chat_id: str, content: str, reply_to: Optional[str]) -> bool:
        """Gateway notices that never reach the thread: the busy acknowledgement, and the banner of a quiet /new."""
        text = content.lstrip()
        if text.startswith(BUSY_NOTICES):
            return True
        if reply_to and str(reply_to) in self._quiet_ids:
            self._quiet_ids.discard(str(reply_to))
            return True
        if text.startswith(RESET_NOTICES) and time.monotonic() < self._quiet_until.get(str(chat_id), 0):
            self._quiet_until.pop(str(chat_id), None)
            return True
        return False

    async def edit_message(self, chat_id: str, message_id: str, content: str, *, finalize: bool = False) -> SendResult:
        if not str(message_id or "").isdigit():
            return SendResult(success=False, error="unknown message")
        return await self._patch(message_id, {"text": content[: self.MAX_MESSAGE_LENGTH]})

    async def delete_message(self, chat_id: str, message_id: str) -> bool:
        if not str(message_id or "").isdigit():
            return False
        try:
            await self._http.request("DELETE", f"/bot/v1/messages/{int(message_id)}")
            return True
        except Exception:
            return False

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        if not self._http:
            return
        status = (getattr(self, "_status_text", None) or {}).get(str(chat_id))
        last = self._typing_sent.get(chat_id)
        now = time.monotonic()
        if last and last[1] == status and now - last[0] < 4.0:
            return
        self._typing_sent[chat_id] = (now, status)
        with contextlib.suppress(Exception):
            await self._http.request("POST", "/bot/v1/typing", {"chat_id": chat_id, "on": True, "status": status}, timeout=5)

    async def stop_typing(self, chat_id: str) -> None:
        self._typing_sent.pop(chat_id, None)
        if self._http:
            with contextlib.suppress(Exception):
                await self._http.request("POST", "/bot/v1/typing", {"chat_id": chat_id, "on": False}, timeout=5)

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        try:
            chat = await self._chat(chat_id)
            return {"name": chat.get("title") or chat_id, "type": "group" if chat.get("kind") == "room" else "dm", "chat_id": chat_id}
        except Exception:
            return {"name": chat_id, "type": "group" if chat_id == "room" else "dm", "chat_id": chat_id}

    async def _upload(self, path: str, name: Optional[str] = None) -> dict:
        with open(path, "rb") as fh:
            data = fh.read(MAX_FETCH_BYTES + 1)
        if len(data) > MAX_FETCH_BYTES:
            raise ValueError("file too large for Holler (25 MB)")
        ftype = mimetypes.guess_type(name or path)[0] or "application/octet-stream"
        res = await self._http.request("POST", "/bot/v1/files", raw=data, content_type=ftype,
                                       extra_headers={"X-File-Name": (name or os.path.basename(path)).encode("ascii", "replace").decode()}, timeout=60)
        return res["file"]

    async def _send_file(self, chat_id: str, path: str, caption: Optional[str], name: Optional[str], reply_to) -> SendResult:
        try:
            f = await self._upload(path, name)
        except Exception as e:
            logger.warning("Holler: upload failed: %s", e)
            return await self.send(chat_id, f"{caption or ''}\n(Could not attach {os.path.basename(path)}: {e})".strip())
        return await self._post({"chat_id": chat_id, "text": caption or "", "attachments": [f["id"]],
                                 "reply_to": self._reply_id(chat_id, reply_to)})

    async def send_image_file(self, chat_id: str, image_path: str, caption: Optional[str] = None,
                              reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_file(chat_id, image_path, caption, None, reply_to)

    async def send_document(self, chat_id: str, file_path: str, caption: Optional[str] = None,
                            file_name: Optional[str] = None, reply_to: Optional[str] = None,
                            metadata: Optional[dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_file(chat_id, file_path, caption, file_name, reply_to)

    async def send_voice(self, chat_id: str, audio_path: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_file(chat_id, audio_path, caption, None, reply_to)

    async def send_video(self, chat_id: str, video_path: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_file(chat_id, video_path, caption, None, reply_to)

    async def send_image(self, chat_id: str, image_url: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None) -> SendResult:
        # Remote images stay links: the server never fetches arbitrary URLs.
        text = f"{caption}\n{image_url}" if caption else image_url
        return await self.send(chat_id, text, reply_to=reply_to, metadata=metadata)

    # ── buttons ──────────────────────────────────────────────────────────────

    async def _send_exec_approval_prompt(self, prompt: ExecApprovalPrompt) -> SendResult:
        approval_id = str(next(self._approval_ids))
        self._approvals[approval_id] = prompt.session_key
        buttons = [{"label": label, "data": f"ea:{choice}:{approval_id}", "style": style or ""}
                   for label, choice, style in prompt.actions]
        rows = [buttons[i:i + 2] for i in range(0, len(buttons), 2)]
        return await self._post({"chat_id": prompt.chat_id, "text": prompt.text, "buttons": rows})

    async def send_slash_confirm(self, chat_id: str, title: str, message: str, session_key: str, confirm_id: str,
                                 metadata: Optional[dict[str, Any]] = None) -> SendResult:
        """The gateway asks before /new ("Confirm /new: Approve Once, Always Approve, Cancel"). A new
        conversation sent from the app was already confirmed there (Start fresh takes two taps; the nightly one is
        The owner's standing choice), so it is approved once here and no prompt lands in the thread. A /new he
        types himself still gets the gateway's own prompt."""
        if time.monotonic() >= self._quiet_until.get(str(chat_id), 0):
            return SendResult(success=False, error="Not supported")

        async def approve():
            try:
                from tools import slash_confirm
                await slash_confirm.resolve(session_key, confirm_id, "once")
            except Exception:
                logger.exception("Holler: could not confirm the new conversation for %s", chat_id)
        task = asyncio.create_task(approve())
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        return SendResult(success=True, message_id=None)

    async def send_clarify(self, chat_id: str, question: str, choices: Optional[list], clarify_id: str,
                           session_key: str, metadata: Optional[dict[str, Any]] = None) -> SendResult:
        if not choices:
            return await self.send(chat_id, question, metadata=metadata)
        self._clarify[clarify_id] = [str(c) for c in choices]
        rows = [[{"label": str(c)[:64], "data": f"cl:{clarify_id}:{i}", "style": ""}] for i, c in enumerate(choices[:5])]
        rows.append([{"label": "Something else", "data": f"cl:{clarify_id}:other", "style": ""}])
        return await self._post({"chat_id": chat_id, "text": question, "buttons": rows})


# ── plugin registration ──────────────────────────────────────────────────────

def check_requirements() -> bool:
    return bool(_get_scoped_secret("HOLLER_BOT_TOKEN", "") and _get_scoped_secret("HOLLER_BOT_ID", ""))


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    return bool((_get_scoped_secret("HOLLER_BOT_TOKEN") or extra.get("token")) and _env("HOLLER_BOT_ID", extra, "bot_id"))


def is_connected(config) -> bool:
    return validate_config(config)


def _env_enablement() -> dict | None:
    token = _get_scoped_secret("HOLLER_BOT_TOKEN", "").strip()
    bot_id = _get_scoped_secret("HOLLER_BOT_ID", "").strip()
    if not (token and bot_id):
        return None
    home = _get_scoped_secret("HOLLER_HOME_CHANNEL", "").strip() or "room"
    return {"bot_id": bot_id, "url": _get_scoped_secret("HOLLER_URL", "").strip() or "http://127.0.0.1:8802",
            "home_channel": {"chat_id": home, "name": "Team room" if home == "room" else home}}


async def _standalone_send(pconfig, chat_id: str, message: str, *, thread_id: Optional[str] = None,
                           media_files: Optional[list[str]] = None, force_document: bool = False) -> dict[str, Any]:
    """Out-of-process delivery (cron outside the gateway): one HTTP post with the profile's token."""
    extra = getattr(pconfig, "extra", {}) or {}
    token = _get_scoped_secret("HOLLER_BOT_TOKEN") or extra.get("token") or ""
    if not token:
        return {"error": "HOLLER_BOT_TOKEN is not set"}
    try:
        http = _LocalHttp(_env("HOLLER_URL", extra, "url", "http://127.0.0.1:8802"), token)
        res = await http.request("POST", "/bot/v1/messages", {
            "chat_id": chat_id or _get_scoped_secret("HOLLER_HOME_CHANNEL", "room") or "room",
            "text": message, "client_id": uuid.uuid4().hex})
        return {"success": True, "message_id": str(res.get("id"))}
    except Exception as e:
        return {"error": f"Holler send failed: {e}"}


def register(ctx):
    ctx.register_platform(
        name=PLATFORM,
        label="Vesper",
        adapter_factory=HollerAdapter,
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["HOLLER_BOT_TOKEN", "HOLLER_BOT_ID"],
        install_hint="No extra packages needed (stdlib only)",
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="HOLLER_HOME_CHANNEL",
        standalone_sender_fn=_standalone_send,
        allowed_users_env="HOLLER_ALLOWED_USERS",
        max_message_length=16000,
        emoji="💬",
        pii_safe=True,
        display_tier="low",
        platform_hint=(
            "You are chatting in Vesper, your owner's private team chat app (it looks like iMessage). "
            "Write like a sharp coworker texting: short, plain, direct. Light Markdown renders "
            "(bold, italics, lists, links, code). In the team room the owner and all your teammate bots "
            "see every message; you are only woken when someone names you, @mentions you or replies to "
            "you. To hand a teammate something, start with their name or @mention them. Lines under "
            "'[Earlier in this chat, not addressed to you]' are context, not requests to you. The owner "
            "can answer with a tapback: a line like '[<name> tapped 👍 on your message: ...]' is their "
            "answer to that message, so act on it instead of asking again, and a line saying they "
            "'reacted' to a message is only for your information."))
