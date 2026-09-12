(() => {
  "use strict";

  const B = window.BooleanSimplifier;
  if (!B || typeof B.simplifyBoolean !== "function") return;

  const originalSimplify = B.simplifyBoolean.bind(B);

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
        if (diff > 1) return null;
        result += "-";
      }
    }
    return diff === 1 ? result : null;
  }

  function uniqueImplicants(list) {
    const map = new Map();
    for (const item of list) {
      if (!map.has(item.bits)) {
        map.set(item.bits, { bits: item.bits, mins: new Set(item.mins) });
      } else {
        const target = map.get(item.bits);
        for (const m of item.mins) target.mins.add(m);
      }
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
          const bits = combineBits(current[i].bits, current[j].bits);
          if (bits === null) continue;
          used.add(i);
          used.add(j);
          next.push({ bits, mins: new Set([...current[i].mins, ...current[j].mins]) });
        }
      }
      current.forEach((imp, i) => { if (!used.has(i)) primes.push(imp); });
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
    let n = 0;
    for (const c of imp.bits) if (c !== "-") n++;
    return n;
  }

  // Exact two-level SOP cover: first minimize number of product terms,
  // then minimize total literal count. The important difference from the old
  // version is that a minterm removed earlier in the same essential-PI pass is
  // never examined again as though it were still uncovered.
  function chooseExactCover(primes, minterms, width) {
    const chart = new Map();
    for (const m of minterms) {
      chart.set(m, primes.map((p, i) => covers(p, m, width) ? i : -1).filter((i) => i >= 0));
    }

    const selected = new Set();
    const uncovered = new Set(minterms);

    let changed = true;
    while (changed) {
      changed = false;
      for (const m of [...uncovered]) {
        // m may have been covered by an implicant selected earlier in this pass.
        if (!uncovered.has(m)) continue;
        const options = chart.get(m).filter((i) => !selected.has(i));
        if (options.length !== 1) continue;
        const idx = options[0];
        selected.add(idx);
        changed = true;
        for (const u of [...uncovered]) {
          if (covers(primes[idx], u, width)) uncovered.delete(u);
        }
      }
    }

    if (!uncovered.size) return [...selected].map((i) => primes[i]);

    const selectedLiteralCost = [...selected].reduce((sum, i) => sum + literalCount(primes[i]), 0);
    let bestChoice = null;
    let bestTerms = Infinity;
    let bestLiterals = Infinity;
    const memo = new Map();

    function scoreChoice(choice) {
      return [...choice].reduce((sum, i) => sum + literalCount(primes[i]), 0);
    }

    function dfs(remaining, choice) {
      const termCount = selected.size + choice.size;
      const literalCost = selectedLiteralCost + scoreChoice(choice);
      if (termCount > bestTerms || (termCount === bestTerms && literalCost >= bestLiterals)) return;

      if (!remaining.size) {
        bestTerms = termCount;
        bestLiterals = literalCost;
        bestChoice = new Set(choice);
        return;
      }

      const remKey = [...remaining].sort((a, b) => a - b).join(",");
      const stateScore = `${choice.size}:${scoreChoice(choice)}`;
      const seen = memo.get(remKey);
      if (seen) {
        const [seenTerms, seenLits] = seen.split(":").map(Number);
        if (seenTerms < choice.size || (seenTerms === choice.size && seenLits <= scoreChoice(choice))) return;
      }
      memo.set(remKey, stateScore);

      let target = null;
      let options = null;
      for (const m of remaining) {
        const opts = chart.get(m).filter((i) => !selected.has(i) && !choice.has(i));
        if (!opts.length) return;
        if (!options || opts.length < options.length) {
          target = m;
          options = opts;
          if (opts.length === 1) break;
        }
      }
      if (target === null || !options) return;

      // Prefer implicants covering more remaining minterms, then fewer literals.
      options.sort((a, b) => {
        let ca = 0, cb = 0;
        for (const m of remaining) {
          if (covers(primes[a], m, width)) ca++;
          if (covers(primes[b], m, width)) cb++;
        }
        return cb - ca || literalCount(primes[a]) - literalCount(primes[b]) || a - b;
      });

      for (const idx of options) {
        const nextRemaining = new Set(remaining);
        for (const m of [...nextRemaining]) {
          if (covers(primes[idx], m, width)) nextRemaining.delete(m);
        }
        choice.add(idx);
        dfs(nextRemaining, choice);
        choice.delete(idx);
      }
    }

    dfs(new Set(uncovered), new Set());
    const all = new Set(selected);
    if (bestChoice) for (const i of bestChoice) all.add(i);
    return [...all].map((i) => primes[i]);
  }

  function implicantToText(imp, variables) {
    const parts = [];
    for (let i = 0; i < imp.bits.length; i++) {
      if (imp.bits[i] === "-") continue;
      const name = B.formatVariable(variables[i]);
      parts.push(imp.bits[i] === "1" ? name : `${name}'`);
    }
    return parts.length ? parts.join("·") : "1";
  }

  function exactify(data) {
    if (!data || !Array.isArray(data.variables) || !Array.isArray(data.minterms)) return data;
    const width = data.variables.length;
    if (!width || data.result === "0" || data.result === "1") return data;
    const total = 2 ** width;
    if (!data.minterms.length || data.minterms.length === total) return data;

    const primes = getPrimeImplicants(data.minterms, width);
    const cover = chooseExactCover(primes, data.minterms, width)
      .sort((a, b) => a.bits.localeCompare(b.bits));

    return {
      ...data,
      result: cover.map((imp) => implicantToText(imp, data.variables)).join(" + "),
      terms: cover.length,
      literals: cover.reduce((sum, imp) => sum + literalCount(imp), 0),
      exactCover: true
    };
  }

  B.simplifyBoolean = function simplifyBooleanExact(input) {
    return exactify(originalSimplify(input));
  };

  window.BooleanSimplifierExact = {
    exactify,
    chooseExactCover,
    getPrimeImplicants
  };
})();
