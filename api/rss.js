// api/rss.js
// RSS-feed met het marifoonbericht, het getij en NAP West-Terschelling +50 cm.
//
// Gebruik: /api/rss                 (getij bij Harlingen, net als de pagina)
//          /api/rss?locatie=texel
//
// Dit bestand haalt niets zelf bij RWS of waddendata op. Het vraagt de drie
// bestaande API's van je eigen site op, zodat alle logica op één plek blijft.
//
// Over de items:
//   Een serverless functie heeft geen geheugen, dus de feed bevat steeds één
//   item: de huidige stand. RSS-lezers bewaren zelf de oude items. Een item
//   is "nieuw" als de guid verandert. Die guid is gebaseerd op de tekst van
//   het marifoonbericht plus het eerstvolgende getij (type en astronomisch
//   tijdstip, dat schuift niet mee met de verwachting). Je krijgt dus een
//   nieuw item bij een nieuw bericht, en verder ongeveer elke 6 uur als een
//   HW of LW voorbij is. Kleine bijstellingen van de verwachting maken geen
//   nieuw item.

import { createHash } from "node:crypto";

const LOCATIES = [
  "denhelder", "denoever", "texel", "harlingen", "vlieland", "terschelling",
  "ameland", "holwerd", "schiermonnikoog", "lauwersoog", "delfzijl",
];
const TIJDZONE = "Europe/Amsterdam"; // de server draait in UTC

export default async function handler(req, res) {
  const locatie = String(req.query?.locatie || "harlingen").toLowerCase();
  if (!LOCATIES.includes(locatie)) {
    return res.status(400).json({ error: "Onbekende locatie", geldigeOpties: LOCATIES });
  }

  const proto = req.headers["x-forwarded-proto"] || "https";
  const basis = `${proto}://${req.headers.host}`;
  const q = `locatie=${encodeURIComponent(locatie)}`;

  // Elk onderdeel mag apart falen; de feed toont dan wat er wel is.
  const [marifoon, getij, drempel] = await Promise.all([
    haalJson(`${basis}/api/marifoon?${q}`),
    haalJson(`${basis}/api/getij?${q}`),
    haalJson(`${basis}/api/drempel`),
  ]);

  const berichtTekst = marifoon?.tekst || "";
  const getijRegel = maakGetijRegel(getij);
  const drempelRegel = maakDrempelRegel(drempel);

  const eerste = getij?.komende?.[0];
  const guidBron = [
    berichtTekst,
    eerste ? `${eerste.type}|${eerste.astronomischTijdstip || eerste.tijdstip}` : "",
  ].join("\n");
  const guid = createHash("sha1").update(guidBron).digest("hex").slice(0, 16);

  // Publicatiedatum: het laatst gepasseerde extreem, anders nu. Zo blijft de
  // datum van een item gelijk zolang het item hetzelfde is.
  const nu = Date.now();
  const verleden = (getij?.extremen || []).filter((e) => new Date(e.tijdstip).getTime() < nu);
  const pubDate = new Date(verleden.length ? verleden[verleden.length - 1].tijdstip : nu);

  const titel = [
    "Marifoonbericht",
    ...(getij?.komende || []).map((e) => `${e.type === "hoogwater" ? "HW" : "LW"} ${tijd(e.tijdstip)}`),
  ].join(", ");

  const regels = [
    berichtTekst || "Geen actueel marifoonbericht beschikbaar.",
    getijRegel,
    drempelRegel,
  ].filter(Boolean);
  const beschrijving = regels.map((r) => `<p>${escapeXml(r)}</p>`).join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Marifoonbericht, sector Texel &amp; Harlingen</title>
  <link>${escapeXml(basis + "/")}</link>
  <atom:link href="${escapeXml(`${basis}/api/rss?${q}`)}" rel="self" type="application/rss+xml" />
  <description>Marifoonbericht met getij (${escapeXml(getij?.locatie || locatie)}) en NAP West-Terschelling +50 cm.</description>
  <language>nl-nl</language>
  <ttl>15</ttl>
  <lastBuildDate>${new Date(nu).toUTCString()}</lastBuildDate>
  <item>
    <title>${escapeXml(titel)}</title>
    <link>${escapeXml(basis + "/")}</link>
    <guid isPermaLink="false">${locatie}-${guid}</guid>
    <pubDate>${pubDate.toUTCString()}</pubDate>
    <description><![CDATA[${beschrijving.replaceAll("]]>", "]]]]><![CDATA[>")}]]></description>
  </item>
</channel>
</rss>
`;

  res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.status(200).send(xml);
}

async function haalJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const d = await r.json();
    return r.ok && !d.error ? d : null;
  } catch (e) {
    console.warn("RSS: kon niet ophalen", url, e.message);
    return null;
  }
}

function maakGetijRegel(getij) {
  if (!getij?.komende?.length) return "Getijgegevens niet beschikbaar.";
  const delen = getij.komende.map((e) => {
    const label = e.type === "hoogwater" ? "HW" : "LW";
    return `${label}: ${tijd(e.tijdstip)}${cm(e.waardeCm)}`;
  });
  return `${getij.locatie}, ${delen.join(", ")}`;
}

function maakDrempelRegel(d) {
  if (!d) return "";
  const kop = `NAP ${d.locatie} +${d.niveauCm} cm`;
  if (!d.komende?.length) {
    return `${kop}: ${d.nuBoven ? "blijft erboven" : "wordt niet gehaald"} binnen de verwachting.`;
  }
  return `${kop}: ${d.komende.map((k) => `${k.richting} ${tijd(k.tijdstip)}`).join(", ")}`;
}

function tijd(iso) {
  if (!iso) return "onbekend";
  return new Date(iso).toLocaleString("nl-NL", {
    timeZone: TIJDZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function cm(w) {
  if (w == null || !Number.isFinite(w)) return "";
  return ` (${w > 0 ? "+" : w < 0 ? "\u2212" : ""}${Math.abs(w)} cm)`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
