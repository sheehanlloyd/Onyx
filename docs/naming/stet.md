# Stet

Preliminary research, not legal clearance.

Date of all checks: 2026-11-22. Nothing was registered, reserved or purchased. Availability can change at any time.

**Verdict: DISQUALIFIED.** Two live AI coding-agent products already use the name, one for human review of agent output and one for evaluating coding agents on the user's own repository. That is this product's exact territory.

## The name

Proofreading mark: "let it stand". A strong fit for reviewed edits, which is why others got there already. Length: 4 letters. As a command and bundle name: `stet`.

## Web search for collisions

Tool: web search (US index). Queries and results:

- Query: `"Stet" software developer tool OR editor OR AI stet.dev OR stet.app OR "stet.sh"`
  Result: STET, described on its listing as a human-in-the-loop review gate for AI coding agents: https://huntscreens.com/products/stet-b64 (site https://stet.fyi/). An open-source AI document editor: https://github.com/filu123/stet. Historical: IBM STET text editor (1977) https://en.wikipedia.org/wiki/STET_(text_editor) and Stet comment software https://en.wikipedia.org/wiki/Stet_(software).

Web search alone missed several small projects during this research; the GitHub and registry lookups below are the stronger evidence.

Collisions found (all sources):

Direct, in the same niche: (1) STET review gate for AI coding agents, https://stet.fyi/; (2) Stet-AI/stet-cli, "Evaluate coding agents (Claude Code, Codex, Cursor) on your own repo's merged PRs", https://github.com/Stet-AI/stet-cli and https://www.stet.sh (created 2026-04-11, pushed 2026-10-21); (3) filu123/stet, AI document editor, https://github.com/filu123/stet; (4) cgrunewald/stet, markdown writer with an agent control channel, https://github.com/cgrunewald/stet; (5) crates.io "stet", a PostScript interpreter with 230875 downloads; (6) App Store "Stet Writer" listed under Developer Tools.

## GitHub

`gh api users/<handle>` returns the account type when the handle is taken and 404 when it is unclaimed. Read-only.

```text
gh api users/stet => User created 2021-02-04 public_repos 65
gh api users/stet-editor => 404 Not Found
gh api users/steteditor => 404 Not Found
gh api users/getstet => Organization created 2026-08-30 public_repos 2
gh api users/stethq => Organization created 2026-07-28 public_repos 2
gh api users/stet-dev => 404 Not Found
gh search repos stet --sort stars --limit 5 =>
  meta/stetho | 12636 stars | Stetho is a debug bridge for Android applications, enabling the powerful Chrome Developer Tools and much more.
  Netflix-Skunkworks/stethoscope | 2003 stars | Personalized, user-focused recommendations for employee information security.
  GliaX/Stethoscope | 1023 stars | A research-validated stethoscope whose plans are available Freely and openly. The cost of the entire stethosco
  uPhyca/stetho-realm | 728 stars | Realm module for Stetho
  Netflix-Skunkworks/stethoscope-app | 463 stars | A desktop application that checks security-related settings and makes recommendations for improvements without
```

## Package registries

HTTP status of a read-only GET (200 means the name is taken, 404 means no package by that name). crates.io was queried with the User-Agent `name-research`.

```text
npm https://registry.npmjs.org/stet => 404
pypi https://pypi.org/pypi/stet/json => 200
crates https://crates.io/api/v1/crates/stet => 200
brew formula https://formulae.brew.sh/api/formula/stet.json => 404
brew cask https://formulae.brew.sh/api/cask/stet.json => 404
pypi desc: Persistent memoization by parameter identity for experiment scripts | version 0.0.2
crates desc: Pure-Rust PostScript Level 3 interpreter — renders PostScript and EPS to raster images or PDF, with no C dependencies | downloads 230875
```

## App stores

iTunes Search API: `https://itunes.apple.com/search?term=stet&entity=macSoftware&limit=5` and the same with `entity=software`. The API returns fuzzy matches, so most rows are not same-name apps.

```text
itunes entity=macSoftware =>
  resultCount 0
itunes entity=software =>
  resultCount 5
  - Stet: Document & Photo Proof | Solana Beach Labs, LLC | Productivity
  - StetSAFE | KuartisMed Ltd Sti | Medical
  - STETSOM STX DSP | Stetsom Industria Eletronica Ltda | Music
  - Stet Mark | Roger Samuel | Productivity
  - OneState RP: Role Play Online | CHILLBASE LTD | Games
```

## Domains

Method: RDAP at the registry (Verisign for .com, Google Registry for .dev and .app, Identity Digital for .io and .sh) plus `dig +short NS <domain>`. HTTP 200 means registered; 404 means the registry has no record.

A 404 with no nameservers means the domain **appears unregistered**. It does not mean it is purchasable at standard price: premium pricing, reserved names and registrar holds are only visible at a registrar checkout, which was not started.

```text
stet.dev | https://pubapi.registry.google/rdap/domain/stet.dev => 200 registration=2024-03-14 expiration=2027-03-14 | dig NS: dns1.registrar-servers.com. dns2.registrar-servers.com.
stet.app | https://pubapi.registry.google/rdap/domain/stet.app => 200 registration=2026-10-26 expiration=2027-10-26 | dig NS: ns1.afternic.com. ns2.afternic.com.
stet.sh | https://rdap.identitydigital.services/rdap/domain/stet.sh => 200 expiration=2027-03-08 registration=2026-03-08 | dig NS: ns1.vercel-dns.com. ns2.vercel-dns.com.
stet.io | https://rdap.identitydigital.services/rdap/domain/stet.io => 200 expiration=2029-01-11 registration=2015-01-11 | dig NS: kyrie.ns.cloudflare.com. leanna.ns.cloudflare.com.
stet.com | https://rdap.verisign.com/com/v1/domain/stet.com => 200  | dig NS: ns61.worldnic.com. ns62.worldnic.com.
steteditor.com | https://rdap.verisign.com/com/v1/domain/steteditor.com => 404  | dig NS: none
getstet.com | https://rdap.verisign.com/com/v1/domain/getstet.com => 200 registration=2024-06-19 expiration=2028-06-19 | dig NS: ns10.wixdns.net. ns11.wixdns.net.
```

## Trademarks

not checked: the name is already disqualified by direct collisions, so a trademark search would not change the verdict.

Direct register searches:

- USPTO Trademark Search (https://tmsearch.uspto.gov/): not checked: the page is a JavaScript application; a plain HTTP GET of the search URL returned the application shell with no result data.
- EUIPO eSearch plus (https://euipo.europa.eu/eSearch/): not checked: JavaScript application; a plain HTTP GET returned no response body.
- WIPO Global Brand Database (https://branddb.wipo.int/): not checked: JavaScript application; a plain HTTP GET returned a 1.7 kB shell with no result data.
- UK IPO trade mark search (https://www.gov.uk/search-for-trademark): not checked: the one UK IPO page requested during this research returned HTTP 403 with a CAPTCHA security check, which was not attempted.

These four searches (Nice Classes 9 and 42, exact and similar marks) must be run by the owner or counsel. Nothing here is a clearance.

## Verdict

**DISQUALIFIED.** Two live AI coding-agent products already use the name, one for human review of agent output and one for evaluating coding agents on the user's own repository. That is this product's exact territory.
