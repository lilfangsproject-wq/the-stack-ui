/* Conversation ordering and receipts for the existing Stack chat. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StackChat = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const key = (message) => message.id
    ? "id:" + message.id
    : "legacy:" + JSON.stringify([message.created_at || "", message.author || "", message.body || ""]);
  const time = (message) => Date.parse(message.created_at) || 0;
  const compare = (a, b) => time(a) - time(b) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const isOwner = (message) => String(message.author || "").toLowerCase() === "seth";

  function merge(existing, incoming) {
    const messages = new Map();
    for (const message of [...existing, ...incoming]) {
      if (!message || typeof message !== "object") continue;
      const id = key(message);
      const previous = messages.get(id);
      messages.set(id, previous?._accepted && !message.backend_accepted_at
        ? { ...message, _accepted: true }
        : message);
    }
    return Array.from(messages.values()).sort(compare);
  }

  function savedEntry(entry, message) {
    return Boolean(message && entry.requestId && message.id === entry.requestId &&
      isOwner(message) && message.body === entry.body && (message.backend_accepted_at || message._accepted));
  }

  function latestIncoming(messages) {
    return messages.slice().reverse().find((message) => message.id && !isOwner(message));
  }

  function unread(messages, through) {
    if (through === undefined) return 0;
    const index = messages.findIndex((message) => message.id === through);
    return messages.slice(index + 1).filter((message) => message.id && !isOwner(message)).length;
  }

  return { key, merge, savedEntry, latestIncoming, unread };
});
