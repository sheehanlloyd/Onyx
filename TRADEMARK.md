# Onyx trademark and branding policy

The Onyx **source code** is MIT licensed and you may do anything MIT permits
with it. The Onyx **name and logo** are not covered by that license, and this
file says what you may do with them.

This is the same split every open-source project of this shape uses: Mozilla's
code is free but you cannot ship your build as "Firefox"; VS Code's source is
MIT but the Microsoft-branded binary is not; Chromium is open but "Chrome" is
not. Onyx follows that model. The point is not to restrict the code — it is so
that a user who downloads something called "Onyx" gets the thing this repository
actually builds and tests.

## You may, without asking

- **Fork, modify, and redistribute the source**, commercially or otherwise, per MIT.
- **Say what your project is derived from** — "a fork of Onyx", "based on Onyx",
  "compatible with Onyx". Accurate, factual references to Onyx are always fine,
  and this policy never restricts nominative or descriptive use.
- **Build Onyx from source and run it yourself**, unmodified, under its own name.
- **Write about Onyx** — reviews, tutorials, comparisons, talks, screenshots,
  academic work. Criticism included; this policy is not a tool for suppressing it.
- **Use the name in package identifiers** where a fork-of relationship is the
  literal truth (`onyx-playbook-foo`, `awesome-onyx`).

## You may not, without written permission

- **Ship a modified build under the name "Onyx"** or a name confusingly similar
  to it. Change the product name in `product.json` before you distribute a fork.
- **Use the Onyx name or logo as your product's primary branding**, or in a way
  that suggests this project produced, endorses, sponsors, or supports your work.
- **Register "Onyx"**, a translation, or a confusingly similar mark as a
  trademark, company name, or domain for developer-tools or AI-coding products.
- **Use the logo modified**, recolored, or as a component of another logo.

## Rebranding a fork

Everything you need to change is in one file. Set `nameShort`, `nameLong`,
`applicationName`, `dataFolderName`, and `darwinBundleIdentifier` in
[`product.json`](product.json), and replace the icons in `resources/`. Onyx
deliberately keeps its own branding confined there rather than scattering it
through the source, so that rebranding a fork is a small, honest edit rather
than a hunt.

## Reporting misuse

Open an issue, or contact the maintainer through the address on the repository's
GitHub profile.

---

**This is a policy statement, not legal advice, and it was not drafted by a
lawyer.** It describes the maintainer's intent regarding the project's name and
branding. It does not itself establish a registered trademark, and registration
in any jurisdiction is a separate step the maintainer has not represented as
complete. If you need certainty for a commercial use, get your own counsel — and
in the meantime, ask; permission is usually a short conversation.
