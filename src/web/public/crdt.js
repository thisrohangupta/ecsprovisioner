// Text CRDT (causal tree / RGA) for the browser editor.
// KEEP IN SYNC with src/core/crdt.ts (same algorithm; the server + tests use that copy).

const ROOT = "root";
const keyOf = (id) => (id ? `${id.c}:${id.s}` : ROOT);
const cmpId = (a, b) => (a.c !== b.c ? a.c - b.c : a.s - b.s);

export class CRDT {
  constructor(site) {
    this.site = site;
    this.clock = 0;
    this.root = { id: null, origin: null, ch: "", del: true, children: [] };
    this.byKey = new Map([[ROOT, this.root]]);
    this.pending = [];
    this.deleted = new Set();
  }

  value() {
    let out = "";
    const walk = (n) => { if (n.id && !n.del) out += n.ch; for (const c of n.children) walk(c); };
    for (const c of this.root.children) walk(c);
    return out;
  }

  _visible() {
    const out = [];
    const walk = (n) => { if (n.id && !n.del) out.push(n); for (const c of n.children) walk(c); };
    for (const c of this.root.children) walk(c);
    return out;
  }

  snapshot() {
    const out = [];
    const walk = (n) => { if (n.id) out.push({ id: n.id, origin: n.origin, ch: n.ch, del: n.del }); for (const c of n.children) walk(c); };
    for (const c of this.root.children) walk(c);
    return out;
  }

  loadSnapshot(nodes) {
    for (const n of nodes) this._rawInsert(n.id, n.origin, n.ch);
    this._drain();
    for (const n of nodes) if (n.del) this._applyDelete(n.id);
  }

  // Anchor for a caret at `index`: id of the visible char before it (null = doc start).
  anchorAt(index) {
    const vis = this._visible();
    if (index <= 0 || vis.length === 0) return null;
    return vis[Math.min(index, vis.length) - 1].id;
  }

  // Resolve an anchor to a caret index. Tombstoned anchors collapse to where
  // the char used to be; unknown anchors return -1.
  indexOfAnchor(anchor) {
    if (!anchor) return 0;
    if (!this.byKey.has(keyOf(anchor))) return -1;
    const target = keyOf(anchor);
    let count = 0;
    let found = -1;
    const walk = (n) => {
      if (found >= 0) return;
      if (n.id) {
        if (!n.del) count++;
        if (keyOf(n.id) === target) { found = count; return; }
      }
      for (const c of n.children) { walk(c); if (found >= 0) return; }
    };
    for (const c of this.root.children) { walk(c); if (found >= 0) break; }
    return found >= 0 ? found : -1;
  }

  localInsert(index, ch) {
    const vis = this._visible();
    const origin = index <= 0 ? null : vis[index - 1].id;
    const id = { c: ++this.clock, s: this.site };
    this._rawInsert(id, origin, ch);
    this._drain();
    return { t: "ins", id, origin, ch };
  }

  localDelete(index) {
    const vis = this._visible();
    const node = vis[index];
    if (!node || !node.id) return null;
    node.del = true;
    return { t: "del", id: node.id };
  }

  apply(op) {
    if (op.t === "del") { this._applyDelete(op.id); return; }
    this._rawInsert(op.id, op.origin, op.ch);
    this._drain();
  }
  applyMany(ops) { for (const op of ops) this.apply(op); }

  _applyDelete(id) {
    const k = keyOf(id);
    this.deleted.add(k);
    const n = this.byKey.get(k);
    if (n) n.del = true;
  }

  _rawInsert(id, origin, ch) {
    const key = keyOf(id);
    if (this.byKey.has(key)) return;
    const parent = this.byKey.get(keyOf(origin));
    if (!parent) { this.pending.push({ id, origin, ch }); return; }
    const node = { id, origin, ch, del: this.deleted.has(key), children: [] };
    let i = 0;
    while (i < parent.children.length && cmpId(parent.children[i].id, id) > 0) i++;
    parent.children.splice(i, 0, node);
    this.byKey.set(key, node);
    if (id.c > this.clock) this.clock = id.c;
  }

  _drain() {
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const p = this.pending[i];
        if (this.byKey.has(keyOf(p.origin))) {
          this.pending.splice(i, 1);
          this._rawInsert(p.id, p.origin, p.ch);
          progress = true;
        }
      }
    }
  }
}

// Derive insert/delete ops by comparing old text to new text (single-caret edits:
// one contiguous replaced region). Applies them to `doc` and returns the ops.
export function editsFromDiff(doc, oldText, newText) {
  let start = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (start < maxPrefix && oldText[start] === newText[start]) start++;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
    endOld--; endNew--;
  }
  const ops = [];
  // delete removed chars [start, endOld) — delete from the right to keep indices stable
  for (let i = endOld - 1; i >= start; i--) {
    const op = doc.localDelete(i);
    if (op) ops.push(op);
  }
  // insert added chars [start, endNew)
  for (let i = start; i < endNew; i++) {
    ops.push(doc.localInsert(i, newText[i]));
  }
  return ops;
}
