(() => {
  "use strict";

  const B = window.BooleanSimplifier;
  if (!B) return;

  const $ = (id) => document.getElementById(id);
  const formulaInput = $("formulaInput");
  const imageInput = $("imageInput");
  const ocrBtn = $("ocrBtn");
  const simplifyBtn = $("simplifyBtn");
  const clearBtn = $("clearBtn");
  const ocrStatus = $("ocrStatus");
  const ocrProgress = $("ocrProgress");
  const errorBox = $("errorBox");
  const emptyState = $("emptyState");
  const resultBox = $("resultBox");
  const resultFormula = $("resultFormula");
  const normalizedFormula = $("normalizedFormula");
  const resultMeta = $("resultMeta");
  let batchResults = $("batchResults");

  if (!batchResults && resultBox?.parentNode) {
    batchResults = document.createElement("div");
    batchResults.id = "batchResults";
    batchResults.className = "batch-results";
    batchResults.hidden = true;
    resultBox.parentNode.appendChild(batchResults);
  }

  const escapeHtml = (value) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  function normalizeOcrText(text) {
    return String(text ?? "")
      .normalize("NFKD")
      .replace(/[’‘`´′]/g, "'")
      .replace(/[\u0304\u0305]/g, "'")
      .replace(/[¬]/g, "!")
      .replace(/[∧×·∙]/g, "*")
      .replace(/[∨＋]/g, "+")
      .replace(/[⊕]/g, "^")
      .replace(/[⊙≡]/g, "@")
      .replace(/[−–—]/g, "-")
      .replace(/[£€]/g, "=")
      .replace(/%/g, "+")
      .replace(/[^A-Za-z0-9_+*|&!~'^@()\[\]=.\s-]/g, " ")
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
      .replace(/\|\|+/g, "|");
  }

  function splitExercises(input) {
    const lines = String(input ?? "").replace(/\r/g, "").split("\n")
      .map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return [];

    const out = [];
    let current = "";
    let number = null;
    const balance = (s) => [...s].reduce((n, ch) => n + (ch === "(" ? 1 : ch === ")" ? -1 : 0), 0);
    const flush = () => {
      if (current.trim()) out.push({ text: current.trim(), number });
      current = "";
      number = null;
    };

    for (const raw of lines) {
      const numbered = raw.match(/^\s*(\d+)\s*[.)-]\s*(.*)$/);
      const line = (numbered ? numbered[2] : raw).trim();
      if (!line) continue;
      const n = numbered ? Number(numbered[1]) : null;
      const startsOperator = /^[+*|&.^@)]/.test(line);
      const assignment = /^(?:\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)\s*=/.test(line);
      const open = current && balance(current) > 0;
      if (numbered || (!open && assignment && current && current.includes("="))) flush();
      if (!current) {
        current = line;
        number = n;
      } else if (startsOperator || open) current += line;
      else current += line;
    }
    flush();
    return out;
  }

  function extractEquation(input) {
    let line = String(input ?? "").trim().replace(/^\s*\d+\s*[.)-]\s*/, "");
    const eq = line.indexOf("=");
    let outputName = null;
    if (eq >= 0) {
      const left = line.slice(0, eq).trim();
      line = line.slice(eq + 1).trim();
      const bracketed = left.match(/^\[([^\]]+)\]$/);
      if (bracketed) outputName = bracketed[1].trim();
      else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(left)) outputName = left;
    }
    if (!line) throw new Error("หลังเครื่องหมาย = ยังไม่มีสมการ");
    return { outputName, expression: line.replace(/\./g, "*") };
  }

  function sameMinterms(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  function forceVariables(expression, variables) {
    return expression + variables.map((v) => `+0*${B.formatVariable(v)}`).join("");
  }

  function pruneRedundantTerms(data) {
    if (!data.result.includes(" + ")) return data;
    let terms = data.result.split(" + ");
    let changed = true;
    while (changed && terms.length > 1) {
      changed = false;
      for (let i = 0; i < terms.length; i++) {
        const candidate = terms.filter((_, idx) => idx !== i).join(" + ");
        try {
          const probe = B.simplifyBoolean(forceVariables(candidate, data.variables));
          if (sameMinterms(probe.minterms, data.minterms)) {
            terms.splice(i, 1);
            changed = true;
            break;
          }
        } catch (_) { /* keep term */ }
      }
    }
    const result = terms.join(" + ");
    let literals = data.literals;
    try { literals = B.tokenize(result).filter((t) => t.type === "VAR").length; } catch (_) { /* keep */ }
    return { ...data, result, terms: terms.length, literals };
  }

  function simplifyOne(input) {
    const equation = extractEquation(input);
    let data = B.simplifyBoolean(equation.expression);
    data = pruneRedundantTerms(data);
    return { ...data, outputName: equation.outputName };
  }

  function displayText(data) {
    return data.outputName ? `${B.formatVariable(data.outputName)} = ${data.result}` : data.result;
  }

  function hideError() { if (errorBox) errorBox.hidden = true; }
  function showError(message) {
    if (errorBox) { errorBox.textContent = message; errorBox.hidden = false; }
    if (resultBox) resultBox.hidden = true;
    if (batchResults) batchResults.hidden = true;
  }

  function renderSingle(data) {
    hideError();
    if (batchResults) batchResults.hidden = true;
    if (resultFormula) resultFormula.textContent = displayText(data);
    if (normalizedFormula) normalizedFormula.textContent = data.normalized;
    const vars = data.variables.length ? data.variables.map(B.formatVariable).join(", ") : "ไม่มี";
    const mins = data.minterms.length <= 24 ? data.minterms.join(", ") : `${data.minterms.slice(0, 24).join(", ")} …`;
    if (resultMeta) resultMeta.innerHTML = `
      <span>ตัวแปร: <strong>${escapeHtml(vars)}</strong></span>
      <span>พจน์: <strong>${data.terms}</strong></span>
      <span>Literal: <strong>${data.literals}</strong></span>
      <span>Minterm: <strong>${escapeHtml(mins || "ไม่มี")}</strong></span>`;
    if (emptyState) emptyState.hidden = true;
    if (resultBox) resultBox.hidden = false;
  }

  function renderBatch(rows) {
    hideError();
    if (resultBox) resultBox.hidden = true;
    if (emptyState) emptyState.hidden = true;
    if (!batchResults) return;
    const ok = rows.filter((r) => r.data).length;
    batchResults.innerHTML = `
      <div class="batch-summary"><strong>พบ ${rows.length} ข้อ</strong><span>ย่อสำเร็จ ${ok}/${rows.length} — ตรวจข้อความ OCR/Bar ก่อนนำไปใช้</span></div>
      ${rows.map((row, i) => {
        const label = row.number ?? i + 1;
        if (row.error) return `<article class="batch-item batch-error"><div class="batch-label">ข้อ ${label}</div><code class="batch-source">${escapeHtml(row.text)}</code><div class="batch-error-text">${escapeHtml(row.error)}</div></article>`;
        const d = row.data;
        const vars = d.variables.length ? d.variables.map(B.formatVariable).join(", ") : "ไม่มี";
        return `<article class="batch-item"><div class="batch-label">ข้อ ${label}</div><div class="batch-answer">${escapeHtml(displayText(d))}</div><div class="batch-normalized"><span>อ่านเป็น</span><code>${escapeHtml(d.normalized)}</code></div><div class="batch-mini-meta"><span>${escapeHtml(vars)}</span><span>${d.terms} พจน์</span><span>${d.literals} literal</span></div></article>`;
      }).join("")}`;
    batchResults.hidden = false;
  }

  function runSimplifyV3() {
    try {
      const items = splitExercises(formulaInput?.value || "");
      if (!items.length) throw new Error("กรุณาพิมพ์สูตร Boolean ก่อน");
      if (items.length === 1) return renderSingle(simplifyOne(items[0].text));
      renderBatch(items.map((item) => {
        try { return { ...item, data: simplifyOne(item.text), error: null }; }
        catch (e) { return { ...item, data: null, error: e.message || String(e) }; }
      }));
    } catch (e) { showError(e.message || String(e)); }
  }

  function bboxOf(node) {
    const b = node?.bbox;
    if (!b) return null;
    const x0 = Number(b.x0 ?? b.left ?? 0), y0 = Number(b.y0 ?? b.top ?? 0);
    const x1 = Number(b.x1 ?? ((b.left ?? 0) + (b.width ?? 0)));
    const y1 = Number(b.y1 ?? ((b.top ?? 0) + (b.height ?? 0)));
    return [x0, y0, x1, y1].every(Number.isFinite) ? { x0, y0, x1, y1 } : null;
  }

  function flattenLines(blocks) {
    const out = [];
    for (const block of blocks || []) for (const p of block.paragraphs || []) for (const line of p.lines || []) {
      const symbols = [];
      for (const word of line.words || []) for (const symbol of word.symbols || []) {
        const bbox = bboxOf(symbol);
        if (bbox && symbol.text) symbols.push({ text: symbol.text, bbox });
      }
      const bbox = bboxOf(line) || bboxOf(block);
      if (bbox) out.push({ text: line.text || "", bbox, symbols });
    }
    return out.sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
  }

  async function imageToCanvas(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error("เปิดรูปไม่ได้")); });
      const longest = Math.max(img.naturalWidth, img.naturalHeight);
      let scale = longest > 2400 ? 2400 / longest : longest < 1200 ? Math.min(2, 1200 / Math.max(1, longest)) : 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally { URL.revokeObjectURL(url); }
  }

  function dark(imageData, x, y, threshold = 180) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= imageData.width || y >= imageData.height) return false;
    const i = (y * imageData.width + x) * 4, d = imageData.data;
    return d[i + 3] > 40 && d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114 < threshold;
  }

  function detectBars(imageData, box) {
    const h = Math.max(1, box.y1 - box.y0), xs = Math.max(0, Math.floor(box.x0)), xe = Math.min(imageData.width - 1, Math.ceil(box.x1));
    const ys = Math.max(0, Math.floor(box.y0 - h * .22)), ye = Math.min(imageData.height - 1, Math.ceil(box.y0 + h * .38));
    const minLen = Math.max(10, Math.round(h * .30)), runs = [];
    for (let y = ys; y <= ye; y++) {
      let x = xs;
      while (x <= xe) {
        while (x <= xe && !dark(imageData, x, y)) x++;
        if (x > xe) break;
        const start = x; let last = x, gap = 0; x++;
        while (x <= xe) {
          if (dark(imageData, x, y)) { last = x; gap = 0; }
          else if (++gap > 1) break;
          x++;
        }
        if (last - start + 1 >= minLen) runs.push({ x0: start, x1: last, y });
      }
    }
    const groups = [];
    for (const r of runs) {
      let hit = null, best = 0;
      for (const g of groups) {
        if (r.y > g.y1 + 2) continue;
        const ov = Math.max(0, Math.min(r.x1, g.x1) - Math.max(r.x0, g.x0) + 1);
        const ratio = ov / Math.max(1, Math.min(r.x1 - r.x0 + 1, g.x1 - g.x0 + 1));
        if (ratio > .55 && ratio > best) { hit = g; best = ratio; }
      }
      if (hit) { hit.x0 = Math.min(hit.x0, r.x0); hit.x1 = Math.max(hit.x1, r.x1); hit.y1 = r.y; }
      else groups.push({ x0: r.x0, x1: r.x1, y0: r.y, y1: r.y });
    }
    return groups.filter((g) => {
      const w = g.x1 - g.x0 + 1, gh = g.y1 - g.y0 + 1, cy = (g.y0 + g.y1) / 2;
      if (w < minLen || gh > Math.max(6, h * .18) || w / Math.max(1, gh) < 4 || cy > box.y0 + h * .34) return false;
      let ink = 0;
      for (let x = g.x0; x <= g.x1; x++) if (dark(imageData, x, g.y1 + 1) || dark(imageData, x, g.y1 + 2)) ink++;
      return ink / Math.max(1, w) <= .35;
    });
  }

  const normSymbol = (t) => String(t || "").replace(/[£€]/g, "=").replace(/%/g, "+").replace(/[×·∙]/g, ".").replace(/[−–—]/g, "-").replace(/[’‘`´′]/g, "'");
  const compatible = (a, b) => a.end <= b.start || b.end <= a.start || (a.start <= b.start && a.end >= b.end) || (b.start <= a.start && b.end >= a.end);

  function applyBars(items, intervals) {
    const kept = [];
    for (const it of [...intervals].sort((a, b) => (b.end - b.start) - (a.end - a.start))) if (kept.every((x) => compatible(it, x))) kept.push(it);
    const opens = new Map(), closes = new Map();
    for (const it of kept) {
      if (!opens.has(it.start)) opens.set(it.start, []); opens.get(it.start).push(it);
      if (!closes.has(it.end)) closes.set(it.end, []); closes.get(it.end).push(it);
    }
    for (const v of opens.values()) v.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.y - b.y);
    for (const v of closes.values()) v.sort((a, b) => b.start - a.start || b.y - a.y);
    let out = "";
    items.forEach((item, i) => {
      for (const _ of opens.get(i) || []) out += "BAR(";
      out += normSymbol(item.text);
      for (const _ of closes.get(i + 1) || []) out += ")";
    });
    return out;
  }

  function rebuildLine(line, imageData) {
    const items = line.symbols || [];
    if (!items.length) return { text: line.text || "", bars: 0 };
    const h = Math.max(1, line.bbox.y1 - line.bbox.y0), margin = Math.max(2, h * .07), intervals = [];
    for (const bar of detectBars(imageData, line.bbox)) {
      const ids = [];
      items.forEach((it, i) => {
        const cx = (it.bbox.x0 + it.bbox.x1) / 2, cy = (it.bbox.y0 + it.bbox.y1) / 2;
        if (cx >= bar.x0 - margin && cx <= bar.x1 + margin && cy > bar.y1 + h * .12) ids.push(i);
      });
      if (!ids.length) continue;
      const start = Math.min(...ids), end = Math.max(...ids) + 1;
      if (/[A-Za-z0-9]/.test(items.slice(start, end).map((x) => normSymbol(x.text)).join(""))) intervals.push({ start, end, y: bar.y0 });
    }
    return { text: applyBars(items, intervals), bars: intervals.length };
  }

  function rebuildOcr(data, canvas) {
    const lines = flattenLines(data?.blocks), raw = String(data?.text || "");
    if (!lines.length) return { text: normalizeOcrText(raw), bars: 0, geometry: false, lineCount: raw.split(/\r?\n/).filter(Boolean).length };
    const imageData = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    let bars = 0;
    const text = lines.map((line) => { const r = rebuildLine(line, imageData); bars += r.bars; return r.text; }).join("\n");
    return { text: normalizeOcrText(text || raw), bars, geometry: true, lineCount: lines.length };
  }

  async function runOcrV3() {
    const file = imageInput?.files?.[0];
    if (!file) return;
    if (!window.Tesseract) return showError("โหลด OCR library ไม่สำเร็จ กรุณารีเฟรชหน้าและตรวจอินเทอร์เน็ต");
    hideError(); ocrBtn.disabled = true; simplifyBtn.disabled = true; ocrStatus.textContent = "กำลังเตรียมภาพ…";
    let worker = null;
    try {
      const canvas = await imageToCanvas(file);
      worker = await Tesseract.createWorker("eng", Tesseract.OEM?.LSTM_ONLY ?? 1, { logger: (m) => {
        if (m.status === "recognizing text" && typeof m.progress === "number") {
          const pct = Math.round(m.progress * 100); ocrProgress.style.width = `${pct}%`; ocrStatus.textContent = `กำลังอ่านข้อความและหา Bar… ${pct}%`;
        }
      }});
      await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM?.SINGLE_BLOCK ?? "6", preserve_interword_spaces: "1" });
      const result = await worker.recognize(canvas, {}, { text: true, blocks: true });
      const rec = rebuildOcr(result.data, canvas);
      formulaInput.value = rec.text;
      const count = splitExercises(rec.text).length || rec.lineCount || 1;
      ocrStatus.textContent = `อ่านเสร็จแล้ว — พบประมาณ ${count} ข้อ • ตรวจพบ Bar ${rec.bars} เส้น (Beta) กรุณาตรวจสูตรก่อนกดย่อ`;
      ocrProgress.style.width = "100%"; formulaInput.focus();
    } catch (e) { showError(`OCR ไม่สำเร็จ: ${e.message || e}`); ocrStatus.textContent = "OCR ไม่สำเร็จ"; }
    finally { if (worker) try { await worker.terminate(); } catch (_) {} ocrBtn.disabled = false; simplifyBtn.disabled = false; }
  }

  // Capture phase lets v3 replace the old single-formula / plain-text OCR handlers without deleting app.js.
  simplifyBtn?.addEventListener("click", (e) => { e.preventDefault(); e.stopImmediatePropagation(); runSimplifyV3(); }, true);
  ocrBtn?.addEventListener("click", (e) => { e.preventDefault(); e.stopImmediatePropagation(); runOcrV3(); }, true);
  formulaInput?.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); runSimplifyV3(); }
  }, true);
  clearBtn?.addEventListener("click", () => { if (batchResults) { batchResults.hidden = true; batchResults.innerHTML = ""; } });

  window.BooleanSimplifierV3 = { simplifyOne, splitExercises, pruneRedundantTerms, detectBars, applyBars, rebuildOcr, normalizeOcrText };
})();
