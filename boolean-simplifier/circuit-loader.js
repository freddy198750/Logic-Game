(() => {
  "use strict";
  // Load the circuit analyzer and apply a small topology fix before executing it.
  // Some AND symbols have a long vertical flat edge that can otherwise be mistaken
  // for a wire joining the gate's two input pins.
  fetch("circuit.js?v=8", { cache: "no-store" })
    .then((r) => {
      if (!r.ok) throw new Error(`โหลด Circuit Analyzer ไม่สำเร็จ (${r.status})`);
      return r.text();
    })
    .then((src) => {
      const needle = "    gate.inputs = inputs;\n    gate.output = output;";
      const replacement = `    gate.inputs = inputs;\n    if (gate.type === \"AND\" && inputs.length) {\n      gate.body.x0 = Math.min(gate.body.x0, Math.min(...inputs.map((s) => s.x2)) - 8);\n    }\n    gate.output = output;`;
      if (!src.includes(needle)) throw new Error("Circuit Analyzer patch ไม่ตรงกับเวอร์ชันปัจจุบัน");
      // eslint-disable-next-line no-eval
      (0, eval)(src.replace(needle, replacement));
    })
    .catch((err) => {
      console.error(err);
      const status = document.getElementById("ocrStatus");
      if (status) status.textContent = "โหลดโหมดวิเคราะห์วงจรไม่สำเร็จ";
    });
})();
