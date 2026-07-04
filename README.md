# AI PR Review Action (OpenAI / Codex)

A GitHub Action that reviews pull requests with an OpenAI coding model
(Codex lineage) and posts a review with **inline comments** and a **summary**
— tuned out of the box for **Vue**, **Java Spring Boot** and **Go** projects.

- Zero dependencies, no build step — a single Node 20 script.
- Reads the diff via the GitHub API (no checkout needed).
- Detects the stack from the changed files and adds stack-specific review
  guidance (Vue reactivity/XSS, Spring transactions/JPA/N+1, Go errors/
  goroutine leaks, ...).
- Uses the OpenAI Responses API with strict JSON-schema output, then
  validates every comment against real diff lines before posting — no
  comments on lines that don't exist.
- Skips lockfiles, `dist/`, `target/`, `vendor/`, generated code, binaries.

## Usage

Add `.github/workflows/ai-review.yml` to your project (same file for Vue,
Spring Boot or Go — the action figures out the stack):

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: oglimmer/review-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

Then add your OpenAI API key as a repository (or organization) secret named
`OPENAI_API_KEY`.

## Inputs

| Input | Default | Description |
|---|---|---|
| `openai-api-key` | — (required) | OpenAI API key. |
| `github-token` | `${{ github.token }}` | Token used to read the PR and post the review. |
| `model` | `gpt-5.5` | Any Responses-API coding model, e.g. `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.1-codex`. |
| `reasoning-effort` | `medium` | `low`, `medium` or `high`. |
| `max-comments` | `15` | Cap on inline comments (most severe first). |
| `max-files` | `50` | Cap on changed files reviewed. |
| `max-diff-chars` | `120000` | Character budget for the diff sent to the model. |
| `exclude` | `''` | Extra comma-separated globs to skip, e.g. `docs/**, **/*.sql`. |
| `extra-instructions` | `''` | Project-specific review rules appended to the prompt. |
| `request-changes-on` | `never` | Submit as `REQUEST_CHANGES` when a finding of at least this severity exists: `critical`, `issue`, or `never`. |
| `skip-draft` | `true` | Skip draft PRs. |

## Outputs

| Output | Description |
|---|---|
| `comment-count` | Number of inline comments posted. |
| `review-url` | URL of the posted review. |

## Per-project tuning examples

**Spring Boot** — enforce your architecture rules:

```yaml
      - uses: oglimmer/review-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          request-changes-on: critical
          extra-instructions: |
            Controllers must not use entities directly, only DTOs.
            All new endpoints need @PreAuthorize.
            Flag any new dependency added to pom.xml.
```

**Vue** — skip generated API client, stricter frontend rules:

```yaml
      - uses: oglimmer/review-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          exclude: 'src/api/generated/**'
          extra-instructions: |
            We use <script setup> with the Composition API exclusively.
            Flag any use of the Options API in new code.
```

**Go** — cheaper model for a high-traffic repo:

```yaml
      - uses: oglimmer/review-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          model: gpt-5.4-mini
          reasoning-effort: low
          max-comments: '8'
```

## Notes

- **Forks:** on `pull_request` from a fork, secrets are unavailable, so the
  review is skipped/fails. That's the safe default. Avoid switching to
  `pull_request_target` unless you understand the security implications
  (it exposes secrets to workflows triggered by untrusted PRs).
- **Cost:** one API call per PR update; the diff is capped at
  `max-diff-chars` (~30k tokens by default). Use a smaller model and
  `reasoning-effort: low` for busy repos.
- **Findings the model can't anchor** to a real diff line aren't dropped —
  they're listed in a collapsible section of the review summary.
- If posting inline comments fails (e.g. the branch moved mid-review), the
  action falls back to a summary-only review containing all findings.

## Development

```sh
node --test test/unit.test.js
```

## Releasing

Tag releases so consumers can pin a major:

```sh
git tag v1.0.0
git tag -f v1
git push origin v1.0.0 --force --tags
```
