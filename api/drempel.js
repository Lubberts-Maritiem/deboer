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
//
// Terugval: lukt RWsOS niet (storing, of RWS weigert het serveradres), dan
// lezen we dezelfde soort verwachting uit de CSV van waterinfo.rws.nl, die
// getij.js ook al gebruikt. Het veld "bronNaam" zegt welke bron het werd.

const RWSOS_URL = "https://rwsos.rws.nl/wb-api/dd/2.0/timeseries";
const LOCATIE = { code: "WTER", waterinfoCode: "terschelling.west", label: "West-Terschelling" };
const WATERINFO_URL = "https://waterinfo.rws.nl/api/chart/get?mapType=waterhoogte&locationCodes=";
const USER_AGENT = "wadoversteken.nl getij-widget (contact via wadoversteken.nl)";
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

    let reeks = [];
    let bronNaam = "rwsos";
    try {
      reeks = await haalReeks(LOCATIE.code, "h_6", now - 60 * 60 * 1000, now + 72 * 60 * 60 * 1000);
    } catch (e) {
      console.warn("RWsOS niet beschikbaar, terugval op waterinfo:", e.message);
    }
    if (reeks.length < 2) {
      bronNaam = "waterinfo";
      reeks = (await haalWaterinfoReeks(LOCATIE.waterinfoCode)).filter((p) => p.ms >= now - 60 * 60 * 1000);
    }
    if (reeks.length < 2) throw new Error("geen verwachting beschikbaar bij RWsOS of waterinfo");

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
      bronNaam,
      verwachtingTot: new Date(reeks[reeks.length - 1].ms).toISOString(),
      opgehaaldOp: new Date(now).toISOString(),
      licentie:
        bronNaam === "rwsos"
          ? "Bron: Rijkswaterstaat, RWsOS eindverwachting."
          : "Bron: Rijkswaterstaat, waterinfo.rws.nl verwachting.",
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
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`RWsOS gaf status ${res.status}`);
  const json = await res.json();
  const events = json?.results?.[0]?.events || [];
  return events
    .map((e) => ({ ms: new Date(e.timeStamp).getTime(), waarde: Number(e.value) }))
    .filter((p) => Number.isFinite(p.ms) && Number.isFinite(p.waarde) && Math.abs(p.waarde) < 10000)
    .sort((a, b) => a.ms - b.ms);
}

async function haalWaterinfoReeks(code) {
  // CSV met kolommen: datum ; tijd (NL) ; locatie ; gemeten ; verwacht ; astronomisch.
  // De kop noemt ook lege "Extremen"-kolommen die in de datarijen ontbreken,
  // daarom tellen we de positie van "verwachting" zonder die mee te rekenen.
  const res = await fetch(WATERINFO_URL + encodeURIComponent(code) + "&values=-48,48", {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`waterinfo gaf status ${res.status}`);
  const regels = (await res.text()).split("\n");
  const kop = (regels.shift() || "").split(";");

  let kolom = -1;
  let teller = 0;
  for (const naam of kop) {
    const n = naam.toLowerCase();
    if (n.startsWith("extremen")) continue;
    if (n.includes("verwachting")) { kolom = teller; break; }
    teller++;
  }
  if (kolom === -1) throw new Error("kolom verwachting niet gevonden in waterinfo-CSV");

  const reeks = [];
  for (const regel of regels) {
    const k = regel.trim().split(";");
    if (k.length <= kolom || k[kolom] === "") continue;
    const [dd, mm, jjjj] = k[0].split("-").map(Number);
    const [uu, min] = (k[1] || "").split(":").map(Number);
    const waarde = Number(k[kolom]);
    if (!jjjj || Number.isNaN(uu) || !Number.isFinite(waarde)) continue;
    reeks.push({ ms: nlNaarMs(jjjj, mm, dd, uu, min), waarde });
  }
  return reeks.sort((a, b) => a.ms - b.ms);
}

function nlNaarMs(jaar, maand, dag, uur, minuut) {
  // Nederlandse kloktijd zonder offset naar UTC-milliseconden. Tweemaal
  // corrigeren, zodat ook de nacht van de klokwissel klopt.
  const naief = Date.UTC(jaar, maand - 1, dag, uur, minuut);
  let ms = naief;
  for (let ronde = 0; ronde < 2; ronde++) ms = naief - nlOffset(ms);
  return ms;
}

function nlOffset(ms) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Amsterdam", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const d = {};
  for (const deel of fmt.formatToParts(new Date(ms))) d[deel.type] = deel.value;
  return Date.UTC(d.year, d.month - 1, d.day, d.hour % 24, d.minute, d.second) - ms;
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
