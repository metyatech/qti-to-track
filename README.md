# qti-to-track

Converts a QTI XML package into Track API JSON payloads, and can publish them directly to Track LMS.

## What this tool does

`qti-to-track` reads a QTI 3.0 package directory (assessment XML plus item XML files), parses it, and produces structured Track draft JSON. It can also directly publish those questions, create a Track material from the resulting Track question IDs, and release the material.

**This repo does not parse Markdown.** The only Markdown parser/compiler in this pipeline is [`markdown-to-qti`](https://github.com/metyatech/markdown-to-qti). The expected workflow is:

```
Markdown    markdown-to-qti    QTI package    qti-to-track    Track payloads / Track LMS
```

`qti-to-track` takes over at the QTI package step. It knows nothing about Markdown.

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

Credentials can be provided by CLI options, environment variables, or a saved session file. Appspace resolution order is CLI `--appspace`, `TRACK_TCM_APPSPACE`, then `--session`. Credential resolution prefers CLI `--authorization` / `--cookie`, then `TRACK_TCM_AUTHORIZATION` / `TRACK_TCM_COOKIE`, then `--session`. The `--session` loader supports `weekly-quiz-workbench track-login` session files that store cookies in `cookieHeader`, as well as legacy `cookie` and nested credential fields.

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
| `--session <path>` | no | Saved Track session file from `weekly-quiz-workbench`; can supply base URL, appspace, `cookieHeader`/cookie, and authorization |
| `--yes` | no | Execute the publish. Without this, it performs a dry-run |
| `--track-map <path>` | no | Path to a `track-map.yaml` file to read/update |
| `--no-track-map` | no | Disable all track-map read/write. Cannot be combined with `--track-map` |
| `--material-title <title>` | no | Override QTI assessment title for the Track material |
| `--material-type <type>` | no | Track material type (default: `others`) |
| `--no-material` | no | Publish questions only; skip material creation and release |
| `--adopt-existing-by-title` | no | Adopt matching existing questions/materials by exact title and update them during real publish |
| `--check-existing` | no | Check exact-title duplicates and fail closed if any are found; also runs during dry-run and requires Track credentials |
| `--upload-images` | no | Upload local images to Track API and replace paths |
| `--base-url <url>` | no | Track base URL (default: https://tracks.dev) |
| `--json` | no | Print result as JSON |

Dry-run behavior: without `--yes`, QTI parsing and payload generation run without Track credentials. Credentials are required in dry-run only when an option needs the Track API, such as `--upload-images`, `--adopt-existing-by-title`, or `--check-existing`. `--check-existing` performs Track API duplicate lookups even in dry-run and fails closed on exact-title question or material duplicates. `--adopt-existing-by-title` is different: matching titles are treated as update targets instead of duplicates, and real publish updates those existing Track records. Real publish without `--adopt-existing-by-title` also fails closed on exact-title duplicates.

## Track-map compatibility

When `--track-map` is used, the publish command creates or updates a `track-map.yaml` mapping file compatible with `@metyatech/weekly-quiz-workbench`. It stores Track IDs, updated timestamps, and stable hashes of API payload JSON so duplicate questions can be tracked between executions. Dry-runs do not write the track-map. `--no-track-map` disables all track-map reads and writes. When `--no-material` is used, no material entry is written.

Example structure:
```yaml
version: 1
target:
  base_url: https://tracks.dev
  appspace: appspace-id
materials:
  qti/imsqti_test:
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

## Development

```sh
npm install
npm run build    # compile TypeScript
npm run test     # run tests with Vitest
npm run verify   # test + build
```
