import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../db.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const db = openDb(root);
const app = express();
app.use(express.json());
async function dates() { return db.prepare("SELECT DISTINCT substr(observed_at_kst,1,10) day FROM stop_events ORDER BY day DESC").all().map(x=>x.day); }
const at = row => new Date(row.observedAtKst).getTime();
const activeProfileId = () => db.prepare("SELECT value FROM settings WHERE key='active_profile_id'").get()?.value;
const profileConfig = () => {
  const id = activeProfileId();
  return {
    profile: db.prepare("SELECT id,name,enabled,weekdays,start_time startTime,end_time endTime,interval_seconds intervalSeconds FROM tracking_profiles WHERE id=?").get(id),
    routes: db.prepare("SELECT route_name routeName FROM profile_routes WHERE profile_id=? ORDER BY route_name").all(id),
    stops: db.prepare("SELECT id,role,label,station_pattern stationPattern,sort_order sortOrder FROM profile_stops WHERE profile_id=? ORDER BY role,sort_order").all(id),
  };
};
function trips(events, snapshots) {
  const { stops } = profileConfig();
  const sourceLabels = new Set(stops.filter(stop => stop.role === "source").map(stop => stop.label));
  const destinationLabels = new Set(stops.filter(stop => stop.role === "destination").map(stop => stop.label));
  return events.filter(event => sourceLabels.has(event.stopLabel) && event.stateCd === 1).map(arrival => {
    const vehicleEvents = events.filter(event => event.routeName === arrival.routeName && event.vehId === arrival.vehId).sort((a, b) => at(a) - at(b));
    const vehicleSnapshots = snapshots.filter(snapshot => snapshot.routeName === arrival.routeName && snapshot.vehId === arrival.vehId).sort((a, b) => at(a) - at(b));
    const departed = vehicleEvents.find(event => event.stopLabel === arrival.stopLabel && event.stateCd === 2 && at(event) >= at(arrival));
    const before = [...vehicleSnapshots].reverse().find(snapshot => at(snapshot) < at(arrival) && snapshot.stationSeq < arrival.stationSeq);
    const destination = vehicleEvents.find(event => destinationLabels.has(event.stopLabel) && at(event) > at(departed ?? arrival));
    return { routeName: arrival.routeName, vehicle: arrival.plateNo || arrival.vehId, source: arrival.stopLabel, arrivedAt: arrival.observedAtKst, seatsBefore: before?.remainSeatCnt ?? null, beforeAt: before?.observedAtKst ?? null, seatsOnArrival: arrival.remainSeatCnt, departedAt: departed?.observedAtKst ?? null, seatsOnDeparture: departed?.remainSeatCnt ?? null, destinationAt: destination?.observedAtKst ?? null, destinationStop: destination?.stopName ?? null };
  }).sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));
}
app.get("/api/health", (_q,r) => r.json({ok:true}));
app.get("/api/config", (_q, r) => r.json(profileConfig()));
app.put("/api/config", (request, response) => {
  const { profile, routes, stops } = request.body ?? {};
  if (!profile?.id || !Array.isArray(routes) || !Array.isArray(stops)) return response.status(400).json({ error: "profile, routes, stops are required" });
  if (!routes.length || !stops.some(stop => stop.role === "source") || !stops.some(stop => stop.role === "destination")) return response.status(400).json({ error: "At least one route, source, and destination are required" });
  try { stops.forEach(stop => new RegExp(stop.stationPattern)); } catch { return response.status(400).json({ error: "One or more stop patterns are invalid regular expressions" }); }
  db.transaction(() => {
    db.prepare("UPDATE tracking_profiles SET name=?, enabled=?, weekdays=?, start_time=?, end_time=?, interval_seconds=? WHERE id=?").run(profile.name || "관측 프로필", profile.enabled ? 1 : 0, profile.weekdays || "1,2,3,4,5", profile.startTime, profile.endTime, Number(profile.intervalSeconds) || 30, profile.id);
    db.prepare("DELETE FROM profile_routes WHERE profile_id=?").run(profile.id);
    const putRoute = db.prepare("INSERT INTO profile_routes(profile_id,route_name) VALUES (?,?)");
    [...new Set(routes.map(route => route.routeName.trim()).filter(Boolean))].forEach(route => putRoute.run(profile.id, route));
    db.prepare("DELETE FROM profile_stops WHERE profile_id=?").run(profile.id);
    const putStop = db.prepare("INSERT INTO profile_stops(profile_id,role,label,station_pattern,sort_order) VALUES (?,?,?,?,?)");
    stops.forEach((stop, index) => putStop.run(profile.id, stop.role, stop.label.trim(), stop.stationPattern.trim(), Number(stop.sortOrder) || index));
  })();
  response.json(profileConfig());
});
app.get("/api/dates", async (_q,r,n) => { try { r.json(await dates()); } catch(e) { n(e); } });
app.get("/api/targets", (_q,r) => r.json(db.prepare("SELECT route_name routeName,route_id routeId,role,label,station_name stationName,station_id stationId,station_seq stationSeq,mobile_no mobileNo FROM targets ORDER BY route_name,station_seq").all()));
app.get("/api/day/:date", (q,r) => { if(!/^\d{4}-\d{2}-\d{2}$/.test(q.params.date)) return r.status(400).json({error:"Invalid date"}); const events=db.prepare("SELECT observed_at_kst observedAtKst,route_name routeName,route_id routeId,veh_id vehId,plate_no plateNo,station_id stationId,station_seq stationSeq,state_cd stateCd,remain_seat_cnt remainSeatCnt,stop_label stopLabel,stop_name stopName FROM stop_events WHERE observed_at_kst LIKE ? ORDER BY observed_at_kst").all(`${q.params.date}%`); const snapshots=db.prepare("SELECT observed_at_kst observedAtKst,route_name routeName,route_id routeId,veh_id vehId,plate_no plateNo,station_id stationId,station_seq stationSeq,state_cd stateCd,remain_seat_cnt remainSeatCnt FROM snapshots WHERE observed_at_kst LIKE ? ORDER BY observed_at_kst").all(`${q.params.date}%`); r.json({date:q.params.date,events,trips:trips(events,snapshots)}); });
const dist = path.join(root, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("/{*path}", (_request, response) => response.sendFile(path.join(dist, "index.html")));
}
app.use((e,_q,r,_n) => { console.error(e); r.status(500).json({error:e.message}); });
app.listen(Number(process.env.PORT||8787), () => console.log("BusTraceBot API: http://localhost:8787"));
