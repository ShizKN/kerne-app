# KERNE sur Cloudflare

Cette reconstruction est conservée dans ce dossier. Le code du site public est dans `cloudflare/site` et le service temps réel dans `cloudflare/worker`.

- Pages : projet `kernee`, domaine `kerne.apospace.com`.
- Worker : `kerne-rooms-2026` avec un Durable Object pour les salles et les tableaux blancs.
- TURN : les secrets `TURN_KEY_ID` et `TURN_KEY_API_TOKEN` sont enregistrés dans le Worker Cloudflare. Ne jamais les ajouter au dépôt ni au site statique.

Pour publier après une modification :

```sh
cd /Users/yassine/Desktop/Kerne/kerne-reconstruction/cloudflare/worker
npm ci
npm run check
npm run deploy
cd /Users/yassine/Desktop/Kerne/kerne-reconstruction
./cloudflare/worker/node_modules/.bin/wrangler pages deploy cloudflare/site --project-name kernee --branch main
```

La branche Pages `kerne-rebuild` sert aux essais. Le Worker autorise seulement le domaine public, les aperçus du projet `kernee` et `localhost`.
