import React, { useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useKeyboardControls } from '@react-three/drei';
import { RigidBody, CapsuleCollider, RapierRigidBody, useRapier } from '@react-three/rapier';
import * as THREE from 'three';

const SPEED = 150;
const JUMP_FORCE = 50;
const PLAYER_HEIGHT = 1;
const START_HEIGHT_ABOVE_GROUND = 400; // Distance supplémentaire au-dessus du sol pour le spawn
const RAYCAST_DISTANCE = 0.05; // Distance pour détecter le sol
const MOUSE_SENSITIVITY = 0.002; // Sensibilité de la souris

interface PlayerProps {
  groundZ?: number; // Position Z du sol (optionnel)
}

export function Player({ groundZ }: PlayerProps = {}) {
  const rigidBodyRef = useRef<RapierRigidBody>(null);
  const { camera } = useThree();
  const [, get] = useKeyboardControls();
  const { rapier, world } = useRapier();
  
  // Position initiale du joueur à Z = 10
  // Le CapsuleCollider est centré sur le RigidBody (position [0, 0, 0])
  // Le bas de la capsule est à startPosition.z - PLAYER_HEIGHT/2
  const startPosition = React.useMemo(() => {
    const groundOffset = groundZ ?? 0;
    // Positionner le centre du joueur suffisamment haut au-dessus du sol détecté
    const centerZ = groundOffset + PLAYER_HEIGHT / 2 + START_HEIGHT_ABOVE_GROUND;
    const pos = new THREE.Vector3(0, 0, centerZ);
    console.log('[PLAYER] Position initiale:', {
      rigidBodyZ: pos.z,
      capsuleBottom: pos.z - PLAYER_HEIGHT / 2,
      groundZ: groundZ
    });
    return pos;
  }, [groundZ]);

  // États pour la rotation de la caméra
  // Dans un système où le plan horizontal est XY et Z est vertical :
  // - rotationZ = rotation dans le plan XY (azimuth) - regarder à gauche/droite
  // - rotationX = inclinaison haut/bas (pitch) - regarder vers le haut/bas
  // Calculer l'angle initial pour regarder vers l'origine (où se trouvent les bâtiments)
  const initialRotation = React.useMemo(() => {
    // Cible : centre de la scène / origine (0, 0, 0)
    const target = new THREE.Vector3(0, 0, 0);
    
    // Position de la caméra (yeux du joueur)
    const cameraPosition = new THREE.Vector3(
      startPosition.x,
      startPosition.y,
      startPosition.z + PLAYER_HEIGHT
    );
    
    // Vecteur de direction vers la cible
    const direction = new THREE.Vector3().subVectors(target, cameraPosition).normalize();
    
    // Calculer l'azimuth (rotation Z) : angle dans le plan XY
    // atan2(y, x) donne l'angle dans le plan XY
    const azimuth = Math.atan2(direction.y, direction.x);
    
    // Calculer le pitch (rotation X) : inclinaison verticale
    // Pour un système Z-up, le pitch est l'angle entre la direction et le plan XY
    const horizontalDistance = Math.sqrt(direction.x * direction.x + direction.y * direction.y);
    const pitch = Math.atan2(-direction.z, horizontalDistance); // Négatif car Z pointe vers le haut
    
    // Correction pour le système d'axes utilisé
    // L'Euler est en ordre ZXY, donc on ajuste les angles
    const correctedAzimuth = azimuth - Math.PI / 2; // Ajustement pour que +Y soit "devant"
    const correctedPitch = Math.PI / 2 - pitch; // Conversion vers le système de coordonnées de la caméra
    
    console.log('[PLAYER] Rotation initiale vers l\'origine:', {
      target: target.toArray(),
      cameraPosition: cameraPosition.toArray(),
      direction: direction.toArray(),
      azimuthDeg: (correctedAzimuth * 180 / Math.PI).toFixed(1),
      pitchDeg: (correctedPitch * 180 / Math.PI).toFixed(1)
    });
    
    return new THREE.Euler(correctedPitch, 0, correctedAzimuth, 'ZXY');
  }, [startPosition]);

  const eulerRef = useRef(initialRotation);
  const isPointerLockedRef = useRef(false);

  useEffect(() => {
    // Positionner la caméra au niveau des yeux du joueur
    camera.position.set(0, 0, startPosition.z + PLAYER_HEIGHT);
    
    // Configurer la caméra pour Z-up
    camera.up.set(0, 0, 1);
    
    // Appliquer la rotation initiale pour regarder vers l'origine
    camera.rotation.copy(initialRotation);
    eulerRef.current.copy(initialRotation);
    
    // Gérer le verrouillage du pointeur
    const handlePointerLockChange = () => {
      isPointerLockedRef.current = document.pointerLockElement !== null;
    };
    
    const handleMouseMove = (event: MouseEvent) => {
      if (!isPointerLockedRef.current) return;
      
      // Rotation horizontale (mouvement X de la souris) → rotation dans le plan XY
      // Dans un système Z-up, on tourne autour de l'axe Z pour regarder à gauche/droite
      eulerRef.current.z -= event.movementX * MOUSE_SENSITIVITY;
      
      // Rotation verticale (mouvement Y de la souris) → inclinaison (rotation autour de l'axe X)
      // On limite l'angle pour éviter les rotations excessives
      // Dans un système où XY est le plan horizontal :
      // - mouvementY positif (vers le bas) → rotation X positive (regarder vers le bas)
      // - mouvementY négatif (vers le haut) → rotation X négative (regarder vers le haut)
      const maxTilt = Math.PI / 1.5; // 60 degrés max
      eulerRef.current.x = Math.max(0, Math.min(maxTilt, eulerRef.current.x - event.movementY * MOUSE_SENSITIVITY));
    };
    
    document.addEventListener('pointerlockchange', handlePointerLockChange);
    document.addEventListener('mousemove', handleMouseMove);
    
    // Fonction pour demander le verrouillage du pointeur au clic
    const handleClick = () => {
      if (!isPointerLockedRef.current) {
        document.body.requestPointerLock();
      }
    };
    
    document.addEventListener('click', handleClick);
    
    return () => {
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('click', handleClick);
    };
  }, [camera, startPosition.z, initialRotation]);

  useFrame((state) => {
    if (!rigidBodyRef.current) return;

    const { forward, backward, left, right, jump } = get();
    const velocity = rigidBodyRef.current.linvel();

    // Mettre à jour la position de la caméra pour suivre le joueur
    const playerPosition = rigidBodyRef.current.translation();
    state.camera.position.set(
      playerPosition.x,
      playerPosition.y,
      playerPosition.z + PLAYER_HEIGHT
    );

    // Appliquer la rotation de la caméra basée sur les mouvements de la souris
    state.camera.rotation.copy(eulerRef.current);

    // Calculer la direction du mouvement basée sur les touches et l'orientation de la caméra
    // Dans notre système Z-up, on utilise la direction complète de la caméra pour le mouvement 3D
    
    // Obtenir la direction avant de la caméra (où elle regarde) - direction complète 3D
    const cameraDirection = new THREE.Vector3();
    state.camera.getWorldDirection(cameraDirection);
    
    // Utiliser la direction complète de la caméra (incluant Z) pour le mouvement 3D
    const forwardDirection = cameraDirection.clone().normalize();
    
    // Calculer la direction droite (perpendiculaire à forward)
    // Dans un système Z-up, utiliser le produit vectoriel avec l'axe up de la caméra
    const rightDirection = new THREE.Vector3();
    rightDirection.crossVectors(forwardDirection, state.camera.up).normalize();
    
    // Calculer la direction vers le haut (perpendiculaire à forward et right)
    const upDirection = new THREE.Vector3();
    upDirection.crossVectors(rightDirection, forwardDirection).normalize();
    
    // Calculer le vecteur de mouvement final
    const movement = new THREE.Vector3(0, 0, 0);
    
    // Avant/arrière : mouvement dans la direction complète de la caméra (3D)
    if (forward) {
      movement.add(forwardDirection);
    }
    if (backward) {
      movement.sub(forwardDirection);
    }
    
    // Gauche/droite : mouvement perpendiculaire à la direction de la caméra
    if (left) {
      movement.sub(rightDirection);
    }
    if (right) {
      movement.add(rightDirection);
    }
    
    // Normaliser et multiplier par la vitesse (seulement si le mouvement n'est pas nul)
    let direction = new THREE.Vector3(0, 0, 0);
    if (movement.length() > 0) {
      direction = movement.normalize().multiplyScalar(SPEED);
    }

    // Appliquer la vélocité : mouvement complet 3D (X, Y, Z)
    // En mode zeroGravity, on permet le mouvement libre dans toutes les directions
    rigidBodyRef.current.setLinvel(
      { x: direction.x, y: direction.y, z: direction.z },
      true
    );

    // Détection du sol et saut
    const rayOrigin = new rapier.Vector3(
      playerPosition.x,
      playerPosition.y,
      playerPosition.z
    );
    const rayDirection = new rapier.Vector3(0, 0, -1);
    const ray = new rapier.Ray(rayOrigin, rayDirection);
    const hit = world.castRay(ray, RAYCAST_DISTANCE + PLAYER_HEIGHT, true);
    
    const grounded = hit !== null && hit.collider !== null && hit.timeOfImpact <= RAYCAST_DISTANCE;

    if (jump && grounded) {
      rigidBodyRef.current.setLinvel(
        { x: velocity.x, y: velocity.y, z: JUMP_FORCE },
        true
      );
    }
  });

  return (
    <RigidBody
      ref={rigidBodyRef}
      position={[startPosition.x, startPosition.y, startPosition.z]}
      colliders={false}
      type="dynamic"
      lockRotations
      enabledRotations={[false, false, false]}
      enabledTranslations={[true, true, true]}
      canSleep={false}
      ccd={true}
      linearDamping={0}
      angularDamping={0}
    >
      {/* CapsuleCollider : args[0] = demi-hauteur, args[1] = rayon
          Position [0, 0, 0] = centre de la capsule au centre du RigidBody
          Donc le bas de la capsule est à startPosition.z - PLAYER_HEIGHT/2 */}
      <CapsuleCollider args={[PLAYER_HEIGHT / 2, 0.3]} />
      {/* Le joueur est invisible, seule la caméra est visible */}
    </RigidBody>
  );
}

