# Tentamen

Preliminary research, not legal clearance.

Date of all checks: 2026-11-22. Nothing was registered, reserved or purchased. Availability can change at any time.

**Verdict: SURVIVES.** The only same-name developer tool is a dormant 8-star package; the GitHub handle is unclaimed and .dev, .app, .sh and .io appear unregistered.

## The name

Latin for "trial, attempt, test". In Dutch and Swedish it is the everyday word for an exam. Length: 8 letters. As a command and bundle name: `tentamen`.

## Web search for collisions

Tool: web search (US index). Queries and results:

- Query: `"Tentamen" software OR app OR AI OR developer tool OR startup`
  Result: No product named Tentamen was returned. Results were exam-related education startups (Examzone, Tentaklar, Eduface), which shows the generic "exam" meaning dominates search.

Web search alone missed several small projects during this research; the GitHub and registry lookups below are the stronger evidence.

Collisions found (all sources):

A small JavaScript testing framework holds the npm name: https://github.com/sporeball/tentamen (8 stars, last push 2022-12-06, npm latest 0.4.1 modified 2022-12-06). It is a developer tool by the same name, but tiny and dormant, so it is listed as a risk and not as a disqualifying collision.

## GitHub

`gh api users/<handle>` returns the account type when the handle is taken and 404 when it is unclaimed. Read-only.

```text
gh api users/tentamen => 404 Not Found
gh api users/tentamen-editor => 404 Not Found
gh api users/tentameneditor => 404 Not Found
gh api users/gettentamen => 404 Not Found
gh api users/tentamenhq => 404 Not Found
gh api users/tentamen-dev => 404 Not Found
gh search repos tentamen --sort stars --limit 5 =>
  sporeball/tentamen | 8 stars | a tiny JavaScript testing framework
  raoulg/ML22-tentamen | 3 stars |
  argon11110/Josef-Kaa-Veggis1077-RealLifeIronMan-og-emmil-sin-tentamen | 3 stars |
  Alexvanderwal/iitorg-samenvatting | 2 stars |
  viktorsve/tentamen | 1 stars |
```

## Package registries

HTTP status of a read-only GET (200 means the name is taken, 404 means no package by that name). crates.io was queried with the User-Agent `name-research`.

```text
npm https://registry.npmjs.org/tentamen => 200
pypi https://pypi.org/pypi/tentamen/json => 404
crates https://crates.io/api/v1/crates/tentamen => 404
brew formula https://formulae.brew.sh/api/formula/tentamen.json => 404
brew cask https://formulae.brew.sh/api/cask/tentamen.json => 404
npm desc: a tiny JavaScript testing framework | latest 0.4.1 | modified 2022-12-06
```

## App stores

iTunes Search API: `https://itunes.apple.com/search?term=tentamen&entity=macSoftware&limit=5` and the same with `entity=software`. The API returns fuzzy matches, so most rows are not same-name apps.

```text
itunes entity=macSoftware =>
  resultCount 0
itunes entity=software =>
  resultCount 1
  - Teoritentamen for bil | Vladislav Zhirnov | Education
```

## Domains

Method: RDAP at the registry (Verisign for .com, Google Registry for .dev and .app, Identity Digital for .io and .sh) plus `dig +short NS <domain>`. HTTP 200 means registered; 404 means the registry has no record.

A 404 with no nameservers means the domain **appears unregistered**. It does not mean it is purchasable at standard price: premium pricing, reserved names and registrar holds are only visible at a registrar checkout, which was not started.

```text
tentamen.dev | https://pubapi.registry.google/rdap/domain/tentamen.dev => 404  | dig NS: none
tentamen.app | https://pubapi.registry.google/rdap/domain/tentamen.app => 404  | dig NS: none
tentamen.sh | https://rdap.identitydigital.services/rdap/domain/tentamen.sh => 404  | dig NS: none
tentamen.io | https://rdap.identitydigital.services/rdap/domain/tentamen.io => 404  | dig NS: none
tentamen.com | https://rdap.verisign.com/com/v1/domain/tentamen.com => 200 registration=2002-06-17 expiration=2027-06-17 | dig NS: ns1.sedoparking.com. ns2.sedoparking.com.
tentameneditor.com | https://rdap.verisign.com/com/v1/domain/tentameneditor.com => 404  | dig NS: none
gettentamen.com | https://rdap.verisign.com/com/v1/domain/gettentamen.com => 404  | dig NS: none
```

## Trademarks

Web search: "tentamen" trademark software class 9 OR class 42. No "Tentamen" record surfaced.

Direct register searches:

- USPTO Trademark Search (https://tmsearch.uspto.gov/): not checked: the page is a JavaScript application; a plain HTTP GET of the search URL returned the application shell with no result data.
- EUIPO eSearch plus (https://euipo.europa.eu/eSearch/): not checked: JavaScript application; a plain HTTP GET returned no response body.
- WIPO Global Brand Database (https://branddb.wipo.int/): not checked: JavaScript application; a plain HTTP GET returned a 1.7 kB shell with no result data.
- UK IPO trade mark search (https://www.gov.uk/search-for-trademark): not checked: the one UK IPO page requested during this research returned HTTP 403 with a CAPTCHA security check, which was not attempted.

These four searches (Nice Classes 9 and 42, exact and similar marks) must be run by the owner or counsel. Nothing here is a clearance.

## Verdict

**SURVIVES.** The only same-name developer tool is a dormant 8-star package; the GitHub handle is unclaimed and .dev, .app, .sh and .io appear unregistered.

Remaining risks:

- npm name "tentamen" is taken, so an npm package or npx command would need another name.
- Generic word for "exam" in Dutch and Swedish: heavy search noise from student material in those languages, and weak distinctiveness there.
- tentamen.com is registered since 2002 and parked (nameservers at sedoparking.com).
- Eight letters and three syllables.
- Trademark registers were not queried directly.
