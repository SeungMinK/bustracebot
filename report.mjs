/** Export one day's SQLite stop events as a compact vehicle-by-vehicle CSV. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const day = process.argv[2];
if (!day) throw new Error("Usage: node report.mjs YYYY-MM-DD");
const db = openDb(here);
const rows = db.prepare("SELECT observed_at_kst observedAtKst,route_name routeName,veh_id vehId,plate_no plateNo,stop_label stopLabel,state_cd stateCd,remain_seat_cnt remainSeatCnt FROM stop_events WHERE observed_at_kst LIKE ? ORDER BY observed_at_kst").all(`${day}%`);
const groups = new Map();
for (const row of rows) {
  const key = `${row.routeName}|${row.vehId}|${row.stopLabel}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
const csv = ["date,route,vehicle,stop,arrival_observed_at,arrival_seats,departure_observed_at,departure_seats"];
for (const events of groups.values()) {
  events.sort((a, b) => a.observedAtKst.localeCompare(b.observedAtKst));
  const first = events[0];
  const arrived = events.find(e => e.stateCd === 1);
  const departed = events.find(e => e.stateCd === 2);
  const cell = v => `"${String(v ?? "").replaceAll('"', '""')}"`;
  csv.push([day, first.routeName, first.plateNo || first.vehId, first.stopLabel,
    arrived?.observedAtKst, arrived?.remainSeatCnt, departed?.observedAtKst, departed?.remainSeatCnt,
  ].map(cell).join(","));
}
const out = path.join(here, "data", `${day}-summary.csv`);
await fs.writeFile(out, csv.join("\n") + "\n", "utf8");
console.log(`Wrote ${out}`);
