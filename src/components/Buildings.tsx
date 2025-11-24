import React, { useEffect, useMemo, useState, useRef } from 'react';
import { OBJLoader } from 'three-stdlib';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import * as THREE from 'three';
import { resolveDataUrl } from '../utils/dataUrlResolver';

interface BuildingsProps {
  // Props optionnelles pour personnaliser l'affichage si nécessaire
  visible?: boolean;
  showEdges?: boolean;
  edgeColor?: string;
  edgeThickness?: number;
  onLoadStart?: () => void;
  onLoadProgress?: (progress: number) => void;
  onLoadComplete?: () => void;
  assets?: BuildingAssetConfig[];
}

interface BuildingAssetConfig {
  id: string;
  objPath: string;
  texturePath: string;
  visible?: boolean;
  showEdges?: boolean;
  edgeColor?: string;
  edgeThickness?: number;
}

interface ResolvedBuildingAsset extends BuildingAssetConfig {
  objUrl: string;
  textureUrl: string;
}

// Cache global pour le modèle OBJ chargé
const modelCache = new Map<string, THREE.Group>();
const loadingPromises = new Map<string, Promise<THREE.Group>>();

// Fonction de throttling pour limiter la fréquence des mises à jour de progression
function createThrottledProgress(onProgress?: (progress: number) => void): (progress: number) => void {
  if (!onProgress) return () => {};
  
  let lastProgress = -1;
  let lastUpdateTime = 0;
  let rafId: number | null = null;
  let pendingProgress: number | null = null;
  
  const THROTTLE_MS = 500; // Maximum une mise à jour toutes les 500ms
  const MIN_PROGRESS_DELTA = 0.1; // Minimum 10% de changement pour mettre à jour
  
  const updateProgress = (progress: number) => {
    // Toujours notifier la progression finale
    if (progress === 1.0) {
      lastProgress = 1.0;
      lastUpdateTime = Date.now();
      pendingProgress = null;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      onProgress(1.0);
      return;
    }
    
    const now = Date.now();
    const progressDelta = Math.abs(progress - lastProgress);
    const timeDelta = now - lastUpdateTime;
    
    // Mettre à jour immédiatement si :
    // 1. Le progrès a changé de plus de 10%
    // 2. OU si plus de 500ms se sont écoulées depuis la dernière mise à jour
    if (progressDelta >= MIN_PROGRESS_DELTA || timeDelta >= THROTTLE_MS) {
      lastProgress = progress;
      lastUpdateTime = now;
      pendingProgress = null;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      onProgress(progress);
    } else {
      // Stocker la progression en attente pour un traitement différé
      pendingProgress = progress;
      
      // Utiliser requestAnimationFrame pour limiter à une fois par frame
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          const currentTime = Date.now();
          const elapsed = currentTime - lastUpdateTime;
          
          if (pendingProgress !== null && elapsed >= THROTTLE_MS) {
            const p = pendingProgress;
            pendingProgress = null;
            lastProgress = p;
            lastUpdateTime = currentTime;
            onProgress(p);
          }
        });
      }
    }
  };
  
  return updateProgress;
}

// Fonction pour charger le modèle OBJ manuellement
async function loadOBJModel(url: string, onProgress?: (progress: number) => void): Promise<THREE.Group> {
  // Vérifier le cache
  if (modelCache.has(url)) {
    console.log('[Buildings] Modèle récupéré du cache:', url);
    // Notifier que le chargement est complet (100%) même si c'est depuis le cache
    if (onProgress) {
      // Utiliser setTimeout pour s'assurer que le callback est appelé de manière asynchrone
      setTimeout(() => {
        onProgress(1.0);
      }, 0);
    }
    return modelCache.get(url)!;
  }
  
  // Vérifier si un chargement est déjà en cours
  if (loadingPromises.has(url)) {
    console.log('[Buildings] Attente du chargement en cours:', url);
    return loadingPromises.get(url)!;
  }
  
  // Créer une fonction de progression throttlée
  const throttledProgress = createThrottledProgress(onProgress);
  
  // Variables pour suivre le chargement
  const startTime = Date.now();
  let lastLoggedProgress = -1;
  
  // Créer une nouvelle promesse de chargement
  const loadingPromise = new Promise<THREE.Group>((resolve, reject) => {
    const loader = new OBJLoader();
    
    console.log('[Buildings] Début du chargement du modèle OBJ:', url);
    console.log('[Buildings] Temps de début:', new Date().toISOString());
    
    loader.load(
      url,
      (object) => {
        const loadTime = Date.now() - startTime;
        console.log('[Buildings] Modèle OBJ chargé avec succès');
        console.log('[Buildings] Temps de chargement:', loadTime, 'ms');
        console.log('[Buildings] Type de l\'objet:', object.type);
        console.log('[Buildings] Nombre d\'enfants directs:', object.children.length);
        
        // Analyser la structure complète de l'objet
        let meshCount = 0;
        let groupCount = 0;
        let lineCount = 0;
        let pointsCount = 0;
        let totalVertices = 0;
        const structure: Array<{
          type: string;
          name: string;
          visible: boolean;
          children: number;
          vertices?: number;
          hasNormals?: boolean;
          hasUVs?: boolean;
          material?: string;
        }> = [];
        
        object.traverse((child) => {
          const childInfo: {
            type: string;
            name: string;
            visible: boolean;
            children: number;
            vertices?: number;
            hasNormals?: boolean;
            hasUVs?: boolean;
            material?: string;
          } = {
            type: child.type,
            name: child.name,
            visible: child.visible,
            children: child.children.length
          };
          
          if (child instanceof THREE.Mesh) {
            meshCount++;
            const geometry = child.geometry;
            if (geometry) {
              const positions = geometry.attributes.position;
              if (positions) {
                totalVertices += positions.count;
                childInfo.vertices = positions.count;
                childInfo.hasNormals = geometry.attributes.normal !== undefined;
                childInfo.hasUVs = geometry.attributes.uv !== undefined;
              }
            }
            if (child.material) {
              childInfo.material = Array.isArray(child.material) 
                ? child.material.map((m: THREE.Material) => m.type).join(', ')
                : child.material.type;
            }
          } else if (child instanceof THREE.Group) {
            groupCount++;
          } else if (child instanceof THREE.LineSegments) {
            lineCount++;
          } else if (child instanceof THREE.Points) {
            pointsCount++;
          }
          
          structure.push(childInfo);
        });
        
        console.log('[Buildings] Analyse de la structure:');
        console.log('[Buildings]   - Meshes:', meshCount);
        console.log('[Buildings]   - Groups:', groupCount);
        console.log('[Buildings]   - Lines:', lineCount);
        console.log('[Buildings]   - Points:', pointsCount);
        console.log('[Buildings]   - Total vertices:', totalVertices.toLocaleString('fr-FR'));
        console.log('[Buildings] Structure complète:', structure);
        
        // Si aucun mesh n'est trouvé, c'est un problème critique
        if (meshCount === 0) {
          console.error('[Buildings] ❌ ERREUR: Aucun mesh trouvé dans le modèle OBJ!');
          console.error('[Buildings] Le fichier OBJ a été chargé mais le parsing a échoué.');
          console.error('[Buildings] Enfants directs:', object.children.map(c => ({
            type: c.type,
            name: c.name,
            constructor: c.constructor.name
          })));
          console.error('[Buildings] Cela peut être dû à:');
          console.error('[Buildings]   1. Fichier OBJ trop volumineux (>500MB peut causer des problèmes)');
          console.error('[Buildings]   2. Format OBJ invalide ou corrompu');
          console.error('[Buildings]   3. Limitation mémoire du navigateur');
          console.error('[Buildings]   4. Le parser OBJLoader ne peut pas gérer ce fichier');
          
          // Rejeter la promesse pour signaler l'erreur
          loadingPromises.delete(url);
          reject(new Error('Le fichier OBJ a été chargé mais aucun mesh n\'a été trouvé. Le parsing a probablement échoué.'));
          return;
        }
        
        // Assurer que la progression finale est toujours notifiée
        if (onProgress) {
          onProgress(1.0);
        }
        modelCache.set(url, object);
        loadingPromises.delete(url);
        resolve(object);
      },
      (progressEvent) => {
        if (progressEvent.lengthComputable) {
          const progress = progressEvent.loaded / progressEvent.total;
          const bytesLoaded = progressEvent.loaded;
          const bytesTotal = progressEvent.total;
          
          // Logger la progression tous les 10%
          const progressPercent = Math.floor(progress * 100);
          if (progressPercent % 10 === 0 && progressPercent !== lastLoggedProgress) {
            lastLoggedProgress = progressPercent;
            const elapsed = Date.now() - startTime;
            const speed = bytesLoaded / elapsed; // bytes/ms
            const remaining = bytesTotal - bytesLoaded;
            const estimatedTimeRemaining = remaining / speed; // ms
            
            console.log(`[Buildings] Progression: ${progressPercent}% (${(bytesLoaded / 1024 / 1024).toFixed(2)} MB / ${(bytesTotal / 1024 / 1024).toFixed(2)} MB)`);
            console.log(`[Buildings] Vitesse: ${(speed * 1000 / 1024 / 1024).toFixed(2)} MB/s, Temps restant estimé: ${(estimatedTimeRemaining / 1000).toFixed(1)}s`);
          }
          
          throttledProgress(progress);
        } else {
          // Si lengthComputable est false, on ne peut pas calculer la progression exacte
          // Mais on peut quand même notifier une progression approximative
          console.log('[Buildings] Progression non calculable, chargement en cours...');
        }
      },
      (error) => {
        const loadTime = Date.now() - startTime;
        console.error('[Buildings] Erreur lors du chargement du modèle OBJ:', error);
        console.error('[Buildings] Temps écoulé avant l\'erreur:', loadTime, 'ms');
        loadingPromises.delete(url);
        reject(error);
      }
    );
  });
  
  loadingPromises.set(url, loadingPromise);
  return loadingPromise;
}

// Composant interne qui charge le modèle une fois l'URL résolue
function BuildingsLoader({ 
  objUrl,
  textureUrl,
  visible,
  showEdges,
  edgeColor,
  edgeThickness,
  globalOriginRef,
  onLoadStart,
  onLoadProgress,
  onLoadComplete
}: { 
  objUrl: string;
  textureUrl: string;
  visible: boolean;
  showEdges: boolean;
  edgeColor: string;
  edgeThickness: number;
  globalOriginRef: React.MutableRefObject<THREE.Vector3 | null>;
  onLoadStart?: () => void;
  onLoadProgress?: (progress: number) => void;
  onLoadComplete?: () => void;
}) {
  // État pour stocker le modèle chargé
  const [obj, setObj] = useState<THREE.Group | null>(null);
  // État pour stocker la texture chargée
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  // État pour suivre si le modèle OBJ est chargé
  const [objLoaded, setObjLoaded] = useState<boolean>(false);
  // État pour suivre si la texture est chargée
  const [textureLoaded, setTextureLoaded] = useState<boolean>(false);
  
  // Utiliser useRef pour stocker les callbacks et éviter les re-renders
  const callbacksRef = useRef({ onLoadStart, onLoadProgress, onLoadComplete });
  
  // Mettre à jour les refs quand les callbacks changent
  useEffect(() => {
    callbacksRef.current = { onLoadStart, onLoadProgress, onLoadComplete };
  }, [onLoadStart, onLoadProgress, onLoadComplete]);
  
  // Charger la texture PNG au montage du composant
  useEffect(() => {
    if (!textureUrl) return;
    
    let isMounted = true;
    const textureStartTime = Date.now();
    
    console.log('[Buildings] Début du chargement de la texture PNG');
    console.log('[Buildings] URL texture:', textureUrl);
    console.log('[Buildings] Temps de début texture:', new Date().toISOString());
    
    // Charger la texture avec THREE.TextureLoader
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(
      textureUrl,
      (loadedTexture) => {
        if (isMounted) {
          const textureLoadTime = Date.now() - textureStartTime;
          console.log('[Buildings] Texture chargée avec succès');
          console.log('[Buildings] Temps de chargement texture:', textureLoadTime, 'ms');
          console.log('[Buildings] Taille de la texture:', loadedTexture.image ? `${loadedTexture.image.width}x${loadedTexture.image.height}` : 'inconnue');
          
          // Configurer la texture
          loadedTexture.colorSpace = THREE.SRGBColorSpace;
          loadedTexture.flipY = false; // Important pour les textures OBJ
          setTexture(loadedTexture);
          setTextureLoaded(true);
        }
      },
      (progressEvent) => {
        if (progressEvent.lengthComputable) {
          const progress = progressEvent.loaded / progressEvent.total;
          const progressPercent = Math.floor(progress * 100);
          console.log(`[Buildings] Progression texture: ${progressPercent}% (${(progressEvent.loaded / 1024 / 1024).toFixed(2)} MB / ${(progressEvent.total / 1024 / 1024).toFixed(2)} MB)`);
        }
      },
      (error) => {
        const textureLoadTime = Date.now() - textureStartTime;
        console.error('[Buildings] Erreur lors du chargement de la texture:', error);
        console.error('[Buildings] Temps écoulé avant l\'erreur texture:', textureLoadTime, 'ms');
        // Même en cas d'erreur, marquer comme chargé pour ne pas bloquer l'affichage
        if (isMounted) {
          setTextureLoaded(true);
        }
      }
    );
    
    return () => {
      isMounted = false;
    };
  }, [textureUrl]);
  
  // Charger le modèle OBJ au montage du composant
  useEffect(() => {
    let isMounted = true;
    
    if (callbacksRef.current.onLoadStart) {
      callbacksRef.current.onLoadStart();
    }
    
    loadOBJModel(objUrl, callbacksRef.current.onLoadProgress)
      .then((loadedObj) => {
        if (isMounted) {
          setObj(loadedObj);
          setObjLoaded(true);
        }
      })
      .catch((error) => {
        console.error('[Buildings] Erreur lors du chargement:', error);
        // Même en cas d'erreur, marquer comme chargé pour ne pas bloquer indéfiniment
        if (isMounted) {
          setObjLoaded(true);
        }
      });
    
    return () => {
      isMounted = false;
    };
  }, [objUrl]); // Seulement objUrl dans les dépendances
  
  // Appeler onLoadComplete uniquement quand les deux sont chargés
  useEffect(() => {
    if (objLoaded && textureLoaded && callbacksRef.current.onLoadComplete) {
      console.log('[Buildings] Modèle OBJ et texture PNG chargés, chargement complet');
      callbacksRef.current.onLoadComplete();
    }
  }, [objLoaded, textureLoaded]);

  // Cloner l'objet pour éviter les problèmes de réutilisation
  // Utiliser useRef pour stocker la texture et éviter de recréer la scène quand elle change
  const textureRef = useRef<THREE.Texture | null>(null);
  
  // Mettre à jour la ref quand la texture change
  useEffect(() => {
    textureRef.current = texture;
  }, [texture]);
  
  const clonedScene = React.useMemo(() => {
    if (!obj) return null;
    
    const cloned = obj.clone();
    
    // Calculer la bounding box AVANT toute modification
    const box = new THREE.Box3().setFromObject(cloned);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    
    console.log('[Buildings] Modèle chargé (coordonnées LAMB93):', {
      center: center.toArray(),
      size: size.toArray(),
      min: box.min.toArray(),
      max: box.max.toArray()
    });
    
    // ÉTAPE 1 : APLATIR LA HIÉRARCHIE
    // Appliquer toutes les transformations des parents aux géométries
    cloned.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        // Mettre à jour la matrice du monde
        child.updateMatrixWorld(true);
        
        // Cloner la géométrie
        const geometry = child.geometry.clone();
        
        // Appliquer la matrice du monde (transformations hiérarchiques)
        geometry.applyMatrix4(child.matrixWorld);
        
        // Remplacer la géométrie
        child.geometry.dispose();
        child.geometry = geometry;
        
        // Réinitialiser les transformations
        child.position.set(0, 0, 0);
        child.rotation.set(0, 0, 0);
        child.scale.set(1, 1, 1);
        child.updateMatrix();
      }
    });
    
    // Réinitialiser la transformation de la scène racine
    cloned.position.set(0, 0, 0);
    cloned.rotation.set(0, 0, 0);
    cloned.scale.set(1, 1, 1);
    
    // Recalculer la bounding box après l'aplatissement
    const flattenedBox = new THREE.Box3().setFromObject(cloned);
    const lamb93Center = flattenedBox.getCenter(new THREE.Vector3());
    
    if (!globalOriginRef.current) {
      globalOriginRef.current = lamb93Center.clone();
      console.log('[Buildings] Origine globale initialisée:', globalOriginRef.current.toArray());
    }
    
    const globalOrigin = globalOriginRef.current.clone();
    
    console.log('[Buildings] Centre global à soustraire:', globalOrigin.toArray());
    
    // ÉTAPE 2 : RECENTRER LES VERTICES DIRECTEMENT DANS LES GÉOMÉTRIES
    // C'est la clé pour éliminer les vibrations avec de grandes coordonnées
    // ET GÉNÉRER LES COORDONNÉES UV POUR LA TEXTURE
    cloned.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        const geometry = child.geometry;
        const positions = geometry.attributes.position;
        
        if (positions) {
          // Calculer la bounding box de cette géométrie pour les UVs
          geometry.computeBoundingBox();
          const geomBox = geometry.boundingBox!;
          const geomSize = new THREE.Vector3();
          geomBox.getSize(geomSize);
          
          // Créer un array pour les coordonnées UV
          const uvs = new Float32Array(positions.count * 2);
          
          // Soustraire le centre LAMB93 de chaque vertex
          // ET générer les coordonnées UV basées sur la projection planaire (vue du dessus)
          for (let i = 0; i < positions.count; i++) {
            const x = positions.getX(i);
            const y = positions.getY(i);
            const z = positions.getZ(i);
            
            // Recentrer les positions
            positions.setX(i, x - globalOrigin.x);
            positions.setY(i, y - globalOrigin.y);
            positions.setZ(i, z - globalOrigin.z);
            
            // Générer les UVs basés sur les coordonnées LAMB93 originales
            // Normaliser par rapport à la taille totale du modèle
            // On utilise les coordonnées X et Y pour une projection planaire
            const u = (x - flattenedBox.min.x) / size.x;
            const v = (y - flattenedBox.min.y) / size.y;
            
            uvs[i * 2] = u;
            uvs[i * 2 + 1] = v;
          }
          
          // Ajouter les UVs à la géométrie
          geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
          
          // Indiquer que les positions ont été modifiées
          positions.needsUpdate = true;
          
          // Recalculer les bounding sphere/box pour le culling
          geometry.computeBoundingSphere();
          geometry.computeBoundingBox();
        }
        
        // CORRECTION DU Z-FIGHTING : Configurer le matériau
        // ET appliquer la texture ou la couleur personnalisée #fcf9e6
        // Utiliser textureRef.current pour éviter de dépendre de texture dans useMemo
        const currentTexture = textureRef.current;
        const customColor = new THREE.Color('#ffffff'); // Blanc pour ne pas teinter la texture
        const newMaterial = new THREE.MeshStandardMaterial({
          // Si la texture est chargée, utiliser blanc pour ne pas teinter
          // Sinon, utiliser la couleur de secours #fcf9e6
          color: currentTexture ? customColor : new THREE.Color('#fcf9e6'),
          // Appliquer la texture si elle est chargée
          map: currentTexture,
          // Propriétés pour rendre la texture plus lumineuse et réceptive à la lumière
          roughness: 1.0,        // Surface mate, pas de reflets spéculaires
          metalness: 0.0,        // Surface non métallique
          // Ajouter un effet émissif léger pour augmenter la luminosité globale
          emissive: currentTexture ? new THREE.Color('#ffffff') : new THREE.Color('#000000'),
          emissiveMap: currentTexture,  // Utiliser la texture comme map émissive
          emissiveIntensity: 0.8, // Intensité de l'émission (30% de la texture)
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
          side: THREE.FrontSide,
          // Désactiver flatShading pour que la texture s'affiche correctement
          flatShading: false,
          // Ajouter le depthTest et depthWrite pour éviter les conflits de depth
          depthTest: true,
          depthWrite: true,
          // Ajouter le transparent et l'opacity pour la transparence
          transparent: false,
          opacity: 1.0,
          // Ajouter le blending pour le rendu par-dessus
          blending: THREE.NormalBlending,
        });
        
        // Disposer l'ancien matériau pour libérer la mémoire
        if (child.material) {
          const oldMaterial = Array.isArray(child.material) ? child.material : [child.material];
          oldMaterial.forEach((mat) => mat.dispose());
        }
        
        // Appliquer le nouveau matériau
        child.material = newMaterial;
      }
    });
    
    // ÉTAPE 3 : Positionner le mesh à l'origine (les vertices sont déjà recentrés)
    // Dans un système Z-up, le mesh doit être à Z=0 pour être visible depuis la caméra
    cloned.position.set(0, 0, 0);
    
    // OBJET STATIQUE : Désactiver matrixAutoUpdate pour éliminer les vibrations
    // Les matrices seront calculées UNE SEULE FOIS et figées
    cloned.matrixAutoUpdate = false;
    
    // S'assurer que tous les enfants sont visibles et ont matrixAutoUpdate DÉSACTIVÉ
    cloned.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh) {
        child.visible = true;
        // CRITIQUE : Désactiver matrixAutoUpdate pour éviter les recalculs à chaque frame
        child.matrixAutoUpdate = false;
        child.frustumCulled = true;
        
        // Calculer la matrice locale une dernière fois
        child.updateMatrix();
      }
    });
    
    // Mettre à jour la matrice de la scène racine une dernière fois
    cloned.updateMatrix();
    
    // Calculer TOUTES les matrices du monde (parent + enfants) UNE DERNIÈRE FOIS
    // Après cet appel, les matrices sont figées et ne seront plus jamais recalculées
    cloned.updateMatrixWorld(true);
    
    // Vérifier que le recentrage a fonctionné
    const finalBox = new THREE.Box3().setFromObject(cloned);
    const finalCenter = finalBox.getCenter(new THREE.Vector3());
    
    console.log('[Buildings] Recentrage terminé:', {
      'Centre LAMB93 original': lamb93Center.toArray(),
      'Origine globale': globalOrigin.toArray(),
      'Centre final (devrait être proche de [0,0,0])': finalCenter.toArray(),
      'Position du mesh': cloned.position.toArray(),
      'Taille': finalBox.getSize(new THREE.Vector3()).toArray(),
      'Texture chargée': textureRef.current !== null,
      'Nombre de meshes': cloned.children.filter(c => c instanceof THREE.Mesh).length
    });
    
    // Vérifier que les UVs ont été générés
    cloned.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        const hasUVs = child.geometry.attributes.uv !== undefined;
        console.log('[Buildings] Mesh UV check:', {
          name: child.name,
          hasUVs,
          uvCount: hasUVs ? child.geometry.attributes.uv.count : 0
        });
      }
    });
    
    return cloned;
  }, [obj, globalOriginRef]); // Recalcule si l'objet source change

  // Appliquer la texture aux matériaux existants sans recréer la scène
  useEffect(() => {
    if (!clonedScene || !texture) return;
    
    clonedScene.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh && child.material) {
        const material = child.material as THREE.MeshStandardMaterial;
        if (material.isMeshStandardMaterial) {
          material.map = texture;
          material.emissiveMap = texture;
          material.needsUpdate = true;
        }
      }
    });
  }, [texture, clonedScene]);

  // Créer les arêtes directement dans la scène
  useEffect(() => {
    if (!showEdges || !clonedScene) return;

    const edgesToClean: THREE.LineSegments[] = [];

    clonedScene.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh && child.visible && child.geometry) {
        // Les géométries ont été recentrées à l'origine (vertices modifiés directement)
        // Les arêtes seront créées à partir de ces vertices recentrés
        
        // Créer un EdgesGeometry avec un seuil d'angle (15 degrés)
        const edgesGeometry = new THREE.EdgesGeometry(child.geometry, 15);
        const edgesMaterial = new THREE.LineBasicMaterial({ 
          color: new THREE.Color(edgeColor),
          linewidth: edgeThickness,
          transparent: false,
          opacity: 1.0,
          // CORRECTION DU Z-FIGHTING : Les arêtes doivent être rendues PAR-DESSUS les faces
          depthTest: true,
          depthWrite: false,  // Ne pas écrire dans le depth buffer pour éviter les conflits
          // Utiliser polygonOffset pour décaler les arêtes vers l'avant
          polygonOffset: true,
          polygonOffsetFactor: -1,  // Valeur négative pour rapprocher de la caméra
          polygonOffsetUnits: -1
        });
        const line = new THREE.LineSegments(edgesGeometry, edgesMaterial);
        
        // OBJET STATIQUE : Désactiver matrixAutoUpdate pour les arêtes aussi
        // Les arêtes doivent être complètement figées comme les meshes
        line.matrixAutoUpdate = false;
        
        // renderOrder plus élevé = rendu après (donc par-dessus)
        // Les faces du mesh ont renderOrder = 0 par défaut
        line.renderOrder = 1;
        
        // Désactiver frustumCulling pour éviter que les arêtes disparaissent
        line.frustumCulled = false;
        
        // Ajouter les arêtes comme enfant direct du mesh
        child.add(line);
        
        // Calculer la matrice de la ligne une dernière fois et la figer
        line.updateMatrix();
        
        edgesToClean.push(line);
      }
    });
    
    // Mettre à jour toutes les matrices du monde UNE DERNIÈRE FOIS
    // Cela inclut maintenant les arêtes qui viennent d'être ajoutées
    clonedScene.updateMatrixWorld(true);
    
    console.log('[Buildings] Arêtes créées et figées:', edgesToClean.length);
    
    return () => {
      // Nettoyer les arêtes lors du démontage
      edgesToClean.forEach((line) => {
        line.parent?.remove(line);
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      });
    };
  }, [clonedScene, showEdges, edgeColor, edgeThickness]);

  // Extraire les données de collision pour chaque mesh
  const collisionData = useMemo(() => {
    if (!clonedScene) return [];
    
    const meshesData: Array<{
      vertices: Float32Array;
      indices: Uint32Array;
      name: string;
    }> = [];
    
    clonedScene.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        const geometry = child.geometry;
        const positions = geometry.attributes.position;
        
        if (!positions) return;
        
        // Extraire les vertices
        const vertices = new Float32Array(positions.count * 3);
        for (let i = 0; i < positions.count; i++) {
          vertices[i * 3] = positions.getX(i);
          vertices[i * 3 + 1] = positions.getY(i);
          vertices[i * 3 + 2] = positions.getZ(i);
        }
        
        // Extraire les indices
        let indices: Uint32Array;
        if (geometry.index) {
          indices = new Uint32Array(geometry.index.array);
        } else {
          // Si pas d'indices, créer des indices séquentiels
          indices = new Uint32Array(positions.count);
          for (let i = 0; i < positions.count; i++) {
            indices[i] = i;
          }
        }
        
        meshesData.push({
          vertices,
          indices,
          name: child.name || 'unnamed_mesh'
        });
      }
    });
    
    console.log(`[Buildings] ${meshesData.length} meshes préparés pour les collisions, total vertices:`, 
      meshesData.reduce((acc, m) => acc + m.vertices.length / 3, 0));
    
    return meshesData;
  }, [clonedScene]);

  useEffect(() => {
    if (clonedScene) {
      console.log('[Buildings] Scène clonée prête, nombre d\'enfants:', clonedScene.children.length);
      
      // Vérifier que la scène est bien dans le graphe
      clonedScene.traverse((child: THREE.Object3D) => {
        if (child instanceof THREE.Mesh) {
          console.log('[Buildings] Mesh trouvé:', {
            name: child.name,
            visible: child.visible,
            position: child.position.toArray(),
            geometry: child.geometry ? {
              vertices: child.geometry.attributes.position?.count || 0,
              type: child.geometry.type
            } : null,
            material: child.material ? {
              type: child.material.type,
              visible: child.material.visible !== false
            } : null
          });
        }
      });
    }
  }, [clonedScene]);

  // Log de débogage pour vérifier que le mesh est rendu
  useEffect(() => {
    if (clonedScene) {
      console.log('[Buildings] Rendu du mesh:', {
        position: clonedScene.position.toArray(),
        visible: clonedScene.visible,
        childrenCount: clonedScene.children.length,
        meshCount: clonedScene.children.filter(c => c instanceof THREE.Mesh).length
      });
    }
  }, [clonedScene]);

  // Ne rien afficher si le modèle n'est pas chargé, si la texture n'est pas chargée, ou si pas visible
  // Attendre que les deux soient chargés avant d'afficher
  if (!visible || !clonedScene || !objLoaded || !textureLoaded) {
    return null;
  }

  // Rendre la scène complète avec les collisions physiques
  // Les arêtes sont ajoutées directement dans la scène
  // Les colliders sont créés à partir des mêmes géométries recentrées
  return (
    <RigidBody type="fixed" colliders={false}>
      {/* Créer un TrimeshCollider pour chaque mesh */}
      {collisionData.map((mesh, index) => (
        <TrimeshCollider 
          key={`collider-${index}-${mesh.name}`}
          args={[mesh.vertices, mesh.indices]}
        />
      ))}
      
      {/* Le mesh visuel */}
      <primitive object={clonedScene} />
    </RigidBody>
  );
}

// Composant principal qui résout l'URL et charge le modèle
export function Buildings({ 
  visible = true, 
  showEdges = true,
  edgeColor = '#000000',
  edgeThickness = 1,
  onLoadStart,
  onLoadProgress,
  onLoadComplete,
  assets
}: BuildingsProps) {
  const globalOriginRef = useRef<THREE.Vector3 | null>(null);
  const defaultAssets = useMemo<BuildingAssetConfig[]>(() => ([
    {
      id: 'tile_0931_6895',
      objPath: '/models/buildings_LHD_FXX_0931_6895_PTS_LAMB93_IGN69_v2.obj',
      texturePath: '/models/buildings_LHD_FXX_0931_6895_PTS_LAMB93_IGN69_texture_color.png'
    },
    {
      id: 'tile_0931_6896',
      objPath: '/models/buildings_LHD_FXX_0931_6896_PTS_LAMB93_IGN69_v2.obj',
      texturePath: '/models/buildings_LHD_FXX_0931_6896_PTS_LAMB93_IGN69_texture_color.png'
    },
    {
      id: 'tile_0932_6895',
      objPath: '/models/buildings_LHD_FXX_0932_6895_PTS_LAMB93_IGN69_v2.obj',
      texturePath: '/models/buildings_LHD_FXX_0932_6895_PTS_LAMB93_IGN69_texture_color.png'
    },
    {
      id: 'tile_0932_6896',
      objPath: '/models/buildings_LHD_FXX_0932_6896_PTS_LAMB93_IGN69_v2.obj',
      texturePath: '/models/buildings_LHD_FXX_0932_6896_PTS_LAMB93_IGN69_texture_color.png'
    }
  ]), []);

  const assetConfigs = useMemo(() => {
    if (assets && assets.length > 0) {
      return assets;
    }
    return defaultAssets;
  }, [assets, defaultAssets]);
  const [resolvedAssets, setResolvedAssets] = useState<ResolvedBuildingAsset[]>([]);

  useEffect(() => {
    if (!visible) {
      setResolvedAssets([]);
      globalOriginRef.current = null;
      return;
    }

    let isMounted = true;
    globalOriginRef.current = null;

    async function resolveAssetPaths() {
      try {
        const resolved = await Promise.all(
          assetConfigs.map(async (asset) => {
            const [objUrl, textureUrl] = await Promise.all([
              resolveDataUrl(asset.objPath),
              resolveDataUrl(asset.texturePath)
            ]);

            console.log('[Buildings] URLs résolues pour l\'asset:', asset.id, { objUrl, textureUrl });

            return {
              ...asset,
              objUrl,
              textureUrl
            };
          })
        );

        if (isMounted) {
          setResolvedAssets(resolved);
        }
      } catch (error) {
        console.error('[Buildings] Erreur lors de la résolution des assets:', error);
        if (isMounted) {
          setResolvedAssets([]);
        }
      }
    }

    resolveAssetPaths();

    return () => {
      isMounted = false;
      globalOriginRef.current = null;
    };
  }, [assetConfigs, visible]);
  
  // Ne rien afficher si pas visible
  if (!visible) {
    return null;
  }
  
  // Ne rien afficher tant que les URLs ne sont pas résolues
  if (resolvedAssets.length === 0) {
    return null;
  }
  
  // Charger tous les modèles avec leurs URLs résolues
  return (
    <>
      {resolvedAssets.map((asset) => (
        <BuildingsLoader 
          key={asset.id}
          objUrl={asset.objUrl}
          textureUrl={asset.textureUrl}
          visible={(asset.visible ?? true) && visible}
          showEdges={asset.showEdges ?? showEdges}
          edgeColor={asset.edgeColor ?? edgeColor}
          edgeThickness={asset.edgeThickness ?? edgeThickness}
          globalOriginRef={globalOriginRef}
          onLoadStart={onLoadStart}
          onLoadProgress={onLoadProgress}
          onLoadComplete={onLoadComplete}
        />
      ))}
    </>
  );
}

// Précharger le modèle pour améliorer les performances
// Note: useLoader gère automatiquement le cache, mais on peut précharger manuellement si nécessaire

