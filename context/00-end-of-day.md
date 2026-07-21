# StrangeLoop — End-of-Day Report for Mike (2026-06-26)

## 1. TL;DR & PR #2 Status

Thank you for pushing PR #2! Based on my review, it appears to address 9 of the issues I previously flagged. I started the local verification pass today and captured proof for the memory-server issues.

**Current verification note: MCP wrapper is stale, direct API works**
I successfully verified the memory-server issues. For the PR #2 engine fixes, the blocker is specifically the MCP wrapper path, not the Engine itself.
- **Issue:** The MCP tool `trigger_run` appears to use an older trigger contract and fails with `Cannot POST /api/runs (404 Not Found)` when pointed at the wrong service/path. In the current API, Studio (`:5003`) assembles the snapshot via `/api/agents/assemble`, then Engine (`:5002`) starts the run via `/api/runs` with a `snapshot` payload.
- **Impact:** I should not rely on the MCP wrapper for PR #2 verification until it is updated. Direct API verification is still possible; I already used that path for the B9 probe, and B0 can be checked by calling Studio assemble directly.

Below is the consolidated evidence and detailed technical context for the remaining open items, as well as the exact root causes I traced for the items addressed in PR #2 (for your reference).

### Phase 2 Verification Results So Far

- **SC-2 (List-All Leak):** I successfully reproduced this issue. Calling `GET /v1/memory?scope_values={}` returned `200 OK` along with 61 scoped rows, which incorrectly included data leaking across multiple tenants (`SL-TEST-A`, `SL-TEST-B`, and `SL-TEST-HITL`). *(Proof captured in `evidence/phase-2-proofs/sc2_leak_proof.pretty.json`)*
- **BUG-R1 (Memory Retrieve 500 Crash):** I successfully reproduced this crash. Calling `POST /v1/memory/retrieve` returned an HTTP `500` error caused by `Protocol.UndefinedError` for `Jason.Encoder` on `MemoryServer.Schemas.SessionMemory`. *(Proof captured in `evidence/phase-2-proofs/bug_r1_response.html`)*
- **BUG-R1 Local Hotfix Re-test (not upstream):** I re-applied the local `@derive Jason.Encoder` hotfix on the three memory schemas and re-ran Plan 08 direct data-plane checks. Exact-scope retrieve now returns `HTTP 200` for session+semantic hits and episodic hits; foreign patient/study scopes still return empty. This proves the root cause, but BUG-R1 remains open upstream until Mike ships the fix. *(Proof captured in `evidence/phase-2-proofs/bug_r1_hotfix_retrieve_exact.json` and `bug_r1_hotfix_retrieve_episodic_only.json`; regression: `env -u SERVICE_TOKEN mix test` → 72 tests, 0 failures.)*
- **B9 (Zombie Runs on Cancel):** I could **not** reproduce this error on the current local build for the HITL cancellation flow. An inline `human_review` run transitioned to `awaiting_input`; subsequently, `POST /api/runs/:id/cancel` returned `200` and the status transitioned to `cancelled` within just a few seconds, without getting stuck in `executing`.
  - *Run `44a5c724-1885-465b-9aa3-6de4df4bd90c`:* Executed via the Phase 2 script. The 185 seconds figure is the polling interval, not the transition time.
  - *Independent verification:* Run `24089b8e-f2bb-48d6-8b6e-0c743ce01141` transitioned to `cancelled` at time t+5s.
  - *Original baseline:* Run `7f9ec000` (perf-plan R-4) was cancelled while the run was still actively `executing`, which represents a different flow and has not been re-tested yet.

---

## 2. Memory-Server Issues (Still Open)

*Note: PR #2 focused on the engine, so these memory service issues remain open.*

### BUG-R1 (HIGH): `/v1/memory/retrieve` crashes with HTTP 500
- **Issue:** Calling this endpoint with a valid semantic hit returns an HTTP 500 error: `Protocol.UndefinedError: Jason.Encoder not implemented for MemoryServer.Schemas...`
- **Root Cause:** All three retrieve helpers (`retrieve_scoped`, `retrieve_episodic_scoped`, `retrieve_session` in `store.ex:320-376`) return raw Ecto structs. However, the controller (`memory_controller.ex:28`) attempts to serialize them directly using `json(conn, result)` without deriving the Jason encoder.
- **Impact:** This currently blocks remote-mode integration tests (PR-1/PR-3/TK-1) because `autoRetrieve` crashes whenever a fact is found.
- **Recommendation:** Derive `Jason.Encoder` on the three schemas, or map the structs to plain maps in the helpers (similar to how `list/1` handles it).
- **Local validation / Xác minh local:** Applying the local-only `@derive Jason.Encoder` hotfix to `SessionMemory`, `SemanticMemory`, and `EpisodicMemory` makes direct `POST /v1/memory/retrieve` pass for all three layers. Cross-scope deny-by-default still holds: `{SL-TEST-A,P2}` and `{SL-TEST-B}` return empty while exact `{SL-TEST-A,P1}` returns the seeded rows.

### SC-2 (HIGH): `GET /v1/memory` List-All Leak
- **Issue:** Calling `GET /v1/memory?scope_values={}` returns ALL tenant memory rows.
- **Root Cause:** The deny-by-default principle (ADR-005 C4) is not enforced on the list path (`store.ex:309`: `when map_size(scope_values) == 0, do: query`).
- **Recommendation:** Add a scope guard to this endpoint matching the behavior of the `clear` endpoint.

### MEM-CLEAR-KG (MED): Knowledge Graph not cleared
- **Issue:** `POST /v1/memory/clear` successfully purges the 3 memory layers, but leaves the Knowledge Graph (`kg_entities`/`kg_edges`) untouched.
- **Impact:** For HIPAA compliance (right-to-erasure), KG-resident facts surviving a clear operation is a risk.
- **Recommendation:** Implement a `kg/clear` scope-bound endpoint or document that a KG purge is a separate required operation.

---

## 3. Engine & Integration Issues

### B9 (HIGH): Cancelled runs become permanent zombies
- **Phase 2 result:** I could **not** reproduce this error on the current local build for the HITL cancellation flow. An inline `human_review` run transitioned to `awaiting_input`; subsequently, `POST /api/runs/:id/cancel` returned `200` and the status transitioned to `cancelled` within just a few seconds, without getting stuck in `executing`.
- *Run `44a5c724-1885-465b-9aa3-6de4df4bd90c`:* Executed via the Phase 2 script. The 185 seconds figure is the polling interval, not the transition time.
- *Independent verification:* Run `24089b8e-f2bb-48d6-8b6e-0c743ce01141` transitioned to `cancelled` at time t+5s.
- *Original baseline:* Run `7f9ec000` (perf-plan R-4) was cancelled while the run was still actively `executing`, which represents a different flow and has not been re-tested yet.

### BUG#2 (MED): `SSRF_ALLOW_PRIVATE` documented but not wired into runtime config

> BUG#2: SSRF_ALLOW_PRIVATE is documented but not wired into runtime config.
> Setting SSRF_ALLOW_PRIVATE=true does not currently affect Engine behavior unless runtime.exs maps it to `:engine, :ssrf_allow_private`.

- **Issue:** `UrlValidator` moduledoc and integration docs advertise `SSRF_ALLOW_PRIVATE=true` as the dev escape hatch. Upstream `runtime.exs` did not map that env var into application config.
- **Root Cause:** `validate/1` reads `Application.get_env(:engine, :ssrf_allow_private, false)` — not `System.get_env` directly. Without the `runtime.exs` wiring block, setting the env (including via `.env`) has no effect; loopback/private URLs stay blocked with `[SSRF] blocked` even when the flag is set. This is an **upstream wiring gap**, not a misconfiguration on our side — `SSRF_ALLOW_PRIVATE=true` is the documented, valid way to test local tool dispatch.
- **Our local unblock (test-only, not upstream):** We stashed a local `runtime.exs` patch that adds the missing env→config mapping so integration tests can exercise the documented path. That patch unblocks testing; it is not the cause of the bug.
- **Recommendation:** Commit the wiring block in upstream `runtime.exs` and add a regression test that drives the real `System.get_env` → `Application.get_env` path (not `Application.put_env` in unit tests alone).

---

## 4. Root Cause Evidence for PR #2 Fixes (For Reference)

*I noted that you fixed these in PR #2, but I wanted to share my root-cause traces in case they are helpful for your internal tests.*

### B0: `registry_url` hard-coded to `:3000` (Fixing B1/B2)
- **Trace:** I found that `Application.get_env(:engine, :registry_url, "http://localhost:3000")` had no environment override (unlike `control_plane_url`). This caused sub-agent assembly to fail with "Flow has no mindsets defined" because the snapshot request was refused.
- **Local Patch:** I applied `System.get_env("REGISTRY_URL")` locally, which successfully unblocked my spawn testing. Thank you for addressing this in PR #2.

### B6: Webhook mindset crash
- **Trace:** I traced the process crash in the webhook mindset to a swapped argument order in `lib/engine/agent_runner.ex:2542`. It was calling `resolve_flow_inputs(state, mindset_def)` instead of `resolve_flow_inputs(mindset_def["input"], state.mindset_outputs)`.

### T3-G1: Scope Forwarding vs. Enforcement (Design Gap)
- **Trace:** I observed that the Engine forwards the `context.scopeValues` to the tool dispatch perfectly, but it did not enforce `args ⊆ scopeValues`. This left the tool endpoint entirely responsible for RBAC filtering. I noted your fix in PR #2 using `bind_scope_args/3` to enforce this at the engine layer—I will re-run my cross-study dispatch tests (S-5) to confirm the leak path is blocked.

### B3/B4/B5: Observability & DX
- **B5 (Timer):** I observed that the overall run-timer (`300000ms`) was preempting the `input_timeout` recovery when a run was paused in `awaiting_input` or `awaiting_approval`.
- **B4 (Silent Degrade):** External tools returning `ECONNREFUSED` or `401` left the run marked as `completed` with empty output, masking infrastructure failures.

---
*Note: This report consolidates my daily findings. My local repository remains strictly AGPL reference-only; I use local forwarding to verify these paths without modifying the upstream source.*

---

## 5. Engineering Highlights & Strengths (The Good Stuff)

*While testing, I also cataloged the areas where StrangeLoop excels. The core Elixir/OTP state machine and integration contracts are incredibly robust. Here are the verified highlights:*

### Core Durability & Reliability
- **H1 (RunReaper):** A hard `kill -9` of the BEAM mid-run leaves zero zombies. The boot-time RunReaper correctly sweeps orphaned runs to `failed`.
- **H2 (Resume & Fork):** Time-travel semantics are clean. Durable resume correctly reuses the `run_id` from the checkpoint, and fork safely spins a new `run_id` without corrupting history.
- **H4 (Resource Watchdogs):** Budget and timeout guards fire accurately and persist a terminal `failed` status without emitting false `completed` signals.
- **H5 (Concurrency Isolation):** Zero cross-bleed. Parallel runs maintain strict isolation of state, `agentKey`, and `finalOutput`.
- **H6 (Observability):** Event traces are strictly monotonic with no gaps, and live SSE streaming delivers frames reliably in real-time.

### Integration, Security & Orchestration
- **H7 (End-to-End Tool Dispatch):** The integration boundary (Engine → HTTP tool → Live Clincove DB) works seamlessly end-to-end.
- **H8 (Secure-by-Default Boundaries):** SSRF protection blocks loopback by default, per-tool bearer auth correctly enforces `401`s without data leaks, and empty `scopeValues` strictly reject with `422`. The secure posture is built-in.
- **H13 (Memory Scope Isolation):** Plan 08 direct memory checks proved the data-plane scope predicate behaves correctly when the retrieve endpoint can serialize results: exact `{studyId:SL-TEST-A, patientId:P1}` returns the seeded rows, while sibling patient `{SL-TEST-A,P2}` and foreign study `{SL-TEST-B}` return empty. EN/VN: scope logic is strong; BUG-R1 is a serialization bug, not a scope-isolation bug.
- **H3 & H12 (Honest Degradation & Self-Correction):** When tool infrastructures fail entirely (e.g., `econnrefused`), the agent does NOT hallucinate; it surfaces the failure honestly. Furthermore, if the LLM breaks the `inputSchema`, the engine bounces the call and the model successfully self-corrects within a few round-trips.
- **H10 (Fail-Fast Validation):** The control plane catches malformed inputs (missing mindsets, missing agents) early and returns correct HTTP status codes (`404`/`422`) rather than crashing with an opaque 500.
- **H11 (Spawn Orchestration):** Complex spawn semantics—including Swarm DAG execution, dependency ordering, wait-then-return handoffs, and tool confinement—execute exactly as designed.

*Conclusion: The bugs reported in sections 2 and 3 reside mostly at the API/edge layer. The underlying state-machine, recovery mechanics, and security defaults are production-grade.*

---

## 6. Next Steps

- **Execute Test Plan 10 (Self-Improve Loop):** The core "Improve tab" functionality (Gym, Graders, Reflection, Export, and Promote) is currently 0% tested. This is a critical area with new PHI egress surfaces that bypass the memory-vault perimeter. My next focus will be executing `10-self-improve-loop-strategy.md` to verify cross-study export leaks, raw PHI in trajectories, LLM judge egress, and reflection prompt safety.
