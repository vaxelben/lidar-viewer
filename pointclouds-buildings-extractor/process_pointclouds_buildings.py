"""
Traitement des nuages de points de Metz
Extraction et reconstruction de bâtiments → Export GLB pour R3F
"""

import numpy as np
import open3d as o3d
import laspy
import json
from pathlib import Path
from typing import List, Dict, Tuple
from dataclasses import dataclass, asdict
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Import optionnel pour scipy (utilisé pour ConvexHull 2D)
try:
    from scipy.spatial import ConvexHull
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False
    logger.warning("scipy non disponible, utilisation d'une méthode alternative pour les enveloppes convexes")


@dataclass
class BuildingMetadata:
    """Métadonnées d'un bâtiment"""
    id: str
    num_points: int
    num_planes: int
    bbox_min: List[float]
    bbox_max: List[float]
    center: List[float]
    area_m2: float
    height_m: float


class MetzBuildingProcessor:
    """
    Processeur pour les nuages de points de Metz
    """
    
    def __init__(self, 
                 input_dir: str = None,
                 output_dir: str = None,
                 distance_threshold: float = 0.3):
        """
        Args:
            input_dir: Dossier contenant les fichiers .copc.laz (relatif à la racine du projet)
            output_dir: Dossier de sortie pour les .glb (relatif à la racine du projet)
            distance_threshold: Seuil RANSAC en mètres
        """
        # Obtenir la racine du projet (un niveau au-dessus du dossier du script)
        project_root = Path(__file__).parent.parent
        
        # Chemins par défaut relatifs à la racine du projet
        if input_dir is None:
            self.input_dir = project_root / "public" / "data" / "metz"
        else:
            # Si le chemin commence par "/", le traiter comme relatif à la racine du projet
            if input_dir.startswith("/"):
                self.input_dir = project_root / input_dir.lstrip("/")
            else:
                # Sinon, traiter comme chemin absolu ou relatif au répertoire courant
                self.input_dir = Path(input_dir)
        
        if output_dir is None:
            self.output_dir = project_root / "public" / "models"
        else:
            # Si le chemin commence par "/", le traiter comme relatif à la racine du projet
            if output_dir.startswith("/"):
                self.output_dir = project_root / output_dir.lstrip("/")
            else:
                # Sinon, traiter comme chemin absolu ou relatif au répertoire courant
                self.output_dir = Path(output_dir)
        self.distance_threshold = distance_threshold
        
        # Créer les dossiers de sortie
        self.buildings_dir = self.output_dir / "buildings"
        self.buildings_dir.mkdir(parents=True, exist_ok=True)
        
        self.metadata = []
        
    def find_laz_files(self) -> List[Path]:
        """Trouve tous les fichiers .laz/.copc.laz"""
        laz_files = list(self.input_dir.glob("*.laz")) + \
                    list(self.input_dir.glob("*.copc.laz"))
        
        logger.info(f"Fichiers .laz trouvés: {len(laz_files)}")
        for f in laz_files:
            logger.info(f"  - {f.name}")
        
        return laz_files
    
    def load_point_cloud(self, filepath: Path) -> Tuple[np.ndarray, np.ndarray]:
        """Charge un fichier LAZ et retourne points + classifications"""
        logger.info(f"Chargement: {filepath.name}")
        
        las = laspy.read(str(filepath))
        
        # Coordonnées XYZ
        points = np.vstack((las.x, las.y, las.z)).transpose()
        
        # Classifications (standard LAS)
        if hasattr(las, 'classification'):
            classifications = np.array(las.classification)
        else:
            classifications = np.zeros(len(points), dtype=np.uint8)
        
        logger.info(f"  Points: {len(points):,}")
        logger.info(f"  Classes: {np.unique(classifications)}")
        
        return points, classifications
    
    def extract_buildings(self, points: np.ndarray, 
                         classifications: np.ndarray) -> np.ndarray:
        """
        Extrait les points classifiés comme 'Bâtiment'
        Standard LAS: classe 6 = Bâtiment
        """
        # Classe 6 = Bâtiment selon LAS 1.4
        building_mask = classifications == 6
        building_points = points[building_mask]
        
        logger.info(f"  Bâtiments: {len(building_points):,} points")
        
        return building_points
    
    def segment_buildings_by_proximity(self, 
                                      points: np.ndarray,
                                      eps: float = 2.0,
                                      min_points: int = 100) -> List[np.ndarray]:
        """
        Sépare les différents bâtiments par clustering spatial (DBSCAN)
        
        Args:
            eps: Distance max entre points d'un même cluster (mètres)
            min_points: Nombre min de points pour former un bâtiment
        """
        logger.info("Segmentation des bâtiments individuels...")
        
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(points)
        
        # DBSCAN pour identifier les bâtiments séparés
        labels = np.array(pcd.cluster_dbscan(
            eps=eps,
            min_points=min_points,
            print_progress=False
        ))
        
        # Extraire chaque cluster
        unique_labels = np.unique(labels)
        buildings = []
        
        for label in unique_labels:
            if label == -1:  # Bruit
                continue
                
            cluster_points = points[labels == label]
            
            if len(cluster_points) >= min_points:
                buildings.append(cluster_points)
        
        logger.info(f"  {len(buildings)} bâtiments détectés")
        
        return buildings
    
    def extract_planes_ransac(self, points: np.ndarray,
                             max_planes: int = 6,
                             min_points: int = 50) -> List[Dict]:
        """Extrait les plans dominants avec RANSAC"""
        
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(points)
        
        planes = []
        remaining_pcd = pcd
        
        for i in range(max_planes):
            if len(remaining_pcd.points) < min_points:
                break
            
            plane_model, inliers = remaining_pcd.segment_plane(
                distance_threshold=self.distance_threshold,
                ransac_n=3,
                num_iterations=1000
            )
            
            if len(inliers) < min_points:
                break
            
            inlier_cloud = remaining_pcd.select_by_index(inliers)
            inlier_points = np.asarray(inlier_cloud.points)
            
            planes.append({
                'equation': plane_model,
                'points': inlier_points,
                'num_points': len(inliers)
            })
            
            remaining_pcd = remaining_pcd.select_by_index(inliers, invert=True)
        
        return planes
    
    def create_building_mesh(self, points: np.ndarray) -> o3d.geometry.TriangleMesh:
        """
        Crée un mesh 3D à partir des points d'un bâtiment
        Utilise une approche hybride: plans RANSAC + enveloppe convexe
        """
        # Méthode 1: Extraction des plans principaux
        planes = self.extract_planes_ransac(points, max_planes=8)
        
        if len(planes) >= 3:
            # Créer un mesh à partir des plans
            mesh = self._create_mesh_from_planes(planes)
        else:
            # Fallback: enveloppe convexe
            pcd = o3d.geometry.PointCloud()
            pcd.points = o3d.utility.Vector3dVector(points)
            mesh, _ = pcd.compute_convex_hull()
        
        # Nettoyer le mesh
        mesh.remove_duplicated_vertices()
        mesh.remove_duplicated_triangles()
        mesh.remove_degenerate_triangles()
        
        # Calculer les normales pour un bon rendu
        mesh.compute_vertex_normals()
        
        # Couleur grise pour les bâtiments
        mesh.paint_uniform_color([0.7, 0.7, 0.75])
        
        return mesh
    
    def _create_mesh_from_planes(self, planes: List[Dict]) -> o3d.geometry.TriangleMesh:
        """
        Crée un mesh à partir de plans RANSAC en préservant les angles nets
        Chaque plan est converti en une surface plane polygonale
        """
        combined_mesh = o3d.geometry.TriangleMesh()
        
        for plane in planes:
            points = plane['points']
            plane_eq = plane['equation']  # [a, b, c, d] où ax + by + cz + d = 0
            
            if len(points) < 3:
                continue
            
            # Créer une surface plane à partir des points du plan
            plane_mesh = self._create_flat_plane_mesh(points, plane_eq)
            
            if len(plane_mesh.vertices) > 0:
                combined_mesh += plane_mesh
        
        if len(combined_mesh.vertices) == 0:
            # Fallback: utiliser convex hull global mais avec Poisson pour préserver les angles
            all_points = np.vstack([p['points'] for p in planes])
            pcd_all = o3d.geometry.PointCloud()
            pcd_all.points = o3d.utility.Vector3dVector(all_points)
            
            # Utiliser Poisson reconstruction avec des paramètres qui préservent les angles
            try:
                # Calculer les normales d'abord
                pcd_all.estimate_normals()
                pcd_all.normalize_normals()
                
                # Poisson avec depth élevé pour préserver les détails
                mesh, _ = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
                    pcd_all, depth=9, width=0, scale=1.1, linear_fit=False
                )
                
                # Nettoyer le mesh
                mesh.remove_duplicated_vertices()
                mesh.remove_duplicated_triangles()
                mesh.remove_degenerate_triangles()
                mesh.remove_non_manifold_edges()
                
                combined_mesh = mesh
            except:
                # Dernier recours: convex hull
                combined_mesh, _ = pcd_all.compute_convex_hull()
        
        return combined_mesh
    
    def _create_flat_plane_mesh(self, points: np.ndarray, plane_eq: np.ndarray) -> o3d.geometry.TriangleMesh:
        """
        Crée un mesh plat à partir des points d'un plan
        Préserve les angles en créant un polygone 2D puis en le triangulant
        """
        if len(points) < 3:
            return o3d.geometry.TriangleMesh()
        
        # Normal du plan: [a, b, c]
        normal = plane_eq[:3]
        normal = normal / np.linalg.norm(normal)
        
        # Trouver un point sur le plan (point moyen des points)
        center = points.mean(axis=0)
        
        # Créer un système de coordonnées 2D sur le plan
        # Vecteur arbitraire perpendiculaire à la normale
        if abs(normal[0]) < 0.9:
            u = np.array([1, 0, 0])
        else:
            u = np.array([0, 1, 0])
        
        # Vecteurs de base du plan
        u = u - np.dot(u, normal) * normal
        u = u / np.linalg.norm(u)
        v = np.cross(normal, u)
        
        # Projeter tous les points sur le plan 2D
        points_2d = []
        for pt in points:
            vec = pt - center
            x_2d = np.dot(vec, u)
            y_2d = np.dot(vec, v)
            points_2d.append([x_2d, y_2d])
        
        points_2d = np.array(points_2d)
        
        # Créer un polygone à partir des points projetés
        # Utiliser alpha shape directement sur les points 3D pour préserver les limites concaves
        # au lieu d'une enveloppe convexe qui peut dépasser les limites réelles
        try:
            # Utiliser alpha shape directement sur les points 3D du plan
            # Cela préserve mieux les limites concaves et évite de dépasser les limites réelles
            pcd_plane = o3d.geometry.PointCloud()
            pcd_plane.points = o3d.utility.Vector3dVector(points)
            
            # Calculer alpha adaptatif basé sur la densité des points
            # Distance médiane entre points voisins
            distances = np.sqrt(np.sum((points[:, np.newaxis, :] - points[np.newaxis, :, :])**2, axis=2))
            non_zero_distances = distances[distances > 0]
            if len(non_zero_distances) > 0:
                median_distance = np.median(non_zero_distances)
                # Alpha adaptatif : plus petit pour préserver les détails
                alpha = max(0.3, min(1.5, median_distance * 1.5))
            else:
                alpha = 0.5
            
            try:
                # Essayer alpha shape d'abord (préserve mieux les limites concaves)
                mesh_alpha = o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(
                    pcd_plane, alpha
                )
                
                if len(mesh_alpha.vertices) > 0:
                    # Utiliser directement le mesh de l'alpha shape
                    # Il préserve mieux les limites concaves et ne dépasse pas les limites réelles
                    mesh_alpha.compute_vertex_normals()
                    return mesh_alpha
                else:
                    raise ValueError("Alpha shape vide")
            except:
                # Fallback: utiliser convex hull si alpha shape échoue
                if HAS_SCIPY:
                    hull_2d = ConvexHull(points_2d)
                    hull_indices = hull_2d.vertices
                    hull_points_3d = points[hull_indices]
                else:
                    hull_3d, _ = pcd_plane.compute_convex_hull()
                    hull_indices = np.unique(np.asarray(hull_3d.triangles).flatten())
                    hull_points_3d = points[hull_indices]
                
                # Créer un mesh à partir du polygone convexe
                mesh = o3d.geometry.TriangleMesh()
                mesh.vertices = o3d.utility.Vector3dVector(hull_points_3d)
                
                # Trianguler le polygone convexe (fan triangulation)
                num_verts = len(hull_points_3d)
                if num_verts >= 3:
                    triangles = []
                    for i in range(1, num_verts - 1):
                        triangles.append([0, i, i + 1])
                    mesh.triangles = o3d.utility.Vector3iVector(triangles)
                    
                    # Calculer les normales (toutes pointent vers la normale du plan)
                    mesh.vertex_normals = o3d.utility.Vector3dVector(
                        [normal] * num_verts
                    )
                
                return mesh
            
        except Exception as e:
            logger.warning(f"Erreur création mesh plan: {e}")
            # Fallback: utiliser alpha shape avec alpha très petit pour préserver les angles
            pcd = o3d.geometry.PointCloud()
            pcd.points = o3d.utility.Vector3dVector(points)
            
            try:
                # Alpha très petit pour préserver les angles
                mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(
                    pcd, alpha=0.1
                )
                return mesh
            except:
                return o3d.geometry.TriangleMesh()
    
    def compute_building_metadata(self, 
                                  building_id: str,
                                  points: np.ndarray,
                                  planes: List[Dict]) -> BuildingMetadata:
        """Calcule les métadonnées d'un bâtiment"""
        
        bbox_min = points.min(axis=0).tolist()
        bbox_max = points.max(axis=0).tolist()
        center = points.mean(axis=0).tolist()
        
        # Estimation de la surface au sol (emprise)
        footprint_points = points[points[:, 2] < np.percentile(points[:, 2], 20)]
        if len(footprint_points) > 0:
            x_range = footprint_points[:, 0].max() - footprint_points[:, 0].min()
            y_range = footprint_points[:, 1].max() - footprint_points[:, 1].min()
            area_m2 = float(x_range * y_range)
        else:
            area_m2 = 0.0
        
        # Hauteur
        height_m = float(bbox_max[2] - bbox_min[2])
        
        return BuildingMetadata(
            id=building_id,
            num_points=len(points),
            num_planes=len(planes),
            bbox_min=bbox_min,
            bbox_max=bbox_max,
            center=center,
            area_m2=area_m2,
            height_m=height_m
        )
    
    def export_to_glb(self, mesh: o3d.geometry.TriangleMesh, 
                     output_path: Path):
        """Exporte un mesh au format GLB (optimisé pour R3F)"""
        # Open3D peut exporter en GLB/GLTF
        try:
            o3d.io.write_triangle_mesh(
                str(output_path),
                mesh,
                write_ascii=False,
                compressed=True
            )
            logger.info(f"  Exporté: {output_path.name}")
        except Exception as e:
            logger.error(f"  Erreur export GLB: {e}")
            # Fallback: export en OBJ
            obj_path = output_path.with_suffix('.obj')
            o3d.io.write_triangle_mesh(str(obj_path), mesh)
            logger.info(f"  Exporté (OBJ): {obj_path.name}")
    
    def process_all(self):
        """Traite tous les fichiers .laz du dossier"""
        
        logger.info("=" * 70)
        logger.info("TRAITEMENT DES NUAGES DE POINTS DE METZ")
        logger.info("=" * 70)
        
        laz_files = self.find_laz_files()
        
        if not laz_files:
            logger.warning("Aucun fichier .laz trouvé!")
            return
        
        all_buildings = []
        building_counter = 0
        
        # Traiter chaque fichier LAZ
        for laz_file in laz_files:
            logger.info(f"\n{'=' * 70}")
            logger.info(f"Fichier: {laz_file.name}")
            logger.info(f"{'=' * 70}")
            
            # Charger le nuage de points
            points, classifications = self.load_point_cloud(laz_file)
            
            # Extraire les bâtiments
            building_points = self.extract_buildings(points, classifications)
            
            if len(building_points) == 0:
                logger.warning("  Aucun point de bâtiment trouvé")
                continue
            
            # Segmenter les bâtiments individuels
            buildings = self.segment_buildings_by_proximity(building_points)
            
            # Traiter chaque bâtiment
            for i, bldg_points in enumerate(buildings):
                building_counter += 1
                building_id = f"building_{building_counter:04d}"
                
                logger.info(f"\n  Bâtiment {building_id}: {len(bldg_points):,} points")
                
                # Extraire les plans
                planes = self.extract_planes_ransac(bldg_points)
                logger.info(f"    Plans détectés: {len(planes)}")
                
                # Créer le mesh
                mesh = self.create_building_mesh(bldg_points)
                logger.info(f"    Mesh: {len(mesh.vertices)} vertices, {len(mesh.triangles)} triangles")
                
                # Calculer métadonnées
                metadata = self.compute_building_metadata(
                    building_id, 
                    bldg_points,
                    planes
                )
                self.metadata.append(metadata)
                
                # Exporter en GLB
                output_path = self.buildings_dir / f"{building_id}.glb"
                self.export_to_glb(mesh, output_path)
                
                all_buildings.append(mesh)
        
        logger.info(f"\n{'=' * 70}")
        logger.info(f"RÉSUMÉ")
        logger.info(f"{'=' * 70}")
        logger.info(f"Bâtiments traités: {building_counter}")
        logger.info(f"Fichiers .glb générés: {len(all_buildings)}")
        
        # Créer un fichier merged avec tous les bâtiments
        if all_buildings:
            self._create_merged_model(all_buildings)
        
        # Sauvegarder les métadonnées
        self._save_metadata()
    
    def _create_merged_model(self, meshes: List[o3d.geometry.TriangleMesh]):
        """
        Crée un fichier GLB unique avec tous les bâtiments
        Préserve les espaces entre les bâtiments en évitant les intersections
        """
        logger.info("\nCréation du modèle merged...")
        
        combined = o3d.geometry.TriangleMesh()
        
        for i, mesh in enumerate(meshes):
            # Nettoyer chaque mesh individuel avant la fusion
            mesh.remove_duplicated_vertices()
            mesh.remove_duplicated_triangles()
            mesh.remove_degenerate_triangles()
            mesh.remove_non_manifold_edges()
            
            # S'assurer que le mesh est orienté correctement
            mesh.compute_vertex_normals()
            mesh.normalize_normals()
            
            # Ajouter le mesh au modèle combiné
            # L'opération += préserve les meshes séparés sans créer d'intersections
            combined += mesh
            
            if (i + 1) % 100 == 0:
                logger.info(f"  Traité {i + 1}/{len(meshes)} bâtiments...")
        
        # Nettoyage final du mesh combiné
        logger.info("Nettoyage du mesh combiné...")
        combined.remove_duplicated_vertices()
        combined.remove_duplicated_triangles()
        combined.remove_degenerate_triangles()
        combined.remove_non_manifold_edges()
        
        # Recalculer les normales pour un bon rendu
        combined.compute_vertex_normals()
        
        output_path = self.output_dir / "buildings_merged.glb"
        self.export_to_glb(combined, output_path)
        
        logger.info(f"Modèle merged: {len(combined.vertices):,} vertices, {len(combined.triangles):,} triangles")
    
    def _save_metadata(self):
        """Sauvegarde les métadonnées en JSON"""
        metadata_path = self.output_dir / "metadata.json"
        
        data = {
            'buildings': [asdict(m) for m in self.metadata],
            'total_buildings': len(self.metadata),
            'processing_params': {
                'distance_threshold': self.distance_threshold,
                'input_dir': str(self.input_dir),
                'output_dir': str(self.output_dir)
            }
        }
        
        with open(metadata_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        
        logger.info(f"\nMétadonnées sauvegardées: {metadata_path}")


def main():
    """Point d'entrée principal"""
    
    processor = MetzBuildingProcessor(
        input_dir=None,                      # Utilise public/data/metz par défaut
        output_dir=None,                     # Utilise public/models par défaut
        distance_threshold=0.3               # 30cm de tolérance RANSAC
    )
    
    processor.process_all()
    
    logger.info("\n" + "=" * 70)
    logger.info("TRAITEMENT TERMINÉ!")
    logger.info("=" * 70)
    logger.info("\nFichiers générés:")
    logger.info(f"  📁 {processor.output_dir / 'buildings'}")
    logger.info("     ├── building_0001.glb")
    logger.info("     ├── building_0002.glb")
    logger.info("     └── ...")
    logger.info(f"  📄 {processor.output_dir / 'buildings_merged.glb'}")
    logger.info(f"  📄 {processor.output_dir / 'metadata.json'}")
    logger.info("\nVous pouvez maintenant charger ces fichiers dans R3F!")


if __name__ == "__main__":
    main()