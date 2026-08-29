---
name: upstream-merge
description: Merge microsoft/vscode upstream into Onyx safely
when-to-use: When the user asks to merge, rebase or sync with upstream VS Code
tools: terminal, editFile, docs
---

1. Read REBASE.md first — it lists every upstream file Onyx touches and how each conflict resolves.
2. Run `git fetch upstream` and inspect `git log --oneline main..upstream/main | head -30` to see what is coming.
3. Expect exactly one conflict, in product.json: upstream re-adds `trustedExtensionAuthAccess`, Onyx removes it. Take the Onyx side of that hunk and keep upstream's structure everywhere else.
4. After merging, re-check every file in REBASE.md's table still carries its Onyx edit; re-apply any the merge dropped.
5. Verify with: `npm run typecheck-client`, `npm run valid-layers-check`, and the Onyx unit tests.
6. Update REBASE.md's merge-drill section with the date, the upstream commit tested, and what conflicted.
