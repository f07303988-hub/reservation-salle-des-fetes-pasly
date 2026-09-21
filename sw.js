/* Service worker — Réservations de la salle des fêtes
 *
 * Rôle : permettre d'ouvrir l'appli même sans réseau.
 * Stratégie : réseau d'abord, avec une copie en cache en secours.
 *   - En ligne, la dernière version publiée est toujours servie, et la copie est mise à jour.
 *   - Hors ligne (ou réseau trop lent), la dernière copie connue est servie : après 4 s pour la page, 3 s pour le manifeste et
 *     les icônes, et seulement s'il existe une copie locale (sans copie, on attend le réseau au lieu d'échouer).
 * Les fiches et documents sont chiffrés dans IndexedDB : ils ne passent jamais par ici.
 *
 * Ce fichier doit rester dans le même dossier que index.html.
 * VERSION est calculée automatiquement à partir du contenu publié (outil stamp-version.py) : elle change à chaque publication,
 * ce qui recharge la liste des fichiers préchargés et supprime les anciennes copies sur tous les appareils.
 * Ne pas la modifier à la main : relancer « python3 stamp-version.py » après toute modification du dossier.
 */
const VERSION = 'sdf-resa-2667ae3d';
const NAV_TIMEOUT_MS = 4000;    // page : au-delà, on préfère la copie locale à une page qui n'ouvre pas
const ASSET_TIMEOUT_MS = 3000;  // manifeste, icônes… (quelques Ko) : même principe, mais seulement s'il existe une copie locale

// Indispensable : la page et le manifeste. Si l'un des deux manque, l'installation échoue.
const SHELL = ['./', 'manifest.webmanifest'];
// Icônes déclarées par le manifeste (192, 512, 512 « maskable ») et par la page (icône iOS). Le navigateur ne les demande qu'au moment
// d'installer l'appli sur l'écran d'accueil : sans préchargement elles manquent hors ligne. Ajoutées une à une, pour qu'une icône
// absente du dossier n'empêche jamais l'installation de la page elle-même (cache.addAll échoue en bloc au premier fichier manquant).
// Si vous ajoutez ou renommez une icône dans le manifeste, mettez cette liste à jour (puis relancez stamp-version.py).
const ICONS = ['icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then(async (cache) => {
        await cache.addAll(SHELL);
        await Promise.all(ICONS.map((u) => cache.add(u).catch(() => {})));
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fetchWithTimeout(request, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(request, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const isNav = req.mode === 'navigate';
    // Ressource déjà en cache : on peut se permettre de lâcher un réseau trop lent. Sans copie locale, on n'abandonne jamais :
    // mieux vaut attendre le réseau que de renvoyer une erreur.
    const local = isNav ? null : await cache.match(req, { ignoreSearch: true });
    try {
      const res = isNav ? await fetchWithTimeout(req, NAV_TIMEOUT_MS)
                : local ? await fetchWithTimeout(req, ASSET_TIMEOUT_MS)
                : await fetch(req);
      if (res && res.status === 200 && res.type === 'basic') {
        event.waitUntil(cache.put(req, res.clone()));
      }
      return res;
    } catch (err) {
      const hit = local || await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
