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
- Emits an explicit **verdict** (`approve` / `request_changes`) and submits a
  real `APPROVE` / `REQUEST_CHANGES` review, so an automated merge gate can act
  on it. Only concrete blocking defects (bugs, security, regressions) block;
  design/style preferences stay non-blocking.
- **Converges across pushes.** Each re-review is fed the previous round's
  findings, so it stops re-raising resolved points or inventing a fresh nitpick
  every push — a good PR actually reaches `approve`.
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

# Cancel an in-progress review when a newer push arrives, so overlapping runs
# don't race to post reviews for stale commits.
concurrency:
  group: ai-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

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
| `max-output-tokens` | `16000` | Token budget for the model's review (reasoning + output). Raise if reviews truncate on large PRs. |
| `exclude` | `''` | Extra comma-separated globs to skip, e.g. `docs/**, **/*.sql`. |
| `extra-instructions` | `''` | Project-specific review rules appended to the prompt. |
| `request-changes-on` | `never` | Stricter override: force `REQUEST_CHANGES` when a finding of at least this severity exists (`critical`, `issue`), on top of the model's verdict. `never` leaves the verdict in charge. |
| `approve-when-clean` | `true` | Submit a real `APPROVE` review when the verdict is `approve`. Set `false` to only ever post comments (never auto-approve). |
| `skip-draft` | `true` | Skip draft PRs. |

## Outputs

| Output | Description |
|---|---|
| `comment-count` | Number of inline comments posted. |
| `review-url` | URL of the posted review. |
| `verdict` | Overall verdict: `approve` or `request_changes`. |
| `blocking-count` | Number of blocking (critical/issue) findings. |

## Verdict, auto-approve & convergence

The model returns an overall **verdict** alongside its comments, and the action
submits it as a real GitHub review:

- **`approve` → `APPROVE`** (when `approve-when-clean` is true, the default).
  The verdict is `approve` unless there is a concrete blocking defect in the
  diff — a bug/logic error, a security hole, a real regression, or data loss.
  Design, architecture and completeness *preferences* (“I’d paginate instead of
  capping”, “could be more thorough”) are `suggestion`/`nit` and never block.
- **`request_changes` → `REQUEST_CHANGES`**, reserved for those blocking defects.

**Convergence.** A PR is re-reviewed on every push. The action feeds the
previous round’s summary back into the prompt and instructs the model to treat
addressed points as resolved and not to invent new non-blocking nits — so an
iterating author (human or an automated coding agent) can actually reach
`approve` instead of chasing a moving target.

**Machine-readable marker.** The sticky summary comment carries a hidden line
for merge gates that don’t want to rely on GitHub’s review state:

```
<!-- review-verdict:approve reviewed-sha:<head-sha> blocking:0 -->
```

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
- **Repeated pushes don't stack up.** The summary lives in a single sticky PR
  comment that is edited in place on each push, and the previous run's inline
  comments are deleted before the new ones are posted — so a PR with ten pushes
  shows one current review, not ten. Inline threads a human has replied to are
  preserved.
- **Findings the model can't anchor** to a real diff line aren't dropped —
  they're listed in a collapsible section of the sticky summary comment.
- If posting inline comments fails (e.g. the branch moved mid-review), the
  action folds all findings into the sticky summary comment instead.

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
