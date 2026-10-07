/**
 * Content-driven board geometry.
 *
 * The old board split the body by fixed ratios from `layout.json`: WORK took
 * 61% of the rows whether it held a twelve-node graph or a single line. On a
 * 240x60 terminal that left 67% of the cells blank — the board got *less*
 * informative as the operator's screen got bigger.
 *
 * Here every widget states a demand (min / ideal / grow) and the engine hands
 * out rows: everyone gets `min`, then everyone climbs toward `ideal`, then the
 * surplus goes to whoever declared `grow`. When the budget cannot even cover
 * the minimums, the least important widget is dropped whole rather than every
 * widget being squeezed into uselessness.
 */

export interface Demand {
  /** Rows below which this widget says nothing worth the space. */
  min: number;
  /** Rows that show the widget's content in full. */
  ideal: number;
  /** Share of the leftover rows. 0 pins the widget at `ideal`. */
  grow: number;
}

export interface FlexItem<T> {
  item: T;
  demand: Demand;
  /** Lower survives longer when the budget is short. */
  priority?: number;
}

export interface Slot<T> {
  item: T;
  rows: number;
}

/**
 * Split `budget` rows across `items`. `chrome` is the per-widget row cost of
 * its frame (2 for a box with a top and bottom border), charged before any
 * content is allocated.
 */
export function distribute<T>(items: readonly FlexItem<T>[], budget: number, chrome: number): Slot<T>[] {
  if (budget <= 0 || items.length === 0) {
    return [];
  }
  // Drop from the least important end until the survivors' minimums fit.
  const ranked = items.map((entry, index) => ({ entry, index })).sort(
    (a, b) => (a.entry.priority ?? 0) - (b.entry.priority ?? 0) || a.index - b.index,
  );
  let kept = ranked;
  const floorOf = (rows: typeof ranked) =>
    rows.reduce((sum, row) => sum + Math.max(0, row.entry.demand.min) + chrome, 0);
  while (kept.length > 1 && floorOf(kept) > budget) {
    kept = kept.slice(0, -1);
  }
  if (kept.length === 0) {
    return [];
  }
  // Restore the caller's order: priority decides survival, not position.
  const live = [...kept].sort((a, b) => a.index - b.index).map((row) => row.entry);

  const content = budget - chrome * live.length;
  if (content <= 0) {
    // Not even the frames fit. One widget takes what is left, unboxed.
    return [{ item: live[0]!.item, rows: Math.max(0, budget) }];
  }
  const rows = live.map((entry) => Math.max(0, entry.demand.min));
  let spent = rows.reduce((sum, value) => sum + value, 0);
  if (spent > content) {
    // The floor itself overflows (a single widget wider than the board):
    // shave proportionally rather than paint outside the body.
    return trim(live, rows, content);
  }
  // Fixed-content widgets climb to their ideal first: they can never use more
  // than that, and any row they leave behind belongs to an elastic pane. Then
  // the surplus goes to the growers, which have content past their ideal.
  let surplus = content - spent;
  for (let i = 0; i < live.length && surplus > 0; i += 1) {
    if (live[i]!.demand.grow > 0) {
      continue;
    }
    const want = Math.max(live[i]!.demand.min, live[i]!.demand.ideal);
    const step = Math.min(surplus, Math.max(0, want - rows[i]!));
    rows[i]! += step;
    surplus -= step;
  }
  const weights = live.map((entry) => Math.max(0, entry.demand.grow));
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (surplus > 0 && total > 0) {
    const share = live.map((_, i) => Math.floor((surplus * weights[i]!) / total));
    for (let i = 0; i < live.length; i += 1) {
      rows[i]! += share[i]!;
    }
    let left = surplus - share.reduce((sum, value) => sum + value, 0);
    let heaviest = 0;
    for (let i = 1; i < live.length; i += 1) {
      if (weights[i]! > weights[heaviest]!) {
        heaviest = i;
      }
    }
    if (weights[heaviest]! > 0) {
      rows[heaviest]! += left;
      left = 0;
    }
    surplus = left;
  } else if (surplus > 0) {
    // Nobody grows: spend the remainder only up to each widget's ideal. A
    // capped pane (ideal is its cap) must not be inflated past it — that
    // is how a 3-row tail pane became 6 rows while the stream went hungry.
    for (let i = live.length - 1; i >= 0 && surplus > 0; i -= 1) {
      const want = Math.max(live[i]!.demand.min, live[i]!.demand.ideal);
      const step = Math.min(surplus, Math.max(0, want - rows[i]!));
      rows[i]! += step;
      surplus -= step;
    }
  }
  spent = rows.reduce((sum, value) => sum + value, 0);
  return live.map((entry, i) => ({ item: entry.item, rows: rows[i]! }));
}

function trim<T>(live: readonly FlexItem<T>[], rows: number[], content: number): Slot<T>[] {
  let over = rows.reduce((sum, value) => sum + value, 0) - content;
  for (let i = rows.length - 1; i >= 0 && over > 0; i -= 1) {
    const cut = Math.min(over, rows[i]!);
    rows[i]! -= cut;
    over -= cut;
  }
  return live.map((entry, i) => ({ item: entry.item, rows: rows[i]! })).filter((slot) => slot.rows > 0);
}

export interface Column {
  x: number;
  width: number;
}

/** Minimum readable column width. Below this a pane is a word-per-line mess. */
const COLUMN_MIN = 46;

/**
 * Widest a prose column should get. A model reply is a paragraph, and past
 * roughly a hundred columns the eye stops tracking the line — a wider board
 * should buy more panes, not longer lines.
 */
const PROSE_MAX = 104;

/**
 * How many side-by-side columns the board runs, and how wide each is.
 *
 * The stream sits in the second column and takes the larger share up to
 * `PROSE_MAX`. Past that the surplus goes to the other columns, which hold
 * lists and charts and read fine wide; past *that* another column is a better
 * use of the width than padding.
 */
export function splitColumns(cols: number, force?: number): Column[] {
  const width = Math.max(1, Math.floor(cols));
  // An operator override still cannot ask for columns narrower than a pane
  // can use: the screen decides what is possible, the config what is wanted.
  const ceiling = Math.max(1, Math.floor(width / COLUMN_MIN));
  const wanted = force === undefined ? undefined : Math.max(1, Math.min(force, ceiling));
  if (wanted === 1 || (wanted === undefined && width < COLUMN_MIN * 2)) {
    return [{ x: 0, width }];
  }
  if (wanted === 2 || (wanted === undefined && width < COLUMN_MIN * 2 + 52)) {
    const left = Math.floor(width * 0.42);
    return place([left, width - left]);
  }
  const columns = wanted ?? Math.min(4, Math.max(3, Math.floor(width / (COLUMN_MIN + 30))));
  const stream = Math.min(PROSE_MAX, Math.floor(width * 0.44));
  const rest = width - stream;
  const others = columns - 1;
  const share = Math.floor(rest / others);
  const widths: number[] = [];
  for (let i = 0; i < columns; i += 1) {
    if (i === 1) {
      widths.push(stream);
      continue;
    }
    widths.push(share);
  }
  // Integer division leaves a remainder; the last column absorbs it so the
  // row is exactly `width` wide.
  widths[widths.length - 1] = width - widths.slice(0, -1).reduce((sum, value) => sum + value, 0);
  return place(widths);
}

function place(widths: readonly number[]): Column[] {
  let x = 0;
  return widths.map((width) => {
    const column = { x, width };
    x += width;
    return column;
  });
}
