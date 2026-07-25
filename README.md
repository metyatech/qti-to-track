# qti-to-track

Converts a QTI XML package into Track API JSON payloads, and can publish them directly to Track LMS.

## What this tool does

`qti-to-track` reads a QTI 3.0 package directory (assessment XML plus item XML files), parses it, and produces structured Track draft JSON. It can also directly publish those questions, create a Track material from the resulting Track question IDs, and release the material.

**This repo does not parse source Markdown.** The only Markdown parser/compiler in this pipeline is [`markdown-to-qti`](https://github.com/metyatech/markdown-to-qti). The expected workflow is:

```
Markdown    markdown-to-qti    QTI package    qti-to-track    Track payloads / Track LMS
```

`qti-to-track` takes over at the QTI package step. It serializes QTI presentation elements into rich text for Track, preserving headings, paragraphs, blockquotes, lists, code, emphasis, strikethrough, links, images, horizontal rules, and tables. Parsed QTI keeps headings as Markdown; Track payloads encode those headings with Track's supported `h1`-`h6` HTML elements because Track's API compiler reserves Markdown heading lines for its own question subsections. Table column alignment is derived from `text-align` styles. Inline QTI `br` elements in question bodies, choices, feedback, rubrics, and table cells are represented with `<br>`; ordinary XML formatting whitespace and newlines remain ordinary spaces. Table delimiters are escaped, and unsupported row or column spans fail explicitly instead of producing a corrupted table.

## Requirements

- Node.js 20+
- A QTI 3.0 package directory produced by `markdown-to-qti`

## Installation

```sh
npm install -g @metyatech/qti-to-track
```

Or run directly without installing:

```sh
npx @metyatech/qti-to-track <command> [options]
```

## Commands

### `inspect`

Parses the QTI package and prints the result. Useful for verifying the package was read correctly before generating payloads.

```sh
qti-to-track inspect --qti-dir ./my-qti-package
```

Print as JSON instead of the default `console.dir` output:

```sh
qti-to-track inspect --qti-dir ./my-qti-package --json
```

**Options**

| Flag | Required | Description |
|------|----------|-------------|
| `--qti-dir <dir>` | yes | Directory containing QTI XML files |
| `--json` | no | Print output as JSON (default: false) |

### `payload`

Generates Track draft JSON and writes it to a file.

```sh
qti-to-track payload --qti-dir ./my-qti-package --output ./out/payload.json
```

The output directory is created automatically if it doesn't exist. The output is not an API-ready material payload because Track material creation requires numeric Track question IDs returned after publishing questions. It contains `materialDraft.questionKeys` plus `questions`; `publish` converts that draft to an API `TrackMaterialPayload` with `questionIds: number[]`.

**Options**

| Flag | Required | Description |
|------|----------|-------------|
| `--qti-dir <dir>` | yes | Directory containing QTI XML files |
| `--output <file>` | yes | Output JSON file path |
| `--upload-images` | no | Upload local images to Track API and replace paths with remote URLs |
| `--material-type <type>` | no | Track material type (default: `others`) |
| `--appspace <id>` | no | Track appspace ID (required for `--upload-images`) |
| `--authorization <token>`| no | Track authorization header (optional) |
| `--cookie <cookie>`| no | Track cookie header (optional) |

### `publish`

Publishes the parsed QTI package directly to Track LMS. Creates questions, bundles them into a material, and releases the material unless `--no-material` is used.

#### Update identity is the track-map, not the title

When `--track-map` is used, re-publishing updates the **same Track records by ID**. Each question is keyed by its stable QTI item identifier (`qti/<identifier>`), and the material is keyed by the stable QTI assessment identifier (`qti/<assessment-identifier>`), so previously published questions and materials are updated through their stored Track IDs regardless of their display titles. A question or material that is not yet in the track-map is **created** as a new Track record; a plain publish never searches by title and never overwrites an unrelated Track record that happens to share a title.

If a mapped `track_question_id` (or `track_material_id`) no longer exists on Track (for example it was deleted in the Track UI), publish fails with an explicit error so a stale mapping cannot silently create or clobber the wrong record. Re-run with `--recreate-missing` to recreate those records and refresh the track-map.

Title-based matching is opt-in and only applies to questions/materials that are **not** in the track-map: `--adopt-existing-by-title` adopts and updates an existing same-title Track record (use it to bootstrap a track-map from records published before track-map support), and `--check-existing` fails closed when a same-title record already exists.

Every real `publish --yes` that creates or updates a material also creates a new Track release. This includes mapped material updates and title-adoption updates. Dry-runs and `--no-material` do not create materials or releases. If a Track Test already selects an older question version, open the test, go to the question list, choose the new version, review it, and confirm the update. A new release does not change an exam that has already been published for delivery.

Credentials can be provided by CLI options, environment variables, a saved session file, or a Track map target. **After `weekly-quiz-workbench track-login`, `qti-to-track publish` can use the default saved session without a manual `--session` flag.** Appspace and base URL resolution order is CLI flags, `TRACK_TCM_*` environment variables, the saved session, then `--track-map` `target`. Credential resolution prefers CLI `--authorization` / `--cookie`, then `TRACK_TCM_AUTHORIZATION` / `TRACK_TCM_COOKIE`, then the saved session. The session loader supports `weekly-quiz-workbench track-login` session files that store cookies in `cookieHeader`, as well as legacy `cookie` and nested credential fields.

When `--track-map` contains a `target`, qti-to-track fails before API use if CLI flags, environment variables, or the selected session point at a different appspace or base URL. This prevents accidentally publishing to a different Track appspace than the committed map records.

```sh
export TRACK_TCM_COOKIE="your_cookie_here"
export TRACK_TCM_APPSPACE="appspace-id"
qti-to-track publish --qti-dir ./my-qti-package --yes --track-map ./track-map.yaml
```

**Options**

| Flag | Required | Description |
|------|----------|-------------|
| `--qti-dir <dir>` | yes | Directory containing QTI XML files |
| `--appspace <id>` | no | Track appspace ID. Required for real publish unless supplied by `TRACK_TCM_APPSPACE` or `--session` |
| `--authorization <token>` | no | Track authorization header |
| `--cookie <cookie>` | no | Track cookie header |
| `--session <path>` | no | Saved Track session file from `weekly-quiz-workbench`; when omitted, the default Workbench session path is checked. Sessions can supply base URL, appspace, `cookieHeader`/cookie, and authorization |
| `--yes` | no | Execute the publish. Without this, it performs a dry-run |
| `--track-map <path>` | no | Path to a `track-map.yaml` file to read/update; its `target` supplies default base URL/appspace and guards against target mismatches |
| `--no-track-map` | no | Disable all track-map read/write. Cannot be combined with `--track-map` |
| `--material-title <title>` | no | Override QTI assessment title for the Track material |
| `--material-type <type>` | no | Track material type (default: `others`) |
| `--no-material` | no | Publish questions only; skip material creation and release |
| `--adopt-existing-by-title` | no | For track-map-unmapped items only: adopt a matching existing question/material by exact title and update it during real publish (bootstrap aid). Off by default |
| `--check-existing` | no | For track-map-unmapped items only: check exact-title duplicates and fail closed if any are found; also runs during dry-run and requires Track credentials |
| `--recreate-missing` | no | Recreate a Track question/material whose mapped track-map ID no longer exists on Track, instead of failing. Off by default |
| `--upload-images` | no | Upload local images to Track API and replace paths |
| `--base-url <url>` | no | Track base URL (default: https://tracks.dev) |
| `--json` | no | Print result as JSON |

Dry-run behavior: without `--yes`, QTI parsing and payload generation run without Track credentials. A plain dry-run reports, per question, whether it would update a track-map-mapped record by ID or create a new one. Credentials are required in dry-run only when an option needs the Track API, such as `--upload-images`, `--adopt-existing-by-title`, or `--check-existing`. `--check-existing` performs Track API title-duplicate lookups (for unmapped items) even in dry-run and fails closed on exact-title question or material duplicates. `--adopt-existing-by-title` instead treats a matching title as an update target for an unmapped item, and real publish updates that existing Track record. A plain real publish (no title flags) updates mapped items by ID and creates unmapped items; it performs no title lookup and never overwrites by title.

When `--upload-images` is used, qti-to-track reads each local image's original dimensions and sends them to the Track upload-signature API. If a local image's dimensions cannot be determined, publish fails instead of leaving a local path in Track content.

## Track-map compatibility

When `--track-map` is used, the publish command creates or updates a `track-map.yaml` mapping file compatible with `@metyatech/weekly-quiz-workbench`. It stores Track IDs, updated timestamps, and stable hashes of API payload JSON so duplicate questions and materials can be tracked between executions by stable source identifiers instead of mutable display titles. Dry-runs do not write the track-map. `--no-track-map` disables all track-map reads and writes. When `--no-material` is used, no material entry is written.

Older track maps may contain material entries keyed by title, such as `qti/Final Exam`. On the next successful publish, qti-to-track reads that legacy key as a fallback, updates the existing `track_material_id`, and rewrites the entry under the stable assessment key.

Example structure:
```yaml
version: 1
target:
  base_url: https://tracks.dev
  appspace: appspace-id
materials:
  qti/assessment_identifier:
    track_material_id: 123
    title: Final Exam
    question_keys:
      - qti/question_1
    source_hash: sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234
    updated_at: '2026-05-28T12:00:00.000Z'
    release_id: abc-123
questions:
  qti/question_1:
    track_question_id: 456
    title: Question 1
    source_hash: sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234
    updated_at: '2026-05-28T12:00:00.000Z'
```

## Output format

The generated `payload` JSON contains two top-level keys:

- `materialDraft` - a draft material object describing the assessment, including string `questionKeys`. This is not an API-ready `TrackMaterialPayload`
- `questions` - an array of `TrackQuestionPayload` objects, one per QTI item

During `publish`, created Track question IDs are used to build the API `TrackMaterialPayload` with `questionIds: number[]` and `materialTypes: string[]`.

`materialDraft.basicTimeMinutes` is derived from package-level QTI `timeLimits maxTime` when the
assessment, test part, or assessment section defines one. If the package has no package-level
time limit, it falls back to the existing behavior of summing item-level time limits and
rounding up to minutes.

Question kinds map as follows:

| QTI interaction type | Track `questionKind` |
|----------------------|----------------------|
| `choiceInteraction` | `1` (single choice) |
| `textEntryInteraction` | `2` (fill-in-the-blank) |
| `extendedTextInteraction` | `3` (free text) |

When an item contains `MAXSCORE` and a scorer rubric, qti-to-track appends the
scoring information to the bottom of the Track question content because Track
does not expose dedicated fields for per-question scoring criteria. The footer
uses a collapsed HTML details block:

```html
---

<details>
<summary><strong>採点基準（最大点: 3点）</strong></summary>

[2点] Mentions nucleus

[1点] Mentions cell

</details>
```

## Development

```sh
npm install
npm run build    # compile TypeScript
npm run test     # run tests with Vitest
npm run verify   # test + build
```
