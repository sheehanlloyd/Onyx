# Vernier

Preliminary research, not legal clearance.

Date of all checks: 2026-11-22. Nothing was registered, reserved or purchased. Availability can change at any time.

**Verdict: DISQUALIFIED.** A widely used profiler, an established software company and an AI-agent feedback tool all use the exact name.

## The name

The sliding fine-reading scale on a caliper. Length: 7 letters. As a command and bundle name: `vernier`.

## Web search for collisions

Tool: web search (US index). Queries and results:

- Query: `"Vernier" software profiler OR developer tool OR AI "vernier"`
  Result: Vernier, the CRuby sampling profiler: https://github.com/jhawthorn/vernier , viewer at https://vernier.prof/ , listing https://www.ruby-toolbox.com/projects/vernier

Web search alone missed several small projects during this research; the GitHub and registry lookups below are the stronger evidence.

Collisions found (all sources):

Direct: (1) jhawthorn/vernier, a well-known Ruby profiler (1126 stars, pushed 2026-11-11); (2) Vernier Software & Technology, a company with several App Store apps (Vernier Graphical Analysis and others) and GitHub account VernierST; (3) npm "vernier", "Local UI feedback layer for turning visual bugs into agent-readable fix packets" (modified 2026-06-14); (4) PyPI and crates.io "vernier", an evaluation library for COCO-style metrics; (5) GitHub accounts getvernier, vernier-dev and vernierhq were all created in 2026.

## GitHub

`gh api users/<handle>` returns the account type when the handle is taken and 404 when it is unclaimed. Read-only.

```text
gh api users/vernier => User created 2012-06-05 public_repos 4
gh api users/vernier-editor => 404 Not Found
gh api users/verniereditor => 404 Not Found
gh api users/getvernier => Organization created 2026-09-22 public_repos 0
gh api users/vernierhq => User created 2026-06-08 public_repos 0
gh api users/vernier-dev => Organization created 2026-09-22 public_repos 0
gh search repos vernier --sort stars --limit 5 =>
  jhawthorn/vernier | 1126 stars |  next generation CRuby profiler
  VernierST/arduino | 30 stars | Project sketches using Vernier Sensors with Arduino. The Vernier Library is used where appropriate. Please see
  VernierST/godirect-examples | 29 stars | Official examples for Vernier Go Direct® Sensors in both Python and JavaScript
  Nicholasli1995/SNVC | 17 stars | Official project website for the AAAI 2022 paper "Stereo Neural Vernier Caliper"
  embodied-computation-group/respyra | 16 stars | A general-purpose respiratory tracking toolbox for interoception research
```

## Package registries

HTTP status of a read-only GET (200 means the name is taken, 404 means no package by that name). crates.io was queried with the User-Agent `name-research`.

```text
npm https://registry.npmjs.org/vernier => 200
pypi https://pypi.org/pypi/vernier/json => 200
crates https://crates.io/api/v1/crates/vernier => 200
brew formula https://formulae.brew.sh/api/formula/vernier.json => 404
brew cask https://formulae.brew.sh/api/cask/vernier.json => 404
npm desc: Local UI feedback layer for turning visual bugs into agent-readable fix packets. | latest 0.1.2 | modified 2026-06-14
pypi desc: High-performance, parity-preserving COCO-style evaluation | version 0.6.0
crates desc: One-dependency facade over the vernier evaluation crates — instance AP, mask kernels, panoptic PQ, semantic mIoU | downloads 180
```

## App stores

iTunes Search API: `https://itunes.apple.com/search?term=vernier&entity=macSoftware&limit=5` and the same with `entity=software`. The API returns fuzzy matches, so most rows are not same-name apps.

```text
itunes entity=macSoftware =>
  resultCount 2
  - Scratch Link | Scratch Foundation, Inc. | Education
  - Time Logger Pro | Fun Pixel Inc. | Productivity
itunes entity=software =>
  resultCount 5
  - Vernier Graphical Analysis | Vernier Software & Technology | Education
  - Vernier Spectral Analysis | Vernier Software & Technology | Education
  - Vernier Graphical Analysis GW | Vernier Software & Technology | Education
  - Vernier Instrumental Analysis | Vernier Software & Technology | Education
  - Vernier Caliper Simulator | Jiun Wei Chia | Education
```

## Domains

Method: RDAP at the registry (Verisign for .com, Google Registry for .dev and .app, Identity Digital for .io and .sh) plus `dig +short NS <domain>`. HTTP 200 means registered; 404 means the registry has no record.

A 404 with no nameservers means the domain **appears unregistered**. It does not mean it is purchasable at standard price: premium pricing, reserved names and registrar holds are only visible at a registrar checkout, which was not started.

```text
vernier.dev | https://pubapi.registry.google/rdap/domain/vernier.dev => 200 registration=2026-05-06 expiration=2027-05-06 | dig NS: pdns1.registrar-servers.com. pdns2.registrar-servers.com.
vernier.app | https://pubapi.registry.google/rdap/domain/vernier.app => 200 registration=2018-05-05 expiration=2027-05-05 | dig NS: none
vernier.sh | https://rdap.identitydigital.services/rdap/domain/vernier.sh => 200 expiration=2027-10-28 registration=2026-10-28 | dig NS: opal.ns.cloudflare.com. phil.ns.cloudflare.com.
vernier.io | https://rdap.identitydigital.services/rdap/domain/vernier.io => 200 expiration=2027-04-03 registration=2026-04-03 | dig NS: maceio.ns.porkbun.com. curitiba.ns.porkbun.com.
vernier.com | https://rdap.verisign.com/com/v1/domain/vernier.com => 200 registration=1994-12-19 expiration=2029-12-18 | dig NS: cody.ns.cloudflare.com. jean.ns.cloudflare.com.
verniereditor.com | https://rdap.verisign.com/com/v1/domain/verniereditor.com => 404  | dig NS: none
getvernier.com | https://rdap.verisign.com/com/v1/domain/getvernier.com => 200 registration=2024-02-26 expiration=2027-02-26 | dig NS: kevin.ns.cloudflare.com. chelsea.ns.cloudflare.com.
```

## Trademarks

not checked: the name is already disqualified by direct collisions. Vernier Software & Technology is an established company publishing software under this name (see App Store results below), so existing marks are likely; that was not verified.

Direct register searches:

- USPTO Trademark Search (https://tmsearch.uspto.gov/): not checked: the page is a JavaScript application; a plain HTTP GET of the search URL returned the application shell with no result data.
- EUIPO eSearch plus (https://euipo.europa.eu/eSearch/): not checked: JavaScript application; a plain HTTP GET returned no response body.
- WIPO Global Brand Database (https://branddb.wipo.int/): not checked: JavaScript application; a plain HTTP GET returned a 1.7 kB shell with no result data.
- UK IPO trade mark search (https://www.gov.uk/search-for-trademark): not checked: the one UK IPO page requested during this research returned HTTP 403 with a CAPTCHA security check, which was not attempted.

These four searches (Nice Classes 9 and 42, exact and similar marks) must be run by the owner or counsel. Nothing here is a clearance.

## Verdict

**DISQUALIFIED.** A widely used profiler, an established software company and an AI-agent feedback tool all use the exact name.
