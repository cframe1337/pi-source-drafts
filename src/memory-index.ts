import { type JournalOp, type SaveOp, type DraftMeta, type SectionEntry, type SnapshotData } from "./journal.ts";

export interface SearchResult {
  entry: DraftMeta;
  id: string;
  score: number;
  excerpt: string;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  tags?: string[];
  sourceType?: string;
  currentProject?: string;
  currentSession?: string;
}

interface WordEntry {
  docId: string;
  count: number;
  inTitle: boolean;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "by", "with", "from", "as", "is", "was", "be", "are", "were",
  "has", "have", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "not", "no", "nor",
  "this", "that", "these", "those", "it", "its", "they", "them",
  "we", "you", "he", "she", "his", "her", "my", "your", "our",
  "about", "into", "over", "after", "before", "between", "under",
  "again", "further", "then", "once", "here", "there", "all",
  "each", "every", "both", "few", "some", "any", "much", "more",
  "most", "other", "such", "only", "own", "same", "so", "than",
  "too", "very", "just", "because", "if", "while", "where",
  "how", "what", "when", "why", "which", "who", "whom",
]);

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = lower.match(/[a-z0-9а-яё]+/gi);
  if (!tokens) return [];
  return tokens.filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

function docIdFromOp(op: SaveOp): string {
  if (op.id) return op.id;
  const slug = op.meta.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `${op.meta.sourceType}-${slug || "draft"}`;
}

export class MemoryIndex {
  private words = new Map<string, WordEntry[]>();
  private docs = new Map<string, DraftMeta>();
  private sections = new Map<string, SectionEntry[]>();
  private tagIndex = new Map<string, string[]>();
  private stIndex = new Map<string, string[]>();
  private df = new Map<string, number>();
  private hashes = new Map<string, string>();
  private _totalDocs = 0;

  get totalDocs(): number {
    return this._totalDocs;
  }

  get snapshotDocs(): Array<{ id: string; meta: DraftMeta; sections: SectionEntry[] }> {
    const result: Array<{ id: string; meta: DraftMeta; sections: SectionEntry[] }> = [];
    for (const [id, meta] of this.docs) {
      result.push({ id, meta, sections: this.sections.get(id) || [] });
    }
    return result;
  }

  findByHash(hash: string): string | undefined {
    return this.hashes.get(hash);
  }

  get snapshotWords(): Array<{ term: string; postings: Array<{ docId: string; count: number; inTitle: boolean }> }> {
    const result: Array<{ term: string; postings: Array<{ docId: string; count: number; inTitle: boolean }> }> = [];
    for (const [term, postings] of this.words) {
      result.push({ term, postings });
    }
    return result;
  }

  get snapshotHashes(): Array<{ hash: string; docId: string }> {
    const result: Array<{ hash: string; docId: string }> = [];
    for (const [hash, docId] of this.hashes) {
      result.push({ hash, docId });
    }
    return result;
  }

  hasDoc(id: string): boolean {
    return this.docs.has(id);
  }

  getMeta(id: string): DraftMeta | undefined {
    return this.docs.get(id);
  }

  getSections(id: string): SectionEntry[] {
    return this.sections.get(id) || [];
  }

  getAllDocs(): string[] {
    return Array.from(this.docs.keys());
  }

  countBySourceType(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [st, ids] of this.stIndex) {
      counts[st] = ids.length;
    }
    return counts;
  }

  apply(op: JournalOp): void {
    switch (op.op) {
      case "save": {
        this._removeDoc(op.id);
        this._indexMeta(op.id, op.meta);
        this._indexContent(op.id, op.content, op.meta.title);
        if (op.sections) this.sections.set(op.id, op.sections);
        if (op.hash) this.hashes.set(op.hash, op.id);
        break;
      }
      case "delete":
        this._removeDoc(op.id);
        break;
      case "update": {
        const existing = this.docs.get(op.id);
        if (existing) {
          const updated = { ...existing, ...op.meta };
          this.docs.set(op.id, updated);
          if (op.meta.tags) this._indexTags(op.id, op.meta.tags);
        }
        break;
      }
    }
  }

  private _removeDoc(id: string): void {
    const meta = this.docs.get(id);
    if (!meta) return;

    this._removeFromIndex(this.tagIndex, id, meta.tags);
    this._removeFromIndex(this.stIndex, id, [meta.sourceType]);

    // remove from hashes map
    for (const [hash, docId] of this.hashes) {
      if (docId === id) { this.hashes.delete(hash); break; }
    }

    for (const [term, postings] of this.words) {
      const filtered = postings.filter(p => p.docId !== id);
      if (filtered.length === 0) {
        this.words.delete(term);
        this.df.delete(term);
      } else {
        this.words.set(term, filtered);
      }
    }

    this.docs.delete(id);
    this.sections.delete(id);
    this._totalDocs = this.docs.size;
  }

  private _removeFromIndex(map: Map<string, string[]>, id: string, keys: string[]): void {
    for (const key of keys) {
      const arr = map.get(key);
      if (!arr) continue;
      const idx = arr.indexOf(id);
      if (idx !== -1) {
        arr.splice(idx, 1);
        if (arr.length === 0) map.delete(key);
      }
    }
  }

  private _indexMeta(id: string, meta: DraftMeta): void {
    this.docs.set(id, meta);
    this._totalDocs = this.docs.size;
    this._indexTags(id, meta.tags);

    if (!this.stIndex.has(meta.sourceType)) this.stIndex.set(meta.sourceType, []);
    this.stIndex.get(meta.sourceType)!.push(id);
  }

  private _indexTags(id: string, tags: string[]): void {
    for (const tag of tags) {
      if (!this.tagIndex.has(tag)) this.tagIndex.set(tag, []);
      const arr = this.tagIndex.get(tag)!;
      if (!arr.includes(id)) arr.push(id);
    }
  }

  private _indexContent(id: string, content: string, title: string): void {
    const titleTokens = tokenize(title);
    const bodyTokens = tokenize(content);

    const localDf = new Map<string, Set<string>>();

    const termCounts = new Map<string, { count: number; inTitle: boolean }>();
    for (const t of titleTokens) {
      const entry = termCounts.get(t) || { count: 0, inTitle: false };
      entry.count++;
      entry.inTitle = true;
      termCounts.set(t, entry);
      if (!localDf.has(t)) localDf.set(t, new Set());
      localDf.get(t)!.add(id);
    }
    for (const t of bodyTokens) {
      const entry = termCounts.get(t) || { count: 0, inTitle: false };
      entry.count++;
      termCounts.set(t, entry);
      if (!localDf.has(t)) localDf.set(t, new Set());
      localDf.get(t)!.add(id);
    }

    for (const [term, entry] of termCounts) {
      if (!this.words.has(term)) this.words.set(term, []);
      this.words.get(term)!.push({ docId: id, count: entry.count, inTitle: entry.inTitle });
    }

    for (const [term, docSet] of localDf) {
      this.df.set(term, (this.df.get(term) || 0) + 1);
    }
  }

  search(query: string, options?: SearchOptions): SearchResult[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    const scores = new Map<string, number>();

    for (const token of tokens) {
      const postings = this.words.get(token);
      if (!postings) continue;

      const df = this.df.get(token) || 1;
      const idf = Math.log(1 + (this._totalDocs - df + 0.5) / (df + 0.5));

      for (const entry of postings) {
        const tf = (entry.inTitle ? 2 : 1) * Math.log(1 + entry.count);
        const current = scores.get(entry.docId) || 0;
        scores.set(entry.docId, current + tf * idf);
      }
    }

    let results: SearchResult[] = [];
    for (const [docId, score] of scores) {
      const meta = this.docs.get(docId);
      if (!meta) continue;

      if (options?.tags && !options.tags.some(t => meta.tags.includes(t))) continue;
      if (options?.sourceType && meta.sourceType !== options.sourceType) continue;

      let finalScore = score;
      if (options?.currentProject && meta.projectDir === options.currentProject) finalScore += 5;
      if (options?.currentSession && meta.sessionId === options.currentSession) finalScore += 10;

      const excerpt = this._getExcerpt(docId, query);

      results.push({ entry: meta, id: docId, score: finalScore, excerpt });
    }

    results.sort((a, b) => b.score - a.score);
    const offset = options?.offset || 0;
    const limit = options?.limit || 20;
    return results.slice(offset, offset + limit);
  }

  private _getExcerpt(docId: string, query: string): string {
    const sections = this.sections.get(docId);
    if (sections && sections.length > 0) {
      for (const sec of sections) {
        if (sec.body.toLowerCase().includes(query.toLowerCase())) {
          return sec.body.slice(0, 200);
        }
      }
    }
    const meta = this.docs.get(docId);
    if (meta) return meta.title;
    return "";
  }

  hydrate(data: SnapshotData): void {
    this.words.clear();
    this.docs.clear();
    this.sections.clear();
    this.tagIndex.clear();
    this.stIndex.clear();
    this.df.clear();
    this.hashes.clear();

    for (const doc of data.docs) {
      this.docs.set(doc.id, doc.meta);
      if (doc.sections) this.sections.set(doc.id, doc.sections);
      this._indexTags(doc.id, doc.meta.tags);
      if (!this.stIndex.has(doc.meta.sourceType)) this.stIndex.set(doc.meta.sourceType, []);
      this.stIndex.get(doc.meta.sourceType)!.push(doc.id);
    }

    this._totalDocs = data.docs.length;

    if (data.hashes) {
      for (const h of data.hashes) this.hashes.set(h.hash, h.docId);
    }

    for (const w of data.words) {
      this.words.set(w.term, w.postings);
      this.df.set(w.term, w.postings.length);
    }
  }

  rebuildFromOps(ops: JournalOp[]): void {
    this.words.clear();
    this.docs.clear();
    this.sections.clear();
    this.tagIndex.clear();
    this.stIndex.clear();
    this.df.clear();
    this.hashes.clear();
    this._totalDocs = 0;

    for (const op of ops) {
      this.apply(op);
    }
  }
}
