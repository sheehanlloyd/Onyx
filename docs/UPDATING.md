# Updating, rolling back and uninstalling

Onyx does not update itself. There is no background updater and no update server; the build has no update address at all. You replace the application by hand, and this page is the whole procedure.

`Onyx: Check for Updates` (Command Palette) asks the project's public release list on GitHub whether a newer release exists, once, when you run it. It tells you one of three things: a newer release exists (with links to the disk image, its checksum and the notes), no newer release exists, or it could not find out. It downloads nothing and installs nothing.

## Where your data is

Replacing or deleting the application never touches any of this. It is all outside the application bundle.

| What | Where |
|---|---|
| Settings, keybindings, snippets, UI state | `~/Library/Application Support/Onyx/User/` |
| Run journals, terminal approval history, per-workspace state | `~/Library/Application Support/Onyx/User/workspaceStorage/<workspace id>/` (journals under `onyx/journal/`) |
| Capability profiles and datasheets measured on this machine, other global state | `~/Library/Application Support/Onyx/User/globalStorage/` |
| Logs, caches, crash reports | `~/Library/Application Support/Onyx/logs/`, `…/Cache*/`, `…/Crashpad/` |
| Installed extensions | `~/.onyx/extensions/` |
| Endpoint API keys, if you stored any | the macOS login keychain, under "Onyx Safe Storage" |
| Per-repository files | `.onyx/` inside each repository (`config.json`, playbooks, saved scorecards). These are yours and travel with the repository |
| Model weights | Not Onyx's. They belong to your runtime (for Ollama, `~/.ollama/models`) |

## Updating

1. Download the new disk image and its `.sha256` file from the release page.
2. Check the download. Both files in the same folder:
   ```bash
   shasum -a 256 -c Onyx-<version>-darwin-arm64.dmg.sha256
   ```
   It must print `OK`. If it does not, delete the download.
3. Quit Onyx (Cmd+Q). Accept or reject any proposals you care about first: a proposal that is still waiting is kept across a restart, but finishing the review before you swap the application is the safer habit.
4. Optional, and what makes rolling back possible: rename the current application instead of deleting it, for example `Onyx.app` to `Onyx-previous.app`, in `/Applications`.
5. Open the disk image and drag Onyx to Applications. If Finder asks, choose Replace.
6. Open Onyx. The first launch of a downloaded application shows macOS's standard confirmation, once. If macOS shows any other warning, stop: do not look for a way around it. The file is damaged or is not the release. Report it.

Your settings, journals, profiles and extensions are where they were.

## Rolling back

1. Quit Onyx.
2. Move the newer `Onyx.app` to the Trash and rename `Onyx-previous.app` back to `Onyx.app`, or drag the older release's application out of its disk image again.
3. Open Onyx.

The data folder is shared between versions and is not rolled back with the application. A newer version may have written state that an older one ignores or reads as missing. During the alpha, treat a rollback as "the older application on the current data", and keep a copy of the data folder if that worries you:

```bash
cp -R ~/Library/Application\ Support/Onyx ~/Onyx-data-backup
```

## Uninstalling

Moving `Onyx.app` to the Trash removes the application and nothing else. Everything in the table above stays on disk until you remove it. That is deliberate: deleting an application should not delete your work history.

To remove the data as well, quit Onyx and delete what you no longer want:

```bash
rm -rf ~/Library/Application\ Support/Onyx      # settings, journals, profiles, logs, caches
rm -rf ~/.onyx                                   # installed extensions
rm -rf ~/Library/Caches/com.onyx.editor ~/Library/Caches/com.onyx.editor.ShipIt
rm -f  ~/Library/Preferences/com.onyx.editor.plist
rm -rf ~/Library/Saved\ Application\ State/com.onyx.editor.savedState
```

If you stored an endpoint API key, remove "Onyx Safe Storage" in Keychain Access. The `.onyx/` folder inside a repository is part of that repository; delete it there if you want it gone. Onyx does not remove models from your runtime; `ollama rm <model>` does.

## What is tested

`node test/onyx/run-replace-check.mts --app <Onyx.app>` runs an agent task in the packaged application so that a journal and settings exist, deletes the application bundle, puts another copy in its place, starts it on the same data, and compares every settings and journal file byte for byte; then it does the same in the other direction (rollback), and finally carries out the uninstall list above against the test's own folders and checks what is left. It uses a throwaway data folder, not `~/Library/Application Support/Onyx`. The module gate runs it.
