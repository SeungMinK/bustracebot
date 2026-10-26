/**
 * Configurable commuter-bus observer
 *
 * Uses only Node.js built-ins.  Set GBIS_SERVICE_KEY before running.
 * It discovers the current route and station IDs at startup, so route changes
 * do not require manually editing numeric IDs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(here);
const apiBase = "https://apis.data.go.kr/6410000";
const key = process.env.GBIS_SERVICE_KEY;
const profileId = db.prepare("SELECT value FROM settings WHERE key='active_profile_id'").get()?.value;
const profile = db.prepare("SELECT * FROM tracking_profiles WHERE id=? AND enabled=1").get(profileId);
const pollSeconds = Number(process.env.POLL_SECONDS || profile?.interval_seconds || 30);
const runNow = process.argv.includes("--run-now");

if (!profile) throw new Error("No enabled tracking profile. Check tracking_profiles in SQLite.");
const watchedStops = db.prepare("SELECT label, station_pattern, role FROM profile_stops WHERE profile_id=? ORDER BY sort_order").all(profileId).map(s => ({label:s.label, role:s.role, re:new RegExp(s.station_pattern)}));
const watchedRoutes = db.prepare("SELECT route_name FROM profile_routes WHERE profile_id=? ORDER BY route_name").all(profileId).map(r=>r.route_name);

function kstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
}

function inWindow(date = new Date()) {
  if (runNow) return true;
  const p = kstParts(date);
  const weekdays = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const minute = Number(p.hour) * 60 + Number(p.minute);
  const toMinute = value => { const [h,m]=value.split(":").map(Number); return h*60+m; };
  return profile.weekdays.split(",").includes(String(weekdays[p.weekday])) && minute >= toMinute(profile.start_time) && minute < toMinute(profile.end_time);
}

function kstStamp(date = new Date()) {
  const p = kstParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+09:00`;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function messageBody(data) {
  return data?.response?.msgBody ?? data?.response?.body ?? data?.msgBody ?? data?.body ?? data;
}

async function request(service, params) {
  const url = new URL(`${apiBase}/${service}`);
  url.search = new URLSearchParams({ format: "json", serviceKey: key, ...params }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${service}: HTTP ${response.status}`);
  const data = await response.json();
  const head = data?.response?.msgHeader ?? data?.header;
  if (head?.resultCode && String(head.resultCode) !== "0") {
    throw new Error(`${service}: ${head.resultCode} ${head.resultMessage || "GBIS error"}`);
  }
  return messageBody(data);
}

async function discover() {
  const targets = [];
  for (const routeName of watchedRoutes) {
    const routeBody = await request("busrouteservice/v2/getBusRouteListv2", { keyword: routeName });
    const routes = asArray(routeBody.busRouteList).filter(r => String(r.routeName).toUpperCase() === routeName);
    if (routes.length !== 1) {
      throw new Error(`${routeName}: exact route match expected 1, found ${routes.length}.`);
    }
    const route = routes[0];
    const stationBody = await request("busrouteservice/v2/getBusRouteStationListv2", { routeId: route.routeId });
    const stations = asArray(stationBody.busRouteStationList);
    for (const station of stations) {
      const match = watchedStops.find(stop => stop.re.test(String(station.stationName || "")));
      if (match) {
        targets.push({
          routeName, routeId: String(route.routeId), role: match.role, label: match.label,
          stationName: station.stationName, stationId: String(station.stationId),
          stationSeq: Number(station.stationSeq), mobileNo: String(station.mobileNo ?? ""),
        });
      }
    }
  }
  const put = db.prepare("INSERT OR REPLACE INTO targets(route_name,route_id,role,label,station_name,station_id,station_seq,mobile_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => { db.prepare("DELETE FROM targets").run(); for (const t of targets) put.run(t.routeName,t.routeId,t.role,t.label,t.stationName,t.stationId,t.stationSeq,t.mobileNo); })();
  return targets;
}

async function snapshot(targets) {
  const now = new Date();
  const stamp = kstStamp(now);
  const allRows = [];
  const eventRows = [];
  for (const routeName of watchedRoutes) {
    const routeTargets = targets.filter(t => t.routeName === routeName);
    if (!routeTargets.length) continue;
    const body = await request("buslocationservice/v2/getBusLocationListv2", { routeId: routeTargets[0].routeId });
    const buses = asArray(body.busLocationList);
    for (const bus of buses) {
      const row = {
        observedAtKst: stamp, routeName, routeId: routeTargets[0].routeId,
        vehId: String(bus.vehId ?? ""), plateNo: bus.plateNo ?? "",
        stationId: String(bus.stationId ?? ""), stationSeq: Number(bus.stationSeq),
        stateCd: Number(bus.stateCd), remainSeatCnt: Number(bus.remainSeatCnt),
      };
      allRows.push(row);
      const hits = routeTargets.filter(t => t.stationSeq === row.stationSeq && t.stationId === row.stationId);
      for (const hit of hits) eventRows.push({ ...row, stopLabel: hit.label, stopName: hit.stationName });
    }
  }
  const putSnapshot = db.prepare("INSERT OR IGNORE INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const putEvent = db.prepare("INSERT OR IGNORE INTO stop_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => { for (const r of allRows) putSnapshot.run(r.observedAtKst,r.routeName,r.routeId,r.vehId,r.plateNo,r.stationId,r.stationSeq,r.stateCd,r.remainSeatCnt); for (const r of eventRows) putEvent.run(r.observedAtKst,r.routeName,r.routeId,r.vehId,r.plateNo,r.stationId,r.stationSeq,r.stateCd,r.remainSeatCnt,r.stopLabel,r.stopName); })();
  console.log(`${stamp} snapshots=${allRows.length} watched-stop-events=${eventRows.length}`);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main() {
  if (!key) throw new Error("GBIS_SERVICE_KEY is not set. See README.md.");
  const targets = await discover();
  if (!targets.length) throw new Error("No configured stops were found. Check the active profile in SQLite.");
  console.table(targets.map(t => ({ route: t.routeName, label: t.label, station: t.stationName, seq: t.stationSeq, no: t.mobileNo })));
  console.log(runNow ? "Test mode: taking one snapshot." : `Waiting for the configured schedule (${profile.start_time}–${profile.end_time} KST).`);
  while (true) {
    const inside = inWindow();
    if (inside) {
      try { await snapshot(targets); } catch (error) { console.error(kstStamp(), error.message); }
      if (runNow) return;
      await sleep(pollSeconds * 1000);
    } else {
      await sleep(15_000);
    }
  }
}

main().catch(error => { console.error(`Fatal: ${error.message}`); process.exitCode = 1; });
