# Obelus

Preliminary research, not legal clearance.

Date of all checks: 2026-11-22. Nothing was registered, reserved or purchased. Availability can change at any time.

**Verdict: DISQUALIFIED.** A code editor with a built-in agent already ships under this exact name.

## The name

The dagger or division mark that ancient editors used to flag doubtful passages. Length: 6 letters. As a command and bundle name: `obelus`.

## Web search for collisions

Tool: web search (US index). Queries and results:

- Query: `"Obelus" editor OR AI OR software OR developer tool "obelus"`
  Result: Web search returned nothing named Obelus. The GitHub checks below found the collisions.

Web search alone missed several small projects during this research; the GitHub and registry lookups below are the stronger evidence.

Collisions found (all sources):

Direct: (1) obelus-editor/obelus, "A code editor that fits how I work, with the agent built in, in a window of its own or in a terminal": https://github.com/obelus-editor/obelus , site https://obelus-editor.github.io/obelus/ (30 stars, pushed 2026-11-13; organization created 2026-09-29); (2) 4gentic/obelus, an offline peer-review surface for AI-assisted papers: https://github.com/4gentic/obelus , https://obelus.4gentic.ai ; (3) npm and PyPI "obelus" taken; (4) obelus.sh and obelus.io registered in 2026.

## GitHub

`gh api users/<handle>` returns the account type when the handle is taken and 404 when it is unclaimed. Read-only.

```text
gh api users/obelus => User created 2014-02-25 public_repos 0
gh api users/obelus-editor => Organization created 2026-09-29 public_repos 2
gh api users/obeluseditor => 404 Not Found
gh api users/getobelus => 404 Not Found
gh api users/obelushq => 404 Not Found
gh api users/obelus-dev => 404 Not Found
gh search repos obelus --sort stars --limit 5 =>
  obelus-editor/obelus | 30 stars | A code editor that fits how I work, with the agent built in, in a window of its own or in a terminal.
  4gentic/obelus | 8 stars | (description omitted)
  monthyx1337/obelus-hack | 7 stars | obelus csgo hack
  polyfish42/obelus | 4 stars | An HTML5 canvas game inspired by The Witness. Draw lines to solve puzzles.
  Pawcharz/obelus-paper-reader | 2 stars | Read research papers with a pen or a keyboard: margin notes linked to the exact words, equations and figures t
```

## Package registries

HTTP status of a read-only GET (200 means the name is taken, 404 means no package by that name). crates.io was queried with the User-Agent `name-research`.

```text
npm https://registry.npmjs.org/obelus => 200
pypi https://pypi.org/pypi/obelus/json => 200
crates https://crates.io/api/v1/crates/obelus => 404
brew formula https://formulae.brew.sh/api/formula/obelus.json => 404
brew cask https://formulae.brew.sh/api/cask/obelus.json => 404
npm desc: A modular, type-safe animation domain-specific language (DSL) written in TypeScript. This library defines a declarative  | latest 0.0.14 | modified 2026-01-16
pypi desc: Protocol implementation of the Asterisk Manager Interface and Asterisk Gateway Interface | version 0.1
```

## App stores

iTunes Search API: `https://itunes.apple.com/search?term=obelus&entity=macSoftware&limit=5` and the same with `entity=software`. The API returns fuzzy matches, so most rows are not same-name apps.

```text
itunes entity=macSoftware =>
  resultCount 0
itunes entity=software =>
  resultCount 3
  - Obelus: Budget & Expense AI | Billy Joe Villas | Finance
  - Obelus Calculator | Chris Wang | Utilities
  - GatherGood: Marble Jars | Obelus One LLC | Lifestyle
```

## Domains

Method: RDAP at the registry (Verisign for .com, Google Registry for .dev and .app, Identity Digital for .io and .sh) plus `dig +short NS <domain>`. HTTP 200 means registered; 404 means the registry has no record.

A 404 with no nameservers means the domain **appears unregistered**. It does not mean it is purchasable at standard price: premium pricing, reserved names and registrar holds are only visible at a registrar checkout, which was not started.

```text
obelus.dev | https://pubapi.registry.google/rdap/domain/obelus.dev => 200 registration=2025-12-14 expiration=2026-12-14 | dig NS: ns-229.awsdns-28.com. ns-684.awsdns-21.net.
obelus.app | https://pubapi.registry.google/rdap/domain/obelus.app => 200 registration=2018-05-10 expiration=2027-05-10 | dig NS: ns1.hover.com. ns2.hover.com.
obelus.sh | https://rdap.identitydigital.services/rdap/domain/obelus.sh => 200 expiration=2027-04-20 registration=2026-04-20 | dig NS: jen.ns.cloudflare.com. jasper.ns.cloudflare.com.
obelus.io | https://rdap.identitydigital.services/rdap/domain/obelus.io => 200 expiration=2027-11-06 registration=2026-11-06 | dig NS: ns1.afternic.com. ns2.afternic.com.
obelus.com | https://rdap.verisign.com/com/v1/domain/obelus.com => 200 registration=2000-02-22 expiration=2031-02-22 | dig NS: kara.ns.cloudflare.com. javier.ns.cloudflare.com.
obeluseditor.com | https://rdap.verisign.com/com/v1/domain/obeluseditor.com => 404  | dig NS: none
getobelus.com | https://rdap.verisign.com/com/v1/domain/getobelus.com => 200 registration=2026-07-01 expiration=2027-07-01 | dig NS: dns1.registrar-servers.com. dns2.registrar-servers.com.
```

## Trademarks

not checked: the name is already disqualified by a direct collision, so a trademark search would not change the verdict.

Direct register searches:

- USPTO Trademark Search (https://tmsearch.uspto.gov/): not checked: the page is a JavaScript application; a plain HTTP GET of the search URL returned the application shell with no result data.
- EUIPO eSearch plus (https://euipo.europa.eu/eSearch/): not checked: JavaScript application; a plain HTTP GET returned no response body.
- WIPO Global Brand Database (https://branddb.wipo.int/): not checked: JavaScript application; a plain HTTP GET returned a 1.7 kB shell with no result data.
- UK IPO trade mark search (https://www.gov.uk/search-for-trademark): not checked: the one UK IPO page requested during this research returned HTTP 403 with a CAPTCHA security check, which was not attempted.

These four searches (Nice Classes 9 and 42, exact and similar marks) must be run by the owner or counsel. Nothing here is a clearance.

## Verdict

**DISQUALIFIED.** A code editor with a built-in agent already ships under this exact name.
