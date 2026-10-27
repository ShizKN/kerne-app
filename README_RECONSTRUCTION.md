# KERNE — reconstruction locale

Cette copie de travail combine la dernière sauvegarde GitHub disponible avec la page d'accueil récente enregistrée sur cet ordinateur. Elle n'est pas le code exact de `kerne.apospace.com`. Les deux dépôts téléchargés dans les dossiers `archive-github-*` restent intacts.

## Démarrer

Node.js 18 ou plus récent est nécessaire.

```sh
npm ci
npm test
npm start
```

Ouvrir ensuite `http://localhost:3000`. Les salles publiques et les salles privées à code de six chiffres acceptent au plus quatre personnes. Le serveur garde les salles et les messages en mémoire ; un redémarrage efface cet état. Les codes privés sont des liens de partage pratiques, pas une authentification forte.

## Vidéo entre réseaux différents

Sans configuration supplémentaire, KERNE utilise le STUN gratuit de Cloudflare. Cela ne suffit pas sur tous les réseaux. Pour activer Cloudflare Realtime TURN, copier `.env.example` vers `.env` et renseigner `TURN_KEY_ID` et `TURN_KEY_API_TOKEN` avant `npm start`. La clé durable reste sur le serveur ; le navigateur reçoit seulement des identifiants temporaires. Les anciens identifiants TURN présents dans la sauvegarde GitHub ne sont plus utilisés dans cette reconstruction et devraient être révoqués s'ils sont encore actifs.

Documentation officielle : [création d'identifiants TURN](https://developers.cloudflare.com/realtime/turn/generate-credentials/) ; [tarifs Realtime](https://developers.cloudflare.com/realtime/sfu/pricing/).

Le navigateur recrée sa connexion de salle quand le réseau change ou quand la liaison vidéo échoue. Le serveur écarte les anciens participants et le client recharge leurs noms et flux à la reconnexion. Le test automatisé simule la déconnexion et le retour d'un participant ; le passage physique Wi‑Fi → 5G reste à vérifier sur deux appareils après mise en ligne.

## Hébergement

Cette version utilise un serveur Node.js pour les salles, le chat et la signalisation WebRTC. Un simple dépôt de fichiers statiques sur Cloudflare Pages ne lance pas `server.js`. Il faut héberger ce serveur sur une plateforme Node.js accessible en HTTPS, ou porter sa logique vers une solution Cloudflare adaptée. Ne pas remplacer le site public actuel avant un test complet sur deux appareils et deux réseaux.
