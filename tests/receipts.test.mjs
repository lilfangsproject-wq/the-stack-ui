import assert from "node:assert/strict";
import polish from "../polish.js";

const receipt = polish.messageReceipt;
assert.equal(receipt({ _typing: true }), null, "typing affordances have no receipt");
assert.equal(receipt({ _queued: true }).label, "Locally queued");
assert.equal(receipt({ _receipt: { state: "pending" } }).label, "Composed locally");
assert.match(receipt({ _receipt: { state: "backend-accepted", commit_sha: "abc12345" } }).detail, /not delivery/);
assert.equal(receipt({ auto: true, author: "Claude", provider: "fallback-live" }).label, "Automated reply");
assert.match(receipt({ auto: true, author: "Claude" }).detail, /not evidence that Claude received or acknowledged/);
assert.equal(receipt({ author: "Claude" }).label, "Receipt unavailable");
console.log("receipt fixtures passed");
