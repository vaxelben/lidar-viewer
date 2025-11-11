import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { CameraControls } from '@react-three/drei';
import * as THREE from 'three';
import { Copc } from 'copc';
import type { Getter } from 'copc';
import * as LazPerf from 'laz-perf';
import { Pane } from 'tweakpane';
import { DatGuiPanel } from './DatGuiPanel';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { resolveDataUrl } from '../utils/dataUrlResolver';

interface DirectLazViewerProps {
  lazFilePaths: string[]; // Tableau de chemins de fichiers LAZ
  pointSize?: number;
  maxPoints?: number; // Limite de points à charger par fichier (défaut: 2M)
}

// Interface pour représenter un node COPC avec ses métadonnées
interface COPCNodeMetadata {
  key: string;
  level: number;
  pointCount: number;
  bounds: {
    min: THREE.Vector3;
    max: THREE.Vector3;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodeData: any; // Données brutes du node COPC
}

// Interface pour les données chargées d'un node
interface LoadedNodeData {
  positions: Float32Array;
  colors: Float32Array;
  intensities: Float32Array;
  classifications: Uint8Array;
}

// Shader Eye-Dome Lighting (EDL) amélioré pour une meilleure perception de profondeur
const EDLShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2() },
    edlStrength: { value: 1.5 },
    radius: { value: 2.5 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform float edlStrength;
    uniform float radius;
    varying vec2 vUv;
    
    // Fonction pour lire la profondeur de manière robuste
    float readDepth(vec2 uv) {
      return texture2D(tDepth, uv).r;
    }
    
    void main() {
      float depth = readDepth(vUv);
      
      // Si pas de géométrie (fond), afficher la couleur originale
      if (depth >= 0.9999) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }
      
      // Linéariser la profondeur pour de meilleures comparaisons
      // Note: avec logarithmicDepthBuffer, la profondeur est déjà mieux distribuée
      float linearDepth = depth;
      
      float shade = 0.0;
      float weightSum = 0.0;
      
      // Échantillonnage amélioré en cercle (8 directions)
      const int samples = 8;
      for (int i = 0; i < samples; i++) {
        float angle = float(i) * 0.785398; // PI/4
        vec2 offset = vec2(cos(angle), sin(angle)) * radius / resolution;
        float sampleDepth = readDepth(vUv + offset);
        
        // Ignorer les échantillons en dehors de la géométrie
        if (sampleDepth < 0.9999) {
          // Calculer la différence de profondeur
          float diff = linearDepth - sampleDepth;
          
          // Accumuler seulement les différences positives (surfaces qui sont plus loin)
          if (diff > 0.0) {
            // Utiliser une fonction exponentielle pour accentuer les bords
            shade += diff;
            weightSum += 1.0;
          }
        }
      }
      
      // Calculer l'ombrage final
      float finalShade = 1.0;
      if (weightSum > 0.0) {
        float avgShade = shade / weightSum;
        // ✅ Facteur ajusté : 50.0 au lieu de 300.0 pour un effet plus visible
        // Plus le facteur est élevé, plus l'ombrage est fort
        finalShade = 1.0 - (avgShade * edlStrength * 50.0);
        finalShade = clamp(finalShade, 0.2, 1.0); // Limiter pour éviter le noir complet
      }
      
      vec4 color = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(color.rgb * finalShade, color.a);
    }
  `
};

// Créer un getter personnalisé pour le navigateur
function createBrowserGetter(url: string): Getter {
  return async (begin: number, end: number) => {
    const response = await fetch(url, {
      headers: {
        Range: `bytes=${begin}-${end - 1}`
      }
    });
    
    // Vérifier le statut HTTP
    // 206 = Partial Content (normal pour les requêtes Range)
    // 200 = OK (si le serveur ne supporte pas Range, il renvoie tout le fichier)
    if (!response.ok && response.status !== 206 && response.status !== 200) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `HTTP error! status: ${response.status} - ${response.statusText}\n` +
        `URL: ${url}\n` +
        `Range: bytes=${begin}-${end - 1}\n` +
        (errorText ? `Réponse: ${errorText.substring(0, 200)}` : '')
      );
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    
    // Vérifier que ce n'est pas du HTML (page d'erreur)
    // Les fichiers COPC commencent par "LASF" (0x4C 0x41 0x53 0x46)
    // Le HTML commence généralement par "<!do" ou "<htm"
    if (data.length > 0) {
      const firstBytes = Array.from(data.slice(0, 4))
        .map(b => String.fromCharCode(b))
        .join('');
      
      // Détecter HTML
      if (firstBytes.toLowerCase().startsWith('<!do') || 
          firstBytes.toLowerCase().startsWith('<htm') ||
          firstBytes[0] === '<') {
        const textDecoder = new TextDecoder();
        const preview = textDecoder.decode(data.slice(0, 500));
        throw new Error(
          `Le serveur a renvoyé du HTML au lieu du fichier binaire.\n` +
          `URL: ${url}\n` +
          `Range: bytes=${begin}-${end - 1}\n` +
          `Statut HTTP: ${response.status}\n` +
          `Aperçu de la réponse: ${preview}`
        );
      }
      
      // Pour les premiers bytes du fichier, vérifier la signature COPC
      if (begin === 0 && data.length >= 4) {
        const signature = String.fromCharCode(data[0], data[1], data[2], data[3]);
        if (signature !== 'LASF') {
          throw new Error(
            `Signature de fichier invalide: "${signature}" (attendu: "LASF")\n` +
            `URL: ${url}\n` +
            `Le fichier ne semble pas être un fichier LAZ/COPC valide.`
          );
        }
      }
    }
    
    return data;
  };
}

// Variable pour stocker l'instance laz-perf initialisée
let lazPerfInstance: typeof LazPerf | null = null;

// Cache global pour les métadonnées des fichiers COPC
const copcMetadataCache = new Map<string, {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  copc: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getter: any;
  nodes: Map<string, COPCNodeMetadata>;
  bounds: { min: THREE.Vector3; max: THREE.Vector3 };
}>();

// Cache pour les données chargées des nodes individuels
const nodeDataCache = new Map<string, LoadedNodeData>();

// [OBSOLÈTE] Anciens caches pour l'ancien système de chargement
// Conservés commentés pour référence
// const loadingCache = new Map<string, boolean>();
// const loadedDataCache = new Map<string, {...}>;

// Fonction pour initialiser laz-perf
async function initLazPerf() {
  if (!lazPerfInstance) {
    console.log("Initialisation de laz-perf...");
    // Initialiser laz-perf avec le chemin vers le fichier WASM
    // Utiliser import.meta.env.BASE_URL pour supporter le base path de GitHub Pages
    const baseUrl = import.meta.env.BASE_URL || '/';
    const wasmPath = `${baseUrl}laz-perf.wasm`.replace(/\/+/g, '/');
    lazPerfInstance = await LazPerf.create({
      'laz-perf.wasm': wasmPath
    });
    console.log("laz-perf initialisé avec succès");
  }
  return lazPerfInstance;
}

/**
 * [FONCTION OBSOLÈTE - Conservée pour référence]
 * Ancienne fonction pour charger un fichier COPC.LAZ avec tous les niveaux
 * Remplacée par loadCOPCMetadata + loadSingleNode pour le LOD dynamique par node
 */
/*
async function loadLAZFile(
  url: string, 
  maxPointsLimit: number = Infinity,
  maxLOD: number = Infinity,
  progressCallback?: (progress: number) => void,
  levelCallback?: (levelData: {
    level: number;
    positions: Float32Array;
    colors: Float32Array;
    intensities: Float32Array;
    classifications: Uint8Array;
    bounds: { min: THREE.Vector3; max: THREE.Vector3 };
    availableClassifications: number[];
    hasRGBColors: boolean;
  }) => void
): Promise<{
  positions: Float32Array;
  colors: Float32Array;
  intensities: Float32Array;
  classifications: Uint8Array;
  bounds: { min: THREE.Vector3; max: THREE.Vector3 };
  availableClassifications: number[];
  hasRGBColors: boolean;
}> {
  // Créer une clé de cache basée sur l'URL, la limite de points et le LOD
  const cacheKey = `${url}_${maxPointsLimit}_LOD${maxLOD}`;
  
  // Vérifier si le fichier est déjà en cours de chargement
  if (loadingCache.get(cacheKey)) {
    console.log(`⏳ Chargement déjà en cours pour ${url}, attente...`);
    // Attendre que le chargement soit terminé
    while (loadingCache.get(cacheKey)) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Retourner les données du cache
    const cached = loadedDataCache.get(cacheKey);
    if (cached) {
      console.log(`✅ Données récupérées du cache pour ${url}`);
      // S'assurer que les bounds sont des Vector3 valides
      return {
        ...cached,
        bounds: {
          min: new THREE.Vector3(cached.bounds.min.x, cached.bounds.min.y, cached.bounds.min.z),
          max: new THREE.Vector3(cached.bounds.max.x, cached.bounds.max.y, cached.bounds.max.z)
        }
      };
    }
  }
  
  // Vérifier si les données sont déjà en cache
  const cached = loadedDataCache.get(cacheKey);
  if (cached) {
    console.log(`✅ Fichier déjà chargé (cache), retour immédiat pour ${url}`);
    // S'assurer que les bounds sont des Vector3 valides
    return {
      ...cached,
      bounds: {
        min: new THREE.Vector3(cached.bounds.min.x, cached.bounds.min.y, cached.bounds.min.z),
        max: new THREE.Vector3(cached.bounds.max.x, cached.bounds.max.y, cached.bounds.max.z)
      }
    };
  }
  
  // Marquer comme en cours de chargement
  loadingCache.set(cacheKey, true);
  console.log(`📥 Début du chargement du fichier avec copc.js: ${url}`);
  
  try {
    // Initialiser laz-perf
    const lazPerf = await initLazPerf();
    
    // Créer un getter pour le navigateur
    const getter = createBrowserGetter(url);
    
    // Charger le fichier COPC
    const copc = await Copc.create(getter);
    
    console.log("Fichier COPC chargé");
    console.log("Header:", copc.header);
    console.log("Info:", copc.info);
    
    // Charger la page racine de la hiérarchie
    const rootPage = copc.info.rootHierarchyPage;
    const hierarchy = await Copc.loadHierarchyPage(getter, rootPage);
    
    // console.log("Hiérarchie chargée:", hierarchy);
    // console.log("Nombre de nodes:", Object.keys(hierarchy.nodes).length);
    
    const nodeKeys = Object.keys(hierarchy.nodes);
    // const totalNodes = nodeKeys.length;
    
    // Fonction pour extraire le niveau d'un node (ex: "4-5-8-0" -> niveau 4)
    const getNodeLevel = (key: string): number => {
      const parts = key.split('-');
      return parseInt(parts[0], 10);
    };
    
    // Pré-calculer le nombre total de points pour la pré-allocation
    let estimatedTotalPoints = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodesToLoad: { key: string; node: any; level: number }[] = [];
    
    // Statistiques par niveau
    const levelStats: { [level: number]: { count: number; points: number } } = {};
    
    for (const key of nodeKeys) {
      const node = hierarchy.nodes[key];
      if (!node || node.pointCount === 0) continue;
      
      const level = getNodeLevel(key);
      
      // ⚡ Filtrer par niveau de détail (LOD)
      if (level > maxLOD) {
        continue;
      }
      
      if (estimatedTotalPoints + node.pointCount > maxPointsLimit) {
        break;
      }
      
      nodesToLoad.push({ key, node, level });
      estimatedTotalPoints += node.pointCount;
      
      // Statistiques
      if (!levelStats[level]) {
        levelStats[level] = { count: 0, points: 0 };
      }
      levelStats[level].count++;
      levelStats[level].points += node.pointCount;
    }
    
    // const maxPointsDisplay = maxPointsLimit === Infinity ? 'Illimité' : maxPointsLimit.toLocaleString('fr-FR');
    // const maxLODDisplay = maxLOD === Infinity ? 'Tous niveaux' : `Niveaux 0-${maxLOD}`;
    // console.log(`📊 Statistiques de chargement:`);
    // console.log(`  - Total de nodes disponibles: ${totalNodes}`);
    // console.log(`  - Niveau de détail max: ${maxLODDisplay}`);
    // console.log(`  - Nodes à charger: ${nodesToLoad.length}`);
    // console.log(`  - Points estimés: ${estimatedTotalPoints.toLocaleString('fr-FR')} / ${maxPointsDisplay}`);
    
    // Afficher les statistiques par niveau
    // const levels = Object.keys(levelStats).map(Number).sort((a, b) => a - b);
    // if (levels.length > 0) {
    //   console.log(`\n📈 Distribution par niveau:`);
    //   for (const level of levels) {
    //     const stats = levelStats[level];
    //     console.log(`  Niveau ${level}: ${stats.count} nodes, ${stats.points.toLocaleString('fr-FR')} points`);
    //   }
    //   console.log('');
    // }
    
    // ⚡ Grouper les nodes par niveau pour chargement progressif
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodesByLevel: { [level: number]: { key: string; node: any }[] } = {};
    for (const { key, node, level } of nodesToLoad) {
      if (!nodesByLevel[level]) {
        nodesByLevel[level] = [];
      }
      nodesByLevel[level].push({ key, node });
    }
    
    const allLevels = Object.keys(nodesByLevel).map(Number).sort((a, b) => a - b);
    // console.log(`🎯 Chargement par niveaux: ${allLevels.join(', ')}`);
    
    // Variables globales pour accumulation
    const allPositions = new Float32Array(estimatedTotalPoints * 3);
    const allColors = new Float32Array(estimatedTotalPoints * 3);
    const allIntensities = new Float32Array(estimatedTotalPoints);
    const allClassifications = new Uint8Array(estimatedTotalPoints);
    const classificationsFound = new Set<number>();
    let currentPointIndex = 0;
    let totalPoints = 0;
    let hasRGBColors = false;
    
    // ⚡ Chargement séquentiel (un node à la fois) pour éviter les erreurs "Failed to fetch"
    // Pas de parallélisation pour garantir la stabilité
    
    // ⚡ Charger niveau par niveau (priorité au niveau 1)
    for (const level of allLevels) {
      const levelNodes = nodesByLevel[level];
      const levelPointsStart = currentPointIndex;
      
      // console.log(`\n📚 === Niveau ${level}: ${levelNodes.length} nodes ===`);
      
      // Charger chaque node séquentiellement
      for (let i = 0; i < levelNodes.length; i++) {
        const { key, node } = levelNodes[i];
        
        try {
          // Charger le node (séquentiel, un à la fois)
          const view = await Copc.loadPointDataView(getter, copc, node, { lazPerf });
          
          // Afficher les dimensions seulement pour le premier node
          if (totalPoints === 0) {
            console.log("Dimensions disponibles dans le fichier:", Object.keys(view.dimensions));
            console.log("Détails des dimensions:", view.dimensions);
          }
          
          // Extraire X, Y, Z, Classification, RGB (si disponible), et Intensité
          const getX = view.getter('X');
          const getY = view.getter('Y');
          const getZ = view.getter('Z');
          const getClassification = view.dimensions['Classification'] ? view.getter('Classification') : null;
          const getIntensity = view.dimensions['Intensity'] ? view.getter('Intensity') : null;
          
          // Vérifier si les couleurs RGB sont disponibles
          const getRed = view.dimensions['Red'] ? view.getter('Red') : null;
          const getGreen = view.dimensions['Green'] ? view.getter('Green') : null;
          const getBlue = view.dimensions['Blue'] ? view.getter('Blue') : null;
          
          // Si au moins une des composantes RGB existe dans ce node, marquer comme ayant des couleurs
          if (getRed || getGreen || getBlue) {
            hasRGBColors = true;
          }
          
          // Extraire les données directement dans les TypedArrays pré-alloués
          for (let j = 0; j < node.pointCount; j++) {
            const posIndex = currentPointIndex * 3;
            
            allPositions[posIndex] = getX(j);
            allPositions[posIndex + 1] = getY(j);
            allPositions[posIndex + 2] = getZ(j);
            
            const classification = getClassification ? getClassification(j) : 0;
            allClassifications[currentPointIndex] = classification;
            classificationsFound.add(classification);
            
            // Extraire l'intensité (normalisée entre 0 et 1)
            const intensity = getIntensity ? getIntensity(j) / 65535.0 : 0;
            allIntensities[currentPointIndex] = intensity;
            
            // Extraire les couleurs RGB (normalisées entre 0 et 1)
            // Les valeurs RGB dans LAZ sont généralement sur 16 bits (0-65535)
            const r = getRed ? getRed(j) / 65535.0 : 0;
            const g = getGreen ? getGreen(j) / 65535.0 : 0;
            const b = getBlue ? getBlue(j) / 65535.0 : 0;
            
            allColors[posIndex] = r;
            allColors[posIndex + 1] = g;
            allColors[posIndex + 2] = b;
            
            currentPointIndex++;
            totalPoints++;
          }
          
          // console.log(`    ✓ ${key}: ${node.pointCount.toLocaleString('fr-FR')} points`);
          
          if (progressCallback) {
            const overallProgress = totalPoints / estimatedTotalPoints;
            progressCallback(Math.min(overallProgress, 1.0));
          }
          
        } catch (error) {
          console.warn(`Erreur lors du chargement du node ${key}:`, error);
          // Continuer avec le node suivant même en cas d'erreur
        }
        
        // Petit délai entre chaque node pour éviter de surcharger le réseau
        if (i < levelNodes.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      
      // ⚡ CALLBACK après chaque niveau chargé
      const levelPointsEnd = currentPointIndex;
      const levelPointCount = levelPointsEnd - levelPointsStart;
      
      if (levelPointCount > 0 && levelCallback) {
        const levelPositions = allPositions.slice(levelPointsStart * 3, levelPointsEnd * 3);
        const levelColors = allColors.slice(levelPointsStart * 3, levelPointsEnd * 3);
        const levelIntensities = allIntensities.slice(levelPointsStart, levelPointsEnd);
        const levelClassifications = allClassifications.slice(levelPointsStart, levelPointsEnd);
        
        // Calculer bounds (utiliser bounds global pour l'instant)
        const bounds = {
          min: new THREE.Vector3(copc.header.min[0], copc.header.min[1], copc.header.min[2]),
          max: new THREE.Vector3(copc.header.max[0], copc.header.max[1], copc.header.max[2])
        };
        
        console.log(`✅ Niveau ${level} terminé: ${levelPointCount.toLocaleString('fr-FR')} points`);
        
        levelCallback({
          level,
          positions: levelPositions,
          colors: levelColors,
          intensities: levelIntensities,
          classifications: levelClassifications,
          bounds,
          availableClassifications: Array.from(classificationsFound).sort((a, b) => a - b),
          hasRGBColors
        });
      }
      
      // Petit délai entre les niveaux pour éviter de surcharger le réseau
      if (level < allLevels[allLevels.length - 1]) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    
    console.log(`Total de points chargés: ${totalPoints}`);
    
    // Afficher les classifications trouvées
    if (classificationsFound.size > 0) {
      const classificationNames: { [key: number]: string } = {
        0: "Jamais classé / Créé",
        1: "Non classé",
        2: "Sol",
        3: "Végétation basse",
        4: "Végétation moyenne",
        5: "Végétation haute / Arbres",
        6: "Bâtiments",
        7: "Bruit (Low Point)",
        8: "Réservé",
        9: "Eau",
        10: "Rail",
        11: "Surface de route",
        12: "Réservé",
        13: "Wire - Guard",
        14: "Wire - Conductor",
        15: "Tour de transmission",
        16: "Wire-structure Connector",
        17: "Pont",
        18: "Bruit élevé"
      };
      
      console.log("\n=== CLASSIFICATIONS TROUVÉES ===");
      const sortedClassifications = Array.from(classificationsFound).sort((a, b) => a - b);
      sortedClassifications.forEach(classId => {
        const name = classificationNames[classId] || `Inconnu (${classId})`;
        console.log(`  ${classId}: ${name}`);
      });
      console.log("================================\n");
    } else {
      console.log("Aucune classification trouvée dans ce fichier");
    }
    
    // ⚡ Les données sont déjà dans des TypedArrays pré-alloués !
    // Si le nombre de points chargés est inférieur à l'estimation, on crée des vues plus petites
    const positions = totalPoints < estimatedTotalPoints 
      ? allPositions.slice(0, totalPoints * 3)
      : allPositions;
    
    const colors = totalPoints < estimatedTotalPoints 
      ? allColors.slice(0, totalPoints * 3)
      : allColors;
    
    const intensities = totalPoints < estimatedTotalPoints 
      ? allIntensities.slice(0, totalPoints)
      : allIntensities;
    
    const classifications = totalPoints < estimatedTotalPoints
      ? allClassifications.slice(0, totalPoints)
      : allClassifications;
    
    // Calculer les limites (bounds) à partir des données du header COPC
    const bounds = {
      min: new THREE.Vector3(
        copc.header.min[0],
        copc.header.min[1],
        copc.header.min[2]
      ),
      max: new THREE.Vector3(
        copc.header.max[0],
        copc.header.max[1],
        copc.header.max[2]
      )
    };
    
    console.log("✅ Extraction terminée:", {
      points: totalPoints,
      hasRGBColors,
      memoryUsed: `${((positions.byteLength + colors.byteLength + intensities.byteLength + classifications.byteLength) / 1024 / 1024).toFixed(2)} MB`,
      bounds: {
        min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
        max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z }
      }
    });
  
    // Préparer les données à retourner avec les classifications trouvées
    const result = { 
      positions, 
      colors, 
      intensities, 
      classifications, 
      bounds,
      availableClassifications: Array.from(classificationsFound).sort((a, b) => a - b),
      hasRGBColors
    };
    
    // Mettre en cache les données chargées
    loadedDataCache.set(cacheKey, result);
    
    // Libérer le verrou de chargement
    loadingCache.set(cacheKey, false);
    
    console.log(`✅ Fichier chargé et mis en cache: ${url}`);
    
    return result;
  } catch (error) {
    // En cas d'erreur, libérer le verrou et supprimer du cache
    loadingCache.set(cacheKey, false);
    loadedDataCache.delete(cacheKey);
    
    console.error(`❌ Erreur lors du chargement du fichier ${url}:`, error);
    throw error; // Propager l'erreur
  }
}
*/

/**
 * Fonction pour charger uniquement les métadonnées d'un fichier COPC
 * (sans charger les points, juste la hiérarchie des nodes)
 */
async function loadCOPCMetadata(relativePath: string): Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  copc: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getter: any;
  nodes: Map<string, COPCNodeMetadata>;
  bounds: { min: THREE.Vector3; max: THREE.Vector3 };
  availableClassifications: number[];
  hasRGBColors: boolean;
}> {
  // Résoudre l'URL complète depuis la configuration
  const url = await resolveDataUrl(relativePath);
  
  // Vérifier le cache (utiliser le chemin relatif comme clé pour la cohérence)
  const cached = copcMetadataCache.get(relativePath);
  if (cached) {
    console.log(`✅ Métadonnées COPC déjà en cache pour ${relativePath}`);
    return {
      ...cached,
      availableClassifications: [],
      hasRGBColors: false
    };
  }

  console.log(`📥 Chargement des métadonnées COPC: ${relativePath} (${url})`);
  
  // Initialiser laz-perf
  await initLazPerf();
  
  // Créer un getter pour le navigateur avec l'URL résolue
  const getter = createBrowserGetter(url);
  
  // Charger le fichier COPC
  const copc = await Copc.create(getter);
  
  console.log("Métadonnées COPC chargées");
  console.log("Header:", copc.header);
  console.log("Info:", copc.info);
  
  // Charger la hiérarchie
  const rootPage = copc.info.rootHierarchyPage;
  const hierarchy = await Copc.loadHierarchyPage(getter, rootPage);
  
  // Créer la map des nodes avec leurs métadonnées
  const nodes = new Map<string, COPCNodeMetadata>();
  const nodeKeys = Object.keys(hierarchy.nodes);
  
  const getNodeLevel = (key: string): number => {
    const parts = key.split('-');
    return parseInt(parts[0], 10);
  };
  
  // Fonction pour calculer les bounds d'un node à partir de sa clé
  const calculateNodeBounds = (key: string, headerMin: number[], headerMax: number[]) => {
    const parts = key.split('-').map(Number);
    const level = parts[0];
    const x = parts[1];
    const y = parts[2];
    const z = parts[3];
    
    // Calculer la taille d'une cellule à ce niveau
    const span = headerMax.map((max, i) => max - headerMin[i]);
    const cellSize = span.map(s => s / Math.pow(2, level));
    
    // Calculer les bounds du node
    const min = new THREE.Vector3(
      headerMin[0] + x * cellSize[0],
      headerMin[1] + y * cellSize[1],
      headerMin[2] + z * cellSize[2]
    );
    
    const max = new THREE.Vector3(
      headerMin[0] + (x + 1) * cellSize[0],
      headerMin[1] + (y + 1) * cellSize[1],
      headerMin[2] + (z + 1) * cellSize[2]
    );
    
    return { min, max };
  };
  
  for (const key of nodeKeys) {
    const node = hierarchy.nodes[key];
    if (!node || node.pointCount === 0) continue;
    
    const level = getNodeLevel(key);
    const bounds = calculateNodeBounds(key, copc.header.min, copc.header.max);
    
    nodes.set(key, {
      key,
      level,
      pointCount: node.pointCount,
      bounds,
      nodeData: node
    });
  }
  
  const bounds = {
    min: new THREE.Vector3(copc.header.min[0], copc.header.min[1], copc.header.min[2]),
    max: new THREE.Vector3(copc.header.max[0], copc.header.max[1], copc.header.max[2])
  };
  
  console.log(`✅ ${nodes.size} nodes trouvés dans la hiérarchie`);
  
  // Mettre en cache (utiliser le chemin relatif comme clé pour la cohérence)
  const metadata = { copc, getter, nodes, bounds };
  copcMetadataCache.set(relativePath, metadata);
  
  return {
    ...metadata,
    availableClassifications: [],
    hasRGBColors: false
  };
}

/**
 * Fonction pour charger les données d'un node spécifique
 */
async function loadSingleNode(
  relativePath: string,
  nodeKey: string
): Promise<LoadedNodeData | null> {
  // Créer une clé de cache unique (utiliser le chemin relatif pour la cohérence)
  const cacheKey = `${relativePath}_${nodeKey}`;
  
  // Vérifier le cache
  const cached = nodeDataCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  
  // Récupérer les métadonnées (utiliser le chemin relatif comme clé)
  const metadata = copcMetadataCache.get(relativePath);
  if (!metadata) {
    console.error(`Métadonnées non trouvées pour ${relativePath}`);
    return null;
  }
  
  const nodeMetadata = metadata.nodes.get(nodeKey);
  if (!nodeMetadata) {
    console.error(`Node ${nodeKey} non trouvé dans les métadonnées`);
    return null;
  }
  
  // ⚡ Délai réduit pour accélérer le chargement
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Charger les données du node avec gestion d'erreur complète
  let view;
  try {
    const lazPerf = await initLazPerf();
    view = await Copc.loadPointDataView(
      metadata.getter,
      metadata.copc,
      nodeMetadata.nodeData,
      { lazPerf }
    );
  } catch (error) {
    console.error(`❌ Erreur lors du chargement du node ${nodeKey} du fichier ${relativePath}:`, error);
    // Retourner null pour indiquer que le node n'a pas pu être chargé
    return null;
  }
  
  // Extraire les données avec gestion d'erreur
  try {
    const pointCount = nodeMetadata.pointCount;
    const positions = new Float32Array(pointCount * 3);
    const colors = new Float32Array(pointCount * 3);
    const intensities = new Float32Array(pointCount);
    const classifications = new Uint8Array(pointCount);
    
    const getX = view.getter('X');
    const getY = view.getter('Y');
    const getZ = view.getter('Z');
    const getClassification = view.dimensions['Classification'] ? view.getter('Classification') : null;
    const getIntensity = view.dimensions['Intensity'] ? view.getter('Intensity') : null;
    const getRed = view.dimensions['Red'] ? view.getter('Red') : null;
    const getGreen = view.dimensions['Green'] ? view.getter('Green') : null;
    const getBlue = view.dimensions['Blue'] ? view.getter('Blue') : null;
    
    for (let i = 0; i < pointCount; i++) {
      positions[i * 3] = getX(i);
      positions[i * 3 + 1] = getY(i);
      positions[i * 3 + 2] = getZ(i);
      
      classifications[i] = getClassification ? getClassification(i) : 0;
      intensities[i] = getIntensity ? getIntensity(i) / 65535.0 : 0;
      
      colors[i * 3] = getRed ? getRed(i) / 65535.0 : 0;
      colors[i * 3 + 1] = getGreen ? getGreen(i) / 65535.0 : 0;
      colors[i * 3 + 2] = getBlue ? getBlue(i) / 65535.0 : 0;
    }
    
    const nodeData = { positions, colors, intensities, classifications };
    
    // Mettre en cache
    nodeDataCache.set(cacheKey, nodeData);
    
    return nodeData;
  } catch (error) {
    console.error(`❌ Erreur lors de l'extraction des données du node ${nodeKey} du fichier ${relativePath}:`, error);
    // Retourner null pour indiquer que le node n'a pas pu être traité
    return null;
  }
}

// Interface pour les contrôles CameraControls
interface CameraControlsType {
  target: THREE.Vector3;
  update: () => void;
}

// Composant pour configurer la caméra
// @ts-expect-error - TypeScript ne détecte pas l'utilisation dans le JSX
function CameraSetup({ bounds }: { bounds: { min: THREE.Vector3; max: THREE.Vector3 } }) {
  const { camera, controls } = useThree();
  const initializedRef = useRef(false);
  
  useEffect(() => {
    // N'exécuter qu'une seule fois pour éviter les conflits avec CameraControls
    if (initializedRef.current) return;
    initializedRef.current = true;
    
    // Le centre est à (0, 0, 0) car les positions sont déjà centrées
    const center = new THREE.Vector3(0, 0, 0);
    
    // Calculer la taille du nuage de points
    const size = new THREE.Vector3(
      bounds.max.x - bounds.min.x,
      bounds.max.y - bounds.min.y,
      bounds.max.z - bounds.min.z
    );
    
    // Calculer la distance de la caméra pour voir l'ensemble du nuage
    const maxDim = Math.max(size.x, size.y, size.z);
    const fitOffset = 1.0; // Augmenté pour avoir une meilleure vue d'ensemble
    const distance = maxDim * fitOffset;
    
    // Positionner la caméra
    camera.position.set(
      0,
      distance * -0.5,
      distance
    );
    
    camera.lookAt(center);
    
    // Ajuster les plans de clipping
    camera.near = distance * 0.001;
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    
    // Si les contrôles sont disponibles, définir leur cible
    if (controls && 'target' in controls && 'update' in controls) {
      (controls as unknown as CameraControlsType).target.copy(center);
      (controls as unknown as CameraControlsType).update();
    }
    
    console.log("Caméra configurée:", {
      position: camera.position.toArray(),
      target: center.toArray(),
      distance,
      near: camera.near,
      far: camera.far
    });
  }, [bounds, camera, controls]);
  
  return null;
}

// Composant pour gérer le LOD dynamique par node basé sur la distance de la caméra
function DynamicNodeLODManager({
  filePaths,
  globalBounds,
  onNodesUpdate
}: {
  filePaths: string[];
  globalBounds: { min: THREE.Vector3; max: THREE.Vector3 };
  onNodesUpdate: (nodesToRender: { fileUrl: string; nodeKey: string; level: number; distance: number }[]) => void;
}) {
  const { camera } = useThree();
  const frameCountRef = useRef<number>(0);
  const loadingNodesRef = useRef<Set<string>>(new Set());
  const lastNodesRef = useRef<string>(''); // Pour comparer les nodes à rendre
  const lastCameraPositionRef = useRef<THREE.Vector3>(new THREE.Vector3());
  
  // ✅ CORRECTIF 1 : File d'attente de chargement avec limite de concurrence
  const loadingQueueRef = useRef<Array<{ cacheKey: string; fileUrl: string; nodeKey: string; distance: number; retries: number }>>([]);
  const currentlyLoadingRef = useRef<number>(0);
  const maxConcurrentLoads = 2; // ⚡ Augmenté à 2 pour plus de rapidité
  const delayBetweenLoads = 150; // ⚡ Réduit à 150ms entre chargements
  const maxRetries = 2; // 2 tentatives
  
  // ✅ CORRECTIF 2 : Debouncing des mises à jour LOD
  const lodUpdateTimerRef = useRef<number>(0);
  const pendingNodesRef = useRef<Array<{ fileUrl: string; nodeKey: string; level: number; distance: number }> | null>(null);
  const LOD_UPDATE_DELAY = 100; // ⚡ Réduit à 100ms pour plus de réactivité
  
  // ✅ CORRECTIF 1 : Fonction pour traiter la file d'attente de chargement avec retry
  const processLoadQueue = useCallback(() => {
    if (loadingQueueRef.current.length > 0 && currentlyLoadingRef.current < maxConcurrentLoads) {
      const item = loadingQueueRef.current.shift()!;
      const { cacheKey, fileUrl, nodeKey, retries } = item;
      
      currentlyLoadingRef.current++;
      
      // ⚡ Délai avant chaque chargement
      setTimeout(() => {
        loadSingleNode(fileUrl, nodeKey).then(() => {
          currentlyLoadingRef.current--;
          loadingNodesRef.current.delete(cacheKey);
          // Continuer après un délai
          setTimeout(() => processLoadQueue(), delayBetweenLoads);
        }).catch((_err) => {
          currentlyLoadingRef.current--;
          
          // ✅ Système de retry
          if (retries < maxRetries) {
            console.warn(`⚠️ Échec node ${nodeKey}, retry ${retries + 1}/${maxRetries}`);
            // Remettre en queue avec un retry incrémenté
            loadingQueueRef.current.push({ cacheKey, fileUrl, nodeKey, distance: item.distance, retries: retries + 1 });
          } else {
            console.error(`❌ Échec définitif node ${nodeKey} après ${maxRetries} tentatives`);
            loadingNodesRef.current.delete(cacheKey);
          }
          
          // ⚡ Délai plus long en cas d'erreur (500ms)
          setTimeout(() => processLoadQueue(), 500);
        });
      }, delayBetweenLoads);
    }
  }, []);
  
  // Calculer la taille du nuage pour les distances relatives
  const cloudSize = useMemo(() => {
    const size = new THREE.Vector3(
      globalBounds.max.x - globalBounds.min.x,
      globalBounds.max.y - globalBounds.min.y,
      globalBounds.max.z - globalBounds.min.z
    );
    return size.length();
  }, [globalBounds]);
  
  // Fonction pour calculer la distance de la caméra à un node et sa largeur
  const getDistanceAndWidth = useCallback((nodeBounds: { min: THREE.Vector3; max: THREE.Vector3 }): { distance: number; nodeWidth: number } => {
    // Centre du node (en coordonnées non centrées)
    const nodeCenter = new THREE.Vector3(
      (nodeBounds.min.x + nodeBounds.max.x) / 2,
      (nodeBounds.min.y + nodeBounds.max.y) / 2,
      (nodeBounds.min.z + nodeBounds.max.z) / 2
    );
    
    // Centre du nuage global
    const globalCenter = new THREE.Vector3(
      (globalBounds.min.x + globalBounds.max.x) / 2,
      (globalBounds.min.y + globalBounds.max.y) / 2,
      (globalBounds.min.z + globalBounds.max.z) / 2
    );
    
    // Position du node centré
    const centeredNodePos = nodeCenter.clone().sub(globalCenter);
    const distance = camera.position.distanceTo(centeredNodePos);
    
    // Calculer la largeur du node (diagonale de la bounding box)
    const nodeSize = new THREE.Vector3(
      nodeBounds.max.x - nodeBounds.min.x,
      nodeBounds.max.y - nodeBounds.min.y,
      nodeBounds.max.z - nodeBounds.min.z
    );
    const nodeWidth = nodeSize.length(); // Diagonale = taille du node
    
    return { distance, nodeWidth };
  }, [camera.position, globalBounds]);
  
  // Fonction pour vérifier si un node est dans le frustum de la caméra
  // Le frustum est passé en paramètre pour éviter de le recréer à chaque appel
  const isNodeInFrustum = useCallback((
    nodeBounds: { min: THREE.Vector3; max: THREE.Vector3 },
    frustum: THREE.Frustum
  ): boolean => {
    // Centre du nuage global
    const globalCenter = new THREE.Vector3(
      (globalBounds.min.x + globalBounds.max.x) / 2,
      (globalBounds.min.y + globalBounds.max.y) / 2,
      (globalBounds.min.z + globalBounds.max.z) / 2
    );
    
    // Convertir les bounds du node en coordonnées centrées
    const nodeMin = nodeBounds.min.clone().sub(globalCenter);
    const nodeMax = nodeBounds.max.clone().sub(globalCenter);
    
    // Créer une bounding box pour le node
    const box = new THREE.Box3(nodeMin, nodeMax);
    
    // Vérifier si la bounding box intersecte le frustum
    return frustum.intersectsBox(box);
  }, [globalBounds]);
  
  // Fonction pour calculer le niveau de LOD approprié pour un node
  // Basé sur la largeur du node : distance < 1 largeur = LOD max, < 2 largeurs = LOD-1, etc.
  // Retourne un LOD théorique qui sera ensuite limité au niveau maximum disponible
  const getLODForDistance = useCallback((distance: number, nodeWidth: number): number => {
    // Normaliser la distance par la largeur du node
    const distanceInWidths = distance / nodeWidth;
    
    // Calculer le LOD théorique basé sur la distance
    // Plus la distance est petite (en multiples de la largeur), plus le LOD est élevé
    // Formule : LOD = max(1, floor(5 - distanceInWidths))
    // 
    // Exemples :
    // distance = 0.1x largeur → LOD = floor(5 - 0.1) = 4
    // distance = 0.5x largeur → LOD = floor(5 - 0.5) = 4
    // distance = 1.0x largeur → LOD = floor(5 - 1.0) = 4
    // distance = 1.5x largeur → LOD = floor(5 - 1.5) = 3
    // distance = 2.0x largeur → LOD = floor(5 - 2.0) = 3
    // distance = 2.5x largeur → LOD = floor(5 - 2.5) = 2
    // distance = 3.0x largeur → LOD = floor(5 - 3.0) = 2
    // distance = 3.5x largeur → LOD = floor(5 - 3.5) = 1
    // distance = 4.0x largeur → LOD = floor(5 - 4.0) = 1
    // distance >= 4.0x largeur → LOD = 1 (minimum)
    //
    // Pour supporter plus de niveaux, on peut utiliser une formule plus agressive :
    // LOD = max(1, floor(10 - distanceInWidths * 2))
    // Cela permet d'avoir des LOD jusqu'à 9 pour distance < 0.5x largeur
    
    // Formule adaptative qui supporte jusqu'à 10 niveaux
    const theoreticalLOD = Math.max(1, Math.floor(5 - distanceInWidths / 2));
    
    return theoreticalLOD;
  }, []);
  
  useFrame(() => {
    frameCountRef.current++;
    
    // Vérifier si la caméra a bougé (position OU rotation)
    // Seuil très petit (0.1% de la taille du nuage) pour détecter tous les mouvements
    const positionMoved = camera.position.distanceTo(lastCameraPositionRef.current) > cloudSize * 0.001;
    
    // Recalculer à chaque frame si la caméra bouge, sinon toutes les 30 frames pour économiser les ressources
    if (!positionMoved && frameCountRef.current % 30 !== 0) return;
    
    // Sauvegarder la position actuelle de la caméra
    lastCameraPositionRef.current.copy(camera.position);
    
    const nodesToRender: { fileUrl: string; nodeKey: string; level: number; distance: number }[] = [];
    const debugInfo: { [level: number]: number } = {};
    let culledNodesCount = 0;
    let visibleNodesCount = 0;
    
    // ✅ CORRECTIF 3 : Liste des nodes manquants à charger avec leur distance
    const missingNodes: Array<{ cacheKey: string; fileUrl: string; nodeKey: string; distance: number }> = [];
    
    // Mettre à jour la matrice de projection de la caméra avant de calculer le frustum
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    
    // Créer le frustum une seule fois par frame pour optimiser les performances
    const frustum = new THREE.Frustum();
    const matrix = new THREE.Matrix4().multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    );
    frustum.setFromProjectionMatrix(matrix);
    
    // Pour chaque fichier
    for (const fileUrl of filePaths) {
      const metadata = copcMetadataCache.get(fileUrl);
      if (!metadata) continue;
      
      // Trouver le niveau maximum disponible dans ce fichier (calculé une seule fois et mis en cache)
      const metadataWithCache = metadata as typeof metadata & { __maxLevel?: number };
      let maxAvailableLevel = metadataWithCache.__maxLevel;
      if (maxAvailableLevel === undefined) {
        maxAvailableLevel = 0;
        for (const node of metadata.nodes.values()) {
          if (node.level > maxAvailableLevel) {
            maxAvailableLevel = node.level;
          }
        }
        metadataWithCache.__maxLevel = maxAvailableLevel;
      }
      
      // Parcourir tous les nodes et afficher ceux dont le niveau est <= LOD requis
      // Affichage cumulatif : si LOD requis = 3, afficher niveaux 1, 2 et 3
      for (const node of metadata.nodes.values()) {
        const { distance, nodeWidth } = getDistanceAndWidth(node.bounds);
        
        // 🔍 FRUSTUM CULLING : Vérifier si le node est visible dans le frustum
        const isVisible = isNodeInFrustum(node.bounds, frustum);
        
        if (!isVisible) {
          culledNodesCount++;
        } else {
          visibleNodesCount++;
        }
        
        let requiredLOD: number;
        if (!isVisible) {
          // Si le node n'est pas visible, forcer le LOD à 1
          requiredLOD = 1;
        } else {
          // Si le node est visible, calculer le LOD normalement
          requiredLOD = getLODForDistance(distance, nodeWidth);
        }
        
        // Limiter le LOD requis au niveau maximum disponible
        requiredLOD = Math.min(requiredLOD, maxAvailableLevel);
        
        // Afficher ce node si son niveau est <= LOD requis (affichage cumulatif)
        // LOD requis = 1 → afficher niveau 1
        // LOD requis = 2 → afficher niveaux 1 et 2
        // LOD requis = 3 → afficher niveaux 1, 2 et 3
        // LOD requis = N → afficher niveaux 1, 2, 3, ..., N
        if (node.level <= requiredLOD && node.level >= 1) {
          nodesToRender.push({
            fileUrl,
            nodeKey: node.key,
            level: node.level,
            distance: distance
          });
          
          // Stats pour debug
          if (!debugInfo[node.level]) debugInfo[node.level] = 0;
          debugInfo[node.level]++;
          
          // ✅ CORRECTIF 1 : Au lieu de charger immédiatement, ajouter à la liste des manquants
          const cacheKey = `${fileUrl}_${node.key}`;
          if (!nodeDataCache.has(cacheKey) && !loadingNodesRef.current.has(cacheKey)) {
            missingNodes.push({ cacheKey, fileUrl, nodeKey: node.key, distance });
          }
        }
      }
    }
    
    // ✅ CORRECTIF 3 : Trier les nodes manquants par distance (les plus proches en premier)
    missingNodes.sort((a, b) => a.distance - b.distance);
    
    // ✅ CORRECTIF 1 : Ajouter les nodes manquants à la file d'attente
    for (const node of missingNodes) {
      if (!loadingNodesRef.current.has(node.cacheKey)) {
        loadingNodesRef.current.add(node.cacheKey);
        loadingQueueRef.current.push({ ...node, retries: 0 });
      }
    }
    
    // ✅ CORRECTIF 1 : Traiter la file d'attente
    processLoadQueue();
    
    // ✅ CORRECTIF 2 : Au lieu de mettre à jour immédiatement, utiliser un debounce
    pendingNodesRef.current = nodesToRender;
    
    if (lodUpdateTimerRef.current) {
      clearTimeout(lodUpdateTimerRef.current);
    }
    
    lodUpdateTimerRef.current = window.setTimeout(() => {
      if (!pendingNodesRef.current) return;
      
      // Créer une signature unique pour comparer les nodes (sans la distance qui change légèrement)
      const nodesSignature = pendingNodesRef.current
        .map(n => `${n.fileUrl}:${n.nodeKey}:${n.level}`)
        .sort()
        .join('|');
      
      // Ne mettre à jour que si les nodes ont changé
      if (nodesSignature !== lastNodesRef.current) {
        lastNodesRef.current = nodesSignature;
        onNodesUpdate(pendingNodesRef.current);
        
        // Log uniquement quand il y a un changement
        console.log(`🔄 LOD mise à jour: ${pendingNodesRef.current.length} nodes à rendre (${missingNodes.length} en cours de chargement)`);
        console.log(`   Répartition par niveau:`, debugInfo);
        console.log(`   🔍 Frustum culling: ${visibleNodesCount} visibles, ${culledNodesCount} cullés (LOD 1)`);
        console.log(`   📦 File d'attente: ${loadingQueueRef.current.length} en attente, ${currentlyLoadingRef.current}/${maxConcurrentLoads} en cours`);
      }
    }, LOD_UPDATE_DELAY);
    
    // Afficher des infos de debug toutes les 5 secondes (150 frames à 30fps)
    if (frameCountRef.current % 150 === 0) {
      console.log(`🎯 LOD dynamique: ${nodesToRender.length} nodes actifs`);
      console.log(`   Position caméra:`, camera.position.toArray().map(v => v.toFixed(1)));
    }
  });
  
  return null;
}

// Composant pour l'effet Eye-Dome Lighting
function EDLEffect({ 
  edlStrength, 
  edlRadius 
}: { 
  edlStrength: number; 
  edlRadius: number; 
}) {
  const { gl, scene, camera, size } = useThree();
  const composerRef = useRef<EffectComposer | null>(null);
  const edlPassRef = useRef<ShaderPass | null>(null);

  useEffect(() => {
    // CORRECTION : Créer explicitement une texture de profondeur
    const depthTexture = new THREE.DepthTexture(size.width, size.height);
    depthTexture.type = THREE.FloatType;  // ✅ FloatType pour meilleure précision avec logarithmic depth
    depthTexture.format = THREE.DepthFormat;

    // Créer un render target avec la texture de profondeur
    const renderTarget = new THREE.WebGLRenderTarget(size.width, size.height, {
      minFilter: THREE.NearestFilter,  // ✅ NearestFilter pour éviter l'interpolation de profondeur
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,  // ✅ Pour les couleurs
      depthTexture: depthTexture,  // ✅ Assigner la texture de profondeur
      depthBuffer: true,
      stencilBuffer: false
    });

    // Créer le composer
    const composer = new EffectComposer(gl, renderTarget);
    composer.setSize(size.width, size.height);

    // Ajouter le RenderPass
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    // Créer et ajouter le ShaderPass EDL
    const edlPass = new ShaderPass(EDLShader);
    edlPass.uniforms.resolution.value.set(size.width, size.height);
    edlPass.uniforms.tDepth.value = depthTexture;  // ✅ Utiliser la texture créée
    edlPass.uniforms.edlStrength.value = edlStrength;
    edlPass.uniforms.radius.value = edlRadius;
    composer.addPass(edlPass);

    composerRef.current = composer;
    edlPassRef.current = edlPass;

    // Log uniquement la première fois
    const windowWithFlags = window as Window & { __edlInitialized?: boolean };
    if (!windowWithFlags.__edlInitialized) {
      console.log("EDL Effect initialized:", {
        resolution: [size.width, size.height],
        edlStrength,
        edlRadius
      });
      windowWithFlags.__edlInitialized = true;
    }

    return () => {
      composer.dispose();
      renderTarget.dispose();
      depthTexture.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera, size.width, size.height]);

  // Mettre à jour les paramètres EDL
  useEffect(() => {
    if (edlPassRef.current) {
      edlPassRef.current.uniforms.edlStrength.value = edlStrength;
      edlPassRef.current.uniforms.radius.value = edlRadius;
    }
  }, [edlStrength, edlRadius]);

  // Utiliser le composer pour le rendu au lieu du renderer par défaut
  useFrame(() => {
    if (composerRef.current) {
      composerRef.current.render();
    }
  }, 1); // Priority 1 pour s'assurer que c'est rendu en dernier

  return null;
}

// Composant pour rendre un node individuel sans fusion
function NodeRenderer({
  fileUrl,
  nodeKey,
  globalBounds,
  visibleClassifications,
  colorMode,
  pointSize
}: {
  fileUrl: string;
  nodeKey: string;
  globalBounds: { min: THREE.Vector3; max: THREE.Vector3 };
  visibleClassifications: Set<number>;
  colorMode: 'classification' | 'altitude' | 'natural';
  pointSize: number;
}) {
  const geometryRef = useRef<THREE.BufferGeometry | null>(null);
  const materialRef = useRef<THREE.PointsMaterial | null>(null);
  const meshRef = useRef<THREE.Points | null>(null);
  
  // Charger les données du node
  const cacheKey = `${fileUrl}_${nodeKey}`;
  const nodeData = nodeDataCache.get(cacheKey);
  
  // Centre du nuage global pour centrer les positions
  const globalCenter = useMemo(() => new THREE.Vector3(
    (globalBounds.min.x + globalBounds.max.x) / 2,
    (globalBounds.min.y + globalBounds.max.y) / 2,
    (globalBounds.min.z + globalBounds.max.z) / 2
  ), [globalBounds]);
  
  // Créer/mettre à jour la géométrie
  useEffect(() => {
    if (!nodeData) return;
    
    const { positions, colors, classifications } = nodeData;
    const pointCount = positions.length / 3;
    
    // Filtrer et centrer les positions, appliquer le mode de couleur
    const filteredPositions: number[] = [];
    const filteredColors: number[] = [];
    
    for (let i = 0; i < pointCount; i++) {
      if (!visibleClassifications.has(classifications[i])) continue;
      
      // Positions centrées
      filteredPositions.push(
        positions[i * 3] - globalCenter.x,
        positions[i * 3 + 1] - globalCenter.y,
        positions[i * 3 + 2] - globalCenter.z
      );
      
      // Couleurs selon le mode
      let r: number, g: number, b: number;
      if (colorMode === 'natural') {
        r = colors[i * 3];
        g = colors[i * 3 + 1];
        b = colors[i * 3 + 2];
      } else if (colorMode === 'altitude') {
        const altitude = positions[i * 3 + 2];
        [r, g, b] = getColorForAltitude(altitude, globalBounds.min.z, globalBounds.max.z);
      } else {
        [r, g, b] = getColorForClassification(classifications[i]);
      }
      filteredColors.push(r, g, b);
    }
    
    if (filteredPositions.length === 0) {
      // Pas de points visibles, cacher la géométrie
      if (meshRef.current) meshRef.current.visible = false;
      return;
    }
    
    // Créer ou mettre à jour la géométrie
    if (!geometryRef.current) {
      geometryRef.current = new THREE.BufferGeometry();
    }
    
    const geo = geometryRef.current;
    const posArray = new Float32Array(filteredPositions);
    const colArray = new Float32Array(filteredColors);
    
    // Réutiliser ou créer les buffers
    const posAttr = geo.getAttribute('position');
    if (posAttr && posAttr.array.length === posArray.length) {
      (posAttr.array as Float32Array).set(posArray);
      posAttr.needsUpdate = true;
    } else {
      geo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    }
    
    const colAttr = geo.getAttribute('color');
    if (colAttr && colAttr.array.length === colArray.length) {
      (colAttr.array as Float32Array).set(colArray);
      colAttr.needsUpdate = true;
    } else {
      geo.setAttribute('color', new THREE.BufferAttribute(colArray, 3));
    }
    
    if (meshRef.current) meshRef.current.visible = true;
  }, [nodeData, visibleClassifications, colorMode, globalCenter, globalBounds]);
  
  // Créer le matériau
  useEffect(() => {
    if (!materialRef.current) {
      materialRef.current = new THREE.PointsMaterial({
        size: pointSize,
        vertexColors: true,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.5,
        depthWrite: true,
        depthTest: true,
        alphaTest: 0.5,
        blending: THREE.NormalBlending,
        toneMapped: false
      });
    } else {
      materialRef.current.size = pointSize;
      materialRef.current.needsUpdate = true;
    }
  }, [pointSize]);
  
  if (!nodeData || !geometryRef.current || !materialRef.current) return null;
  
  return <points ref={meshRef} geometry={geometryRef.current} material={materialRef.current} />;
}

// Composant pour gérer tous les nodes visibles
function DynamicNodeRenderer({
  nodesToRenderKeys,
  allNodes,
  globalBounds,
  visibleClassifications,
  colorMode,
  pointSize
}: {
  nodesToRenderKeys: Set<string>;
  allNodes: { fileUrl: string; nodeKey: string }[];
  globalBounds: { min: THREE.Vector3; max: THREE.Vector3 };
  visibleClassifications: Set<number>;
  colorMode: 'classification' | 'altitude' | 'natural';
  pointSize: number;
}) {
  return (
    <>
      {allNodes.map(node => {
        const cacheKey = `${node.fileUrl}_${node.nodeKey}`;
        const shouldRender = nodesToRenderKeys.has(cacheKey);
        
        if (!shouldRender || !nodeDataCache.has(cacheKey)) return null;
        
        return (
          <NodeRenderer
            key={cacheKey}
            fileUrl={node.fileUrl}
            nodeKey={node.nodeKey}
            globalBounds={globalBounds}
            visibleClassifications={visibleClassifications}
            colorMode={colorMode}
            pointSize={pointSize}
          />
        );
      })}
    </>
  );
}

// Mapper les classifications vers des couleurs
function getColorForClassification(classification: number): [number, number, number] {
  const classificationColors: { [key: number]: [number, number, number] } = {
    0: [0.5, 0.5, 0.5],     // Jamais classé / Créé - Gris
    1: [0.7, 0.7, 0.7],     // Non classé - Gris clair
    2: [0.6, 0.4, 0.2],     // Sol - Brun
    3: [0.4, 0.8, 0.3],     // Végétation basse - Vert clair
    4: [0.2, 0.7, 0.2],     // Végétation moyenne - Vert
    5: [0.1, 0.5, 0.1],     // Végétation haute / Arbres - Vert foncé
    6: [0.8, 0.2, 0.2],     // Bâtiments - Rouge
    7: [0.3, 0.3, 0.3],     // Bruit (Low Point) - Gris foncé
    8: [0.5, 0.5, 0.5],     // Réservé - Gris
    9: [0.2, 0.4, 0.8],     // Eau - Bleu
    10: [0.4, 0.4, 0.4],    // Rail - Gris
    11: [0.3, 0.3, 0.3],    // Surface de route - Gris foncé
    12: [0.5, 0.5, 0.5],    // Réservé - Gris
    13: [0.9, 0.6, 0.0],    // Wire - Guard - Orange
    14: [0.9, 0.7, 0.0],    // Wire - Conductor - Jaune-orange
    15: [0.6, 0.6, 0.6],    // Tour de transmission - Gris
    16: [0.7, 0.7, 0.7],    // Wire-structure Connector - Gris clair
    17: [0.5, 0.3, 0.1],    // Pont - Brun
    18: [0.2, 0.2, 0.2],    // Bruit élevé - Gris très foncé
  };
  
  return classificationColors[classification] || [1.0, 1.0, 1.0]; // Blanc par défaut
}

// Calculer la couleur basée sur l'altitude avec un gradient
// Gradient : bleu foncé -> bleu clair -> vert foncé -> vert clair -> jaune -> orange -> rouge
function getColorForAltitude(altitude: number, minAlt: number, maxAlt: number): [number, number, number] {
  // Normaliser l'altitude entre 0 et 1
  const normalized = (altitude - minAlt) / (maxAlt - minAlt);
  const t = Math.max(0, Math.min(1, normalized)); // Clamp entre 0 et 1
  
  // Définir les couleurs du gradient avec leurs positions (0 à 1)
  const gradientStops: Array<{ pos: number; color: [number, number, number] }> = [
    { pos: 0.0,  color: [0.0, 0.0, 0.5] },   // Bleu foncé
    { pos: 0.15, color: [0.0, 0.5, 1.0] },   // Bleu clair
    { pos: 0.3,  color: [0.0, 0.5, 0.0] },   // Vert foncé
    { pos: 0.45, color: [0.5, 1.0, 0.0] },   // Vert clair
    { pos: 0.6,  color: [1.0, 1.0, 0.0] },   // Jaune
    { pos: 0.75, color: [1.0, 0.5, 0.0] },   // Orange
    { pos: 1.0,  color: [1.0, 0.0, 0.0] }    // Rouge
  ];
  
  // Trouver les deux couleurs entre lesquelles interpoler
  let i = 0;
  while (i < gradientStops.length - 1 && t > gradientStops[i + 1].pos) {
    i++;
  }
  
  const stop1 = gradientStops[i];
  const stop2 = gradientStops[i + 1];
  
  // Calculer le facteur d'interpolation local entre les deux stops
  const localT = (t - stop1.pos) / (stop2.pos - stop1.pos);
  
  // Interpoler linéairement entre les deux couleurs
  const r = stop1.color[0] + (stop2.color[0] - stop1.color[0]) * localT;
  const g = stop1.color[1] + (stop2.color[1] - stop1.color[1]) * localT;
  const b = stop1.color[2] + (stop2.color[2] - stop1.color[2]) * localT;
  
  return [r, g, b];
}

// [OBSOLÈTE] Ancien composant PointCloudRenderer avec fusion
// Remplacé par NodeRenderer + DynamicNodeRenderer pour éviter les freezes
/*
function PointCloudRenderer({
  positions,
  colors,
  classifications,
  bounds,
  pointSize,
  visibleClassifications,
  colorMode = 'classification'
}: {
  positions: Float32Array;
  colors: Float32Array;
  classifications: Uint8Array;
  bounds: { min: THREE.Vector3; max: THREE.Vector3 };
  pointSize: number;
  visibleClassifications: Set<number>;
  colorMode?: 'classification' | 'altitude' | 'natural';
}) {
  // États pour forcer le re-render quand la géométrie/matériau sont créés
  const [geometryReady, setGeometryReady] = useState(false);
  const [materialReady, setMaterialReady] = useState(false);
  
  // Références pour conserver les objets entre les rendus
  const geometryRef = useRef<THREE.BufferGeometry | null>(null);
  const materialRef = useRef<THREE.PointsMaterial | null>(null);
  
  // Log uniquement au premier render
  const initialLogRef = useRef(false);
  if (!initialLogRef.current) {
    console.log("PointCloudRenderer initialisé:", {
      positionsLength: positions.length,
      colorsLength: colors.length,
      pointSize: pointSize
    });
    initialLogRef.current = true;
  }
  
  // Mémoïser le center et cloudSize pour éviter les recalculs
  const { center, cloudSize } = useMemo(() => {
    const c = new THREE.Vector3(
      (bounds.min.x + bounds.max.x) / 2,
      (bounds.min.y + bounds.max.y) / 2,
      (bounds.min.z + bounds.max.z) / 2
    );
    
    const cs = Math.sqrt(
      Math.pow(bounds.max.x - bounds.min.x, 2) +
      Math.pow(bounds.max.y - bounds.min.y, 2) +
      Math.pow(bounds.max.z - bounds.min.z, 2)
    );
    
    return { center: c, cloudSize: cs };
  }, [bounds]);

  // Filtrer les points selon les classifications visibles
  // En mode distance, ne pas inclure `distances` comme dépendance pour éviter les recalculs constants
  const { filteredPositions, filteredColors } = useMemo(() => {
    const tempPositions: number[] = [];
    const tempColors: number[] = [];
    
    // Parcourir tous les points et ne garder que ceux dont la classification est visible
    for (let i = 0; i < classifications.length; i++) {
      if (visibleClassifications.has(classifications[i])) {
        // Ajouter les positions centrées
        tempPositions.push(
          positions[i * 3] - center.x,
          positions[i * 3 + 1] - center.y,
          positions[i * 3 + 2] - center.z
        );
        
        // Ajouter les couleurs selon le mode choisi
        let r: number, g: number, b: number;
        
        if (colorMode === 'natural') {
          // Coloration naturelle (couleurs RGB extraites du fichier)
          r = colors[i * 3];
          g = colors[i * 3 + 1];
          b = colors[i * 3 + 2];
        } else if (colorMode === 'altitude') {
          // Coloration par altitude (coordonnée Z)
          const altitude = positions[i * 3 + 2]; // Z est l'altitude
          [r, g, b] = getColorForAltitude(altitude, bounds.min.z, bounds.max.z);
        } else {
          // Coloration par classification (mode par défaut)
          [r, g, b] = getColorForClassification(classifications[i]);
        }
        
        tempColors.push(r, g, b);
      }
    }
    
    // Log seulement si changement significatif
    const pointCount = tempPositions.length / 3;
    const windowWithCache = window as Window & { __lastPointCount?: number };
    if (Math.abs(pointCount - (windowWithCache.__lastPointCount || 0)) > 1000) {
      console.log(`Points filtrés: ${pointCount} / ${classifications.length} (mode: ${colorMode})`);
      windowWithCache.__lastPointCount = pointCount;
    }
    
    return {
      filteredPositions: new Float32Array(tempPositions),
      filteredColors: new Float32Array(tempColors)
    };
  }, [positions, colors, classifications, center, cloudSize, visibleClassifications, colorMode]);
  
  // Create geometry
  useEffect(() => {
    const pointCount = filteredPositions.length / 3;
    const windowWithGeomCache = window as Window & { __lastGeomPointCount?: number };
    if (pointCount > 0 && Math.abs(pointCount - (windowWithGeomCache.__lastGeomPointCount || 0)) > 1000) {
      console.log("Création/mise à jour géométrie:", pointCount.toLocaleString('fr-FR'), "points");
      windowWithGeomCache.__lastGeomPointCount = pointCount;
    }
    
    if (!geometryRef.current) {
      geometryRef.current = new THREE.BufferGeometry();
    }
    
    const geo = geometryRef.current;
    
    // ✅ CORRECTIF 4 : Réutiliser les buffers si possible au lieu de les recréer
    const posAttr = geo.getAttribute('position');
    if (posAttr && posAttr.array.length === filteredPositions.length) {
      // Réutiliser le buffer existant
      (posAttr.array as Float32Array).set(filteredPositions);
      posAttr.needsUpdate = true;
    } else {
      // Créer un nouveau buffer seulement si la taille change
      geo.setAttribute('position', new THREE.BufferAttribute(filteredPositions, 3));
    }
    
    // Même chose pour les couleurs
    const colAttr = geo.getAttribute('color');
    if (colAttr && colAttr.array.length === filteredColors.length) {
      // Réutiliser le buffer existant
      (colAttr.array as Float32Array).set(filteredColors);
      colAttr.needsUpdate = true;
    } else {
      // Créer un nouveau buffer seulement si la taille change
      geo.setAttribute('color', new THREE.BufferAttribute(filteredColors, 3));
    }
    
    // ✅ CORRECTIF 4 : Calculer les bounds seulement si nécessaire (une fois par LOD change)
    if (!geo.boundingBox || !geo.boundingSphere) {
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
    }
    
    // Signaler que la géométrie est prête
    setGeometryReady(true);
    
    return () => {
      // Optionnellement nettoyer la géométrie lors du démontage
      if (geometryRef.current) {
        geometryRef.current.dispose();
      }
      setGeometryReady(false);
    };
  }, [filteredPositions, filteredColors]);
  
  // Create or update material
  useEffect(() => {
    if (!materialRef.current) {
      materialRef.current = new THREE.PointsMaterial({
        size: pointSize,
        vertexColors: true,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.5,
        depthWrite: true,
        depthTest: true,
        alphaTest: 0.5,
        blending: THREE.NormalBlending,
        fog: true,
        // Cette propriété est importante pour que les points restent visibles
        toneMapped: false

      });
    } else {
      materialRef.current.size = pointSize;
      materialRef.current.needsUpdate = true;
    }
    
    // Désactiver le garbage collection pour ce matériau
    if (materialRef.current) {
      materialRef.current.dispose = () => {
        console.log("Matériau préservé intentionnellement");
      };
    }
    
    // Signaler que le matériau est prêt
    setMaterialReady(true);
    
    return () => {
      // Ne pas nettoyer le matériau lors du démontage
      setMaterialReady(false);
    };
  }, [pointSize]);
  
  // Pas de logs de render à chaque frame pour éviter la pollution de la console
  
  return (
    <>
      <CameraSetup bounds={bounds} />
      {geometryReady && materialReady && geometryRef.current && materialRef.current ? (
        <points geometry={geometryRef.current} material={materialRef.current} />
      ) : (
        <mesh>
          <boxGeometry args={[100, 100, 100]} />
          <meshBasicMaterial color="red" />
        </mesh>
      )}
    </>
  );
}
*/

// Composant principal du visualiseur
const DirectLazViewer: React.FC<DirectLazViewerProps> = ({
  lazFilePaths,
  pointSize = 0.5
}) => {
  // const [loading, setLoading] = useState<boolean>(true);
  // const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [pointData, setPointData] = useState<{
    positions: Float32Array;
    colors: Float32Array;
    intensities: Float32Array;
    classifications: Uint8Array;
    bounds: { min: THREE.Vector3; max: THREE.Vector3 };
    availableClassifications: number[];
    hasRGBColors: boolean;
  } | null>(null);
  
  // État pour gérer les classifications visibles
  const [visibleClassifications, setVisibleClassifications] = useState<Set<number>>(new Set());
  
  // États pour les paramètres EDL
  const [edlStrength, setEdlStrength] = useState<number>(1.5);
  const [edlRadius, setEdlRadius] = useState<number>(2.5);
  const [edlEnabled, setEdlEnabled] = useState<boolean>(true);
  
  // État pour le mode de couleur
  const [colorMode, setColorMode] = useState<'classification' | 'altitude' | 'natural'>('classification');
  
  // Seuils de distance pour le LOD dynamique (multiples de la taille du nuage)
  // [très proche, proche, moyen, loin]
  const [lodDistanceThresholds, setLodDistanceThresholds] = useState<number[]>([0.5, 1.0, 2.0, 4.0]);
  
  // État pour la taille des points (contrôlable via Tweakpane)
  const [currentPointSize, setCurrentPointSize] = useState<number>(pointSize);
  
  const [totalPointsDisplayed, setTotalPointsDisplayed] = useState<number>(0);
  
  // Nouveaux états pour le système de LOD dynamique par node
  const [nodesToRender, setNodesToRender] = useState<{ fileUrl: string; nodeKey: string; level: number; distance: number }[]>([]);
  const [metadataLoaded, setMetadataLoaded] = useState<boolean>(false);

  // Synchroniser currentPointSize avec la prop pointSize si elle change
  useEffect(() => {
    setCurrentPointSize(pointSize);
  }, [pointSize]);
  
  // Référence pour le panneau Tweakpane
  const paneRef = useRef<Pane | null>(null);
  // Référence pour les paramètres pointSize dans Tweakpane
  const pointSizeParamsRef = useRef<{ pointSize: number } | null>(null);
  
  // Mettre à jour le slider Tweakpane quand currentPointSize change
  useEffect(() => {
    if (pointSizeParamsRef.current) {
      pointSizeParamsRef.current.pointSize = currentPointSize;
    }
  }, [currentPointSize]);
  
  // 🚀 Nouveau système : Chargement des métadonnées puis du niveau 1 uniquement
  useEffect(() => {
    let isMounted = true;
    
    async function loadInitialData() {
      try {
        setError(null);
        console.log(`🚀 Chargement des métadonnées de ${lazFilePaths.length} fichier(s)`);
        
        // Étape 1 : Charger les métadonnées de tous les fichiers
        // Les chemins sont déjà des chemins relatifs, ils seront résolus dans loadCOPCMetadata
        // Utiliser Promise.allSettled pour continuer même si certains fichiers échouent
        const metadataResults: Array<{ filePath: string; metadata: Awaited<ReturnType<typeof loadCOPCMetadata>> | null }> = [];
        
        for (const filePath of lazFilePaths) {
          try {
            const metadata = await loadCOPCMetadata(filePath);
            metadataResults.push({ filePath, metadata });
          } catch (error) {
            console.error(`❌ Impossible de charger les métadonnées pour ${filePath}:`, error);
            metadataResults.push({ filePath, metadata: null });
          }
        }
        
        // Filtrer les résultats null (fichiers qui ont échoué)
        const successfulResults = metadataResults.filter(r => r.metadata !== null);
        const allMetadata = successfulResults.map(r => r.metadata!);
        const successfulFilePaths = successfulResults.map(r => r.filePath);
        
        if (allMetadata.length === 0) {
          throw new Error('Aucun fichier n\'a pu être chargé. Vérifiez que les fichiers existent et sont accessibles.');
        }
        
        if (allMetadata.length < lazFilePaths.length) {
          console.warn(`⚠️ ${lazFilePaths.length - allMetadata.length} fichier(s) n'ont pas pu être chargé(s) sur ${lazFilePaths.length}`);
        }
        
        if (!isMounted) return;
        
        // Calculer les bounds globaux
        const globalMin = new THREE.Vector3(Infinity, Infinity, Infinity);
        const globalMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        
        for (const metadata of allMetadata) {
          globalMin.min(metadata.bounds.min);
          globalMax.max(metadata.bounds.max);
        }
        
        console.log(`✅ Métadonnées chargées. Bounds globaux:`, { min: globalMin, max: globalMax });
        
        // Étape 2 : Charger uniquement le niveau 1 de tous les fichiers qui ont réussi
        console.log(`📥 Chargement du niveau 1 de ${successfulFilePaths.length} fichier(s)...`);
        
        // Charger les nodes de manière séquentielle par fichier pour éviter de surcharger le serveur
        // et permettre une meilleure gestion des erreurs
        for (const filePath of successfulFilePaths) {
          const metadata = copcMetadataCache.get(filePath);
          if (!metadata) continue;
          
          // Trouver tous les nodes de niveau 1
          const level1Nodes = Array.from(metadata.nodes.values()).filter(node => node.level === 1);
          
          // Charger les nodes avec gestion d'erreur individuelle
          // Limiter le parallélisme à 3 nodes à la fois pour éviter de surcharger
          const batchSize = 3;
          for (let i = 0; i < level1Nodes.length; i += batchSize) {
            const batch = level1Nodes.slice(i, i + batchSize);
            const batchPromises = batch.map(async (node) => {
              try {
                return await loadSingleNode(filePath, node.key);
              } catch (error) {
                console.error(`❌ Erreur lors du chargement du node ${node.key} du fichier ${filePath}:`, error);
                return null;
              }
            });
            
            await Promise.all(batchPromises);
            
            // Petit délai entre les batches pour éviter de surcharger le serveur
            if (i + batchSize < level1Nodes.length) {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
        }
        
        if (!isMounted) return;
        
        console.log(`✅ Niveau 1 chargé pour tous les fichiers`);
        
        // Initialiser l'affichage avec le niveau 1
        // Ne inclure que les nodes qui ont été chargés avec succès
        const initialNodesToRender: { fileUrl: string; nodeKey: string; level: number; distance: number }[] = [];
        for (const filePath of successfulFilePaths) {
          const metadata = copcMetadataCache.get(filePath);
          if (!metadata) continue;
          
          const level1Nodes = Array.from(metadata.nodes.values()).filter(node => node.level === 1);
          for (const node of level1Nodes) {
            // Vérifier que les données du node sont en cache (chargées avec succès)
            const cacheKey = `${filePath}_${node.key}`;
            const nodeData = nodeDataCache.get(cacheKey);
            if (nodeData) {
              initialNodesToRender.push({
                fileUrl: filePath,
                nodeKey: node.key,
                level: 1,
                distance: 0 // Distance sera calculée par le LOD manager
              });
            }
          }
        }
        
        if (initialNodesToRender.length === 0) {
          console.warn(`⚠️ Aucun node de niveau 1 n'a pu être chargé. L'affichage sera vide.`);
        } else {
          console.log(`✅ ${initialNodesToRender.length} node(s) de niveau 1 prêt(s) pour l'affichage`);
        }
        
        setNodesToRender(initialNodesToRender);
        
        // Configurer pointData pour l'affichage initial
        setPointData({
          positions: new Float32Array(0),
          colors: new Float32Array(0),
          intensities: new Float32Array(0),
          classifications: new Uint8Array(0),
          bounds: { min: globalMin, max: globalMax },
          availableClassifications: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
          hasRGBColors: true
        });
        
        setVisibleClassifications(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]));
        setMetadataLoaded(true);
        
        console.log(`🎨 Affichage initial prêt avec ${initialNodesToRender.length} nodes de niveau 1`);
        
      } catch (err) {
        if (isMounted) {
          console.error("Erreur lors du chargement initial:", err);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }
    
    loadInitialData();
    
    return () => {
      isMounted = false;
    };
  }, [lazFilePaths]);
  
  // 🎨 Nouveau : Gérer l'affichage dynamique des nodes sans fusion
  // Mémoïser uniquement la liste des clés de nodes à afficher
  const nodesToRenderKeys = useMemo(() => {
    if (nodesToRender.length === 0 || !metadataLoaded) return new Set<string>();
    return new Set(nodesToRender.map(n => `${n.fileUrl}_${n.nodeKey}`));
  }, [nodesToRender, metadataLoaded]);
  
  // Calculer les statistiques pour l'affichage
  useEffect(() => {
    let totalPoints = 0;
    for (const nodeToRender of nodesToRender) {
      const cacheKey = `${nodeToRender.fileUrl}_${nodeToRender.nodeKey}`;
      const nodeData = nodeDataCache.get(cacheKey);
      if (nodeData) {
        totalPoints += nodeData.positions.length / 3;
      }
    }
    setTotalPointsDisplayed(totalPoints);
  }, [nodesToRender]);
  
  // Créer le panneau Tweakpane pour gérer les classifications
  useEffect(() => {
    if (!pointData || paneRef.current) return;
    
    // Créer le panneau
    const pane = new Pane({
      title: 'Paramètres',
      expanded: true,
    });
    
    paneRef.current = pane;
    
    // Ajouter un slider pour la taille des points
    const pointSizeParams = {
      pointSize: currentPointSize
    };
    pointSizeParamsRef.current = pointSizeParams;
    
    (pane as unknown as { addBinding: (obj: Record<string, number>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: number }) => void) => void } }).addBinding(pointSizeParams, 'pointSize', {
      label: 'Taille des points',
      min: 0.1,
      max: 10.0,
      step: 0.1
    }).on('change', (ev: { value: number }) => {
      setCurrentPointSize(ev.value);
    });
    
    // Ajouter un séparateur
    (pane as unknown as { addBlade: (config: { view: string }) => void }).addBlade({
      view: 'separator'
    });
    
    // Noms des classifications
    const classificationNames: { [key: number]: string } = {
      0: "Non classé",
      1: "Non classé",
      2: "Sol",
      3: "Végétation basse",
      4: "Végétation moyenne",
      5: "Arbres",
      6: "Bâtiments",
      7: "Bruit bas",
      8: "Réservé",
      9: "Eau",
      10: "Rail",
      11: "Routes",
      12: "Réservé",
      13: "Wire Guard",
      14: "Wire Conductor",
      15: "Tour transmission",
      16: "Wire Connector",
      17: "Ponts",
      18: "Bruit élevé",
    };
    
    // Ajouter un dossier pour les paramètres EDL
    const edlFolder = (pane as unknown as { addFolder: (config: { title: string; expanded: boolean }) => unknown }).addFolder({
      title: 'Eye-Dome Lighting (EDL)',
      expanded: true,
    });
    
    const edlParams = {
      enabled: edlEnabled,
      strength: edlStrength,
      radius: edlRadius
    };
    
    (edlFolder as unknown as { addBinding: (obj: Record<string, boolean | number>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: boolean | number }) => void) => void } }).addBinding(edlParams, 'enabled', {
      label: 'Activer EDL'
    }).on('change', (ev: { value: boolean | number }) => {
      setEdlEnabled(ev.value as boolean);
    });
    
    (edlFolder as unknown as { addBinding: (obj: Record<string, boolean | number>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: boolean | number }) => void) => void } }).addBinding(edlParams, 'strength', {
      label: 'Intensité',
      min: 0.1,
      max: 5.0,
      step: 0.1
    }).on('change', (ev: { value: boolean | number }) => {
      setEdlStrength(ev.value as number);
    });
    
    (edlFolder as unknown as { addBinding: (obj: Record<string, boolean | number>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: boolean | number }) => void) => void } }).addBinding(edlParams, 'radius', {
      label: 'Rayon',
      min: 0.5,
      max: 5.0,
      step: 0.1
    }).on('change', (ev: { value: boolean | number }) => {
      setEdlRadius(ev.value as number);
    });
    
    // Ajouter un séparateur
    (pane as unknown as { addBlade: (config: { view: string }) => void }).addBlade({
      view: 'separator'
    });
    
    // Ajouter un dossier pour le mode de couleur
    const colorFolder = (pane as unknown as { addFolder: (config: { title: string; expanded: boolean }) => unknown }).addFolder({
      title: 'Mode de Couleur',
      expanded: true,
    });
    
    const colorParams = {
      mode: colorMode
    };
    
    (colorFolder as unknown as { addBinding: (obj: Record<string, string>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: string }) => void) => void } }).addBinding(colorParams, 'mode', {
      label: 'Mode',
      options: {
        'Classification': 'classification',
        'Altitude': 'altitude',
        'Naturelle': 'natural'
      }
    }).on('change', (ev: { value: string }) => {
      setColorMode(ev.value as 'classification' | 'altitude' | 'natural');
    });
    
    // Ajouter un séparateur
    (pane as unknown as { addBlade: (config: { view: string }) => void }).addBlade({
      view: 'separator'
    });
    
    // Ajouter un dossier pour les classifications
    const classFolder = (pane as unknown as { addFolder: (config: { title: string; expanded: boolean }) => unknown }).addFolder({
      title: 'Classifications',
      expanded: true,
    });
    
    // Créer un objet pour gérer l'état des checkboxes
    const checkboxState: { [key: string]: boolean } = {};
    pointData.availableClassifications.forEach(classId => {
      checkboxState[`class_${classId}`] = true;
    });
    
    // Ajouter des checkboxes pour chaque classification disponible
    pointData.availableClassifications.forEach(classId => {
      const name = classificationNames[classId] || `Classe ${classId}`;
      const key = `class_${classId}`;
      
      (classFolder as unknown as { addBinding: (obj: Record<string, boolean>, key: string, options: { label: string }) => { on: (event: string, handler: (ev: { value: boolean }) => void) => void } }).addBinding(checkboxState, key, {
        label: `${classId}: ${name}`
      }).on('change', (ev: { value: boolean }) => {
        setVisibleClassifications(prev => {
          const newSet = new Set(prev);
          if (ev.value) {
            newSet.add(classId);
          } else {
            newSet.delete(classId);
          }
          return newSet;
        });
      });
    });
    
    // Note: Les boutons nécessitent le plugin @tweakpane/plugin-essentials
    // Pour l'instant, utilisez les checkboxes individuellement
    
    // Nettoyer le panneau lors du démontage
    return () => {
      if (paneRef.current) {
        paneRef.current.dispose();
        paneRef.current = null;
      }
      pointSizeParamsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointData]);
  
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* {loading && (
        <div style={{ 
          position: 'absolute', 
          top: '50%', 
          left: '50%', 
          transform: 'translate(-50%, -50%)',
          background: 'rgba(0,0,0,0.8)',
          color: 'white',
          padding: '20px',
          borderRadius: '8px',
          textAlign: 'center',
          zIndex: 1000
        }}>
          <h3>Chargement du fichier...</h3>
          <p>{Math.round(progress * 100)}%</p>
        </div>
      )} */}
      
      {error && (
        <div style={{ 
          position: 'absolute', 
          top: '50%', 
          left: '50%', 
          transform: 'translate(-50%, -50%)',
          background: 'rgba(255,0,0,0.8)',
          color: 'white',
          padding: '20px',
          borderRadius: '8px',
          textAlign: 'center',
          zIndex: 1000
        }}>
          <h3>Erreur</h3>
          <p>{error}</p>
        </div>
      )}
      
      {pointData && (
        <>
          <Canvas 
            frameloop="always"
            style={{ background: '#000' }}
            gl={{ 
              antialias: true,
              logarithmicDepthBuffer: true,
              preserveDrawingBuffer: false
            }}
            camera={{ 
              position: [0, 0, 650], 
              // Définition de l'axe up de la caméra
              up: [0, 0, 1],
              near: 0.01, 
              far: 10000
            }}
            onCreated={({ gl, scene, camera }) => {
              console.log("Canvas created", gl.domElement);
              // Activer le nettoyage automatique pour éviter les traces
              gl.autoClear = true;
              gl.setClearColor(0x000000, 1);
              
              // S'assurer que le domElement est correctement configuré pour les événements de souris
              const canvas = gl.domElement;
              canvas.setAttribute("tabindex", "0");
              canvas.focus();
              
              // Journaliser les propriétés importantes pour le débogage
              console.log("Camera:", camera);
              console.log("Scene:", scene);
              console.log("Canvas element:", canvas);
            }}
          >
          {/* Note: Les lumières n'affectent PAS les nuages de points avec vertexColors.
              L'Eye-Dome Lighting (EDL) est utilisé pour la perception de profondeur.
              Cette lumière "Soleil" éclaire uniquement les éléments auxiliaires (axes, grille, etc.). */}
          
          {/* ☀️ Lumière directionnelle "Soleil" - éclairage principal de la scène */}
          <directionalLight 
            position={[100, 100, 100]}  // Position du soleil (diagonal haut)
            intensity={1.2}             // Intensité lumineuse
            color="#ffffff"             // Lumière blanche naturelle
            castShadow={false}          // Pas d'ombres (inutile pour nuages de points)
          />
          
          {/* Lumière ambiante minimale pour éviter les zones trop sombres */}
          <ambientLight intensity={0.3} color="#ffffff" />
          
          {/* CameraControls optimisé pour données géospatiales LIDAR */}
          <CameraControls
            makeDefault
            enabled={true}
            
            // Avec up=[0,0,1], l'azimuth tourne maintenant autour de Z
            // Donc pour tourner dans le plan XY, on laisse azimuth libre
            // et on bloque polar
            //minPolarAngle={Math.PI / 2}   
            //maxPolarAngle={Math.PI / 2}   
            
            azimuthRotateSpeed={0.5}
            
            minDistance={1}
            maxDistance={10000}
            dollyToCursor={false}
            infinityDolly={false}
            // L'option domElement peut aider à s'assurer que les événements souris sont capturés
            domElement={document.querySelector('canvas') || undefined}
          />

          {/* Gestionnaire de LOD dynamique par node */}
          {pointData && metadataLoaded && (
            <DynamicNodeLODManager
              filePaths={lazFilePaths}
              globalBounds={pointData.bounds}
              onNodesUpdate={setNodesToRender}
            />
          )}

          <DatGuiPanel
            pointCount={totalPointsDisplayed}
            pointSize={currentPointSize}
            onPointSizeChange={setCurrentPointSize}
            edlEnabled={edlEnabled}
            onEdlEnabledChange={setEdlEnabled}
            edlStrength={edlStrength}
            onEdlStrengthChange={setEdlStrength}
            edlRadius={edlRadius}
            onEdlRadiusChange={setEdlRadius}
            colorMode={colorMode}
            onColorModeChange={setColorMode}
            maxLOD={0}
            onMaxLODChange={() => {}}
            maxAvailableLevel={0}
          />
          
          {/* Axes de référence pour l'orientation */}
          {/* <axesHelper args={[100]} /> */}
           {/* Nouveau système : Rendu dynamique des nodes sans fusion */}
           {pointData && metadataLoaded && (
             <DynamicNodeRenderer
               nodesToRenderKeys={nodesToRenderKeys}
               allNodes={nodesToRender}
               globalBounds={pointData.bounds}
               visibleClassifications={visibleClassifications}
               colorMode={colorMode}
               pointSize={currentPointSize}
             />
           )}
           {edlEnabled && (
             <EDLEffect 
               edlStrength={edlStrength} 
               edlRadius={edlRadius} 
             />
           )}
         </Canvas>
        </>
      )}
    </div>
  );
};

export default DirectLazViewer;
