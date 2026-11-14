"""End-to-end check of the Hermes plugin against a throwaway Holler server, outside the live gateway.

Run inside Hermes's own Python (so the gateway modules import exactly as in production):
  HERMES_HOME=$(mktemp -d) ~/.hermes/hermes-agent/.hermes/bin/hermes --run-module cProfile -o /dev/null test/plugin_selftest.py
"""

import asyncio
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import shutil
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get("VESPER_NODE") or shutil.which("node") or "node"
PORT = 8891
TOKEN = "selftest-ben-token-0123456789abcdef"
sys.path.insert(0, str(ROOT / "hermes-plugin"))

from gateway.config import PlatformConfig  # noqa: E402
from gateway.platform_registry import PlatformEntry, platform_registry  # noqa: E402
from gateway.platforms.base import ExecApprovalPrompt  # noqa: E402
from holler.adapter import HollerAdapter, register  # noqa: E402


class FakePluginContext:
    """Registers the platform the way hermes_cli.plugins does (unknown kwargs raise TypeError)."""

    def register_platform(self, name, label, adapter_factory, check_fn, validate_config=None,
                          required_env=None, install_hint="", **entry_kwargs):
        entry_kwargs.setdefault("plugin_name", "holler-platform")
        platform_registry.register(PlatformEntry(
            name=name, label=label, adapter_factory=adapter_factory, check_fn=check_fn,
            validate_config=validate_config, required_env=required_env or [], install_hint=install_hint,
            source="plugin", **entry_kwargs))


register(FakePluginContext())
failures = []


def check(cond, what):
    print(("ok   " if cond else "FAIL ") + what)
    if not cond:
        failures.append(what)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def http(method, path, body=None, cookie=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    req.add_header("content-type", "application/json")
    if cookie:
        req.add_header("cookie", cookie)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read() or b"null")


async def wait_for(pred, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        await asyncio.sleep(0.05)
    return False


async def main(tmp: Path):
    env = {**os.environ, "HOLLER_HOME": str(tmp / "home"), "HOLLER_CONFIG": str(tmp / "config.json")}
    (tmp / "config.json").write_text(json.dumps({"port": PORT, "hosts": ["127.0.0.1"],
                                                 "botTokens": {"ben": hashlib.sha256(TOKEN.encode()).hexdigest()}}))
    server = subprocess.Popen([NODE, "--no-warnings", str(ROOT / "server/main.mjs")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        link = subprocess.run([NODE, "--no-warnings", str(ROOT / "server/main.mjs"), "--login-link"], env=env, capture_output=True, text=True).stdout.strip()
        token = link.split("t=")[1]
        with urllib.request.build_opener(NoRedirect).open(f"http://127.0.0.1:{PORT}/login?t={token}", timeout=5) as r:
            cookie = r.headers["set-cookie"].split(";")[0]

        events = []
        adapter = HollerAdapter(PlatformConfig(enabled=True, extra={"url": f"http://127.0.0.1:{PORT}", "bot_id": "ben", "token": TOKEN}))
        adapter._acquire_platform_lock = lambda *a, **k: True
        adapter._release_platform_lock = lambda *a, **k: None

        async def capture(event):
            events.append(event)
        adapter.handle_message = capture

        check(await adapter.connect(), "adapter connects")
        check(http("GET", "/health")["bots"]["ben"] is True, "server sees ben online")

        http("POST", "/api/chats/dm-ben/messages", {"text": "Ben, how are the Acme leads?", "client_id": "t1"}, cookie)
        check(await wait_for(lambda: len(events) == 1), "DM reaches the adapter")
        e = events[-1]
        check(e.text == "Ben, how are the Acme leads?" and e.source.chat_type == "dm" and e.source.user_id == "alex"
              and e.source.user_name == "Alex", "DM event has text, dm chat type and sender")

        http("POST", "/api/chats/room/messages", {"text": "what is on today?", "client_id": "t2"}, cookie)
        await asyncio.sleep(0.5)
        check(len(events) == 1, "unaddressed room message does not wake ben")
        http("POST", "/api/chats/room/messages", {"text": "Ben, check Acme please", "client_id": "t3"}, cookie)
        check(await wait_for(lambda: len(events) == 2), "addressed room message wakes ben")
        e = events[-1]
        check(e.source.chat_type == "group" and e.source.thread_id == "holler-room", "room event is a shared group thread")
        check("[Alex] what is on today?" in (e.channel_context or ""), "room context rides along")

        r = await adapter.send("dm-ben", "Six new leads. **Two** booked.")
        check(r.success and r.message_id, "send works")
        msgs = http("GET", "/api/chats/dm-ben/messages", cookie=cookie)["messages"]
        check(msgs[-1]["text"] == "Six new leads. **Two** booked." and msgs[-1]["sender"] == "ben", "reply is stored as ben")

        await adapter.send_typing("dm-ben")
        adapter.set_status_text("dm-ben", "Reading HQ clients")
        await adapter.send_typing("dm-ben")
        await adapter.stop_typing("dm-ben")
        check(True, "typing and status calls do not raise")

        r = await adapter.edit_message("dm-ben", r.message_id, "Six new leads. Two booked, one callback.")
        check(r.success, "edit works")

        prompt = ExecApprovalPrompt(chat_id="dm-ben", session_key="selftest-session", text="Run `rm -rf build`?",
                                    actions=[("Approve once", "once", "primary"), ("Deny", "deny", "danger")],
                                    command="rm -rf build", description="test", smart_denied=False)
        r = await adapter._send_exec_approval_prompt(prompt)
        check(r.success, "approval card posts")
        card = http("GET", "/api/chats/dm-ben/messages", cookie=cookie)["messages"][-1]
        check(card["kind"] == "card" and card["buttons"][0][0]["data"].startswith("ea:once:"), "card has approval buttons")
        http("POST", f"/api/messages/{card['id']}/press", {"data": card["buttons"][0][0]["data"]}, cookie)

        def resolved_label():
            m = [x for x in http("GET", "/api/chats/dm-ben/messages", cookie=cookie)["messages"] if x["id"] == card["id"]][0]
            return (m.get("resolved") or {}).get("label")
        check(await wait_for(lambda: resolved_label() == "Expired, nothing ran"), "press reaches the adapter (no pending approval, so it reports expired)")

        png = tmp / "dot.png"
        png.write_bytes(bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                                      "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"))
        r = await adapter.send_image_file("dm-ben", str(png), caption="chart")
        check(r.success, "image upload and send")
        last = http("GET", "/api/chats/dm-ben/messages", cookie=cookie)["messages"][-1]
        check(last["attachments"] and last["attachments"][0]["type"] == "image/png", "attachment is an image")

        http("POST", "/api/chats/dm-ben/messages", {"text": "here", "attachments": [last["attachments"][0]["id"]], "client_id": "t4"}, cookie)
        check(await wait_for(lambda: len(events) == 3), "photo from Alex reaches the adapter")
        check(events[-1].media_urls and os.path.exists(events[-1].media_urls[0]), "photo is cached locally for the model")

        # 11-09: tapbacks, Stop, the safety resend and turn receipts.
        q = await adapter.send("dm-ben", "Pat asked for Thursday instead. Want me to move it?")
        n = len(events)
        http("POST", f"/api/messages/{q.message_id}/react", {"emoji": "\U0001F44D"}, cookie)
        check(await wait_for(lambda: len(events) == n + 1), "a thumbs up on a question wakes the bot")
        e = events[-1]
        check("tapped \U0001F44D on your message" in e.text and "That is his yes" in e.text and e.reply_to_text.startswith("Pat asked for Thursday")
              and e.reply_to_is_own_message and not str(e.message_id).isdigit(), "the wake quotes the message and says what the tapback means")
        note = await adapter.send("dm-ben", "Report sent to Hal.")
        http("POST", f"/api/messages/{note.message_id}/react", {"emoji": "\u2764\ufe0f"}, cookie)
        await asyncio.sleep(0.4)
        check(len(events) == n + 1, "a heart on a plain message wakes nobody")
        http("POST", "/api/chats/dm-ben/messages", {"text": "and the Birch numbers?", "client_id": "t6"}, cookie)
        check(await wait_for(lambda: len(events) == n + 2), "his next message arrives")
        check("reacted \u2764\ufe0f to your message" in (events[-1].channel_context or ""), "the heart rides along as context")

        n = len(events)
        http("POST", "/api/chats/dm-ben/command", {"command": "stop"}, cookie)
        check(await wait_for(lambda: len(events) == n + 1), "Stop reaches the adapter")
        e = events[-1]
        check(e.text == "/stop" and e.is_command() and e.get_command() == "stop" and e.source.chat_id == "dm-ben", "it is a gateway /stop for that chat")
        msgs = http("GET", "/api/chats/dm-ben/messages", cookie=cookie)["messages"]
        check(not any(m["text"] == "/stop" for m in msgs), "and leaves no bubble in the thread")

        first = [m for m in msgs if m["text"] == "and the Birch numbers?"][0]
        chat = {"id": "dm-ben", "kind": "dm", "title": "Ben"}
        n = len(events)
        await adapter._on_message({"chat": chat, "message": first, "addressed": True, "redelivery": 0})
        check(len(events) == n, "the server's safety resend of a message the bot has is dropped")
        await adapter._on_message({"chat": chat, "message": first, "addressed": True, "redelivery": 1})
        check(len(events) == n + 1, "a resend Alex asked for is taken again")
        await adapter._on_message({"chat": chat, "message": first, "addressed": True, "redelivery": 1})
        check(len(events) == n + 1, "but only once")

        from gateway.platforms.event import ProcessingOutcome
        await adapter.on_processing_start(events[-1])
        await adapter.on_processing_complete(events[-1], ProcessingOutcome.FAILURE)

        def flagged():
            m = [x for x in http("GET", "/api/chats/dm-ben/messages", cookie=cookie)["messages"] if x["id"] == first["id"]][0]
            return (m.get("delivery") or {}).get("state")
        check(await wait_for(lambda: flagged() == "failed"), "a turn that failed is marked on his message")
        await adapter.on_processing_complete(events[-1], ProcessingOutcome.SUCCESS)
        check(await wait_for(lambda: flagged() is None), "and a turn that finished clears it")
        await adapter.on_processing_start(events[n - 1])  # the /stop event: no message of his, so nothing is posted
        check(True, "receipts for commands and tapbacks are skipped without error")

        # A new conversation (Start fresh, or the nightly one): no banner in the thread, and his next message
        # carries what the server says the bot should know.
        before = len(http("GET", "/api/chats/dm-ben/messages", cookie=cookie)["messages"])
        n = len(events)
        http("POST", "/api/chats/dm-ben/command", {"command": "fresh"}, cookie)
        check(await wait_for(lambda: len(events) == n + 1), "Start fresh reaches the adapter")
        cmd = events[-1]
        check(cmd.text == "/new" and cmd.get_command() == "new" and cmd.source.thread_id is None, "as a gateway /new for the bot's one conversation")
        # The gateway asks "Confirm /new" first: for one sent from the app the adapter approves it, with no prompt.
        from tools import slash_confirm
        chose = []

        async def on_confirm(choice):
            chose.append(choice)
            return "\u2728 Session reset! Starting fresh."
        slash_confirm.register("selftest-key", "7", "new", on_confirm)
        r = await adapter.send_slash_confirm("dm-ben", "/new", "This starts a fresh session", "selftest-key", "7")
        check(r.success and await wait_for(lambda: chose == ["once"]), "the gateway's Confirm /new is approved once, silently")
        slash_confirm.register("selftest-key", "8", "new", on_confirm)
        r = await adapter.send_slash_confirm("dm-eli", "/new", "This starts a fresh session", "selftest-key", "8")
        check(not r.success and chose == ["once"], "a /new typed by hand in another chat still gets the gateway's own prompt")
        slash_confirm.clear("selftest-key")
        r = await adapter.send("dm-ben", "\u2728 Session reset! Starting fresh.\nModel: test", reply_to=cmd.message_id)
        check(r.success and r.message_id is None, "the gateway's banner is swallowed")
        r = await adapter.send("dm-ben", "\u21aa Redirected current run. I'll adjust using your correction.\n\n\U0001F4A1 First-time tip")
        check(r.success and r.message_id is None, "and so is the busy acknowledgement")
        check(len(http("GET", "/api/chats/dm-ben/messages", cookie=cookie)["messages"]) == before, "nothing landed in the thread")
        r = await adapter.send("dm-ben", "Real reply after the reset.")
        check(r.success and r.message_id, "a real reply still goes out")
        http("POST", "/api/chats/dm-ben/messages", {"text": "yes", "client_id": "t7"}, cookie)
        check(await wait_for(lambda: len(events) == n + 2), "his next message arrives")
        check(events[-1].source.thread_id is None, "in the same conversation key, so routine posts keep being mirrored into it")

        # Server restart: the adapter reconnects on its own and picks up where it left off.
        server.terminate(); server.wait(5)
        server = subprocess.Popen([NODE, "--no-warnings", str(ROOT / "server/main.mjs")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        await asyncio.sleep(1.0)
        check(await wait_for(lambda: http_ok("/health"), 10), "server back up")
        check(await wait_for(lambda: http("GET", "/health")["bots"]["ben"] is True, 20), "adapter reconnected after restart")
        n = len(events)
        http("POST", "/api/chats/dm-ben/messages", {"text": "still there?", "client_id": "t5"}, cookie)
        check(await wait_for(lambda: len(events) == n + 1 and events[-1].text == "still there?", 5), "messages flow after reconnect, no duplicates")

        await adapter.disconnect()
    finally:
        server.terminate()
        try:
            server.wait(5)
        except Exception:
            server.kill()


def http_ok(path):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=1)
        return True
    except Exception:
        return False


with tempfile.TemporaryDirectory(prefix="holler-plugin-") as d:
    asyncio.run(main(Path(d)))
print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
