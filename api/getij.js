// api/getij.js
// Haalt het eerstvolgende laagwater en hoogwater op bij Rijkswaterstaat
// (WaterWebservices, astronomisch getij) voor een van de 10 vaste locaties.
//
// Moet server-side, want deze RWS-API staat geen browseraanroepen toe (geen CORS).

const RWS_URL =
  "https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen";

// RWS-locatiecodes per keuze in het menu. Getest tegen de groepering
// GETETBRKD2 (astronomisch getijextreem, HW/LW), 12 september 2026.
const LOCATIES = {
  denhelder: { label: "Den Helder", code: "denhelder.marsdiep" },
  denoever: { label: "Den Oever", code: "denoever.waddenzee.voorhaven" },
  texel: { label: "Texel", code: "texel.oudeschild" },
  harlingen: { label: "Harlingen", code: "harlingen.waddenzee" },
  vlieland: { label: "Vlieland", code: "vlieland.haven" },
  terschelling: { label: "Terschelling", code: "terschelling.west" },
  ameland: { label: "Ameland", code: "ameland.nes" },
  holwerd: { label: "Holwerd", code: "holwerd.veersteiger" },
  schiermonnikoog: { label: "Schiermonnikoog", code: "schiermonnikoog.waddenzee" },
  lauwersoog: { label: "Lauwersoog", code: "lauwersoog.waddenzee" },
  delfzijl: { label: "Delfzijl", code: "delfzijl" },
};

// In-memory cache per locatie: getij verandert traag, geen reden om
// bij elke paginaload opnieuw bij RWS te bevragen.
const cache = {}; // { [locatieKey]: { data, fetchedAt } }
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minuten

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

    const begin = new Date(now - 12 * 60 * 60 * 1000); // 12u terug, voor context
    const eind = new Date(now + 48 * 60 * 60 * 1000); // 48u vooruit, ruim genoeg

    const body = {
      Locatie: { Code: locatie.code },
      AquoPlusWaarnemingMetadata: {
        AquoMetadata: { Groepering: { Code: "GETETBRKD2" } },
      },
      Periode: {
        Begindatumtijd: toRwsTijd(begin),
        Einddatumtijd: toRwsTijd(eind),
      },
    };

    const response = await fetch(RWS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`RWS gaf status ${response.status}`);
    }

    const json = await response.json();
    const metingen = json?.WaarnemingenLijst?.[0]?.MetingenLijst || [];

    const alle = metingen
      .map((m) => ({
        tijdstip: m.Tijdstip,
        type: m.Meetwaarde?.Waarde_Alfanumeriek, // "hoogwater" | "laagwater"
      }))
      .filter((m) => m.tijdstip && m.type)
      .sort((a, b) => new Date(a.tijdstip) - new Date(b.tijdstip));

    const toekomstig = alle.filter((m) => new Date(m.tijdstip).getTime() >= now);
    const volgendLaagwater = toekomstig.find((m) => m.type === "laagwater") || null;
    const volgendHoogwater = toekomstig.find((m) => m.type === "hoogwater") || null;

    const result = {
      locatie: locatie.label,
      locatieKey,
      opgehaaldOp: new Date().toISOString(),
      volgendLaagwater,
      volgendHoogwater,
      licentie: "Bron: Rijkswaterstaat WaterWebservices (CC0), astronomisch getij.",
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

function toRwsTijd(date) {
  // RWS verwacht bijv. "2026-09-12T00:00:00.000+02:00". We werken in
  // Europe/Amsterdam-lokale tijd is lastig zonder library, dus we geven
  // gewoon UTC met een "+00:00"-suffix; RWS accepteert dat prima.
  return date.toISOString().replace("Z", "+00:00");
}

export { LOCATIES };
