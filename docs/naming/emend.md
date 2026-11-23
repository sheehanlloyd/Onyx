# Emend

Preliminary research, not legal clearance.

Date of all checks: 2026-11-22. Nothing was registered, reserved or purchased. Availability can change at any time.

**Verdict: DISQUALIFIED.** A same-name tool performs verified AI code edits, and a same-name Python CLI performs structured code edits. Both overlap with reviewed, verified edit proposals.

## The name

To correct a text by editing. Length: 5 letters. As a command and bundle name: `emend`.

## Web search for collisions

Tool: web search (US index). Queries and results:

- Query: `"Emend" software OR app OR AI editor OR developer tool "emend"`
  Result: Web search returned no product named Emend (nearest: Emenda, a software-analysis tools company, https://emenda.com/tools/). The GitHub and registry checks below found the collisions.

Web search alone missed several small projects during this research; the GitHub and registry lookups below are the stronger evidence.

Collisions found (all sources):

Direct: (1) diyanbogdanov/emend, "Verified AI dependency migrations ... fixes them, and proves the result still compiles and passes your tests": https://github.com/diyanbogdanov/emend (55 stars, npm package emend-cli); (2) PyPI "emend", "A Python refactoring CLI tool with structured edits and pattern transforms": https://github.com/lucaswiman/emend ; (3) anuopensci/emend, "Standarise data with an AI assistant"; (4) crates.io "emend" (created 2026-10-29); (5) App Store "Emend", a manuscript-structuring app (Productivity); (6) emend.dev and emend.app registered in March 2026.

## GitHub

`gh api users/<handle>` returns the account type when the handle is taken and 404 when it is unclaimed. Read-only.

```text
gh api users/emend => User created 2011-10-09 public_repos 3
gh api users/emend-editor => 404 Not Found
gh api users/emendeditor => 404 Not Found
gh api users/getemend => 404 Not Found
gh api users/emendhq => 404 Not Found
gh api users/emend-dev => Organization created 2024-02-25 public_repos 0
gh search repos emend --sort stars --limit 5 =>
  diyanbogdanov/emend | 55 stars | Verified AI dependency migrations. Finds which of your lines a version bump actually breaks, fixes them, and p
  Ridanisaurus/EmendatusEnigmatica | 38 stars | Minecraft Unification Mod
  jimmyleray/Emendare | 29 stars | Democratic platform to draft amendable texts
  emender/emender | 28 stars | A test automation framework for product documentation
  anuopensci/emend | 17 stars | Standarise data with an AI assistant
```

## Package registries

HTTP status of a read-only GET (200 means the name is taken, 404 means no package by that name). crates.io was queried with the User-Agent `name-research`.

```text
npm https://registry.npmjs.org/emend => 200
pypi https://pypi.org/pypi/emend/json => 200
crates https://crates.io/api/v1/crates/emend => 200
brew formula https://formulae.brew.sh/api/formula/emend.json => 404
brew cask https://formulae.brew.sh/api/cask/emend.json => 404
npm desc: A lightweight JS-based library to inline redact e-mail addresses to protect against against scraping. | latest 1.1.0 | modified 2025-05-01
pypi desc: A Python refactoring CLI tool with structured edits and pattern transforms | version 0.5.6
crates desc: Read-modify-write of Office Open XML spreadsheets: open an existing .xlsx, change what you were asked to change, and han | downloads 25
```

## App stores

iTunes Search API: `https://itunes.apple.com/search?term=emend&entity=macSoftware&limit=5` and the same with `entity=software`. The API returns fuzzy matches, so most rows are not same-name apps.

```text
itunes entity=macSoftware =>
  resultCount 5
  - Emendo Editor | Angelo Luis Rodrigues da Silva | Photo & Video
  - Vivi - Merge Videos | PLATINUM CITY LLC | Photo & Video
  - Total GIF Maker | 奇志 熊 | Photo & Video
  - Easy Collage | 军 龙 | Graphics & Design
  - Steel Cord Splice | Maven Software Inc. | Productivity
itunes entity=software =>
  resultCount 5
  - Emend (subtitle omitted) | Sunlit Game Studio LLC | Productivity
  - Screenshot Stitching -Long Pic | 娴 李 | Utilities
  - Benchmark Transitions | Emend Health Corporation | Lifestyle
  - Empower Recovery Center | Emend Health Corporation | Lifestyle
  - Restoration Recovery Center | Emend Health Corporation | Lifestyle
```

## Domains

Method: RDAP at the registry (Verisign for .com, Google Registry for .dev and .app, Identity Digital for .io and .sh) plus `dig +short NS <domain>`. HTTP 200 means registered; 404 means the registry has no record.

A 404 with no nameservers means the domain **appears unregistered**. It does not mean it is purchasable at standard price: premium pricing, reserved names and registrar holds are only visible at a registrar checkout, which was not started.

```text
emend.dev | https://pubapi.registry.google/rdap/domain/emend.dev => 200 registration=2026-03-09 expiration=2027-03-09 | dig NS: dns1.registrar-servers.com. dns2.registrar-servers.com.
emend.app | https://pubapi.registry.google/rdap/domain/emend.app => 200 registration=2026-03-29 expiration=2027-03-29 | dig NS: amir.ns.cloudflare.com. melinda.ns.cloudflare.com.
emend.sh | https://rdap.identitydigital.services/rdap/domain/emend.sh => 404  | dig NS: none
emend.io | https://rdap.identitydigital.services/rdap/domain/emend.io => 200 expiration=2028-12-03 registration=2021-12-03 | dig NS: coco.ns.cloudflare.com. dilbert.ns.cloudflare.com.
emend.com | https://rdap.verisign.com/com/v1/domain/emend.com => 200 registration=1997-12-08 expiration=2027-12-07 | dig NS: ns-252.awsdns-31.com. ns-690.awsdns-22.net.
emendeditor.com | https://rdap.verisign.com/com/v1/domain/emendeditor.com => 404  | dig NS: none
getemend.com | https://rdap.verisign.com/com/v1/domain/getemend.com => 200 registration=2026-10-04 expiration=2027-10-04 | dig NS: roan.ns.cloudflare.com. sandy.ns.cloudflare.com.
```

## Trademarks

Web search: "emend" trademark software class 9 OR class 42. Aggregator results show EMEND marks in Classes 35, 45, 32 and 5 (https://trademarks.justia.com/984/52/emend-98452421.html), an EMENDA mark in Class 42, and a cancelled EMENDO mark (https://markinton.com/trademark/emendo-79099393). No live EMEND software registration surfaced; aggregator data may be incomplete.

Direct register searches:

- USPTO Trademark Search (https://tmsearch.uspto.gov/): not checked: the page is a JavaScript application; a plain HTTP GET of the search URL returned the application shell with no result data.
- EUIPO eSearch plus (https://euipo.europa.eu/eSearch/): not checked: JavaScript application; a plain HTTP GET returned no response body.
- WIPO Global Brand Database (https://branddb.wipo.int/): not checked: JavaScript application; a plain HTTP GET returned a 1.7 kB shell with no result data.
- UK IPO trade mark search (https://www.gov.uk/search-for-trademark): not checked: the one UK IPO page requested during this research returned HTTP 403 with a CAPTCHA security check, which was not attempted.

These four searches (Nice Classes 9 and 42, exact and similar marks) must be run by the owner or counsel. Nothing here is a clearance.

## Verdict

**DISQUALIFIED.** A same-name tool performs verified AI code edits, and a same-name Python CLI performs structured code edits. Both overlap with reviewed, verified edit proposals.
