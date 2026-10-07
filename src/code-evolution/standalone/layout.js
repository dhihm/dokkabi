// Stable slot-based layout. Every module, file and symbol keeps the slot it was
// first given for as long as it exists; new entities take the lowest free slot.
// Nothing is ever compacted, so an edit never moves unrelated nodes on screen.

export const GEOMETRY = Object.freeze({
  MODULE_W: 280,
  MODULE_GAP: 48,
  HEADER: 64,
  FILE_W: 240,
  FILE_H: 176,
  FILE_GAP: 20,
  FILE_INSET: 20,
  CHIP_W: 106,
  CHIP_H: 15,
  CHIP_GAP_X: 8,
  CHIP_GAP_Y: 2,
  CHIP_TOP: 50,
  CHIP_INSET: 10,
  MAX_CHIPS: 14,
});

function lowestFree(used) {
  let i = 0;
  while (used.has(i)) i++;
  return i;
}

export class LayoutManager {
  constructor(state = {}) {
    this.modules = { ...(state.modules || {}) };
    this.files = { ...(state.files || {}) };
    this.symbols = {};
    for (const [k, v] of Object.entries(state.symbols || {})) this.symbols[k] = { ...v };
  }

  toJSON() {
    return { modules: this.modules, files: this.files, symbols: this.symbols };
  }

  /**
   * @param {Array<{id:string}>} modules
   * @param {Array<{id:string,parent:string,path:string}>} files  file-like nodes (files + externals)
   * @param {Map<string, Array<{id:string,line:number}>>} symbolsByFile
   * @returns {Map<string,{x:number,y:number,w:number,h:number,hidden?:boolean}>}
   */
  apply(modules, files, symbolsByFile) {
    const G = GEOMETRY;
    const boxes = new Map();

    // Modules -> columns.
    const moduleIds = new Set(modules.map((m) => m.id));
    for (const id of Object.keys(this.modules)) if (!moduleIds.has(id)) delete this.modules[id];
    const usedCols = new Set(Object.values(this.modules));
    for (const m of [...modules].sort((a, b) => a.id.localeCompare(b.id))) {
      if (this.modules[m.id] === undefined) {
        const col = lowestFree(usedCols);
        this.modules[m.id] = col;
        usedCols.add(col);
      }
    }

    // Files -> slots within their module column.
    const fileIds = new Set(files.map((f) => f.id));
    for (const id of Object.keys(this.files)) if (!fileIds.has(id)) delete this.files[id];
    const usedSlots = new Map();
    const pending = [];
    for (const f of files) {
      const entry = this.files[f.id];
      if (entry && entry.module === f.parent) {
        if (!usedSlots.has(f.parent)) usedSlots.set(f.parent, new Set());
        usedSlots.get(f.parent).add(entry.slot);
      } else pending.push(f);
    }
    pending.sort((a, b) => a.path.localeCompare(b.path));
    for (const f of pending) {
      if (!usedSlots.has(f.parent)) usedSlots.set(f.parent, new Set());
      const used = usedSlots.get(f.parent);
      const slot = lowestFree(used);
      used.add(slot);
      this.files[f.id] = { module: f.parent, slot };
    }

    // Symbols -> chip slots within their file card.
    for (const id of Object.keys(this.symbols)) if (!fileIds.has(id)) delete this.symbols[id];
    for (const [fileId, syms] of symbolsByFile) {
      const map = this.symbols[fileId] || (this.symbols[fileId] = {});
      const present = new Set(syms.map((s) => s.id));
      for (const id of Object.keys(map)) if (!present.has(id)) delete map[id];
      const used = new Set(Object.values(map));
      for (const s of [...syms].sort((a, b) => a.line - b.line || a.id.localeCompare(b.id))) {
        if (map[s.id] === undefined) {
          const slot = lowestFree(used);
          used.add(slot);
          map[s.id] = slot;
        }
      }
    }

    // Geometry.
    const maxSlot = new Map();
    for (const { module, slot } of Object.values(this.files)) {
      maxSlot.set(module, Math.max(maxSlot.get(module) ?? 0, slot));
    }
    for (const m of modules) {
      const col = this.modules[m.id];
      const rows = (maxSlot.get(m.id) ?? 0) + 1;
      boxes.set(m.id, {
        x: col * (G.MODULE_W + G.MODULE_GAP), y: 0,
        w: G.MODULE_W, h: G.HEADER + rows * (G.FILE_H + G.FILE_GAP),
      });
    }
    for (const f of files) {
      const { slot } = this.files[f.id];
      const mb = boxes.get(f.parent);
      boxes.set(f.id, { x: mb.x + G.FILE_INSET, y: G.HEADER + slot * (G.FILE_H + G.FILE_GAP), w: G.FILE_W, h: G.FILE_H });
    }
    for (const [fileId, syms] of symbolsByFile) {
      const fb = boxes.get(fileId);
      const map = this.symbols[fileId];
      for (const s of syms) {
        const slot = map[s.id];
        const hidden = slot >= G.MAX_CHIPS;
        const visualSlot = hidden ? G.MAX_CHIPS - 1 : slot;
        boxes.set(s.id, {
          x: fb.x + G.CHIP_INSET + (visualSlot % 2) * (G.CHIP_W + G.CHIP_GAP_X),
          y: fb.y + G.CHIP_TOP + Math.floor(visualSlot / 2) * (G.CHIP_H + G.CHIP_GAP_Y),
          w: G.CHIP_W, h: G.CHIP_H,
          ...(hidden ? { hidden: true } : {}),
        });
      }
    }
    return boxes;
  }
}
