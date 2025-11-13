import { useMemo, useRef, useEffect, useState } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { nodeDataCache } from './DirectLazViewer';

interface BuildingTrianglesWebGPUProps {
  nodesToRender: { fileUrl: string; nodeKey: string; level: number; distance: number }[];
  globalBounds: { min: THREE.Vector3; max: THREE.Vector3 };
}

// Types WebGPU
interface GPU {
  requestAdapter(): Promise<GPUAdapter | null>;
}

interface GPUAdapter {
  requestDevice(): Promise<GPUDevice>;
}

interface GPUDevice {
  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
  createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule;
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout;
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout;
  createComputePipeline(descriptor: GPUComputePipelineDescriptor): GPUComputePipeline;
  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup;
  createCommandEncoder(): GPUCommandEncoder;
  queue: GPUQueue;
  destroy(): void;
}

interface GPUBuffer {
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  mapAsync(mode: number): Promise<void>;
  destroy(): void;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface GPUShaderModule {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface GPUBindGroupLayout {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface GPUPipelineLayout {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface GPUComputePipeline {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface GPUBindGroup {}
interface GPUCommandEncoder {
  beginComputePass(): GPUComputePassEncoder;
  copyBufferToBuffer(source: GPUBuffer, sourceOffset: number, destination: GPUBuffer, destinationOffset: number, size: number): void;
  finish(): GPUCommandBuffer;
}

interface GPUComputePassEncoder {
  setPipeline(pipeline: GPUComputePipeline): void;
  setBindGroup(index: number, bindGroup: GPUBindGroup): void;
  dispatchWorkgroups(workgroupCount: number): void;
  end(): void;
}

interface GPUQueue {
  submit(commandBuffers: GPUCommandBuffer[]): void;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface GPUCommandBuffer {}
interface GPUBufferDescriptor {
  size: number;
  usage: number;
  mappedAtCreation?: boolean;
}
interface GPUShaderModuleDescriptor {
  code: string;
}
interface GPUBindGroupLayoutDescriptor {
  entries: Array<{
    binding: number;
    visibility: number;
    buffer: { type: string };
  }>;
}
interface GPUPipelineLayoutDescriptor {
  bindGroupLayouts: GPUBindGroupLayout[];
}
interface GPUComputePipelineDescriptor {
  layout: GPUPipelineLayout;
  compute: {
    module: GPUShaderModule;
    entryPoint: string;
  };
}
interface GPUBindGroupDescriptor {
  layout: GPUBindGroupLayout;
  entries: Array<{
    binding: number;
    resource: { buffer: GPUBuffer };
  }>;
}

declare global {
  interface Navigator {
    gpu?: GPU;
  }
  interface Window {
    GPUBufferUsage?: {
      STORAGE: number;
      COPY_DST: number;
      COPY_SRC: number;
      UNIFORM: number;
      MAP_READ: number;
    };
    GPUShaderStage?: {
      COMPUTE: number;
    };
    GPUMapMode?: {
      READ: number;
    };
  }
}

// Classification pour les bâtiments
const BUILDING_CLASSIFICATION = 6;

// ===== PARAMÈTRES CRITIQUES POUR CONTRÔLER LA FORMATION DES TRIANGLES =====
const MAX_THRESHOLD = 2.0;  // 🔑 Distance maximale entre points connectés (en mètres)
                             // Réduisez cette valeur pour des triangles plus serrés
                             // Exemples: 0.5m, 1.0m, 2.0m, 5.0m

const MAX_EDGE_LENGTH = 3.0; // 🔑 Longueur maximale d'une arête de triangle (en mètres)
                              // Les triangles avec des arêtes plus longues sont rejetés

const PLAYER_RADIUS = 200;
const MAX_VALENCE = 6;  // 🔑 Nombre de plus proches voisins par point
                        // Plus élevé = plus de connexions possibles
                        // Recommandé: 4-8 pour un bon maillage

const MAX_POINTS = 25000;
const MIN_TRIANGLE_AREA = 0.001; // Aire minimale (m²) pour éviter les triangles plats
const MIN_ANGLE_DEG = 10; // Angle minimal dans le triangle (degrés)

// Compute shader WGSL pour calculer les connexions
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
  
  var bestIndices: array<u32, 8>;  // Augmenté pour supporter MAX_VALENCE jusqu'à 8
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

// Calculer l'aire d'un triangle
function triangleArea(p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3): number {
  const v1 = new THREE.Vector3().subVectors(p2, p1);
  const v2 = new THREE.Vector3().subVectors(p3, p1);
  const cross = new THREE.Vector3().crossVectors(v1, v2);
  return cross.length() * 0.5;
}

// Calculer l'angle le plus petit dans un triangle (en radians)
function smallestAngle(p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3): number {
  const v1 = new THREE.Vector3().subVectors(p2, p1);
  const v2 = new THREE.Vector3().subVectors(p3, p1);
  const v3 = new THREE.Vector3().subVectors(p3, p2);
  
  const a = v1.length();
  const b = v2.length();
  const c = v3.length();
  
  if (a === 0 || b === 0 || c === 0) return 0;
  
  // Loi des cosinus pour trouver les angles
  const cosAngle1 = Math.max(-1, Math.min(1, (b * b + c * c - a * a) / (2 * b * c)));
  const cosAngle2 = Math.max(-1, Math.min(1, (a * a + c * c - b * b) / (2 * a * c)));
  const cosAngle3 = Math.max(-1, Math.min(1, (a * a + b * b - c * c) / (2 * a * b)));
  
  const angle1 = Math.acos(cosAngle1);
  const angle2 = Math.acos(cosAngle2);
  const angle3 = Math.acos(cosAngle3);
  
  return Math.min(angle1, angle2, angle3);
}

export function BuildingTrianglesWebGPU({
  nodesToRender,
  globalBounds
}: BuildingTrianglesWebGPUProps) {
  const { camera } = useThree();
  const geometryRef = useRef<THREE.BufferGeometry>(new THREE.BufferGeometry());
  const lastUpdateFrameRef = useRef<number>(0);
  const webGPUDeviceRef = useRef<GPUDevice | null>(null);
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
      console.log('[BUILDING TRIANGLES] Initialisation WebGPU...');
      const gpu = navigator.gpu;
      if (!gpu) {
        console.error('[BUILDING TRIANGLES] WebGPU non disponible');
        return;
      }
      
      try {
        const adapter = await gpu.requestAdapter();
        if (!adapter) {
          console.error('[BUILDING TRIANGLES] Aucun adaptateur WebGPU');
          return;
        }
        
        const device = await adapter.requestDevice();
        webGPUDeviceRef.current = device;
        webGPUInitializedRef.current = true;
        console.log('[BUILDING TRIANGLES] ✅ WebGPU initialisé');
      } catch (error) {
        console.error('[BUILDING TRIANGLES] Erreur WebGPU:', error);
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
    
    if (!webGPUInitializedRef.current || !webGPUDeviceRef.current || isProcessing) {
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
        
        const pointsToProcess = buildingPoints;
        const device = webGPUDeviceRef.current;
        
        if (!device) {
          return;
        }
        
        // Créer les buffers WebGPU
        const pointsData = new Float32Array(pointCount * 3);
        for (let i = 0; i < pointCount; i++) {
          pointsData[i * 3] = pointsToProcess[i].x;
          pointsData[i * 3 + 1] = pointsToProcess[i].y;
          pointsData[i * 3 + 2] = pointsToProcess[i].z;
        }
        
        const bufferUsage = window.GPUBufferUsage;
        if (!bufferUsage) {
          throw new Error('GPUBufferUsage non disponible');
        }
        
        const pointsBuffer = device.createBuffer({
          size: pointsData.byteLength,
          usage: bufferUsage.STORAGE | bufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Float32Array(pointsBuffer.getMappedRange()).set(pointsData);
        pointsBuffer.unmap();
        
        const connectionsBuffer = device.createBuffer({
          size: pointCount * MAX_VALENCE * 4,
          usage: bufferUsage.STORAGE | bufferUsage.COPY_SRC,
        });
        
        const paramsData = new Uint32Array([
          pointCount,
          0, 0, 0
        ]);
        const paramsDataView = new DataView(paramsData.buffer);
        paramsDataView.setFloat32(4, maxThresholdSquared, true);
        paramsData[2] = MAX_VALENCE;
        
        const paramsBuffer = device.createBuffer({
          size: 16,
          usage: bufferUsage.UNIFORM | bufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Uint32Array(paramsBuffer.getMappedRange()).set(paramsData);
        paramsBuffer.unmap();
        
        // Créer le compute pipeline
        const shaderModule = device.createShaderModule({
          code: computeShaderCode,
        });
        
        const shaderStage = window.GPUShaderStage;
        if (!shaderStage) {
          throw new Error('GPUShaderStage non disponible');
        }
        
        const bindGroupLayout = device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: shaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 1, visibility: shaderStage.COMPUTE, buffer: { type: 'storage' } },
            { binding: 2, visibility: shaderStage.COMPUTE, buffer: { type: 'uniform' } },
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
        
        // Exécuter le compute shader
        const commandEncoder = device.createCommandEncoder();
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(computePipeline);
        passEncoder.setBindGroup(0, bindGroup);
        
        const workgroupCount = Math.ceil(pointCount / 64);
        passEncoder.dispatchWorkgroups(workgroupCount);
        passEncoder.end();
        
        // Copier les résultats
        const mapMode = window.GPUMapMode;
        if (!mapMode) {
          throw new Error('GPUMapMode non disponible');
        }
        
        const readbackBuffer = device.createBuffer({
          size: pointCount * MAX_VALENCE * 4,
          usage: bufferUsage.COPY_DST | bufferUsage.MAP_READ,
        });
        
        commandEncoder.copyBufferToBuffer(
          connectionsBuffer,
          0,
          readbackBuffer,
          0,
          pointCount * MAX_VALENCE * 4
        );
        
        device.queue.submit([commandEncoder.finish()]);
        
        // Lire les résultats
        await readbackBuffer.mapAsync(mapMode.READ);
        const connectionsData = new Uint32Array(readbackBuffer.getMappedRange());
        
        // ===== CONSTRUCTION DES TRIANGLES ENTRE PLUS PROCHES VOISINS =====
        const triangleVertices: number[] = [];
        const triangleSet = new Set<string>();
        let rejectedByDistance = 0;
        let rejectedByArea = 0;
        let rejectedByAngle = 0;
        let acceptedTriangles = 0;
        
        // Créer un Set pour recherche rapide de voisins
        const neighborSets = new Array(pointCount).fill(null).map(() => new Set<number>());
        
        for (let i = 0; i < pointCount; i++) {
          const baseIndex = i * MAX_VALENCE;
          for (let j = 0; j < MAX_VALENCE; j++) {
            const neighborIdx = connectionsData[baseIndex + j];
            if (neighborIdx !== 0xFFFFFFFF && neighborIdx < pointCount) {
              neighborSets[i].add(neighborIdx);
            }
          }
        }
        
        // Pour chaque point, créer des triangles avec ses voisins
        for (let i = 0; i < pointCount; i++) {
          const neighbors = Array.from(neighborSets[i]);
          
          // Créer des triangles entre ce point et toutes les paires de ses voisins
          for (let j = 0; j < neighbors.length; j++) {
            for (let k = j + 1; k < neighbors.length; k++) {
              const n1 = neighbors[j];
              const n2 = neighbors[k];
              
              // ✅ VÉRIFICATION CRITIQUE : Les 3 points doivent être mutuellement voisins
              // Cela garantit que les triangles se forment entre points proches
              const n1HasN2 = neighborSets[n1].has(n2);
              const n2HasN1 = neighborSets[n2].has(n1);
              
              if (n1HasN2 && n2HasN1) {
                // Créer une clé unique triée
                const sortedIndices = [i, n1, n2].sort((a, b) => a - b);
                const triangleKey = sortedIndices.join(',');
                
                if (!triangleSet.has(triangleKey)) {
                  const p1 = pointsToProcess[i];
                  const p2 = pointsToProcess[n1];
                  const p3 = pointsToProcess[n2];
                  
                  // Vérifier les longueurs d'arêtes
                  const edge1 = p1.distanceTo(p2);
                  const edge2 = p2.distanceTo(p3);
                  const edge3 = p3.distanceTo(p1);
                  const maxEdge = Math.max(edge1, edge2, edge3);
                  
                  if (maxEdge > MAX_EDGE_LENGTH) {
                    rejectedByDistance++;
                    continue;
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
                  triangleSet.add(triangleKey);
                  acceptedTriangles++;
                  
                  triangleVertices.push(
                    p1.x, p1.y, p1.z,
                    p2.x, p2.y, p2.z,
                    p3.x, p3.y, p3.z
                  );
                }
              }
            }
          }
        }
        
        readbackBuffer.unmap();
        
        // Nettoyer les buffers
        pointsBuffer.destroy();
        connectionsBuffer.destroy();
        paramsBuffer.destroy();
        readbackBuffer.destroy();
        
        // Log de débogage détaillé
        if (lastUpdateFrameRef.current % 100 === 0) {
          console.log(`\n========== RAPPORT DE TRIANGULATION ==========`);
          console.log(`📊 Points traités: ${pointCount}`);
          console.log(`✅ Triangles acceptés: ${acceptedTriangles}`);
          console.log(`❌ Triangles rejetés:`);
          console.log(`   - Par distance (>${MAX_EDGE_LENGTH}m): ${rejectedByDistance}`);
          console.log(`   - Par aire (<${MIN_TRIANGLE_AREA}m²): ${rejectedByArea}`);
          console.log(`   - Par angle (<${MIN_ANGLE_DEG}°): ${rejectedByAngle}`);
          console.log(`\n⚙️  PARAMÈTRES ACTUELS:`);
          console.log(`   MAX_THRESHOLD: ${MAX_THRESHOLD}m (distance max entre voisins)`);
          console.log(`   MAX_EDGE_LENGTH: ${MAX_EDGE_LENGTH}m (longueur max d'arête)`);
          console.log(`   MAX_VALENCE: ${MAX_VALENCE} (nb de voisins par point)`);
          console.log(`   MIN_ANGLE: ${MIN_ANGLE_DEG}°`);
          
          // Statistiques sur les voisinages
          const neighborCounts = neighborSets.map(s => s.size);
          const avgNeighbors = neighborCounts.reduce((a, b) => a + b, 0) / pointCount;
          const minNeighbors = Math.min(...neighborCounts);
          const maxNeighbors = Math.max(...neighborCounts);
          console.log(`\n🔗 Voisinages:`);
          console.log(`   Min: ${minNeighbors}, Max: ${maxNeighbors}, Moy: ${avgNeighbors.toFixed(1)}`);
          
          if (acceptedTriangles === 0 && pointCount > 2) {
            console.log(`\n⚠️  AUCUN TRIANGLE CRÉÉ !`);
            console.log(`💡 Suggestions:`);
            console.log(`   - Augmentez MAX_THRESHOLD (actuellement ${MAX_THRESHOLD}m)`);
            console.log(`   - Augmentez MAX_EDGE_LENGTH (actuellement ${MAX_EDGE_LENGTH}m)`);
            console.log(`   - Augmentez MAX_VALENCE (actuellement ${MAX_VALENCE})`);
            console.log(`   - Réduisez MIN_ANGLE_DEG (actuellement ${MIN_ANGLE_DEG}°)`);
          }
          console.log(`=============================================\n`);
        }
        
        // Mettre à jour la géométrie
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
        console.error('[BUILDING TRIANGLES] Erreur:', error);
        if (error instanceof Error) {
          console.error('[BUILDING TRIANGLES] Détails:', error.message, error.stack);
        }
        geometryRef.current.setDrawRange(0, 0);
      } finally {
        setIsProcessing(false);
      }
    })();
  });
  
  // Initialiser la géométrie
  useEffect(() => {
    console.log('[BUILDING TRIANGLES] Composant monté');
    const emptyPositions = new Float32Array(0);
    geometryRef.current.setAttribute('position', new THREE.BufferAttribute(emptyPositions, 3));
    geometryRef.current.setDrawRange(0, 0);
  }, []);
  
  return (
    <mesh geometry={geometryRef.current}>
      <meshStandardMaterial 
        color={0x4080ff}
        transparent={true}
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
