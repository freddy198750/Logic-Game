const $ = (id) => document.getElementById(id);

const formulaInput = $("formulaInput");
const imageInput = $("imageInput");
const preview = $("preview");
const previewWrap = $("previewWrap");
const ocrStatus = $("ocrStatus");
const ocrProgress = $("ocrProgress");
const resultBox = $("resultBox");
const emptyState = $("emptyState");
const resultFormula = $("resultFormula");
const normalizedFormula = $("normalizedFormula");
const resultMeta = $("resultMeta");
const errorBox = $("errorBox");
const simplifyBtn = $("simplifyBtn");
const ocrBtn = $("ocrBtn");
const exampleBtn = $("exampleBtn");
const clearBtn = $("clearBtn");

let selectedImage = null;
let exampleIndex = 0;

const RESERVED_WORDS = new Set(["AND", "OR", "NOT", "BAR", "XOR", "XNOR"]);

function normalizeVisualSymbols(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[’‘`´′]/g, "'")
    .replace(/[\u0304\u0305]/g, "'")
    .replace(/[¬]/g, "!")
    .replace(/[∧×·∙]/g, "*")
    .replace(/[∨]/g, "+")
    .replace(/[＋]/g, "+")
    .replace(/[⊕]/g, "^")
    .replace(/[⊙≡]/g, "@")
    .replace(/[−–—]/g, "-");
}

function cleanOcrText(text) {
  let s = normalizeVisualSymbols(text)
    .replace(/[^A-Za-z0-9_+*|&!~'^@()\[\]\s]/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  s = s.replace(/\|\|+/g, "|");
  return s;
}

function formatVariable(name) {
  if (/^[A-Za-z_]\w*$/.test(name) && !RESERVED_WORDS.has(name.toUpperCase()) && !/^[A-Z]{2,}$/.test(name)) {
    return name;
  }
  return `[${name}]`;
}

function tokenize(input) {
  const s = normalizeVisualSymbols(input);
  const raw = [];

  for (let i = 0; i < s.length;) {
    const ch = s[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === "[") {
      const end = s.indexOf("]", i + 1);
      if (end < 0) throw new Error("ตัวแปรแบบ [NAME] ยังไม่มีเครื่องหมาย ] ปิด");
      const name = s.slice(i + 1, end).trim();
      if (!name) throw new Error("ชื่อตัวแปรใน [ ] ห้ามว่าง");
      if (!/^[A-Za-z_][A-Za-z0-9_ ]*$/.test(name)) {
        throw new Error("ตัวแปรใน [ ] ใช้ได้เฉพาะตัวอักษร ตัวเลข _ และเว้นวรรค");
      }
      raw.push({ type: "VAR", value: name });
      i = end + 1;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      const word = s.slice(i, j);
      const keyword = word.toUpperCase();

      if (keyword === "AND") raw.push({ type: "AND", value: word });
      else if (keyword === "OR") raw.push({ type: "OR", value: word });
      else if (keyword === "NOT" || keyword === "BAR") raw.push({ type: "NOT", value: word });
      else if (keyword === "XOR") raw.push({ type: "XOR", value: word });
      else if (keyword === "XNOR") raw.push({ type: "XNOR", value: word });
      else if (/^[A-Z]{2,}$/.test(word)) {
        for (const letter of word) raw.push({ type: "VAR", value: letter });
      } else {
        raw.push({ type: "VAR", value: word });
      }

      i = j;
      continue;
    }

    if (ch === "0" || ch === "1") raw.push({ type: "CONST", value: ch });
    else if (ch === "+" || ch === "|") raw.push({ type: "OR", value: ch });
    else if (ch === "*" || ch === "&") raw.push({ type: "AND", value: ch });
    else if (ch === "!" || ch === "~") raw.push({ type: "NOT", value: ch });
    else if (ch === "^") raw.push({ type: "XOR", value: ch });
    else if (ch === "@") raw.push({ type: "XNOR", value: ch });
    else if (ch === "'") raw.push({ type: "PRIME", value: ch });
    else if (ch === "(") raw.push({ type: "LPAREN", value: ch });
    else if (ch === ")") raw.push({ type: "RPAREN", value: ch });
    else throw new Error(`ไม่รู้จักอักขระ “${ch}”`);
    i++;
  }

  if (!raw.length) throw new Error("กรุณาพิมพ์สูตร Boolean ก่อน");

  const out = [];
  const canEnd = (t) => ["VAR", "CONST", "RPAREN", "PRIME"].includes(t.type);
  const canStart = (t) => ["VAR", "CONST", "LPAREN", "NOT"].includes(t.type);

  for (let i = 0; i < raw.length; i++) {
    if (i > 0 && canEnd(raw[i - 1]) && canStart(raw[i])) {
      out.push({ type: "AND", value: "*", implicit: true });
    }
    out.push(raw[i]);
  }
  return out;
}

function parseBoolean(input) {
  const tokens = tokenize(input);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (type) => {
    const token = tokens[pos];
    if (!token || token.type !== type) {
      throw new Error(`รูปแบบสูตรไม่ถูกต้อง${token ? ` ใกล้ “${token.value}”` : " ที่ท้ายสูตร"}`);
    }
    pos++;
    return token;
  };

  function parseOr() {
    let node = parseXor();
    while (peek()?.type === "OR") {
      take("OR");
      node = { type: "OR", left: node, right: parseXor() };
    }
    return node;
  }

  function parseXor() {
    let node = parseAnd();
    while (peek()?.type === "XOR" || peek()?.type === "XNOR") {
      const op = peek().type;
      take(op);
      node = { type: op, left: node, right: parseAnd() };
    }
    return node;
  }

  function parseAnd() {
    let node = parseUnary();
    while (peek()?.type === "AND") {
      take("AND");
      node = { type: "AND", left: node, right: parseUnary() };
    }
    return node;
  }

  function parseUnary() {
    let node;
    if (peek()?.type === "NOT") {
      take("NOT");
      node = { type: "NOT", child: parseUnary() };
    } else {
      node = parsePrimary();
    }

    while (peek()?.type === "PRIME") {
      take("PRIME");
      node = { type: "NOT", child: node };
    }
    return node;
  }

  function parsePrimary() {
    const token = peek();
    if (!token) throw new Error("สูตรจบไม่สมบูรณ์");
    if (token.type === "VAR") {
      take("VAR");
      return { type: "VAR", name: token.value };
    }
    if (token.type === "CONST") {
      take("CONST");
      return { type: "CONST", value: token.value === "1" };
    }
    if (token.type === "LPAREN") {
      take("LPAREN");
      const node = parseOr();
      take("RPAREN");
      return node;
    }
    throw new Error(`คาดว่าจะเป็นตัวแปรหรือวงเล็บ แต่พบ “${token.value}”`);
  }

  const ast = parseOr();
  if (pos !== tokens.length) {
    throw new Error(`มีส่วนที่อ่านไม่ได้ใกล้ “${tokens[pos].value}”`);
  }
  return ast;
}

function getVariables(ast, set = new Set()) {
  if (ast.type === "VAR") set.add(ast.name);
  if (ast.left) getVariables(ast.left, set);
  if (ast.right) getVariables(ast.right, set);
  if (ast.child) getVariables(ast.child, set);
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function evaluate(ast, env) {
  switch (ast.type) {
    case "VAR": return !!env[ast.name];
    case "CONST": return ast.value;
    case "NOT": return !evaluate(ast.child, env);
    case "AND": return evaluate(ast.left, env) && evaluate(ast.right, env);
    case "OR": return evaluate(ast.left, env) || evaluate(ast.right, env);
    case "XOR": return evaluate(ast.left, env) !== evaluate(ast.right, env);
    case "XNOR": return evaluate(ast.left, env) === evaluate(ast.right, env);
    default: throw new Error("AST ไม่ถูกต้อง");
  }
}

function astToCanonicalText(ast, parentPrecedence = 0) {
  const precedence = { OR: 1, XOR: 2, XNOR: 2, AND: 3, NOT: 4, VAR: 5, CONST: 5 };
  let text;

  if (ast.type === "VAR") text = formatVariable(ast.name);
  else if (ast.type === "CONST") text = ast.value ? "1" : "0";
  else if (ast.type === "NOT") {
    const child = ast.child;
    if (child.type === "VAR" || child.type === "CONST") {
      text = `${astToCanonicalText(child, precedence.NOT)}'`;
    } else {
      text = `BAR(${astToCanonicalText(child)})`;
    }
  } else if (ast.type === "AND") {
    text = `${astToCanonicalText(ast.left, precedence.AND)}·${astToCanonicalText(ast.right, precedence.AND)}`;
  } else if (ast.type === "XOR") {
    text = `${astToCanonicalText(ast.left, precedence.XOR)} ⊕ ${astToCanonicalText(ast.right, precedence.XOR)}`;
  } else if (ast.type === "XNOR") {
    text = `${astToCanonicalText(ast.left, precedence.XNOR)} ⊙ ${astToCanonicalText(ast.right, precedence.XNOR)}`;
  } else if (ast.type === "OR") {
    text = `${astToCanonicalText(ast.left, precedence.OR)} + ${astToCanonicalText(ast.right, precedence.OR)}`;
  }

  return precedence[ast.type] < parentPrecedence ? `(${text})` : text;
}

function bitsFor(num, width) {
  return num.toString(2).padStart(width, "0");
}

function combineBits(a, b) {
  let diff = 0;
  let result = "";
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) result += a[i];
    else {
      if (a[i] === "-" || b[i] === "-") return null;
      diff++;
      result += "-";
      if (diff > 1) return null;
    }
  }
  return diff === 1 ? result : null;
}

function uniqueImplicants(list) {
  const map = new Map();
  for (const item of list) {
    if (!map.has(item.bits)) map.set(item.bits, { bits: item.bits, mins: new Set(item.mins) });
    else for (const m of item.mins) map.get(item.bits).mins.add(m);
  }
  return [...map.values()];
}

function getPrimeImplicants(minterms, width) {
  let current = minterms.map((m) => ({ bits: bitsFor(m, width), mins: new Set([m]) }));
  const primes = [];

  while (current.length) {
    const used = new Set();
    const next = [];

    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const combined = combineBits(current[i].bits, current[j].bits);
        if (combined !== null) {
          used.add(i);
          used.add(j);
          next.push({
            bits: combined,
            mins: new Set([...current[i].mins, ...current[j].mins])
          });
        }
      }
    }

    current.forEach((imp, idx) => {
      if (!used.has(idx)) primes.push(imp);
    });

    current = uniqueImplicants(next);
  }

  return uniqueImplicants(primes);
}

function covers(imp, minterm, width) {
  const bits = bitsFor(minterm, width);
  for (let i = 0; i < width; i++) {
    if (imp.bits[i] !== "-" && imp.bits[i] !== bits[i]) return false;
  }
  return true;
}

function literalCount(imp) {
  return [...imp.bits].filter((c) => c !== "-").length;
}

function chooseMinimumCover(primes, minterms, width) {
  const chart = new Map();
  for (const m of minterms) {
    chart.set(m, primes.map((p, i) => covers(p, m, width) ? i : -1).filter((i) => i >= 0));
  }

  const selected = new Set();
  let uncovered = new Set(minterms);

  let changed = true;
  while (changed) {
    changed = false;
    for (const m of [...uncovered]) {
      const options = chart.get(m).filter((i) => !selected.has(i));
      if (options.length === 1) {
        const idx = options[0];
        if (!selected.has(idx)) {
          selected.add(idx);
          changed = true;
        }
        for (const u of [...uncovered]) {
          if (covers(primes[idx], u, width)) uncovered.delete(u);
        }
      }
    }
  }

  if (!uncovered.size) return [...selected].map((i) => primes[i]);

  const candidateSet = new Set();
  for (const m of uncovered) {
    for (const i of chart.get(m)) if (!selected.has(i)) candidateSet.add(i);
  }
  const candidates = [...candidateSet];

  let best = null;
  let bestScore = [Infinity, Infinity];

  function score(choice) {
    return [choice.size, [...choice].reduce((sum, i) => sum + literalCount(primes[i]), 0)];
  }
  function better(a, b) {
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  }

  function dfs(remaining, choice) {
    const sc = score(choice);
    if (sc[0] > bestScore[0] || (sc[0] === bestScore[0] && sc[1] >= bestScore[1])) return;
    if (!remaining.size) {
      if (better(sc, bestScore)) {
        bestScore = sc;
        best = new Set(choice);
      }
      return;
    }

    let options = null;
    for (const m of remaining) {
      const opts = candidates.filter((i) => covers(primes[i], m, width));
      if (!options || opts.length < options.length) options = opts;
    }

    if (!options || !options.length) return;

    options.sort((a, b) => literalCount(primes[a]) - literalCount(primes[b]));
    for (const idx of options) {
      const nextChoice = new Set(choice);
      nextChoice.add(idx);
      const nextRemaining = new Set([...remaining].filter((m) => !covers(primes[idx], m, width)));
      dfs(nextRemaining, nextChoice);
    }
  }

  dfs(uncovered, new Set());
  if (!best) throw new Error("ไม่สามารถหาชุด implicant ที่ครอบคลุมได้");

  return [...new Set([...selected, ...best])].map((i) => primes[i]);
}

function implicantToText(imp, variables) {
  const parts = [];
  for (let i = 0; i < imp.bits.length; i++) {
    const name = formatVariable(variables[i]);
    if (imp.bits[i] === "1") parts.push(name);
    if (imp.bits[i] === "0") parts.push(`${name}'`);
  }
  return parts.length ? parts.join("·") : "1";
}

function simplifyBoolean(input) {
  const ast = parseBoolean(input);
  const variables = getVariables(ast);
  if (variables.length > 8) {
    throw new Error("เวอร์ชันเว็บนี้รองรับได้สูงสุด 8 ตัวแปร เพื่อให้การย่อทำงานเร็วในเบราว์เซอร์");
  }

  if (variables.length === 0) {
    return {
      result: evaluate(ast, {}) ? "1" : "0",
      normalized: astToCanonicalText(ast),
      variables,
      minterms: [],
      terms: 1,
      literals: 0
    };
  }

  const minterms = [];
  const total = 2 ** variables.length;
  for (let n = 0; n < total; n++) {
    const bits = bitsFor(n, variables.length);
    const env = {};
    variables.forEach((v, i) => env[v] = bits[i] === "1");
    if (evaluate(ast, env)) minterms.push(n);
  }

  if (minterms.length === 0) {
    return { result: "0", normalized: astToCanonicalText(ast), variables, minterms, terms: 1, literals: 0 };
  }
  if (minterms.length === total) {
    return { result: "1", normalized: astToCanonicalText(ast), variables, minterms, terms: 1, literals: 0 };
  }

  const primes = getPrimeImplicants(minterms, variables.length);
  const cover = chooseMinimumCover(primes, minterms, variables.length);
  const result = cover
    .sort((a, b) => a.bits.localeCompare(b.bits))
    .map((imp) => implicantToText(imp, variables))
    .join(" + ");

  return {
    result,
    normalized: astToCanonicalText(ast),
    variables,
    minterms,
    terms: cover.length,
    literals: cover.reduce((sum, imp) => sum + literalCount(imp), 0)
  };
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  resultBox.hidden = true;
}

function hideError() {
  errorBox.hidden = true;
}

function renderResult(data) {
  hideError();
  resultFormula.textContent = data.result;
  normalizedFormula.textContent = data.normalized;
  const vars = data.variables.length ? data.variables.map(formatVariable).join(", ") : "ไม่มี";
  const mins = data.minterms.length <= 24 ? data.minterms.join(", ") : `${data.minterms.slice(0, 24).join(", ")} …`;
  resultMeta.innerHTML = `
    <span>ตัวแปร: <strong>${vars}</strong></span>
    <span>พจน์: <strong>${data.terms}</strong></span>
    <span>Literal: <strong>${data.literals}</strong></span>
    <span>Minterm: <strong>${mins || "ไม่มี"}</strong></span>
  `;
  emptyState.hidden = true;
  resultBox.hidden = false;
}

function runSimplify() {
  try {
    const data = simplifyBoolean(formulaInput.value);
    renderResult(data);
  } catch (err) {
    showError(err.message || String(err));
  }
}

function insertIntoFormula(text, cursorBack = 0) {
  const start = formulaInput.selectionStart ?? formulaInput.value.length;
  const end = formulaInput.selectionEnd ?? start;
  formulaInput.value = formulaInput.value.slice(0, start) + text + formulaInput.value.slice(end);
  const cursor = start + text.length - cursorBack;
  formulaInput.focus();
  formulaInput.setSelectionRange?.(cursor, cursor);
}

if (document.querySelectorAll) {
  document.querySelectorAll(".symbol-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const text = button.dataset.template || button.dataset.insert || "";
      const cursorBack = Number(button.dataset.cursorBack || 0);
      insertIntoFormula(text, cursorBack);
    });
  });
}

imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0];
  if (!file) return;
  selectedImage = file;
  preview.src = URL.createObjectURL(file);
  previewWrap.hidden = false;
  ocrStatus.textContent = "เลือกรูปแล้ว — กด “อ่านข้อความจากรูป”";
  ocrProgress.style.width = "0%";
  ocrBtn.disabled = false;
});

ocrBtn.addEventListener("click", async () => {
  if (!selectedImage) return;
  if (!window.Tesseract) {
    showError("โหลด OCR library ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วรีเฟรชหน้า");
    return;
  }

  hideError();
  ocrBtn.disabled = true;
  simplifyBtn.disabled = true;
  ocrStatus.textContent = "กำลังอ่านข้อความจากรูป…";

  try {
    const result = await Tesseract.recognize(selectedImage, "eng", {
      logger: (m) => {
        if (m.status === "recognizing text" && typeof m.progress === "number") {
          const pct = Math.round(m.progress * 100);
          ocrProgress.style.width = `${pct}%`;
          ocrStatus.textContent = `กำลังอ่านข้อความ… ${pct}%`;
        }
      }
    });

    const raw = result.data.text.trim();
    const cleaned = cleanOcrText(raw);
    formulaInput.value = cleaned || raw;
    ocrStatus.textContent = cleaned
      ? "อ่านเสร็จแล้ว — ตรวจสูตร โดยเฉพาะ Bar/prime ก่อนกดย่อ"
      : "อ่านได้บางส่วน — กรุณาแก้สูตรในช่องข้อความ";
    ocrProgress.style.width = "100%";
    formulaInput.focus();
  } catch (err) {
    showError(`OCR ไม่สำเร็จ: ${err.message || err}`);
    ocrStatus.textContent = "OCR ไม่สำเร็จ";
  } finally {
    ocrBtn.disabled = false;
    simplifyBtn.disabled = false;
  }
});

simplifyBtn.addEventListener("click", runSimplify);
formulaInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") runSimplify();
});

const examples = [
  "CD + CD'",
  "X ⊕ Y",
  "BAR(X+Y)",
  "Sensor*Enable + Sensor*Enable'",
  "[INPUT]*Q1 + [INPUT]*Q1'"
];

exampleBtn.addEventListener("click", () => {
  formulaInput.value = examples[exampleIndex % examples.length];
  exampleIndex++;
  runSimplify();
});

clearBtn.addEventListener("click", () => {
  formulaInput.value = "";
  imageInput.value = "";
  selectedImage = null;
  previewWrap.hidden = true;
  resultBox.hidden = true;
  emptyState.hidden = false;
  errorBox.hidden = true;
  ocrBtn.disabled = true;
  ocrStatus.textContent = "ยังไม่ได้เลือกรูป";
  ocrProgress.style.width = "0%";
  formulaInput.focus();
});

window.BooleanSimplifier = {
  simplifyBoolean,
  parseBoolean,
  cleanOcrText,
  tokenize,
  formatVariable,
  normalizeVisualSymbols
};
