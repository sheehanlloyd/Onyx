# Cupel

Preliminary research, not legal clearance.

Date of all checks: 2026-11-22. Nothing was registered, reserved or purchased. Availability can change at any time.

**Verdict: DISQUALIFIED.** An active LLM benchmarking tool, a coding harness and an LLM context crate all use the exact name, and there is a UK Class 42 application for it.

## The name

The small porous cup used in fire assay to separate precious metal from base metal. Length: 5 letters. As a command and bundle name: `cupel`.

## Web search for collisions

Tool: web search (US index). Queries and results:

- Query: `"Cupel" software developer tool OR AI OR open source cupel`
  Result: Web search returned no product named Cupel (only near-misses such as CUPL/WinCUPL and CuPy). The GitHub and registry checks below found the collisions.

Web search alone missed several small projects during this research; the GitHub and registry lookups below are the stronger evidence.

Collisions found (all sources):

Direct: (1) tolitius/cupel, "discover LLMs punching above their weight", an LLM benchmarking tool with site https://cupel.run and the PyPI package "cupel" ("separates precious LLMs from base LLMs", version 0.1.96): https://github.com/tolitius/cupel (65 stars, pushed 2026-11-22); (2) rommeld/cupel, "Lean coding harness written in Rust, focused on fast local workflows": https://github.com/rommeld/cupel; (3) crates.io "cupel", "Context window management pipeline for LLM applications" (created 2026-03-15); (4) a UK trade mark application for "Cupel" in Class 42.

## GitHub

`gh api users/<handle>` returns the account type when the handle is taken and 404 when it is unclaimed. Read-only.

```text
gh api users/cupel => Organization created 2017-11-30 public_repos 0
gh api users/cupel-editor => 404 Not Found
gh api users/cupeleditor => 404 Not Found
gh api users/getcupel => 404 Not Found
gh api users/cupelhq => 404 Not Found
gh api users/cupel-dev => 404 Not Found
gh search repos cupel --sort stars --limit 5 =>
  tolitius/cupel | 65 stars | discover LLMs punching above their weight
  rommeld/cupel | 5 stars | Lean coding harness written in Rust, focused on fast local workflows, deterministic tooling, and efficient cod
  Globox1997/Cupellation | 3 stars | https://modrinth.com/mod/cupellation
  wistrand/cupella | 2 stars | A workspace for static analysis of Android APKs with a coding agent
  SamGalanakis/cupel | 1 stars |
```

## Package registries

HTTP status of a read-only GET (200 means the name is taken, 404 means no package by that name). crates.io was queried with the User-Agent `name-research`.

```text
npm https://registry.npmjs.org/cupel => 404
pypi https://pypi.org/pypi/cupel/json => 200
crates https://crates.io/api/v1/crates/cupel => 200
brew formula https://formulae.brew.sh/api/formula/cupel.json => 404
brew cask https://formulae.brew.sh/api/cask/cupel.json => 404
pypi desc: separates precious LLMs from base LLMs. works with any OpenAI/Anthropic compatible API | version 0.1.96
crates desc: Context window management pipeline for LLM applications | downloads 370
```

## App stores

iTunes Search API: `https://itunes.apple.com/search?term=cupel&entity=macSoftware&limit=5` and the same with `entity=software`. The API returns fuzzy matches, so most rows are not same-name apps.

```text
itunes entity=macSoftware =>
  resultCount 0
itunes entity=software =>
  resultCount 4
  - Bruegger's Bagels | Caribou Coffee Company, Inc. | Food & Drink
  - Noah's NY Bagels | Caribou Coffee Company, Inc. | Food & Drink
  - COFE | COFE DISTRICT APP HOLDING LTD | Lifestyle
  - PopUp Bagels | Lunchbox Technologies Inc. | Food & Drink
```

## Domains

Method: RDAP at the registry (Verisign for .com, Google Registry for .dev and .app, Identity Digital for .io and .sh) plus `dig +short NS <domain>`. HTTP 200 means registered; 404 means the registry has no record.

A 404 with no nameservers means the domain **appears unregistered**. It does not mean it is purchasable at standard price: premium pricing, reserved names and registrar holds are only visible at a registrar checkout, which was not started.

```text
cupel.dev | https://pubapi.registry.google/rdap/domain/cupel.dev => 200 registration=2026-03-07 expiration=2027-03-07 | dig NS: zelda.ns.cloudflare.com. gabriel.ns.cloudflare.com.
cupel.app | https://pubapi.registry.google/rdap/domain/cupel.app => 200 registration=2026-02-10 expiration=2027-02-10 | dig NS: dns1.registrar-servers.com. dns2.registrar-servers.com.
cupel.sh | https://rdap.identitydigital.services/rdap/domain/cupel.sh => 200 expiration=2027-08-14 registration=2026-08-14 | dig NS: nile.ns.cloudflare.com. desiree.ns.cloudflare.com.
cupel.io | https://rdap.identitydigital.services/rdap/domain/cupel.io => 200 expiration=2027-10-27 registration=2026-10-27 | dig NS: dns1.registrar-servers.com. dns2.registrar-servers.com.
cupel.com | https://rdap.verisign.com/com/v1/domain/cupel.com => 200 registration=2000-02-15 expiration=2028-02-15 | dig NS: nsg1.namebrightdns.com. nsg2.namebrightdns.com.
cupeleditor.com | https://rdap.verisign.com/com/v1/domain/cupeleditor.com => 404  | dig NS: none
getcupel.com | https://rdap.verisign.com/com/v1/domain/getcupel.com => 200 registration=2026-11-17 expiration=2027-11-17 | dig NS: dns1.registrar-servers.com. dns2.registrar-servers.com.
```

## Trademarks

Web search: "cupel" trademark software class 9 OR class 42 USPTO. Result: a UK application UK00004352899 for the word mark "Cupel" in Class 42 (software development services), published in Trade Mark Journal 2026/013 (27 March 2026): https://www.ipo.gov.uk/t-tmj/tm-journals/2026-013/UK00004352899.html . not checked: the journal page itself returned HTTP 403 with a CAPTCHA security check, so applicant and status were not read; the summary comes from the search result only.

Direct register searches:

- USPTO Trademark Search (https://tmsearch.uspto.gov/): not checked: the page is a JavaScript application; a plain HTTP GET of the search URL returned the application shell with no result data.
- EUIPO eSearch plus (https://euipo.europa.eu/eSearch/): not checked: JavaScript application; a plain HTTP GET returned no response body.
- WIPO Global Brand Database (https://branddb.wipo.int/): not checked: JavaScript application; a plain HTTP GET returned a 1.7 kB shell with no result data.
- UK IPO trade mark search (https://www.gov.uk/search-for-trademark): not checked: the one UK IPO page requested during this research returned HTTP 403 with a CAPTCHA security check, which was not attempted.

These four searches (Nice Classes 9 and 42, exact and similar marks) must be run by the owner or counsel. Nothing here is a clearance.

## Verdict

**DISQUALIFIED.** An active LLM benchmarking tool, a coding harness and an LLM context crate all use the exact name, and there is a UK Class 42 application for it.
