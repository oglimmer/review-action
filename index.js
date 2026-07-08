'use strict';

const fs = require('fs');

// ---------------------------------------------------------------------------
// Small helpers (this action is dependency-free on purpose)
// ---------------------------------------------------------------------------

function getInput(name, fallback = '') {
  const v = process.env[`INPUT_${name.toUpperCase()}`];
  return v === undefined || v === '' ? fallback : v.trim();
}

// Like getInput but coerces to a positive integer, falling back to the default
// when the value is missing or not a sane number (so a typo can't silently
// disable comments or blow the diff budget).
function getIntInput(name, fallback) {
  const n = parseInt(getInput(name, String(fallback)), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delim = `ghadelim_${name.length}_${String(value).length}`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delim}\n${value}\n${delim}\n`);
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const DEFAULT_EXCLUDES = [
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/bun.lockb',
  '**/go.sum', '**/Cargo.lock', '**/composer.lock', '**/Gemfile.lock',
  '**/gradle.lockfile', '**/gradlew*', '**/mvnw*', '**/.mvn/**',
  '**/*.min.js', '**/*.min.css', '**/*.map',
  '**/dist/**', '**/build/**', '**/target/**', '**/vendor/**',
  '**/node_modules/**', '**/*.snap', '**/*.pb.go', '**/*_generated.go',
  '**/*.svg', '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.ico',
  '**/*.woff', '**/*.woff2', '**/*.ttf', '**/*.pdf',
];

function buildExcluder(extraCsv) {
  const patterns = DEFAULT_EXCLUDES.concat(
    extraCsv.split(',').map((p) => p.trim()).filter(Boolean)
  ).map(globToRegex);
  return (path) => patterns.some((re) => re.test(path));
}

// ---------------------------------------------------------------------------
// Networking (timeout + transient-failure retries)
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// fetch with a per-attempt timeout and bounded retries on transient failures:
// HTTP 429, any 5xx, and network/abort errors. Honours a Retry-After header when
// present, otherwise backs off exponentially with jitter. A single hiccup from
// GitHub or OpenAI no longer fails the whole review.
async function fetchWithRetry(url, options = {}, { retries = 3, timeoutMs = 60000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        console.warn(`::warning::${url} -> ${res.status}; retrying in ${wait}ms (attempt ${attempt + 1}/${retries}).`);
        await sleep(wait);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt >= retries) break;
      const wait = Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
      console.warn(`::warning::${url} request failed (${e.message}); retrying in ${wait}ms (attempt ${attempt + 1}/${retries}).`);
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error(`Request to ${url} failed after ${retries} retries.`);
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

function makeGithubClient(token) {
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  return async function gh(pathname, { method = 'GET', body } = {}) {
    const res = await fetchWithRetry(base + pathname, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'openai-pr-review-action',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`GitHub API ${method} ${pathname} -> ${res.status}: ${text.slice(0, 500)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  };
}

async function fetchChangedFiles(gh, repo, prNumber, maxFiles) {
  const files = [];
  for (let page = 1; files.length < maxFiles; page++) {
    const batch = await gh(`/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files.slice(0, maxFiles);
}

// Hidden markers let a later run recognise what a previous run posted, so
// repeated pushes update in place instead of stacking duplicates. Both render
// invisibly in the GitHub UI.
const REVIEW_MARKER = '<!-- openai-pr-review-action -->';
const COMMENT_MARKER = '<!-- openai-pr-review-comment -->';

async function fetchAllPages(gh, pathname) {
  const out = [];
  const sep = pathname.includes('?') ? '&' : '?';
  for (let page = 1; ; page++) {
    const batch = await gh(`${pathname}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// Picks the review comments a previous run left (they carry the marker) that are
// safe to remove — i.e. not the root of a thread a human has since replied to.
function commentsToDelete(comments, marker) {
  const humanReplyTargets = new Set();
  for (const c of comments) {
    if (c.in_reply_to_id != null && !(c.body || '').includes(marker)) {
      humanReplyTargets.add(c.in_reply_to_id);
    }
  }
  return comments
    .filter((c) => (c.body || '').includes(marker) && !humanReplyTargets.has(c.id))
    .map((c) => c.id);
}

async function deletePreviousComments(gh, repo, prNumber) {
  const comments = await fetchAllPages(gh, `/repos/${repo}/pulls/${prNumber}/comments`);
  const ids = commentsToDelete(comments, COMMENT_MARKER);
  for (const id of ids) {
    try {
      await gh(`/repos/${repo}/pulls/comments/${id}`, { method: 'DELETE' });
    } catch (e) {
      console.warn(`::warning::Could not delete stale review comment ${id}: ${e.message}`);
    }
  }
  return ids.length;
}

// Creates the summary as a PR conversation comment, or edits the existing one in
// place so there is only ever a single, current summary regardless of push count.
async function upsertSummaryComment(gh, repo, prNumber, body) {
  const existing = (await fetchAllPages(gh, `/repos/${repo}/issues/${prNumber}/comments`))
    .find((c) => (c.body || '').includes(REVIEW_MARKER));
  if (existing) {
    return gh(`/repos/${repo}/issues/comments/${existing.id}`, { method: 'PATCH', body: { body } });
  }
  return gh(`/repos/${repo}/issues/${prNumber}/comments`, { method: 'POST', body: { body } });
}

// ---------------------------------------------------------------------------
// Diff preparation
// ---------------------------------------------------------------------------

// Annotates a unified-diff patch with line numbers of the new (RIGHT) file
// version, and collects the set of line numbers a review comment may target.
function annotatePatch(patch) {
  const out = [];
  const rightLines = new Set();
  let newLine = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(raw);
      newLine = m ? parseInt(m[1], 10) : 0;
      out.push(raw);
    } else if (raw.startsWith('+')) {
      out.push(`+ ${String(newLine).padStart(5)} | ${raw.slice(1)}`);
      rightLines.add(newLine);
      newLine++;
    } else if (raw.startsWith('-')) {
      out.push(`-       | ${raw.slice(1)}`);
    } else if (raw.startsWith('\\')) {
      out.push(raw); // "\ No newline at end of file"
    } else {
      out.push(`  ${String(newLine).padStart(5)} | ${raw.startsWith(' ') ? raw.slice(1) : raw}`);
      rightLines.add(newLine);
      newLine++;
    }
  }
  return { text: out.join('\n'), rightLines };
}

const STACK_RULES = [
  {
    name: 'Vue / frontend',
    match: /\.(vue|ts|tsx|js|jsx|mjs|cjs|css|scss|html)$/,
    guidance: [
      'Vue: mutating props, missing/unstable `key` in v-for, watch where computed fits, reactivity losses (destructuring reactive objects), missing cleanup of listeners/intervals in unmount.',
      'XSS risks: v-html / innerHTML / unsanitized user input in templates or DOM APIs.',
      'TypeScript: unsafe casts (`as any`), swallowed promise rejections, missing await, race conditions in async handlers.',
      'State handling: direct store state mutation outside actions, stale closures over reactive values.',
    ],
  },
  {
    name: 'Java / Spring Boot',
    match: /\.(java|kt|kts)$|pom\.xml$|build\.gradle/,
    guidance: [
      'Spring: @Transactional on private/self-invoked methods (silently ignored), missing transaction boundaries around multi-step writes, field injection instead of constructor injection.',
      'JPA: N+1 query patterns, entities returned straight from controllers instead of DTOs, missing fetch strategy on collections used in loops.',
      'Correctness: nullability gaps (Optional misuse, unguarded .get()), equals/hashCode on entities, resource leaks (unclosed streams).',
      'Security: missing authorization checks on new endpoints, user input concatenated into queries, secrets/credentials in code or config.',
    ],
  },
  {
    name: 'Go',
    match: /\.go$|go\.mod$/,
    guidance: [
      'Go: ignored error returns, errors compared with == instead of errors.Is/As, missing %w when wrapping.',
      'Concurrency: goroutine leaks (missing context cancellation / unbounded goroutines), data races on shared maps/slices, misuse of sync primitives.',
      'Resources: defer inside loops holding files/connections open, missing Close on response bodies/rows.',
      'API/context: context.Context not propagated or stored in structs, ignoring ctx cancellation in long loops.',
    ],
  },
];

function detectStacks(paths) {
  return STACK_RULES.filter((s) => paths.some((p) => s.match.test(p)));
}

function buildPrompt({ pr, files, stacks, extraInstructions, maxComments }) {
  const stackSection = stacks.length
    ? stacks.map((s) => `${s.name}:\n${s.guidance.map((g) => `- ${g}`).join('\n')}`).join('\n\n')
    : 'No specific stack detected; apply general best practices.';

  const instructions = `You are a senior software engineer performing a pull request review.

Review ONLY the changed code shown in the diff. Report findings that materially matter:
- bugs and logic errors introduced by the change
- security vulnerabilities
- concurrency/resource problems
- realistic performance issues
- misleading naming or missing error handling where it will bite

Do NOT:
- comment on style that a formatter/linter would catch
- praise code or restate what the diff does
- invent issues in code you cannot see
- exceed ${maxComments} comments; if you find more, keep the most important ones

Severity levels: "critical" (must fix: bug/security), "issue" (should fix),
"suggestion" (worth considering), "nit" (minor). Use "nit" sparingly.

Each comment must target a line marked with "+" (preferred) or an unchanged
context line, using the line number printed in the diff (the new-file line
number). Write comment bodies in GitHub markdown, concise, with a concrete
suggested fix where possible.

Stack-specific things to watch for in this PR:

${stackSection}${extraInstructions ? `\n\nProject-specific instructions (from the repository owner):\n${extraInstructions}` : ''}`;

  const filesText = files
    .map((f) => `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.annotated}\n\`\`\``)
    .join('\n\n');

  const input = `Pull request #${pr.number}: ${pr.title}

${pr.body ? `PR description:\n${pr.body.slice(0, 2000)}\n\n` : ''}Diff (each line is prefixed with marker and new-file line number):

${filesText}

Return your review as JSON. "summary" is a short overall assessment in
markdown (2-6 sentences: what the PR does, overall quality, main risks).`;

  return { instructions, input };
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['critical', 'issue', 'suggestion', 'nit'] },
          body: { type: 'string' },
        },
        required: ['path', 'line', 'severity', 'body'],
      },
    },
  },
  required: ['summary', 'comments'],
};

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------

async function requestReview({ apiKey, model, reasoningEffort, maxOutputTokens, instructions, input }) {
  const res = await fetchWithRetry('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      reasoning: { effort: reasoningEffort },
      max_output_tokens: maxOutputTokens,
      text: {
        format: {
          type: 'json_schema',
          name: 'code_review',
          strict: true,
          schema: REVIEW_SCHEMA,
        },
      },
    }),
  }, { timeoutMs: 300000 });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${bodyText.slice(0, 1000)}`);
  }
  const data = JSON.parse(bodyText);
  const message = (data.output || []).find((o) => o.type === 'message');
  const textPart = message && (message.content || []).find((c) => c.type === 'output_text');
  if (!textPart) {
    // A hit output-token cap truncates the response before any parseable JSON is
    // produced. Surface an actionable error rather than a raw JSON.parse crash.
    if (data.status === 'incomplete') {
      throw new Error(
        `OpenAI response incomplete (${JSON.stringify(data.incomplete_details)}); ` +
        'raise max-output-tokens or narrow the diff (max-diff-chars / exclude).'
      );
    }
    throw new Error('OpenAI response contained no output text.');
  }
  if (data.status === 'incomplete') {
    console.warn(`::warning::OpenAI response incomplete: ${JSON.stringify(data.incomplete_details)}`);
  }
  return { review: JSON.parse(textPart.text), usage: data.usage };
}

// ---------------------------------------------------------------------------
// Review post-processing
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = { critical: 0, issue: 1, suggestion: 2, nit: 3 };
const SEVERITY_BADGE = {
  critical: '🔴 **critical**',
  issue: '🟠 **issue**',
  suggestion: '🔵 suggestion',
  nit: '⚪ nit',
};

function validateComments(comments, fileIndex, maxComments) {
  const valid = [];
  const dropped = [];
  const seen = new Set();
  for (const c of comments || []) {
    const file = fileIndex.get(c.path);
    const key = `${c.path}:${c.line}:${c.body.slice(0, 60)}`;
    if (!file || !file.rightLines.has(c.line)) {
      dropped.push(c);
    } else if (!seen.has(key)) {
      seen.add(key);
      valid.push(c);
    }
  }
  valid.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  return { valid: valid.slice(0, maxComments), dropped };
}

function buildReviewBody({ summary, model, dropped, skippedFiles, truncated }) {
  const parts = [
    REVIEW_MARKER,
    `## 🤖 AI Code Review`,
    '',
    summary,
  ];
  if (dropped.length) {
    parts.push('', '<details><summary>Findings that could not be anchored to a diff line</summary>', '');
    for (const c of dropped) {
      parts.push(`- ${SEVERITY_BADGE[c.severity] || c.severity} \`${c.path}:${c.line}\` — ${c.body}`);
    }
    parts.push('', '</details>');
  }
  const notes = [];
  if (skippedFiles.length) notes.push(`${skippedFiles.length} file(s) skipped (excluded/binary/too large)`);
  if (truncated) notes.push('diff truncated to fit the model budget');
  parts.push('', '---', `<sub>Model: \`${model}\`${notes.length ? ` · ${notes.join(' · ')}` : ''}</sub>`);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') {
    fail(`This action must run on pull_request or pull_request_target events (got: ${eventName}).`);
  }
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  if (!pr) fail('No pull_request found in the event payload.');

  if (getInput('skip-draft', 'true') === 'true' && pr.draft) {
    console.log('Draft PR — skipping review.');
    setOutput('comment-count', '0');
    return;
  }

  const apiKey = getInput('openai-api-key');
  if (!apiKey) fail('Input openai-api-key is required (set it from a secret).');
  const token = getInput('github-token') || process.env.GITHUB_TOKEN;
  if (!token) fail('No GitHub token available.');

  const model = getInput('model', 'gpt-5.5');
  const reasoningEffort = getInput('reasoning-effort', 'medium');
  const maxComments = getIntInput('max-comments', 15);
  const maxFiles = getIntInput('max-files', 50);
  const maxDiffChars = getIntInput('max-diff-chars', 120000);
  const maxOutputTokens = getIntInput('max-output-tokens', 16000);
  const requestChangesOn = getInput('request-changes-on', 'never');

  const repo = process.env.GITHUB_REPOSITORY;
  const gh = makeGithubClient(token);
  const excluded = buildExcluder(getInput('exclude'));

  console.log(`Reviewing ${repo}#${pr.number} with ${model} ...`);
  const rawFiles = await fetchChangedFiles(gh, repo, pr.number, maxFiles);

  const skippedFiles = [];
  const files = [];
  let budget = maxDiffChars;
  let truncated = false;
  for (const f of rawFiles) {
    if (f.status === 'removed' || !f.patch || excluded(f.filename)) {
      skippedFiles.push(f.filename);
      continue;
    }
    if (f.patch.length > budget) {
      truncated = true;
      skippedFiles.push(f.filename);
      continue;
    }
    budget -= f.patch.length;
    const { text, rightLines } = annotatePatch(f.patch);
    files.push({ filename: f.filename, status: f.status, annotated: text, rightLines });
  }

  if (!files.length) {
    console.log('No reviewable files in this PR — nothing to do.');
    setOutput('comment-count', '0');
    return;
  }
  console.log(`Files to review: ${files.length} (skipped: ${skippedFiles.length})`);

  const stacks = detectStacks(files.map((f) => f.filename));
  if (stacks.length) console.log(`Detected stacks: ${stacks.map((s) => s.name).join(', ')}`);

  const { instructions, input } = buildPrompt({
    pr,
    files,
    stacks,
    extraInstructions: getInput('extra-instructions'),
    maxComments,
  });

  const { review, usage } = await requestReview({ apiKey, model, reasoningEffort, maxOutputTokens, instructions, input });
  if (usage) console.log(`Token usage: ${usage.input_tokens} in / ${usage.output_tokens} out`);

  const fileIndex = new Map(files.map((f) => [f.filename, f]));
  const { valid, dropped } = validateComments(review.comments, fileIndex, maxComments);
  console.log(`Model returned ${(review.comments || []).length} comment(s); posting ${valid.length}, unanchored ${dropped.length}.`);

  const threshold = SEVERITY_ORDER[requestChangesOn];
  const reviewEvent =
    threshold !== undefined && valid.some((c) => SEVERITY_ORDER[c.severity] <= threshold)
      ? 'REQUEST_CHANGES'
      : 'COMMENT';

  const summaryBody = buildReviewBody({ summary: review.summary, model, dropped, skippedFiles, truncated });
  const inlineComments = valid.map((c) => ({
    path: c.path,
    line: c.line,
    side: 'RIGHT',
    body: `${SEVERITY_BADGE[c.severity]} ${c.body}\n\n${COMMENT_MARKER}`,
  }));

  // Every push triggers a fresh review. Remove the previous run's inline
  // comments first so identical findings don't pile up push after push; threads
  // a human has already replied to are left untouched.
  const removed = await deletePreviousComments(gh, repo, pr.number);
  if (removed) console.log(`Removed ${removed} stale inline comment(s) from a previous review.`);

  let reviewUrl = '';
  let summaryText = summaryBody;
  if (inlineComments.length || reviewEvent === 'REQUEST_CHANGES') {
    try {
      const posted = await gh(`/repos/${repo}/pulls/${pr.number}/reviews`, {
        method: 'POST',
        body: { commit_id: pr.head.sha, event: reviewEvent, body: REVIEW_MARKER, comments: inlineComments },
      });
      reviewUrl = posted.html_url || '';
    } catch (e) {
      // Inline comments can 422 if the diff shifted since we read it; fold the
      // findings into the sticky summary comment instead of losing them.
      console.warn(`::warning::Posting inline comments failed (${e.message}); folding findings into the summary.`);
      summaryText = `${summaryBody}\n\n### Findings\n${valid
        .map((c) => `- ${SEVERITY_BADGE[c.severity]} \`${c.path}:${c.line}\` — ${c.body}`)
        .join('\n')}`;
    }
  }

  // The summary lives in one sticky PR comment that is edited in place on every
  // push, so the conversation isn't flooded with a new summary per review.
  const summaryComment = await upsertSummaryComment(gh, repo, pr.number, summaryText);
  if (!reviewUrl) reviewUrl = summaryComment.html_url || '';

  setOutput('comment-count', String(inlineComments.length));
  setOutput('review-url', reviewUrl);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## AI Code Review\n${review.summary}\n\n${inlineComments.length} inline comment(s) posted → ${reviewUrl}\n`
    );
  }
  console.log(`Review posted: ${reviewUrl}`);
}

module.exports = { annotatePatch, globToRegex, buildExcluder, detectStacks, validateComments, commentsToDelete, getIntInput, fetchWithRetry, REVIEW_SCHEMA };

if (require.main === module) {
  main().catch((e) => fail(e.stack || String(e)));
}
