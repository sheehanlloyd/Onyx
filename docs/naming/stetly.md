# Stetly

Preliminary research, not legal clearance.

Date of all checks: 2026-11-22. Nothing was registered, reserved or purchased. Availability can change at any time.

**Verdict: DISQUALIFIED.** Two same-name apps exist, one of them a writing and publishing editor, and the name is one suffix away from "Stet", which is used by AI coding-agent review and evaluation products. This is a judgment call: no same-name developer tool was found on GitHub or in the registries, where every identifier was unclaimed.

## The name

Coined from "stet" (let it stand) plus "-ly". Length: 6 letters. As a command and bundle name: `stetly`.

## Web search for collisions

Tool: web search (US index). Queries and results:

- Query: `"Stetly" OR "Lydstone" software OR app OR AI OR company`
  Result: Nothing named Stetly was returned.
- Query: `"Stetly" app OR startup OR software OR "stetly.com"`
  Result: Nothing named Stetly was returned by web search. The App Store lookup below did find two apps.

Web search alone missed several small projects during this research; the GitHub and registry lookups below are the stronger evidence.

Collisions found (all sources):

App Store (iTunes Search API, entity=software): "Stetly Write & Publish" (Productivity, a writing tool) and "Stetly App" (Business). stetly.com (2014) and stetly.app (2026-06-10) are registered. The root "Stet" is used by AI coding-agent review and evaluation tools (see stet.md), and the same App Store query returned "Stet Writer" under Developer Tools.

## GitHub

`gh api users/<handle>` returns the account type when the handle is taken and 404 when it is unclaimed. Read-only.

```text
gh api users/stetly => 404 Not Found
gh api users/stetly-editor => 404 Not Found
gh api users/stetlyeditor => 404 Not Found
gh api users/getstetly => 404 Not Found
gh api users/stetlyhq => 404 Not Found
gh api users/stetly-dev => 404 Not Found
gh search repos stetly --sort stars --limit 5 =>
  greenrd/stet | 8 stars | Archive of https://www.gitorious.org/stet/stet.git/
  cgrunewald/stet | 8 stars | Stet: a quiet, fast markdown writer with a Rust core. Vim keys, linked notes, review suggestions, and an agent
  plotify/plotify | 8 stars | Plotify ist eine Software für Schriftsteller/innen, die dir dabei hilft, die Charaktere deiner Geschichte zu p
  Stet-AI/stet-cli | 5 stars | Evaluate coding agents (Claude Code, Codex, Cursor) on your own repo's merged PRs. Installer and agent skill f
  hassansaleh31/fullstack-javascript-tutorial-for-beginners | 5 stars | A beginner friendly stet by step tutorial aimed to teach you how to build a Node.js API connected to a sql dat
```

## Package registries

HTTP status of a read-only GET (200 means the name is taken, 404 means no package by that name). crates.io was queried with the User-Agent `name-research`.

```text
npm https://registry.npmjs.org/stetly => 404
pypi https://pypi.org/pypi/stetly/json => 404
crates https://crates.io/api/v1/crates/stetly => 404
brew formula https://formulae.brew.sh/api/formula/stetly.json => 404
brew cask https://formulae.brew.sh/api/cask/stetly.json => 404
```

## App stores

iTunes Search API: `https://itunes.apple.com/search?term=stetly&entity=macSoftware&limit=5` and the same with `entity=software`. The API returns fuzzy matches, so most rows are not same-name apps.

```text
itunes entity=macSoftware =>
  resultCount 0
itunes entity=software =>
  resultCount 5
  - Klarna: Smarter everyday money | Klarna Bank AB | Finance
  - Stetly App | Daniel Stooss LLC | Business
  - StetSAFE | KuartisMed Ltd Sti | Medical
  - Stet Writer | Almost Right Creative, LLC | Developer Tools
  - Stetly Write & Publish | Theano Bertsia | Productivity
```

## Domains

Method: RDAP at the registry (Verisign for .com, Google Registry for .dev and .app, Identity Digital for .io and .sh) plus `dig +short NS <domain>`. HTTP 200 means registered; 404 means the registry has no record.

A 404 with no nameservers means the domain **appears unregistered**. It does not mean it is purchasable at standard price: premium pricing, reserved names and registrar holds are only visible at a registrar checkout, which was not started.

```text
stetly.dev | https://pubapi.registry.google/rdap/domain/stetly.dev => 404  | dig NS: none
stetly.app | https://pubapi.registry.google/rdap/domain/stetly.app => 200 registration=2026-06-10 expiration=2027-06-10 | dig NS: kay.ns.cloudflare.com. javon.ns.cloudflare.com.
stetly.sh | https://rdap.identitydigital.services/rdap/domain/stetly.sh => 404  | dig NS: none
stetly.io | https://rdap.identitydigital.services/rdap/domain/stetly.io => 404  | dig NS: none
stetly.com | https://rdap.verisign.com/com/v1/domain/stetly.com => 200 registration=2014-05-07 expiration=2027-05-07 | dig NS: lily.ns.cloudflare.com. will.ns.cloudflare.com.
stetlyeditor.com | https://rdap.verisign.com/com/v1/domain/stetlyeditor.com => 404  | dig NS: none
getstetly.com | https://rdap.verisign.com/com/v1/domain/getstetly.com => 404  | dig NS: none
```

## Trademarks

Web search: "lydite" trademark software OR "lydstone" trademark OR "stetly" trademark. No "Stetly" record surfaced.

Direct register searches:

- USPTO Trademark Search (https://tmsearch.uspto.gov/): not checked: the page is a JavaScript application; a plain HTTP GET of the search URL returned the application shell with no result data.
- EUIPO eSearch plus (https://euipo.europa.eu/eSearch/): not checked: JavaScript application; a plain HTTP GET returned no response body.
- WIPO Global Brand Database (https://branddb.wipo.int/): not checked: JavaScript application; a plain HTTP GET returned a 1.7 kB shell with no result data.
- UK IPO trade mark search (https://www.gov.uk/search-for-trademark): not checked: the one UK IPO page requested during this research returned HTTP 403 with a CAPTCHA security check, which was not attempted.

These four searches (Nice Classes 9 and 42, exact and similar marks) must be run by the owner or counsel. Nothing here is a clearance.

## Verdict

**DISQUALIFIED.** Two same-name apps exist, one of them a writing and publishing editor, and the name is one suffix away from "Stet", which is used by AI coding-agent review and evaluation products. This is a judgment call: no same-name developer tool was found on GitHub or in the registries, where every identifier was unclaimed.
