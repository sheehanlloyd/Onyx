# Dubitant

Preliminary research, not legal clearance.

Date of all checks: 2026-11-22. Nothing was registered, reserved or purchased. Availability can change at any time.

**Verdict: SURVIVES.** No same-name product was found in any check, and every identifier checked was unclaimed on the date, including the .com.

## The name

Rare English word (also French): "one who doubts". It names the stance directly: the editor doubts the model until the evidence is in. Length: 8 letters. As a command and bundle name: `dubitant`.

## Web search for collisions

Tool: web search (US index). Queries and results:

- Query: `"Dubitant" software OR app OR AI OR company OR trademark`
  Result: No product, company or project with this exact name was returned. Nearest neighbour: DUBIUS, a pending US application (serial 99090886, owner The Credible AI Labs Inc., described by the aggregator as covering software for evaluating; the description was cut off): https://trademark.justia.com/990/90/dubius-99090886.html

Web search alone missed several small projects during this research; the GitHub and registry lookups below are the stronger evidence.

Collisions found (all sources):

None found by exact name in developer tools, editors, AI products, languages or open-source projects.

## GitHub

`gh api users/<handle>` returns the account type when the handle is taken and 404 when it is unclaimed. Read-only.

```text
gh api users/dubitant => 404 Not Found
gh api users/dubitant-editor => 404 Not Found
gh api users/dubitanteditor => 404 Not Found
gh api users/getdubitant => 404 Not Found
gh api users/dubitanthq => 404 Not Found
gh api users/dubitant-dev => 404 Not Found
gh search repos dubitant --sort stars --limit 5 =>
```

## Package registries

HTTP status of a read-only GET (200 means the name is taken, 404 means no package by that name). crates.io was queried with the User-Agent `name-research`.

```text
npm https://registry.npmjs.org/dubitant => 404
pypi https://pypi.org/pypi/dubitant/json => 404
crates https://crates.io/api/v1/crates/dubitant => 404
brew formula https://formulae.brew.sh/api/formula/dubitant.json => 404
brew cask https://formulae.brew.sh/api/cask/dubitant.json => 404
```

## App stores

iTunes Search API: `https://itunes.apple.com/search?term=dubitant&entity=macSoftware&limit=5` and the same with `entity=software`. The API returns fuzzy matches, so most rows are not same-name apps.

```text
itunes entity=macSoftware =>
  resultCount 0
itunes entity=software =>
  resultCount 1
  - 少儿英语秀-随时随地秀英语 | Chengdu Aitu Education Technology Co., Ltd. | Education
```

## Domains

Method: RDAP at the registry (Verisign for .com, Google Registry for .dev and .app, Identity Digital for .io and .sh) plus `dig +short NS <domain>`. HTTP 200 means registered; 404 means the registry has no record.

A 404 with no nameservers means the domain **appears unregistered**. It does not mean it is purchasable at standard price: premium pricing, reserved names and registrar holds are only visible at a registrar checkout, which was not started.

```text
dubitant.dev | https://pubapi.registry.google/rdap/domain/dubitant.dev => 404  | dig NS: none
dubitant.app | https://pubapi.registry.google/rdap/domain/dubitant.app => 404  | dig NS: none
dubitant.sh | https://rdap.identitydigital.services/rdap/domain/dubitant.sh => 404  | dig NS: none
dubitant.io | https://rdap.identitydigital.services/rdap/domain/dubitant.io => 404  | dig NS: none
dubitant.com | https://rdap.verisign.com/com/v1/domain/dubitant.com => 404  | dig NS: none
dubitanteditor.com | https://rdap.verisign.com/com/v1/domain/dubitanteditor.com => 404  | dig NS: none
getdubitant.com | https://rdap.verisign.com/com/v1/domain/getdubitant.com => 404  | dig NS: none
```

## Trademarks

The same web search served as the trademark search (it included the word "trademark"). No exact "Dubitant" record surfaced. The DUBIUS application above shares the Latin root and sits in AI evaluation software; counsel should judge whether that is close enough to matter.

Direct register searches:

- USPTO Trademark Search (https://tmsearch.uspto.gov/): not checked: the page is a JavaScript application; a plain HTTP GET of the search URL returned the application shell with no result data.
- EUIPO eSearch plus (https://euipo.europa.eu/eSearch/): not checked: JavaScript application; a plain HTTP GET returned no response body.
- WIPO Global Brand Database (https://branddb.wipo.int/): not checked: JavaScript application; a plain HTTP GET returned a 1.7 kB shell with no result data.
- UK IPO trade mark search (https://www.gov.uk/search-for-trademark): not checked: the one UK IPO page requested during this research returned HTTP 403 with a CAPTCHA security check, which was not attempted.

These four searches (Nice Classes 9 and 42, exact and similar marks) must be run by the owner or counsel. Nothing here is a clearance.

## Verdict

**SURVIVES.** No same-name product was found in any check, and every identifier checked was unclaimed on the date, including the .com.

Remaining risks:

- Eight letters and three syllables: longer than the 4 to 7 letter target.
- Unfamiliar word; some people will need it spelled once. The tone is sceptical, which fits the stance but may read as negative.
- DUBIUS (pending US application, AI evaluation software) shares the root "dubi-". Not checked by counsel.
- Trademark registers were not queried directly (see below).
- Domains "appear unregistered" by RDAP and DNS only; price and registrar holds are unknown.
