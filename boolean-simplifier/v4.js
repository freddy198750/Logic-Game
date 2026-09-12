(() => {
  "use strict";
  const uploadInput = document.getElementById("imageInput");
  const cameraInput = document.getElementById("cameraInput");
  const clearBtn = document.getElementById("clearBtn");
  const ocrStatus = document.getElementById("ocrStatus");
  const batchResults = document.getElementById("batchResults");
  const previewWrap = document.getElementById("previewWrap");
  const preview = document.getElementById("preview");

  // The existing OCR engine reads #imageInput. Keep that engine unchanged and
  // mirror a newly captured camera file into the upload input before OCR runs.
  cameraInput?.addEventListener("change", () => {
    const file = cameraInput.files?.[0];
    if (!file || !uploadInput) return;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      uploadInput.files = dt.files;
      uploadInput.dispatchEvent(new Event("change", { bubbles: true }));
      if (ocrStatus) ocrStatus.textContent = "ถ่ายรูปแล้ว — กด “อ่านข้อความจากรูป”";
    } catch (err) {
      if (ocrStatus) ocrStatus.textContent = "เบราว์เซอร์นี้ส่งรูปจากกล้องเข้า OCR ไม่ได้ กรุณาใช้ “เลือกรูป” แทน";
    }
  });

  clearBtn?.addEventListener("click", () => {
    if (cameraInput) cameraInput.value = "";
    document.getElementById("circuitSourceOverlay")?.remove();
  });

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function shortLetterCandidate(name) {
    const s = String(name || "").trim();
    if (/^[A-Za-z]$/.test(s)) return s;
    // OCR often glues a stray character to a one-letter source label, e.g. "hy".
    // For short alphabetic tokens, the character nearest the wire is normally the last one.
    if (/^[A-Za-z]{2,3}$/.test(s)) return s[s.length - 1];
    return null;
  }

  function repairConsecutiveInputNames(rawNames) {
    if (!Array.isArray(rawNames) || rawNames.length < 3 || rawNames.length > 10) return null;
    const chars = rawNames.map(shortLetterCandidate);
    const baseCounts = new Map();
    chars.forEach((ch, i) => {
      if (!ch) return;
      const base = ch.toLowerCase().charCodeAt(0) - i;
      baseCounts.set(base, (baseCounts.get(base) || 0) + 1);
    });
    let bestBase = null, bestCount = 0;
    for (const [base, count] of baseCounts) {
      if (count > bestCount) { bestBase = base; bestCount = count; }
    }
    // Only repair when there is strong positional evidence of a sequence (w,x,y,z / a,b,c,d ...).
    if (bestBase == null || bestCount < Math.max(2, Math.ceil(rawNames.length * 0.6))) return null;
    const end = bestBase + rawNames.length - 1;
    if (bestBase < 97 || end > 122) return null;

    const hasLower = rawNames.some((s) => /[a-z]/.test(String(s)));
    const repaired = rawNames.map((_, i) => {
      const c = String.fromCharCode(bestBase + i);
      return hasLower ? c : c.toUpperCase();
    });
    const changed = repaired.some((v, i) => v !== rawNames[i]);
    return changed ? repaired : null;
  }

  function replaceTextTokens(root, pairs) {
    if (!root || !pairs.length) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      let text = node.nodeValue || "";
      for (const [from, to] of pairs) {
        if (!from || from === to) continue;
        const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(from)}(?=$|[^A-Za-z0-9_])`, "g");
        text = text.replace(re, (_, p1) => `${p1}${to}`);
      }
      node.nodeValue = text;
    }
  }

  async function detectInputWireRows(file, wanted) {
    if (!file || !wanted || wanted < 1) return [];
    try {
      const bitmap = "createImageBitmap" in window ? await createImageBitmap(file) : null;
      if (!bitmap) return [];
      const scale = Math.min(1, 1000 / bitmap.width);
      const W = Math.max(1, Math.round(bitmap.width * scale));
      const H = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, W, H);
      bitmap.close?.();
      const p = ctx.getImageData(0, 0, W, H).data;
      const maxX = Math.floor(W * 0.27);
      const minRun = Math.max(28, Math.floor(W * 0.055));
      const candidates = [];
      for (let y = 1; y < H - 1; y++) {
        let bestStart = -1, bestLen = 0, runStart = -1;
        for (let x = 0; x < maxX; x++) {
          const i = (y * W + x) * 4;
          const gray = .299 * p[i] + .587 * p[i + 1] + .114 * p[i + 2];
          const dark = gray < 105;
          if (dark && runStart < 0) runStart = x;
          if ((!dark || x === maxX - 1) && runStart >= 0) {
            const end = dark && x === maxX - 1 ? x + 1 : x;
            const len = end - runStart;
            if (len > bestLen) { bestLen = len; bestStart = runStart; }
            runStart = -1;
          }
        }
        if (bestLen >= minRun && bestStart >= Math.floor(W * 0.025)) {
          candidates.push({ y, x: bestStart, len: bestLen });
        }
      }
      const merged = [];
      for (const c of candidates) {
        const last = merged[merged.length - 1];
        if (last && c.y - last.y2 <= Math.max(3, H * .006)) {
          last.y2 = c.y;
          if (c.len > last.len) { last.y = c.y; last.x = c.x; last.len = c.len; }
        } else merged.push({ ...c, y2: c.y });
      }
      const ranked = merged
        .filter(c => c.y > H * .03 && c.y < H * .94)
        .sort((a, b) => a.x - b.x || b.len - a.len)
        .slice(0, Math.min(18, wanted * 4));
      const chosen = [];
      for (const c of ranked.sort((a, b) => a.y - b.y)) {
        if (chosen.every(v => Math.abs(v.y - c.y) > H * .055)) chosen.push(c);
      }
      if (chosen.length < wanted) return [];
      return chosen.slice(0, wanted).map(c => ({ x: c.x / W, y: c.y / H }));
    } catch (_) {
      return [];
    }
  }

  async function overlayCorrectedNames(names) {
    if (!previewWrap || !preview || !names?.length) return;
    document.getElementById("circuitSourceOverlay")?.remove();
    const file = uploadInput?.files?.[0] || cameraInput?.files?.[0];
    const points = await detectInputWireRows(file, names.length);
    if (points.length !== names.length) return;

    previewWrap.style.position = "relative";
    const layer = document.createElement("div");
    layer.id = "circuitSourceOverlay";
    layer.style.position = "absolute";
    layer.style.left = `${preview.offsetLeft}px`;
    layer.style.top = `${preview.offsetTop}px`;
    layer.style.width = `${preview.clientWidth}px`;
    layer.style.height = `${preview.clientHeight}px`;
    layer.style.pointerEvents = "none";
    layer.style.zIndex = "4";

    points.forEach((pt, i) => {
      const s = document.createElement("span");
      s.textContent = names[i];
      s.style.position = "absolute";
      s.style.left = `${Math.max(1, pt.x * 100 - 4.2)}%`;
      s.style.top = `${pt.y * 100}%`;
      s.style.transform = "translateY(-55%)";
      s.style.padding = "0 3px";
      s.style.borderRadius = "4px";
      s.style.background = "rgba(255,255,255,.96)";
      s.style.color = "#118a4e";
      s.style.font = "800 clamp(11px, 2vw, 16px) system-ui";
      layer.appendChild(s);
    });
    previewWrap.appendChild(layer);
  }

  let repairing = false;
  async function repairCircuitLabelsIfNeeded() {
    if (repairing || !batchResults || batchResults.hidden) return;
    const inputStrong = batchResults.querySelector(".circuit-summary span:first-child strong");
    if (!inputStrong) return;
    const raw = inputStrong.textContent.split(",").map(s => s.trim()).filter(Boolean);
    const repaired = repairConsecutiveInputNames(raw);
    if (!repaired) return;

    repairing = true;
    const pairs = raw.map((v, i) => [v, repaired[i]]);
    replaceTextTokens(batchResults, pairs);
    if (ocrStatus) {
      let text = ocrStatus.textContent || "";
      for (const [from, to] of pairs) {
        const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(from)}(?=$|[^A-Za-z0-9_])`, "g");
        text = text.replace(re, (_, p1) => `${p1}${to}`);
      }
      ocrStatus.textContent = text;
    }
    await overlayCorrectedNames(repaired);
    repairing = false;
  }

  // Circuit V9 runs after this script. Observe its result/status changes and then
  // repair obvious OCR outliers using the vertical order of input wires.
  const observer = new MutationObserver(() => {
    window.setTimeout(repairCircuitLabelsIfNeeded, 30);
  });
  if (ocrStatus) observer.observe(ocrStatus, { childList: true, characterData: true, subtree: true });
  if (batchResults) observer.observe(batchResults, { childList: true, characterData: true, subtree: true });
})();