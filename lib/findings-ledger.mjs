/**
 * IA Loop — what earlier Work Units already found out, carried forward.
 *
 * Measured across Goals 014-016: ~60% of every agent action is orientation,
 * and it does not fall. Each unit is a cold process, so each one re-derives
 * where things live — and the unit that just mapped the same module is no help
 * at all unless the plan happened to declare it as a dependency.
 *
 * What a packet carries today is `relevantFiles`: the plan's guesses, plus the
 * files a DECLARED dependency changed. Two gaps follow from that, and this
 * module fills exactly those two:
 *
 *   siblings   a unit with no declared dependency on WU-03 learns nothing from
 *              WU-03, even when both are editing the same feature.
 *   reads      nothing anywhere carries what a unit READ. That is the larger
 *              half of orientation and it is thrown away every time.
 *
 * DELIBERATELY NOT a shared memory. It carries file paths and who touched
 * them — facts git and the tool stream already prove — never prose, never
 * reasoning, never another unit's report or transcript. That distinction is
 * what keeps it from becoming the warm session the architecture rejects: a
 * shared conversation is unbounded and propagates conclusions, while this is
 * bounded, and a wrong entry costs one Read to disprove.
 *
 * It is also derived rather than authored. No model writes it and no model is
 * asked to summarise for it, so it cannot hallucinate an entry and costs
 * nothing to produce.
 */

/** Entries carried into one packet. Beyond this, more pointers stop helping. */
export const MAX_ENTRIES = 40;

/** Characters of packet the ledger may occupy, counted as rendered. */
export const MAX_LEDGER_CHARS = 3_000;

/** How a prior unit touched a file. `CHANGED` outranks `READ` on merge. */
export const TOUCH = Object.freeze({ CHANGED: 'CHANGED', READ: 'READ' });

/** Categories of the tool stream that name a file worth remembering. */
const PATH_CATEGORIES = new Set(['READ', 'EDIT', 'WRITE']);

/** A token is a path when it has a separator and a file extension. */
const LOOKS_LIKE_PATH = /^[^\s:*?"<>|]+[\\/][^\s:*?"<>|]*\.[A-Za-z0-9]+$/;

function normalize(path) {
  if (typeof path !== 'string') return null;
  const value = path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (value === '' || !LOOKS_LIKE_PATH.test(value)) return null;
  return value;
}

/**
 * Collects what units touch, and hands the next unit a bounded view of it.
 *
 * Scoped to one Goal by its only caller: the tree moves when the baseline
 * moves, so an entry from a previous Goal would describe a file that may no
 * longer be where it says.
 */
export function createFindingsLedger({ maxEntries = MAX_ENTRIES } = {}) {
  /** path -> { touch, by:Set } — one row per file, not one per observation. */
  const rows = new Map();

  function touch(path, unitId, kind) {
    const ref = normalize(path);
    if (!ref) return;
    const row = rows.get(ref) ?? { ref, touch: TOUCH.READ, by: new Set() };
    // CHANGED is the stronger claim and never degrades back to READ.
    if (kind === TOUCH.CHANGED) row.touch = TOUCH.CHANGED;
    if (unitId) row.by.add(unitId);
    rows.set(ref, row);
  }

  return {
    /**
     * Feeds one tool-stream event. Safe to call for every event: anything that
     * is not a file access is ignored, and a malformed one cannot throw.
     */
    observe(unitId, event) {
      if (!event || !PATH_CATEGORIES.has(event.category)) return;
      touch(event.detail, unitId, event.category === 'READ' ? TOUCH.READ : TOUCH.CHANGED);
    },

    /** Records what git says a unit changed, which outranks anything observed. */
    completeUnit(unitId, { changedFiles = [] } = {}) {
      for (const file of changedFiles) touch(file, unitId, TOUCH.CHANGED);
    },

    /** Every row, for tests and telemetry. */
    size() {
      return rows.size;
    },

    /**
     * The bounded view one packet carries.
     *
     * `exclude` is what the packet already lists in `relevantFiles`: repeating
     * those would spend the budget saying something the unit has been told.
     * Changed files come first — a file this Goal has already edited is the
     * strongest pointer there is — and the cap bites the weaker end.
     */
    forPacket({ exclude = [], maxChars = MAX_LEDGER_CHARS } = {}) {
      const skip = new Set(exclude.map((file) => normalize(file)).filter(Boolean));
      const ordered = [...rows.values()]
        .filter((row) => !skip.has(row.ref))
        .sort((a, b) => {
          if (a.touch !== b.touch) return a.touch === TOUCH.CHANGED ? -1 : 1;
          return a.ref.localeCompare(b.ref);
        });

      const out = [];
      let chars = 0;
      for (const row of ordered) {
        if (out.length >= maxEntries) break;
        const entry = Object.freeze({
          file: row.ref,
          touch: row.touch,
          by: Object.freeze([...row.by].sort()),
        });
        // Rendered size, because the packet is serialised as JSON.
        const cost = JSON.stringify(entry).length;
        if (chars + cost > maxChars) break;
        chars += cost;
        out.push(entry);
      }
      return Object.freeze(out);
    },
  };
}
