import { useMemo, useRef, useEffect, useState } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { nodeDataCache } from './DirectLazViewer';

interface BuildingTrianglesDelaunayProps {
  nodesToRender: { fileUrl: string; nodeKey: string; level: number; distance: number }[];
  globalBounds: { min: THREE.Vector3; max: THREE.Vector3 };
}

const BUILDING_CLASSIFICATION = 6;
const PLAYER_RADIUS = 50;
const MAX_POINTS = 25000;

// ===== PARAMÈTRES CRITIQUES POUR CONTRÔLER LA FORMATION DES TRIANGLES =====
const MAX_THRESHOLD = 2.0;    // 🔑 Distance maximale entre points connectés (en mètres)
const MAX_EDGE_LENGTH = 3.0;  // 🔑 Longueur maximale d'une arête de triangle (en mètres)
const MAX_VALENCE = 6;         // 🔑 Nombre de plus proches voisins par point (pour WebGPU)
const MIN_TRIANGLE_AREA = 0.001; // Aire minimale (m²)
const MIN_ANGLE_DEG = 10;      // Angle minimal dans le triangle (degrés)

// ===== COMPUTE SHADER WEBGPU POUR TROUVER LES PLUS PROCHES VOISINS =====
const computeShaderCode = `
struct Params {
  pointCount: u32,
  maxThresholdSquared: f32,
  maxValence: u32,
  padding: u32,
};

@group(0) @binding(0) var<storage, read> points: array<f32>;
@group(0) @binding(1) var<storage, read_write> connections: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

fn readPoint(index: u32) -> vec3<f32> {
  let base = index * 3u;
  return vec3<f32>(
    points[base],
    points[base + 1u],
    points[base + 2u]
  );
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let index = global_id.x;
  
  if (index >= params.pointCount) {
    return;
  }
  
  let point1 = readPoint(index);
  
  var bestIndices: array<u32, 8>;
  var bestDistances: array<f32, 8>;
  
  for (var i: u32 = 0u; i < 8u; i++) {
    bestIndices[i] = 0xFFFFFFFFu;
    bestDistances[i] = 999999.0;
  }
  
  for (var j: u32 = 0u; j < params.pointCount; j++) {
    if (j == index) {
      continue;
    }
    
    let point2 = readPoint(j);
    let diff = point2 - point1;
    let distSquared = dot(diff, diff);
    
    if (distSquared <= params.maxThresholdSquared) {
      for (var k: u32 = 0u; k < params.maxValence; k++) {
        if (distSquared < bestDistances[k]) {
          for (var m = params.maxValence - 1u; m > k; m--) {
            bestIndices[m] = bestIndices[m - 1u];
            bestDistances[m] = bestDistances[m - 1u];
          }
          bestIndices[k] = j;
          bestDistances[k] = distSquared;
          break;
        }
      }
    }
  }
  
  let baseIndex = index * params.maxValence;
  for (var i: u32 = 0u; i < params.maxValence; i++) {
    connections[baseIndex + i] = bestIndices[i];
  }
}
`;

// ===== FONCTIONS UTILITAIRES =====
function triangleArea(p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3): number {
  const v1 = new THREE.Vector3().subVectors(p2, p1);
  const v2 = new THREE.Vector3().subVectors(p3, p1);
  const cross = new THREE.Vector3().crossVectors(v1, v2);
  return cross.length() * 0.5;
}

function smallestAngle(p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3): number {
  const v1 = new THREE.Vector3().subVectors(p2, p1);
  const v2 = new THREE.Vector3().subVectors(p3, p1);
  const v3 = new THREE.Vector3().subVectors(p3, p2);
  
  const a = v1.length();
  const b = v2.length();
  const c = v3.length();
  
  if (a === 0 || b === 0 || c === 0) return 0;
  
  const cosAngle1 = Math.max(-1, Math.min(1, (b * b + c * c - a * a) / (2 * b * c)));
  const cosAngle2 = Math.max(-1, Math.min(1, (a * a + c * c - b * b) / (2 * a * c)));
  const cosAngle3 = Math.max(-1, Math.min(1, (a * a + b * b - c * c) / (2 * a * b)));
  
  const angle1 = Math.acos(cosAngle1);
  const angle2 = Math.acos(cosAngle2);
  const angle3 = Math.acos(cosAngle3);
  
  return Math.min(angle1, angle2, angle3);
}


// ===== TRIANGULATION DE DELAUNAY 2D =====
// Cette approche projette les points sur un plan et utilise Delaunay
// qui garantit qu'aucun triangle ne se superpose

// Structure pour un triangle
interface DelaunayTriangle {
  a: number;
  b: number;
  c: number;
  circumcenter: [number, number];
  circumradiusSquared: number;
}

// Calculer le cercle circonscrit d'un triangle
function circumcircle(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number
): { x: number; y: number; radiusSquared: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const ex = cx - ax;
  const ey = cy - ay;

  const bl = dx * dx + dy * dy;
  const cl = ex * ex + ey * ey;
  const d = 0.5 / (dx * ey - dy * ex);

  const x = ax + (ey * bl - dy * cl) * d;
  const y = ay + (dx * cl - ex * bl) * d;

  const rdx = ax - x;
  const rdy = ay - y;
  const radiusSquared = rdx * rdx + rdy * rdy;

  return { x, y, radiusSquared };
}

// Implémenter l'algorithme de Delaunay (Bowyer-Watson)
function delaunay2D(points: Array<[number, number]>): number[][] {
  const n = points.length;
  if (n < 3) return [];

  // Trouver les limites
  let minX = points[0][0], minY = points[0][1];
  let maxX = points[0][0], maxY = points[0][1];
  
  for (let i = 1; i < n; i++) {
    if (points[i][0] < minX) minX = points[i][0];
    if (points[i][1] < minY) minY = points[i][1];
    if (points[i][0] > maxX) maxX = points[i][0];
    if (points[i][1] > maxY) maxY = points[i][1];
  }

  const dx = maxX - minX;
  const dy = maxY - minY;
  const deltaMax = Math.max(dx, dy);
  const midx = (minX + maxX) / 2;
  const midy = (minY + maxY) / 2;

  // Créer un super-triangle qui contient tous les points
  const p1: [number, number] = [midx - 20 * deltaMax, midy - deltaMax];
  const p2: [number, number] = [midx, midy + 20 * deltaMax];
  const p3: [number, number] = [midx + 20 * deltaMax, midy - deltaMax];

  const allPoints = [...points, p1, p2, p3];
  
  // Triangle initial
  const triangles: DelaunayTriangle[] = [];
  const circ = circumcircle(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  triangles.push({
    a: n,
    b: n + 1,
    c: n + 2,
    circumcenter: [circ.x, circ.y],
    circumradiusSquared: circ.radiusSquared
  });

  // Ajouter les points un par un
  for (let i = 0; i < n; i++) {
    const [px, py] = points[i];
    const badTriangles: number[] = [];

    // Trouver les triangles dont le cercle circonscrit contient le point
    for (let j = 0; j < triangles.length; j++) {
      const tri = triangles[j];
      const dx = px - tri.circumcenter[0];
      const dy = py - tri.circumcenter[1];
      const distSquared = dx * dx + dy * dy;

      if (distSquared < tri.circumradiusSquared) {
        badTriangles.push(j);
      }
    }

    // Trouver les arêtes du polygone formé par les mauvais triangles
    const polygon: Array<[number, number]> = [];
    
    for (let j = 0; j < badTriangles.length; j++) {
      const tri = triangles[badTriangles[j]];
      const edges: Array<[number, number]> = [
        [tri.a, tri.b],
        [tri.b, tri.c],
        [tri.c, tri.a]
      ];

      for (const edge of edges) {
        let shared = false;
        for (let k = 0; k < badTriangles.length; k++) {
          if (j === k) continue;
          const tri2 = triangles[badTriangles[k]];
          const edges2: Array<[number, number]> = [
            [tri2.a, tri2.b],
            [tri2.b, tri2.c],
            [tri2.c, tri2.a]
          ];

          for (const edge2 of edges2) {
            if ((edge[0] === edge2[1] && edge[1] === edge2[0]) ||
                (edge[0] === edge2[0] && edge[1] === edge2[1])) {
              shared = true;
              break;
            }
          }
          if (shared) break;
        }

        if (!shared) {
          polygon.push(edge);
        }
      }
    }

    // Supprimer les mauvais triangles
    for (let j = badTriangles.length - 1; j >= 0; j--) {
      triangles.splice(badTriangles[j], 1);
    }

    // Créer de nouveaux triangles à partir du polygone
    for (const edge of polygon) {
      const pa = allPoints[edge[0]];
      const pb = allPoints[edge[1]];
      const pc = [px, py];

      const circ = circumcircle(pa[0], pa[1], pb[0], pb[1], pc[0], pc[1]);
      triangles.push({
        a: edge[0],
        b: edge[1],
        c: i,
        circumcenter: [circ.x, circ.y],
        circumradiusSquared: circ.radiusSquared
      });
    }
  }

  // Filtrer les triangles qui contiennent les sommets du super-triangle
  const result: number[][] = [];
  for (const tri of triangles) {
    if (tri.a < n && tri.b < n && tri.c < n) {
      result.push([tri.a, tri.b, tri.c]);
    }
  }

  return result;
}

// Projeter les points 3D sur un plan 2D
function projectToPlane(points: THREE.Vector3[]): {
  points2D: Array<[number, number]>;
  basis: { u: THREE.Vector3; v: THREE.Vector3; origin: THREE.Vector3 };
} {
  if (points.length < 3) {
    return {
      points2D: points.map(p => [p.x, p.z] as [number, number]),
      basis: {
        u: new THREE.Vector3(1, 0, 0),
        v: new THREE.Vector3(0, 0, 1),
        origin: new THREE.Vector3(0, 0, 0)
      }
    };
  }

  // Calculer le centroïde
  const centroid = new THREE.Vector3();
  for (const p of points) {
    centroid.add(p);
  }
  centroid.divideScalar(points.length);

  // Calculer la normale par PCA (simplifiée)
  // On utilise la normale moyenne des triangles formés avec le centroïde
  const normal = new THREE.Vector3();
  for (let i = 0; i < Math.min(points.length, 100); i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const v1 = new THREE.Vector3().subVectors(p1, centroid);
    const v2 = new THREE.Vector3().subVectors(p2, centroid);
    const cross = new THREE.Vector3().crossVectors(v1, v2);
    normal.add(cross);
  }
  normal.normalize();

  // Créer une base orthonormée
  const u = new THREE.Vector3();
  if (Math.abs(normal.y) < 0.9) {
    u.crossVectors(normal, new THREE.Vector3(0, 1, 0)).normalize();
  } else {
    u.crossVectors(normal, new THREE.Vector3(1, 0, 0)).normalize();
  }
  const v = new THREE.Vector3().crossVectors(normal, u);

  // Projeter les points
  const points2D: Array<[number, number]> = [];
  for (const p of points) {
    const rel = new THREE.Vector3().subVectors(p, centroid);
    const x = rel.dot(u);
    const y = rel.dot(v);
    points2D.push([x, y]);
  }

  return {
    points2D,
    basis: { u, v, origin: centroid }
  };
}

export function BuildingTrianglesDelaunay({
  nodesToRender,
  globalBounds
}: BuildingTrianglesDelaunayProps) {
  const { camera } = useThree();
  const geometryRef = useRef<THREE.BufferGeometry>(new THREE.BufferGeometry());
  const lastUpdateFrameRef = useRef<number>(0);
  const webGPUDeviceRef = useRef<any>(null);
  const webGPUInitializedRef = useRef<boolean>(false);
  const [isProcessing, setIsProcessing] = useState(false);
  
  const globalCenter = useMemo(() => new THREE.Vector3(
    (globalBounds.min.x + globalBounds.max.x) / 2,
    (globalBounds.min.y + globalBounds.max.y) / 2,
    (globalBounds.min.z + globalBounds.max.z) / 2
  ), [globalBounds]);
  
  const radiusSquared = PLAYER_RADIUS * PLAYER_RADIUS;
  const maxThresholdSquared = MAX_THRESHOLD * MAX_THRESHOLD;
  
  // Initialiser WebGPU
  useEffect(() => {
    async function initWebGPU() {
      console.log('[DELAUNAY + NEAREST] Initialisation WebGPU...');
      const gpu = (navigator as any).gpu;
      if (!gpu) {
        console.warn('[DELAUNAY + NEAREST] WebGPU non disponible, utilisation CPU uniquement');
        webGPUInitializedRef.current = false;
        return;
      }
      
      try {
        const adapter = await gpu.requestAdapter();
        if (!adapter) {
          console.warn('[DELAUNAY + NEAREST] Aucun adaptateur WebGPU, utilisation CPU uniquement');
          webGPUInitializedRef.current = false;
          return;
        }
        
        const device = await adapter.requestDevice();
        webGPUDeviceRef.current = device;
        webGPUInitializedRef.current = true;
        console.log('[DELAUNAY + NEAREST] ✅ WebGPU initialisé');
      } catch (error) {
        console.warn('[DELAUNAY + NEAREST] Erreur WebGPU, utilisation CPU uniquement:', error);
        webGPUInitializedRef.current = false;
      }
    }
    
    initWebGPU();
    
    return () => {
      if (webGPUDeviceRef.current) {
        webGPUDeviceRef.current.destroy();
        webGPUDeviceRef.current = null;
        webGPUInitializedRef.current = false;
      }
    };
  }, []);
  
  // Mettre à jour les triangles à chaque frame
  useFrame(() => {
    lastUpdateFrameRef.current++;
    
    if (lastUpdateFrameRef.current % 10 !== 0) {
      return;
    }
    
    if (isProcessing) {
      return;
    }
    
    setIsProcessing(true);
    
    (async () => {
      try {
        const playerPosition = camera.position.clone();
        const buildingPoints: THREE.Vector3[] = [];
      
        // Collecter les points de bâtiment dans le rayon
        for (const node of nodesToRender) {
          const cacheKey = `${node.fileUrl}_${node.nodeKey}`;
          const nodeData = nodeDataCache.get(cacheKey);
          
          if (!nodeData) continue;
          
          const { positions, classifications } = nodeData;
          const pointCount = positions.length / 3;
          
          for (let i = 0; i < pointCount; i++) {
            if (classifications[i] === BUILDING_CLASSIFICATION) {
              const x = positions[i * 3] - globalCenter.x;
              const y = positions[i * 3 + 1] - globalCenter.y;
              const z = positions[i * 3 + 2] - globalCenter.z;
              
              const dx = x - playerPosition.x;
              const dy = y - playerPosition.y;
              const dz = z - playerPosition.z;
              const distSquared = dx * dx + dy * dy + dz * dz;
              
              if (distSquared <= radiusSquared) {
                buildingPoints.push(new THREE.Vector3(x, y, z));
                
                if (buildingPoints.length >= MAX_POINTS) {
                  break;
                }
              }
            }
          }
          
          if (buildingPoints.length >= MAX_POINTS) {
            break;
          }
        }
        
        const pointCount = buildingPoints.length;
        
        if (pointCount < 3) {
          geometryRef.current.setDrawRange(0, 0);
          return;
        }
        
        // ===== ÉTAPE 1 : Utiliser WebGPU pour trouver les plus proches voisins =====
        let neighborSets: Set<number>[] | null = null;
        
        if (webGPUInitializedRef.current && webGPUDeviceRef.current) {
          try {
            const device = webGPUDeviceRef.current;
            
            // Créer les buffers WebGPU
            const pointsData = new Float32Array(pointCount * 3);
            for (let i = 0; i < pointCount; i++) {
              pointsData[i * 3] = buildingPoints[i].x;
              pointsData[i * 3 + 1] = buildingPoints[i].y;
              pointsData[i * 3 + 2] = buildingPoints[i].z;
            }
            
            const pointsBuffer = device.createBuffer({
              size: pointsData.byteLength,
              usage: (window as any).GPUBufferUsage.STORAGE | (window as any).GPUBufferUsage.COPY_DST,
              mappedAtCreation: true,
            });
            new Float32Array(pointsBuffer.getMappedRange()).set(pointsData);
            pointsBuffer.unmap();
            
            const connectionsBuffer = device.createBuffer({
              size: pointCount * MAX_VALENCE * 4,
              usage: (window as any).GPUBufferUsage.STORAGE | (window as any).GPUBufferUsage.COPY_SRC,
            });
            
            const paramsData = new Uint32Array([pointCount, 0, 0, 0]);
            const paramsDataView = new DataView(paramsData.buffer);
            paramsDataView.setFloat32(4, maxThresholdSquared, true);
            paramsData[2] = MAX_VALENCE;
            
            const paramsBuffer = device.createBuffer({
              size: 16,
              usage: (window as any).GPUBufferUsage.UNIFORM | (window as any).GPUBufferUsage.COPY_DST,
              mappedAtCreation: true,
            });
            new Uint32Array(paramsBuffer.getMappedRange()).set(paramsData);
            paramsBuffer.unmap();
            
            const shaderModule = device.createShaderModule({
              code: computeShaderCode,
            });
            
            const bindGroupLayout = device.createBindGroupLayout({
              entries: [
                { binding: 0, visibility: (window as any).GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: (window as any).GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 2, visibility: (window as any).GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
              ],
            });
            
            const pipelineLayout = device.createPipelineLayout({
              bindGroupLayouts: [bindGroupLayout],
            });
            
            const computePipeline = device.createComputePipeline({
              layout: pipelineLayout,
              compute: {
                module: shaderModule,
                entryPoint: 'main',
              },
            });
            
            const bindGroup = device.createBindGroup({
              layout: bindGroupLayout,
              entries: [
                { binding: 0, resource: { buffer: pointsBuffer } },
                { binding: 1, resource: { buffer: connectionsBuffer } },
                { binding: 2, resource: { buffer: paramsBuffer } },
              ],
            });
            
            const commandEncoder = device.createCommandEncoder();
            const passEncoder = commandEncoder.beginComputePass();
            passEncoder.setPipeline(computePipeline);
            passEncoder.setBindGroup(0, bindGroup);
            
            const workgroupCount = Math.ceil(pointCount / 64);
            passEncoder.dispatchWorkgroups(workgroupCount);
            passEncoder.end();
            
            const readbackBuffer = device.createBuffer({
              size: pointCount * MAX_VALENCE * 4,
              usage: (window as any).GPUBufferUsage.COPY_DST | (window as any).GPUBufferUsage.MAP_READ,
            });
            
            commandEncoder.copyBufferToBuffer(
              connectionsBuffer,
              0,
              readbackBuffer,
              0,
              pointCount * MAX_VALENCE * 4
            );
            
            device.queue.submit([commandEncoder.finish()]);
            
            await readbackBuffer.mapAsync((window as any).GPUMapMode.READ);
            const connectionsData = new Uint32Array(readbackBuffer.getMappedRange());
            
            // Construire les Sets de voisins
            neighborSets = new Array(pointCount).fill(null).map(() => new Set<number>());
            for (let i = 0; i < pointCount; i++) {
              const baseIndex = i * MAX_VALENCE;
              for (let j = 0; j < MAX_VALENCE; j++) {
                const neighborIdx = connectionsData[baseIndex + j];
                if (neighborIdx !== 0xFFFFFFFF && neighborIdx < pointCount) {
                  neighborSets[i].add(neighborIdx);
                }
              }
            }
            
            readbackBuffer.unmap();
            pointsBuffer.destroy();
            connectionsBuffer.destroy();
            paramsBuffer.destroy();
            readbackBuffer.destroy();
          } catch (error) {
            console.warn('[DELAUNAY + NEAREST] Erreur WebGPU, fallback vers CPU:', error);
            neighborSets = null;
          }
        }
        
        // ===== ÉTAPE 2 : Faire la triangulation de Delaunay =====
        const { points2D, basis } = projectToPlane(buildingPoints);
        const triangleIndices = delaunay2D(points2D);
        
        // ===== ÉTAPE 3 : Filtrer les triangles par distance et qualité =====
        const triangleVertices: number[] = [];
        let acceptedTriangles = 0;
        let rejectedByDistance = 0;
        let rejectedByArea = 0;
        let rejectedByAngle = 0;
        let rejectedByNeighborhood = 0;
        
        for (const [a, b, c] of triangleIndices) {
          const p1 = buildingPoints[a];
          const p2 = buildingPoints[b];
          const p3 = buildingPoints[c];
          
          // Vérifier les longueurs d'arêtes
          const edge1 = p1.distanceTo(p2);
          const edge2 = p2.distanceTo(p3);
          const edge3 = p3.distanceTo(p1);
          const maxEdge = Math.max(edge1, edge2, edge3);
          
          if (maxEdge > MAX_EDGE_LENGTH) {
            rejectedByDistance++;
            continue;
          }
          
          // Si on a les voisinages WebGPU, vérifier que les 3 points sont mutuellement voisins
          if (neighborSets) {
            const hasEdge12 = neighborSets[a].has(b) || neighborSets[b].has(a);
            const hasEdge23 = neighborSets[b].has(c) || neighborSets[c].has(b);
            const hasEdge31 = neighborSets[c].has(a) || neighborSets[a].has(c);
            
            // Au moins 2 arêtes doivent être dans le voisinage
            const connectedEdges = [hasEdge12, hasEdge23, hasEdge31].filter(Boolean).length;
            if (connectedEdges < 2) {
              rejectedByNeighborhood++;
              continue;
            }
          }
          
          // Vérifier l'aire
          const area = triangleArea(p1, p2, p3);
          if (area < MIN_TRIANGLE_AREA) {
            rejectedByArea++;
            continue;
          }
          
          // Vérifier l'angle minimal
          const minAngle = smallestAngle(p1, p2, p3);
          const minAngleRad = (MIN_ANGLE_DEG * Math.PI) / 180;
          
          if (minAngle < minAngleRad) {
            rejectedByAngle++;
            continue;
          }
          
          // Triangle valide !
          acceptedTriangles++;
          triangleVertices.push(
            p1.x, p1.y, p1.z,
            p2.x, p2.y, p2.z,
            p3.x, p3.y, p3.z
          );
        }
        
        // Log de débogage détaillé
        if (lastUpdateFrameRef.current % 100 === 0) {
          console.log(`\n========== DELAUNAY + VOISINS PROCHES ==========`);
          console.log(`📊 Points traités: ${pointCount}`);
          console.log(`🔺 Triangles Delaunay générés: ${triangleIndices.length}`);
          console.log(`✅ Triangles acceptés: ${acceptedTriangles}`);
          console.log(`❌ Triangles rejetés:`);
          console.log(`   - Par distance (>${MAX_EDGE_LENGTH}m): ${rejectedByDistance}`);
          console.log(`   - Par voisinage: ${rejectedByNeighborhood}`);
          console.log(`   - Par aire (<${MIN_TRIANGLE_AREA}m²): ${rejectedByArea}`);
          console.log(`   - Par angle (<${MIN_ANGLE_DEG}°): ${rejectedByAngle}`);
          console.log(`\n⚙️  PARAMÈTRES:`);
          console.log(`   MAX_THRESHOLD: ${MAX_THRESHOLD}m (voisinage)`);
          console.log(`   MAX_EDGE_LENGTH: ${MAX_EDGE_LENGTH}m`);
          console.log(`   MAX_VALENCE: ${MAX_VALENCE} voisins`);
          console.log(`   WebGPU: ${webGPUInitializedRef.current ? '✅' : '❌'}`);
          
          if (acceptedTriangles === 0 && pointCount > 2) {
            console.log(`\n⚠️  AUCUN TRIANGLE CRÉÉ !`);
            console.log(`💡 Suggestions:`);
            console.log(`   - Augmentez MAX_THRESHOLD (actuellement ${MAX_THRESHOLD}m)`);
            console.log(`   - Augmentez MAX_EDGE_LENGTH (actuellement ${MAX_EDGE_LENGTH}m)`);
            console.log(`   - Augmentez MAX_VALENCE (actuellement ${MAX_VALENCE})`);
          }
          console.log(`===============================================\n`);
        }
        
        // Mettre à jour la géométrie avec les triangles
        if (triangleVertices.length > 0) {
          const positions = new Float32Array(triangleVertices);
          const positionAttribute = geometryRef.current.getAttribute('position');
          
          if (positionAttribute && positionAttribute.array.length === positions.length) {
            (positionAttribute.array as Float32Array).set(positions);
            positionAttribute.needsUpdate = true;
          } else {
            geometryRef.current.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometryRef.current.computeVertexNormals();
            geometryRef.current.computeBoundingSphere();
          }
          
          const vertexCount = triangleVertices.length / 3;
          geometryRef.current.setDrawRange(0, vertexCount);
        } else {
          geometryRef.current.setDrawRange(0, 0);
        }
      } catch (error) {
        console.error('[DELAUNAY + NEAREST] Erreur:', error);
        if (error instanceof Error) {
          console.error('[DELAUNAY + NEAREST] Détails:', error.message, error.stack);
        }
        geometryRef.current.setDrawRange(0, 0);
      } finally {
        setIsProcessing(false);
      }
    })();
  });
  
  // Initialiser la géométrie
  useEffect(() => {
    console.log('[DELAUNAY TRIANGULATION] Composant monté');
    const emptyPositions = new Float32Array(0);
    geometryRef.current.setAttribute('position', new THREE.BufferAttribute(emptyPositions, 3));
    geometryRef.current.setDrawRange(0, 0);
  }, []);
  
  return (
    <mesh geometry={geometryRef.current}>
      <meshStandardMaterial 
        color={0x4080ff}
        transparent={false}
        opacity={0.7}
        side={THREE.DoubleSide}
        depthTest={true}
        depthWrite={true}
        flatShading={false}
        wireframe={false}
      />
    </mesh>
  );
}
