import React, { useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useKeyboardControls } from '@react-three/drei';
import { RigidBody, CapsuleCollider, RapierRigidBody, useRapier } from '@react-three/rapier';
import * as THREE from 'three';

const SPEED = 50;
const JUMP_FORCE = 50;
const PLAYER_HEIGHT = 50;
const RAYCAST_DISTANCE = 0.2; // Distance pour détecter le sol
const MOUSE_SENSITIVITY = 0.002; // Sensibilité de la souris

interface PlayerProps {
  groundZ?: number; // Position Z du sol (optionnel)
}

export function Player({ groundZ }: PlayerProps = {}) {
  const rigidBodyRef = useRef<RapierRigidBody>(null);
  const { camera } = useThree();
  const [, get] = useKeyboardControls();
  const { rapier, world } = useRapier();
  
  // États pour la rotation de la caméra
  // Dans un système où le plan horizontal est XY et Z est vertical :
  // - rotationZ = rotation dans le plan XY (azimuth) - regarder à gauche/droite
  // - rotationX = inclinaison haut/bas (pitch) - regarder vers le haut/bas
  // Par défaut, la caméra regarde vers l'horizon (pitch = 0) dans le plan XY
  // Pour regarder vers l'axe Y positif (devant), on tourne de -Math.PI/2 autour de Z
  const eulerRef = useRef(new THREE.Euler(Math.PI / 2, 0, Math.PI / 2, 'ZXY')); // Ordre ZXY : d'abord Z (azimuth), puis X (pitch)
  const isPointerLockedRef = useRef(false);

  // Position initiale du joueur à Z = 10
  // Le CapsuleCollider est centré sur le RigidBody (position [0, 0, 0])
  // Le bas de la capsule est à startPosition.z - PLAYER_HEIGHT/2
  const startPosition = React.useMemo(() => {
    // Positionner le joueur à Z = 10
    // Le centre du RigidBody sera à Z = 10
    // Le bas de la capsule sera à 10 - PLAYER_HEIGHT/2
    const pos = new THREE.Vector3(0, 0, 10);
    console.log('[PLAYER] Position initiale:', {
      rigidBodyZ: pos.z,
      capsuleBottom: pos.z - PLAYER_HEIGHT / 2,
      groundZ: groundZ
    });
    return pos;
  }, [groundZ]);

  useEffect(() => {
    // Positionner la caméra au niveau des yeux du joueur (Z = 10 + PLAYER_HEIGHT)
    camera.position.set(0, 0, 10 + PLAYER_HEIGHT);
    
    // Configurer la caméra pour Z-up
    camera.up.set(0, 0, 1);
    
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
  }, [camera]);

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
    // Dans notre système Z-up, on utilise la direction de la caméra pour le mouvement
    
    // Obtenir la direction avant de la caméra (où elle regarde)
    const cameraDirection = new THREE.Vector3();
    state.camera.getWorldDirection(cameraDirection);
    
    // Pour un système Z-up, on projette la direction de la caméra sur le plan XY
    // et on normalise pour avoir un vecteur horizontal
    const forwardDirection = new THREE.Vector3(cameraDirection.x, cameraDirection.y, 0).normalize();
    
    // Calculer la direction droite (perpendiculaire à forward dans le plan XY)
    // Dans un système Z-up, la droite est obtenue en faisant le produit vectoriel avec l'axe Z
    const rightDirection = new THREE.Vector3();
    rightDirection.crossVectors(forwardDirection, new THREE.Vector3(0, 0, 1)).normalize();
    
    // Calculer le vecteur de mouvement final
    const movement = new THREE.Vector3(0, 0, 0);
    
    // Avant/arrière : mouvement dans la direction de la caméra (projetée sur XY)
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

    // Appliquer la vélocité : garder Z (vertical) et remplacer X et Y
    rigidBodyRef.current.setLinvel(
      { x: direction.x, y: direction.y, z: velocity.z },
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

