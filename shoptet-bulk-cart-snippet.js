/**
 * Shoptet Bulk Cart Helper (client-side only, no private API token).
 *
 * Features:
 * - Floating FAB button -> native-like drawer panel
 * - Add products by codes (comma/newline)
 * - Search inside panel: click result adds item to bulk draft (no detail page open)
 * - Quantity controls per row before inserting into cart
 * - Silent addToCart (without extended popup): shoptet.cartShared.addToCart(payload, true)
 * - Session persistence (draft survives refresh in same browser tab)
 */
(function shoptetBulkCartNative() {
  if (typeof window === "undefined") return;
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", shoptetBulkCartNative, { once: true });
    return;
  }

  const ROOT_ID = "shoptet-bulk-cart-root";
  const ENTRY_HOST_ID = "shoptet-bulk-entry-host";
  const FAB_ID = "shoptet-bulk-cart-fab";
  const DRAWER_ID = "shoptet-bulk-cart-drawer";
  const STORAGE_KEY = "shoptet-bulk-cart-v2";
  const STYLE_ID = "shoptet-bulk-cart-style";
  const VERSION = "2026-04-21-overlay-center";

  const existingRoot = document.getElementById(ROOT_ID);
  if (existingRoot) existingRoot.remove();
  const existingEntryHost = document.getElementById(ENTRY_HOST_ID);
  if (existingEntryHost) existingEntryHost.remove();
  const existingStyle = document.getElementById(STYLE_ID);
  if (existingStyle) existingStyle.remove();

  const origin = location.origin;
  let idSeq = 0;
  let searchTimer = null;
  let searchAbortController = null;
  /** @type {{id:string, code:string, qty:number, title:string, href:string, img:string, unitPrice:string, avail:string, stockCount:number|null, resolved:boolean, invalid:boolean, suggestion:{code:string,title:string}|null}[]} */
  let draftItems = [];

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function normalizeSpace(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function parseCodes(raw) {
    return String(raw || "")
      .split(/[\s,;]+/u)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function normalizeHeader(header) {
    return normalizeSpace(header)
      .replace(/^\uFEFF/, "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "");
  }

  function parseDelimitedLine(line, delimiter) {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((x) => normalizeSpace(x));
  }

  function parseCsvToMatrix(text) {
    const lines = String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .filter((x) => normalizeSpace(x).length > 0);
    if (!lines.length) return [];
    const sample = lines.slice(0, 4).join("\n");
    const counts = {
      ";": (sample.match(/;/g) || []).length,
      ",": (sample.match(/,/g) || []).length,
      "\t": (sample.match(/\t/g) || []).length,
    };
    const delimiter = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    return lines.map((line) => parseDelimitedLine(line, delimiter));
  }

  function matrixToCodeEntries(matrix) {
    if (!matrix.length) return { entries: [], rowErrors: [] };
    const firstRow = (matrix[0] || []).map((x) => normalizeHeader(x));
    const codeHeaderAliases = ["kod", "code", "sku", "produktkod", "productcode", "itemcode"];
    const qtyHeaderAliases = ["pocet", "qty", "quantity", "mnozstvo", "amount", "ks", "kusy"];
    const hasHeader = codeHeaderAliases.includes(firstRow[0]) && qtyHeaderAliases.includes(firstRow[1]);
    const startIdx = hasHeader ? 1 : 0;
    const entries = [];
    const rowErrors = [];

    for (let i = startIdx; i < matrix.length; i += 1) {
      const row = matrix[i] || [];
      const code = normalizeSpace(row[0] || "");
      const rawQty = normalizeSpace(row[1] || "");
      if (!code && !rawQty) continue;
      if (!code) {
        rowErrors.push(`Riadok ${i + 1}: chýba kód v stĺpci A.`);
        continue;
      }
      if (!rawQty) {
        rowErrors.push(`Riadok ${i + 1}: chýba počet v stĺpci B.`);
        continue;
      }
      // Povolené sú iba pevné celé kladné čísla (bez desatiniek).
      if (!/^[1-9]\d*$/.test(rawQty)) {
        rowErrors.push(`Riadok ${i + 1}: počet "${rawQty}" nie je celé kladné číslo.`);
        continue;
      }
      entries.push({ code, qty: Number.parseInt(rawQty, 10) });
    }

    return { entries, rowErrors };
  }

  function parseStockCount(availText) {
    const m = normalizeSpace(availText).match(/\((\d+)\s*ks\)/i);
    return m ? Number.parseInt(m[1], 10) : null;
  }

  function normalizeUnitPriceText(priceText) {
    return normalizeSpace(priceText).replace(/\s*\/\s*ks$/i, "").replace(/\s*za\s*ks$/i, "").trim();
  }

  function parseUnitPriceSk(unitStr) {
    const s = (unitStr || "").replace(/\u00a0/g, " ");
    const m = s.match(/(\d[\d\s]*[,.]\d{2})/);
    if (!m) return NaN;
    return Number.parseFloat(m[1].replace(/\s/g, "").replace(",", "."));
  }

  function levenshtein(a, b) {
    const x = String(a || "");
    const y = String(b || "");
    if (!x.length) return y.length;
    if (!y.length) return x.length;
    const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
    for (let i = 0; i <= x.length; i += 1) dp[i][0] = i;
    for (let j = 0; j <= y.length; j += 1) dp[0][j] = j;
    for (let i = 1; i <= x.length; i += 1) {
      for (let j = 1; j <= y.length; j += 1) {
        const cost = x[i - 1] === y[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[x.length][y.length];
  }

  function formatLineTotal(unitStr, qty) {
    const n = parseUnitPriceSk(unitStr);
    if (Number.isNaN(n)) return "—";
    return (
      "€" +
      (n * qty).toLocaleString("sk-SK", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    ).replace(/\u00a0/g, " ");
  }

  function nextId() {
    idSeq += 1;
    return "i" + String(idSeq);
  }

  function saveState() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draftItems));
    } catch (_e) {
      // ignore storage errors
    }
  }

  function loadState() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((x) => x && typeof x.code === "string")
        .map((x) => ({
          id: typeof x.id === "string" ? x.id : nextId(),
          code: String(x.code || "").trim(),
          qty: Math.max(1, Number.parseInt(String(x.qty || 1), 10) || 1),
          title: String(x.title || `Produkt · ${x.code || ""}`),
          href: String(x.href || ""),
          img: String(x.img || ""),
          unitPrice: normalizeUnitPriceText(x.unitPrice || ""),
          avail: String(x.avail || ""),
          stockCount: typeof x.stockCount === "number" ? x.stockCount : parseStockCount(x.avail || ""),
          resolved: !!x.resolved,
          invalid: !!x.invalid,
          suggestion:
            x.suggestion && x.suggestion.code
              ? { code: String(x.suggestion.code), title: String(x.suggestion.title || x.suggestion.code) }
              : null,
        }));
    } catch (_e) {
      return [];
    }
  }

  function findByCode(code) {
    const c = String(code || "").trim().toUpperCase();
    return draftItems.find((x) => x.code.toUpperCase() === c) || null;
  }

  function mergeEntriesByCode(entries) {
    const map = new Map();
    for (const it of entries || []) {
      const code = normalizeSpace(it.code || "");
      const qty = Math.max(1, Number.parseInt(String(it.qty || 1), 10) || 1);
      if (!code) continue;
      const key = code.toUpperCase();
      const prev = map.get(key);
      if (prev) prev.qty += qty;
      else map.set(key, { code, qty });
    }
    return Array.from(map.values());
  }

  function ingestEntriesWithoutLookup(entries) {
    const merged = mergeEntriesByCode(entries);
    for (const { code, qty } of merged) {
      const existing = findByCode(code);
      if (existing) {
        existing.qty = Math.max(1, existing.qty + qty);
        continue;
      }
      upsertDraftItem({
        id: nextId(),
        code,
        qty,
        title: `Produkt · ${code}`,
        href: "",
        img: "",
        unitPrice: "",
        avail: "Neoverené",
        stockCount: null,
        resolved: false,
        invalid: false,
        suggestion: null,
      });
    }
    renderDraftList();
    return merged;
  }

  async function validateImportedCodes(mergedEntries) {
    const invalidCodes = [];
    let lookupErrors = 0;
    const maxToValidate = 300;
    const toValidate = mergedEntries.slice(0, maxToValidate);
    for (let i = 0; i < toValidate.length; i += 1) {
      const { code } = toValidate[i];
      let meta = null;
      let lookupFailed = false;
      try {
        meta = await resolveCodeToMeta(code);
      } catch (_e) {
        lookupFailed = true;
      }
      const row = findByCode(code);
      if (!row) continue;
      if (lookupFailed) {
        lookupErrors += 1;
        row.invalid = false;
        row.resolved = false;
        row.avail = "Neoverené";
        row.suggestion = null;
        continue;
      }
      if (meta && meta.status === "exact" && meta.item) {
        row.title = meta.item.title || row.title;
        row.href = meta.item.href || row.href;
        row.img = meta.item.img || row.img;
        row.unitPrice = normalizeUnitPriceText(meta.item.unitPrice || row.unitPrice);
        row.avail = meta.item.avail || row.avail;
        row.stockCount = typeof meta.item.stockCount === "number" ? meta.item.stockCount : row.stockCount;
        row.resolved = true;
        row.invalid = false;
        row.suggestion = null;
      } else {
        row.invalid = true;
        row.resolved = false;
        row.avail = "";
        row.suggestion = meta && meta.suggestion ? meta.suggestion : null;
        invalidCodes.push(code);
      }
      if ((i + 1) % 25 === 0) renderDraftList();
      await sleep(15);
    }
    renderDraftList();
    return {
      invalidCodes,
      lookupErrors,
      validatedCount: toValidate.length,
      skippedCount: Math.max(0, mergedEntries.length - toValidate.length),
    };
  }

  function upsertDraftItem(item) {
    const existing = findByCode(item.code);
    if (existing) {
      existing.qty = Math.max(1, existing.qty + (item.qty || 1));
      if (item.resolved) {
        existing.title = item.title || existing.title;
        existing.href = item.href || existing.href;
        existing.img = item.img || existing.img;
        existing.unitPrice = normalizeUnitPriceText(item.unitPrice || existing.unitPrice);
        existing.avail = item.avail || existing.avail;
        existing.stockCount = typeof item.stockCount === "number" ? item.stockCount : existing.stockCount;
        existing.resolved = true;
        existing.invalid = !!item.invalid;
        existing.suggestion = item.suggestion || null;
      }
      return existing;
    }
    const row = {
      id: item.id || nextId(),
      code: String(item.code || "").trim(),
      qty: Math.max(1, Number.parseInt(String(item.qty || 1), 10) || 1),
      title: item.title || `Produkt · ${item.code || ""}`,
      href: item.href || "",
      img: item.img || "",
      unitPrice: normalizeUnitPriceText(item.unitPrice || ""),
      avail: item.avail || "",
      stockCount: typeof item.stockCount === "number" ? item.stockCount : parseStockCount(item.avail || ""),
      resolved: !!item.resolved,
      invalid: !!item.invalid,
      suggestion: item.suggestion || null,
    };
    draftItems.push(row);
    return row;
  }

  function renderAvailability(item) {
    if (item.invalid) return { text: "Pravdepodobne zlý kód", cls: "err" };
    if (typeof item.stockCount === "number") return { text: `Sklad: ${item.stockCount} ks`, cls: "in-stock" };
    const a = normalizeSpace(item.avail);
    if (!a) return { text: "Údaje nedostupné", cls: "muted" };
    if (/skladom|na\s+sklade/i.test(a)) return { text: a, cls: "in-stock" };
    if (/dotaz|objedn|vypredan|nedostup/i.test(a)) return { text: a, cls: "warn" };
    return { text: a, cls: "muted" };
  }

  async function fetchSearchResults(query, signal) {
    const q = normalizeSpace(query);
    if (!q || q.length < 2) return [];
    const url = `${origin}/vyhladavanie/?string=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "text/html" },
      signal,
    });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const cards = Array.from(doc.querySelectorAll("#products-found .product")).slice(0, 12);
    const products = cards
      .map((card) => {
        const nameLink =
          card.querySelector(".name, .p-name a, .p-in a[href]") || card.querySelector("a[href]");
        const name = normalizeSpace(nameLink ? nameLink.textContent : "");
        const hrefRaw = nameLink ? nameLink.getAttribute("href") || "" : "";
        const href = hrefRaw.startsWith("http")
          ? hrefRaw
          : hrefRaw.startsWith("/")
            ? origin + hrefRaw
            : hrefRaw
              ? origin + "/" + hrefRaw
              : "";
        const imgEl = card.querySelector(".image img") || card.querySelector("img");
        const imgRaw = imgEl ? imgEl.getAttribute("data-src") || imgEl.getAttribute("src") || "" : "";
        const img = imgRaw && !imgRaw.startsWith("http") ? origin + (imgRaw.startsWith("/") ? "" : "/") + imgRaw : imgRaw;
        const text = normalizeSpace(card.textContent || "");
        const codeMatch = text.match(
          /(?:Kód|Kod|Obj\.\s*č\.|Obj\.\s*c\.|k[oó]d\s*v[ýy]robcu)\s*:?\s*([A-Z0-9][A-Z0-9\-\/.]*)/i
        );
        const code = codeMatch ? codeMatch[1] : "";
        const priceEl =
          card.querySelector(".price-final") ||
          card.querySelector(".price .standard") ||
          card.querySelector(".prices") ||
          card.querySelector(".price");
        const unitPrice = normalizeUnitPriceText(priceEl ? priceEl.textContent : "");
        const avEl = card.querySelector(".availability") || card.querySelector(".avail");
        const avail = normalizeSpace(avEl ? avEl.textContent : "");
        const stockCount = parseStockCount(avail);
        if (!name || !code) return null;
        return {
          code,
          title: name,
          href,
          img,
          unitPrice,
          avail,
          stockCount,
          resolved: true,
          invalid: false,
          suggestion: null,
        };
      })
      .filter(Boolean);
    return products;
  }

  async function resolveCodeToMeta(code) {
    const q = normalizeSpace(code);
    if (!q) return null;
    const queryCandidates = [q];
    const compact = q.replace(/[^A-Za-z0-9]/g, "");
    if (compact && compact !== q) queryCandidates.push(compact);
    const token = q.split(/[-./]/)[0];
    if (token && token.length >= 3) queryCandidates.push(token);
    if (/^\d+$/.test(q) && q.length >= 4) queryCandidates.push(q.slice(0, 4));

    /** @type {Array<any>} */
    const allHits = [];
    for (const query of Array.from(new Set(queryCandidates))) {
      const hits = await fetchSearchResults(query);
      hits.forEach((h) => {
        const key = String(h.code || "").toUpperCase();
        if (!allHits.some((x) => String(x.code || "").toUpperCase() === key)) allHits.push(h);
      });
      if (allHits.length > 20) break;
    }

    const exact = allHits.find((x) => String(x.code || "").toUpperCase() === q.toUpperCase());
    if (exact) return { status: "exact", item: exact, suggestion: null };

    if (!allHits.length) return { status: "invalid", item: null, suggestion: null };
    let best = allHits[0];
    let bestScore = levenshtein(q.toUpperCase(), String(best.code || "").toUpperCase());
    for (const h of allHits.slice(1)) {
      const score = levenshtein(q.toUpperCase(), String(h.code || "").toUpperCase());
      if (score < bestScore) {
        best = h;
        bestScore = score;
      }
    }
    return {
      status: "invalid",
      item: null,
      suggestion: best ? { code: best.code, title: best.title } : null,
    };
  }

  let xlsxLoaderPromise = null;
  function ensureXlsxLoader() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxLoaderPromise) return xlsxLoaderPromise;
    xlsxLoaderPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.async = true;
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => reject(new Error("Nepodarilo sa načítať XLSX parser."));
      document.head.appendChild(s);
    });
    return xlsxLoaderPromise;
  }

  async function parseImportFile(file) {
    const name = String(file && file.name ? file.name : "").toLowerCase();
    if (!file) return { entries: [], rowErrors: [] };
    if (name.endsWith(".csv")) {
      const text = await file.text();
      return matrixToCodeEntries(parseCsvToMatrix(text));
    }
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      const XLSX = await ensureXlsxLoader();
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const firstSheetName = wb.SheetNames[0];
      const ws = wb.Sheets[firstSheetName];
      const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
      return matrixToCodeEntries(matrix);
    }
    throw new Error("Podporované formáty sú CSV, XLSX, XLS.");
  }

  function downloadCsvTemplate() {
    // ";" delimiter kvôli Excel lokalizácii (SK/CZ), aby bol kód v A a počet v B.
    const csv = ["kod;pocet", "120853;2", "193886;1"].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bulk_objednavanie_sablona.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
#${ROOT_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483643;
  pointer-events: none;
}
#${ROOT_ID}.open {
  pointer-events: auto;
}
#${ROOT_ID}, #${ROOT_ID} * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
#${ENTRY_HOST_ID} {
  display: flex;
  width: 100%;
  justify-content: flex-end;
  align-items: center;
  margin: 0 0 14px 0;
}
#${FAB_ID} {
  position: relative; z-index: 2147483644;
  border: none; border-radius: 10px; background: #111827; color: #fff; font-weight: 700;
  cursor: pointer; box-shadow: 0 8px 20px rgba(0,0,0,.18); font-size: 14px;
  transition: transform .2s ease, box-shadow .2s ease, background .2s ease;
  height: 40px; padding: 0 14px; display: inline-flex; align-items: center; gap: 8px;
}
#${FAB_ID}:hover { background: #0b1220; transform: translateY(-1px); box-shadow: 0 12px 24px rgba(0,0,0,.24); }
.bulk-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483644;
  background: rgba(15, 23, 42, 0.55);
  opacity: 0;
  visibility: hidden;
  transition: opacity .22s ease, visibility .22s ease;
}
#${ROOT_ID}.open .bulk-overlay {
  opacity: 1;
  visibility: visible;
}
#${DRAWER_ID} {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%) scale(.985);
  width: min(980px, calc(100vw - 32px));
  max-width: min(980px, calc(100vw - 32px));
  max-height: min(92dvh, 92vh);
  --bulk-bg: #ffffff;
  --bulk-surface: #f8fafc;
  --bulk-border: #e2e8f0;
  --bulk-text: #0f172a;
  --bulk-muted: #64748b;
  --bulk-accent: #111827;
  --bulk-accent-strong: #020617;
  --bulk-success: #15803d;
  --bulk-danger: #b91c1c;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  z-index: 2147483645;
  box-shadow: 0 24px 64px rgba(0,0,0,.28);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity .22s ease, transform .22s ease, visibility .22s ease;
}
#${ROOT_ID}.open #${DRAWER_ID} {
  opacity: 1;
  visibility: visible;
  transform: translate(-50%, -50%) scale(1);
  pointer-events: auto;
}
.bulk-head { flex-shrink: 0; padding: 12px 14px; border-bottom: 1px solid #f1f5f9; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.bulk-head-title { font-weight: 700; font-size: clamp(18px, 1.8vw, 22px); color: var(--bulk-text); line-height: 1.2; letter-spacing: -0.01em; }
.bulk-head-sub { font-size: 12px; color: var(--bulk-muted); margin-top: 2px; line-height: 1.35; }
.bulk-head-actions { display: flex; gap: 8px; }
.bulk-btn { border: 1px solid #d1d5db; background: #fff; border-radius: 8px; padding: 8px 11px; font-size: 13px; cursor: pointer; color: var(--bulk-text); transition: background .16s ease, border-color .16s ease, color .16s ease, transform .16s ease; }
.bulk-btn:hover { background: var(--bulk-surface); transform: translateY(-1px); }
.bulk-btn:active { transform: translateY(0); }
.bulk-btn.primary { background: var(--bulk-accent); color: #fff; border-color: var(--bulk-accent); }
.bulk-btn.green { background: #16a34a; color: #fff; border-color: #16a34a; }
.bulk-file-wrap { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bulk-file-label { display: inline-flex; align-items: center; position: relative; overflow: hidden; }
.bulk-file-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}
.bulk-content {
  padding: 12px 14px;
  display: grid;
  grid-template-columns: 1.1fr 1fr;
  gap: 14px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  background: var(--bulk-bg);
}
@media (max-width: 880px) { .bulk-content { grid-template-columns: 1fr; } }
.bulk-card { border: 1px solid var(--bulk-border); border-radius: 10px; overflow: hidden; background: #fff; }
.bulk-card-head { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; font-size: 13px; font-weight: 700; color: var(--bulk-text); background: #fafafa; }
.bulk-card-body { padding: 10px 12px; }
.bulk-help { font-size: 12px; color: var(--bulk-muted); line-height: 1.45; margin-bottom: 8px; }
.bulk-input, .bulk-textarea {
  width: 100%;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 14px;
  padding: 9px 10px;
  color: var(--bulk-text);
  background: #fff;
  transition: border-color .16s ease, box-shadow .16s ease;
}
.bulk-input {
  max-height: 120px;
  overflow-x: auto;
  overflow-y: auto;
  word-break: break-word;
}
.bulk-textarea {
  min-height: 78px;
  max-height: 240px;
  overflow-x: hidden;
  overflow-y: auto;
  resize: vertical;
}
.bulk-inline { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
.bulk-search-results { margin-top: 8px; max-height: 210px; overflow: auto; border: 1px solid #e5e7eb; border-radius: 8px; }
.bulk-result { display: grid; grid-template-columns: 48px 1fr auto; gap: 10px; align-items: center; padding: 8px 9px; border-bottom: 1px solid #f1f5f9; cursor: pointer; }
.bulk-result:last-child { border-bottom: none; }
.bulk-result:hover { background: var(--bulk-surface); }
.bulk-result img { width: 44px; height: 44px; object-fit: contain; background: #f8fafc; border-radius: 6px; }
.bulk-result-title { font-size: 13px; font-weight: 600; color: var(--bulk-text); }
.bulk-result-meta { font-size: 12px; color: var(--bulk-muted); margin-top: 2px; }
.bulk-result-code { font-size: 12px; font-weight: 700; color: #334155; }
.bulk-list { max-height: 340px; overflow: auto; }
.bulk-row { display: grid; grid-template-columns: 52px 1fr auto auto auto; gap: 10px; align-items: center; padding: 9px 10px; border-bottom: 1px solid #f8fafc; }
.bulk-row.warn { background: #fffbeb; }
.bulk-row.invalid { background: #fff1f2; border-left: 3px solid #ef4444; }
.bulk-row img { width: 44px; height: 44px; object-fit: contain; background: #f8fafc; border-radius: 6px; }
.bulk-row-title { font-size: 13px; font-weight: 600; color: var(--bulk-text); line-height: 1.35; }
.bulk-row-code { font-size: 12px; color: var(--bulk-muted); }
.bulk-row-note { margin-top: 2px; font-size: 12px; color: #b91c1c; font-weight: 600; }
.bulk-row-suggest { margin-top: 2px; font-size: 12px; color: #be123c; }
.bulk-row-suggest button { border: none; background: transparent; color: #be123c; text-decoration: underline; cursor: pointer; padding: 0; font-size: 12px; }
.bulk-avail { font-size: 12px; font-weight: 600; text-align: right; min-width: 106px; }
.bulk-avail.in-stock { color: var(--bulk-success); }
.bulk-avail.warn { color: var(--bulk-text); }
.bulk-avail.muted { color: var(--bulk-muted); font-weight: 500; }
.bulk-avail.err { color: var(--bulk-danger); }
.bulk-qty { display: inline-flex; align-items: center; border: 1px solid #d1d5db; border-radius: 8px; overflow: hidden; }
.bulk-qty button { width: 29px; height: 32px; border: none; background: #f8fafc; cursor: pointer; font-size: 18px; color: var(--bulk-text); }
.bulk-qty input { width: 46px; height: 32px; border: none; text-align: center; font-size: 13px; }
.bulk-price { text-align: right; min-width: 118px; }
.bulk-price-unit { font-size: 12px; color: var(--bulk-muted); }
.bulk-price-line { font-size: 14px; font-weight: 700; color: var(--bulk-text); margin-top: 1px; }
.bulk-remove { border: none; background: transparent; color: #6b7280; cursor: pointer; font-size: 18px; padding: 4px; }
.bulk-remove:hover { color: var(--bulk-danger); }
.bulk-footer { flex-shrink: 0; border-top: 1px solid #f1f5f9; padding: 10px 14px; display: flex; justify-content: space-between; gap: 10px; align-items: center; flex-wrap: wrap; background: #fafafa; }
.bulk-log { font-size: 12px; color: #374151; white-space: pre-wrap; max-height: 120px; overflow: auto; line-height: 1.35; }
.bulk-badge { display: inline-block; min-width: 20px; padding: 1px 6px; border-radius: 999px; background: #ef4444; color: #fff; font-size: 11px; margin-left: 5px; vertical-align: middle; text-align: center; }
.bulk-btn:focus-visible,
.bulk-input:focus-visible,
.bulk-textarea:focus-visible,
.bulk-qty button:focus-visible,
.bulk-qty input:focus-visible,
.bulk-remove:focus-visible,
.bulk-row-suggest button:focus-visible {
  outline: 2px solid var(--bulk-accent-strong);
  outline-offset: 2px;
}
.bulk-input:focus-visible,
.bulk-textarea:focus-visible {
  border-color: #334155;
  box-shadow: 0 0 0 2px rgba(51, 65, 85, 0.16);
}
@media (max-width: 980px) {
  #${ENTRY_HOST_ID} { justify-content: stretch; margin-bottom: 10px; }
  #${FAB_ID} { width: 100%; justify-content: center; font-size: 14px; }
  #${DRAWER_ID} {
    width: calc(100vw - 20px);
    max-width: calc(100vw - 20px);
    max-height: min(92dvh, 92vh);
    border-radius: 14px;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .bulk-content { grid-template-columns: 1fr; }
  .bulk-row {
    grid-template-columns: 44px 1fr auto;
    grid-template-areas:
      "img info remove"
      "img avail avail"
      "img qty price";
    gap: 6px 8px;
    align-items: center;
    padding: 10px 8px;
  }
  .bulk-row > :nth-child(1) { grid-area: img; }
  .bulk-row > :nth-child(2) { grid-area: info; min-width: 0; }
  .bulk-row > :nth-child(3) { grid-area: avail; text-align: left; min-width: 0; }
  .bulk-row > :nth-child(4) { grid-area: qty; justify-self: start; }
  .bulk-row > :nth-child(5) { grid-area: price; text-align: right; min-width: 90px; justify-self: end; }
  .bulk-row > :nth-child(6) { grid-area: remove; justify-self: end; align-self: start; }
  .bulk-row-title { font-size: 12.5px; line-height: 1.28; }
  .bulk-row-code { font-size: 11.5px; }
  .bulk-row-note, .bulk-row-suggest { font-size: 11.5px; }
  .bulk-avail { font-size: 11.5px; line-height: 1.2; }
  .bulk-price-unit { font-size: 11px; }
  .bulk-price-line { font-size: 14px; }
  .bulk-qty button { width: 28px; height: 30px; }
  .bulk-qty input { width: 42px; height: 30px; font-size: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  #${FAB_ID},
  #${DRAWER_ID},
  .bulk-btn,
  .bulk-result {
    transition: none !important;
    animation: none !important;
  }
}
`;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = ROOT_ID;

  const fab = document.createElement("button");
  fab.id = FAB_ID;
  fab.type = "button";
  fab.innerHTML = '🛒 <span>Bulk objednávanie</span><span class="bulk-badge" style="display:none">0</span>';

  const drawer = document.createElement("section");
  drawer.id = DRAWER_ID;
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  drawer.setAttribute("aria-labelledby", "bulk-cart-dialog-title");
  drawer.innerHTML = `
    <div class="bulk-head">
      <div>
        <div class="bulk-head-title" id="bulk-cart-dialog-title">Bulk pridanie do košíka</div>
        <div class="bulk-head-sub">Náhľad položiek, úprava množstva a validácia kódov</div>
      </div>
      <div class="bulk-head-actions">
        <button type="button" class="bulk-btn" data-act="collapse">Schovať</button>
        <button type="button" class="bulk-btn" data-act="close">Zavrieť</button>
      </div>
    </div>
    <div class="bulk-content">
      <div class="bulk-card">
        <div class="bulk-card-head">Vyhľadanie produktu (pridať do draftu)</div>
        <div class="bulk-card-body">
          <div class="bulk-help">
            Napíšte názov alebo kód. Klik na výsledok pridá položku do draftu (neotvára detail produktu).
          </div>
          <input class="bulk-input" data-role="search-input" placeholder="napr. Eaton stykač 120853" />
          <div class="bulk-search-results" data-role="search-results"></div>
        </div>
      </div>
      <div class="bulk-card">
        <div class="bulk-card-head">Pridať podľa kódov</div>
        <div class="bulk-card-body">
          <div class="bulk-help">Kódy oddeľte čiarkou, medzerou alebo novým riadkom. Alebo nahrajte CSV/XLSX súbor (stĺpce: <strong>kod</strong>, <strong>pocet</strong>).</div>
          <textarea class="bulk-textarea" data-role="code-input" placeholder="120853, 193886, EP-502537"></textarea>
          <div class="bulk-inline">
            <button type="button" class="bulk-btn primary" data-act="codes-to-draft">Pridať kódy do draftu</button>
            <button type="button" class="bulk-btn" data-act="clear-codes">Vyčistiť pole</button>
            <button type="button" class="bulk-btn" data-act="download-template">Stiahnuť CSV šablónu</button>
            <label class="bulk-btn bulk-file-label bulk-file-wrap">
              Nahrať CSV/XLSX
              <input class="bulk-file-input" data-role="file-input" type="file" accept=".csv,.xlsx,.xls" />
            </label>
          </div>
        </div>
      </div>
      <div class="bulk-card" style="grid-column: 1 / -1;">
        <div class="bulk-card-head">Draft položiek pred vložením</div>
        <div class="bulk-list" data-role="draft-list"></div>
      </div>
    </div>
    <div class="bulk-footer">
      <div class="bulk-inline">
        <button type="button" class="bulk-btn" data-act="clear-draft">Vyčistiť draft</button>
        <button type="button" class="bulk-btn" data-act="add-valid">Pridať iba validné</button>
        <button type="button" class="bulk-btn green" data-act="add-all">Pridať do košíka</button>
      </div>
      <div class="bulk-log" data-role="log">Pripravené.</div>
    </div>
  `;

  const backdrop = document.createElement("div");
  backdrop.className = "bulk-overlay";
  backdrop.setAttribute("data-act", "backdrop");
  backdrop.setAttribute("aria-hidden", "true");
  root.appendChild(backdrop);
  root.appendChild(drawer);
  document.body.appendChild(root);

  const cartInner =
    document.querySelector('div.cart-inner[data-testid="tableCart"]') ||
    document.querySelector(".cart-inner") ||
    document.querySelector(".cart-content") ||
    document.querySelector("#content");
  const entryHost = document.createElement("div");
  entryHost.id = ENTRY_HOST_ID;
  const originalCartPaddingTop = cartInner
    ? Number.parseFloat(window.getComputedStyle(cartInner).paddingTop || "0") || 0
    : 0;
  if (cartInner) {
    cartInner.prepend(entryHost);
  } else {
    entryHost.style.position = "fixed";
    entryHost.style.left = "14px";
    entryHost.style.right = "14px";
    entryHost.style.bottom = "14px";
    entryHost.style.zIndex = "2147483644";
    document.body.appendChild(entryHost);
  }
  entryHost.appendChild(fab);

  function applyEntryHostLayout() {
    if (!cartInner) return;
    const currentPosition = window.getComputedStyle(cartInner).position;
    if (currentPosition === "static") cartInner.style.position = "relative";
    if (window.innerWidth <= 980) {
      cartInner.style.paddingTop = `${originalCartPaddingTop}px`;
      entryHost.style.position = "relative";
      entryHost.style.top = "auto";
      entryHost.style.right = "auto";
      entryHost.style.width = "100%";
      return;
    }
    cartInner.style.paddingTop = `${originalCartPaddingTop + 52}px`;
    entryHost.style.position = "absolute";
    entryHost.style.top = "8px";
    entryHost.style.right = "8px";
    entryHost.style.width = "auto";
  }

  const badgeEl = fab.querySelector(".bulk-badge");
  const searchInputEl = drawer.querySelector('[data-role="search-input"]');
  const searchResultsEl = drawer.querySelector('[data-role="search-results"]');
  const codeInputEl = drawer.querySelector('[data-role="code-input"]');
  const fileInputEl = drawer.querySelector('[data-role="file-input"]');
  const draftListEl = drawer.querySelector('[data-role="draft-list"]');
  const logEl = drawer.querySelector('[data-role="log"]');

  const fileLabelEl = drawer.querySelector(".bulk-file-label");

  function setLog(text) {
    logEl.textContent = String(text || "");
  }
  if (fileLabelEl && fileInputEl) {
    fileLabelEl.addEventListener("click", (e) => {
      // Default label->input activation usually works; this is a robust fallback.
      if (e.target === fileInputEl) return;
      try {
        if (typeof fileInputEl.showPicker === "function") {
          e.preventDefault();
          fileInputEl.showPicker();
          return;
        }
      } catch (_err) {
        // ignore and fallback to click()
      }
      try {
        e.preventDefault();
        fileInputEl.click();
      } catch (_err) {
        // ignore, browser blocked synthetic picker open
      }
    });
  }


  function updateBadge() {
    const count = draftItems.length;
    if (!badgeEl) return;
    badgeEl.textContent = String(count);
    badgeEl.style.display = count ? "inline-block" : "none";
  }

  function renderDraftList() {
    draftListEl.innerHTML = "";
    if (!draftItems.length) {
      draftListEl.innerHTML = '<div class="bulk-help" style="padding: 12px;">Draft je prázdny.</div>';
      updateBadge();
      saveState();
      return;
    }
    draftItems.forEach((it) => {
      const av = renderAvailability(it);
      const row = document.createElement("div");
      row.className = "bulk-row" + (it.invalid ? " invalid" : it.resolved ? "" : " warn");
      row.dataset.id = it.id;
      const note =
        it.invalid && it.suggestion
          ? `<div class="bulk-row-note">Kód je pravdepodobne nesprávny.</div><div class="bulk-row-suggest">Nemysleli ste náhodou <button type="button" data-act="use-suggest">${it.suggestion.code}</button>?</div>`
          : it.invalid
            ? '<div class="bulk-row-note">Kód je pravdepodobne nesprávny.</div>'
            : "";
      row.innerHTML = `
        <div>${it.img ? `<img src="${it.img}" alt="">` : ""}</div>
        <div>
          <div class="bulk-row-title">${it.title || `Produkt · ${it.code}`}</div>
          <div class="bulk-row-code">Kód: ${it.code}</div>
          ${note}
        </div>
        <div class="bulk-avail ${av.cls}">${av.text}</div>
        <div class="bulk-qty">
          <button type="button" data-act="minus">−</button>
          <input type="number" min="1" max="9999" value="${it.qty}" />
          <button type="button" data-act="plus">+</button>
        </div>
        <div class="bulk-price">
          <div class="bulk-price-unit">${it.unitPrice ? `${it.unitPrice} / ks` : "— / ks"}</div>
          <div class="bulk-price-line">${formatLineTotal(it.unitPrice, it.qty)}</div>
        </div>
      `;
      const removeBtn = document.createElement("button");
      removeBtn.className = "bulk-remove";
      removeBtn.type = "button";
      removeBtn.title = "Odstrániť";
      removeBtn.textContent = "🗑";
      removeBtn.addEventListener("click", () => {
        draftItems = draftItems.filter((x) => x.id !== it.id);
        renderDraftList();
      });
      row.appendChild(removeBtn);

      const qtyInput = row.querySelector("input[type='number']");
      const minus = row.querySelector('[data-act="minus"]');
      const plus = row.querySelector('[data-act="plus"]');
      const updateQty = () => {
        let q = Number.parseInt(String(qtyInput.value || "1"), 10);
        if (Number.isNaN(q) || q < 1) q = 1;
        qtyInput.value = String(q);
        it.qty = q;
        row.querySelector(".bulk-price-line").textContent = formatLineTotal(it.unitPrice, it.qty);
        saveState();
      };
      minus.addEventListener("click", () => {
        qtyInput.value = String(Math.max(1, (Number.parseInt(qtyInput.value, 10) || 1) - 1));
        updateQty();
      });
      plus.addEventListener("click", () => {
        qtyInput.value = String(Math.min(9999, (Number.parseInt(qtyInput.value, 10) || 1) + 1));
        updateQty();
      });
      qtyInput.addEventListener("change", updateQty);

      const suggestBtn = row.querySelector('[data-act="use-suggest"]');
      if (suggestBtn) {
        suggestBtn.addEventListener("click", () => {
          if (!it.suggestion) return;
          it.code = it.suggestion.code;
          it.title = it.suggestion.title || it.suggestion.code;
          it.invalid = false;
          it.suggestion = null;
          renderDraftList();
          setLog(`Použitý navrhnutý kód: ${it.code}`);
        });
      }

      draftListEl.appendChild(row);
    });
    updateBadge();
    saveState();
  }

  function renderSearchResults(results) {
    searchResultsEl.innerHTML = "";
    if (!results || !results.length) {
      searchResultsEl.innerHTML = '<div class="bulk-help" style="padding: 10px;">Žiadne výsledky.</div>';
      return;
    }
    results.forEach((r) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "bulk-result";
      const availLabel =
        typeof r.stockCount === "number" ? `Sklad: ${r.stockCount} ks` : r.avail || "Dostupnosť neznáma";
      row.innerHTML = `
        <div>${r.img ? `<img src="${r.img}" alt="">` : ""}</div>
        <div>
          <div class="bulk-result-title">${r.title}</div>
          <div class="bulk-result-meta">${availLabel} · ${r.unitPrice ? `${r.unitPrice} / ks` : "Cena neznáma"}</div>
        </div>
        <div class="bulk-result-code">${r.code}</div>
      `;
      row.addEventListener("click", () => {
        upsertDraftItem({ ...r, qty: 1, id: nextId() });
        renderDraftList();
        setLog(`Pridané do draftu: ${r.code}`);
      });
      searchResultsEl.appendChild(row);
    });
  }

  async function addCodeEntriesToDraft(entries, options = {}) {
    const { suppressFinalLog = false } = options;
    const normalizedEntries = mergeEntriesByCode(entries);
    if (!normalizedEntries.length) {
      if (!suppressFinalLog) setLog("Zadajte aspoň jeden kód.");
      return { total: 0, invalidCodes: [] };
    }

    setLog("Dopĺňam metadata z vyhľadávania...");
    const invalidCodes = [];
    for (const { code, qty } of normalizedEntries) {
      let meta = null;
      try {
        meta = await resolveCodeToMeta(code);
      } catch (_e) {
        meta = null;
      }
      if (meta && meta.status === "exact" && meta.item) {
        upsertDraftItem({ ...meta.item, code, qty, id: nextId(), invalid: false, suggestion: null });
      } else {
        invalidCodes.push(code);
        upsertDraftItem({
          id: nextId(),
          code,
          qty,
          title: `Produkt · ${code}`,
          href: "",
          img: "",
          unitPrice: "",
          avail: "",
          stockCount: null,
          resolved: false,
          invalid: true,
          suggestion: meta && meta.suggestion ? meta.suggestion : null,
        });
      }
      renderDraftList();
      await sleep(80);
    }
    if (!suppressFinalLog) {
      const invalidCount = draftItems.filter((x) => x.invalid).length;
      setLog(
        invalidCount
          ? `Kódy pridané do draftu. Pozor: ${invalidCount} položiek je označených ako pravdepodobne nesprávnych.`
          : "Kódy pridané do draftu."
      );
    }
    return { total: normalizedEntries.length, invalidCodes };
  }

  async function doSearch(query) {
    const q = normalizeSpace(query);
    if (q.length < 2) {
      searchResultsEl.innerHTML = '<div class="bulk-help" style="padding: 10px;">Napíšte aspoň 2 znaky.</div>';
      return;
    }
    searchResultsEl.innerHTML = '<div class="bulk-help" style="padding: 10px;">Hľadám...</div>';
    if (searchAbortController) searchAbortController.abort();
    searchAbortController = new AbortController();
    try {
      const results = await fetchSearchResults(q, searchAbortController.signal);
      renderSearchResults(results);
    } catch (e) {
      if (String(e || "").includes("AbortError")) return;
      searchResultsEl.innerHTML =
        '<div class="bulk-help" style="padding: 10px;color:#b91c1c;">Vyhľadávanie zlyhalo.</div>';
    }
  }

  function dismissCartPopup() {
    const closeBtn =
      document.querySelector("#colorbox .js-close-popup") ||
      document.querySelector("#colorbox .close, #colorbox .close-popup") ||
      document.querySelector(".popup-widget .js-close-popup");
    if (closeBtn && typeof closeBtn.click === "function") {
      closeBtn.click();
      return;
    }
    const colorbox = document.getElementById("colorbox");
    if (colorbox && colorbox.parentNode) {
      colorbox.style.display = "none";
    }
    const overlay = document.getElementById("cboxOverlay");
    if (overlay) overlay.style.display = "none";
  }

  async function addItemsToCart(itemsToAdd, clearAddedFromDraft) {
    if (!itemsToAdd.length) {
      setLog("Nie sú dostupné žiadne položky na pridanie.");
      return;
    }
    if (
      typeof shoptet === "undefined" ||
      !shoptet.cartShared ||
      typeof shoptet.cartShared.addToCart !== "function"
    ) {
      setLog("Pridanie do košíka nie je momentálne dostupné. Obnovte stránku a skúste znova.");
      return;
    }
    const addAllBtn = drawer.querySelector('[data-act="add-all"]');
    const addValidBtn = drawer.querySelector('[data-act="add-valid"]');
    addAllBtn.disabled = true;
    addValidBtn.disabled = true;
    const lines = [];
    for (const it of itemsToAdd) {
      try {
        shoptet.cartShared.addToCart({ productCode: it.code, amount: it.qty }, true);
        await sleep(180);
        dismissCartPopup();
        lines.push(`OK ${it.code} × ${it.qty}`);
      } catch (e) {
        lines.push(`Chyba ${it.code}: ${e && e.message ? e.message : e}`);
      }
      setLog(lines.join("\n"));
      await sleep(260);
    }
    lines.push("— hotovo —");
    setLog(lines.join("\n"));
    if (clearAddedFromDraft) {
      const addedCodes = new Set(itemsToAdd.map((x) => String(x.code || "").toUpperCase()));
      draftItems = draftItems.filter((x) => !addedCodes.has(String(x.code || "").toUpperCase()));
      renderDraftList();
    }
    addAllBtn.disabled = false;
    addValidBtn.disabled = false;
  }

  async function addAllToCart() {
    if (!draftItems.length) {
      setLog("Draft je prázdny.");
      return;
    }
    const invalid = draftItems.filter((x) => x.invalid);
    if (invalid.length) {
      setLog(`Najprv opravte alebo odstráňte položky s červeným stavom (${invalid.length}).`);
      return;
    }
    await addItemsToCart([...draftItems], true);
  }

  async function addOnlyValidToCart() {
    if (!draftItems.length) {
      setLog("Draft je prázdny.");
      return;
    }
    const valid = draftItems.filter((x) => !x.invalid);
    if (!valid.length) {
      setLog("V drafte nie sú žiadne validné položky.");
      return;
    }
    await addItemsToCart(valid, true);
  }

  let previousBodyOverflow = "";

  function openDrawer() {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    root.classList.add("open");
    drawer.classList.add("open");
  }
  function closeDrawer() {
    root.classList.remove("open");
    drawer.classList.remove("open");
    document.body.style.overflow = previousBodyOverflow || "";
  }

  function positionDrawer() {
    /* Centrovaný modal — žiadne inline pozície */
  }

  fab.addEventListener("click", () => {
    if (root.classList.contains("open")) closeDrawer();
    else openDrawer();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && root.classList.contains("open")) {
      e.preventDefault();
      closeDrawer();
    }
  });

  backdrop.addEventListener("click", () => {
    closeDrawer();
  });
  drawer.querySelector('[data-act="close"]').addEventListener("click", () => {
    closeDrawer();
  });
  drawer.querySelector('[data-act="collapse"]').addEventListener("click", () => {
    closeDrawer();
  });
  drawer.addEventListener("click", (e) => {
    e.stopPropagation();
  });
  drawer.querySelector('[data-act="clear-codes"]').addEventListener("click", () => {
    codeInputEl.value = "";
  });
  drawer.querySelector('[data-act="download-template"]').addEventListener("click", () => {
    downloadCsvTemplate();
  });
  drawer.querySelector('[data-act="codes-to-draft"]').addEventListener("click", async () => {
    const codes = parseCodes(codeInputEl.value);
    await addCodeEntriesToDraft(codes.map((code) => ({ code, qty: 1 })));
  });
  async function handleImportFileChange(e) {
    const file = e.target && e.target.files ? e.target.files[0] : null;
    if (!file) return;
    try {
      const { entries, rowErrors } = await parseImportFile(file);
      if (rowErrors.length) {
        setLog(`Import zlyhal. Opravte chyby v súbore:\n${rowErrors.slice(0, 8).join("\n")}`);
        return;
      }
      if (!entries.length) {
        setLog("Súbor neobsahuje platné riadky. Očakávané sú stĺpce: A=kod, B=pocet.");
      } else {
        const merged = ingestEntriesWithoutLookup(entries);
        setLog(`Súbor načítaný lokálne: ${merged.length} kódov. Overujem kódy...`);
        const verify = await validateImportedCodes(merged);
        if (verify.invalidCodes.length) {
          const uniq = Array.from(new Set(verify.invalidCodes.map((x) => x.toUpperCase())));
          const suffix =
            verify.skippedCount > 0
              ? `\nPoznámka: overených iba prvých ${verify.validatedCount} kódov (ďalších ${verify.skippedCount} čaká na manuálne overenie).`
              : "";
          const lookupWarn =
            verify.lookupErrors > 0
              ? `\nPoznámka: ${verify.lookupErrors} kódov sa nepodarilo overiť (sieť/timeout).`
              : "";
          setLog(
            `Import dokončený s chybou: neplatné kódy (${uniq.length})\n${uniq.slice(0, 12).join(", ")}${suffix}${lookupWarn}`
          );
        } else if (verify.skippedCount > 0) {
          setLog(
            `Import načítaný: ${merged.length} kódov. Overených prvých ${verify.validatedCount}, ďalších ${verify.skippedCount} zostalo neoverených.`
          );
        } else if (verify.lookupErrors > 0) {
          setLog(
            `Import načítaný: ${merged.length} kódov. Overenie nedokončené pre ${verify.lookupErrors} položiek (sieť/timeout).`
          );
        } else {
          setLog(`Import v poriadku: načítaných a overených ${merged.length} kódov.`);
        }
      }
    } catch (err) {
      setLog(`Import zlyhal: ${err && err.message ? err.message : err}`);
    } finally {
      if (e.target) e.target.value = "";
    }
  }

  fileInputEl.addEventListener("change", handleImportFileChange);
  drawer.querySelector('[data-act="clear-draft"]').addEventListener("click", () => {
    draftItems = [];
    renderDraftList();
    setLog("Draft vyčistený.");
  });
  drawer.querySelector('[data-act="add-all"]').addEventListener("click", async () => {
    await addAllToCart();
  });
  drawer.querySelector('[data-act="add-valid"]').addEventListener("click", async () => {
    await addOnlyValidToCart();
  });

  searchInputEl.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      doSearch(searchInputEl.value);
    }, 260);
  });
  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSearch(searchInputEl.value);
    }
  });

  draftItems = loadState();
  applyEntryHostLayout();
  renderDraftList();
  positionDrawer();
  window.addEventListener("resize", () => {
    applyEntryHostLayout();
    positionDrawer();
  });
  setLog("Pripravené. Otvorte panel cez tlačidlo Bulk objednávanie.");
  window.__shoptetBulkCartVersion = VERSION;
})();
