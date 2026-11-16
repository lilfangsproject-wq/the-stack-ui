#!/usr/bin/env node
/** Static premium gate — run before shipping a Stack UI shell. Exit 1 on fail. */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("OK:", m);

const app = read("app.js");
const css = read("style.css");
const html = read("index.html");
const sw = read("sw.js");

const ver = app.match(/const STACK_VERSION = "([^"]+)"/)?.[1];
if (!ver) fail("STACK_VERSION missing");
else ok(`version ${ver}`);

if (!sw.includes(`the-stack-shell-${ver}`)) fail(`sw.js CACHE must match ${ver}`);
else ok("sw cache matches version");

if (!html.includes(`data-stack-version>${ver}<`) && !html.includes(`>${ver}</span>`)) {
  // spans filled by JS; still require version string present for boot card defaults
  if (!html.includes(ver)) fail(`index.html should mention ${ver}`);
  else ok("index mentions version");
} else ok("index version spans");

try {
  execSync(`node --check "${path.join(root, "app.js")}"`, { stdio: "pipe" });
  ok("app.js syntax");
} catch {
  fail("app.js syntax error");
}

// No hardcoded near-black sheet bg (breaks Look themes)
if (/#chat-pane\s*\{[^}]*background:\s*#0b0c0e/s.test(css)) {
  fail("#chat-pane must use var(--bg), not #0b0c0e");
} else ok("chat sheet uses theme background");

// Pull-to-dismiss must not arm from the message list
if (app.includes("box.scrollTop <= 1") && app.includes("atTop")) {
  fail("pull-to-dismiss still arms from message list top (scroll fight)");
} else ok("pull-to-dismiss scoped to grabber/header");

if (!app.includes("rememberChatReturn")) fail("missing rememberChatReturn");
else ok("chat return tracking present");

if (!app.includes("function closeChatSheet")) fail("missing closeChatSheet");
else ok("closeChatSheet present");

// Home must not wire section heads as fake Agents/channel jumps
if (/cc-head home-tap" data-goto-agents/.test(app) || /cc-head home-tap" data-open-channel/.test(app)) {
  fail("section heads still navigate away from Home");
} else ok("section heads are not fake links");

// Hosts must not open random agent DMs
if (/host host-\$\{h\.key\} home-tap" data-open-agent/.test(app) || /data-open-agent="\$\{esc\(agent\)\}"[^>]*>\s*\n\s*<div class="host-top"/.test(app)) {
  fail("computer cards still open agent DMs");
} else if (app.includes('data-open-agent="${esc(agent)}" aria-label="${esc(h.name)}')) {
  fail("computer cards still open agent DMs");
} else ok("computer cards are status-only");

// Feed summary must not hijack navigation
if (/summary class="home-tap"\$\{openAttr\}/.test(app) || /summary class="home-tap" data-open-/.test(app)) {
  fail("feed summary still hijacks taps");
} else ok("feed expands normally");

// Required shell assets
for (const f of ["favicon.svg", "icon-180.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "manifest.webmanifest"]) {
  if (!fs.existsSync(path.join(root, f))) fail(`missing ${f}`);
}
ok("icon + manifest assets present");

if (fs.readFileSync(path.join(root, "favicon.svg"), "utf8").includes("#7cb518")) {
  fail("favicon still olive/lime mark — expected iridescent");
} else ok("favicon is iridescent mark");

if (process.exitCode) {
  console.error("\nPremium check FAILED");
  process.exit(1);
}
console.log("\nPremium check PASSED");
