// sw.js
// Service worker: zorgt dat de pagina ook zonder bereik opent.
//
// Wat hij bewaart:
//   - de pagina zelf (index.html) en de favicons
//   - de achtergrondfoto en het beeldmerk van dutchdredging.nl
// Wat hij NIET doet:
//   - de API's (/api/...). Die bewaart de pagina zelf in de browser, met
//     tijdstempel, zodat hij kan laten zien hoe oud de gegevens zijn.
//
// De pagina: eerst het netwerk proberen (zodat je altijd de nieuwste versie
// krijgt), en pas na 5 seconden zonder antwoord de bewaarde versie tonen.
//
// Pas je de lijst of de aanpak hier aan, verhoog dan VERSIE. Dan ruimt de
// browser de oude bewaarde bestanden vanzelf op.

const VERSIE = "v1";
const PAGINA = `pagina-${VERSIE}`;
const BEELD = `beeld-${VERSIE}`;
const NETWERK_TIMEOUT_MS = 5000;

const VASTE_BESTANDEN = ["/", "/favicon.ico", "/favicon-32.png", "/apple-touch-icon.png"];
const BEELD_HOSTS = ["www.dutchdredging.nl"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PAGINA).then((cache) =>
      // Los toevoegen: ontbreekt er één (bijv. een favicon), dan gaat de rest door.
      Promise.all(VASTE_BESTANDEN.map((url) => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((namen) => Promise.all(
        namen.filter((n) => n !== PAGINA && n !== BEELD).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // De pagina zelf.
  if (req.mode === "navigate") {
    event.respondWith(netwerkEerst(req, "/"));
    return;
  }

  // API's laten we met rust, die regelt de pagina.
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) return;

  // Favicons en andere vaste bestanden van je eigen site.
  if (url.origin === self.location.origin && VASTE_BESTANDEN.includes(url.pathname)) {
    event.respondWith(netwerkEerst(req, url.pathname));
    return;
  }

  // Foto en beeldmerk van De Boer: uit het geheugen als het kan, en op de
  // achtergrond bijwerken.
  if (BEELD_HOSTS.includes(url.hostname)) {
    event.respondWith(geheugenEerst(req));
  }
});

async function netwerkEerst(req, sleutel) {
  const cache = await caches.open(PAGINA);
  const netwerk = fetch(req).then((res) => {
    if (res.ok) cache.put(sleutel, res.clone());
    return res;
  });
  try {
    return await Promise.race([
      netwerk,
      new Promise((_, nee) => setTimeout(() => nee(new Error("timeout")), NETWERK_TIMEOUT_MS)),
    ]);
  } catch {
    const bewaard = await cache.match(sleutel);
    if (bewaard) return bewaard;
    return netwerk; // niets bewaard: dan toch op het netwerk wachten
  }
}

async function geheugenEerst(req) {
  const cache = await caches.open(BEELD);
  const bewaard = await cache.match(req);
  const netwerk = fetch(req)
    .then((res) => {
      // Afbeeldingen van een andere site komen "opaque" binnen (status 0).
      // Die mogen we bewaren, maar we kunnen de inhoud niet controleren.
      if (res.ok || res.type === "opaque") cache.put(req, res.clone());
      return res;
    })
    .catch(() => bewaard);
  return bewaard || netwerk;
}
