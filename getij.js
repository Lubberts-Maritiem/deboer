// api/getij.js
// Haalt het astronomische getij op bij Rijkswaterstaat (WaterWebservices ddapi20)
// voor een van de vaste locaties, plus de actueel gemeten waterstand.
//
// Moet server-side, want deze RWS-API staat geen browseraanroepen toe (geen CORS).
//
// Twee bronnen, want ze vullen elkaar aan:
//   1. WaterWebservices geeft het ASTRONOMISCHE getij, de zuivere maanberekening.
//      Die houdt geen rekening met wind en luchtdruk, dus bij opzet of afwaaiing
//      wijkt hij tientallen centimeters af van wat er echt gebeurt.
//   2. waterinfo.rws.nl geeft de VERWACHTING uit het stromingsmodel van RWS,
//      inclusief opzet. Die loopt ongeveer 48 uur vooruit.
// We nemen de verwachting waar die er is, en vallen daarbuiten terug op
// astronomisch. Elk extreem draagt zijn eigen bronvermelding.
//
// Sinds 8 oktober 2026 is waddendata.nl de primaire bron voor de verwachte
// extremen. Die site levert per locatie zo'n 7 dagen HW/LW met zowel het
// astronomische als het verwachte tijdstip en de hoogte, via een WebSocket
// (wss://data.waddendata.nl) die bij verbinden één JSON-snapshot stuurt met
// alle locaties. Voor locaties die waddendata niet kent (Den Oever, Texel,
// Schiermonnikoog), of als waddendata niet bereikbaar is, valt dit bestand
// terug op de oude route: RWS astronomisch plus de waterinfo-verwachting.
//
// Belangrijk detail, getest 15 september 2026:
//   - Groepering GETETBRKD2 zonder Grootheid geeft het TYPE ("hoogwater"/"laagwater"),
//     met Waarde_Numeriek 0 en eenheid "dimensieloos".
//   - Diezelfde groepering MET Grootheid WATHTE en Hoedanigheid NAP geeft de HOOGTE
//     in cm NAP, op exact dezelfde tijdstippen.
//   Je hebt dus beide aanroepen nodig en koppelt ze op tijdstip.
//   - Grootheid WATHTE zonder groepering geeft de gemeten stand, per 10 minuten
//     (bij Holwerd en Delfzijl per minuut).
//   - RWS geeft tijdstippen in MET (+01:00), het hele jaar door. Dat is een correcte
//     absolute tijd, new Date() rekent dat vanzelf om naar lokale tijd.

const RWS_URL =
  "https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen";

const LOCATIES = {
  // waddendata: de naam zoals die in het Tides-object van waddendata.nl staat.
  // Ontbreekt die, dan kent waddendata de locatie niet en gebruiken we RWS.
  denhelder: { label: "Den Helder", code: "denhelder.marsdiep", waddendata: "Den Helder" },
  denoever: { label: "Den Oever", code: "denoever.waddenzee.voorhaven" },
  texel: { label: "Texel", code: "texel.oudeschild" },
  harlingen: { label: "Harlingen", code: "harlingen.waddenzee", waddendata: "Harlingen" },
  vlieland: { label: "Vlieland", code: "vlieland.haven", waddendata: "Vlieland" },
  terschelling: { label: "West-Terschelling", code: "terschelling.west", waddendata: "West-Terschelling" },
  ameland: { label: "Ameland", code: "ameland.nes", waddendata: "Nes Ameland" },
  holwerd: { label: "Holwerd", code: "holwerd.veersteiger", waddendata: "Holwerd" },
  schiermonnikoog: { label: "Schiermonnikoog", code: "schiermonnikoog.waddenzee" },
  lauwersoog: { label: "Lauwersoog", code: "lauwersoog.waddenzee", waddendata: "Lauwersoog" },
  delfzijl: { label: "Delfzijl", code: "delfzijl", waddendata: "Delfzijl" },
};

// In-memory cache per locatie: getij verandert traag, geen reden om
// bij elke paginaload opnieuw bij RWS te bevragen.
const cache = {}; // { [locatieKey]: { data, fetchedAt } }
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minuten

export default async function handler(req, res) {
  const locatieKey = (req.query?.locatie || "texel").toLowerCase();
  const locatie = LOCATIES[locatieKey];

  if (!locatie) {
    return res.status(400).json({
      error: "Onbekende locatie",
      geldigeOpties: Object.keys(LOCATIES),
    });
  }

  try {
    const now = Date.now();
    const cached = cache[locatieKey];
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.status(200).json(cached.data);
    }

    const periodeStand = {
      Begindatumtijd: toRwsTijd(new Date(now - 2 * 60 * 60 * 1000)),
      Einddatumtijd: toRwsTijd(new Date(now)),
    };

    // Extremen en actuele stand parallel. De gemeten stand is nice-to-have.
    const [extremenResultaat, standen] = await Promise.all([
      haalExtremen(locatie, now),
      haalMetingen(
        locatie.code,
        { Grootheid: { Code: "WATHTE" }, Hoedanigheid: { Code: "NAP" } },
        periodeStand
      ).catch(() => []),
    ]);
    const { extremen, bronNaam } = extremenResultaat;

    const toekomstig = extremen.filter((m) => new Date(m.tijdstip).getTime() >= now);
    const volgendLaagwater = toekomstig.find((m) => m.type === "laagwater") || null;
    const volgendHoogwater = toekomstig.find((m) => m.type === "hoogwater") || null;
    // De eerstvolgende twee extremen in de volgorde waarin ze echt komen.
    // Soms is dat LW dan HW, soms HW dan LW. De interface toont ze zo.
    const komende = toekomstig.slice(0, 2);

    // Laatste geldige meting van de actuele stand.
    let actueel = null;
    for (let i = standen.length - 1; i >= 0; i--) {
      const w = standen[i]?.Meetwaarde?.Waarde_Numeriek;
      // RWS gebruikt 999999999 als "geen waarde".
      if (typeof w === "number" && Math.abs(w) < 10000 && standen[i].Tijdstip) {
        actueel = { tijdstip: standen[i].Tijdstip, waardeCm: Math.round(w) };
        break;
      }
    }

    const result = {
      locatie: locatie.label,
      locatieKey,
      opgehaaldOp: new Date().toISOString(),
      extremen,
      volgendLaagwater,
      volgendHoogwater,
      komende,
      actueel,
      // Hoeveel van de getoonde extremen uit de verwachting komen. Handig om
      // in de interface te melden welke bron er nu eigenlijk op het scherm staat.
      bron: {
        verwacht: extremen.filter((e) => e.bron === "verwacht").length,
        astronomisch: extremen.filter((e) => e.bron === "astronomisch").length,
      },
      bronNaam,
      licentie:
        bronNaam === "waddendata"
          ? "Getij: waddendata.nl (data Rijkswaterstaat). Actuele stand: RWS WaterWebservices (CC0)."
          : "Getij: Rijkswaterstaat WaterWebservices (CC0) en waterinfo.rws.nl.",
    };

    cache[locatieKey] = { data: result, fetchedAt: now };
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).json(result);
  } catch (err) {
    console.error("Getij-ophalen mislukt:", err);
    return res.status(502).json({
      error: "Kon getijgegevens niet ophalen",
      detail: String(err.message || err),
    });
  }
}

async function haalExtremen(locatie, now) {
  // Eerst waddendata. Lukt dat niet, of kent waddendata deze locatie niet,
  // dan de oude RWS-route.
  if (locatie.waddendata) {
    try {
      const extremen = await extremenUitWaddendata(locatie.waddendata);
      if (extremen.length) return { extremen, bronNaam: "waddendata" };
      console.warn(`waddendata gaf geen extremen voor ${locatie.waddendata}`);
    } catch (e) {
      console.warn("waddendata niet beschikbaar, terugval op RWS:", e.message);
    }
  }
  return { extremen: await extremenUitRws(locatie.code, now), bronNaam: "rws" };
}

// ---------- waddendata.nl ----------

const WADDENDATA_WS = "wss://data.waddendata.nl";
const WADDENDATA_TTL_MS = 10 * 60 * 1000;
const WADDENDATA_TIMEOUT_MS = 8000;
// Eén snapshot bevat alle locaties, dus één gedeelde cache. De lopende
// promise bewaren we ook, zodat gelijktijdige verzoeken één verbinding delen.
let waddendataCache = null; // { tides, fetchedAt }
let waddendataBezig = null;

async function haalWaddendataTides() {
  if (waddendataCache && Date.now() - waddendataCache.fetchedAt < WADDENDATA_TTL_MS) {
    return waddendataCache.tides;
  }
  if (!waddendataBezig) {
    waddendataBezig = leesWaddendataSnapshot()
      .then((snapshot) => {
        if (!snapshot?.Tides || typeof snapshot.Tides !== "object") {
          throw new Error("snapshot zonder Tides");
        }
        waddendataCache = { tides: snapshot.Tides, fetchedAt: Date.now() };
        return snapshot.Tides;
      })
      .finally(() => { waddendataBezig = null; });
  }
  return waddendataBezig;
}

async function leesWaddendataSnapshot() {
  // Node 22+ heeft WebSocket ingebouwd. Op oudere Node proberen we het
  // pakket "ws"; ontbreekt dat ook, dan faalt dit netjes en valt de
  // handler terug op RWS.
  const WS = globalThis.WebSocket ?? (await import("ws")).default;

  return new Promise((resolve, reject) => {
    // Zonder Origin-header weigert waddendata de verbinding (getest 8 okt 2026).
    // Zowel de ingebouwde WebSocket van Node (undici) als het pakket "ws"
    // accepteren headers als tweede argument.
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
    const timer = setTimeout(
      () => klaar(new Error("waddendata gaf geen antwoord binnen 8 s")),
      WADDENDATA_TIMEOUT_MS
    );
    ws.onmessage = (bericht) => {
      try {
        klaar(null, JSON.parse(typeof bericht.data === "string" ? bericht.data : String(bericht.data)));
      } catch (e) {
        klaar(new Error("waddendata stuurde geen geldige JSON"));
      }
    };
    ws.onerror = () => klaar(new Error("waddendata WebSocket-fout"));
  });
}

async function extremenUitWaddendata(naam) {
  const tides = await haalWaddendataTides();
  const rij = tides[naam];
  // Vorm: [ [regio, code], [ { date, unix_date, water_height, tide,
  //         date_predict, water_height_predict }, ... ] ]
  // Let op: date en date_predict zijn Nederlandse kloktijd zonder offset,
  // unix_date is wel een echte UTC-tijd. date_predict_unix is ondanks de naam
  // ook een tekstdatum, die negeren we.
  const lijst = Array.isArray(rij?.[1]) ? rij[1] : [];

  return lijst
    .map((e) => {
      const type = e.tide === "HW" ? "hoogwater" : e.tide === "LW" ? "laagwater" : null;
      const astroTijd = Number.isFinite(e.unix_date)
        ? new Date(e.unix_date * 1000)
        : nlTekstNaarDate(e.date);
      const astroCm = Number.isFinite(Number(e.water_height)) ? Math.round(Number(e.water_height)) : null;
      const verwTijd = nlTekstNaarDate(e.date_predict);
      const verwCmRuw = e.water_height_predict;
      const verwCm = verwCmRuw !== "" && verwCmRuw != null && Number.isFinite(Number(verwCmRuw))
        ? Math.round(Number(verwCmRuw))
        : null;
      const heeftVerwachting = verwTijd && verwCm != null;

      return {
        tijdstip: (heeftVerwachting ? verwTijd : astroTijd)?.toISOString() ?? null,
        type,
        waardeCm: heeftVerwachting ? verwCm : astroCm,
        astronomischTijdstip: astroTijd?.toISOString() ?? null,
        astronomischCm: astroCm,
        bron: heeftVerwachting ? "verwacht" : "astronomisch",
        verschilCm: heeftVerwachting && astroCm != null ? verwCm - astroCm : 0,
      };
    })
    .filter((m) => m.tijdstip && m.type)
    .sort((a, b) => new Date(a.tijdstip) - new Date(b.tijdstip));
}

function nlTekstNaarDate(tekst) {
  // "2026-10-08 08:30" in Nederlandse kloktijd naar een echte Date.
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(tekst || ""));
  if (!m) return null;
  return nlNaarDate(+m[1], +m[2], +m[3], +m[4], +m[5]);
}

// ---------- RWS (terugval) ----------

async function extremenUitRws(code, now) {
  const periodeGetij = {
    Begindatumtijd: toRwsTijd(new Date(now - 12 * 60 * 60 * 1000)),
    Einddatumtijd: toRwsTijd(new Date(now + 96 * 60 * 60 * 1000)), // 4 dagen vooruit
  };

  const [typen, hoogtes] = await Promise.all([
    haalMetingen(code, { Groepering: { Code: "GETETBRKD2" } }, periodeGetij),
    haalMetingen(
      code,
      {
        Grootheid: { Code: "WATHTE" },
        Groepering: { Code: "GETETBRKD2" },
        Hoedanigheid: { Code: "NAP" },
      },
      periodeGetij
    ),
  ]);

  // Hoogtes per tijdstip, zodat we ze aan het juiste extreem kunnen koppelen.
  const hoogtePerTijd = new Map();
  for (const m of hoogtes) {
    const w = m.Meetwaarde?.Waarde_Numeriek;
    if (m.Tijdstip && typeof w === "number") hoogtePerTijd.set(m.Tijdstip, Math.round(w));
  }

  const extremen = typen
    .map((m) => ({
      tijdstip: m.Tijdstip,
      type: m.Meetwaarde?.Waarde_Alfanumeriek, // "hoogwater" | "laagwater"
      waardeCm: hoogtePerTijd.has(m.Tijdstip) ? hoogtePerTijd.get(m.Tijdstip) : null,
      astronomischTijdstip: m.Tijdstip,
      astronomischCm: hoogtePerTijd.has(m.Tijdstip) ? hoogtePerTijd.get(m.Tijdstip) : null,
      bron: "astronomisch",
      verschilCm: 0,
    }))
    .filter((m) => m.tijdstip && m.type)
    .sort((a, b) => new Date(a.tijdstip) - new Date(b.tijdstip));

  // Verwachte extremen uit het RWS-stromingsmodel eroverheen leggen.
  const verwachteExtremen = await haalVerwachting(code).catch((e) => {
    console.warn("Verwachting niet beschikbaar:", e.message);
    return [];
  });
  voegVerwachtingSamen(extremen, verwachteExtremen);
  return extremen;
}

async function haalMetingen(code, aquoMetadata, periode) {
  const response = await fetch(RWS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Locatie: { Code: code },
      AquoPlusWaarnemingMetadata: { AquoMetadata: aquoMetadata },
      Periode: periode,
    }),
  });

  // 204 betekent: verzoek klopt, maar er is geen data voor deze combinatie.
  if (response.status === 204) return [];
  if (!response.ok) throw new Error(`RWS gaf status ${response.status}`);

  const tekst = await response.text();
  if (!tekst) return [];
  const json = JSON.parse(tekst);
  return json?.WaarnemingenLijst?.[0]?.MetingenLijst || [];
}

const WATERINFO_URL =
  "https://waterinfo.rws.nl/api/chart/get?mapType=waterhoogte&locationCodes=";

async function haalVerwachting(code) {
  // Deze endpoint accepteert alleen vaste vensters. "-48,48" werkt, "-24,24"
  // niet. Het einde ligt hoe dan ook op de horizon van het model, ongeveer
  // 48 uur vooruit. De CSV heeft zes kolommen:
  //   datum ; tijd (NL) ; locatie ; gemeten ; verwacht ; astronomisch
  const res = await fetch(WATERINFO_URL + encodeURIComponent(code) + "&values=-48,48", {
    headers: { "User-Agent": "wadoversteken.nl getij-widget (contact via wadoversteken.nl)" },
  });
  if (!res.ok) throw new Error(`waterinfo gaf status ${res.status}`);

  const csv = await res.text();
  const regels = csv.split("\n");
  const kop = (regels.shift() || "").split(";");

  // De kop belooft negen kolommen, drie reeksen met elk een "Extremen"-kolom,
  // maar die extremenkolommen komen altijd leeg terug en ontbreken in de
  // datarijen. Daarom tellen we in de kop hoeveel echte datakolommen er vóór
  // "verwachting" staan, in plaats van de positie hard in te bakken. Gaat RWS
  // die kolommen ooit vullen, dan blijft dit kloppen.
  let kolom = -1;
  let teller = 0;
  for (const naam of kop) {
    const n = naam.toLowerCase();
    if (n.startsWith("extremen")) continue;
    if (n.includes("verwachting")) { kolom = teller; break; }
    teller++;
  }
  if (kolom === -1) throw new Error("kolom verwachting niet gevonden in de CSV-kop");

  const reeks = [];
  for (const regel of regels) {
    const k = regel.trim().split(";");
    if (k.length <= kolom || !k[kolom]) continue;
    const [dd, mm, jjjj] = k[0].split("-").map(Number);
    const [uu, min] = k[1].split(":").map(Number);
    if (!jjjj || Number.isNaN(uu)) continue;
    reeks.push({ tijd: nlNaarDate(jjjj, mm, dd, uu, min), waarde: Number(k[kolom]) });
  }
  if (reeks.length < 5) return [];

  return zoekExtremen(reeks);
}

function zoekExtremen(reeks) {
  // De reeks staat per 10 minuten. Een punt is een extreem als het over een uur
  // aan weerszijden het hoogste of laagste is. Daarna verfijnen we het moment
  // met een parabool door de drie punten rond de top, zodat we niet aan het
  // raster van 10 minuten vastzitten.
  const VENSTER = 6; // 6 punten is 60 minuten
  const RAND    = 2; // aan het begin en eind is twee punten genoeg
  const uit = [];

  for (let i = RAND; i < reeks.length - RAND; i++) {
    // Het venster wordt bij de randen van de reeks eenzijdig ingekort. De
    // verwachting begint namelijk pas rond het huidige moment, en juist het
    // eerstvolgende extreem is het belangrijkste op het scherm. Met een vast
    // venster van een uur viel dat er steeds buiten.
    const van  = Math.max(0, i - VENSTER);
    const tot  = Math.min(reeks.length - 1, i + VENSTER);
    const v = reeks[i].waarde;
    let hoogste = true;
    let laagste = true;
    for (let j = van; j <= tot; j++) {
      if (j === i) continue;
      if (reeks[j].waarde > v) hoogste = false;
      if (reeks[j].waarde < v) laagste = false;
    }
    if (!hoogste && !laagste) continue;
    if (uit.length && reeks[i].tijd - uit[uit.length - 1].tijdstipMs < 3 * 60 * 60 * 1000) continue;

    const y0 = reeks[i - 1].waarde;
    const y1 = v;
    const y2 = reeks[i + 1].waarde;
    const noemer = y0 - 2 * y1 + y2;
    // Verschuiving in stappen van 10 minuten, begrensd op een halve stap.
    let delta = noemer === 0 ? 0 : (0.5 * (y0 - y2)) / noemer;
    if (!Number.isFinite(delta) || Math.abs(delta) > 0.5) delta = 0;

    const tijdstipMs = reeks[i].tijd.getTime() + delta * 10 * 60 * 1000;
    const top = y1 - 0.25 * (y0 - y2) * delta;

    uit.push({
      tijdstipMs,
      type: hoogste ? "hoogwater" : "laagwater",
      waardeCm: Math.round(top),
    });
  }
  return uit;
}

function voegVerwachtingSamen(extremen, verwacht) {
  // Een astronomisch extreem en het bijbehorende verwachte extreem liggen dicht
  // bij elkaar. Opzet verschuift het moment hooguit een klein uur, dus zoeken we
  // binnen 90 minuten naar de dichtstbijzijnde van hetzelfde type.
  const MARGE_MS = 90 * 60 * 1000;

  for (const e of extremen) {
    const doel = new Date(e.tijdstip).getTime();
    let beste = null;
    let besteAfstand = MARGE_MS;

    for (const v of verwacht) {
      if (v.type !== e.type) continue;
      const afstand = Math.abs(v.tijdstipMs - doel);
      if (afstand < besteAfstand) {
        besteAfstand = afstand;
        beste = v;
      }
    }
    if (!beste) continue;

    e.tijdstip = new Date(beste.tijdstipMs).toISOString();
    e.waardeCm = beste.waardeCm;
    e.bron = "verwacht";
    e.verschilCm = e.astronomischCm == null ? null : beste.waardeCm - e.astronomischCm;
  }
  extremen.sort((a, b) => new Date(a.tijdstip) - new Date(b.tijdstip));
}

function nlNaarDate(jaar, maand, dag, uur, minuut) {
  // De CSV geeft Nederlandse kloktijd zonder offset. Zonder library bepalen we
  // de offset door een eerste gok terug te rekenen via Intl, en die correctie
  // toe te passen. Tweemaal, zodat ook de nacht van de klokwissel klopt.
  let ms = Date.UTC(jaar, maand - 1, dag, uur, minuut);
  for (let ronde = 0; ronde < 2; ronde++) {
    ms = Date.UTC(jaar, maand - 1, dag, uur, minuut) - nlOffset(new Date(ms));
  }
  return new Date(ms);
}

function nlOffset(datum) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Amsterdam",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const d = {};
  for (const deel of fmt.formatToParts(datum)) d[deel.type] = deel.value;
  const alsUtc = Date.UTC(d.year, d.month - 1, d.day, d.hour % 24, d.minute, d.second);
  return alsUtc - datum.getTime();
}

function toRwsTijd(date) {
  // RWS accepteert gewoon UTC met een "+00:00"-suffix en rekent zelf om.
  return date.toISOString().replace("Z", "+00:00");
}

export { LOCATIES };
