# Product name research

Preliminary research, not legal clearance.

Date of all checks: 2026-11-22. This folder holds the shortlist research for renaming the editor currently called "Onyx". The owner picks the name; this document only supplies evidence.

## Plain statements

- (a) This is preliminary research, not legal clearance. No trademark register was queried directly (see "Checks that could not be run").
- (b) No research can promise that a name spreads or is remembered. The ranking below weighs collisions and availability, not future popularity.
- (c) Availability was observed on 2026-11-22 only. Nothing was registered, reserved or purchased, no account, organization or repository was created, and any of these identifiers can be taken by someone else at any time.
- (d) Next steps for the owner are listed at the end: registrar check for price, trademark search by counsel, then register the domain and GitHub organization yourself.

## Headline

Of 16 names researched in full, 4 survive and 12 are disqualified. The space is crowded: almost every short real word that fits the product's stance (testing, proofreading, doubt, measurement) is already used by an AI coding or model-evaluation tool, many of them created during 2026. All four survivors are 6 to 8 letters; no name of 4 or 5 letters got through screening with an unclaimed GitHub handle.

## Method

1. Brainstorm. 118 names were generated in five batches (the brief asked for 25 to 30; the batches grew because the early batches were almost entirely taken). Themes: assaying and touchstones, measurement instruments, proofreading marks, approval and refusal, scepticism, and coinages built on those roots. Names containing "code", "cursor", "copilot", "zed", "wind" or "onyx" were excluded.
2. Screening. For every name: `gh api users/<name>` (handle taken or 404), `gh search repos <name> --sort stars` (top repositories), npm registry status, and RDAP status for `<name>.dev` and `<name>.com`. Deviation from the brief: a web search was run only for names that advanced, not for every brainstormed name; the GitHub repository search stood in for it at screening, and it proved the better detector of small same-name tools.
3. Full research. 16 names advanced (the brief asked for 10 to 12; four were added after most of the initial twelve were disqualified). Each has its own file with every command or URL and its result.
4. Verdict rule. DISQUALIFIED when a same-name project is a developer tool, editor, AI product or model and is either well established or active in 2026 in this product's own territory (AI editing, agent review, model evaluation, benchmarking). A dormant or tiny same-name tool outside that territory is recorded as a risk, not a disqualification. Three verdicts are judgment calls and say so in their files: stetly, assayist and probatum.

Tools and endpoints (all read-only, no login beyond the existing `gh` session, no personal data sent):

- GitHub: `gh api users/<handle>`, `gh search repos <name> --sort stars --limit 5`, `gh api repos/<owner>/<repo>` for descriptions and dates.
- npm `https://registry.npmjs.org/<name>`; PyPI `https://pypi.org/pypi/<name>/json`; crates.io `https://crates.io/api/v1/crates/<name>` with User-Agent `name-research`; Homebrew `https://formulae.brew.sh/api/formula/<name>.json` and `/api/cask/<name>.json`.
- App stores: `https://itunes.apple.com/search?term=<name>&entity=macSoftware&limit=5` and `entity=software`.
- Domains: registry RDAP (`https://rdap.verisign.com/com/v1/domain/<d>`, `https://pubapi.registry.google/rdap/domain/<d>` for .dev and .app, `https://rdap.identitydigital.services/rdap/domain/<d>` for .io and .sh) plus `dig +short NS <d>`. The screening pass used `https://rdap.org/domain/<d>`; it has no data for .io and .sh and began returning HTTP 429, so the full pass went to the registries directly. A control lookup of a nonsense name returned 404 on each endpoint.
- Web search for collisions and for "<name> trademark" with software classes.

In the raw output blocks, three third-party descriptions are replaced with "(description omitted)" or "(subtitle omitted)" because they contain words this repository's hygiene check rejects; emoji were stripped. Nothing else was altered.

"Appears unregistered" means RDAP returned 404 and DNS returned no nameservers. It does not mean purchasable at standard price: premium pricing, reserved names and registrar holds are only visible at a registrar checkout, which was not started.

## All fully researched candidates

| Name | Verdict | GitHub handle | Best available domain | Registries | Main risk |
| --- | --- | --- | --- | --- | --- |
| [dubitant](dubitant.md) | SURVIVES | unclaimed (404) | dubitant.dev, .app, .sh, .io and .com all appear unregistered | npm, PyPI, crates.io, Homebrew: all 404 | Length (8 letters, 3 syllables); DUBIUS pending mark shares the root |
| [lydstone](lydstone.md) | SURVIVES | unclaimed (404) | lydstone.dev (also .app, .sh, .io) appears unregistered; .com is registered | npm, PyPI, crates.io, Homebrew: all 404 | Neighbour "Lydite" (coding-agent tool, same root); .com taken |
| [tentamen](tentamen.md) | SURVIVES | unclaimed (404) | tentamen.dev (also .app, .sh, .io) appears unregistered; .com is registered and parked | npm taken (dormant test framework); PyPI, crates.io, Homebrew 404 | npm name taken by a dormant dev tool; generic "exam" word in Dutch and Swedish |
| [stetit](stetit.md) | SURVIVES | unclaimed (404) | stetit.dev (also .app, .sh, .io) appears unregistered; .com is registered | npm, PyPI, crates.io, Homebrew: all 404 | Root "Stet" is used by AI coding-agent review and evaluation tools |
| [stet](stet.md) | DISQUALIFIED | taken (User, 2021) | none: .dev, .app, .sh, .io, .com all registered | npm 404; PyPI and crates.io taken | STET review gate and Stet-AI agent evaluation CLI |
| [stetly](stetly.md) | DISQUALIFIED | unclaimed (404) | stetly.dev appears unregistered; .com and .app registered | npm, PyPI, crates.io, Homebrew: all 404 | Two same-name apps (one a writing editor) plus the crowded "Stet" root |
| [cupel](cupel.md) | DISQUALIFIED | taken (Organization, 2017, 0 public repos) | none: .dev, .app, .sh, .io, .com all registered (four of them in 2026) | npm 404; PyPI and crates.io taken by LLM tools | tolitius/cupel LLM benchmark; UK Class 42 application |
| [lydite](lydite.md) | DISQUALIFIED | taken (Organization, 2026-08-29) | lydite.app, .sh, .io appear unregistered; .dev and .com registered | npm, PyPI, crates.io, Homebrew: all 404 | aoricloud/lydite coding-agent sandbox tool; lydite org code-quality CLI |
| [assay](assay.md) | DISQUALIFIED | taken (Organization, 2013) | none: .dev, .app, .sh, .io, .com all registered | npm, PyPI, crates.io all taken | Five or more AI evaluation tools named Assay |
| [assayist](assayist.md) | DISQUALIFIED | unclaimed (404) | assayist.dev (also .app, .sh, .io) appears unregistered; .com registered | crates.io taken (benchmark orchestrator); npm, PyPI 404 | Same-name benchmark orchestrator crate (2026); crowded "Assay" family |
| [loupe](loupe.md) | DISQUALIFIED | taken (Organization, 2019) | none: all seven checked domains registered | npm, PyPI, crates.io all taken | Many developer tools named Loupe, including loupe-editor |
| [vernier](vernier.md) | DISQUALIFIED | taken (User, 2012) | none: .dev, .app, .sh, .io, .com all registered | npm, PyPI, crates.io all taken | Ruby profiler (1126 stars) and Vernier Software & Technology |
| [emend](emend.md) | DISQUALIFIED | taken (User, 2011) | emend.sh appears unregistered; .dev, .app, .io, .com registered | npm, PyPI, crates.io all taken | diyanbogdanov/emend verified AI code migrations; PyPI emend refactoring CLI |
| [obelus](obelus.md) | DISQUALIFIED | taken (User, 2014); obelus-editor also taken | none: .dev, .app, .sh, .io, .com all registered | npm and PyPI taken; crates.io 404 | obelus-editor/obelus, a code editor with a built-in agent |
| [trutina](trutina.md) | DISQUALIFIED | taken (User, 2018, 0 public repos) | trutina.sh appears unregistered; .dev, .app, .io, .com registered | PyPI reserved by an AI company; npm, crates.io 404 | trutina-4b AI model; PyPI name reserved by an AI company |
| [probatum](probatum.md) | DISQUALIFIED | unclaimed (404) | probatum.sh appears unregistered; .dev, .app, .io, .com registered | npm and crates.io taken; PyPI 404 | Same-name proof-certificate developer tool (2026); npm and domains claimed |

## Survivors, ranked

The order is by evidence of collision risk, then by how many identifiers were unclaimed. It is not a prediction of which name people will like.

1. **dubitant** ([file](dubitant.md)). "One who doubts." The only name where every check came back empty: no same-name repository in GitHub search, handle 404, npm, PyPI, crates.io and Homebrew 404, and .dev, .app, .sh, .io and .com all appear unregistered. It states the product's stance toward the model in one word. Against it: 8 letters and 3 syllables, an unfamiliar word, and a pending US application for DUBIUS (AI evaluation software) with the same root.
2. **lydstone** ([file](lydstone.md)). Coined from "Lydian stone", the touchstone; keeps the dark-stone lineage of the current name. No same-name repository, handle 404, all registries 404, .dev, .app, .sh and .io appear unregistered. Ranked second because lydstone.com is registered and because "Lydite", a tool that runs coding agents behind a sandbox, shares the root and the meaning.
3. **tentamen** ([file](tentamen.md)). Latin "trial, test". Handle 404 and .dev, .app, .sh and .io appear unregistered. Ranked third because the npm name is held by a dormant JavaScript testing framework (8 stars, last push 2022), tentamen.com is parked, and the word is the everyday term for "exam" in Dutch and Swedish, which weakens distinctiveness and fills search results with student material.
4. **stetit** ([file](stetit.md)). Latin "it stood", built on the proofreading mark "stet". Every identifier except the .com was unclaimed. Ranked last because its root, "Stet", is already used by a review gate for AI coding agents and by a CLI that evaluates coding agents on the user's own repository. That overlap may be disqualifying in counsel's view; it survives here only because no product uses the exact name.

An honest reading: only the top two are clean on the exact name, and none of the four meets the 4 to 7 letter target comfortably. If none appeals, a further round should start from coined words, because real words in this vocabulary are close to exhausted.

## Disqualified, with the collision that killed each

| Name | Collision |
| --- | --- |
| stet | STET review gate for AI coding agents (https://stet.fyi/) and Stet-AI/stet-cli, which evaluates coding agents on the user's own repository (https://www.stet.sh) |
| stetly | Two same-name App Store apps, one a writing and publishing editor; one suffix away from "Stet" (judgment call) |
| cupel | tolitius/cupel LLM benchmarking tool (https://cupel.run, PyPI "cupel"); rommeld/cupel coding harness; UK Class 42 application for "Cupel" |
| lydite | aoricloud/lydite runs coding agents behind a sandbox with verification receipts; GitHub organization "lydite" ships a code-quality CLI |
| assay | At least five AI evaluation or verification tools named Assay (assay-core, assay-ai, assay.tools, Assay.js, Assay code verification) |
| assayist | Same-name benchmark orchestrator on crates.io (2026); derivative of the saturated "Assay" (judgment call) |
| loupe | Many developer tools named Loupe (JavaScript runtime visualizer with 3258 stars, macOS inspector for AI agents, Rust profiler crate); a "loupe-editor" GitHub organization exists |
| vernier | jhawthorn/vernier Ruby profiler (1126 stars); Vernier Software & Technology; npm "vernier" agent feedback tool |
| emend | diyanbogdanov/emend verified AI dependency migrations; PyPI "emend" refactoring CLI |
| obelus | obelus-editor/obelus, a code editor with a built-in agent |
| trutina | trutina-4b AI model; PyPI name reserved by an AI company; a same-name model evaluation harness |
| probatum | Same-name proof-certificate developer tool on crates.io (2026); npm and most domains claimed in 2026 (judgment call) |

## Dropped at screening

One line each. "Handle taken" means `gh api users/<name>` returned an account. Star counts are from `gh search repos` on the date. Where no specific collision is named, the name was dropped because the GitHub handle (and usually npm) was already taken and stronger candidates existed; those names were not searched on the web.

| Name | Reason |
| --- | --- |
| chary | Handle and npm taken; unfamiliar word |
| gnomon | paypal/gnomon command-line tool (932 stars); handle taken |
| burin | Handle and npm taken |
| tare | kelviq/tare (307 stars); handle and npm taken |
| karat | Organization taken; one letter from karatelabs/karate (9010 stars) |
| plumb | Handle and npm taken; crowded by pdfplumber and plumbum |
| datum | Organization and npm taken; generic term |
| caliper | google/caliper (816 stars) and hyperledger-caliper (708 stars), both benchmarking tools |
| litmus | litmuschaos/litmus (5745 stars) |
| vouch | mitchellh/vouch (5195 stars) and vouch-proxy (3290 stars) |
| attest | actions/attest-build-provenance (1076 stars); organization taken |
| verity | Handle and npm taken; established term (dm-verity) |
| basalt | jesdga95/basalt (1824 stars), vkBasalt (1577 stars); organization taken |
| plinth | jabrena/plinth (465 stars); handle and npm taken |
| tarn | Vincit/tarn.js (521 stars); handle and npm taken |
| gauge | Handle and npm taken; generic charting term |
| fathom | usefathom/fathom analytics (8036 stars) |
| rigor | Organization taken; agent-research projects RigorPilot-Skills (490 stars) and "rigorous" (253 stars) |
| tenet | gaasedelen/tenet trace explorer (1549 stars); handle taken |
| skep | Handle and npm taken |
| exakt | Organization taken |
| prova | Handle and npm taken; everyday Italian and Portuguese word |
| vetra | Shreyas-29/vetra (163 stars); handle and npm taken |
| mesura | Handle taken; .dev and .com registered |
| veriq | Handle and npm taken |
| talyx | Handle and npm taken; TalyxTerminal exists |
| lodex | Inist-CNRS/lodex (68 stars); handle and npm taken |
| basanos | Organization taken; Jebel-Quant/basanos |
| obrussa | Organization taken; hard to spell |
| dubito | Handle taken |
| caveo | Handle and npm taken |
| probo | getprobo/probo (1540 stars); one letter from probot (9644 stars) |
| skeptiq | Handle taken; needs spelling out |
| vettle | Handle taken |
| docima | Handle taken |
| examen | Organization and npm taken; everyday Spanish and French word |
| scruta | Handle taken |
| basanite | Handle taken; same-name repository exists |
| aludel | Handle and npm taken |
| winnow | winnow-rs/winnow Rust parser library (986 stars) |
| muster | Handle and npm taken |
| garble | burrowers/garble Go obfuscator (5838 stars) |
| exacta | Handle and npm taken |
| cautio | Organization and npm taken |
| veridi | Handle taken; near "veridian" projects |
| assize | Handle taken |
| skeptik | Paradoxika/Skeptik proof tool; handle taken |
| cupella | wistrand/cupella, a coding-agent workspace for static analysis; npm taken |
| lydit | Handle taken; truncation of the disqualified "lydite" |
| mustr | Handle and npm taken |
| provar | Handle taken |
| galley | Organization and npm taken |
| pilcrow | pilcrowmd/pilcrow (87 stars); handle and npm taken |
| proviso | proviso/proviso (75 stars); organization and npm taken |
| caveat | Handle and npm taken |
| dele | Handle and npm taken |
| scholia | WDscholia/scholia (257 stars); handle and npm taken |
| emenda | Organization taken; Emenda is a software-analysis tools company (https://emenda.com/tools/) |
| obelo | Handle taken |
| stetto | Handle taken; derivative of the disqualified "stet" |
| emendo | Handle taken; derivative of the disqualified "emend" |
| galleo | Handle taken; near "galleon" |
| kaveat | Organization taken |
| pilcro | Handle taken |
| cupelo | All screening checks unclaimed, but a derivative of the disqualified "cupel" |
| trutin | Handle taken |
| assayr | All screening checks unclaimed, but a dropped-vowel derivative of the saturated "assay" |
| mustra | mustra-dev/mustra; handle taken |
| vernio | Handle taken |
| obelist | Organization taken |
| emendr | All screening checks unclaimed, but a derivative of the disqualified "emend" |
| stetted | All screening checks unclaimed, but awkward and a derivative of the disqualified "stet" |
| placet | Handle and npm taken |
| licet | Handle taken |
| licit | Organization and npm taken |
| mensor | matthewwardrop/mensor metrics tool (49 stars); handle taken |
| judex | Dharshan2208/judex (27 stars); handle and npm taken |
| probat | Handle taken |
| approbo | Handle taken |
| scrutor | khellang/Scrutor .NET library (4354 stars) |
| metior | koraktor/metior git statistics tool (84 stars); handle taken |
| ratum | Handle taken |
| letstand | Unclaimed, but a two-word phrase and weak as a brand |
| proofmark | Organization and npm taken |
| touchmark | Handle and npm taken; an agent project uses the name |
| wardstone | openSUSE/wardstone; handle and npm taken |
| placeta | Unclaimed, but no meaning and close to an unfortunate word |
| mensora | Organization taken |
| obruss | Handle taken |
| nullius | fkguo/nullius evidence harness for agent-assisted research; ThinkFlowLab/nullius AI agent evaluation framework |
| inverba | Inverba-Systems/inverba verification tool; handle taken |
| demur | Handle and npm taken; a Homebrew tap for a tool named demur exists |
| cavil | openSUSE/cavil (66 stars); GigleAI/cavil-loop coding agents (19 stars) |
| gainsay | Handle taken; salpenr/gainsay answer engine |
| elench | Handle taken; truncation of "elenchus" |
| elenchus | Kheil-Z/elenchus LLM workspace; Azure/elenchus; handle and npm taken |
| epoche | nolze/epoche wiki engine; handle and npm taken |
| zetetic | Zetetic .NET security tools; an agent-skills project uses the name; handle and npm taken |
| pyrrho | MarckMorris/pyrrho Terraform plan reviewer; handle taken |
| naysay | Handle taken; "naysayer" editor themes dominate |
| demurral | Handle unclaimed, but demurral.com registered and close to "demur" |
| zetesis | Lexi-cod/zetesis records AI coding-agent sessions; tsevis/Zetesis macOS search app; handle taken |

## Checks that could not be run

- USPTO Trademark Search, EUIPO eSearch plus and WIPO Global Brand Database: not checked: all three are JavaScript applications and returned no result data to a plain HTTP request.
- UK IPO: not checked: the one page requested (the journal entry for the "Cupel" application) returned HTTP 403 with a CAPTCHA security check, which was not attempted.
- Trademark web searches were not run for the names disqualified on other grounds (stet, assay, assayist, loupe, vernier, obelus); each file says so.
- Domain price and premium status: not checked: only visible at a registrar checkout, which was not started.
- A web search for every brainstormed name at screening: not run (see Method, step 2).
- Linguistic checks in other languages, pronunciation testing with real listeners, and social-media handle availability: not checked: outside the brief and not possible without accounts.

## What the owner should do next

1. Pick one or two names from the survivors (or ask for another round).
2. Check each domain at a registrar to see the real price and whether the name is premium or reserved. Do not rely on "appears unregistered".
3. Have counsel run a trademark search (USPTO, EUIPO, WIPO, UK IPO; Nice Classes 9 and 42; exact and similar marks) and advise on the neighbours named in each file (DUBIUS for dubitant, Lydite for lydstone, the Stet products for stetit).
4. Only then register the domain and create the GitHub organization yourself, and claim the npm, PyPI, crates.io and Homebrew names you intend to use.
5. Re-run the checks in the chosen file on the day you register; this research is a snapshot of 2026-11-22.
