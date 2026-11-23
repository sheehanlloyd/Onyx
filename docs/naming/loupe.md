# Loupe

Preliminary research, not legal clearance.

Date of all checks: 2026-11-22. Nothing was registered, reserved or purchased. Availability can change at any time.

**Verdict: DISQUALIFIED.** Many developer tools on macOS and in every registry already use the name, including a "loupe-editor" GitHub organization and loupeeditor.com, both created in 2026.

## The name

A jeweller's magnifier. Length: 5 letters. As a command and bundle name: `loupe`.

## Web search for collisions

Tool: web search (US index). Queries and results:

- Query: `"Loupe" developer tool OR AI OR app software loupe (event loop visualizer, Loupe Mac app, Loupe AI)`
  Result: Loupe, a macOS accessibility inspector for AI agents that copies structured output for AI coding tools: https://smughead.github.io/Loupe ; "Loupe: Log Forensics", Mac App Store, Developer Tools: https://apps.apple.com/app/id6794675487 ; Aeastr/Loupe SwiftUI debugging toolkit: https://github.com/Aeastr/Loupe ; Loupe by Mysk: https://github.com/mysk-research/loupe ; Loupe screen magnifier for Mac: https://apps.apple.com/us/app/loupe/id1535217393?mt=12

Web search alone missed several small projects during this research; the GitHub and registry lookups below are the stronger evidence.

Collisions found (all sources):

Direct and numerous: latentflip/loupe JavaScript runtime visualizer (3258 stars) https://github.com/latentflip/loupe ; npm "loupe" inspect utility (a dependency of the Chai assertion library; that relationship is from memory, not checked); crates.io "loupe" profiling tool (4124776 downloads); macOS developer tools named Loupe (URLs above); GitHub organizations loupe, loupe-editor (created 2026-10-05) and loupehq exist; loupeeditor.com was registered 2026-09-06.

## GitHub

`gh api users/<handle>` returns the account type when the handle is taken and 404 when it is unclaimed. Read-only.

```text
gh api users/loupe => Organization created 2019-11-07 public_repos 0
gh api users/loupe-editor => Organization created 2026-10-05 public_repos 1
gh api users/loupeeditor => 404 Not Found
gh api users/getloupe => 404 Not Found
gh api users/loupehq => Organization created 2020-08-08 public_repos 0
gh api users/loupe-dev => User created 2023-06-08 public_repos 0
gh search repos loupe --sort stars --limit 5 =>
  latentflip/loupe | 3258 stars | Visualizing the javascript runtime at runtime
  mysk-research/loupe | 1584 stars | A privacy-focused iOS app that raises awareness about what native apps can see
  Aeastr/Loupe | 645 stars | A SwiftUI debugging toolkit for visualizing renders, layouts, and measurements.
  loupe-php/loupe | 533 stars | A full text search engine with tokenization, stemming, typo tolerance, filters and geo support based on only P
  PHP-CMSIG/search | 445 stars | Search abstraction over different search engines written in PHP. Currently implemented Elasticsearch, Opensear
```

## Package registries

HTTP status of a read-only GET (200 means the name is taken, 404 means no package by that name). crates.io was queried with the User-Agent `name-research`.

```text
npm https://registry.npmjs.org/loupe => 200
pypi https://pypi.org/pypi/loupe/json => 200
crates https://crates.io/api/v1/crates/loupe => 200
brew formula https://formulae.brew.sh/api/formula/loupe.json => 404
brew cask https://formulae.brew.sh/api/cask/loupe.json => 404
npm desc: Inspect utility for Node.js and browsers | latest 3.2.1 | modified 2025-08-21
pypi desc: A Python library for solving parametric optimization problems with built-in autograd. | version 1.3.1
crates desc: Profiling tool for Rust | downloads 4124776
```

## App stores

iTunes Search API: `https://itunes.apple.com/search?term=loupe&entity=macSoftware&limit=5` and the same with `entity=software`. The API returns fuzzy matches, so most rows are not same-name apps.

```text
itunes entity=macSoftware =>
  resultCount 4
  - Loupe | Joseph Stenger | Utilities
  - MIDI Loupe & Monitor | Gerald Flossmann | Music
  - Zoom Me - Desktop Magnifier | 永英 陆 | Productivity
  - Cursor Pro | App ahead GmbH | Productivity
itunes entity=software =>
  resultCount 5
  - Loupe - Sports Trading Cards | Loupe Tech, LLC | Shopping
  - Loupe: What Apps Can See | Mysk Inc. | Developer Tools
  - Magnifying Glass - handy loupe | Katoh Atsushi | Utilities
  - Loupe: Live Screen Translator | 泽政 邱 | Utilities
  - Magnifier | Apple Inc. | Utilities
```

## Domains

Method: RDAP at the registry (Verisign for .com, Google Registry for .dev and .app, Identity Digital for .io and .sh) plus `dig +short NS <domain>`. HTTP 200 means registered; 404 means the registry has no record.

A 404 with no nameservers means the domain **appears unregistered**. It does not mean it is purchasable at standard price: premium pricing, reserved names and registrar holds are only visible at a registrar checkout, which was not started.

```text
loupe.dev | https://pubapi.registry.google/rdap/domain/loupe.dev => 200 registration=2020-07-30 expiration=2029-07-30 | dig NS: ns15.domaincontrol.com. ns16.domaincontrol.com.
loupe.app | https://pubapi.registry.google/rdap/domain/loupe.app => 200 registration=2019-09-18 expiration=2027-09-18 | dig NS: maceio.ns.porkbun.com. curitiba.ns.porkbun.com.
loupe.sh | https://rdap.identitydigital.services/rdap/domain/loupe.sh => 200 registration=2026-03-09 expiration=2027-03-09 | dig NS: nsany1.infomaniak.com. nsany2.infomaniak.com.
loupe.io | https://rdap.identitydigital.services/rdap/domain/loupe.io => 200 expiration=2027-08-05 registration=2020-08-05 | dig NS: ns1.afternic.com. ns2.afternic.com.
loupe.com | https://rdap.verisign.com/com/v1/domain/loupe.com => 200 registration=1998-09-28 expiration=2027-09-27 | dig NS: viddy.ns.cloudflare.com. meilani.ns.cloudflare.com.
loupeeditor.com | https://rdap.verisign.com/com/v1/domain/loupeeditor.com => 200 registration=2026-09-06 expiration=2027-09-06 | dig NS: dns1.registrar-servers.com. dns2.registrar-servers.com.
getloupe.com | https://rdap.verisign.com/com/v1/domain/getloupe.com => 200 registration=2011-10-21 expiration=2027-10-21 | dig NS: adrian.ns.cloudflare.com. khalid.ns.cloudflare.com.
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

**DISQUALIFIED.** Many developer tools on macOS and in every registry already use the name, including a "loupe-editor" GitHub organization and loupeeditor.com, both created in 2026.
