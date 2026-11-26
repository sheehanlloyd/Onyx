# Lydstone

Preliminary research, not legal clearance.

Date of all checks: 2026-11-22. Nothing was registered, reserved or purchased. Availability can change at any time.

**Verdict: SURVIVES.** No same-name product found; GitHub handle and all registries unclaimed; four of five primary domains appear unregistered.

## The name

Coined from "Lydian stone", the old name for the touchstone: a black stone used to test gold by the streak it leaves. It keeps the dark-stone lineage of the current name and adds the testing idea. Length: 8 letters. As a command and bundle name: `lydstone`.

## Web search for collisions

Tool: web search (US index). Queries and results:

- Query: `"Stetly" OR "Lydstone" software OR app OR AI OR company`
  Result: Nothing named Lydstone was returned.
- Query: `"Lydstone" company OR brand OR app OR game`
  Result: Nothing named Lydstone was returned (nearest names: Lysto, Lydian, Lyden; unrelated).

Web search alone missed several small projects during this research; the GitHub and registry lookups below are the stronger evidence.

Collisions found (all sources):

None found by exact name. Neighbour in the same field: "Lydite" (see lydite.md), a tool that runs coding agents behind a sandbox, with a GitHub organization and lydite.dev registered in 2026. The two names share the root "Lyd-" and the touchstone meaning.

## GitHub

`gh api users/<handle>` returns the account type when the handle is taken and 404 when it is unclaimed. Read-only.

```text
gh api users/lydstone => 404 Not Found
gh api users/lydstone-editor => 404 Not Found
gh api users/lydstoneeditor => 404 Not Found
gh api users/getlydstone => 404 Not Found
gh api users/lydstonehq => 404 Not Found
gh api users/lydstone-dev => 404 Not Found
gh search repos lydstone --sort stars --limit 5 =>
```

## Package registries

HTTP status of a read-only GET (200 means the name is taken, 404 means no package by that name). crates.io was queried with the User-Agent `name-research`.

```text
npm https://registry.npmjs.org/lydstone => 404
pypi https://pypi.org/pypi/lydstone/json => 404
crates https://crates.io/api/v1/crates/lydstone => 404
brew formula https://formulae.brew.sh/api/formula/lydstone.json => 404
brew cask https://formulae.brew.sh/api/cask/lydstone.json => 404
```

## App stores

iTunes Search API: `https://itunes.apple.com/search?term=lydstone&entity=macSoftware&limit=5` and the same with `entity=software`. The API returns fuzzy matches, so most rows are not same-name apps.

```text
itunes entity=macSoftware =>
  resultCount 0
itunes entity=software =>
  resultCount 5
  - BCS Best Cheer Stone | Li Tan | Utilities
  - KP Sanghvi | K. P. SANGHVI & SONS | Business
  - Rock Identifier: Gemstone ID | GREAT ESCAPER LIMITED | Utilities
  - Crystals Wholesale (USA) | Clearsight Technologies Private Limited | Shopping
  - EarthWorks, Inc. | Creative Edge, Inc. | Business
```

## Domains

Method: RDAP at the registry (Verisign for .com, Google Registry for .dev and .app, Identity Digital for .io and .sh) plus `dig +short NS <domain>`. HTTP 200 means registered; 404 means the registry has no record.

A 404 with no nameservers means the domain **appears unregistered**. It does not mean it is purchasable at standard price: premium pricing, reserved names and registrar holds are only visible at a registrar checkout, which was not started.

```text
lydstone.dev | https://pubapi.registry.google/rdap/domain/lydstone.dev => 404  | dig NS: none
lydstone.app | https://pubapi.registry.google/rdap/domain/lydstone.app => 404  | dig NS: none
lydstone.sh | https://rdap.identitydigital.services/rdap/domain/lydstone.sh => 404  | dig NS: none
lydstone.io | https://rdap.identitydigital.services/rdap/domain/lydstone.io => 404  | dig NS: none
lydstone.com | https://rdap.verisign.com/com/v1/domain/lydstone.com => 200 registration=2024-04-28 expiration=2027-04-28 | dig NS: ns41.domaincontrol.com. ns42.domaincontrol.com.
lydstoneeditor.com | https://rdap.verisign.com/com/v1/domain/lydstoneeditor.com => 404  | dig NS: none
getlydstone.com | https://rdap.verisign.com/com/v1/domain/getlydstone.com => 404  | dig NS: none
```

## Trademarks

Web search: "lydite" trademark software OR "lydstone" trademark OR "stetly" trademark. No record for "Lydstone" surfaced; results were unrelated building-material marks (LITESTONE, DYSTONE and similar).

Direct register searches:

- USPTO Trademark Search (https://tmsearch.uspto.gov/): not checked: the page is a JavaScript application; a plain HTTP GET of the search URL returned the application shell with no result data.
- EUIPO eSearch plus (https://euipo.europa.eu/eSearch/): not checked: JavaScript application; a plain HTTP GET returned no response body.
- WIPO Global Brand Database (https://branddb.wipo.int/): not checked: JavaScript application; a plain HTTP GET returned a 1.7 kB shell with no result data.
- UK IPO trade mark search (https://www.gov.uk/search-for-trademark): not checked: the one UK IPO page requested during this research returned HTTP 403 with a CAPTCHA security check, which was not attempted.

These four searches (Nice Classes 9 and 42, exact and similar marks) must be run by the owner or counsel. Nothing here is a clearance.

## Verdict

**SURVIVES.** No same-name product found; GitHub handle and all registries unclaimed; four of five primary domains appear unregistered.

Remaining risks:

- Neighbour "Lydite" is an AI coding-agent tool with the same etymology. A reader could link the two. This is the main risk.
- lydstone.com is registered (2024-04-28, nameservers at domaincontrol.com); the holder and use are unknown.
- Eight letters (two syllables). Needs a one-line explanation of the meaning.
- Trademark registers were not queried directly.
- Domains "appear unregistered" by RDAP and DNS only; price is unknown.
