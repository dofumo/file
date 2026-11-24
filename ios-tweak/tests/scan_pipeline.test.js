'use strict';
const assert = require('node:assert/strict');
const core = require('../scripts/scan_pipeline_core.js');

const label = /^\s*(?:câu(?:\s+hỏi)?|bài|question|q)\s*(?:số\s*)?[.#:]?\s*(\d{1,3})\s*(?:[.:)\-–—]|$|\s)/i;

// 43 numbered questions must all be detected, even with duplicate UI labels.
const lines = [];
for (let i = 1; i <= 43; i++) {
  lines.push(`Câu ${i}: Nội dung câu hỏi ${i}`);
  lines.push(`A. Phương án A của câu ${i}`);
  lines.push(`B. Phương án B của câu ${i}`);
}
lines.splice(30, 0, 'Câu 12: nhãn trùng do thành phần giao diện phụ');
const anchors = core.detectAnchors(lines, label);
assert.equal(anchors.length, 43, `expected 43 anchors, got ${anchors.length}`);

// Adaptive planner must account for every anchor exactly once and preserve order.
const chunks = core.planQuestionChunks(lines, anchors, { calcScore: () => 0 });
const planned = chunks.flatMap(c => c.expected);
assert.deepEqual(planned, anchors);
assert.equal(new Set(planned).size, 43);
assert.equal(chunks.length, 11, `43 short theory questions should use 11 adaptive requests; got ${chunks.length}`);
assert.ok(chunks.every(c => c.expected.length >= 1 && c.expected.length <= 4));


// Mixed complexity planning: a long calculation/image question must not share a
// large theory batch; every original question still appears once.
const mixedLines = [];
for (let i = 1; i <= 8; i++) {
  mixedLines.push(`Câu ${i}: ${i === 3 ? 'Tính toán ' + 'x'.repeat(5600) : i === 6 ? '[Hình 1] Bài toán có hình' : 'Lý thuyết ngắn ' + i}`);
  mixedLines.push(`A. Lựa chọn ${i}`);
}
const mixedAnchors = core.detectAnchors(mixedLines, label);
const mixedChunks = core.planQuestionChunks(mixedLines, mixedAnchors, {
  calcScore: text => /Tính toán/.test(text) ? 6 : 0
});
assert.deepEqual(mixedChunks.flatMap(x => x.expected), mixedAnchors);
assert.equal(mixedChunks.find(x => x.expected.includes(mixedAnchors[2])).expected.length, 1);
assert.ok(mixedChunks.find(x => x.expected.includes(mixedAnchors[5])).expected.length <= 2);

// Answers whose anchor points at text inside a question segment map to its heading.
const c = { start: 10, from: 10, end: 40, expected: [10, 22, 31] };
const normalized = core.normalizeAnswers([
  { anchor: 13, answer: 'A', explanation: 'first' },
  { anchor: 26, answer: 'B', explanation: 'second' },
  { anchor: 36, answer: 'C', explanation: 'third' },
  { anchor: 80, answer: 'D', explanation: 'out of range' }
], c);
assert.deepEqual(normalized.items.map(x => x.anchor), [10, 22, 31]);
assert.deepEqual(normalized.missing, []);
assert.equal(normalized.rejected, 1);

// A single-question repair may omit its anchor, but an explicit wrong or decimal
// anchor must not be silently attributed to that question.
const oneRepair = { start: 90, end: 100, expected: [90], ranges: [{ anchor: 90, start: 90, end: 100 }] };
assert.deepEqual(core.normalizeAnswers([{ answer: 'B', explanation: 'anchor omitted' }], oneRepair).items.map(x => x.anchor), [90]);
assert.deepEqual(core.normalizeAnswers([{ anchor: 900, answer: 'X' }], oneRepair).items, []);
assert.deepEqual(core.normalizeAnswers([{ anchor: 90.5, answer: 'X' }], oneRepair).items, []);

// Duplicate outputs cannot overwrite a different expected question or create false coverage.
const partial = core.normalizeAnswers([
  { anchor: 12, answer: 'A', explanation: 'one' },
  { anchor: 15, answer: 'C', explanation: 'duplicate inside first question' }
], { start: 10, end: 30, expected: [10, 20] });
assert.deepEqual(partial.items.map(x => x.anchor), [10]);
assert.deepEqual(partial.missing, [20]);

// Recovery groups may be non-contiguous when already-solved questions sit between them.
const disjoint = core.normalizeAnswers([
  { anchor: 15, answer: 'A', explanation: 'q1 segment' },
  { anchor: 25, answer: 'X', explanation: 'belongs to an already-solved middle question' },
  { anchor: 35, answer: 'C', explanation: 'q3 segment' }
], {
  start: 10, end: 40, expected: [10, 30],
  ranges: [{ anchor: 10, start: 10, end: 20 }, { anchor: 30, start: 30, end: 40 }]
});
assert.deepEqual(disjoint.items.map(x => x.anchor), [10, 30]);
assert.equal(disjoint.rejected, 1);

assert.deepEqual(core.groupAnchors([1,2,3,4,5], 2), [[1,2],[3,4],[5]]);
assert.deepEqual(core.missingAnchors([1,2,3], new Set([1,3])), [2]);

// Simulate a weak first pass that returns only half the requested answers.
// The global repair queue must identify exactly the remaining anchors.
const firstPassFound = new Set();
for (const chunk of chunks) {
  const weak = chunk.expected.filter((_, index) => index % 2 === 0)
    .map(anchor => ({ anchor, answer: 'A', explanation: 'first pass' }));
  const normalizedChunk = core.normalizeAnswers(weak, chunk);
  normalizedChunk.items.forEach(item => firstPassFound.add(item.anchor));
}
const missingForRepair = core.missingAnchors(anchors, firstPassFound);
assert.ok(missingForRepair.length > 0 && missingForRepair.length < 43);
const repaired = new Set([...firstPassFound, ...missingForRepair]);
assert.equal(core.missingAnchors(anchors, repaired).length, 0);
console.log(`scan_pipeline: PASS (${anchors.length} anchors, ${chunks.length} adaptive chunks)`);
