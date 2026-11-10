# multipi permission policy (draft for operator review)

Date: 2026-11-09 · Status: DRAFT — not a contract until merged as spec
References: `docs/permission-example.json` (operator's command sample),
`docs/permissions.local.example.json` (original claude-dev-loop local permissions),
incident: 2026-11-09 unauthorized upgrade of a foreign repo (the "oneshot" incident).

## 1. Problem and non-goals

Guidelines (AGENTS.md stop conditions, role prompts) failed exactly when they
mattered: the orchestrator inferred a target repo it was not told about, and
mutated it. Every mechanism that depends on the model *choosing* to comply is a
guideline, not a control.

**Goal:** deterministic allow/deny/ask decisions sitting between the model's
intent and the effect, for the orchestrator session (the widest-blast-radius
actor). Fail closed: anything the evaluator cannot positively classify as
safe for the *declared* action is denied or escalated, never defaulted
through.

**Non-goals (v1):**
- Not an OS security boundary. Same-user token forgery, `/proc` env reads,
  and exfiltration via allowed channels are out of scope; the escape hatch is
  a dedicated user/container (pi's documented model), and the audit trail
  makes policy violations reviewable even where enforcement cannot be perfect.
- Not a sandbox for children. Children already run in worktrees with narrow
  roles; the scenario-store guard is unchanged.
- Not a substitute for the loop's existing fail-closed discipline
  (probe-negative ⇒ keep, gate-red ⇒ no merge).

## 2. The three dimensions of an action

Every action the policy sees reduces to one of three questions; the policy
block carries all three:

1. **Command** — is this shell/tool invocation itself a known-dangerous
   shape? (force push, `reset --hard`, repo delete, `pr merge --admin`,
   `.env` access, token-dir access…) — the operator's first sample answers
   this dimension.
2. **Program** — is this invocation a *trusted loop program* (a script from
   the installed `scripts/` set) or freeform? The original claude-dev-loop
   allowed exactly its script set; that is the trusted-surface allowlist.
   Trusted programs act by identity (`realpath` against the installed
   scripts dir), not by name or path string the model composed.
3. **Path/repo** — what does this action *touch*? Files (Edit/Write/Read
   targets, shell file operands) are confined to the configured write scope:
   the repo, its worktrees, the notes dir, the gate worktree, and temp
   space. Git operations are confined to the configured repo allowlist —
   resolved from **ground truth** (see §4), never from inference.

`additionalDirectories` (the old file's path list) is not hand-maintained:
it is **computed from `.devloop.json`** (notes/worktree/gate paths already
live there) and rendered into the effective policy.

## 3. Verdict model

Each policy rule yields one of three verdicts; resolution on an action:

```
deny  (any deny rule matches)            -> BLOCK
ask   (any ask rule matches, no deny)    -> ESCALATE  (§6)
allow (an allow rule matches)            -> PASS
default (nothing matches)                -> PASS   (posture: default-allow,
                                                     deny-by-class)
```

**Posture decision (operator-confirmed 2026-11-09):** default-allow with
curated deny/ask classes — "a tripwire is a good first step and makes the
LLM think about what it is trying to do." The allow list is bookkeeping and
audit baseline, not load-bearing; a strict mode (default-ask, allow grown
from audit-log data) is a documented future flip, not v1.

Rule syntax: the operator's dialect, verbatim —
`Bash(<prefix>*)`, `Read(<path-glob>)`, `Edit(<path-glob>)`, `*` glob
matching, deny > ask > allow precedence. One refinement v1 adopts over raw
CC glob semantics: `Bash` patterns match the **invocation's first token +
command line** with explicit documented limits (see §9 limits).

## 4. Two enforcement layers

**Layer 1 — hook (the tripwire).** The existing `tool_call` hook seat
(guard.ts idiom), now applicable to the **orchestrator** session too. It
evaluates all three dimensions from the tool arguments:
- command rules: string patterns (§3);
- program rules: leading-path prefix match against the installed scripts dir;
- path rules: operand/path extraction for Read/Edit/Write tools and crude
  `git -C <path>` / absolute-path tripwires for Bash.

Verdicts: deny ⇒ block with rule id + one-line reason (the tripwire: the
reason text is what makes the model reconsider). ask ⇒ block with an
escalation directive (§6). Default/allow ⇒ pass.

Layer 1's known limits are its documented contract, not an accident:
arbitrary shell can wrap, quote, or substitute around string patterns.
Layer 1 exists for recall against the common surface and for the
reconsideration effect, **not as the boundary**.

**Layer 2 — shims (the guarantee).** `git` and `gh` wrapper shims prepended
to the session PATH (the smoke-test shim idiom, productized):
- **Repo scope (git):** on mutation subcommands (commit, push, tag,
  checkout -b is fine — read-only refs never deny), the shim resolves the
  acting repository via `git rev-parse --git-common-dir` + the configured
  remote URL, compares against the policy repo allowlist.
  Target ∉ allowlist ⇒ exit 126 with a policy line. **Unresolvable ⇒ deny.**
- **Refspec scope (git push):** base branch of any allowlisted repo ⇒ deny
  (merges travel through `merge-train.sh` only — §5); force flags
  (`-f`/`--force`/`+` in refspecs) ⇒ deny.
- **Dangerous classes (gh):** `repo delete`, `pr merge` (any form outside a
  trusted program) ⇒ deny or ask per the ask list.
- Everything else passes through untouched to the real binary (shim =
  wrapper, not reimplementation).

Layer 2 sees real argv and live git state: the inference hole of the
oneshot incident is structurally closed — the decision is made from
`rev-parse` output, never from what the model believes it is inside.

## 5. Trusted programs (identity exemption)

Loop scripts (`scripts/*.sh` under the installed root, matched by realpath)
act **by identity**: their internal git/gh calls are exempt from Layer-1
string patterns and from the Layer-2 base-branch/force denials — because the
*script code*, reviewed and gated by the ordinary pipeline, is the
authorized actor (merge-train pushes main; that is its entire job). The
exemption is scoped to the script's own child processes (the shim checks
`$PPID` ancestry / an env marker the script sets) and never extends to
shell invocations that merely *mention* a script path.

Consequence: anything not implemented inside a trusted script is subject to
the full policy — freeform `gh pr merge`, freeform tag+push, freeform
installs into foreign repos all stay denied/ask. Capability lives in
reviewed code, not in the model.

## 6. The ask machinery (approval class)

An `ask` verdict blocks with a structured directive:
`ASK <rule-id>: <action summary>. Operator approval required: run
'multipi-approve <rule-id>' in your own shell, then retry.`

- **Minting:** `multipi-approve` (a CLI the operator runs in *their* shell)
  writes a token into the per-project token dir
  (`~/.multipi/<project>/dev-loop-tokens/<rule-id>.tok`): HMAC-signed with a
  per-project secret held in the operator's environment (never in the repo,
  never readable by the loop — the operator's `Read(...dev-loop-tokens/**)`
  deny from the sample is *inverted*: the operator's CLI reads its own dir;
  the agent's Read denies keep the agent from sniffing tokens or secrets),
  carrying rule-id, target scope, and a short TTL (default 10 min, policy
  configurable).
- **Consumption:** the hook/shim, on an ask-class action whose parameters
  match a live token's scope, passes it through and consumes (singleshot)
  the token. Token file perms 0600, dir 0700.
- **Honest residual:** one shared OS user means the hard boundary is still
  the OS (§1). What the scheme buys: the agent cannot compute a valid token
  (needs the operator's secret), cannot read them (Read deny), cannot
  perform the operation any other way (freeform spellings denied), and every
  ask-hit and consumption is in the audit log with enough context that a
  self-approved-looking event is reviewable. The escalation-to-user
  container remains the ironclad option.

**Ask list (proposed, operator to confirm):**
- `cleanup-worktrees.sh --apply` (the original file's exact precedent);
- `git tag` (create/delete) and `git push --tags` / tag refspecs;
- `gh pr merge` outside a trusted program;
- any base-branch push attempt not already flat-denied (defense in depth);
- `install.sh` with a **foreign** target (see rule below — this is the
  oneshot-incident rule, and it lands in ask, not deny: upgrading another
  repo is legitimate *with* consent).

## 7. The oneshot-incident rules (the delta no sample had)

Expressed because no string pattern can:

1. **Foreign-repo mutation ⇒ deny by default, ask for whitelisted
   secondaries.** Any resolved git target, install target, or file-write
   scope outside {self, allowlisted secondaries} ⇒ deny. `install.sh
   <foreign>` ⇒ ask if the foreign path is in the policy's
   `secondaries` list, deny otherwise.
2. **Inference is not a source.** Where the acting repo/path cannot be
   resolved with certainty (`rev-parse` fails, cwd ambiguous, wrapped
   invocation), the verdict is deny (fail closed) — the exact failure mode
   of 2026-11-09 is now the fail direction.
3. **Repo allowlist is data.** `.devloop.json` `policy.repos`:
   `["self"]` or `["self", "/abs/path"]`. Self-only is the default.

## 8. Audit, governance, observability

- **Audit log:** one JSONL line per non-default verdict (denies, asks,
  ask-consumptions) + a heartbeat sample of allowed dangerous-class
  near-misses: timestamp, session, rule-id, verdict, action summary
  (bounded length, no secrets/store paths), layer (hook/shim). Written to
  the state dir's `logs/policy-audit.jsonl`; never to the repo, never
  forwarded to children (log-hygiene rules apply).
- **Policy governance:** the policy is config-in-repo (`policy` block in
  `.devloop.json` or an adjacent `permissions.json` loaded by the same
  loader), so edits ride the ordinary pipeline — PR, review, gate, merge.
  The hook records a SHA of the effective policy at session start into the
  audit log and warns on drift vs. the last committed one at each
  non-default verdict. Self-loosening becomes a visible PR plus audit noise,
  not a silent change.
- **Doctor surface:** `doctor.sh` gains a `policy` section: loaded?
  effective default posture, rule counts per verdict, shim presence
  (missing shims on PATH ⇒ MISSING with the repair line, fail closed — an
  uninstall that removes shims but leaves policy is a broken state, not a
  quiet bypass).
- **`policy.sh` (small, operator-facing):** `show` (effective policy
  rendered), `audit [--since]` (tail), `explain <command>` (dry-run a
  command string through the evaluator — the tripwire made interactive).

## 9. Documented limits (honest contract)

- Hook string matching: bypassable by wrapping/quoting/substitution —
  accepted; Layer 2 + the fail-closed default on unresolvable targets is the
  compensation for git/gh, and the audit log is the compensation elsewhere.
- Read/Edit path rules cover the tools, not `cat`/`sed` inside Bash — the
  token-dir `.env` denials are therefore tripwires only; the secret-minting
  design (§6) does not rely on them.
- Shim coverage = git + gh. Other mutators (raw HTTPS, rsync, …) are out of
  v1 scope; the audit heartbeat makes heavy foreign-path traffic visible.
- Shared-user residual: see §6.
- Ask tokens are singleshot + TTL + scope-bound; a stolen token is a
  bounded, audited exposure, not a standing grant.

## 10. Phasing and acceptance

**Phase 1 (tripwire + guarantee for git/gh):**
(a) policy config schema + pure `policy.ts` evaluator (operator's dialect,
precedence, repo/path resolution from arguments); unit-pinned.
(b) hook wiring for orchestrator (and children, harmless); audit log;
session-start policy hash.
(c) git/gh shims: repo-scope, base-branch/force deny, dangerous gh classes,
trusted-program identity exemption (§5).
(d) doctor `policy` section + `policy.sh show/explain`.
(e) smoke: every rule class; the three oneshot-delta rules (foreign target
deny, unresolvable-target deny, secondaries ask); shim-bypass honesty
(wrapped invocation passes Layer 1 but hits Layer 2); audit line shapes.

Acceptance (phase 1): a scripted replay of the oneshot-incident command
sequences is denied at Layer 2 with the correct rule id, and the loop's own
operations (dispatch/review/gate/merge, incl. merge-train's main push) run
clean through the shims with zero new denies in the audit log over a full
train cycle.

**Phase 2 (ask machinery):** `multipi-approve`, token dir + HMAC + TTL,
ask-class consumption, token Read denies wired, smoke with a fake-token
forge attempt (invalid HMAC ⇒ still blocked) and a mint→consume happy path
driven by a fixture operator CLI.

**Out of phase 2 (parked):** strict-mode default-ask flip, additional shims
(curl/rsync/… ), container/dedicated-user hardening guide.

## 11. Ticket decomposition (provisional)

| # | Ticket | Depends on |
|---|--------|-----------|
| P1 | policy config + `policy.ts` evaluator + unit pins | — |
| P2 | hook wiring (orchestrator) + audit log + policy hash | P1 |
| P3 | git/gh shims + repo-scope/base-branch/force + trusted-program exemption | P1 (uses evaluator) |
| P4 | doctor policy section + `policy.sh` (show/explain/audit) | P2, P3 |
| P5 | smoke suite: rule classes, oneshot-delta rules, shim honesty, full-train zero-deny acceptance | P2, P3 |
| P6 | (phase 2) ask machinery: multipi-approve, tokens, consumption, forge-resist pins | P2 |

Each ticket independently gatable in the ordinary pipeline; P3's exemption
logic is the one delicate piece (gets its own review pass on the PPID/
marker ancestry check).
