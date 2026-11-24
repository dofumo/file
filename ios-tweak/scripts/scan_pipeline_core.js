/* Pure scan-planning helpers shared by the WKWebView port and Node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.__QTScanCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function detectAnchors(lines, labelRegex) {
    const candidates = [];
    for (let index = 0; index < (lines || []).length; index++) {
      const line = String(lines[index] || '').trim();
      if (!line || !labelRegex) continue;
      const match = line.match(labelRegex);
      if (!match) continue;
      const number = Number(match[1]);
      if (!Number.isInteger(number) || number < 1 || number > 500) continue;
      // Short, explicit question headings are preferred over long incidental text.
      const score = Math.max(0, 220 - Math.min(line.length, 220)) + (/^(câu|bài|question|q)\b/i.test(line) ? 20 : 0);
      candidates.push({ index, number, score });
    }
    if (candidates.length < 2) return [];

    // Longest increasing subsequence in DOM order. This rejects repeated headers,
    // page counters and duplicated labels without requiring every number to exist.
    const dp = new Array(candidates.length).fill(1);
    const previous = new Array(candidates.length).fill(-1);
    let best = 0;
    for (let i = 0; i < candidates.length; i++) {
      for (let j = 0; j < i; j++) {
        if (candidates[j].number < candidates[i].number && dp[j] + 1 > dp[i]) {
          dp[i] = dp[j] + 1;
          previous[i] = j;
        }
      }
      if (dp[i] > dp[best] || (dp[i] === dp[best] && candidates[i].score > candidates[best].score)) best = i;
    }

    const selected = [];
    for (let at = best; at >= 0; at = previous[at]) {
      selected.push(candidates[at].index);
      if (previous[at] < 0) break;
    }
    selected.reverse();
    return selected.length >= 2 ? selected : [];
  }

  function countImages(text) {
    const matches = String(text || '').match(/\[Hình\s+\d+/gi);
    return matches ? matches.length : 0;
  }

  function planQuestionChunks(lines, anchors, options) {
    const opts = options || {};
    const scoreCalc = typeof opts.calcScore === 'function' ? opts.calcScore : (() => 0);
    const maxTheoryChars = Number(opts.maxTheoryChars) || 11000;
    const maxComplexChars = Number(opts.maxComplexChars) || 7200;
    const maxImages = Number(opts.maxImages) || 8;
    const chunks = [];
    const profiles = (anchors || []).map((anchor, index) => {
      const end = anchors[index + 1] == null ? lines.length : anchors[index + 1];
      const text = lines.slice(anchor, end).join('\n');
      const images = countImages(text);
      const score = Number(scoreCalc(text)) || 0;
      const chars = text.length;
      const complex = images > 0 || score >= 3 || chars > 2200;
      return { anchor, end, text, images, score, chars, complex };
    });

    let i = 0;
    while (i < profiles.length) {
      const first = profiles[i];
      const widthFor = p => p.images > 1 || p.score >= 6 || p.chars > 5200 ? 1
        : p.complex ? 2
        : p.chars < 800 ? 4 : 3;
      let limit = widthFor(first);
      let j = i;
      let chars = 0;
      let images = 0;
      while (j < profiles.length) {
        const p = profiles[j];
        // The strictest member controls the whole batch. A long/formula-heavy
        // question can therefore never be hidden inside a large theory batch.
        limit = Math.min(limit, widthFor(p));
        const charLimit = p.complex ? maxComplexChars : maxTheoryChars;
        if (j - i >= limit) break;
        if (j > i && (chars + p.chars > charLimit || images + p.images > maxImages)) break;
        chars += p.chars;
        images += p.images;
        j++;
      }
      // Every iteration must consume at least one question, even for a very long item.
      if (j === i) j++;
      const selected = profiles.slice(i, j);
      const expected = selected.map(p => p.anchor);
      const ranges = selected.map(p => ({ anchor: p.anchor, start: p.anchor, end: p.end }));
      const start = expected[0];
      const end = j < profiles.length ? profiles[j].anchor : lines.length;
      chunks.push({ from: start, start, end, expected, ranges, chars, images, complex: selected.some(p => p.complex) });
      i = j;
    }
    return chunks;
  }

  function normalizeAnswers(rawAnswers, chunk) {
    const raw = Array.isArray(rawAnswers) ? rawAnswers : [];
    const expected = Array.isArray(chunk && chunk.expected) ? chunk.expected : [];
    const start = Number(chunk && chunk.start);
    const end = Number(chunk && chunk.end);
    const byAnchor = new Map();
    let rejected = 0;

    function targetFor(rawAnchor) {
      if (!Number.isInteger(rawAnchor)) return null;
      if (!expected.length) return rawAnchor >= start && rawAnchor < end ? rawAnchor : null;
      if (expected.includes(rawAnchor)) return rawAnchor;
      const ranges = Array.isArray(chunk && chunk.ranges) && chunk.ranges.length
        ? chunk.ranges
        : expected.map((a, i) => ({ anchor: a, start: a, end: i + 1 < expected.length ? expected[i + 1] : end }));
      for (const range of ranges) {
        if (rawAnchor >= Number(range.start) && rawAnchor < Number(range.end)) return Number(range.anchor);
      }
      // Tolerate a model choosing the immediately preceding heading line, but
      // never map a distant/out-of-chunk anchor to an unrelated question.
      if (rawAnchor >= start - 2 && rawAnchor < start) return expected[0];
      return null;
    }

    for (const item of raw) {
      if (!item || typeof item !== 'object' || item.answer == null || !String(item.answer).trim()) {
        rejected++;
        continue;
      }
      const hasExplicitAnchor = item.anchor !== undefined && item.anchor !== null && String(item.anchor).trim() !== '';
      const rawAnchor = hasExplicitAnchor ? Number(item.anchor) : NaN;
      let anchor = targetFor(rawAnchor);
      // For a one-question repair prompt only, an omitted anchor can be safely
      // attributed to that sole requested question. An explicit wrong/decimal
      // anchor is rejected rather than silently assigned to it.
      if (anchor == null && !hasExplicitAnchor && expected.length === 1) anchor = expected[0];
      if (anchor == null) {
        rejected++;
        continue;
      }
      const normalized = { ...item, anchor };
      const old = byAnchor.get(anchor);
      const completeness = q => String(q.explanation || '').length + String(q.answer_text || '').length + (Number(q.confidence) || 0) * 100;
      if (!old || completeness(normalized) > completeness(old)) byAnchor.set(anchor, normalized);
    }

    const items = [...byAnchor.values()].sort((a, b) => a.anchor - b.anchor);
    const missing = expected.filter(anchor => !byAnchor.has(anchor));
    return { items, missing, rejected, duplicates: Math.max(0, raw.length - items.length - rejected) };
  }

  function groupAnchors(anchors, size) {
    const width = Math.max(1, Math.min(8, Number(size) || 1));
    const groups = [];
    for (let i = 0; i < (anchors || []).length; i += width) groups.push(anchors.slice(i, i + width));
    return groups;
  }

  function missingAnchors(expected, found) {
    const set = found instanceof Set ? found : new Set(found || []);
    return (expected || []).filter(anchor => !set.has(anchor));
  }

  return { detectAnchors, planQuestionChunks, normalizeAnswers, groupAnchors, missingAnchors };
});
