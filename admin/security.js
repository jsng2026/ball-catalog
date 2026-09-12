"use strict";
// Serialize data through a text node; only fixed markup may use innerHTML.
function escapeHTML(value) {
  const span = document.createElement("span");
  span.textContent = String(value ?? "");
  return span.innerHTML;
}
function safeSourceURL(value) {
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : "about:blank"; }
  catch { return "about:blank"; }
}
