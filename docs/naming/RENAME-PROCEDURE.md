# Rename procedure (prepared, not applied)

Preliminary research, not legal clearance, applies to the name itself; this page is only the engineering. Nothing here has been done. The product is still Onyx everywhere. It becomes something else only after the owner picks a name (DEC-01) and a logo direction (`docs/brand/`).

DEC-01 fixes the scope: the **product identity** changes; **internal identifiers stay**. Source file and symbol names (`onyx*`), setting ids (`onyx.*`), command ids (`onyx.*`), the `.onyx/` folder inside a repository and the `~/.onyx` folder keep their names. A user's settings and a repository's `.onyx/config.json` therefore keep working without migration.

Do it as one pull request, before the signed candidate is built (D2) and before the screenshots are captured (D6): both carry the name.

## Order

1. **Owner, outside the repository, before any code.** Registrar check and purchase of the domain; trademark search by counsel; create the GitHub organisation or decide the repository's new name. Until these are done the name is not chosen.
2. **product.json.** `node test/onyx/release/rename-product.mts --name <Name> --repository <owner>/<name>` prints the plan; add `--write` to apply it. It changes the name fields, the application and protocol names, the bundle identifier and the repository URLs, and keeps the data folder names. It was run only as a dry run.
3. **User-facing strings.** About 150 localized strings in `src/vs/workbench/contrib/onyx` and `src/vs/platform/onyxRuntime` contain the word (command titles such as "Onyx: Check for Updates", dialog text). Change the text, never the localization key or the command id. Prefer the product name from `IProductService.nameShort` where a string is built at run time, so that the next rename is one field.
4. **Theme extension** (`extensions/theme-onyx`): the display name, the four theme labels and the walkthrough text. The theme **ids** ("Onyx Dark", …) are stored in users' settings and in `workbenchThemeService.ts` defaults; either keep the ids and change only the labels (no migration), or change both and add a settings migration. Keeping the ids is the smaller, safer change. The extension's folder and publisher stay (`REBASE.md`).
5. **User data folder.** The data folder is named after `nameShort`: `~/Library/Application Support/Onyx` becomes `…/<Name>`. Choose one, and test it with `test/onyx/run-replace-check.mts` extended for the case:
   - migrate: on first launch, when the new folder does not exist and the old one does, copy it (never move it: a rollback needs the old one), and tell the user; or
   - do not migrate, and say so in the release notes with the one `cp -R` command. For an alpha with few users this is acceptable; it must be stated, not discovered.
   `darwinBundleIdentifier` changes too, so macOS treats the application as a new one: saved window state and any privacy permissions start fresh, and the "Onyx Safe Storage" keychain item is not read (stored endpoint API keys must be entered again).
6. **Icons.** Generate the `.icns` and the other sizes from the chosen direction (`docs/brand/README.md` lists every file and the commands).
7. **Documents.** README (with the line "formerly Onyx", which DEC-01 allows only once the rename is real), SECURITY.md, CONTRIBUTING.md, ROADMAP.md, `docs/*.md`, `docs/release/NOTES-TEMPLATE.md`, the issue templates, `CITATION.cff`. `docs/progress/` and `docs/research/results/` are records of what was done under the old name and are not rewritten.
8. **Checks and harnesses.** The URL allowlist in `test/onyx/run-hygiene.mts`; the application path in the workflows and in Section 11's commands (`../VSCode-darwin-arm64/<Name>.app`); `docs/UPDATING.md`'s paths.
9. **Rebuild and prove it.** Packaged build; `run-packaged-smoke.mts`, `run-extension-smoke.mts`, `run-replace-check.mts`; the module gate for all five modules; the image manifest re-captured (D6).
10. **Owner: rename the repository** (GitHub keeps redirects from the old name for web and git URLs, until a repository with the old name is created again). Then check: the old clone URL still fetches; the README's links; the update check, which reads the repository from `product.json`'s issue URL and so follows the rename with step 2; the release workflow.

## What a rename breaks if a step is skipped

| Skipped | Symptom |
|---|---|
| Step 2's repository URL | `Onyx: Check for Updates` asks the old repository; redirects cover it until the old name is reused |
| Step 4 with ids changed and no migration | Users' chosen theme silently falls back to the default |
| Step 5 | A user's settings, journals and profiles appear to be gone after the update. They are in the old folder |
| Step 8's allowlist | The hygiene check fails on the new URLs, which is the check working |

## Not decided here

The name, the logo, the domain, whether the GitHub organisation is new or the repository stays under the current account, and whether theme ids change. The first four are the owner's; the last is a recommendation above.
