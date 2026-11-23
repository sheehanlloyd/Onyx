# Probatum

Preliminary research, not legal clearance.

Date of all checks: 2026-11-22. Nothing was registered, reserved or purchased. Availability can change at any time.

**Verdict: DISQUALIFIED.** A same-name developer tool about verified program generation was published in 2026, and the npm name plus most domains were claimed the same year. The projects are small, so this is a judgment call, but the name is visibly being built on.

## The name

Latin "proved, tested" (as in "probatum est"). Length: 8 letters. As a command and bundle name: `probatum`.

## Web search for collisions

Tool: web search (US index). Queries and results:

- Query: `"Probatum" software OR app OR AI OR developer tool OR trademark`
  Result: Web search returned nothing named Probatum (nearest: Probate Plus, Probatix). The GitHub and registry checks below found the collisions. The same search served as the trademark web search; no record surfaced.

Web search alone missed several small projects during this research; the GitHub and registry lookups below are the stronger evidence.

Collisions found (all sources):

(1) crates.io "probatum", "Write the contract, get the proof: compile behavioral intent into programs with machine-checkable proof certificates" (created 2026-10-14, repository https://github.com/HyperonX-Team/probatum); (2) npm "probatum" claimed 2026-07-03 (placeholder version 0.0.0-probe.0); (3) balbboa/probatum-dist, "Probatum release binaries"; (4) atOCEANO/probatum, a simulated exchange for backtests; (5) probatum.dev, .app, .io and getprobatum.com were all registered in 2026.

## GitHub

`gh api users/<handle>` returns the account type when the handle is taken and 404 when it is unclaimed. Read-only.

```text
gh api users/probatum => 404 Not Found
gh api users/probatum-editor => 404 Not Found
gh api users/probatumeditor => 404 Not Found
gh api users/getprobatum => 404 Not Found
gh api users/probatumhq => 404 Not Found
gh api users/probatum-dev => 404 Not Found
gh search repos probatum --sort stars --limit 5 =>
  atOCEANO/probatum | 1 stars | One simulated crypto exchange for backtests, parameter searches and reinforcement learning, stepped bar by bar
  Rozolini/probatum | 0 stars |
  balbboa/probatum-dist | 0 stars | Probatum release binaries
  lucasrufino07/probatum | 0 stars |
  HyperonX-Team/probatum | 0 stars |
```

## Package registries

HTTP status of a read-only GET (200 means the name is taken, 404 means no package by that name). crates.io was queried with the User-Agent `name-research`.

```text
npm https://registry.npmjs.org/probatum => 200
pypi https://pypi.org/pypi/probatum/json => 404
crates https://crates.io/api/v1/crates/probatum => 200
brew formula https://formulae.brew.sh/api/formula/probatum.json => 404
brew cask https://formulae.brew.sh/api/cask/probatum.json => 404
npm desc:  | latest None | modified 2026-07-03
crates desc: Write the contract, get the proof: compile behavioral intent into programs with machine-checkable proof certificates | downloads 12
```

## App stores

iTunes Search API: `https://itunes.apple.com/search?term=probatum&entity=macSoftware&limit=5` and the same with `entity=software`. The API returns fuzzy matches, so most rows are not same-name apps.

```text
itunes entity=macSoftware =>
  resultCount 0
itunes entity=software =>
  resultCount 0
```

## Domains

Method: RDAP at the registry (Verisign for .com, Google Registry for .dev and .app, Identity Digital for .io and .sh) plus `dig +short NS <domain>`. HTTP 200 means registered; 404 means the registry has no record.

A 404 with no nameservers means the domain **appears unregistered**. It does not mean it is purchasable at standard price: premium pricing, reserved names and registrar holds are only visible at a registrar checkout, which was not started.

```text
probatum.dev | https://pubapi.registry.google/rdap/domain/probatum.dev => 200 registration=2026-03-14 expiration=2027-03-14 | dig NS: dns1.registrar-servers.com. dns2.registrar-servers.com.
probatum.app | https://pubapi.registry.google/rdap/domain/probatum.app => 200 registration=2026-04-18 expiration=2027-04-18 | dig NS: ns14.ovh.net. dns14.ovh.net.
probatum.sh | https://rdap.identitydigital.services/rdap/domain/probatum.sh => 404  | dig NS: none
probatum.io | https://rdap.identitydigital.services/rdap/domain/probatum.io => 200 expiration=2027-03-04 registration=2026-03-04 | dig NS: ns-cloud-c1.googledomains.com. ns-cloud-c2.googledomains.com.
probatum.com | https://rdap.verisign.com/com/v1/domain/probatum.com => 200 registration=2000-02-17 expiration=2027-02-17 | dig NS: ns-138.awsdns-17.com. ns-793.awsdns-35.net.
probatumeditor.com | https://rdap.verisign.com/com/v1/domain/probatumeditor.com => 404  | dig NS: none
getprobatum.com | https://rdap.verisign.com/com/v1/domain/getprobatum.com => 200 registration=2026-09-01 expiration=2027-09-01 | dig NS: ryan.ns.cloudflare.com. harmony.ns.cloudflare.com.
```

## Trademarks

Covered by the web search above (it included the word "trademark"). No "Probatum" record surfaced.

Direct register searches:

- USPTO Trademark Search (https://tmsearch.uspto.gov/): not checked: the page is a JavaScript application; a plain HTTP GET of the search URL returned the application shell with no result data.
- EUIPO eSearch plus (https://euipo.europa.eu/eSearch/): not checked: JavaScript application; a plain HTTP GET returned no response body.
- WIPO Global Brand Database (https://branddb.wipo.int/): not checked: JavaScript application; a plain HTTP GET returned a 1.7 kB shell with no result data.
- UK IPO trade mark search (https://www.gov.uk/search-for-trademark): not checked: the one UK IPO page requested during this research returned HTTP 403 with a CAPTCHA security check, which was not attempted.

These four searches (Nice Classes 9 and 42, exact and similar marks) must be run by the owner or counsel. Nothing here is a clearance.

## Verdict

**DISQUALIFIED.** A same-name developer tool about verified program generation was published in 2026, and the npm name plus most domains were claimed the same year. The projects are small, so this is a judgment call, but the name is visibly being built on.
