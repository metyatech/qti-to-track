# qti-to-track

Converts a QTI XML package into Track API JSON payloads, and can publish them directly to Track LMS.

## What this tool does

`qti-to-track` reads a directory of QTI XML files (a manifest plus item files), parses them, and produces structured JSON payloads ready for the Track API. It can also directly push these payloads to Track LMS.

**This repo does not parse Markdown.** The only Markdown parser/compiler in this pipeline is [`markdown-to-qti`](https://github.com/metyatech/markdown-to-qti). The expected workflow is:

```
Markdown    markdown-to-qti    QTI package    qti-to-track    Track payloads / Track LMS
```

`qti-to-track` takes over at the QTI package step. It knows nothing about Markdown.

## Requirements

- Node.js 20+
- A QTI package directory produced by `markdown-to-qti` (or any conformant QTI 2.x output)

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

Generates Track API JSON payloads and writes them to a file.

```sh
qti-to-track payload --qti-dir ./my-qti-package --output ./out/payload.json
```

The output directory is created automatically if it doesn't exist.

**Options**

| Flag | Required | Description |
|------|----------|-------------|
| `--qti-dir <dir>` | yes | Directory containing QTI XML files |
| `--output <file>` | yes | Output JSON file path |
| `--upload-images` | no | Upload local images to Track API and replace paths with remote URLs |
| `--appspace <id>` | no | Track appspace ID (required for `--upload-images`) |
| `--authorization <token>`| no | Track authorization header (optional) |
| `--cookie <cookie>`| no | Track cookie header (optional) |

### `publish`

Publishes the parsed QTI package directly to Track LMS. Creates questions, bundles them into a material, and releases the material. 

*Credentials must be provided via `TRACK_TCM_COOKIE` or `TRACK_TCM_AUTHORIZATION` environment variables.*

```sh
export TRACK_TCM_COOKIE="your_cookie_here"
qti-to-track publish --qti-dir ./my-qti-package --appspace appspace-id --yes --track-map ./track-map.yaml
```

**Options**

| Flag | Required | Description |
|------|----------|-------------|
| `--qti-dir <dir>` | yes | Directory containing QTI XML files |
| `--appspace <id>` | yes | Track appspace ID |
| `--yes` | no | Execute the publish. Without this, it performs a dry-run |
| `--track-map <path>` | no | Path to a `track-map.yaml` file to read/update |
| `--adopt-existing-by-title` | no | Update existing questions/materials if titles match |
| `--upload-images` | no | Upload local images to Track API and replace paths |
| `--base-url <url>` | no | Track base URL (default: https://tracks.dev) |
| `--json` | no | Print result as JSON |

## Track-map compatibility

When `--track-map` is used, the publish command creates or updates a `track-map.yaml` mapping file compatible with `@metyatech/weekly-quiz-workbench`. It stores Track IDs, updated timestamps, and hashed source payloads so duplicate questions can be tracked between executions. 

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

The generated JSON contains two top-level keys:

- `material` - a `TrackMaterialPayload` object describing the assessment
- `questions` - an array of `TrackQuestionPayload` objects, one per QTI item

Question kinds map as follows:

| QTI interaction type | Track `questionKind` |
|----------------------|----------------------|
| `choiceInteraction` | `1` (single choice) |
| `textEntryInteraction` | `2` (fill-in-the-blank) |
| `extendedTextInteraction` | `4` (free text) |

## Development

```sh
npm install
npm run build    # compile TypeScript
npm run test     # run tests with Vitest
npm run verify   # test + build
```