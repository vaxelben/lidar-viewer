/**
 * Cloudflare Worker pour servir les fichiers COPC.LAZ depuis R2
 * avec support CORS complet pour GitHub Pages
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Headers CORS pour toutes les réponses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*', // Ou 'https://vaxelben.github.io' pour plus de sécurité
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type, Content-Length',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag',
      'Access-Control-Max-Age': '86400', // 24h
    };

    // Gérer les requêtes OPTIONS (preflight CORS)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {
      // Extraire le nom du fichier (enlever le / initial)
      const fileName = pathname.slice(1);
      
      console.log(`📥 Requête pour: ${fileName}`);

      // Vérifier que le bucket R2 est bien lié
      if (!env.LIDAR_BUCKET) {
        console.error('❌ LIDAR_BUCKET binding non trouvé');
        return new Response('Configuration serveur incorrecte (R2 bucket non lié)', {
          status: 500,
          headers: corsHeaders
        });
      }

      // Récupérer le fichier depuis R2
      const object = await env.LIDAR_BUCKET.get(fileName);

      if (object === null) {
        console.error(`❌ Fichier non trouvé: ${fileName}`);
        return new Response(`Fichier non trouvé: ${fileName}`, {
          status: 404,
          headers: corsHeaders
        });
      }

      console.log(`✅ Fichier trouvé: ${fileName} (${object.size} bytes)`);

      // Construire les headers de réponse
      const headers = new Headers(corsHeaders);
      headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
      headers.set('Content-Length', object.size);
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Cache-Control', 'public, max-age=31536000'); // Cache 1 an
      
      if (object.httpEtag) {
        headers.set('ETag', object.httpEtag);
      }

      // Gérer les requêtes Range (crucial pour COPC/LAZ)
      const range = request.headers.get('Range');
      if (range) {
        console.log(`📦 Requête Range: ${range}`);
        
        // Parser le Range header (ex: "bytes=0-65535")
        const rangeMatch = range.match(/bytes=(\d+)-(\d*)/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1]);
          const end = rangeMatch[2] ? parseInt(rangeMatch[2]) : object.size - 1;
          const length = end - start + 1;

          // Récupérer la portion du fichier
          const partialObject = await env.LIDAR_BUCKET.get(fileName, {
            range: { offset: start, length: length }
          });

          if (partialObject) {
            headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
            headers.set('Content-Length', length);
            
            return new Response(partialObject.body, {
              status: 206, // Partial Content
              headers: headers
            });
          }
        }
      }

      // Réponse complète (pas de Range)
      return new Response(object.body, {
        status: 200,
        headers: headers
      });

    } catch (error) {
      console.error('❌ Erreur Worker:', error);
      return new Response(`Erreur serveur: ${error.message}`, {
        status: 500,
        headers: corsHeaders
      });
    }
  }
};

