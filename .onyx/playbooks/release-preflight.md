---
name: release-preflight
description: Run the full Onyx pre-release verification
when-to-use: Before building a DMG or calling a milestone done
tools: terminal, docs
---

1. Gates, in order: `npm run typecheck-client`, `npm run valid-layers-check`, `npx eslint src/vs/platform/onyxRuntime src/vs/workbench/contrib/onyx test/onyx`, `npm run stylelint`, `./scripts/test.sh --grep Onyx`.
2. Run the end-to-end suite against the mock runtimes: `node test/onyx/run-e2e.mts` — all 45 checks must pass. It refuses to start if a real runtime holds :11434 or :1234 (LM Studio) — stop those first, or set `ONYX_MOCK_PORT` / `ONYX_MOCK_LMSTUDIO_PORT`.
3. Walk LAUNCH.md's pre-flight checklist item by item; do not skip the fresh-profile checks (onboarding starts on "Connect a Local Runtime", no other vendor's assistant anywhere).
4. Check all four themes — Onyx Dark, Onyx Light, and both High Contrast variants — on the control plane, chat, inline edit and the empty states.
5. Confirm REBASE.md still lists every touched upstream file, and ONYX.md's status checklist matches reality.
