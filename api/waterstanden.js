// api/waterstanden.js
// Actuele gemeten waterstanden voor de rollende balk onderaan de pagina.
//
// Bron: waddendata.nl, dezelfde WebSocket als getij.js (wss://data.waddendata.nl).
// Bij verbinden stuurt die één JSON-snapshot met alle locaties. Wij gebruiken:
//   - waterstanden[regio][code].H1          gemeten stand in cm NAP
//   - WaterstandenAstroPredict[regio][code] astronomische stand van nu,
//                                           voor de opzet (gemeten min astro)
//   - Tides[naam]                           eerstvolgend HW of LW, voor de
//                                           richting: komt eerst HW, dan stijgt het
// Den Oever en Schiermonnikoog hebben geen getijtabel bij waddendata. Voor de
// richting gebruiken we daar de buren Kornwerderzand (ook aan de Afsluitdijk)
// en Lauwersoog, die vrijwel hetzelfde getij hebben.

const LOCATIES = [
  { naam: "Den Helder",        regio: "west", code: "DENH", getij: "Den Helder" },
  { naam: "Den Oever",         regio: "west", code: "OEBU", getij: "Kornwerderzand" },
  { naam: "Harlingen",         regio: "west", code: "HARL", getij: "Harlingen" },
  { naam: "West-Terschelling", regio: "west", code: "WTER", getij: "West-Terschelling" },
  { naam: "Ameland",           regio: "west", code: "NESS", getij: "Nes Ameland" },
  { naam: "Holwerd",           regio: "oost", code: "HOLW", getij: "Holwerd" },
  { naam: "Schiermonnikoog",   regio: "oost", code: "SCHI", getij: "Lauwersoog" },
  { naam: "Lauwersoog",        regio: "oost", code: "LAUW", getij: "Lauwersoog" },
];

// Een meting ouder dan dit tonen we niet meer als actueel.
const MAX_LEEFTIJD_MS = 60 * 60 * 1000;

const WADDENDATA_WS = "wss://data.waddendata.nl";
const CACHE_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 8000;
let cache = null; // { data, fetchedAt }
let bezig = null;

export default async function handler(req, res) {
  try {
    const now = Date.now();
    if (!cache || now - cache.fetchedAt >= CACHE_TTL_MS) {
      if (!bezig) {
        bezig = leesSnapshot()
          .then((snapshot) => { cache = { data: verwerk(snapshot), fetchedAt: Date.now() }; })
          .finally(() => { bezig = null; });
      }
      await bezig;
    }
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).json(cache.data);
  } catch (err) {
    console.error("Waterstanden-ophalen mislukt:", err);
    return res.status(502).json({
      error: "Kon waterstanden niet ophalen",
      detail: String(err.message || err),
    });
  }
}

function verwerk(snapshot) {
  const W = snapshot?.waterstanden;
  if (!W || typeof W !== "object") throw new Error("snapshot zonder waterstanden");
  const A = snapshot.WaterstandenAstroPredict || {};
  const T = snapshot.Tides || {};
  const now = Date.now();

  const locaties = LOCATIES.map((l) => {
    const h = W[l.regio]?.[l.code]?.H1;
    const ms = Number(h?.unix_timestamp) * 1000;
    const waarde = Number(h?.value);
    const geldig = h && h.value !== "--" && Number.isFinite(waarde) && Number.isFinite(ms)
      && now - ms < MAX_LEEFTIJD_MS && Math.abs(waarde) < 1000;

    const astro = Number(A[l.regio]?.[l.code]?.value);
    return {
      naam: l.naam,
      waardeCm: geldig ? Math.round(waarde) : null,
      tijdstip: geldig ? new Date(ms).toISOString() : null,
      opzetCm: geldig && Number.isFinite(astro) ? Math.round(waarde - astro) : null,
      richting: richtingUitGetij(T[l.getij], now), // "stijgend" | "dalend" | null
    };
  });

  return {
    locaties,
    opgehaaldOp: new Date(now).toISOString(),
    licentie: "Waterstanden: waddendata.nl (data Rijkswaterstaat).",
  };
}

function richtingUitGetij(rij, now) {
  // Vorm: [ [regio, code], [ { tide: "HW"|"LW", unix_date, date_predict, ... } ] ]
  const lijst = Array.isArray(rij?.[1]) ? rij[1] : [];
  let eerst = null;
  let eerstMs = Infinity;
  for (const e of lijst) {
    // Het verwachte tijdstip als dat er is, anders het astronomische.
    const ms = nlTekstNaarMs(e.date_predict) ?? Number(e.unix_date) * 1000;
    if (!Number.isFinite(ms) || ms < now) continue;
    if (ms < eerstMs) { eerstMs = ms; eerst = e; }
  }
  if (!eerst) return null;
  return eerst.tide === "HW" ? "stijgend" : eerst.tide === "LW" ? "dalend" : null;
}

async function leesSnapshot() {
  // Node 22+ heeft WebSocket ingebouwd; anders het pakket "ws".
  const WS = globalThis.WebSocket ?? (await import("ws")).default;
  return new Promise((resolve, reject) => {
    // Zonder Origin-header weigert waddendata de verbinding.
    const ws = new WS(WADDENDATA_WS, {
      headers: {
        Origin: "https://waddendata.nl",
        "User-Agent": "wadoversteken.nl getij-widget (contact via wadoversteken.nl)",
      },
    });
    const klaar = (fout, data) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      fout ? reject(fout) : resolve(data);
    };
    const timer = setTimeout(() => klaar(new Error("waddendata gaf geen antwoord binnen 8 s")), TIMEOUT_MS);
    ws.onmessage = (m) => {
      try { klaar(null, JSON.parse(typeof m.data === "string" ? m.data : String(m.data))); }
      catch { klaar(new Error("waddendata stuurde geen geldige JSON")); }
    };
    ws.onerror = () => klaar(new Error("waddendata WebSocket-fout"));
  });
}

function nlTekstNaarMs(tekst) {
  // "2026-10-08 08:30" in Nederlandse kloktijd naar UTC-milliseconden.
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(tekst || ""));
  if (!m) return null;
  const naief = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
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
