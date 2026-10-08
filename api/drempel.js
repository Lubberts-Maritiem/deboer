// api/drempel.js
// Berekent wanneer de waterstand bij West-Terschelling door NAP +50 cm gaat,
// stijgend en dalend, op basis van de RWS-eindverwachting.
//
// Bron: dezelfde data als de RWS-viewer
//   https://rwsos.rws.nl/viewer/detach/chart/waddenzee/waterkwantiteit/location/WTER
// Die viewer leest uit een open DD-API (getest 8 oktober 2026):
//   /wb-api/dd/2.0/timeseries?locationCode=WTER&observationTypeId=WT&sourceName=h_6
//   - sourceName h_6 is "rws eindverwachting" (de rode lijn in de grafiek)
//   - sourceName S_4 is astronomisch, S_1 is de meting
//   - waarden in cm NAP, per 10 minuten, tijden in UTC ("Z")
// De verwachting loopt ongeveer 48 uur vooruit.

const RWSOS_URL = "https://rwsos.rws.nl/wb-api/dd/2.0/timeseries";
const LOCATIE = { code: "WTER", label: "West-Terschelling" };
const NIVEAU_CM = 50;

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = null; // { data, fetchedAt }

export default async function handler(req, res) {
  try {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.status(200).json(cache.data);
    }

    const reeks = await haalReeks(LOCATIE.code, "h_6", now - 60 * 60 * 1000, now + 72 * 60 * 60 * 1000);
    if (reeks.length < 2) throw new Error("geen verwachting beschikbaar");

    const komende = zoekDoorgangen(reeks, NIVEAU_CM)
      .filter((d) => new Date(d.tijdstip).getTime() >= now)
      .slice(0, 2); // in tijdsvolgorde, dus soms eerst stijgend, soms eerst dalend

    // Staat het water nu boven het niveau? Laatste verwachte punt vóór nu.
    const huidig = [...reeks].reverse().find((p) => p.ms <= now) || reeks[0];

    const data = {
      locatie: LOCATIE.label,
      niveauCm: NIVEAU_CM,
      nuBoven: huidig.waarde >= NIVEAU_CM,
      komende, // [{ tijdstip, richting: "stijgend" | "dalend" }]
      verwachtingTot: new Date(reeks[reeks.length - 1].ms).toISOString(),
      opgehaaldOp: new Date(now).toISOString(),
      licentie: "Bron: Rijkswaterstaat, RWsOS eindverwachting.",
    };

    cache = { data, fetchedAt: now };
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).json(data);
  } catch (err) {
    console.error("Drempel-ophalen mislukt:", err);
    return res.status(502).json({
      error: "Kon verwachting niet ophalen",
      detail: String(err.message || err),
    });
  }
}

async function haalReeks(code, bron, vanMs, totMs) {
  const params = new URLSearchParams({
    locationCode: code,
    observationTypeId: "WT",
    sourceName: bron,
    startTime: zonderMs(vanMs),
    endTime: zonderMs(totMs),
  });
  const res = await fetch(`${RWSOS_URL}?${params}`, {
    headers: { "User-Agent": "wadoversteken.nl getij-widget (contact via wadoversteken.nl)" },
  });
  if (!res.ok) throw new Error(`RWsOS gaf status ${res.status}`);
  const json = await res.json();
  const events = json?.results?.[0]?.events || [];
  return events
    .map((e) => ({ ms: new Date(e.timeStamp).getTime(), waarde: Number(e.value) }))
    .filter((p) => Number.isFinite(p.ms) && Number.isFinite(p.waarde) && Math.abs(p.waarde) < 10000)
    .sort((a, b) => a.ms - b.ms);
}

function zoekDoorgangen(reeks, niveau) {
  // Tussen twee punten waar het niveau tussen valt, interpoleren we lineair.
  // Bij stappen van 10 minuten is dat op een minuut of twee nauwkeurig.
  const uit = [];
  for (let i = 1; i < reeks.length; i++) {
    const a = reeks[i - 1];
    const b = reeks[i];
    const stijgt = a.waarde < niveau && b.waarde >= niveau;
    const daalt = a.waarde >= niveau && b.waarde < niveau;
    if (!stijgt && !daalt) continue;
    const fractie = (niveau - a.waarde) / (b.waarde - a.waarde);
    const ms = a.ms + fractie * (b.ms - a.ms);
    uit.push({
      tijdstip: new Date(Math.round(ms / 60000) * 60000).toISOString(),
      richting: stijgt ? "stijgend" : "dalend",
    });
  }
  return uit;
}

function zonderMs(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
