# Stetit

Preliminary research, not legal clearance.

Date of all checks: 2026-11-22. Nothing was registered, reserved or purchased. Availability can change at any time.

**Verdict: SURVIVES.** No same-name product found and every identifier except the .com was unclaimed on the date. It survives on the exact name only.

## The name

Latin "it stood", from the same verb as the proofreading mark "stet" (let it stand). Also reads as "stet it". Length: 6 letters. As a command and bundle name: `stetit`.

## Web search for collisions

Tool: web search (US index). Queries and results:

- Query: `"Stetit" software OR app OR AI OR company OR trademark`
  Result: Nothing named Stetit was returned. Nearest names were unrelated marks (STEMIT, STITA, SETRAIT).

Web search alone missed several small projects during this research; the GitHub and registry lookups below are the stronger evidence.

Collisions found (all sources):

None found by exact name. The root "Stet" is crowded in exactly this field (see stet.md): STET review gate for AI coding agents (https://stet.fyi/), Stet-AI/stet-cli which evaluates coding agents on the user's own repository (https://github.com/Stet-AI/stet-cli, https://www.stet.sh), and two AI-assisted writing editors named Stet.

## GitHub

`gh api users/<handle>` returns the account type when the handle is taken and 404 when it is unclaimed. Read-only.

```text
gh api users/stetit => 404 Not Found
gh api users/stetit-editor => 404 Not Found
gh api users/stetiteditor => 404 Not Found
gh api users/getstetit => 404 Not Found
gh api users/stetithq => 404 Not Found
gh api users/stetit-dev => 404 Not Found
gh search repos stetit --sort stars --limit 5 =>
  occasi444/Stetit | 0 stars |
  zlatal/STETITTEST | 0 stars |
  stetithbpyxbq/stetithbpyxbq.github.io | 0 stars | (description omitted)
```

## Package registries

HTTP status of a read-only GET (200 means the name is taken, 404 means no package by that name). crates.io was queried with the User-Agent `name-research`.

```text
npm https://registry.npmjs.org/stetit => 404
pypi https://pypi.org/pypi/stetit/json => 404
crates https://crates.io/api/v1/crates/stetit => 404
brew formula https://formulae.brew.sh/api/formula/stetit.json => 404
brew cask https://formulae.brew.sh/api/cask/stetit.json => 404
```

## App stores

iTunes Search API: `https://itunes.apple.com/search?term=stetit&entity=macSoftware&limit=5` and the same with `entity=software`. The API returns fuzzy matches, so most rows are not same-name apps.

```text
itunes entity=macSoftware =>
  resultCount 0
itunes entity=software =>
  resultCount 2
  - Knauf Shqip | Urim Murati | Utilities
  - DATAVET | EVET ARASTIRMA GELISTIRME MUHENDISLIK YAZILIM SISTEMLERI MED DANISMANLIK VET LTD STI | Medical
```

## Domains

Method: RDAP at the registry (Verisign for .com, Google Registry for .dev and .app, Identity Digital for .io and .sh) plus `dig +short NS <domain>`. HTTP 200 means registered; 404 means the registry has no record.

A 404 with no nameservers means the domain **appears unregistered**. It does not mean it is purchasable at standard price: premium pricing, reserved names and registrar holds are only visible at a registrar checkout, which was not started.

```text
stetit.dev | https://pubapi.registry.google/rdap/domain/stetit.dev => 404  | dig NS: none
stetit.app | https://pubapi.registry.google/rdap/domain/stetit.app => 404  | dig NS: none
stetit.sh | https://rdap.identitydigital.services/rdap/domain/stetit.sh => 404  | dig NS: none
stetit.io | https://rdap.identitydigital.services/rdap/domain/stetit.io => 404  | dig NS: none
stetit.com | https://rdap.verisign.com/com/v1/domain/stetit.com => 200 registration=2015-05-15 expiration=2027-05-15 | dig NS: dns1.registrar-servers.com. dns2.registrar-servers.com.
stetiteditor.com | https://rdap.verisign.com/com/v1/domain/stetiteditor.com => 404  | dig NS: none
getstetit.com | https://rdap.verisign.com/com/v1/domain/getstetit.com => 404  | dig NS: none
```

## Trademarks

The same web search served as the trademark search. No "Stetit" record surfaced.

Direct register searches:

- USPTO Trademark Search (https://tmsearch.uspto.gov/): not checked: the page is a JavaScript application; a plain HTTP GET of the search URL returned the application shell with no result data.
- EUIPO eSearch plus (https://euipo.europa.eu/eSearch/): not checked: JavaScript application; a plain HTTP GET returned no response body.
- WIPO Global Brand Database (https://branddb.wipo.int/): not checked: JavaScript application; a plain HTTP GET returned a 1.7 kB shell with no result data.
- UK IPO trade mark search (https://www.gov.uk/search-for-trademark): not checked: the one UK IPO page requested during this research returned HTTP 403 with a CAPTCHA security check, which was not attempted.

These four searches (Nice Classes 9 and 42, exact and similar marks) must be run by the owner or counsel. Nothing here is a clearance.

## Verdict

**SURVIVES.** No same-name product found and every identifier except the .com was unclaimed on the date. It survives on the exact name only.

Remaining risks:

- Derived from "Stet", which is used by at least two AI coding-agent products, one of them an agent evaluation tool on the user's own repository. Confusion and a likelihood-of-confusion objection are both plausible. This is a serious risk and the reason it ranks last.
- stetit.com is registered (2015-05-15).
- Pronunciation is ambiguous ("STET-it" or "steh-TEET").
- Trademark registers were not queried directly.
