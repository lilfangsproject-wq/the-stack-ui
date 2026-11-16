#!/usr/bin/env python3
"""Phone smoke for The Stack — mocked GitHub, no PAT. Exit 1 on failure."""
import asyncio, base64, json, os, threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
UI = Path(os.environ.get("STACK_UI_ROOT", ROOT))
_HUB_CANDIDATES = [
    Path(os.environ["STACK_HUB_ROOT"]) if os.environ.get("STACK_HUB_ROOT") else None,
    Path("/agent/repos/ai-workspace/Projects/The-Stack/hub"),
    Path("/Users/seef/Documents/Codex/2026-10-27/h/outputs/AI Workspace/Projects/The-Stack/hub"),
]
HUB = next((p for p in _HUB_CANDIDATES if p and p.is_dir()), ROOT / "hub")
OUT = Path(os.environ.get("STACK_SMOKE_OUT", "/tmp/stack-premium"))
OUT.mkdir(parents=True, exist_ok=True)

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(UI), **k)
    def log_message(self, *a):
        pass

def b64(p: Path):
    return base64.b64encode(p.read_bytes()).decode()

async def gh(route):
    u = route.request.url
    hdr = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "content-type": "application/json"}
    if route.request.method == "OPTIONS":
        return await route.fulfill(status=204, headers=hdr)
    if u.rstrip("/").endswith("/zen"):
        return await route.fulfill(status=200, body="ok", headers={**hdr, "content-type": "text/plain"})
    if u.endswith("/pulls") or "/commits?" in u or u.endswith("/commits"):
        return await route.fulfill(status=200, headers=hdr, body="[]")
    if "/contents/" in u:
        if route.request.method == "PUT":
            return await route.fulfill(status=200, headers=hdr, body="{}")
        marker = "/contents/Projects/The-Stack/hub/"
        if marker in u:
            rel = u.split(marker, 1)[1].split("?", 1)[0]
            p = HUB / rel
            if p.is_file():
                return await route.fulfill(
                    status=200,
                    headers=hdr,
                    body=json.dumps({"sha": "x", "content": b64(p), "encoding": "base64"}),
                )
            return await route.fulfill(status=404, headers=hdr, body='{"message":"Not Found"}')
        return await route.fulfill(status=404, headers=hdr, body='{"message":"Not Found"}')
    return await route.fulfill(status=200, headers=hdr, body="{}")

async def main():
    httpd = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=2,
            service_workers="block",
            color_scheme="dark",
        )
        await ctx.route("https://api.github.com/**", gh)
        page = await ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))

        def on_console(m):
            if m.type != "error":
                return
            t = m.text or ""
            if "Failed to load resource" in t or "404" in t or "net::ERR_" in t:
                return
            errors.append(f"console:{t}")

        page.on("console", on_console)
        base = "http://127.0.0.1:8765/index.html?cloud=1"
        await page.goto(base)
        await page.wait_for_selector("#cloud-connect", timeout=4000)
        boot_txt = await page.locator("#boot-status").inner_text()
        if "Connecting" in boot_txt:
            errors.append("boot still says Connecting with no token")
        if await page.locator("#tabbar svg.tab-ico").count() != 4:
            errors.append("tab bar is missing the four icons")
        await page.evaluate(
            """() => {
              localStorage.setItem('stack-github-hub-v1', JSON.stringify({token:'ghp_mock',repo:'lilfangsproject-wq/ai-workspace',branch:'main'}));
              localStorage.setItem('stack-look-v2', 'iris');
            }"""
        )
        await page.goto(base)
        await page.wait_for_timeout(3500)
        shell = await page.locator("#shell:not(.hidden)").count()
        home = await page.locator("#home-pane:not(.hidden)").count()
        order = await page.evaluate(
            """() => {
              const ids = [...document.querySelectorAll('#home-body [id]')].map((n) => n.id);
              const needs = ids.indexOf('cc-needs');
              const roster = ids.indexOf('cc-roster');
              const hosts = ids.indexOf('cc-hosts');
              return { needs, roster, hosts, running: ids.indexOf('cc-running'), latest: ids.indexOf('cc-latest') };
            }"""
        )
        if not (order["needs"] >= 0 and order["roster"] > order["needs"]):
            errors.append(f"home order wrong: {order}")
        if order["running"] >= 0 or order["latest"] >= 0:
            errors.append("home still splits Running and Latest")
        if order["hosts"] >= 0 and order["hosts"] < order["roster"]:
            errors.append("computers still sit above the agent roster")
        wash = await page.evaluate("() => getComputedStyle(document.body).backgroundImage")
        if wash.count("radial-gradient") != 1:
            errors.append(f"expected one page wash, got {wash.count('radial-gradient')}")
        await page.screenshot(path=str(OUT / "v31.7-home.png"))
        back_ok = True
        sheet = False
        agent = page.locator(".agent-line[data-open-agent]").first
        if await agent.count():
            await agent.click()
            await page.wait_for_timeout(1000)
            sheet = await page.evaluate("document.getElementById('chat-pane')?.classList.contains('sheet-open')")
            await page.screenshot(path=str(OUT / "v31.7-chat-from-home.png"))
            await page.locator("#chat-back").click()
            await page.wait_for_timeout(600)
            back_ok = await page.evaluate("!document.getElementById('home-pane')?.classList.contains('hidden')")
            await page.screenshot(path=str(OUT / "v31.7-back-home.png"))
        await page.locator(".tabbar [data-tab='chats']").click()
        await page.wait_for_timeout(800)
        inbox = await page.locator("#chats-pane:not(.hidden) .chat-inbox-row").count()
        await page.screenshot(path=str(OUT / "v31.7-chats-inbox.png"))
        # Composer controls aligned (heights) when a chat is open
        if inbox:
            await page.locator(".chat-inbox-row").first.click()
            await page.wait_for_timeout(900)
            heights = await page.evaluate(
                """() => {
                  const a = document.querySelector('#chat-pane .attach-btn');
                  const t = document.querySelector('#chat-pane textarea');
                  const s = document.querySelector('#chat-pane button[type=submit]');
                  return a && t && s ? [a.getBoundingClientRect().height, t.getBoundingClientRect().height, s.getBoundingClientRect().height] : null;
                }"""
            )
            await page.screenshot(path=str(OUT / "v31.7-composer.png"))
        else:
            heights = None

        # v31.7: tabs must work while a chat sheet is open
        tabs_from_sheet = None
        await page.locator(".tabbar [data-tab='chats']").click()
        await page.wait_for_timeout(500)
        if await page.locator("#chats-pane:not(.hidden) .chat-inbox-row").count():
            await page.locator(".chat-inbox-row").first.click()
            await page.wait_for_timeout(700)
            sheet_open = await page.evaluate(
                "() => !!document.getElementById('chat-pane')?.classList.contains('sheet-open')"
            )
            tab_live = await page.evaluate(
                """() => {
                  const tab = document.getElementById('tabbar');
                  const cs = getComputedStyle(tab);
                  const btn = tab.querySelector('button[data-tab="agents"]');
                  const r = btn.getBoundingClientRect();
                  return {
                    opacity: cs.opacity,
                    pointerEvents: cs.pointerEvents,
                    inView: r.top < window.innerHeight && r.bottom > 0 && r.width > 0,
                  };
                }"""
            )
            await page.locator(".tabbar [data-tab='agents']").click()
            await page.wait_for_timeout(700)
            landed = await page.evaluate(
                """() => ({
                  agents: !document.getElementById('agents-pane')?.classList.contains('hidden'),
                  sheet: !!document.getElementById('chat-pane')?.classList.contains('sheet-open'),
                  active: document.querySelector('#tabbar button.active')?.dataset.tab || null,
                })"""
            )
            await page.screenshot(path=str(OUT / "v31.7-tab-from-sheet.png"))
            tabs_from_sheet = {"sheet_was_open": sheet_open, "tab": tab_live, "landed": landed}
            if not sheet_open:
                errors.append("expected chat sheet open before tab tap")
            if tab_live.get("opacity") in ("0", 0) or tab_live.get("pointerEvents") == "none" or not tab_live.get("inView"):
                errors.append(f"tab bar inert while sheet open: {tab_live}")
            if not landed.get("agents") or landed.get("active") != "agents":
                errors.append(f"Agents tab from open chat failed: {landed}")

        await browser.close()
    httpd.shutdown()
    report = {
        "shell": bool(shell),
        "home": bool(home),
        "sheet_from_home": bool(sheet),
        "back_to_home": back_ok,
        "inbox_rows": inbox,
        "composer_heights": heights,
        "tabs_from_sheet": tabs_from_sheet,
        "js_errors": errors[:8],
    }
    print(json.dumps(report, indent=2))
    (OUT / "smoke-report.json").write_text(json.dumps(report, indent=2))
    if not shell or not home:
        raise SystemExit("boot failed")
    if errors:
        raise SystemExit("js errors: " + " | ".join(errors[:3]))
    if not back_ok:
        raise SystemExit("Back from Home-opened chat did not return to Home")
    if heights and max(heights) - min(heights) > 6:
        raise SystemExit(f"composer control heights uneven: {heights}")
    if tabs_from_sheet is None:
        print("WARN: skipped tabs_from_sheet (no inbox rows)")
    print("SMOKE PASSED")

asyncio.run(main())
