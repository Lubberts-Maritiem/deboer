// api/marifoon.js
// Haalt het actuele marifoonbericht op van knmi.nl en filtert de secties
// die de sectoren "Texel" en "Harlingen" bevatten.
//
// Draait als Vercel serverless function. Nodig omdat dit server-side moet
// gebeuren (nette scraping-etiquette, geen browser-CORS-gedoe, en zodat de
// site niet bij elke bezoeker opnieuw knmi.nl belast).

const SOURCE_URL = "https://www.knmi.nl/nederland-nu/maritiem/marifoon";

// Elke locatie uit het getij-menu hoort bij één marifoon-sector.
// Bron: KNMI deelt Texel en Harlingen soms samen in (bijv. 's nachts),
// maar overdag vaak apart met een eigen tekst per sector.
const LOCATIE_SECTOR = {
  denhelder: "texel",
  denoever: "texel",
  texel: "texel",
  harlingen: "harlingen",
  vlieland: "harlingen",
  terschelling: "harlingen",
  ameland: "harlingen",
  holwerd: "harlingen",
  schiermonnikoog: "harlingen",
  lauwersoog: "harlingen",
  delfzijl: "delfzijl",
};

// In-memory cache per sector: het bericht wisselt maar 4x per dag,
// dus we hoeven niet bij elke request opnieuw te scrapen.
const cache = {}; // { [sector]: { data, fetchedAt } }
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minuten

export default async function handler(req, res) {
  const locatieKey = (req.query?.locatie || "texel").toLowerCase();
  const sector = LOCATIE_SECTOR[locatieKey] || "texel";

  try {
    const now = Date.now();
    const cached = cache[sector];
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.status(200).json(cached.data);
    }

    const response = await fetch(SOURCE_URL, {
      headers: {
        // Nette, herkenbare user-agent. Geen misleiding, geen browser-spoofing.
        "User-Agent": "wadoversteken.nl marifoon-widget (contact via wadoversteken.nl)",
      },
    });

    if (!response.ok) {
      throw new Error(`KNMI-pagina gaf status ${response.status}`);
    }

    const html = await response.text();
    const result = parseMarifoonHtml(html, new Date(), sector);

    cache[sector] = { data: result, fetchedAt: now };
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).json(result);
  } catch (err) {
    console.error("Marifoon-scrape mislukt:", err);
    return res.status(502).json({
      error: "Kon marifoonbericht niet ophalen",
      detail: String(err.message || err),
    });
  }
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function parseMarifoonHtml(html, nu, sector) {
  // De KNMI-pagina rendert elk district-blok als:
  //   <h2>Kop van de sectie (bijv. "Verwachting geldig van ... tot ..."):</h2>
  //   <p><i>Districtsnamen</i><br>Verwachtingstekst.</p>
  //   <p><i>Andere districtsnamen</i><br>Andere tekst.</p>
  //   ...
  // We lopen door de HTML op volgorde, zodat elk <p>-blok gekoppeld blijft
  // aan de meest recente <h2>-kop erboven.
  //
  // Belangrijk: Texel en Harlingen hebben soms een EIGEN tekst (overdag) en
  // soms een gedeelde tekst (bijv. 's nachts, blok "Texel Harlingen"). We
  // filteren daarom op precies de gevraagde sector, niet op "Texel of
  // Harlingen" samen, anders pakken we altijd de eerst gevonden van de twee.

  const opgesteldMatch = html.match(/Opgesteld:\s*([^<]+)</i);
  const opgesteld = opgesteldMatch ? decodeEntities(opgesteldMatch[1]) : null;

  const volgendMatch = html.match(/Een volgend bericht[^<]*</i);
  const volgendBericht = volgendMatch ? decodeEntities(volgendMatch[0].replace(/<$/, "")) : null;

  // Alle koppen (<h2>) en districtsblokken (<p><i>...) in volgorde van voorkomen,
  // met hun positie in de string, zodat we ze kunnen interleaven.
  const tokens = [];
  const h2Re = /<h2[^>]*>([^<]*)<\/h2>/gi;
  const blokRe = /<p><i>([^<]+)<\/i><br\s*\/?>([^<]+)<\/p>/gi;

  let m;
  while ((m = h2Re.exec(html))) {
    tokens.push({ type: "kop", pos: m.index, tekst: decodeEntities(m[1]) });
  }
  while ((m = blokRe.exec(html))) {
    tokens.push({
      type: "blok",
      pos: m.index,
      districten: decodeEntities(m[1]),
      tekst: decodeEntities(m[2]),
    });
  }
  tokens.sort((a, b) => a.pos - b.pos);

  const sectorRegex = new RegExp(`\\b${sector}\\b`, "i");
  let huidigeKop = "";
  const gevonden = [];
  for (const token of tokens) {
    if (token.type === "kop") {
      huidigeKop = token.tekst;
      continue;
    }
    if (sectorRegex.test(token.districten)) {
      gevonden.push({
        periode: huidigeKop.replace(/:$/, ""),
        districten: token.districten,
        tekst: token.tekst,
      });
    }
  }

  const alleVerwachtingen = gevonden.filter((g) =>
    /^verwachting geldig/i.test(g.periode)
  );

  // Elke periode heeft de vorm "Verwachting geldig van <start> tot <eind>".
  // We parsen start/eind terug naar een Date, zodat we kunnen bepalen welke
  // periode nu geldig is. "nu" komt als parameter binnen (testbaar, en
  // consistent met de rest van deze functie-aanroep).
  const metTijden = alleVerwachtingen.map((v) => {
    const bereik = parsePeriodeBereik(v.periode, nu);
    return { ...v, ...bereik };
  });

  let huidige = metTijden.find(
    (v) => v.start && v.eind && nu >= v.start && nu < v.eind
  );
  // Als door afronding/tijdzone geen exacte match lukt: pak de periode die
  // net begonnen is (start in het verleden, dichtstbij).
  if (!huidige) {
    huidige = metTijden
      .filter((v) => v.start && v.start <= nu)
      .sort((a, b) => b.start - a.start)[0];
  }
  // Nog steeds niets (bijv. bericht net ververst): val terug op de eerste.
  if (!huidige) {
    huidige = metTijden[0];
  }

  return {
    bron: SOURCE_URL,
    opgehaaldOp: new Date().toISOString(),
    opgesteld,
    sector,
    districten: huidige ? huidige.districten : null,
    // Alleen de kale tekst die nu geldt voor de gekozen sector, geen
    // periode-label of andere metadata.
    tekst: huidige ? huidige.tekst : null,
    volgendBericht,
    licentie: "Bron: KNMI (knmi.nl). Automatisch overgenomen, geen officiële distributie.",
  };
}

function parsePeriodeBereik(periodeTekst, referentie) {
  // "Verwachting geldig van zaterdag 20:00 tot zondag 08:00"
  const m = periodeTekst.match(
    /van\s+(\w+)\s+(\d{1,2}):(\d{2})\s+tot\s+(\w+)\s+(\d{1,2}):(\d{2})/i
  );
  if (!m) return { start: null, eind: null };

  const dagen = [
    "zondag",
    "maandag",
    "dinsdag",
    "woensdag",
    "donderdag",
    "vrijdag",
    "zaterdag",
  ];
  const [, dagStartNaam, uStart, mStart, dagEindNaam, uEind, mEind] = m;

  const naarDatum = (dagNaam, uur, minuut) => {
    const doelDag = dagen.indexOf(dagNaam.toLowerCase());
    if (doelDag === -1) return null;
    // Zoek de meest recente datum (vandaag of eerder deze week terug/vooruit,
    // max 6 dagen) die op deze weekdag valt, dicht bij "referentie".
    const d = new Date(referentie);
    for (let offset = -3; offset <= 3; offset++) {
      const kandidaat = new Date(referentie);
      kandidaat.setDate(referentie.getDate() + offset);
      if (kandidaat.getDay() === doelDag) {
        kandidaat.setHours(Number(uur), Number(minuut), 0, 0);
        return kandidaat;
      }
    }
    return d;
  };

  let start = naarDatum(dagStartNaam, uStart, mStart);
  let eind = naarDatum(dagEindNaam, uEind, mEind);
  if (start && eind && eind <= start) {
    eind = new Date(eind.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  return { start, eind };
}
