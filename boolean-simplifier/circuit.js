(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const circuitBtn = $("circuitBtn");
  const imageInput = $("imageInput");
  const cameraInput = $("cameraInput");
  const preview = $("preview");
  const ocrStatus = $("ocrStatus");
  const ocrProgress = $("ocrProgress");
  const ocrBtn = $("ocrBtn");
  const simplifyBtn = $("simplifyBtn");
  const clearBtn = $("clearBtn");
  const resultBox = $("resultBox");
  const batchResults = $("batchResults");
  const emptyState = $("emptyState");
  const errorBox = $("errorBox");

  if (!circuitBtn || !imageInput) return;

  const TYPE_LABEL = { NOT: "NOT", AND: "AND", OR: "OR", XOR: "XOR" };

  function setError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
  }
  function clearError() {
    if (errorBox) errorBox.hidden = true;
  }
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function fileToBitmap(file) {
    if ("createImageBitmap" in window) return await createImageBitmap(file);
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  function rasterize(bitmap) {
    const naturalW = bitmap.width || bitmap.naturalWidth;
    const naturalH = bitmap.height || bitmap.naturalHeight;
    const maxW = 1400;
    const maxH = 1000;
    const scale = Math.min(1, maxW / naturalW, maxH / naturalH);
    const W = Math.max(1, Math.round(naturalW * scale));
    const H = Math.max(1, Math.round(naturalH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, W, H);
    const imageData = ctx.getImageData(0, 0, W, H);
    const black = new Uint8Array(W * H);
    const p = imageData.data;

    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      const r = p[i], g = p[i + 1], b = p[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 178 && (mx - mn < 70 || mx < 95)) black[j] = 1;
    }
    return { canvas, ctx, imageData, black, W, H, naturalW, naturalH, scale };
  }

  function lineMasks(black, W, H) {
    const horizontal = new Uint8Array(W * H);
    const vertical = new Uint8Array(W * H);
    const minH = Math.max(24, Math.round(W * 0.025));
    const minV = Math.max(24, Math.round(H * 0.04));

    for (let y = 0; y < H; y++) {
      let x = 0;
      const base = y * W;
      while (x < W) {
        while (x < W && !black[base + x]) x++;
        const start = x;
        while (x < W && black[base + x]) x++;
        if (x - start >= minH) horizontal.fill(1, base + start, base + x);
      }
    }

    for (let x = 0; x < W; x++) {
      let y = 0;
      while (y < H) {
        while (y < H && !black[y * W + x]) y++;
        const start = y;
        while (y < H && black[y * W + x]) y++;
        if (y - start >= minV) {
          for (let yy = start; yy < y; yy++) vertical[yy * W + x] = 1;
        }
      }
    }
    return { horizontal, vertical, minH, minV };
  }

  function components(bin, W, H, minArea = 1) {
    const N = W * H;
    const seen = new Uint8Array(N);
    const queue = new Int32Array(N);
    const out = [];
    const dirs = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];

    for (let start = 0; start < N; start++) {
      if (!bin[start] || seen[start]) continue;
      let qh = 0, qt = 0;
      queue[qt++] = start;
      seen[start] = 1;
      let area = 0, minX = W, minY = H, maxX = 0, maxY = 0, sumX = 0, sumY = 0;

      while (qh < qt) {
        const idx = queue[qh++];
        const y = Math.floor(idx / W);
        const x = idx - y * W;
        area++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        sumX += x;
        sumY += y;

        for (let d = 0; d < 8; d++) {
          if ((x === 0 && (d === 0 || d === 3 || d === 5)) ||
              (x === W - 1 && (d === 2 || d === 4 || d === 7)) ||
              (y === 0 && d <= 2) || (y === H - 1 && d >= 5)) continue;
          const ni = idx + dirs[d];
          if (ni >= 0 && ni < N && bin[ni] && !seen[ni]) {
            seen[ni] = 1;
            queue[qt++] = ni;
          }
        }
      }

      if (area >= minArea) {
        out.push({ x0: minX, y0: minY, x1: maxX, y1: maxY, w: maxX - minX + 1,
          h: maxY - minY + 1, area, cx: sumX / area, cy: sumY / area });
      }
    }
    return out;
  }

  function mergeBoxes(boxes, gapX, gapY) {
    let cur = boxes.map((b) => ({ ...b }));
    let changed = true;
    while (changed) {
      changed = false;
      const used = new Array(cur.length).fill(false);
      const next = [];
      for (let i = 0; i < cur.length; i++) {
        if (used[i]) continue;
        let a = { ...cur[i] };
        used[i] = true;
        let grown = true;
        while (grown) {
          grown = false;
          for (let j = 0; j < cur.length; j++) {
            if (used[j]) continue;
            const b = cur[j];
            const separate = a.x1 + gapX < b.x0 || b.x1 + gapX < a.x0 ||
              a.y1 + gapY < b.y0 || b.y1 + gapY < a.y0;
            if (!separate) {
              const total = a.area + b.area;
              a = {
                x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
                x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
                area: total,
                cx: (a.cx * a.area + b.cx * b.area) / total,
                cy: (a.cy * a.area + b.cy * b.area) / total,
              };
              a.w = a.x1 - a.x0 + 1;
              a.h = a.y1 - a.y0 + 1;
              used[j] = true;
              grown = true;
              changed = true;
            }
          }
        }
        next.push(a);
      }
      cur = next;
    }
    return cur;
  }

  function bubbleScore(box, black, W, H) {
    let best = 0;
    const startX = Math.max(box.x0 + Math.floor(box.w * 0.5), 0);
    const endX = Math.min(box.x1 + 15, W - 1);
    const startY = Math.max(box.y0 + 5, 0);
    const endY = Math.min(box.y1 - 5, H - 1);
    const radii = [5, 7, 9];
    for (let cy = startY; cy <= endY; cy += 3) {
      for (let cx = startX; cx <= endX; cx += 3) {
        for (const r of radii) {
          let ring = 0, samples = 0;
          for (let k = 0; k < 16; k++) {
            const a = (Math.PI * 2 * k) / 16;
            const x = Math.round(cx + r * Math.cos(a));
            const y = Math.round(cy + r * Math.sin(a));
            if (x >= 0 && x < W && y >= 0 && y < H) {
              ring += black[y * W + x];
              samples++;
            }
          }
          let inner = 0, innerN = 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            if (dx * dx + dy * dy > 4) continue;
            const x = cx + dx, y = cy + dy;
            if (x >= 0 && x < W && y >= 0 && y < H) {
              inner += black[y * W + x];
              innerN++;
            }
          }
          const score = (samples ? ring / samples : 0) - 0.7 * (innerN ? inner / innerN : 0);
          if (score > best) best = score;
        }
      }
    }
    return best;
  }

  function detectGates(black, horizontal, vertical, W, H) {
    const symbol = new Uint8Array(W * H);
    for (let i = 0; i < symbol.length; i++) symbol[i] = black[i] && !horizontal[i] && !vertical[i] ? 1 : 0;

    const raw = components(symbol, W, H, 8);
    const merged = mergeBoxes(raw, Math.max(14, W * 0.016), Math.max(6, H * 0.011));
    const boxes = merged.filter((b) =>
      b.h > H * 0.06 && b.w > W * 0.03 && b.w < W * 0.23 &&
      b.h < H * 0.20 && b.area > Math.max(150, W * H * 0.0002) && b.x0 > W * 0.12
    );

    const gates = boxes.map((b, index) => {
      const bubble = bubbleScore(b, black, W, H);
      let leftPixels = 0;
      const leftW = Math.max(1, Math.floor(b.w / 3));
      for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x < b.x0 + leftW; x++) {
        leftPixels += symbol[y * W + x];
      }
      const leftDensity = leftPixels / (leftW * b.h);
      let type;
      if (bubble > 0.82) type = "NOT";
      else if (b.w / W < 0.055) type = "AND";
      else if (leftDensity > 0.13) type = "XOR";
      else type = "OR";

      let bodyX0 = b.x0 - 5;
      if (type === "AND") bodyX0 = b.x0 - b.h * 0.92;
      const body = {
        x0: Math.max(0, Math.round(bodyX0)), y0: Math.max(0, b.y0 - 5),
        x1: Math.min(W - 1, b.x1 + 5), y1: Math.min(H - 1, b.y1 + 5),
      };
      return { id: `G${index + 1}`, type, box: b, body, bubble, leftDensity, inputs: [], output: null };
    });

    gates.sort((a, b) => a.body.x0 - b.body.x0 || a.body.y0 - b.body.y0);
    gates.forEach((g, i) => g.id = `G${i + 1}`);
    return { gates, symbol };
  }

  function lineSegments(mask, W, H, orientation, minLength) {
    const comps = components(mask, W, H, 1);
    const out = [];
    for (const c of comps) {
      if (orientation === "H" && c.w >= minLength) {
        out.push({ id: `H${out.length}`, o: "H", x1: c.x0, x2: c.x1, y: Math.round(c.cy), th: c.h });
      } else if (orientation === "V" && c.h >= minLength) {
        out.push({ id: `V${out.length}`, o: "V", y1: c.y0, y2: c.y1, x: Math.round(c.cx), th: c.w });
      }
    }
    return out;
  }

  function detectPorts(gate, hs, W, H) {
    const b = gate.box;
    const yLo = b.y0 + 0.15 * b.h;
    const yHi = b.y0 + 0.85 * b.h;
    let inputs = hs.filter((s) =>
      s.y >= yLo && s.y <= yHi &&
      s.x2 >= b.x0 - 1.3 * b.h && s.x2 <= b.x0 + 0.45 * b.w &&
      s.x2 - s.x1 >= Math.max(18, W * 0.014) && s.x1 < b.x0
    );

    inputs.sort((a, b2) => a.y - b2.y);
    const deduped = [];
    for (const s of inputs) {
      const last = deduped[deduped.length - 1];
      if (last && Math.abs(last.y - s.y) < Math.max(6, H * 0.01)) {
        if (s.x1 < last.x1) deduped[deduped.length - 1] = s;
      } else deduped.push(s);
    }
    inputs = deduped;

    const need = gate.type === "NOT" ? 1 : 2;
    if (inputs.length > need) {
      const targets = need === 1 ? [b.y0 + b.h / 2] : [b.y0 + b.h * 0.32, b.y0 + b.h * 0.68];
      const remain = inputs.slice();
      const chosen = [];
      for (const t of targets) {
        let best = 0;
        for (let i = 1; i < remain.length; i++) if (Math.abs(remain[i].y - t) < Math.abs(remain[best].y - t)) best = i;
        chosen.push(remain.splice(best, 1)[0]);
      }
      inputs = chosen.sort((a, b2) => a.y - b2.y);
    }

    const outputs = hs.filter((s) =>
      s.y >= yLo && s.y <= yHi &&
      s.x1 >= b.x0 + 0.55 * b.w && s.x1 <= b.x1 + 30 &&
      s.x2 - s.x1 >= Math.max(18, W * 0.014) && s.x2 > b.x1
    );
    let output = null;
    if (outputs.length) {
      const target = b.y0 + b.h / 2;
      output = outputs.reduce((best, s) => Math.abs(s.y - target) < Math.abs(best.y - target) ? s : best, outputs[0]);
    }
    gate.inputs = inputs;
    gate.output = output;
  }

  function localDensity(black, W, H, x, y, rad) {
    x = Math.round(x); y = Math.round(y);
    let sum = 0, n = 0;
    for (let yy = Math.max(0, y - rad); yy <= Math.min(H - 1, y + rad); yy++) {
      const base = yy * W;
      for (let xx = Math.max(0, x - rad); xx <= Math.min(W - 1, x + rad); xx++) {
        sum += black[base + xx]; n++;
      }
    }
    return n ? sum / n : 0;
  }

  function midpoint(s) {
    return s.o === "H" ? [(s.x1 + s.x2) / 2, s.y] : [s.x, (s.y1 + s.y2) / 2];
  }

  function buildNets(gates, hs, vs, black, W, H) {
    const portIds = new Set();
    for (const g of gates) {
      g.inputs.forEach((s) => portIds.add(s.id));
      if (g.output) portIds.add(g.output.id);
    }

    const all = [...hs, ...vs];
    const active = all.filter((s) => {
      const [mx, my] = midpoint(s);
      const inside = gates.some((g) => mx >= g.body.x0 && mx <= g.body.x1 && my >= g.body.y0 && my <= g.body.y1);
      return !inside || portIds.has(s.id);
    });
    const map = new Map(active.map((s) => [s.id, s]));
    const ids = [...map.keys()];
    const adj = new Map(ids.map((id) => [id, new Set()]));
    const tol = Math.max(5, Math.round(W * 0.0055));
    const rad = Math.max(4, Math.round(W * 0.0047));

    function connect(a, b) { adj.get(a.id).add(b.id); adj.get(b.id).add(a.id); }
    for (let i = 0; i < ids.length; i++) {
      const a = map.get(ids[i]);
      for (let j = i + 1; j < ids.length; j++) {
        const b = map.get(ids[j]);
        let yes = false;
        if (a.o === "H" && b.o === "H") {
          yes = Math.abs(a.y - b.y) <= tol && !(a.x2 + tol < b.x1 || b.x2 + tol < a.x1);
        } else if (a.o === "V" && b.o === "V") {
          yes = Math.abs(a.x - b.x) <= tol && !(a.y2 + tol < b.y1 || b.y2 + tol < a.y1);
        } else {
          const h = a.o === "H" ? a : b;
          const v = a.o === "V" ? a : b;
          const x = v.x, y = h.y;
          if (x >= h.x1 - tol && x <= h.x2 + tol && y >= v.y1 - tol && y <= v.y2 + tol) {
            const endpoint = Math.min(Math.abs(x - h.x1), Math.abs(x - h.x2)) <= tol ||
              Math.min(Math.abs(y - v.y1), Math.abs(y - v.y2)) <= tol;
            const dot = localDensity(black, W, H, x, y, rad) >= 0.74;
            yes = endpoint || dot;
          }
        }
        if (yes) connect(a, b);
      }
    }

    const netOf = new Map();
    const nets = [];
    const visited = new Set();
    for (const id of ids) {
      if (visited.has(id)) continue;
      const stack = [id];
      visited.add(id);
      const members = [];
      while (stack.length) {
        const u = stack.pop(); members.push(u); netOf.set(u, nets.length);
        for (const v of adj.get(u)) if (!visited.has(v)) { visited.add(v); stack.push(v); }
      }
      nets.push(members);
    }
    return { netOf, nets, segmentMap: map };
  }

  function pickSourceNames(sourceNets, nets, segmentMap, ocr, W, H, naturalW, naturalH) {
    const records = sourceNets.map((net) => {
      const segs = nets[net].map((id) => segmentMap.get(id)).filter(Boolean);
      const hs = segs.filter((s) => s.o === "H");
      const left = hs.length ? hs.reduce((a, b) => a.x1 < b.x1 ? a : b) : null;
      return { net, y: left ? left.y : 0, x: left ? left.x1 : 0 };
    }).sort((a, b) => a.y - b.y);

    const words = Array.isArray(ocr?.data?.words) ? ocr.data.words : [];
    const sx = W / naturalW, sy = H / naturalH;
    const used = new Set();
    for (const rec of records) {
      let best = null, bestDist = Infinity;
      for (const w of words) {
        const text = String(w.text || "").trim();
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(text) || /^T\d*$/i.test(text) || /^F\d*$/i.test(text)) continue;
        const bb = w.bbox || {};
        const cx = ((bb.x0 ?? 0) + (bb.x1 ?? 0)) * 0.5 * sx;
        const cy = ((bb.y0 ?? 0) + (bb.y1 ?? 0)) * 0.5 * sy;
        if (cx > rec.x + W * 0.04) continue;
        const d = Math.abs(cy - rec.y) + Math.max(0, cx - rec.x) * 0.2;
        if (d < bestDist && Math.abs(cy - rec.y) < H * 0.06 && !used.has(text)) { best = text; bestDist = d; }
      }
      if (best) { rec.name = best; used.add(best); }
    }

    const rawTokens = String(ocr?.data?.text || "").match(/\b[A-Za-z][A-Za-z0-9_]*\b/g) || [];
    const pool = [...new Set(rawTokens.filter((t) => !/^T\d*$/i.test(t) && !/^F\d*$/i.test(t) && t.length <= 8))];
    let pi = 0;
    for (let i = 0; i < records.length; i++) {
      if (records[i].name) continue;
      while (pi < pool.length && used.has(pool[pi])) pi++;
      records[i].name = pi < pool.length ? pool[pi++] : `I${i + 1}`;
      used.add(records[i].name);
    }
    return new Map(records.map((r) => [r.net, r.name]));
  }

  function buildExpressions(gates, netOf, sourceNames) {
    const producer = new Map();
    const consumed = new Set();
    for (const g of gates) {
      if (g.output && netOf.has(g.output.id)) producer.set(netOf.get(g.output.id), g);
      for (const s of g.inputs) if (netOf.has(s.id)) consumed.add(netOf.get(s.id));
    }

    const memo = new Map();
    const visiting = new Set();
    function gateExpr(g) {
      if (memo.has(g.id)) return memo.get(g.id);
      if (visiting.has(g.id)) throw new Error("พบวงจรย้อนกลับ (feedback) ซึ่งโหมด Beta ยังไม่รองรับ");
      visiting.add(g.id);
      const inputNets = g.inputs.map((s) => netOf.get(s.id)).filter((n) => n !== undefined);
      const need = g.type === "NOT" ? 1 : 2;
      if (inputNets.length < need) throw new Error(`อ่านขาเข้า ${g.type} ได้ไม่ครบ`);
      const vals = inputNets.slice(0, need).map((n) => netExpr(n));
      let text;
      if (g.type === "NOT") text = `(${vals[0]})'`;
      else if (g.type === "AND") text = `(${vals[0]})*(${vals[1]})`;
      else if (g.type === "OR") text = `(${vals[0]})+(${vals[1]})`;
      else if (g.type === "XOR") text = `(${vals[0]})^(${vals[1]})`;
      else throw new Error(`ยังไม่รองรับ Gate ${g.type}`);
      visiting.delete(g.id);
      memo.set(g.id, text);
      return text;
    }
    function netExpr(n) {
      if (sourceNames.has(n)) return sourceNames.get(n);
      const g = producer.get(n);
      if (g) return gateExpr(g);
      return `I${n + 1}`;
    }

    let roots = gates.filter((g) => !g.output || !netOf.has(g.output.id) || !consumed.has(netOf.get(g.output.id)));
    roots = roots.filter((g) => {
      try { gateExpr(g); return true; } catch { return false; }
    }).sort((a, b) => (a.body.y0 + a.body.y1) - (b.body.y0 + b.body.y1));
    if (!roots.length) throw new Error("หา Gate เอาต์พุตไม่เจอ");
    return roots.map((g, i) => ({ gate: g, name: `F${i + 1}`, expression: gateExpr(g) }));
  }

  function annotate(canvas, ctx, gates) {
    ctx.save();
    ctx.lineWidth = Math.max(2, canvas.width * 0.002);
    ctx.font = `700 ${Math.max(13, Math.round(canvas.width * 0.014))}px system-ui`;
    for (const g of gates) {
      ctx.strokeStyle = "#7357ff";
      ctx.fillStyle = "#7357ff";
      const b = g.body;
      ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      ctx.fillText(TYPE_LABEL[g.type] || g.type, b.x0, Math.max(14, b.y0 - 5));
    }
    ctx.restore();
    return canvas.toDataURL("image/png");
  }

  function renderCircuit(outputs, gates, sourceNames) {
    if (resultBox) resultBox.hidden = true;
    if (emptyState) emptyState.hidden = true;
    if (!batchResults) return;
    const sourceList = [...new Set(sourceNames.values())].join(", ");
    const gateCounts = gates.reduce((m, g) => (m[g.type] = (m[g.type] || 0) + 1, m), {});
    const gateText = Object.entries(gateCounts).map(([k, v]) => `${k} ${v}`).join(" • ");
    const cards = outputs.map((out) => {
      let simplified = out.expression;
      try {
        simplified = window.BooleanSimplifier?.simplifyBoolean(out.expression)?.result || out.expression;
      } catch (_) {}
      return `<div class="batch-item circuit-result-item">
        <div class="batch-item-head"><strong>${escapeHtml(out.name)}</strong><span>Logic Circuit</span></div>
        <div class="batch-answer">${escapeHtml(out.name)} = ${escapeHtml(simplified)}</div>
        <code class="circuit-raw">${escapeHtml(out.expression)}</code>
      </div>`;
    }).join("");
    batchResults.innerHTML = `<div class="circuit-summary">
      <span>Inputs <strong>${escapeHtml(sourceList || "-")}</strong></span>
      <span>Gates <strong>${escapeHtml(gateText)}</strong></span>
    </div>${cards}`;
    batchResults.hidden = false;
  }

  async function analyzeCircuit(file) {
    const bitmap = await fileToBitmap(file);
    const ras = rasterize(bitmap);
    const { horizontal, vertical, minH, minV } = lineMasks(ras.black, ras.W, ras.H);
    const { gates } = detectGates(ras.black, horizontal, vertical, ras.W, ras.H);
    if (gates.length < 2) throw new Error("ยังตรวจจับ Logic Gate จากรูปนี้ไม่ได้ ลองครอปรูปให้เหลือเฉพาะวงจรและให้เส้นคมชัดขึ้น");

    const hs = lineSegments(horizontal, ras.W, ras.H, "H", minH);
    const vs = lineSegments(vertical, ras.W, ras.H, "V", minV);
    for (const g of gates) detectPorts(g, hs, ras.W, ras.H);

    const usable = gates.filter((g) => g.inputs.length >= (g.type === "NOT" ? 1 : 2));
    if (usable.length < 2) throw new Error("เจอ Gate แต่ตามเส้นเข้าขา Gate ไม่ครบ รูปที่มีเส้นโค้ง/เอียงมากอาจยังอ่านไม่ได้");

    const { netOf, nets, segmentMap } = buildNets(usable, hs, vs, ras.black, ras.W, ras.H);
    const outputNets = new Set(usable.filter((g) => g.output && netOf.has(g.output.id)).map((g) => netOf.get(g.output.id)));
    const sourceNets = [...new Set(usable.flatMap((g) => g.inputs.map((s) => netOf.get(s.id)).filter((n) => n !== undefined && !outputNets.has(n))))];

    let ocr = null;
    if (window.Tesseract) {
      ocrStatus.textContent = "อ่านชื่อ Input/Output…";
      try {
        ocr = await Tesseract.recognize(file, "eng", {
          logger: (m) => {
            if (m.status === "recognizing text" && typeof m.progress === "number") {
              const pct = Math.round(m.progress * 100);
              if (ocrProgress) ocrProgress.style.width = `${pct}%`;
            }
          }
        });
      } catch (_) {}
    }

    const sourceNames = pickSourceNames(sourceNets, nets, segmentMap, ocr, ras.W, ras.H, ras.naturalW, ras.naturalH);
    const outputs = buildExpressions(usable, netOf, sourceNames);
    preview.src = annotate(ras.canvas, ras.ctx, usable);
    return { outputs, gates: usable, sourceNames };
  }

  circuitBtn.addEventListener("click", async () => {
    const file = imageInput.files?.[0] || cameraInput?.files?.[0];
    if (!file) return;
    clearError();
    circuitBtn.disabled = true;
    if (ocrBtn) ocrBtn.disabled = true;
    if (simplifyBtn) simplifyBtn.disabled = true;
    if (batchResults) batchResults.hidden = true;
    if (resultBox) resultBox.hidden = true;
    ocrStatus.textContent = "กำลังหา Gate และตามสายวงจร…";
    if (ocrProgress) ocrProgress.style.width = "12%";

    try {
      const data = await analyzeCircuit(file);
      renderCircuit(data.outputs, data.gates, data.sourceNames);
      ocrStatus.textContent = `วิเคราะห์วงจรแล้ว — พบ ${data.gates.length} Gate`;
      if (ocrProgress) ocrProgress.style.width = "100%";
    } catch (err) {
      setError(`วิเคราะห์วงจรไม่สำเร็จ: ${err.message || err}`);
      ocrStatus.textContent = "วิเคราะห์วงจรไม่สำเร็จ";
      if (ocrProgress) ocrProgress.style.width = "0%";
    } finally {
      circuitBtn.disabled = false;
      if (ocrBtn) ocrBtn.disabled = false;
      if (simplifyBtn) simplifyBtn.disabled = false;
    }
  });

  imageInput.addEventListener("change", () => { circuitBtn.disabled = !imageInput.files?.length; });
  cameraInput?.addEventListener("change", () => { circuitBtn.disabled = !(cameraInput.files?.length || imageInput.files?.length); });
  clearBtn?.addEventListener("click", () => { circuitBtn.disabled = true; });
})();
