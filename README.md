# qti-to-track

Converts a QTI XML package into Track API JSON payloads.

## What this tool does

`qti-to-track` reads a directory of QTI XML files (a manifest plus item files), parses them, and produces structured JSON payloads ready for the Track API.

**This repo does not parse Markdown.** The only Markdown parser/compiler in this pipeline is [`markdown-to-qti`](https://github.com/metyatech/markdown-to-qti). The expected workflow is:

```
Markdown  →  markdown-to-qti  →  QTI package  →  qti-to-track  →  Track payloads
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

## Output format

The generated JSON contains two top-level keys:

- `material` - a `TrackMaterialPayload` object describing the assessment
- `questions` - an array of `TrackQuestionPayload` objects, one per QTI item

Question kinds map as follows:

| QTI interaction type | Track `questionKind` |
|----------------------|----------------------|
| `choiceInteraction` | `1` (single choice) |
| `textEntryInteraction` | `3` (fill-in-the-blank) |
| `extendedTextInteraction` | `4` (free text) |

## Out of scope

Publishing payloads to the Track API (i.e. making HTTP requests) is **not implemented in this phase**. The tool only generates the JSON files. Calling the API is a separate step handled outside this tool.

## Development

```sh
npm install
npm run build    # compile TypeScript
npm run test     # run tests with Vitest
npm run verify   # test + build
```
