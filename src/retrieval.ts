import type { Bundle, Page } from "./procedures.js";

// Lexical retrieval over published pages (retrievalVersion "1"): CJK text is
// tokenized into character bigrams, latin/digit runs into lowercase words.
// Pure and deterministic so answers and evaluations share identical ranking.
export interface RetrievedPage {
  page: Page;
  score: number;
  truncated: boolean;
  content: string;
}
export function contextPage(page: Page, content: string) {
  return { id: page.id, title: page.title, path: page.path, content };
}
interface FieldIndex {
  counts: Map<string, number>;
  length: number;
}
interface PageIndex {
  title: FieldIndex;
  body: FieldIndex;
}
const indexCache = new WeakMap<Bundle, Map<Page, PageIndex>>();

function tokenize(text: string): string[] {
  const tokens: string[] = [],
    // \p{L} includes Han, so the non-Han run must subtract it: otherwise a
    // segment like "cap介绍" fuses into one token that matches no page.
    runs = text
      .toLowerCase()
      .match(/[\p{Script=Han}]+|[[\p{L}\p{N}]--\p{Script=Han}]+/gv) ?? [];
  for (const run of runs) {
    if (!/^\p{Script=Han}+$/u.test(run)) {
      tokens.push(run);
      continue;
    }
    if (run.length === 1) tokens.push(run);
    else
      for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}
function index(text: string): FieldIndex {
  const counts = new Map<string, number>();
  let length = 0;
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
    length++;
  }
  return { counts, length };
}
function pageIndexes(bundle: Bundle): Map<Page, PageIndex> {
  let indexes = indexCache.get(bundle);
  if (!indexes) {
    indexes = new Map(
      bundle.pages.map((page) => [
        page,
        { title: index(page.title), body: index(page.content) },
      ]),
    );
    indexCache.set(bundle, indexes);
  }
  return indexes;
}

export function retrieve(
  bundle: Bundle,
  question: string,
  options: { topK?: number; maxContextBytes?: number } = {},
): RetrievedPage[] {
  const topK = options.topK ?? 6,
    maxContextBytes = options.maxContextBytes ?? 60000;
  const indexes = pageIndexes(bundle),
    terms = [...new Set(tokenize(question))];
  if (!terms.length) return [];
  const documentFrequency = new Map<string, number>();
  for (const page of bundle.pages) {
    const fields = indexes.get(page)!;
    for (const term of terms)
      if (fields.title.counts.has(term) || fields.body.counts.has(term))
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const scored = bundle.pages
    .map((page, order) => {
      const fields = indexes.get(page)!;
      let score = 0;
      for (const term of terms) {
        const titleHits = fields.title.counts.get(term) ?? 0,
          bodyHits = fields.body.counts.get(term) ?? 0;
        if (!titleHits && !bodyHits) continue;
        const idf = Math.log(
          1 + bundle.pages.length / (1 + (documentFrequency.get(term) ?? 0)),
        );
        score +=
          idf *
          (3 * (titleHits / (fields.title.length || 1)) +
            bodyHits / (fields.body.length || 1));
      }
      return { page, score, order };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, topK);
  let budget = Math.max(0, maxContextBytes - 2); // JSON array brackets
  const result: RetrievedPage[] = [];
  for (const { page, score } of scored) {
    const available = budget - (result.length ? 1 : 0);
    const cost = (content: string) =>
      Buffer.byteLength(JSON.stringify(contextPage(page, content)), "utf8");
    if (cost("") >= available) continue;
    let content = page.content;
    if (cost(content) > available) {
      const points = Array.from(content);
      let low = 0,
        high = points.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (cost(points.slice(0, mid).join("")) <= available) low = mid;
        else high = mid - 1;
      }
      content = points.slice(0, low).join("");
    }
    if (!content) continue;
    budget -= cost(content) + (result.length ? 1 : 0);
    result.push({ page, score, content, truncated: content !== page.content });
  }
  return result;
}
