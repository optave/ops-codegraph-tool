/**
 * Check whether the dataflow table exists and has data.
 * @param {object} db
 * @returns {boolean}
 */
export function hasDataflowTable(db) {
  try {
    return db.prepare('SELECT COUNT(*) AS c FROM dataflow').get().c > 0;
  } catch {
    return false;
  }
}
