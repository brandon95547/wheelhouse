/** Deletes every business record, keeping the schema and configuration. */
import { DB_PATH, clearAllData, migrate } from '../lib/db.js';

migrate();
const deleted = clearAllData();

console.log(`Cleared Wheelhouse data in ${DB_PATH}`);
for (const [table, rows] of Object.entries(deleted)) {
  console.log(`  ${table.padEnd(20)} ${rows} row(s) deleted`);
}
