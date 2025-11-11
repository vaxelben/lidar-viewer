# Cloudflare Worker - Proxy R2 pour fichiers COPC.LAZ

Ce Worker sert de proxy CORS-enabled pour servir les fichiers `.copc.laz` depuis un bucket Cloudflare R2.

## 🎯 Fonctionnalités

- ✅ Support CORS complet (headers `Access-Control-Allow-Origin`)
- ✅ Support des requêtes Range (crucial pour COPC)
- ✅ Gestion d'erreurs robuste
- ✅ Cache HTTP (1 an)
- ✅ Logs de débogage

## 📦 Déploiement

### 1. Installer Wrangler (si pas déjà fait)

```powershell
npm install -g wrangler
# ou avec yarn
yarn global add wrangler
# ou utiliser npx
npx wrangler --version
```

### 2. Se connecter à Cloudflare

```powershell
npx wrangler login
```

Une fenêtre de navigateur s'ouvrira pour vous authentifier.

### 3. Vérifier le nom de votre bucket R2

Listez vos buckets R2 :

```powershell
npx wrangler r2 bucket list
```

**IMPORTANT** : Notez le nom exact de votre bucket (par exemple : `lidar-data`)

### 4. Modifier `wrangler.toml`

Ouvrez `wrangler.toml` et remplacez `bucket_name` par le nom de votre bucket :

```toml
[[r2_buckets]]
binding = "LIDAR_BUCKET"
bucket_name = "lidar-data"  # ← Votre bucket ici
```

### 5. Déployer le Worker

Depuis le dossier `cloudflare-worker/` :

```powershell
cd cloudflare-worker
npx wrangler deploy
```

Vous devriez voir :

```
✨ Successfully published r2-proxy-worker
   https://r2-proxy-worker.datawrap.workers.dev
```

## 🧪 Tester le Worker

### Test 1 : Accès direct (devrait retourner le fichier)

```powershell
curl -I https://r2-proxy-worker.datawrap.workers.dev/LHD_FXX_0927_6895_PTS_LAMB93_IGN69.copc.laz
```

Attendu :
- Status : `200 OK` ou `206 Partial Content`
- Header `Access-Control-Allow-Origin: *`
- Header `Content-Type: application/octet-stream`

### Test 2 : Requête OPTIONS (preflight CORS)

```powershell
curl -X OPTIONS -I https://r2-proxy-worker.datawrap.workers.dev/LHD_FXX_0927_6895_PTS_LAMB93_IGN69.copc.laz
```

Attendu :
- Status : `204 No Content`
- Header `Access-Control-Allow-Origin: *`
- Header `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`

### Test 3 : Requête Range (crucial pour COPC)

```powershell
curl -H "Range: bytes=0-1023" -I https://r2-proxy-worker.datawrap.workers.dev/LHD_FXX_0927_6895_PTS_LAMB93_IGN69.copc.laz
```

Attendu :
- Status : `206 Partial Content`
- Header `Content-Range: bytes 0-1023/XXXXX`
- Header `Access-Control-Allow-Origin: *`

## 📊 Voir les logs

Pour voir les logs en temps réel pendant le débogage :

```powershell
npx wrangler tail r2-proxy-worker
```

Puis testez une requête, vous verrez les logs `console.log()` du Worker.

## 🔒 Sécurité (optionnel)

Par défaut, le Worker accepte les requêtes de **tous les domaines** (`Access-Control-Allow-Origin: *`).

Pour restreindre à GitHub Pages uniquement, modifiez `r2-proxy.js` ligne 12 :

```javascript
'Access-Control-Allow-Origin': 'https://vaxelben.github.io',
```

## 🔧 Dépannage

### Erreur "LIDAR_BUCKET binding non trouvé"

→ Le binding R2 n'est pas configuré dans `wrangler.toml`

### Erreur 404 "Fichier non trouvé"

→ Vérifiez que les fichiers sont bien uploadés dans R2 à la **racine** du bucket (pas dans un dossier)

```powershell
npx wrangler r2 object list lidar-data
```

### Erreur 500

→ Regardez les logs :

```powershell
npx wrangler tail r2-proxy-worker
```

## 📝 Mise à jour du Worker

Après modification du code `r2-proxy.js` :

```powershell
cd cloudflare-worker
npx wrangler deploy
```

Les changements sont déployés instantanément (pas de cache).

