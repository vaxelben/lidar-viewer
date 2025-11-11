interface Env {
  MY_BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ============================================
    // 1. VÉRIFICATION DU REFERER (ASSOUPLIE)
    // ============================================
    const referer = request.headers.get('Referer') || '';
    const origin = request.headers.get('Origin') || '';
    const userAgent = request.headers.get('User-Agent') || '';

    // Liste blanche des domaines autorisés
    const allowedOrigins = [
      'https://vaxelben.github.io',
      'http://localhost:5173',      // Vite dev server
      'http://localhost:3000',       // Alternative dev
      'http://127.0.0.1:5173',       // Alternative localhost
      'http://127.0.0.1:3000',       // Alternative localhost
    ];

    // Vérifier si la requête vient d'un domaine autorisé
    const isAllowedReferer = allowedOrigins.some(allowed =>
      referer.startsWith(allowed)
    );
    const isAllowedOrigin = allowedOrigins.some(allowed =>
      origin === allowed || origin.startsWith(allowed)
    );

    // ⚠️ BLOCAGE MODÉRÉ : Autoriser si :
    // - Referer/Origin valide ✅
    // - Pas de Referer/Origin (requêtes Range légitimes) ✅
    // - MAIS bloquer si Referer/Origin présent ET invalide ❌
    const hasInvalidReferer = (referer && !isAllowedReferer) || (origin && !isAllowedOrigin);
    
    if (hasInvalidReferer) {
      console.log('❌ Accès refusé - Origine invalide:', {
        referer,
        origin,
        path: url.pathname,
        ip: request.headers.get('CF-Connecting-IP')
      });
      
      return new Response('Access Denied - Unauthorized domain', {
        status: 403,
        headers: {
          'Content-Type': 'text/plain',
          'X-Blocked-Reason': 'Invalid referer/origin',
        }
      });
    }

    // ============================================
    // 2. GESTION DES REQUÊTES CORS (Preflight)
    // ============================================
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin || 'https://vaxelben.github.io',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Range, Content-Length',
          'Access-Control-Max-Age': '86400',
          'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, ETag, Last-Modified, Accept-Ranges',
        },
      });
    }

    // ============================================
    // 3. VÉRIFICATION DE LA MÉTHODE HTTP
    // ============================================
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: {
          'Allow': 'GET, HEAD, OPTIONS',
        }
      });
    }

    // ============================================
    // 4. RÉCUPÉRATION DU FICHIER DEPUIS R2
    // ============================================
    const objectKey = url.pathname.substring(1);

    // Page d'accueil / health check
    if (!objectKey) {
      return new Response('🔒 R2 Proxy Worker - Protected Access\n✅ Status: Online', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // Bloquer les tentatives d'accès à des fichiers système
    if (objectKey.includes('..') || objectKey.startsWith('.')) {
      return new Response('Invalid path', { status: 400 });
    }

    // Logger la requête valide
    console.log('✅ Accès autorisé:', {
      file: objectKey,
      referer: referer || '(none)',
      origin: origin || '(none)',
      method: request.method,
      range: request.headers.get('Range') || 'none',
      ip: request.headers.get('CF-Connecting-IP')
    });

    // Gérer les requêtes avec Range (pour streaming de gros fichiers COPC)
    const range = request.headers.get('Range');
    let object;

    try {
      if (range) {
        const rangeMatch = range.match(/bytes=(\d+)-(\d*)/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1]);
          const end = rangeMatch[2] ? parseInt(rangeMatch[2]) : undefined;
          
          console.log('📦 Requête Range:', { start, end, file: objectKey });
          
          object = await env.MY_BUCKET.get(objectKey, {
            range: { offset: start, length: end ? end - start + 1 : undefined }
          });
        }
      } else {
        object = await env.MY_BUCKET.get(objectKey);
      }
    } catch (error: any) {
      console.error('❌ Erreur R2:', error.message);
      return new Response(`R2 Error: ${error.message}`, {
        status: 500,
        headers: {
          'Content-Type': 'text/plain',
          'Access-Control-Allow-Origin': origin || 'https://vaxelben.github.io',
        }
      });
    }

    // Fichier introuvable
    if (!object) {
      console.log('❌ Fichier introuvable:', objectKey);
      return new Response(`File not found: ${objectKey}`, {
        status: 404,
        headers: {
          'Content-Type': 'text/plain',
          'Access-Control-Allow-Origin': origin || 'https://vaxelben.github.io',
        }
      });
    }

    // ============================================
    // 5. RETOURNER LE FICHIER AVEC HEADERS CORS
    // ============================================
    const headers = new Headers();
    object.writeHttpMetadata(headers);

    // Headers CORS (crucial pour GitHub Pages)
    const corsOrigin = origin || referer.split('/').slice(0, 3).join('/') || 'https://vaxelben.github.io';
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, ETag, Last-Modified, Accept-Ranges');

    // Headers de cache (fichiers immutables)
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');

    // Headers de sécurité
    headers.set('X-Content-Type-Options', 'nosniff');

    // Support des requêtes Range
    headers.set('Accept-Ranges', 'bytes');

    // Gestion du Range pour streaming COPC
    if (range && object.range) {
      const rangeOffset = object.range.offset;
      const rangeLength = object.range.length;
      const totalSize = object.size;
      
      headers.set('Content-Range', `bytes ${rangeOffset}-${rangeOffset + rangeLength - 1}/${totalSize}`);
      headers.set('Content-Length', rangeLength.toString());
      
      console.log('📤 Réponse Range:', {
        file: objectKey,
        range: `${rangeOffset}-${rangeOffset + rangeLength - 1}/${totalSize}`,
        size: rangeLength
      });

      return new Response(object.body, {
        status: 206, // Partial Content
        headers,
      });
    }

    console.log('📤 Réponse complète:', { file: objectKey, size: object.size });

    return new Response(object.body, {
      status: 200,
      headers,
    });
  },
};

