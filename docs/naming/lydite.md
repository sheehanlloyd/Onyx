# Lydite

Preliminary research, not legal clearance.

Date of all checks: 2026-11-22. Nothing was registered, reserved or purchased. Availability can change at any time.

**Verdict: DISQUALIFIED.** A same-name tool already runs coding agents behind a sandbox with verification receipts, and a same-name code-quality CLI holds the GitHub organization. Both are active in November 2026.

## The name

Lydian stone, the black touchstone used to test gold. Length: 6 letters. As a command and bundle name: `lydite`.

## Web search for collisions

Tool: web search (US index). Queries and results:

- Query: `"Lydite" software OR app OR AI OR startup OR developer tool`
  Result: Web search returned nothing named Lydite. The GitHub checks below found the collisions.

Web search alone missed several small projects during this research; the GitHub and registry lookups below are the stronger evidence.

Collisions found (all sources):

Direct: (1) aoricloud/lydite, "Runs coding agents on your repo with their commands behind a sandbox wall, replays your proof command itself, and opens a pull request only for what passed, with a receipt": https://github.com/aoricloud/lydite (pushed 2026-11-22); (2) the GitHub organization "lydite" (created 2026-08-29, 3 public repos) with lydite/lydite, "Unified code-quality and security scanning for Rust, TypeScript, and Go", site https://lydite.org ; (3) lydite.dev registered 2026-10-04.

## GitHub

`gh api users/<handle>` returns the account type when the handle is taken and 404 when it is unclaimed. Read-only.

```text
gh api users/lydite => Organization created 2026-08-29 public_repos 3
gh api users/lydite-editor => 404 Not Found
gh api users/lyditeeditor => 404 Not Found
gh api users/getlydite => 404 Not Found
gh api users/lyditehq => 404 Not Found
gh api users/lydite-dev => 404 Not Found
gh search repos lydite --sort stars --limit 5 =>
  aoricloud/lydite | 3 stars | Runs coding agents on your repo with their commands behind a sandbox wall, replays your proof command itself,
  Lydi-vine/LyditeShop | 1 stars |
  aoricloud/mycelium-lab | 1 stars | A mycelium growth simulator in Rust, written by AI agents under Lydite. Runs in your browser.
  aoricloud/givre-lab | 1 stars | A crystal growth simulator in Rust (DLA, snow crystals, dielectric breakdown), written by AI agents under Lydi
  lydite/lydite | 0 stars | Unified code-quality and security scanning for Rust, TypeScript, and Go — one CLI, run identically locally and
```

## Package registries

HTTP status of a read-only GET (200 means the name is taken, 404 means no package by that name). crates.io was queried with the User-Agent `name-research`.

```text
npm https://registry.npmjs.org/lydite => 404
pypi https://pypi.org/pypi/lydite/json => 404
crates https://crates.io/api/v1/crates/lydite => 404
brew formula https://formulae.brew.sh/api/formula/lydite.json => 404
brew cask https://formulae.brew.sh/api/cask/lydite.json => 404
```

## App stores

iTunes Search API: `https://itunes.apple.com/search?term=lydite&entity=macSoftware&limit=5` and the same with `entity=software`. The API returns fuzzy matches, so most rows are not same-name apps.

```text
itunes entity=macSoftware =>
  resultCount 0
itunes entity=software =>
  resultCount 4
  - Crystals Wholesale (USA) | Clearsight Technologies Private Limited | Shopping
  - Rock Identifier: Gemstone ID | GREAT ESCAPER LIMITED | Utilities
  - Geode: Mineral Identifier | Benjamin Repingon | Reference
  - Rock & Stone Identifier - AI | Asha Avaiya | Education
```

## Domains

Method: RDAP at the registry (Verisign for .com, Google Registry for .dev and .app, Identity Digital for .io and .sh) plus `dig +short NS <domain>`. HTTP 200 means registered; 404 means the registry has no record.

A 404 with no nameservers means the domain **appears unregistered**. It does not mean it is purchasable at standard price: premium pricing, reserved names and registrar holds are only visible at a registrar checkout, which was not started.

```text
lydite.dev | https://pubapi.registry.google/rdap/domain/lydite.dev => 200 registration=2026-10-04 expiration=2027-10-04 | dig NS: piers.ns.cloudflare.com. carioca.ns.cloudflare.com.
lydite.app | https://pubapi.registry.google/rdap/domain/lydite.app => 404  | dig NS: none
lydite.sh | https://rdap.identitydigital.services/rdap/domain/lydite.sh => 404  | dig NS: none
lydite.io | https://rdap.identitydigital.services/rdap/domain/lydite.io => 404  | dig NS: none
lydite.com | https://rdap.verisign.com/com/v1/domain/lydite.com => 200 registration=2013-05-04 expiration=2027-05-04 | dig NS: ns1.dns.com.cn. ns2.dns.com.cn.
lyditeeditor.com | https://rdap.verisign.com/com/v1/domain/lyditeeditor.com => 404  | dig NS: none
getlydite.com | https://rdap.verisign.com/com/v1/domain/getlydite.com => 404  | dig NS: none
```

## Trademarks

Web search: "lydite" trademark software OR "lydstone" trademark OR "stetly" trademark. No "Lydite" record surfaced.

Direct register searches:

- USPTO Trademark Search (https://tmsearch.uspto.gov/): not checked: the page is a JavaScript application; a plain HTTP GET of the search URL returned the application shell with no result data.
- EUIPO eSearch plus (https://euipo.europa.eu/eSearch/): not checked: JavaScript application; a plain HTTP GET returned no response body.
- WIPO Global Brand Database (https://branddb.wipo.int/): not checked: JavaScript application; a plain HTTP GET returned a 1.7 kB shell with no result data.
- UK IPO trade mark search (https://www.gov.uk/search-for-trademark): not checked: the one UK IPO page requested during this research returned HTTP 403 with a CAPTCHA security check, which was not attempted.

These four searches (Nice Classes 9 and 42, exact and similar marks) must be run by the owner or counsel. Nothing here is a clearance.

## Verdict

**DISQUALIFIED.** A same-name tool already runs coding agents behind a sandbox with verification receipts, and a same-name code-quality CLI holds the GitHub organization. Both are active in November 2026.
