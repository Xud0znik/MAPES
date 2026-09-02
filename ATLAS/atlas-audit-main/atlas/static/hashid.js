"use strict";

(function () {
  const hex = (s, n) => new RegExp("^[a-f0-9]{" + n + "}$", "i").test(s);

  const RULES = [
    { rx: /^\$krb5tgs\$(23|17|18|19)\$/i, name: "Kerberos 5 TGS-REP (Kerberoast)", mode: "13100/19600/19700" },
    { rx: /^\$krb5asrep\$(23|17|18)\$/i, name: "Kerberos 5 AS-REP (AS-REP roast)", mode: "18200/32100/32200" },
    { rx: /^\$krb5pa\$/i, name: "Kerberos 5 PA-ENC-TIMESTAMP", mode: "7500" },
    { rx: /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/, name: "bcrypt", mode: "3200" },
    { rx: /^\$6\$/, name: "sha512crypt (Unix $6$)", mode: "1800" },
    { rx: /^\$5\$/, name: "sha256crypt (Unix $5$)", mode: "7400" },
    { rx: /^\$1\$/, name: "md5crypt (Unix $1$)", mode: "500" },
    { rx: /^\$y\$/, name: "yescrypt", mode: "-" },
    { rx: /^\$DCC2\$/i, name: "Domain Cached Credentials 2 (mscash2)", mode: "2100" },
    { rx: /^\$sha1\$/i, name: "sha1crypt", mode: "15100" },
    { rx: /^\$argon2/i, name: "Argon2", mode: "-" },
    { rx: /^[^:]+::[^:]*:[a-f0-9]{16}:[a-f0-9]{32}:[a-f0-9]+$/i, name: "NetNTLMv2", mode: "5600" },
    { rx: /^[^:]+::[^:]*:[a-f0-9]{48}:[a-f0-9]{48}:[a-f0-9]{16}$/i, name: "NetNTLMv1", mode: "5500" },
    { rx: /^\*[A-F0-9]{40}$/i, name: "MySQL 4.1+ (SHA1 doble)", mode: "300" },
    { rx: /^[a-f0-9]{32}:[a-f0-9]{32}$/i, name: "LM:NTLM (par de PWDUMP)", mode: "1000 (NT)" },
    { rx: /^[a-f0-9]{16}$/i, name: "LM / DES", mode: "3000" },
  ];

  function detect(secret) {
    const s = String(secret || "").trim();
    if (!s) return { primary: "", candidates: [], crackable: false, mode: "" };

    for (const r of RULES) {
      if (r.rx.test(s)) return { primary: r.name, candidates: [r.name], crackable: r.mode !== "-", mode: r.mode };
    }

    if (hex(s, 32)) return { primary: "NTLM / MD5 (32 hex)", candidates: ["NTLM", "MD5", "MD4"], crackable: true, mode: "1000 (NT) / 0 (MD5)" };
    if (hex(s, 40)) return { primary: "SHA-1", candidates: ["SHA-1", "MySQL 4.1 (sin *)", "RIPEMD-160"], crackable: true, mode: "100" };
    if (hex(s, 56)) return { primary: "SHA-224", candidates: ["SHA-224"], crackable: true, mode: "1300" };
    if (hex(s, 64)) return { primary: "SHA-256", candidates: ["SHA-256", "SHA3-256", "Keccak-256"], crackable: true, mode: "1400" };
    if (hex(s, 96)) return { primary: "SHA-384", candidates: ["SHA-384"], crackable: true, mode: "10800" };
    if (hex(s, 128)) return { primary: "SHA-512", candidates: ["SHA-512", "SHA3-512", "Whirlpool"], crackable: true, mode: "1700" };
    return { primary: "", candidates: [], crackable: false, mode: "" };
  }

  function looksLikeHash(secret) {
    const s = String(secret || "").trim();
    if (!s) return false;
    return detect(s).primary !== "" || /^\$[a-z0-9]+\$/i.test(s) || (/^[a-f0-9]+$/i.test(s) && s.length >= 16);
  }

  window.HASHID = { detect, looksLikeHash };
})();
