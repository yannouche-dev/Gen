# Videogen — génération vidéo sur GPU Vast.ai, pilotée depuis ton téléphone

Interface web statique (GitHub Pages) qui **loue, configure, surveille et arrête** une machine GPU sur
[Vast.ai](https://vast.ai), y installe **ComfyUI** et les modèles vidéo, puis te laisse générer des vidéos
**LTX-2.5**, **Wan 2.2** et **HunyuanVideo 1.5** depuis le navigateur.
Le **Studio BD** fabrique aussi des bandes dessinées : personnages de référence cohérents de case en case
(FLUX.2 Dev), histoire découpée en pages par une IA locale (Qwen 3.5), bulles en français, export PDF/CBZ.

Tes clés se saisissent **uniquement dans l'interface**, une fois. Elles restent chiffrées dans ton navigateur.
Au quotidien : **Démarrer → Générer → Arrêter**.

---

## Sommaire

1. [Architecture](#1-architecture)
2. [Contenu du dépôt](#2-contenu-du-dépôt)
3. [Première configuration (une seule fois)](#3-première-configuration-une-seule-fois)
4. [Checklist du premier test réel (sur mobile)](#4-checklist-du-premier-test-réel-sur-mobile)
5. [Usage quotidien](#5-usage-quotidien)
6. [Studio BD](#6-studio-bd)
7. [Coûts](#7-coûts)
8. [Modèles disponibles et ajout d'un modèle](#8-modèles-disponibles-et-ajout-dun-modèle)
9. [Dépannage](#9-dépannage)
10. [Sécurité : risques et protections](#10-sécurité--risques-et-protections)
11. [Développement et tests](#11-développement-et-tests)
12. [Ce qui a été vérifié, ce qui ne l'a pas été](#12-ce-qui-a-été-vérifié-ce-qui-ne-la-pas-été)

---

## 1. Architecture

```
Téléphone ─ GitHub Pages (application statique, CSP stricte, aucun script tiers)
  │  coffre chiffré AES-GCM (clé dérivée PBKDF2 de ta phrase de passe) dans localStorage
  │
  ├─HTTPS→ Cloudflare Worker « videogen-vast-proxy » ─→ API REST Vast.ai (+ lecture des logs S3)
  │         (l'API Vast n'envoie pas d'en-têtes CORS : un navigateur ne peut pas l'appeler directement)
  │
  ├─HTTPS→ huggingface.co/api/whoami-v2 (test du token à la saisie)
  │
  └─HTTPS/WSS→ https://xxxx.trycloudflare.com   ← tunnel Cloudflare ouvert PAR l'instance
                 cloudflared → Caddy 127.0.0.1:28080 (exige « Authorization: Bearer <jeton> »
                                                     ou « ?token= » pour le WebSocket ; CORS = ton origine)
                    ├ /videogen/* → agent.py : étapes, % de téléchargement, suppression des sorties, watchdog
                    └ /*          → ComfyUI 127.0.0.1:28188 (--enable-cors-header <ton origine>)
```

**Le chemin d'un clic sur « Démarrer » :**

1. L'interface cherche une instance portant le label `videogen`.
   - **S'il y en a une arrêtée**, elle propose de la redémarrer : les modèles sont déjà sur son disque.
   - **Sinon**, elle cherche des offres (`POST /api/v0/bundles/`) selon tes réglages. Tu choisis une offre, l'interface affiche le prix et demande confirmation.
2. Location (`PUT /api/v0/asks/{id}/`) avec :
   - une image PyTorch CUDA 12.8+ ;
   - une **amorce `onstart`** de moins de 4 000 caractères ;
   - les variables d'environnement `HF_TOKEN`, `COMFY_ACCESS_TOKEN` (généré dans le navigateur avec `crypto.getRandomValues`), `ALLOWED_ORIGIN`, `IDLE_MINUTES`, `MAX_HOURS`, `MODELS` et `COMFY_VERSION`.
   - **Ta clé API Vast n'est jamais transmise à l'instance.**
3. L'amorce télécharge les scripts de `instance/` depuis ce dépôt (`raw.githubusercontent.com`), **au commit exact de l'interface déployée**. Elle vérifie leurs **empreintes SHA-256**, intégrées au build, avant d'exécuter quoi que ce soit.
4. `instance/onstart.sh` s'exécute ensuite :
   - il installe Caddy et cloudflared, téléchargés en versions figées et vérifiés par SHA-256 ;
   - il lance l'agent et Caddy, puis ouvre le tunnel ;
   - il publie l'URL dans les logs du conteneur (`VIDEOGEN_TUNNEL_URL=…`) ;
   - il installe ou met à jour ComfyUI (tag figé), le lance, puis télécharge **uniquement les poids manquants** avec `hf download`.
5. L'interface lit les logs via l'API Vast et récupère l'URL **sans copier-coller**. Elle affiche ensuite les étapes détaillées fournies par l'agent : machine louée, conteneur, tunnel, ComfyUI, modèles (%), prêt.
6. **Watchdog** (sur l'instance) : arrêt si la file ComfyUI est vide depuis `IDLE_MINUTES` (20 par défaut) ou si l'instance tourne depuis plus de `MAX_HOURS` (4 par défaut).
   - L'arrêt passe par la clé **restreinte** que Vast injecte dans chaque conteneur (`CONTAINER_API_KEY`). Elle ne peut que démarrer, arrêter ou détruire **cette** instance.
   - Si cette clé manque, le dernier recours est d'éteindre le conteneur (PID 1). Vast ne documente pas clairement si cela arrête la facturation du GPU : vérifie dans la console.
   - Le décompte d'inactivité ne commence qu'une fois les téléchargements terminés.

## 2. Contenu du dépôt

```
web/                     Interface (Vite + TypeScript, sans framework)
  index.html             CSP injectée au build
  src/core/              coffre chiffré (vault), Journal masqué, HTTP, réglages
  src/vast/              client Vast, offres, amorce onstart, cycle de vie de l'instance
  src/comfy/             client ComfyUI (REST + WebSocket), génération, erreurs lisibles
  src/workflows/         construction des requêtes /prompt à partir de models.json
  src/media/             galerie (Blob en mémoire), dernière image, ffmpeg.wasm
  src/comic/             Studio BD : gabarits, prompts, requêtes FLUX.2/Qwen, stockage chiffré, rendu, PDF/CBZ
  src/ui/                écrans : Instance, Générer, BD, Galerie, Journal, Clés
  public/workflows/      workflows ComfyUI au format API (convertis des templates officiels)
  public/models.json     correspondance nœuds/champs, options supportées, valeurs par défaut
worker/                  Cloudflare Worker (proxy Vast sans état) + wrangler.jsonc
instance/
  onstart.sh             installation et lancement sur la machine GPU
  agent.py               statut, progression, suppression des sorties, LoRA Hugging Face, watchdog
  Caddyfile              reverse proxy : jeton obligatoire, CORS, jeton masqué dans les logs
  weights.json           poids à télécharger par famille (générés depuis les templates)
mocks/                   faux Vast + Hugging Face, faux ComfyUI + agent, vidéos de test
tests/unit/              Vitest : coffre, masquage, Worker, workflows, amorce onstart (exécutée)
tests/e2e/               Playwright (Pixel 7) : parcours complet et erreurs contre les mocks
tests/instance/          agent.py (faux Vast/HF/ComfyUI) et vrai Caddy
tools/                   conversion des templates officiels, validation contre un vrai ComfyUI
.github/workflows/       deploy.yml (Pages), ci.yml (tests + gitleaks), worker.yml (wrangler)
```

## 3. Première configuration (une seule fois)

Tout se fait depuis le navigateur du téléphone. Sur github.com, les **Réglages (Settings)** d'un dépôt ne
s'affichent parfois qu'en « version ordinateur » : dans le menu du navigateur, coche *Version pour ordinateur*.

### 3.1 Activer GitHub Pages

1. Dépôt → **Settings → Pages**.
2. *Build and deployment → Source* : choisis **GitHub Actions**.
3. Onglet **Actions** → workflow **« Déployer l'interface (GitHub Pages) »** → **Run workflow**. Il se lance aussi seul à chaque push sur `main`.
4. À la fin, l'adresse du site s'affiche, par exemple `https://yannouche-dev.github.io/Gen/`. Ajoute-la à ton écran d'accueil.

### 3.2 Déployer le proxy Vast (Cloudflare Worker)

1. Crée un compte gratuit sur [dash.cloudflare.com](https://dash.cloudflare.com). Ouvre une fois **Workers & Pages** : cela crée ton sous-domaine `xxx.workers.dev`, nécessaire au premier déploiement.
2. **Account ID** : visible dans **Workers & Pages** (colonne de droite) ou dans l'URL du tableau de bord.
3. **Jeton API** : *My Profile → API Tokens → Create Token*, modèle **« Edit Cloudflare Workers »**, ton compte, puis *Create Token*. Copie-le : il ne sera plus affiché.
4. Sur GitHub : dépôt → **Settings → Secrets and variables → Actions → New repository secret**.
   - `CLOUDFLARE_API_TOKEN` = le jeton ;
   - `CLOUDFLARE_ACCOUNT_ID` = l'Account ID.
5. **Actions → « Déployer le proxy Vast (Cloudflare Worker) » → Run workflow.**
6. Ouvre l'exécution terminée : le **résumé** affiche l'URL du proxy, du type `https://videogen-vast-proxy.xxx.workers.dev`. Garde-la pour l'écran Clés.
7. *Facultatif, plus strict :* ajoute une **variable** (onglet *Variables*, pas *Secrets*) `VAST_PROXY_URL` avec cette URL, puis relance le déploiement de l'interface. La CSP n'autorisera alors que ce Worker, au lieu de tout `*.workers.dev`.

Le Worker n'accepte que l'origine `https://<propriétaire>.github.io`. Il ne relaie que 7 routes Vast, plus la lecture des logs S3. Il ne journalise rien : l'observabilité est désactivée dans `worker/wrangler.jsonc`, et le code ne contient aucun `console.log`.

### 3.3 Clé API Vast.ai (restreinte, recommandé)

1. [cloud.vast.ai](https://cloud.vast.ai) → crédite ton compte (*Billing*).
2. *Keys* → **nouvelle clé API**. Coche seulement les permissions nécessaires :
   - **instance read** et **instance write** (louer, démarrer, arrêter, détruire, lire les logs) ;
   - **user read** (crédit) ;
   - **misc** (recherche d'offres).
3. Ne coche **pas** *billing*. Une clé volée dans le navigateur ne pourrait alors ni changer ta facturation ni créer d'autres clés.

### 3.4 Token Hugging Face

1. Va sur [huggingface.co/Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5) et **accepte la licence**. Le dépôt est protégé : sans cette acceptation, le téléchargement échoue.
2. *Settings → Access Tokens → Create new token* → type **Fine-grained**. Coche **« Read access to contents of all public gated repos you can access »**. C'est tout ce dont l'instance a besoin.

### 3.5 Saisie dans l'interface

Ouvre le site → écran **Clés** :

1. **URL du proxy** (étape 3.2), **clé Vast**, **token Hugging Face**.
2. Touche **Tester** sur chaque ligne. Le résultat attendu :
   - pour Vast : « OK — compte …, crédit … $ » ;
   - pour Hugging Face : « OK — ton_nom … · accès à Lightricks/LTX-2.5 : OK ».
3. Choisis une **phrase de passe** (8 caractères minimum), puis **Enregistrer**.
   - **Mémoriser dans ce navigateur (chiffré)** coché : les clés sont chiffrées dans localStorage, et ta phrase de passe est demandée à chaque ouverture.
   - Décoché : les clés restent **en mémoire seulement** et disparaissent à la fermeture de l'onglet.

## 4. Checklist du premier test réel (sur mobile)

Coche au fur et à mesure. Si une étape échoue : onglet **Journal → Copier**, puis colle-moi le texte. Les clés
y sont masquées automatiquement.

**A. Clés**
- [ ] Le site s'ouvre. L'écran **Clés** affiche l'URL du proxy, ou tu la saisis.
- [ ] *Tester* (Vast) répond « OK — compte …, crédit … $ ».
- [ ] *Tester* (Hugging Face) répond « OK — … » et « accès à Lightricks/LTX-2.5 : OK ».
  - Si tu vois « non vérifiable depuis le navigateur », ce n'est pas bloquant : l'instance vérifiera elle-même.
- [ ] *Enregistrer*. L'onglet **Instance** s'affiche, avec « Aucune instance ».
- [ ] Ferme et rouvre le site : l'écran **Déverrouiller** demande ta phrase de passe.

**B. Démarrage**
- [ ] **Premier test rapide et peu coûteux (conseillé) :** dans **Réglages de location → Modèles à installer**, décoche
  LTX-2.5 **et les deux familles Studio BD**, puis coche **« Test minimal : Wan 2.1 1.3B »** (≈ 10 Go au lieu de
  ≈ 118 Go). Coche plutôt **« Test léger : Wan 2.2 5B »** (≈ 18 Go) pour tester aussi **Prolonger**. Tu peux baisser le
  **disque à 60 Go**. Pour le vrai usage, recoche LTX-2.5 et le Studio BD, et loue une nouvelle instance.
- [ ] Sinon, dans **Réglages de location**, laisse les valeurs par défaut :
  - 1 GPU, RTX PRO 6000 puis RTX 5090 ;
  - fiabilité ≥ 99 % et débit ≥ 500 Mb/s ;
  - disque 200 Go et modèles **LTX-2.5 + Studio BD** (FLUX.2 Dev et Qwen 3.5), ≈ 118 Go ;
  - prix max 2,5 $/h, à ajuster.
- [ ] **Démarrer** : une liste d'offres apparaît, RTX PRO 6000 en tête si disponibles.
- [ ] Touche une offre. La fenêtre **Confirmer la location** affiche le prix, puis **Louer à …**.
- [ ] Le bandeau orange « Instance allumée · durée · coût » apparaît en haut.
- [ ] Les étapes avancent. Durées indicatives pour un **premier** démarrage, environ 20 à 40 min en tout :
  - ✓ Machine louée ;
  - ✓ Conteneur démarré (téléchargement de l'image, souvent 3 à 10 min) ;
  - ✓ Accès HTTPS sécurisé (tunnel) ;
  - ✓ ComfyUI installé et lancé (3 à 8 min) ;
  - Modèles téléchargés : **%** en direct, environ 118 Go avec les familles par défaut (52 Go pour LTX-2.5 seul) ;
  - ✓ Prêt.

**C. Première génération**

Avec la famille de test : modèle **Wan 2.1 1.3B · Texte → vidéo (test)**, 480p, 2 s. Avec LTX-2.5, suis les étapes ci-dessous.

**Génération LTX-2.5 (courte, 720p)**
- [ ] Onglet **Générer**. Modèle **LTX-2.5 · Texte → vidéo**. Wan et Hunyuan apparaissent « absent du serveur » : c'est normal, ils ne sont pas installés.
- [ ] Résolution **720p**, format **16:9** (1280 × 704), durée **3 s**, 24 i/s.
- [ ] Prompt, par exemple : `A red fox trotting through fresh snow at sunrise, cinematic tracking shot`.
- [ ] **Générer**. Le statut, la barre de progression, l'étape en cours et les aperçus s'affichent.
- [ ] La vidéo s'affiche dans le navigateur. **Télécharger** l'enregistre sur le téléphone.
- [ ] *(Facultatif)* **Prolonger** : la dernière image passe en I2V. **Galerie → Assembler** produit la vidéo complète.

**D. Arrêt**
- [ ] Onglet **Instance → Arrêter (garder le disque)** → confirmer. L'état passe à **Arrêtée** et le bandeau disparaît.
- [ ] Sur [cloud.vast.ai/instances](https://cloud.vast.ai/instances/), l'instance `videogen` est **Stopped**. Le GPU n'est plus facturé, le stockage l'est encore.
- [ ] *(Pour ne plus rien payer)* **Détruire l'instance** → confirmer. Dans la console Vast, l'instance disparaît.

## 5. Usage quotidien

1. Ouvre le site et saisis ta phrase de passe.
2. **Instance → Démarrer**. Si l'instance est arrêtée, elle redémarre et les modèles sont déjà là (quelques minutes). Sinon, choisis une offre.
3. **Générer** : choisis le modèle. Seules les options que ce modèle supporte s'affichent :
   - prompt, et prompt négatif s'il existe ;
   - résolution (480p à 1080p selon le modèle) et format 16:9, 9:16 ou 1:1 ;
   - durée et images par seconde ;
   - steps et CFG (Wan, Hunyuan) ; mode rapide LoRA 4 étapes (Wan) ; amélioration du prompt (LTX) ;
   - seed fixe ou aléatoire ;
   - image de début et/ou de fin.

   **Préréglages** : *Enregistrer* garde les réglages du formulaire, sans les images, dans ce navigateur.
4. **File d'attente (GPU au maximum)** : *Générer* envoie la vidéo, et toutes ses variantes, **immédiatement** dans la
   file de ComfyUI sur l'instance. Pendant qu'elle tourne, tu peux écrire un autre prompt et appuyer sur
   **Ajouter à la file** : le GPU enchaîne les vidéos sans aucun temps mort, même téléphone verrouillé.
   La file s'affiche sous la génération en cours (position de chaque vidéo, ✕ pour en retirer une, *Vider la file*).
   Chaque vidéo arrive dans la Galerie dès qu'elle est prête (16 vidéos en attente au plus).
   **Annuler** interrompt la génération en cours sur le serveur.
5. **Galerie** :
   - miniatures, réglages et seed de chaque vidéo ;
   - **Rejouer** (mêmes réglages et même seed), **Prolonger**, **Télécharger**, **Supprimer** ;
   - **Timeline** : ordre réglable avec ↑ et ↓, puis **Assembler** avec ffmpeg.wasm, chargé à la demande depuis le site (≈ 32 Mo).
6. Les vidéos ne vivent **que dans l'onglet**, en mémoire : télécharge celles que tu veux garder. Les fichiers sont supprimés de l'instance dès qu'ils ont été récupérés.

   **Téléphone en veille :** la génération tourne sur l'instance, pas dans le téléphone. Tu peux verrouiller l'écran :
   - au réveil, le suivi reprend tout seul et la vidéo est récupérée ;
   - si le navigateur a fermé l'onglet, la génération en cours est reprise à la réouverture, après déverrouillage ;
   - une vidéo non récupérée reste sur l'instance, même après un arrêt automatique : redémarre l'instance pour la récupérer.

   L'écran reste allumé pendant le démarrage et les générations, si le navigateur le permet.
7. **Toutes tes instances Vast** sont listées en haut de l'onglet Instance, quel que soit leur label, y compris celles
   d'autres projets ou créées depuis la console Vast. Les instances **allumées** (GPU facturé) apparaissent en premier,
   en rouge, avec **Arrêter** et **Détruire**. La liste suit toutes les pages de l'API et se vérifie **chaque minute**
   et à chaque retour sur l'onglet. Le bandeau du haut passe en alerte dès qu'une instance est allumée, et le
   navigateur te prévient si tu fermes l'onglet.
8. **Arrête** quand tu as fini. Sinon le watchdog le fera après 20 min de file vide, ou après 4 h au maximum.
9. Si tu fermes l'onglet alors qu'une instance tourne, le navigateur te le rappelle.

**Options du modèle (vue Générer).** Sous le choix du modèle, des étiquettes résument ce qu'il sait faire : durées,
images par seconde, résolutions, son, images de début, intermédiaire et de fin, steps/CFG. Ensuite :

- **Assistant de prompt** : des boutons ajoutent au prompt des formules en anglais pour la caméra (plan fixe,
  travelling, orbite, drone…), le cadrage, la lumière et le style, et, pour LTX-2.5, le son (ambiance, musique,
  dialogue entre guillemets). Il rappelle aussi l'ordre de description conseillé.
- **Options LTX-2.5** :
  - **Améliorer le prompt** : Gemma réécrit ton prompt, et le prompt réellement utilisé s'affiche avec le résultat
    et dans la Galerie. Un curseur règle sa **créativité**.
  - **Son généré** : LTX-2.5 crée la bande-son avec l'image. Décoché, la vidéo est muette.
  - **Fidélité à l'image de début** (image → vidéo) : haut, la vidéo colle à l'image ; bas, plus de mouvement.
  - **Force des images clés** (modèle « Images clés »).
- **Image clé intermédiaire** (LTX-2.5 · Images clés) : en plus des images de début et de fin, une image placée à
  l'instant de ton choix. Elle est insérée dans la chaîne officielle de guides `LTXVAddGuide`.
- **Nombre de vidéos** : jusqu'à 8 variantes, toutes envoyées d'un coup dans la file. La seed est aléatoire pour chacune, ou seed fixe, +1, +2…
- Toutes ces options sont enregistrées dans les **préréglages**.

**Prolonger une vidéo** : la dernière image est extraite dans le navigateur, avec `<video>` + canvas, et ffmpeg.wasm en
repli (utile sur Safari iOS). Le modèle image → vidéo de la même famille est pré-rempli, ainsi que le prompt, la
résolution et la durée. Le résultat se place juste après l'original dans la timeline.

## 6. Studio BD

Onglet **BD** : une bande dessinée complète, de l'histoire aux planches, avec **tes personnages** dessinés de façon
cohérente sur chaque case.

Les deux familles du Studio BD sont **cochées par défaut** dans *Instance → Réglages de location*, avec LTX-2.5
(tes anciens réglages restés sur « LTX-2.5 seul » ont été mis à jour ; un choix personnel, comme une famille de test,
est respecté) :

| Famille | Rôle | Poids |
|---|---|---|
| **Studio BD : FLUX.2 Dev** | dessine les cases ; jusqu'à 4 images de référence par case | ≈ 57 Go : FLUX.2 Dev fp8, encodeur Mistral 3 Small fp8, VAE FLUX.2, LoRA Turbo |
| **Studio BD : IA d'écriture Qwen 3.5 4B** | découpe l'histoire, décrit tes personnages | ≈ 9 Go |

Le disque par défaut passe à **200 Go** (LTX-2.5 + Studio BD). Décoche LTX-2.5 si tu ne fais que de la BD. Prends de préférence un GPU de **48 Go ou plus** (RTX PRO 6000) : sur 32 Go
(RTX 5090), ComfyUI décharge une partie du modèle en mémoire système, ce qui marche mais plus lentement.

**BD express : un titre suffit** (étape *Histoire*). Exemple : « La libraire veut rendre son mari jaloux », 3 pages,
ton *Vaudeville*, puis **Créer la BD**. Tout s'enchaîne :

1. Qwen 3.5 écrit la **bible** de l'histoire : synopsis, résumé de chaque page (début, rebondissement, chute),
   personnages avec leur description physique, décors récurrents. Tes personnages existants restent les héros.
2. Qwen 3.5 **découpe** chaque page en cases en suivant ce plan, avec des règles de continuité : mêmes tenues,
   même heure du jour dans une scène, chaque case suit la précédente. Il écrit aussi les dialogues en français.
3. Les dessins partent **tous d'un coup dans la file de l'instance** :
   - un travail « Planches » : la planche de poses de chaque personnage sans photo et l'image de chaque décor ;
   - puis **un travail par page** : toutes ses cases, avec les planches et décors branchés comme références.

   Tu peux verrouiller le téléphone : le GPU enchaîne tout, et les images se rangent dans le projet au réveil.

Les planches et décors dessinés deviennent les références des personnages et des décors. Ils servent ensuite à
chaque case régénérée : **mêmes visages, mêmes lieux, même style** sur toute la BD.

**Contenu :** romance, séduction, jalousie et sous-entendus, oui. L'IA d'écriture reçoit la consigne de ne pas aller
jusqu'à la nudité ou au contenu sexuel explicite. Le Studio BD ne propose pas de mode explicite, puisqu'il sait
reproduire un visage à partir d'une photo.

**Étapes (dans l'onglet BD) :**

1. **Projet** : *Nouveau*. Tes projets sont rangés **dans le téléphone** (IndexedDB), **chiffrés** en AES-GCM avec
   une clé aléatoire gardée dans le coffre. Sans la phrase de passe, ils sont illisibles. *Tout effacer* (écran Clés)
   les supprime aussi. Avec « ne pas mémoriser », les projets ne survivent pas à la fermeture de l'onglet.
2. **Personnages** : pour chacun, un nom et **1 à 3 images de référence** nettes (visage et tenue visibles).
   - **Décrire avec l'IA** : Qwen 3.5 regarde l'image et écrit une description précise (âge, cheveux, tenue,
     couleurs…). Tu peux la corriger.
   - **Planche de poses** : FLUX.2 dessine le personnage de face, de trois quarts, de profil et de dos. La planche
     est ajoutée à ses références, ce qui renforce la cohérence.
   - **Sans photo** : *Dessiner d'après la description*. Le dessin obtenu devient la référence du personnage.
   **Décors** : les lieux qui reviennent (nom, description, photo ou *Dessiner le décor*). Leur image est envoyée
   comme référence pour chaque case qui s'y passe.
3. **Style** : franco-belge, manga, comics, webtoon, aquarelle, polar, cartoon, réaliste, plus tes précisions.
   - **Image de style** (facultative) : une case d'un album dont tu veux le trait et les couleurs, mais pas le contenu.
   - **Rapide** : FLUX.2 Turbo, 8 étapes. Décoche-le pour la version finale (20 étapes).
4. **Histoire** : écris le synopsis, choisis 1 à 8 pages, puis **Découper avec l'IA**. Qwen 3.5 propose les pages
   et les cases (3 à 6 par page), le cadrage, les personnages présents, les **dialogues et récitatifs en français**.
5. **Pages** : aperçu de la planche, mise en page (8 gabarits, de la pleine page au gaufrier de 6), et pour
   chaque case : description, personnages présents, décor, cadrage et bulles (réplique, pensée, récitatif).
   - **Générer les cases vides** envoie toute la page en **un seul travail** dans la file de l'instance ;
     **Générer toutes les pages** fait de même pour toute la BD ; **Régénérer** refait une case avec une nouvelle seed.
   - Chaque case est générée **au format exact de son emplacement** (≈ 1 mégapixel).
   - Les bulles se déplacent au doigt avec la poignée ✥.
6. **Export** : **PDF A4**, **CBZ** (liseuses de BD, avec `ComicInfo.xml`) ou **PNG** page par page. Les fichiers
   sont fabriqués dans le téléphone.

**Comment la cohérence est obtenue.** Pour chaque case, les images de référence des personnages présents, et du
décor, sont envoyées à FLUX.2 Dev par sa chaîne officielle `ReferenceLatent` (4 au plus). Ordre de priorité :

1. la 1ʳᵉ image de chaque personnage ;
2. l'image du décor ;
3. les autres images des personnages (planche de poses…) ;
4. l'image de style.

Le prompt relie chaque nom à ses références (« Léa is the character shown in reference images 1 and 3… »), rappelle
sa description, et demande de garder les murs, meubles et couleurs du décor. Les seeds dérivent d'une seed de projet :
une planche dessinée dans le graphe d'une page est identique à celle du travail « Planches », et ComfyUI la reprend
de son cache au lieu de la recalculer.

**Le texte n'est jamais dessiné par le modèle.** Les bulles sont tracées par le navigateur avec la police libre
Comic Neue (OFL), servie par le site. Les accents sont donc exacts, et une faute se corrige sans régénérer l'image.

**Téléphone en veille :** comme pour les vidéos, une case en cours continue sur l'instance. Elle est récupérée au
réveil, ou à la réouverture de l'onglet, et rangée dans son projet. Les images sont supprimées de l'instance dès
qu'elles sont récupérées. Les images de référence envoyées sont effacées au bout de 2 h.

**Licence :** FLUX.2 [dev] est publié par Black Forest Labs sous une **licence non commerciale**. Lis-la avant tout
usage commercial de tes planches.

### LoRA (Hugging Face)

Une LoRA ajuste le modèle sans le remplacer : un style de dessin, un mouvement de caméra, un trait d'encre…
Elles viennent **uniquement de Hugging Face** et marchent avec **LTX-2.5** (onglet Générer) et **FLUX.2 Dev**
(Style du Studio BD).

1. **Instance → LoRA** (instance prête) : colle le lien Hugging Face.
   - Lien d'un fichier (`…/blob/main/fichier.safetensors`) : installé directement.
   - Lien d'un dépôt : la liste de ses fichiers `.safetensors` s'affiche, choisis-en un.
   - **Faite pour** : LTX-2.5 ou FLUX.2 Dev, deviné d'après le nom, à corriger si besoin.
2. L'instance la télécharge avec ton token HF (dépôts privés ou à licence compris), avec la progression. Elle est
   utilisable **aussitôt**, sans redémarrage.
3. **Générer** (modèles LTX-2.5) : section *LoRA*, jusqu'à 3, chacune avec sa **force** (−1 à 2, 1 par défaut).
   **Studio BD → Style** : *LoRA de style*, appliquée à **toutes** les images du projet (cases, planches, décors).
   Les LoRA sont gardées dans les préréglages.
4. Les LoRA restent sur le disque de l'instance tant qu'elle existe. Ce navigateur se souvient de leurs liens :
   sur une nouvelle instance, **Réinstaller mes LoRA** les retélécharge. *Supprimer* efface le fichier et l'oublie.

Techniquement, l'interface insère des nœuds officiels `LoraLoaderModelOnly` entre le chargement du modèle et ses
utilisateurs. Pour FLUX.2, ils sont placés avant la LoRA Turbo du template. Toutes ces combinaisons ont été validées
contre ComfyUI v0.44.2.

**Limites :**
- Une LoRA ne marche que sur le modèle pour lequel elle a été entraînée : une LoRA LTX-2 (19B) ou FLUX.1 ne
  marchera pas sur LTX-2.5 ou FLUX.2.
- Les IC-LoRA de Lightricks (contrôle, upscaler…) demandent leurs propres workflows : elles ne sont pas prises en charge.
- LTX-2.5 est en int8 : l'application de LoRA sur ces poids n'a pas pu être vérifiée sur GPU. Ce sera à confirmer
  à ta première LoRA LTX.
- **Sécurité** : liens `huggingface.co` uniquement ; fichiers `.safetensors` seulement, avec en-tête vérifié (jamais
  de pickle) ; 6 Go au plus ; noms nettoyés, rangés dans `models/loras/videogen/`.

## 7. Coûts

| Poste | Quand | Ordre de grandeur |
|---|---|---|
| GPU + machine (`dph_total`) | à la seconde, **tant que l'instance tourne** (y compris pendant l'installation) | affiché sur chaque offre et dans la confirmation ; RTX PRO 6000 plus chère que RTX 5090 |
| Stockage du disque | **tout le temps** tant que l'instance existe, **même arrêtée** | affiché dans l'onglet Instance quand elle est arrêtée (≈ prix/Go/mois × taille ÷ 30 par jour) |
| Bande passante | selon l'hôte (certains facturent le téléchargement) | le 1er démarrage télécharge ≈ 118 Go avec les familles par défaut (LTX-2.5 ≈ 52 Go + Studio BD ≈ 66 Go), environ 70 Go de plus pour Wan, 45 Go pour Hunyuan ; familles de test : ≈ 10 Go (Wan 2.1 1.3B) ou ≈ 18 Go (Wan 2.2 5B) ; Studio BD : ≈ 57 Go (FLUX.2 Dev) + 9 Go (Qwen 3.5) |

- **Le bandeau de coût** en haut de l'écran donne la durée allumée et le coût estimé de la session (prix/h × durée).
- **Le crédit Vast restant** est affiché dans l'onglet Instance.
- **Arrêter** coupe le coût GPU et garde les modèles : le prochain démarrage est rapide, mais le stockage reste facturé. **Détruire** coupe tout, et le prochain démarrage retélécharge les modèles.
- **Le watchdog** (20 min de file vide, 4 h maximum) se règle dans *Réglages de location*. La valeur 0 le désactive (déconseillé).
- **Une instance arrêtée peut ne pas redémarrer** si quelqu'un d'autre loue le GPU entre-temps : elle reste en attente. Détruis-la et loue une autre offre.

## 8. Modèles disponibles et ajout d'un modèle

Les workflows sont **convertis des templates officiels ComfyUI** (paquet `comfyui-workflow-templates` 0.11.103,
installé avec ComfyUI v0.44.2), sans modification. La conversion passe par le frontend officiel (« Export API »).
Chaque combinaison d'options que l'interface peut produire a été **validée par un vrai ComfyUI v0.44.2**
(`tools/validate-workflows.mjs`, 98 variantes, y compris les options LTX, l'image clé intermédiaire et les LoRA).

| Id | Template officiel | Famille (poids) |
|---|---|---|
| `ltx25-t2v` | `video_ltx2_5_t2v.json` | LTX-2.5 int8 (≈ 52 Go) : transformer 22B distillé int8, encodeur Gemma 4 12B int8, VAE vidéo et audio, upscaler x2, Gemma 4 E2B (amélioration du prompt) |
| `ltx25-i2v` | `video_ltx2_5_i2v.json` | LTX-2.5 |
| `ltx25-flf2v` | `video_ltx2_5_flf2v.json` | LTX-2.5 |
| `wan22-t2v` | `video_wan2_2_14B_t2v.json` | Wan 2.2 14B fp8 (≈ 70 Go) : high et low noise T2V et I2V, LoRA lightx2v, umt5, VAE 2.1 |
| `wan22-i2v` | `video_wan2_2_14B_i2v.json` | Wan 2.2 |
| `hy15-t2v` | `video_hunyuan_video_1.5_720p_t2v.json` | HunyuanVideo 1.5 720p (≈ 45 Go) : T2V et I2V fp16, Qwen2.5-VL 7B fp8, byT5, VAE, SigCLIP |
| `hy15-i2v` | `video_hunyuan_video_1.5_720p_i2v.json` | HunyuanVideo 1.5 |
| `wan21-1.3b-t2v` | `text_to_video_wan.json` | **Test minimal** Wan 2.1 1.3B (≈ 10 Go) : modèle 1.3B fp16, umt5 fp8, VAE 2.1 ; 480p, 1 à 5 s |
| `wan22-5b-t2v` | `video_wan2_2_5B_ti2v.json` | **Test léger** Wan 2.2 5B (≈ 18 Go) : TI2V 5B fp16, umt5 fp8, VAE 2.2 ; 480p ou 720p |
| `wan22-5b-i2v` | `video_wan2_2_5B_ti2v.json`, nœud « image de début » activé (désactivé par défaut dans le template) | Test léger Wan 2.2 5B |
| `flux2-dev-ref` (Studio BD) | `image_flux2_fp8.json` ; la chaîne `ReferenceLatent` est reconstruite pour 0 à 4 références | FLUX.2 Dev (≈ 57 Go) |
| `qwen35-text` (Studio BD) | `llm_qwen3_5_text_gen.json` ; l'image est retirée quand il n'y en a pas | Qwen 3.5 4B (≈ 9 Go) |

Les noms de fichiers et les dépôts Hugging Face viennent des templates eux-mêmes (`instance/weights.json`). Pour
installer Wan ou Hunyuan, coche la famille dans *Réglages de location* **avant** de louer. Le disque est augmenté
automatiquement si besoin.

Sur une instance existante, les familles se fixent à la création. Pour en ajouter une : détruis l'instance, coche
la famille, puis loue de nouveau.

Un modèle est grisé (« absent du serveur ») si `/object_info` ne connaît pas l'un de ses nœuds ou ne liste pas l'un
de ses fichiers de poids.

**Ajouter un modèle (ex. Wan 2.2 First/Last-Frame) :**

1. Lance en local un ComfyUI **de la même version** que `COMFY_VERSION` (`instance/onstart.sh`), sur CPU :
   `python main.py --cpu --port 8188`.
2. Ajoute l'entrée dans `TEMPLATES`, en haut de `tools/convert-templates.mjs`, par exemple
   `'wan22-flf2v': ['video_wan2_2_14B_flf2v.json', 'wan22']`. Lance ensuite :
   ```
   COMFY=http://127.0.0.1:8188 TEMPLATES_DIR=<site-packages>/comfyui_workflow_templates_json/templates \
   COMFY_MODELS_DIR=<ComfyUI>/models node tools/convert-templates.mjs --placeholders
   ```
   Cela écrit `web/public/workflows/<id>.json`, met à jour `instance/weights.json` et `tests/fixtures/object_info.json`.
   `--placeholders` crée des fichiers de poids vides : aucun téléchargement n'est nécessaire.
3. Ouvre le workflow converti et repère les nœuds à piloter : primitives « Prompt », « Width », « Duration »… et `RandomNoise`, `SaveVideo`. Ajoute un bloc dans `web/public/models.json` (copie un modèle proche). Seules les options déclarées dans `params` s'affichent.
4. Vérifie avec `COMFY=http://127.0.0.1:8188 node tools/validate-workflows.mjs`, puis `npm test` et `npm run test:e2e`.
5. Pousse sur `main` : l'interface est redéployée et les nouveaux poids seront téléchargés par les **nouvelles** instances.

**Mettre à jour ComfyUI :** change `COMFY_VERSION` (`instance/onstart.sh`) et `comfyVersion`
(`web/src/core/settings.ts`, `web/public/models.json`). Reconvertis ensuite les templates (étape 2) et revalide
(étape 4). Une instance existante suit la version de son interface d'origine : détruis-la et recrée-la pour en profiter.

## 9. Dépannage

Commence toujours par **Journal → Copier** : il contient chaque requête (méthode, URL, code HTTP, durée), les
réponses d'erreur, les lignes de démarrage publiées par l'instance et, via **Logs de l'instance**, la fin de
`onstart.log`. Toute clé ou tout jeton y est masqué (ex. `vast_…a3f9`), y compris dans les URL et les en-têtes.

| Symptôme | Cause probable | Solution |
|---|---|---|
| Test Vast : « origine refusée (403) » | `ALLOWED_ORIGIN` du Worker ≠ adresse du site | Le site doit être servi depuis `https://<propriétaire>.github.io`. Relance le workflow du Worker. |
| Test Vast : « Clé refusée (401) » | clé erronée ou sans permission | Recrée la clé (§ 3.3). |
| Test Vast : « Serveur injoignable » | URL du proxy fausse, ou Worker non déployé | Vérifie l'URL (résumé du workflow Worker). |
| Aucune offre | filtres trop stricts (prix max, fiabilité, débit, CUDA ≥ 12.9) | Augmente le prix max ou baisse le débit dans *Réglages de location*. |
| « Cette offre vient d'être louée » | quelqu'un l'a prise entre-temps | Relance la recherche. |
| Bloqué sur « Conteneur démarré » | téléchargement de l'image (lent sur certains hôtes) | Patiente. Si l'état devient `exited` ou `offline` : **Détruire**, puis une autre offre. |
| Bloqué sur « Accès HTTPS (tunnel) » | QUIC (UDP) bloqué chez l'hôte : le script bascule seul en HTTP/2 ; ou logs Vast pas encore disponibles | Patiente 2 à 3 min. Le Journal montre `VIDEOGEN_STEP=tunnel:retry`. |
| Étape outils : « empreinte SHA-256 invalide » | scripts du dépôt modifiés après le build | Redéploie l'interface (push sur `main`), puis détruis et recrée l'instance. |
| Modèles : « accès refusé … accepte la licence » | licence LTX-2.5 non acceptée, ou token sans accès aux dépôts protégés | § 3.4, puis Arrêter et Démarrer (seuls les fichiers manquants sont repris). |
| Modèles : « disque insuffisant » | trop de familles pour la taille du disque | Détruis, augmente le disque, recrée. |
| « Mémoire GPU insuffisante (OOM) » | résolution ou durée trop grandes pour le GPU | Baisse la résolution ou la durée. |
| « Nœud manquant sur le serveur » | version de ComfyUI ≠ version des workflows | Remets `v0.44.2` dans les réglages, puis recrée l'instance. |
| « Instance injoignable » pendant l'usage | tunnel coupé (il change d'URL à chaque relance) | L'interface recherche seule la nouvelle URL. Sinon **Actualiser**. |
| Arrêtée toute seule | watchdog (inactivité ou durée max) | Normal. Le motif s'affiche dans l'onglet Instance. **Démarrer** pour reprendre. |
| Phrase de passe oubliée | le coffre est indéchiffrable sans elle | **Tout effacer**, puis ressaisis les clés. Tes instances Vast ne sont pas touchées. |

## 10. Sécurité : risques et protections

**Risques à connaître :**

- **Les clés vivent dans le navigateur.** Un script malveillant exécuté sur le site pourrait les lire une fois le
  coffre déverrouillé. Protections en place :
  - CSP stricte : `script-src 'self'`, aucun script tiers, aucun CDN, `connect-src` limité au proxy, à
    `huggingface.co` et à `*.trycloudflare.com` ;
  - aucune utilisation d'`innerHTML` ;
  - dépendances figées par `package-lock.json` : la seule dépendance livrée est ffmpeg.wasm ;
  - refus de s'exécuter dans une iframe ;
  - verrouillage manuel.

  Pour limiter les dégâts possibles, utilise une **clé Vast restreinte** et un **token HF en lecture seule**.
- **Même origine pour tous tes sites GitHub Pages.** Tous tes dépôts publiés sur `https://<toi>.github.io` partagent
  le même localStorage et la même origine autorisée par le Worker. Le coffre est chiffré, mais n'héberge pas de
  code non fiable sur un autre de tes sites Pages.
- **Les LoRA** sont du code de modèle tiers : installe-les depuis des dépôts de confiance. L'agent n'accepte que
  `huggingface.co`, le format `.safetensors` (en-tête vérifié, pas de pickle exécutable) et 6 Go au plus.
- **Le token Hugging Face est transmis à l'instance**, comme variable d'environnement. L'hôte Vast (un tiers) peut
  techniquement le lire, tout comme toute personne ayant ta clé Vast (`extra_env`). Utilise un token
  **fine-grained en lecture seule**, révocable à tout moment.
- **Le jeton ComfyUI** (256 bits, unique par instance) protège l'accès au tunnel. Il passe en paramètre `?token=`
  pour le WebSocket, faute de pouvoir mettre un en-tête dans un navigateur. Cloudflare termine le TLS du tunnel et
  voit donc ce paramètre. Caddy le retire avant ComfyUI et le masque dans ses journaux.
- **Le Worker voit passer ta clé Vast** (en-tête `Authorization`) à chaque appel. Il ne la stocke ni ne la
  journalise. Les membres de ton compte Cloudflare pourraient en revanche activer un suivi en direct
  (`wrangler tail`) : garde ce compte pour toi.
- **Les vidéos** ne transitent que par ton instance et ton navigateur. Elles sont supprimées de l'instance dès
  leur récupération, et purgées au-delà de 2 h. Aucune statistique ni analyse d'audience.

**Ce que fait le projet pour te protéger :**

- Ta **clé Vast principale n'est jamais envoyée à l'instance** : le watchdog utilise la clé restreinte injectée par Vast.
- Les **scripts exécutés sur la machine GPU** sont vérifiés par SHA-256, au commit exact de l'interface, ainsi que Caddy et cloudflared.
- **Aucun secret dans le dépôt** : le scan gitleaks tourne en CI à chaque push, avec une exception uniquement pour les valeurs factices des tests.

## 11. Développement et tests

Prérequis : Node 22, Python 3.10+, Chromium de Playwright.

```
npm ci
npm run typecheck          # TypeScript strict
npm test                   # Vitest : coffre, masquage, Worker, offres, workflows, amorce onstart exécutée
npm run test:e2e           # build de test + Playwright (Pixel 7) contre les mocks
python3 -m unittest discover -s tests/instance -v   # agent.py ; Caddy réel si CADDY_BIN est défini
npm run build:test && npm run mocks                 # essai manuel sur http://127.0.0.1:4173
```

Avec les mocks :
- clé Vast de test : `test-vast-key-0123456789abcdef` ;
- token Hugging Face de test : `hf_TestToken0123456789abcdef` ;
- mots-clés dans le prompt : `#oom` (manque de mémoire GPU), `#missing` (nœud manquant), `#slow` (génération longue, pour tester l'annulation).
- Studio BD : le mock renvoie une image PNG pour chaque case et un faux Qwen 3.5 (description, ou découpage JSON).

Les tests de bout en bout couvrent :
- clés et coffre : saisie, test et chiffrement des clés ; phrase de passe fausse ; verrouillage ; « ne pas mémoriser » ; tout effacer ;
- location : offres triées ; prix confirmé ; offre déjà louée ; corps de création sans clé principale ;
- démarrage : étapes jusqu'à « Prêt » ; modèles grisés ;
- génération : T2V, puis prolongation I2V à partir de la dernière image ; suppression des fichiers sur l'instance ;
- galerie : timeline réordonnée et assemblage ffmpeg.wasm ;
- erreurs : manque de mémoire GPU (OOM), nœud manquant, annulation ;
- Journal : aucun secret en clair ;
- instance : arrêt, redémarrage, destruction, reprise d'une instance arrêtée ;
- rappel avant de fermer l'onglet ;
- file d'attente vidéo : variantes envoyées d'un coup, ajout pendant le calcul, retrait d'une vidéo de la file ;
- Studio BD : projet chiffré, personnage décrit par l'IA, découpage, page en un seul travail avec références, bulles déplacées, export PDF/CBZ, persistance après rechargement, case récupérée après fermeture de l'onglet, message si FLUX.2/Qwen manque ;
- BD express : titre → bible → découpage → planches, décors et pages tous en file, onglet fermé puis rouvert, tout rangé dans le projet ;
- LoRA : installation depuis un dépôt (choix du fichier) ou un lien direct, refus d'un dépôt protégé et d'un autre site, LoRA LTX dans Générer et LoRA de style FLUX.2 dans le Studio BD (nœuds vérifiés), suppression, réinstallation sur une nouvelle instance.

Validation des requêtes BD (0 à 4 références, Qwen avec et sans image, travaux fusionnés de la BD express sur les 8 gabarits) contre un vrai ComfyUI :
`COMFY=http://127.0.0.1:8188 node tools/validate-comic.mjs`.

## 12. Ce qui a été vérifié, ce qui ne l'a pas été

**Vérifié pendant le développement :**

- **Documentation à jour (novembre 2026)** : routes et champs de l'API Vast.ai, `server.py` de ComfyUI v0.44, CLI `hf`, cloudflared, Caddy et ffmpeg.wasm.
- **Workflows** : les 10 workflows et 98 variantes d'options (LoRA comprises) sont acceptés par un vrai ComfyUI v0.44.2. Seuls des fichiers de poids vides ont été utilisés, sans GPU.
- **Studio BD** : les 32 requêtes types sont acceptées par ComfyUI v0.44.2 : FLUX.2 Dev avec 0 à 4 références et avec LoRA de style, Qwen 3.5 avec et sans image, bible, et travaux fusionnés de la BD express sur les 8 mises en page. Le PDF et le CBZ produits sont relus par des outils standards.
- **Caddyfile** : testé avec le vrai Caddy 2.11.9 (jeton, CORS, en-têtes retirés, jeton masqué dans les logs).
- **Amorce `onstart`** : exécutée réellement (téléchargement, vérification SHA-256, refus d'un fichier modifié).
- **Agent** (`agent.py`) : téléchargements, erreur de licence, watchdog et arrêt via la clé restreinte, LoRA (installation, refus d'un dépôt ou chemin invalide, d'un `.ckpt`, d'un faux safetensors, d'un fichier trop gros, suppression hors du dossier), testés contre de faux serveurs.
- **Worker** : configuration validée par `wrangler deploy --dry-run`.
- **Interface** : parcours complet testé contre les mocks.

**Non vérifiable sans tes comptes (ton premier test réel le fera) :**

- **Vast.ai réel** : le comportement de l'API, l'injection de `CONTAINER_API_KEY` dans l'image choisie, et l'exécution de `onstart` à chaque redémarrage.
- **Hugging Face depuis le navigateur** : la réponse CORS de `huggingface.co`. Si elle bloque le test, l'interface le signale et l'instance vérifie le token elle-même.
- **Génération sur GPU** : vitesse réelle et consommation mémoire des modèles sur RTX PRO 6000 ou RTX 5090.
- **Tunnel** : la stabilité des tunnels `trycloudflare.com` sur la durée.
- **Studio BD sur GPU** : temps par case, qualité de la ressemblance avec tes références, et qualité du découpage JSON de Qwen 3.5. Si la réponse de Qwen est illisible, l'interface le dit et tu peux relancer.

Si quelque chose échoue, colle-moi le **Journal** (bouton **Copier**) : je corrigerai à partir de là.
