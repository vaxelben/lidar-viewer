# 🔒 Sécuriser votre bucket Cloudflare R2

## 📋 Options de sécurité disponibles

### 1. ✅ CORS restrictif (Recommandé - Simple)

Limitez l'accès uniquement à votre domaine GitHub Pages.

**Configuration CORS pour production** :
```json
[
  {
    "AllowedOrigins": ["https://vaxelben.github.io"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

**Avantages** :
- ✅ Simple à configurer
- ✅ Bloque automatiquement les requêtes depuis d'autres domaines
- ✅ Empêche le hotlinking (utilisation de vos fichiers par d'autres sites)
- ✅ Pas de modification de code nécessaire

**Inconvénients** :
- ❌ N'empêche pas complètement l'accès direct (quelqu'un peut contourner avec curl/Postman)
- ❌ Les fichiers restent techniquement publics

### 2. 🔐 Cloudflare Workers + Tokens (Recommandé - Avancé)

Utilisez un Worker pour valider les requêtes avec un token d'authentification.

#### Étape 1 : Créer un Worker

1. Allez sur https://dash.cloudflare.com/workers
2. Cliquez sur **Create a Worker**
3. Collez ce code :

```javascript
// Worker pour protéger l'accès au bucket R2
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Vérifier l'origine (CORS)
    const origin = request.headers.get('Origin');
    const allowedOrigins = ['https://vaxelben.github.io'];
    
    // Vérifier que la requête vient du bon domaine
    if (origin && !allowedOrigins.includes(origin)) {
      return new Response('Accès refusé', { status: 403 });
    }
    
    // Extraire le nom du fichier depuis l'URL
    const filename = url.pathname.substring(1); // Enlever le / initial
    
    if (!filename) {
      return new Response('Fichier non spécifié', { status: 400 });
    }
    
    // Récupérer le fichier depuis R2
    const object = await env.R2_BUCKET.get(filename);
    
    if (!object) {
      return new Response('Fichier non trouvé', { status: 404 });
    }
    
    // Préparer les headers de réponse avec CORS
    const headers = new Headers();
    headers.set('Access-Control-Allow-Origin', origin || 'https://vaxelben.github.io');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD');
    headers.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
    headers.set('Cache-Control', 'public, max-age=3600');
    
    // Gérer les requêtes Range (nécessaire pour COPC)
    const range = request.headers.get('Range');
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : object.size - 1;
      
      const slice = await object.slice(start, end + 1).arrayBuffer();
      
      headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
      headers.set('Content-Length', (end - start + 1).toString());
      headers.set('Accept-Ranges', 'bytes');
      
      return new Response(slice, {
        status: 206,
        headers
      });
    }
    
    // Requête normale (sans Range)
    return new Response(object.body, {
      headers
    });
  }
};
```

4. Cliquez sur **Save and Deploy**

#### Étape 2 : Lier le Worker au bucket R2

1. Dans votre Worker, allez dans **Settings** > **Variables**
2. Sous **R2 Bucket Bindings**, cliquez sur **Add binding**
3. Variable name : `R2_BUCKET`
4. R2 bucket : Sélectionnez votre bucket `lidar-viewer-data`
5. Cliquez sur **Save**

#### Étape 3 : Configurer un domaine pour le Worker

1. Dans votre Worker, allez dans **Triggers**
2. Sous **Routes**, cliquez sur **Add route**
3. Route : `r2.votre-domaine.com/*` (si vous avez un domaine personnalisé)
4. Ou utilisez l'URL Worker directe : `https://votre-worker.workers.dev`

#### Étape 4 : Mettre à jour votre application

Dans `public/data-config.json` :
```json
{
  "dataBaseUrl": "https://votre-worker.workers.dev",
  "description": "Fichiers protégés via Cloudflare Worker"
}
```

**Avantages** :
- ✅ Contrôle total sur l'accès
- ✅ Possibilité d'ajouter une authentification par token
- ✅ Logs d'accès détaillés
- ✅ Peut bloquer des IP spécifiques
- ✅ Rate limiting possible

**Inconvénients** :
- ❌ Plus complexe à configurer
- ❌ Nécessite des connaissances en JavaScript

### 3. 🚫 Bucket privé + URLs signées (Maximum de sécurité)

Pour un contrôle total avec des URLs temporaires signées.

#### Configuration

1. **Gardez le bucket privé** (pas de R2.dev subdomain)
2. **Générez des tokens d'accès API** dans Cloudflare
3. **Créez un backend** qui génère des URLs signées à la demande

**Note** : Cette méthode est trop complexe pour la plupart des cas d'usage et nécessite un backend serveur.

## 🎯 Quelle option choisir ?

### Pour la plupart des projets : **Option 1 (CORS restrictif)**
- Simple et efficace
- Empêche le hotlinking depuis d'autres sites web
- Gratuit et sans maintenance

### Pour des données sensibles : **Option 2 (Worker)**
- Contrôle total sur l'accès
- Possibilité d'ajouter une authentification
- Logs d'accès

### Pour des données très sensibles : **Option 3 (URLs signées)**
- Maximum de sécurité
- URLs temporaires
- Requiert un backend

## ⚙️ Configuration recommandée pour votre projet

```json
[
  {
    "AllowedOrigins": ["https://vaxelben.github.io"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

## 📊 Monitoring

### Voir qui accède à vos fichiers

Cloudflare R2 ne fournit pas de logs d'accès détaillés directement, mais vous pouvez :

1. **Utiliser Cloudflare Analytics** (Dashboard R2)
   - Nombre de requêtes
   - Bande passante utilisée
   - Requêtes par région

2. **Utiliser un Worker avec logs** (Option 2)
   - Logs de toutes les requêtes
   - IP des clients
   - Fichiers demandés

### Détecter une utilisation abusive

Si vous voyez une consommation de bande passante anormale :

1. **Vérifiez les metrics** dans le dashboard R2
2. **Activez Cloudflare WAF** (Web Application Firewall) si nécessaire
3. **Ajoutez un rate limit** dans le Worker

## 🔑 Bonnes pratiques

1. ✅ **Utilisez HTTPS uniquement** (GitHub Pages le fait automatiquement)
2. ✅ **Limitez les origines CORS** à votre domaine exact
3. ✅ **Activez le cache** pour réduire les requêtes à R2
4. ✅ **Surveillez l'utilisation** régulièrement
5. ✅ **Mettez à jour les CORS** si vous changez de domaine

## ❓ FAQ

**Q : Les fichiers sont-ils vraiment protégés avec CORS ?**  
R : CORS empêche les navigateurs d'accéder aux fichiers depuis d'autres domaines. Quelqu'un avec curl/Postman peut toujours les télécharger, mais c'est suffisant pour 99% des cas.

**Q : Puis-je bloquer complètement l'accès direct ?**  
R : Oui, avec l'Option 2 (Worker) ou 3 (URLs signées). Mais CORS est généralement suffisant.

**Q : Comment savoir si quelqu'un utilise mes fichiers sans autorisation ?**  
R : Surveillez les métriques dans le dashboard R2. Une augmentation anormale indique un problème.

**Q : Le Worker consomme-t-il des ressources gratuites ?**  
R : Oui, mais Cloudflare offre 100,000 requêtes/jour gratuites pour les Workers, ce qui est largement suffisant.

**Q : Puis-je avoir plusieurs origines autorisées ?**  
R : Oui ! Ajoutez-les dans le tableau `AllowedOrigins` :
```json
{
  "AllowedOrigins": [
    "https://vaxelben.github.io",
    "https://www.votre-domaine.com"
  ],
  ...
}
```

## 🎉 Résultat

Avec CORS correctement configuré :
- ✅ Seul votre site GitHub Pages peut charger les fichiers
- ✅ Les autres sites web recevront une erreur CORS
- ✅ Pas de hotlinking possible depuis un navigateur
- ✅ Vos données sont protégées contre l'utilisation abusive

## 🔗 Liens utiles

- [Documentation CORS de Cloudflare R2](https://developers.cloudflare.com/r2/buckets/cors/)
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Dashboard R2](https://dash.cloudflare.com/r2)

