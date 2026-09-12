"use strict";
let loadedHead;

"use strict";
// The repo this panel reads seed/overrides from and commits back to.
// It MUST be the repo the panel is served from — it was left pointing at
// the project's previous owner after the move to jsng2026, so every load
// and every commit was aimed at a different repository than the one the
// workflow runs in. Override per-deployment with ?repo=owner/name.
const REPO = new URLSearchParams(location.search).get("repo") || "jsng2026/Ball";
const BRANCH = "main";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const OVERRIDES_PATH = "tools/catalog-scraper/overrides.json";
const SEED_PATH = "tools/catalog-scraper/seed.json";
const PROMOS_PATH = "tools/catalog-scraper/promotions.json";
const SOURCES_PATH = "tools/catalog-scraper/sources.json";
const WORKFLOW = "update-catalog.yml";
const API = "https://api.github.com";

document.getElementById("repoLabel").textContent = REPO;

const ENTRY_FIELDS = [
  ["baseMilesPerDollar", "Base mpd"],
  ["fcyBaseMilesPerDollar", "Overseas mpd"],
  ["fcyFeePercent", "FCY fee — fraction, 0.0325 = 3.25%"],
  ["earnBlockSize", "Earn block ($)"],
];
const RULE_FIELDS = [
  ["milesPerDollar", "Bonus mpd"],
  ["monthlyCap", "Monthly cap ($)"],
  ["minMonthlySpend", "Min monthly spend ($)"],
  ["minTransactionAmount", "Min transaction ($)"],
];
const OVERFLOW_OPTIONS = [["baseRate", "Base rate after cap"], ["zero", "Zero after cap"]];
const CAP_PERIOD_TYPES = [
  ["calendarMonth", "Calendar month"],
  ["calendarYear", "Calendar year"],
  ["lifetime", "Lifetime"],
  ["statementCycle", "Statement cycle"],
];
// Must match BestCardKit's SpendCategory raw values exactly (Models/MCC.swift).
const CATEGORY_OPTIONS = [
  ["dining", "Dining"], ["groceries", "Groceries"], ["transport", "Transport"], ["fuel", "Fuel"],
  ["travel", "Travel"], ["onlineShopping", "Online shopping"], ["retailShopping", "Retail shopping"],
  ["entertainment", "Entertainment"], ["utilities", "Utilities"], ["insurance", "Insurance"],
  ["education", "Education"], ["government", "Government"], ["other", "Other"],
];

let robot = null;          // scraped.json entries by id (the robot's view)
let files = {};            // {overrides: {json, sha}, seed: {json, sha}}
let workingOverrides = {}; // editable copy of overrides.json
let workingSeed = null;    // editable copy of seed.json
let workingPromos = null;   // editable copy of promotions.json
let workingSources = null;  // editable copy of sources.json (delete-only)
let scrapedAt = null;
let corroboration = {};    // `${entryId}|${ruleId ?? ""}|${field}` -> check (see corroborate.py)

const $ = (id) => document.getElementById(id);
const status = (msg, cls = "") => { const el = $("status"); el.textContent = msg; el.className = cls; };
const token = () => $("token").value.trim();
const clone = (x) => structuredClone(x);
// Remove legacy persisted credentials. Tokens live only in this page's memory.
localStorage.removeItem("ball-admin-token");
$("rememberToken").disabled = true;
$("rememberToken").checked = false;
$("forgetBtn").style.display = "none";
function persistTokenChoice() {}

/// GitHub's status codes, in terms of what the admin actually has to fix.
function explainHTTP(code) {
  switch (code) {
    case 401: return "Token rejected — check it's pasted in full and hasn't expired";
    case 403: return "Token lacks permission — it needs Contents and Actions read/write on this repo";
    case 404: return `Not found — either the token can't see ${REPO}, or the file isn't on ${BRANCH} yet`;
    case 409: return "Someone else changed this file — reload the catalog and redo your edits";
    case 422: return "GitHub rejected the change — reload the catalog and try again";
    default: return `GitHub returned HTTP ${code}`;
  }
}

async function gh(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Authorization": `Bearer ${token()}`, "Accept": "application/vnd.github+json",
               ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`${explainHTTP(response.status)} (${path})`);
  return response.status === 204 ? null : response.json();
}

function decodeContent(file) {
  return JSON.parse(new TextDecoder().decode(
    Uint8Array.from(atob(file.content.replace(/\n/g, "")), c => c.charCodeAt(0))));
}

async function loadFile(path) {
  const file = await gh(`/repos/${REPO}/contents/${path}?ref=${BRANCH}`);
  return { json: decodeContent(file), sha: file.sha };
}

$("loadBtn").onclick = async () => {
  try {
    if (!token()) { status("Paste a GitHub token first.", "err"); return; }
    status("Loading…");
    loadedHead = (await gh(`/repos/${REPO}/git/ref/heads/${BRANCH}`)).object.sha;
    persistTokenChoice();
    // Repo is private → raw URLs need auth, so read the robot's view via
    // the authenticated contents API like everything else.
    try {
      const scrapedFile = await loadFile("catalog/scraped.json");
      robot = Object.fromEntries(scrapedFile.json.entries.map(e => [e.id, e]));
      scrapedAt = scrapedFile.json.updatedAt;
    } catch {
      robot = {}; // panel still works; robot comparison just shows "no data"
    }
    try {
      const corrFile = await loadFile("catalog/corroboration.json");
      corroboration = Object.fromEntries(
        corrFile.json.checks.map(c => [`${c.entryId}|${c.ruleId ?? ""}|${c.field}`, c]));
      const conflicts = corrFile.json.checks.filter(c => c.status === "conflict").length;
      $("corrSummary").textContent = conflicts
        ? `${conflicts} conflict(s) of ${corrFile.json.checks.length} check(s), as of ${corrFile.json.updatedAt}`
        : `no conflicts (${corrFile.json.checks.length} check(s) as of ${corrFile.json.updatedAt})`;
    } catch {
      corroboration = {}; // no corroboration.json yet — badges just don't appear
      $("corrSummary").textContent = "not published yet";
    }
    files.overrides = await loadFile(OVERRIDES_PATH);
    files.seed = await loadFile(SEED_PATH);
    files.promos = await loadFile(PROMOS_PATH);
    files.sources = await loadFile(SOURCES_PATH);
    workingOverrides = clone(files.overrides.json);
    workingSeed = clone(files.seed.json);
    workingPromos = clone(files.promos.json);
    workingSources = clone(files.sources.json);
    $("scrapedAt").textContent = scrapedAt ?? "not published yet";
    refresh();
    $("editor").style.display = "";
    status(`Loaded ${workingSeed.entries.length} cards`, "ok");
    refreshBuildStatus();
  } catch (error) { status(error.message, "err"); }
};

// ---- value resolution -------------------------------------------------
// robot value  = what automatic mode would publish (scraped.json, falling
//                back to seed for new/unscraped cards)
// manual value = workingOverrides[entry][field] (if present)
// effective    = manual ?? robot

function robotEntry(entryId) {
  return robot?.[entryId] ?? workingSeed.entries.find(e => e.id === entryId);
}
function robotRule(entryId, ruleId) {
  return (robotEntry(entryId)?.earnRules || []).find(r => r.id === ruleId)
      ?? (workingSeed.entries.find(e => e.id === entryId)?.earnRules || []).find(r => r.id === ruleId);
}
function overrideFor(entryId) { return workingOverrides[entryId] || null; }
function overrideRuleFor(entryId, ruleId) {
  return (overrideFor(entryId)?.earnRules || []).find(r => r.id === ruleId) || null;
}

function setOverride(entryId, field, value) {
  workingOverrides[entryId] = workingOverrides[entryId] || {};
  workingOverrides[entryId][field] = value;
}
function clearOverride(entryId, field) {
  const entry = workingOverrides[entryId];
  if (!entry) return;
  delete entry[field];
  cleanEntry(entryId);
}
function setRuleOverride(entryId, ruleId, field, value) {
  workingOverrides[entryId] = workingOverrides[entryId] || {};
  const rules = workingOverrides[entryId].earnRules = workingOverrides[entryId].earnRules || [];
  let patch = rules.find(r => r.id === ruleId);
  if (!patch) { patch = { id: ruleId }; rules.push(patch); }
  patch[field] = value;
}
function clearRuleOverride(entryId, ruleId, field) {
  const entry = workingOverrides[entryId];
  if (!entry?.earnRules) return;
  const patch = entry.earnRules.find(r => r.id === ruleId);
  if (!patch) return;
  delete patch[field];
  if (Object.keys(patch).length <= 1) {
    entry.earnRules = entry.earnRules.filter(r => r !== patch);
    if (!entry.earnRules.length) delete entry.earnRules;
  }
  cleanEntry(entryId);
}
function cleanEntry(entryId) {
  const entry = workingOverrides[entryId];
  if (entry && !Object.keys(entry).length) delete workingOverrides[entryId];
}

// ---- rendering --------------------------------------------------------

function corrBadge(check) {
  if (!check) return null;
  const badge = document.createElement("span");
  badge.className = "badge " + (check.status === "conflict" ? "conflict" : "agree");
  badge.textContent = check.status === "conflict" ? "⚠ conflict" : "✓ agrees";
  const lines = check.sources.map(s => `${s.name}: ${s.value}`);
  badge.title = `live: ${check.liveValue ?? "–"}\n` + lines.join("\n");
  return badge;
}

function fieldCell(labelText, robotValue, manualValue, onManual, onRevert, corrCheck) {
  const wrap = document.createElement("div");
  const label = document.createElement("label");
  label.textContent = labelText;
  const badge = corrBadge(corrCheck);
  if (badge) label.appendChild(badge);
  const input = document.createElement("input");
  input.type = "number"; input.step = "any";
  const isManual = manualValue !== null && manualValue !== undefined;
  input.value = (isManual ? manualValue : robotValue) ?? "";
  if (isManual) input.classList.add("manual");
  input.oninput = () => {
    const value = input.value === "" ? null : Number(input.value);
    if (value === (robotValue ?? null)) onRevert(); else onManual(value);
    // Deliberately NOT refresh(): renderCards() wipes and rebuilds every
    // node, so a full re-render here would tear out the very input being
    // typed into and drop focus after each character. Keep the pending-
    // changes pane live and the amber "manual" tint honest; the rest of
    // the re-render (badges, the "revert to automatic" note) lands on blur.
    input.classList.toggle("manual", value !== (robotValue ?? null));
    renderDiff();
  };
  input.onchange = () => refresh();
  wrap.append(label, input);
  if (isManual && (manualValue ?? null) !== (robotValue ?? null)) {
    const note = document.createElement("div");
    note.className = "robot";
    note.innerHTML = `robot: <b>${escapeHTML(robotValue ?? "–")}</b> · <span class="use">revert to automatic</span>`;
    note.querySelector(".use").onclick = () => { onRevert(); refresh(); };
    wrap.appendChild(note);
  }
  return wrap;
}

function selectCell(labelText, robotValue, manualValue, options, onManual, onRevert) {
  const wrap = document.createElement("div");
  const label = document.createElement("label");
  label.textContent = labelText;
  const select = document.createElement("select");
  options.forEach(([value, text]) => {
    const opt = document.createElement("option");
    opt.value = value; opt.textContent = text;
    select.appendChild(opt);
  });
  const isManual = manualValue !== null && manualValue !== undefined;
  select.value = isManual ? manualValue : robotValue;
  if (isManual) select.classList.add("manual");
  select.onchange = () => {
    if (select.value === robotValue) onRevert(); else onManual(select.value);
    refresh();
  };
  wrap.append(label, select);
  if (isManual && manualValue !== robotValue) {
    const note = document.createElement("div");
    note.className = "robot";
    const robotLabel = options.find(([v]) => v === robotValue)?.[1] ?? robotValue;
    note.innerHTML = `robot: <b>${escapeHTML(robotLabel)}</b> · <span class="use">revert to automatic</span>`;
    note.querySelector(".use").onclick = () => { onRevert(); refresh(); };
    wrap.appendChild(note);
  }
  return wrap;
}

// ---- capPeriod: {type, dayOfMonth?} object, distinct from the flat
// numeric/enum fields above, so it gets its own cell rather than fitting
// fieldCell/selectCell.

function capPeriodType(cp) { return (cp && cp.type) || "calendarMonth"; }
function capPeriodDay(cp) { return cp && cp.type === "statementCycle" ? cp.dayOfMonth : 1; }
function sameCapPeriod(a, b) {
  const ta = capPeriodType(a), tb = capPeriodType(b);
  if (ta !== tb) return false;
  return ta !== "statementCycle" || capPeriodDay(a) === capPeriodDay(b);
}

function capPeriodCell(entryId, ruleId, rRule, rulePatch) {
  const wrap = document.createElement("div");
  const label = document.createElement("label");
  label.textContent = "Cap resets";
  const select = document.createElement("select");
  CAP_PERIOD_TYPES.forEach(([value, text]) => {
    const opt = document.createElement("option");
    opt.value = value; opt.textContent = text;
    select.appendChild(opt);
  });
  const dayInput = document.createElement("input");
  dayInput.type = "number"; dayInput.min = "1"; dayInput.max = "31"; dayInput.style.width = "60px";
  dayInput.title = "Day of month the statement closes";

  const robotCP = rRule.capPeriod || null;
  const hasManual = rulePatch ? "capPeriod" in rulePatch : false;
  const manualCP = hasManual ? rulePatch.capPeriod : null;
  const effective = hasManual ? manualCP : robotCP;

  select.value = capPeriodType(effective);
  dayInput.value = capPeriodDay(effective);
  dayInput.style.display = select.value === "statementCycle" ? "" : "none";
  if (hasManual) select.classList.add("manual");

  function commit() {
    const type = select.value;
    dayInput.style.display = type === "statementCycle" ? "" : "none";
    const next = type === "statementCycle"
      ? { type, dayOfMonth: Math.min(31, Math.max(1, Number(dayInput.value) || 1)) }
      : { type };
    if (sameCapPeriod(next, robotCP)) clearRuleOverride(entryId, ruleId, "capPeriod");
    else setRuleOverride(entryId, ruleId, "capPeriod", next);
    refresh();
  }
  select.onchange = commit;
  dayInput.onchange = commit;

  wrap.append(label, select, dayInput);
  if (hasManual && !sameCapPeriod(manualCP, robotCP)) {
    const note = document.createElement("div");
    note.className = "robot";
    const robotText = CAP_PERIOD_TYPES.find(([v]) => v === capPeriodType(robotCP))?.[1] ?? "Calendar month";
    const robotDay = robotCP?.type === "statementCycle" ? ` (day ${robotCP.dayOfMonth})` : "";
    note.innerHTML = `robot: <b>${escapeHTML(robotText)}${escapeHTML(robotDay)}</b> · <span class="use">revert to automatic</span>`;
    note.querySelector(".use").onclick = () => { clearRuleOverride(entryId, ruleId, "capPeriod"); refresh(); };
    wrap.appendChild(note);
  }
  return wrap;
}

// ---- tiers: an array of {upTo, milesPerDollar}, replaces the flat
// milesPerDollar/monthlyCap/overflowBehavior above for earning purposes when set.

function tiersEditor(entryId, ruleId, rRule, rulePatch) {
  const wrap = document.createElement("div");
  wrap.className = "tiers";
  const label = document.createElement("label");
  label.textContent = "Tiers (overrides bonus mpd/cap above when set)";
  wrap.appendChild(label);

  const hasManual = rulePatch ? "tiers" in rulePatch : false;
  const robotTiers = rRule.tiers || null;
  const tiers = (hasManual ? rulePatch.tiers : robotTiers) || [];

  function commit(newTiers) {
    if (newTiers.length === 0) clearRuleOverride(entryId, ruleId, "tiers");
    else setRuleOverride(entryId, ruleId, "tiers", newTiers);
    refresh();
  }

  tiers.forEach((tier, i) => {
    const row = document.createElement("div");
    row.className = "tierrow";

    const upTo = document.createElement("input");
    upTo.type = "number"; upTo.step = "any";
    upTo.placeholder = "up to $ (blank = rest)";
    upTo.value = tier.upTo ?? "";
    upTo.onchange = () => {
      const next = clone(tiers);
      next[i] = { ...next[i], upTo: upTo.value === "" ? null : Number(upTo.value) };
      commit(next);
    };

    const mpd = document.createElement("input");
    mpd.type = "number"; mpd.step = "any";
    mpd.placeholder = "mpd";
    mpd.value = tier.milesPerDollar ?? "";
    mpd.onchange = () => {
      const next = clone(tiers);
      next[i] = { ...next[i], milesPerDollar: Number(mpd.value) || 0 };
      commit(next);
    };

    const removeBtn = document.createElement("button");
    removeBtn.className = "danger tiny"; removeBtn.textContent = "✕";
    removeBtn.onclick = () => commit(tiers.filter((_, j) => j !== i));

    row.append(upTo, mpd, removeBtn);
    wrap.appendChild(row);
  });

  const addBtn = document.createElement("button");
  addBtn.className = "secondary tiny"; addBtn.style.marginTop = "4px";
  addBtn.textContent = "+ tier";
  addBtn.onclick = () => commit([...tiers, { upTo: null, milesPerDollar: 0 }]);
  wrap.appendChild(addBtn);

  if (hasManual && JSON.stringify(rulePatch.tiers) !== JSON.stringify(robotTiers)) {
    const note = document.createElement("div");
    note.className = "robot";
    note.innerHTML = `robot: <b>${robotTiers ? robotTiers.length + " tier(s)" : "none"}</b> · <span class="use">revert to automatic</span>`;
    note.querySelector(".use").onclick = () => { clearRuleOverride(entryId, ruleId, "tiers"); refresh(); };
    wrap.appendChild(note);
  }
  return wrap;
}

// ---- categories: the pool of SpendCategory values a rule matches. For an
// ordinary rule this pool applies as-is; for a "choose N categories" rule
// (see categoryChoiceLimit in the advanced row above) it's the pool the
// CARDHOLDER picks N from in the app — the admin panel only authors the
// pool + N, never the cardholder's actual pick (that's per-user, local to
// their own copy of the card, and never touches the catalog).

function categoriesCell(entryId, ruleId, rRule, rulePatch) {
  const wrap = document.createElement("div");
  wrap.className = "tiers";
  const label = document.createElement("label");
  label.textContent = "Categories this rule matches (or, with \"Choose N categories\" set, the pool the cardholder picks from)";
  wrap.appendChild(label);

  const hasManual = rulePatch ? "categories" in rulePatch : false;
  const robotCategories = rRule.categories || [];
  const categories = hasManual ? rulePatch.categories : robotCategories;
  const selected = new Set(categories);

  const chipRow = document.createElement("div");
  CATEGORY_OPTIONS.forEach(([value, text]) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (selected.has(value) ? " on" : "");
    chip.textContent = text;
    chip.onclick = () => {
      const next = new Set(categories);
      if (next.has(value)) next.delete(value); else next.add(value);
      const nextArr = CATEGORY_OPTIONS.map(([v]) => v).filter(v => next.has(v));
      if (JSON.stringify(nextArr) === JSON.stringify(robotCategories)) clearRuleOverride(entryId, ruleId, "categories");
      else setRuleOverride(entryId, ruleId, "categories", nextArr);
      refresh();
    };
    chipRow.appendChild(chip);
  });
  wrap.appendChild(chipRow);

  if (hasManual && JSON.stringify(rulePatch.categories) !== JSON.stringify(robotCategories)) {
    const note = document.createElement("div");
    note.className = "robot";
    const robotLabel = robotCategories.length
      ? robotCategories.map(c => CATEGORY_OPTIONS.find(([v]) => v === c)?.[1] ?? c).join(", ")
      : "none";
    note.innerHTML = `robot: <b>${escapeHTML(robotLabel)}</b> · <span class="use">revert to automatic</span>`;
    note.querySelector(".use").onclick = () => { clearRuleOverride(entryId, ruleId, "categories"); refresh(); };
    wrap.appendChild(note);
  }
  return wrap;
}

// ---- sections, search & filters ---------------------------------------

let activeSection = "cards";
let cardFilter = "all";

function showSection(name) {
  activeSection = name;
  document.querySelectorAll("nav button").forEach(b => b.classList.toggle("on", b.dataset.section === name));
  ["cards", "promos", "sources", "review"].forEach(id => {
    $(`section-${id}`).hidden = id !== name;
  });
}
document.querySelectorAll("nav button").forEach(button => {
  button.onclick = () => showSection(button.dataset.section);
});

$("cardSearch").oninput = () => renderCards();  // immediate: no field is mid-edit
document.querySelectorAll(".toolbar .chip").forEach(chip => {
  chip.onclick = () => {
    cardFilter = chip.dataset.filter;
    document.querySelectorAll(".toolbar .chip").forEach(c => c.classList.toggle("on", c === chip));
    renderCards();
  };
});

/// Cards matching the search box and the active filter chip. Sixteen-plus
/// products on one page is a lot to scroll when you came to fix one rate.
function visibleEntries() {
  const query = $("cardSearch").value.trim().toLowerCase();
  return workingSeed.entries.filter(entry => {
    if (query) {
      const haystack = `${entry.issuer} ${entry.productName} ${entry.milesProgram ?? ""} ${entry.id}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (cardFilter === "manual") {
      return Object.keys(overrideFor(entry.id) || {}).length > 0;
    }
    if (cardFilter === "conflict") {
      return Object.values(corroboration).some(c => c.entryId === entry.id && c.status === "conflict");
    }
    return true;
  });
}

// A full renderCards() wipes and rebuilds every node in the list. That is
// fine between edits and fatal during one: committing a field (on blur)
// used to destroy the field you were moving *into*, so "type a cap, click
// the rule name, type" silently lost the second edit — and clicking a
// category chip straight from a text field swallowed the click, because the
// chip was rebuilt before it fired.
//
// So the rebuild is deferred to the next macrotask (letting any in-flight
// click land first) and held back entirely while a text field in the list
// still has focus, resuming the moment focus leaves it.
let cardRenderQueued = false;

function stillEditingCards() {
  const el = document.activeElement;
  return Boolean(el) && $("cards").contains(el) && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}

function scheduleCardRender() {
  if (cardRenderQueued) return;
  cardRenderQueued = true;
  setTimeout(() => {
    cardRenderQueued = false;
    if (stillEditingCards()) {
      $("cards").addEventListener("focusout", scheduleCardRender, { once: true });
      return;
    }
    renderCards();
  }, 0);
}

function refresh() { scheduleCardRender(); renderPromos(); renderSources(); renderDiff(); }

// Pending edits live only in this tab until "Commit & rebuild" is pressed,
// so a stray reload or closed tab would throw them away silently.
window.addEventListener("beforeunload", (event) => {
  if (!workingSeed || !anyChanges()) return;
  event.preventDefault();
  event.returnValue = "";
});

function renderCards() {
  const container = $("cards");
  const scroll = window.scrollY;
  container.innerHTML = "";

  const entries = visibleEntries();
  $("navCards").textContent = workingSeed.entries.length;
  $("cardCount").textContent = entries.length === workingSeed.entries.length
    ? `${entries.length} card(s)`
    : `${entries.length} of ${workingSeed.entries.length} card(s)`;
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No cards match that search or filter.";
    container.appendChild(empty);
  }

  entries.forEach(seedEntry => {
    const entryId = seedEntry.id;
    const rEntry = robotEntry(entryId) || seedEntry;
    const override = overrideFor(entryId);
    const isNew = !files.seed.json.entries.some(e => e.id === entryId);

    const panel = document.createElement("div");
    panel.className = "panel";

    const head = document.createElement("div");
    head.className = "cardhead";
    const title = document.createElement("div");
    const hasManual = override && Object.keys(override).length > 0;
    const entryConflicts = Object.values(corroboration).filter(c => c.entryId === entryId && c.status === "conflict").length;
    title.innerHTML = `<span class="cardname">${escapeHTML(seedEntry.issuer)} ${escapeHTML(seedEntry.productName)}</span>` +
      `<span class="prog">${escapeHTML(seedEntry.milesProgram ?? "")} · ${escapeHTML(seedEntry.network)}</span>` +
      (isNew ? `<span class="badge new">NEW — not committed yet</span>`
             : hasManual ? `<span class="badge manual">HAS MANUAL VALUES</span>`
                         : `<span class="badge auto">FULLY AUTOMATIC</span>`) +
      (entryConflicts ? `<span class="badge conflict">⚠ ${entryConflicts} field(s) conflict</span>` : "");
    const removeBtn = document.createElement("button");
    removeBtn.className = "danger tiny";
    removeBtn.textContent = "Remove card";
    removeBtn.onclick = () => {
      if (!confirm(`Remove ${escapeHTML(seedEntry.issuer)} ${escapeHTML(seedEntry.productName)} from the catalog?\n\nApps keep users' existing copies of this card but it stops receiving updates and disappears from the add-card list.`)) return;
      workingSeed.entries = workingSeed.entries.filter(e => e.id !== entryId);
      delete workingOverrides[entryId];
      refresh();
    };
    head.append(title, removeBtn);
    panel.appendChild(head);

    const row = document.createElement("div");
    row.className = "row"; row.style.marginTop = "8px";
    ENTRY_FIELDS.forEach(([field, labelText]) => {
      row.appendChild(fieldCell(
        labelText,
        rEntry[field] ?? null,
        override ? (field in override ? override[field] : null) : null,
        (value) => setOverride(entryId, field, value),
        () => clearOverride(entryId, field),
        corroboration[`${entryId}|${""}|${field}`]
      ));
    });
    panel.appendChild(row);

    (seedEntry.earnRules || []).forEach(seedRule => {
      const rRule = robotRule(entryId, seedRule.id) || seedRule;
      const rulePatch = overrideRuleFor(entryId, seedRule.id);
      const ruleDiv = document.createElement("div");
      ruleDiv.className = "rule";
      const name = document.createElement("div");
      name.className = "rulename cardhead";
      const nameText = document.createElement("span");
      nameText.textContent = `↳ ${seedRule.name} (${(seedRule.channels || []).join(", ")}${seedRule.currencyScope ? " · " + seedRule.currencyScope : ""})`;
      const dropRuleBtn = document.createElement("button");
      dropRuleBtn.className = "danger tiny";
      dropRuleBtn.textContent = "Delete rule";
      dropRuleBtn.onclick = () => {
        if (!confirm(`Delete the rule "${seedRule.name}" from ${escapeHTML(seedEntry.issuer)} ${escapeHTML(seedEntry.productName)}?\n\nCards already on a phone lose this bonus rate at the next refresh.`)) return;
        removeRuleFromCard(entryId, seedRule.id);
      };
      name.append(nameText, dropRuleBtn);
      ruleDiv.appendChild(name);
      ruleDiv.appendChild(ruleIdentityRow(entryId, seedRule));
      const ruleRow = document.createElement("div");
      ruleRow.className = "row";
      RULE_FIELDS.forEach(([field, labelText]) => {
        ruleRow.appendChild(fieldCell(
          labelText,
          rRule[field] ?? null,
          rulePatch ? (field in rulePatch ? rulePatch[field] : null) : null,
          (value) => setRuleOverride(entryId, seedRule.id, field, value),
          () => clearRuleOverride(entryId, seedRule.id, field),
          corroboration[`${entryId}|${seedRule.id}|${field}`]
        ));
      });
      ruleDiv.appendChild(ruleRow);

      const advancedRow = document.createElement("div");
      advancedRow.className = "row"; advancedRow.style.marginTop = "6px";
      advancedRow.appendChild(selectCell(
        "Overflow behavior",
        rRule.overflowBehavior || "baseRate",
        rulePatch && "overflowBehavior" in rulePatch ? rulePatch.overflowBehavior : null,
        OVERFLOW_OPTIONS,
        (value) => setRuleOverride(entryId, seedRule.id, "overflowBehavior", value),
        () => clearRuleOverride(entryId, seedRule.id, "overflowBehavior")
      ));
      advancedRow.appendChild(capPeriodCell(entryId, seedRule.id, rRule, rulePatch));
      advancedRow.appendChild(fieldCell(
        "Choose N categories",
        rRule.categoryChoiceLimit ?? null,
        rulePatch && "categoryChoiceLimit" in rulePatch ? rulePatch.categoryChoiceLimit : null,
        (value) => setRuleOverride(entryId, seedRule.id, "categoryChoiceLimit", value),
        () => clearRuleOverride(entryId, seedRule.id, "categoryChoiceLimit")
      ));
      ruleDiv.appendChild(advancedRow);

      ruleDiv.appendChild(categoriesCell(entryId, seedRule.id, rRule, rulePatch));
      ruleDiv.appendChild(tiersEditor(entryId, seedRule.id, rRule, rulePatch));

      panel.appendChild(ruleDiv);
    });

    const addRuleBtn = document.createElement("button");
    addRuleBtn.className = "secondary tiny";
    addRuleBtn.style.marginTop = "12px";
    addRuleBtn.textContent = "＋ Add an earn rule to this card";
    addRuleBtn.onclick = () => addRuleToCard(entryId);
    panel.appendChild(addRuleBtn);

    container.appendChild(panel);
  });
  window.scrollTo(0, scroll);
}

// ---- rule identity (seed-level) ---------------------------------------
// Name, channels, currency scope and validity are *structure*, not scraped
// numbers — the scraper only ever patches numeric fields, so these live in
// seed.json and the robot can never fight them. Until now they could only
// be changed by hand-editing that file.

const SCOPE_OPTIONS = [["any", "Local and foreign"], ["local", "Local only"], ["foreign", "Foreign only"]];

function seedRuleRef(entryId, ruleId) {
  const entry = workingSeed.entries.find(e => e.id === entryId);
  return (entry?.earnRules || []).find(r => r.id === ruleId) || null;
}

function ruleIdentityRow(entryId, seedRule) {
  const row = document.createElement("div");
  row.className = "row";
  row.style.marginTop = "6px";

  row.appendChild(textRow("Rule name (shown in the app)", seedRule.name, "4 mpd contactless", (value) => {
    const rule = seedRuleRef(entryId, seedRule.id);
    if (rule) rule.name = value ?? "";
    refresh();
  }, { wide: false }));

  const scopeWrap = document.createElement("div");
  const scopeLabel = document.createElement("label");
  scopeLabel.textContent = "Applies to";
  const scopeSelect = document.createElement("select");
  SCOPE_OPTIONS.forEach(([value, text]) => {
    const option = document.createElement("option");
    option.value = value; option.textContent = text;
    scopeSelect.appendChild(option);
  });
  scopeSelect.value = seedRule.currencyScope || "any";
  scopeSelect.onchange = () => {
    const rule = seedRuleRef(entryId, seedRule.id);
    if (rule) rule.currencyScope = scopeSelect.value === "any" ? null : scopeSelect.value;
    refresh();
  };
  scopeWrap.append(scopeLabel, scopeSelect);
  row.appendChild(scopeWrap);

  const untilWrap = document.createElement("div");
  const untilLabel = document.createElement("label");
  untilLabel.textContent = "Expires (blank = permanent)";
  const untilInput = document.createElement("input");
  untilInput.type = "date";
  untilInput.value = isoToDateInput(seedRule.validUntil);
  untilInput.onchange = () => {
    const rule = seedRuleRef(entryId, seedRule.id);
    if (rule) rule.validUntil = dateInputToISO(untilInput.value);
    refresh();
  };
  untilWrap.append(untilLabel, untilInput);
  row.appendChild(untilWrap);

  const channelWrap = document.createElement("div");
  channelWrap.style.flex = "1 1 100%";
  const channelLabel = document.createElement("label");
  channelLabel.textContent = "Channels this rule pays on";
  channelWrap.appendChild(channelLabel);
  const chips = document.createElement("div");
  const current = new Set(seedRule.channels || ["any"]);
  CHANNEL_OPTIONS.forEach(([value, text]) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (current.has(value) ? " on" : "");
    chip.textContent = text;
    chip.onclick = () => {
      const next = new Set(current);
      if (value === "any") { next.clear(); next.add("any"); }
      else {
        next.delete("any");
        if (next.has(value)) next.delete(value); else next.add(value);
        if (!next.size) next.add("any");
      }
      const rule = seedRuleRef(entryId, seedRule.id);
      if (rule) rule.channels = CHANNEL_OPTIONS.map(([v]) => v).filter(v => next.has(v));
      refresh();
    };
    chips.appendChild(chip);
  });
  channelWrap.appendChild(chips);
  row.appendChild(channelWrap);

  return row;
}

/// A new rule goes in seed.json (structure), with a slug id derived from the
/// card so cap history on users' phones stays keyed to something stable.
function addRuleToCard(entryId) {
  const entry = workingSeed.entries.find(e => e.id === entryId);
  if (!entry) return;
  entry.earnRules = entry.earnRules || [];
  let n = entry.earnRules.length + 1;
  let id = `${entryId}.rule-${n}`;
  while (entry.earnRules.some(r => r.id === id)) id = `${entryId}.rule-${++n}`;
  entry.earnRules.push({
    id, name: "New bonus rule", mccs: [], categories: [],
    channels: ["any"], milesPerDollar: entry.baseMilesPerDollar,
  });
  refresh();
}

function removeRuleFromCard(entryId, ruleId) {
  const entry = workingSeed.entries.find(e => e.id === entryId);
  if (!entry) return;
  entry.earnRules = (entry.earnRules || []).filter(r => r.id !== ruleId);
  // An override patch keyed to a rule that no longer exists would be
  // re-appended as a brand new rule by deep_merge — drop it with the rule.
  const patch = workingOverrides[entryId];
  if (patch?.earnRules) {
    patch.earnRules = patch.earnRules.filter(r => r.id !== ruleId);
    if (!patch.earnRules.length) delete patch.earnRules;
    cleanEntry(entryId);
  }
  refresh();
}

// ---- offers & promotions ----------------------------------------------
// promotions.json is a flat curated list the scraper never touches. Until
// now the only way to change an offer was to hand-edit that file, which is
// exactly the kind of thing this panel exists to avoid.

function textRow(labelText, value, placeholder, onChange, { multiline = false, wide = true } = {}) {
  const wrap = document.createElement("div");
  wrap.style.flex = wide ? "1 1 100%" : "";
  const label = document.createElement("label");
  label.textContent = labelText;
  const field = document.createElement(multiline ? "textarea" : "input");
  if (!multiline) field.className = "wide";
  field.placeholder = placeholder;
  field.value = value ?? "";
  // Same reason as the rate fields: re-rendering on every keystroke would
  // tear out the element being typed into. Commit on blur.
  field.onchange = () => onChange(field.value.trim() === "" ? null : field.value.trim());
  field.oninput = () => renderDiff();
  wrap.append(label, field);
  return wrap;
}

/// `validUntil` is ISO-8601 in the file but a date is all anyone means.
function isoToDateInput(iso) { return iso ? iso.slice(0, 10) : ""; }
function dateInputToISO(value) { return value ? `${value}T23:59:59Z` : null; }

function renderPromos() {
  const host = $("promos");
  host.innerHTML = "";
  $("navPromos").textContent = workingPromos.length;
  if (!workingPromos.length) {
    host.innerHTML = '<p class="empty">No offers yet. The Home tab simply hides the section.</p>';
    return;
  }

  workingPromos.forEach((promo, index) => {
    const item = document.createElement("div");
    item.className = "item";

    const top = document.createElement("div");
    top.className = "top";
    const heading = document.createElement("div");
    const expired = promo.validUntil && new Date(promo.validUntil) < new Date();
    heading.innerHTML = `<span class="cardname">${escapeHTML(promo.title || "(untitled offer)")}</span>` +
      (expired ? `<span class="badge manual">EXPIRED — dropped at build</span>` : "");
    const removeBtn = document.createElement("button");
    removeBtn.className = "danger tiny";
    removeBtn.textContent = "Delete";
    removeBtn.onclick = () => {
      if (!confirm(`Delete the offer "${promo.title || promo.id}"?`)) return;
      workingPromos.splice(index, 1);
      refresh();
    };
    top.append(heading, removeBtn);
    item.appendChild(top);

    const row = document.createElement("div");
    row.className = "row";
    row.style.marginTop = "6px";
    row.appendChild(textRow("Title", promo.title, "15% KrisFlyer transfer bonus",
      (value) => { workingPromos[index].title = value ?? ""; refresh(); }));
    row.appendChild(textRow("Details", promo.details, "What the offer is, in one or two sentences.",
      (value) => { workingPromos[index].details = value ?? ""; refresh(); }, { multiline: true }));
    item.appendChild(row);

    const meta = document.createElement("div");
    meta.className = "row";
    meta.style.marginTop = "6px";

    const cardWrap = document.createElement("div");
    const cardLabel = document.createElement("label");
    cardLabel.textContent = "Related card (optional)";
    const cardSelect = document.createElement("select");
    cardSelect.className = "wide";
    const none = document.createElement("option");
    none.value = ""; none.textContent = "— not card-specific —";
    cardSelect.appendChild(none);
    workingSeed.entries.forEach(entry => {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = `${entry.issuer} ${entry.productName}`;
      cardSelect.appendChild(option);
    });
    cardSelect.value = promo.catalogID ?? "";
    cardSelect.onchange = () => {
      workingPromos[index].catalogID = cardSelect.value || null;
      refresh();
    };
    cardWrap.append(cardLabel, cardSelect);
    meta.appendChild(cardWrap);

    const dateWrap = document.createElement("div");
    const dateLabel = document.createElement("label");
    dateLabel.textContent = "Ends (blank = no end date)";
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.value = isoToDateInput(promo.validUntil);
    dateInput.onchange = () => {
      workingPromos[index].validUntil = dateInputToISO(dateInput.value);
      refresh();
    };
    dateWrap.append(dateLabel, dateInput);
    meta.appendChild(dateWrap);

    meta.appendChild(textRow("Read more URL (optional)", promo.url, "https://…",
      (value) => { workingPromos[index].url = value; refresh(); }));
    item.appendChild(meta);

    const idLine = document.createElement("p");
    idLine.className = "hint";
    idLine.textContent = `id: ${promo.id}`;
    item.appendChild(idLine);

    host.appendChild(item);
  });
}

$("addPromoBtn").onclick = () => {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  let id = `offer.${stamp}`;
  let suffix = 2;
  while (workingPromos.some(p => p.id === id)) id = `offer.${stamp}-${suffix++}`;
  workingPromos.push({ id, title: "", details: "" });
  showSection("promos");
  refresh();
};

// ---- robot watchlist ---------------------------------------------------
// sources.json is what the scraper actually reads each week. Auto-discovery
// appends rows marked "discovered": true, and the README has always promised
// those are visible and deletable — this is where that happens.

function renderSources() {
  const host = $("sources");
  host.innerHTML = "";
  $("navSources").textContent = workingSources.length;

  const watched = new Set(workingSources.map(source => source.entry_id));
  const unwatched = workingSeed.entries.filter(entry => !watched.has(entry.id));

  if (!workingSources.length) {
    host.innerHTML = '<p class="empty">No sources yet — every card is running on seed values alone.</p>';
  }

  workingSources.forEach((source, index) => {
    const entry = workingSeed.entries.find(e => e.id === source.entry_id);
    const item = document.createElement("div");
    item.className = "item";

    const top = document.createElement("div");
    top.className = "top";
    const heading = document.createElement("div");
    heading.innerHTML =
      `<span class="cardname">${escapeHTML(entry ? `${entry.issuer} ${entry.productName}` : source.entry_id)}</span>` +
      (source.discovered ? `<span class="badge new">robot-found</span>` : "") +
      (entry ? "" : `<span class="badge conflict">no such card in seed</span>`) +
      (source.rule_id ? `<span class="prog">patches rule: ${escapeHTML(source.rule_id)}</span>` : `<span class="prog">card-level fields only</span>`);
    const removeBtn = document.createElement("button");
    removeBtn.className = "danger tiny";
    removeBtn.textContent = "Stop watching";
    removeBtn.onclick = () => {
      if (!confirm(`Stop scraping this page?\n\n${source.url}\n\nThe card keeps its current values and falls back to seed + your manual edits. Auto-discovery may find it a new source on a later run.`)) return;
      workingSources.splice(index, 1);
      refresh();
    };
    top.append(heading, removeBtn);
    item.appendChild(top);

    const url = document.createElement("a");
    url.className = "url";
    url.href = safeSourceURL(source.url);
    url.target = "_blank";
    url.rel = "noopener";
    url.textContent = source.url;
    item.appendChild(url);

    host.appendChild(item);
  });

  if (unwatched.length) {
    const note = document.createElement("p");
    note.className = "hint";
    note.style.marginTop = "12px";
    note.innerHTML = `<b>${unwatched.length} card(s) not scraped at all:</b> ` +
      unwatched.map(e => escapeHTML(`${e.issuer} ${e.productName}`)).join(", ") +
      `. They run on seed values plus anything you set manually until auto-discovery finds each one an official issuer page.`;
    host.appendChild(note);
  }
}

// ---- add card ---------------------------------------------------------

const CHANNEL_OPTIONS = [
  ["any", "Any"], ["contactless", "Contactless"], ["online", "Online"], ["chipAndPin", "Chip & PIN"],
];
let newCardChannels = new Set(["any"]);

function slugify(issuer, productName) {
  return `${issuer}-${productName}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function renderChannelChips() {
  const host = $("ncChannels");
  host.innerHTML = "";
  CHANNEL_OPTIONS.forEach(([value, text]) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (newCardChannels.has(value) ? " on" : "");
    chip.textContent = text;
    chip.onclick = () => {
      // "Any" means every channel, so it's exclusive with the specific ones
      // rather than something to combine with them.
      if (value === "any") newCardChannels = new Set(["any"]);
      else {
        newCardChannels.delete("any");
        if (newCardChannels.has(value)) newCardChannels.delete(value); else newCardChannels.add(value);
        if (!newCardChannels.size) newCardChannels = new Set(["any"]);
      }
      renderChannelChips();
    };
    host.appendChild(chip);
  });
}

function updateNewCardId() {
  const id = slugify($("ncIssuer").value.trim(), $("ncProduct").value.trim());
  $("ncId").textContent = id || "–";
  return id;
}

function showAddCardForm(show) {
  $("addCardForm").style.display = show ? "" : "none";
  $("addCardBtn").style.display = show ? "none" : "";
  if (show) { $("ncError").textContent = ""; $("ncIssuer").focus(); }
}

$("addCardBtn").onclick = () => showAddCardForm(true);
$("ncCancel").onclick = () => showAddCardForm(false);
$("ncIssuer").oninput = updateNewCardId;
$("ncProduct").oninput = updateNewCardId;
$("ncHasRule").onchange = () => {
  $("ncRuleFields").style.display = $("ncHasRule").checked ? "" : "none";
};
renderChannelChips();

$("ncSave").onclick = () => {
  const fail = (message) => { $("ncError").textContent = message; };
  const issuer = $("ncIssuer").value.trim();
  const productName = $("ncProduct").value.trim();
  if (!issuer) return fail("Issuer is required.");
  if (!productName) return fail("Product name is required.");

  const id = updateNewCardId();
  if (workingSeed.entries.some(e => e.id === id)) return fail(`Card id "${id}" already exists.`);

  const base = Number($("ncBase").value);
  if (!Number.isFinite(base) || base < 0) return fail("Base mpd must be a number.");
  const fcyFee = $("ncFcyFee").value === "" ? null : Number($("ncFcyFee").value);
  if (fcyFee !== null && (!Number.isFinite(fcyFee) || fcyFee < 0 || fcyFee > 1)) {
    return fail("FCY fee is a fraction between 0 and 1 — 3.25% is 0.0325.");
  }

  const entry = {
    id, issuer, productName,
    network: $("ncNetwork").value,
    baseMilesPerDollar: base,
    earnRules: [], excludedMCCs: [], excludedCategories: [],
    fcyFeePercent: fcyFee,
    milesProgram: $("ncProgram").value.trim() || null,
  };

  if ($("ncHasRule").checked) {
    const mpd = Number($("ncRuleMpd").value);
    if (!Number.isFinite(mpd) || mpd <= 0) return fail("Bonus mpd must be a positive number.");
    const capRaw = $("ncRuleCap").value;
    const cap = capRaw === "" ? null : Number(capRaw);
    if (cap !== null && (!Number.isFinite(cap) || cap <= 0)) return fail("Monthly cap must be a positive number, or blank for uncapped.");
    const rule = {
      id: `${id}.bonus`,
      name: $("ncRuleName").value.trim() || "Bonus rate",
      mccs: [], categories: [],
      channels: [...newCardChannels],
      milesPerDollar: mpd,
    };
    if (cap !== null) rule.monthlyCap = cap;
    entry.earnRules.push(rule);
  }

  workingSeed.entries.push(entry);
  ["ncIssuer", "ncProduct", "ncProgram", "ncRuleName"].forEach(field => { $(field).value = ""; });
  newCardChannels = new Set(["any"]);
  renderChannelChips();
  updateNewCardId();
  showAddCardForm(false);
  refresh();
};

// ---- diff & save ------------------------------------------------------

function seedChanged() { return JSON.stringify(workingSeed) !== JSON.stringify(files.seed.json); }
function overridesChanged() { return JSON.stringify(workingOverrides) !== JSON.stringify(files.overrides.json); }
function promosChanged() { return JSON.stringify(workingPromos) !== JSON.stringify(files.promos.json); }
function sourcesChanged() { return JSON.stringify(workingSources) !== JSON.stringify(files.sources.json); }
function anyChanges() { return seedChanged() || overridesChanged() || promosChanged() || sourcesChanged(); }

function renderDiff() {
  const parts = [];
  const headlines = [];

  const before = files.seed.json.entries.map(e => e.id);
  const after = workingSeed.entries.map(e => e.id);
  const added = after.filter(id => !before.includes(id));
  const removedIds = before.filter(id => !after.includes(id));
  if (added.length) { parts.push(`CARDS TO ADD: ${added.join(", ")}`); headlines.push(`${added.length} card(s) added`); }
  if (removedIds.length) { parts.push(`CARDS TO REMOVE: ${removedIds.join(", ")}`); headlines.push(`${removedIds.length} card(s) removed`); }

  // Rules live in seed.json too, so a seed change that isn't an add/remove
  // is a rule edit — worth naming rather than leaving as a silent diff.
  const ruleChanges = [];
  workingSeed.entries.forEach(entry => {
    const original = files.seed.json.entries.find(e => e.id === entry.id);
    if (!original) return;
    const beforeRules = (original.earnRules || []).map(r => r.id);
    const afterRules = (entry.earnRules || []).map(r => r.id);
    afterRules.filter(id => !beforeRules.includes(id)).forEach(id => ruleChanges.push(`+ ${id}`));
    beforeRules.filter(id => !afterRules.includes(id)).forEach(id => ruleChanges.push(`- ${id}`));
  });
  if (ruleChanges.length) {
    parts.push("EARN RULES (seed.json):\n" + ruleChanges.join("\n"));
    headlines.push(`${ruleChanges.length} rule change(s)`);
  }

  if (overridesChanged()) {
    parts.push("MANUAL VALUES (overrides.json):\n" + JSON.stringify(workingOverrides, null, 2));
    headlines.push("manual values edited");
  }
  if (promosChanged()) {
    parts.push("OFFERS (promotions.json):\n" + JSON.stringify(workingPromos, null, 2));
    headlines.push("offers edited");
  }
  if (sourcesChanged()) {
    const keptIds = workingSources.map(s => s.url);
    const dropped = files.sources.json.filter(s => !keptIds.includes(s.url));
    parts.push("WATCHLIST (sources.json):\n" + dropped.map(s => `- ${s.entry_id}: ${s.url}`).join("\n"));
    headlines.push(`${dropped.length} source(s) removed`);
  }

  $("diff").textContent = parts.length ? parts.join("\n\n") : "No changes yet.";
  // Explicit "flex"/"none", not ""/"none": the bar's default display:none
  // comes from the stylesheet, so clearing the inline style would just fall
  // back to hidden and the commit button would never appear.
  $("commitBar").style.display = parts.length ? "block" : "none";
  $("commitSummary").textContent = headlines.length
    ? `Pending: ${headlines.join(" · ")}`
    : "";
}

$("reviewBtn").onclick = () => showSection("review");

// ---- rebuild status -----------------------------------------------------
// The panel used to end at "dispatched" and leave you guessing. This reads
// the workflow back so a failed rebuild is visible here, where you made the
// change, instead of only in the Actions tab.

function setBuild(state, text, url) {
  $("build").querySelector(".dot").className = `dot ${state}`;
  $("buildText").textContent = text;
  const link = $("buildLink");
  if (url) { link.href = safeSourceURL(url); link.style.display = ""; } else { link.style.display = "none"; }
}

async function latestRun() {
  const data = await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`);
  return data.workflow_runs?.[0] ?? null;
}

async function refreshBuildStatus() {
  try {
    const run = await latestRun();
    if (!run) return setBuild("idle", "never run — the catalog is whatever was last committed by hand");
    const when = new Date(run.created_at).toLocaleString();
    if (run.status !== "completed") return setBuild("run", `running (started ${when})`, run.html_url);
    setBuild(run.conclusion === "success" ? "ok" : "bad",
             `${run.conclusion} — ${when}`, run.html_url);
  } catch (error) {
    setBuild("idle", `couldn't read status (${error.message})`);
  }
}

/// After dispatching, follow the run until it finishes so the outcome lands
/// on this page. Gives up quietly rather than polling forever.
///
/// "Ours" is decided by timestamp, not by run id: identifying the new run as
/// "not the one that was latest before dispatch" fails when GitHub has
/// already created it by the time we look, which is the common case.
async function followBuild(dispatchedAt) {
  const tolerance = 2 * 60 * 1000;  // clock skew between browser and GitHub
  while (Date.now() - dispatchedAt < 10 * 60 * 1000) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    let run;
    try { run = await latestRun(); } catch { continue; }
    if (!run || new Date(run.created_at).getTime() < dispatchedAt - tolerance) {
      setBuild("run", "waiting for the run to appear…");
      continue;
    }
    if (run.status !== "completed") { setBuild("run", "rebuilding…", run.html_url); continue; }
    setBuild(run.conclusion === "success" ? "ok" : "bad",
             run.conclusion === "success"
               ? "rebuild finished — your phone picks it up within ~12h"
               : `rebuild ${run.conclusion} — open the run to see why`,
             run.html_url);
    return;
  }
  setBuild("run", "still running — check the Actions tab");
}

$("resetBtn").onclick = () => {
  if (!confirm("Discard every pending change and reload the committed values?")) return;
  workingOverrides = clone(files.overrides.json);
  workingSeed = clone(files.seed.json);
  workingPromos = clone(files.promos.json);
  workingSources = clone(files.sources.json);
  refresh();
};

$("saveBtn").onclick = async () => {
  const button = $("saveBtn");
  button.disabled = true;
  try {
    const changes = [];
    if (seedChanged()) changes.push({ path: SEED_PATH, json: workingSeed });
    if (overridesChanged()) changes.push({ path: OVERRIDES_PATH, json: workingOverrides });
    if (promosChanged()) changes.push({ path: PROMOS_PATH, json: workingPromos });
    if (sourcesChanged()) changes.push({ path: SOURCES_PATH, json: workingSources });
    if (changes.length) {
      status("Committing all edits atomically…");
      loadedHead = await commitFilesAtomically(gh, REPO, BRANCH, loadedHead, changes);
      // Reload immutable files from the committed head; failed dispatch can be retried.
      files.seed = await loadFile(SEED_PATH); files.overrides = await loadFile(OVERRIDES_PATH);
      files.promos = await loadFile(PROMOS_PATH); files.sources = await loadFile(SOURCES_PATH);
    }
    status("Dispatching catalog rebuild…");
    await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST", body: JSON.stringify({ ref: BRANCH }),
    });
    refresh();
    status("Committed. Watching the rebuild — the status line below updates when it finishes.", "ok");
    setBuild("run", "dispatched, waiting for GitHub to pick it up…");
    followBuild(Date.now());
  } catch (error) {
    status(error.message, "err");
  } finally {
    button.disabled = false;
  }
};
