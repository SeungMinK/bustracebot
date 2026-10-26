import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export function openDb(root) {
  const dbPath = path.resolve(root, process.env.BUS_TRACE_DB_PATH || "./data/bustrace.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS targets (route_name TEXT, route_id TEXT, role TEXT NOT NULL DEFAULT 'source', label TEXT, station_name TEXT, station_id TEXT, station_seq INTEGER, mobile_no TEXT, PRIMARY KEY(route_id, station_id, station_seq));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT);
    CREATE TABLE IF NOT EXISTS tracking_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, weekdays TEXT NOT NULL DEFAULT '1,2,3,4,5', start_time TEXT NOT NULL DEFAULT '06:30', end_time TEXT NOT NULL DEFAULT '07:30', interval_seconds INTEGER NOT NULL DEFAULT 30);
    CREATE TABLE IF NOT EXISTS profile_routes (profile_id TEXT NOT NULL, route_name TEXT NOT NULL, PRIMARY KEY(profile_id, route_name));
    CREATE TABLE IF NOT EXISTS profile_stops (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('source','destination')), label TEXT NOT NULL, station_pattern TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS snapshots (observed_at_kst TEXT, route_name TEXT, route_id TEXT, veh_id TEXT, plate_no TEXT, station_id TEXT, station_seq INTEGER, state_cd INTEGER, remain_seat_cnt INTEGER, PRIMARY KEY(observed_at_kst, route_id, veh_id));
    CREATE TABLE IF NOT EXISTS stop_events (observed_at_kst TEXT, route_name TEXT, route_id TEXT, veh_id TEXT, plate_no TEXT, station_id TEXT, station_seq INTEGER, state_cd INTEGER, remain_seat_cnt INTEGER, stop_label TEXT, stop_name TEXT, PRIMARY KEY(observed_at_kst, route_id, veh_id, stop_label));
    CREATE INDEX IF NOT EXISTS idx_events_day ON stop_events(observed_at_kst, route_name, veh_id);
  `);
  const targetColumns = db.prepare("PRAGMA table_info(targets)").all();
  if (!targetColumns.some(column => column.name === "role")) {
    db.exec("ALTER TABLE targets ADD COLUMN role TEXT NOT NULL DEFAULT 'source'");
  }
  const exists = db.prepare("SELECT 1 FROM tracking_profiles WHERE id = ?").get("default-gimpo-commute");
  if (!exists) {
    db.transaction(() => {
      db.prepare("INSERT INTO settings VALUES (?, ?, ?)").run("active_profile_id", "default-gimpo-commute", "웹과 수집기가 기본으로 사용하는 프로필 ID");
      db.prepare("INSERT INTO tracking_profiles VALUES (?, ?, 1, '1,2,3,4,5', '06:30', '07:30', 30)").run("default-gimpo-commute", "기본 출근 관측");
      const route = db.prepare("INSERT INTO profile_routes VALUES (?, ?)"); route.run("default-gimpo-commute", "8600"); route.run("default-gimpo-commute", "G6000");
      const stop = db.prepare("INSERT INTO profile_stops(profile_id,role,label,station_pattern,sort_order) VALUES (?,?,?,?,?)");
      stop.run("default-gimpo-commute","source","반도유보라2차·김포대학교","반도유보라2차.*김포대|김포대.*반도유보라2차",10);
      stop.run("default-gimpo-commute","source","운양역","^운양역",20);
      stop.run("default-gimpo-commute","source","하늘빛마을 한신더휴테라스12단지","하늘빛마을.*한신더휴테라스12",30);
      stop.run("default-gimpo-commute","source","한신더휴테라스","^한신더휴테라스$",40);
      stop.run("default-gimpo-commute","destination","당산역","당산역2번출구|당산역광역환승센터",100);
    })();
  }
  return db;
}
