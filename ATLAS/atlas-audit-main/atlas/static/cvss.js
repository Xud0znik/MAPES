"use strict";

(function () {

  const M31 = [
    { k: "AV", label: "Attack vector", opts: [["N", "Network"], ["A", "Adjacent"], ["L", "Local"], ["P", "Physical"]] },
    { k: "AC", label: "Attack complexity", opts: [["L", "Low"], ["H", "High"]] },
    { k: "PR", label: "Privileges required", opts: [["N", "None"], ["L", "Low"], ["H", "High"]] },
    { k: "UI", label: "User interaction", opts: [["N", "None"], ["R", "Required"]] },
    { k: "S", label: "Scope", opts: [["U", "Unchanged"], ["C", "Changed"]] },
    { k: "C", label: "Confidentiality", opts: [["H", "High"], ["L", "Low"], ["N", "None"]] },
    { k: "I", label: "Integrity", opts: [["H", "High"], ["L", "Low"], ["N", "None"]] },
    { k: "A", label: "Availability", opts: [["H", "High"], ["L", "Low"], ["N", "None"]] },
  ];
  const DEF31 = { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" };

  const M40 = [
    { k: "AV", label: "Attack vector", opts: [["N", "Network"], ["A", "Adjacent"], ["L", "Local"], ["P", "Physical"]] },
    { k: "AC", label: "Attack complexity", opts: [["L", "Low"], ["H", "High"]] },
    { k: "AT", label: "Attack requirements", opts: [["N", "None"], ["P", "Present"]] },
    { k: "PR", label: "Privileges required", opts: [["N", "None"], ["L", "Low"], ["H", "High"]] },
    { k: "UI", label: "User interaction", opts: [["N", "None"], ["P", "Passive"], ["A", "Active"]] },
    { k: "VC", label: "Confidentiality (vulnerable system)", opts: [["H", "High"], ["L", "Low"], ["N", "None"]] },
    { k: "VI", label: "Integrity (vulnerable system)", opts: [["H", "High"], ["L", "Low"], ["N", "None"]] },
    { k: "VA", label: "Availability (vulnerable system)", opts: [["H", "High"], ["L", "Low"], ["N", "None"]] },
    { k: "SC", label: "Confidentiality (subsequent system)", opts: [["H", "High"], ["L", "Low"], ["N", "None"]] },
    { k: "SI", label: "Integrity (subsequent system)", opts: [["H", "High"], ["L", "Low"], ["N", "None"]] },
    { k: "SA", label: "Availability (subsequent system)", opts: [["H", "High"], ["L", "Low"], ["N", "None"]] },
  ];
  const DEF40 = { AV: "N", AC: "L", AT: "N", PR: "N", UI: "N", VC: "H", VI: "H", VA: "H", SC: "N", SI: "N", SA: "N" };

  function metrics(version) { return version === "4.0" ? M40 : M31; }
  function defaults(version) { return Object.assign({}, version === "4.0" ? DEF40 : DEF31); }

  function toVector(version, m) {
    const order = metrics(version).map((x) => x.k);
    const head = version === "4.0" ? "CVSS:4.0" : "CVSS:3.1";
    return head + "/" + order.map((k) => k + ":" + (m[k] || defaults(version)[k])).join("/");
  }
  function parse(vector) {
    const out = {};
    let version = "3.1";
    String(vector || "").split("/").forEach((part) => {
      const [k, v] = part.split(":");
      if (k === "CVSS") version = v;
      else if (k && v) out[k] = v;
    });
    return { version, metrics: out };
  }

  function roundup(x) {
    const i = Math.round(x * 100000);
    return (i % 10000 === 0) ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
  }

  function score31(m) {
    m = Object.assign(defaults("3.1"), m);
    const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[m.AV];
    const AC = { L: 0.77, H: 0.44 }[m.AC];
    const UI = { N: 0.85, R: 0.62 }[m.UI];
    const scopeChanged = m.S === "C";
    const PR = (scopeChanged ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 })[m.PR];
    const imp = { H: 0.56, L: 0.22, N: 0 };
    const C = imp[m.C], I = imp[m.I], A = imp[m.A];
    if ([AV, AC, UI, PR, C, I, A].some((v) => v == null)) return null;
    const iss = 1 - (1 - C) * (1 - I) * (1 - A);
    const impact = scopeChanged
      ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
      : 6.42 * iss;
    const expl = 8.22 * AV * AC * PR * UI;
    let base;
    if (impact <= 0) base = 0;
    else base = roundup(Math.min((scopeChanged ? 1.08 : 1) * (impact + expl), 10));
    return { score: base, exact: true };
  }

  function score40(m) {
    m = Object.assign(defaults("4.0"), m);
    const imp = { H: 0.56, L: 0.22, N: 0 };
    const vuln = 1 - (1 - imp[m.VC]) * (1 - imp[m.VI]) * (1 - imp[m.VA]);
    const sub = 1 - (1 - imp[m.SC]) * (1 - imp[m.SI]) * (1 - imp[m.SA]);
    const impact = 6.42 * Math.max(vuln, sub * 0.92);
    const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[m.AV];
    const AC = { L: 0.77, H: 0.44 }[m.AC];
    const AT = { N: 0.85, P: 0.62 }[m.AT];
    const PR = { N: 0.85, L: 0.62, H: 0.27 }[m.PR];
    const UI = { N: 0.85, P: 0.62, A: 0.5 }[m.UI];
    if ([AV, AC, AT, PR, UI].some((v) => v == null)) return null;
    const expl = 8.22 * AV * AC * AT * PR * UI;
    const base = impact <= 0 ? 0 : roundup(Math.min(impact + expl, 10));
    return { score: base, exact: false };
  }

  function band(score) {
    if (score == null) return { sev: "info", name: "—" };
    if (score <= 0) return { sev: "info", name: "None" };
    if (score < 4) return { sev: "low", name: "Low" };
    if (score < 7) return { sev: "med", name: "Medium" };
    if (score < 9) return { sev: "high", name: "High" };
    return { sev: "crit", name: "Critical" };
  }

  function evaluate(version, m) {
    const r = version === "4.0" ? score40(m) : score31(m);
    if (!r) return null;
    const b = band(r.score);
    return { version, vector: toVector(version, m), score: r.score, exact: r.exact,
      severity: b.sev, severityName: b.name };
  }

  window.CVSS = { metrics, defaults, toVector, parse, evaluate, band, score31, score40 };
})();
