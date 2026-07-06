'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { annotatePatch, buildExcluder, detectStacks, validateComments, commentsToDelete } = require('../index.js');

const MARKER = '<!-- openai-pr-review-comment -->';

test('annotatePatch numbers added and context lines on the new side', () => {
  const patch = [
    '@@ -1,4 +1,5 @@',
    ' package main',
    '',
    '-func old() {}',
    '+func fresh() {}',
    '+func extra() {}',
    ' func main() {}',
  ].join('\n');

  const { text, rightLines } = annotatePatch(patch);

  // context line 1, blank context line 2, added lines 3+4, context line 5
  assert.deepStrictEqual([...rightLines].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.match(text, /\+ {5}3 \| func fresh\(\) \{\}/);
  assert.match(text, /\+ {5}4 \| func extra\(\) \{\}/);
  // removed lines get no right-side number
  assert.match(text, /- {7}\| func old\(\) \{\}/);
});

test('annotatePatch handles multiple hunks', () => {
  const patch = [
    '@@ -1,2 +1,2 @@',
    ' a',
    '+b',
    '@@ -10,2 +11,2 @@',
    ' x',
    '+y',
  ].join('\n');
  const { rightLines } = annotatePatch(patch);
  assert.deepStrictEqual([...rightLines].sort((a, b) => a - b), [1, 2, 11, 12]);
});

test('default excludes skip lockfiles, vendored and generated code', () => {
  const excluded = buildExcluder('');
  assert.ok(excluded('package-lock.json'));
  assert.ok(excluded('frontend/pnpm-lock.yaml'));
  assert.ok(excluded('go.sum'));
  assert.ok(excluded('backend/target/classes/App.class'));
  assert.ok(excluded('web/dist/app.min.js'));
  assert.ok(excluded('api/types_generated.go'));
  assert.ok(!excluded('src/main/java/App.java'));
  assert.ok(!excluded('main.go'));
  assert.ok(!excluded('src/components/Button.vue'));
});

test('user excludes are added on top of defaults', () => {
  const excluded = buildExcluder('docs/**, **/*.sql');
  assert.ok(excluded('docs/adr/001.md'));
  assert.ok(excluded('migrations/001_init.sql'));
  assert.ok(!excluded('src/app.ts'));
});

test('detectStacks finds vue, spring and go', () => {
  const stacks = detectStacks(['src/App.vue', 'src/main/java/A.java', 'cmd/api/main.go']);
  assert.deepStrictEqual(stacks.map((s) => s.name), ['Vue / frontend', 'Java / Spring Boot', 'Go']);
  assert.deepStrictEqual(detectStacks(['README.md']), []);
});

test('validateComments drops unanchored lines, dedupes, sorts by severity and caps', () => {
  const fileIndex = new Map([
    ['a.go', { rightLines: new Set([5, 6, 7]) }],
  ]);
  const comments = [
    { path: 'a.go', line: 6, severity: 'nit', body: 'minor' },
    { path: 'a.go', line: 5, severity: 'critical', body: 'boom' },
    { path: 'a.go', line: 5, severity: 'critical', body: 'boom' }, // duplicate
    { path: 'a.go', line: 99, severity: 'issue', body: 'off the diff' },
    { path: 'missing.go', line: 5, severity: 'issue', body: 'unknown file' },
    { path: 'a.go', line: 7, severity: 'issue', body: 'real' },
  ];
  const { valid, dropped } = validateComments(comments, fileIndex, 2);
  assert.deepStrictEqual(valid.map((c) => c.severity), ['critical', 'issue']);
  assert.strictEqual(dropped.length, 2);
});

test('commentsToDelete targets only our own comments, keeping human-answered threads', () => {
  const comments = [
    { id: 1, body: `finding A\n${MARKER}`, in_reply_to_id: null },       // ours, no replies -> delete
    { id: 2, body: `finding B\n${MARKER}`, in_reply_to_id: null },       // ours, but a human replied -> keep
    { id: 3, body: 'thanks, will fix', in_reply_to_id: 2 },              // human reply to #2
    { id: 4, body: 'a human review comment', in_reply_to_id: null },     // not ours -> never touch
    { id: 5, body: `finding C\n${MARKER}`, in_reply_to_id: 4 },          // ours, replying to a human -> delete
  ];
  assert.deepStrictEqual(commentsToDelete(comments, MARKER), [1, 5]);
});

test('commentsToDelete returns nothing when there are no prior bot comments', () => {
  assert.deepStrictEqual(commentsToDelete([{ id: 1, body: 'human', in_reply_to_id: null }], MARKER), []);
  assert.deepStrictEqual(commentsToDelete([], MARKER), []);
});
