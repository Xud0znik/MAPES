# Security Policy

ATLAS is an offensive-security tool that holds sensitive engagement data —
credentials, findings and screenshots. Its security matters, and reports are
welcome.

## Supported versions

ATLAS is developed on a rolling basis. Security fixes land on the latest
release and on `main`.

| Version | Supported |
| ------- | --------- |
| latest release / `main` | ✅ |
| older tags | ❌ |

Always run the latest version before reporting an issue.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.** Disclose it
privately first so a fix can ship before the details are public.

Preferred channel:

1. **GitHub Security Advisories** — on the repository, go to the **Security**
   tab → **Report a vulnerability**. This opens a private advisory visible only
   to you and the maintainer.

If you cannot use that, reach the maintainer privately through the
[HackNode Discord](https://discord.gg/jk5v7wDcSN) or
[LinkedIn](https://www.linkedin.com/in/marc-teruel-ruiz-5a9515222).

When you report, please include:

- A clear description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- The ATLAS version / commit and how you ran it (OS, Python version, TLS on/off,
  bound host).

### What to expect

- Acknowledgement of your report as soon as possible.
- An assessment and, for a confirmed issue, a fix on `main`.
- Credit in the release notes if you would like it (tell us how to name you).

There is no bug-bounty programme; this is a personal open project.

## Scope

**In scope** — anything that lets an attacker who is *not* meant to have access
compromise ATLAS or the data it holds, for example:

- Authentication bypass, or reading/writing data without a valid session.
- Weaknesses in the credential vault encryption or the password/envelope scheme.
- Cross-site request forgery, DNS-rebinding, or cross-origin bypasses against a
  local instance.
- Path traversal, SQL injection, stored XSS, or leaking secrets in responses,
  logs or error messages.

**Out of scope / by design** — these are documented behaviours, not
vulnerabilities:

- **No password recovery.** The data key is only stored sealed by your password;
  forgetting it means the encrypted secrets are unrecoverable. This is
  deliberate and there is no backdoor.
- **Running with no password.** ATLAS can start without authentication (it warns
  loudly, and stores secrets in clear). That is an explicit operator choice.
- **Binding to `0.0.0.0`.** Exposing ATLAS on the network is the operator's
  decision; set a password first. ATLAS warns about this.
- **The self-signed TLS certificate.** It encrypts traffic but proves no
  identity — expected for a local tool.
- Findings that require an attacker who already has the operator's password,
  local filesystem access to `data/`, or physical/OS-level access to the machine.

## Handling engagement data

ATLAS is meant for **authorised security assessments only**. Treat the `data/`
folder and `conf.json` as sensitive material — both are git-ignored by default
and must never be committed. Credential secrets are encrypted at rest with
ChaCha20-Poly1305 under a password-sealed data key; everything else in the
project (node names, findings, notes, screenshots) is not encrypted, so protect
the folder accordingly.
