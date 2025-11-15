"""
Traitement des nuages de points de Metz - Version Optimisée RAM

OPTIMISATIONS MÉMOIRE:
- Découpage spatial en grille avant DBSCAN (évite la saturation RAM)
- Utilisation de sklearn DBSCAN avec ball_tree (plus efficace)
- Sous-échantillonnage adaptatif pour les gros clusters
- Suivi de progression avec barre de progression
- Traitement par chunks pour les très gros fichiers
"""

import numpy as np
import open3d as o3d
import laspy
import json
from pathlib import Path
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass, asdict
import logging
from shapely.geometry import Polygon, MultiPolygon, Point
from shapely.ops import unary_union
import alphashape
from tqdm import tqdm
from sklearn.cluster import DBSCAN
import gc

# Configuration logging
logging.basicConfig(
    level=logging.INFO,
    format='%(levelname)-8s %(message)s'
)
logger = logging.getLogger(__name__)

# Import optionnel scipy
try:
    from scipy.spatial import ConvexHull
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False
    logger.warning("scipy non disponible")

try:
    import triangle
    HAS_TRIANGLE = True
except ImportError:
    HAS_TRIANGLE = False
    logger.warning("triangle non disponible")


@dataclass
class CourtyardInfo:
    """Information sur une cour intérieure"""
    boundary_2d: np.ndarray
    height_m: float
    area_m2: float
    wall_height_m: float


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
    num_courtyards: int = 0


class OptimizedBuildingProcessor:
    """
    Processeur optimisé pour éviter la saturation RAM
    """

    def __init__(self,
                 input_dir: str = None,
                 output_dir: str = None,
                 distance_threshold: float = 0.3,
                 dbscan_eps: float = 8.5,
                 dbscan_min_points: int = 100,
                 grid_size: float = 100.0,  # Taille de grille pour découpage spatial
                 max_points_per_cluster: int = 50000):  # Limite pour sous-échantillonnage
        """
        Args:
            grid_size: Taille de la grille en mètres pour découpage spatial
            max_points_per_cluster: Si un cluster dépasse ce nombre, on sous-échantillonne
        """
        project_root = Path(__file__).parent.parent

        if input_dir is None:
            self.input_dir = project_root / "public" / "data" / "metz"
        else:
            self.input_dir = Path(input_dir) if not input_dir.startswith("/") else project_root / input_dir.lstrip("/")

        if output_dir is None:
            self.output_dir = project_root / "public" / "models"
        else:
            self.output_dir = Path(output_dir) if not output_dir.startswith("/") else project_root / output_dir.lstrip("/")

        self.distance_threshold = distance_threshold
        self.dbscan_eps = dbscan_eps
        self.dbscan_min_points = dbscan_min_points
        self.grid_size = grid_size
        self.max_points_per_cluster = max_points_per_cluster

        self.buildings_dir = self.output_dir / "buildings"
        self.buildings_dir.mkdir(parents=True, exist_ok=True)

        self.metadata = []

    # ==================== OPTIMISATION MÉMOIRE ====================

    def create_spatial_grid(self, points: np.ndarray) -> Dict[Tuple[int, int], np.ndarray]:
        """
        Découpe les points en grille spatiale 2D
        
        Retourne un dictionnaire {(grid_x, grid_y): indices_points}
        """
        logger.info(f"Découpage spatial (grille {self.grid_size}m)...")
        
        # Calculer les indices de grille pour chaque point
        grid_x = np.floor(points[:, 0] / self.grid_size).astype(int)
        grid_y = np.floor(points[:, 1] / self.grid_size).astype(int)
        
        # Grouper les points par cellule de grille
        grid_cells = {}
        unique_cells = np.unique(np.column_stack([grid_x, grid_y]), axis=0)
        
        for cell in unique_cells:
            cx, cy = cell
            mask = (grid_x == cx) & (grid_y == cy)
            indices = np.where(mask)[0]
            if len(indices) > 0:
                grid_cells[(cx, cy)] = indices
        
        logger.info(f" {len(grid_cells)} cellules de grille créées")
        return grid_cells

    def merge_adjacent_clusters(self, 
                                clusters: List[np.ndarray],
                                eps: float) -> List[np.ndarray]:
        """
        Fusionne les clusters adjacents provenant de différentes cellules de grille
        """
        if len(clusters) <= 1:
            return clusters
        
        logger.info(f"Fusion des clusters adjacents...")
        
        # Calculer les centres de chaque cluster
        centers = np.array([c.mean(axis=0) for c in clusters])
        
        # Clustering des centres avec DBSCAN
        from sklearn.cluster import DBSCAN
        clustering = DBSCAN(eps=eps * 2, min_samples=1, algorithm='ball_tree')
        labels = clustering.fit_predict(centers)
        
        # Fusionner les clusters avec le même label
        merged = []
        for label in np.unique(labels):
            cluster_indices = np.where(labels == label)[0]
            merged_points = np.vstack([clusters[i] for i in cluster_indices])
            merged.append(merged_points)
        
        logger.info(f" {len(clusters)} → {len(merged)} clusters après fusion")
        return merged

    def downsample_points(self, points: np.ndarray, 
                         target_size: int) -> Tuple[np.ndarray, np.ndarray]:
        """
        Sous-échantillonne les points en préservant la structure
        
        Retourne: (points_downsampled, indices_originaux)
        """
        if len(points) <= target_size:
            return points, np.arange(len(points))
        
        # Voxel downsampling
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(points)
        
        # Calculer la taille de voxel appropriée
        bbox = pcd.get_axis_aligned_bounding_box()
        diagonal = np.linalg.norm(bbox.get_max_bound() - bbox.get_min_bound())
        voxel_size = diagonal / np.cbrt(target_size)
        
        pcd_down = pcd.voxel_down_sample(voxel_size)
        downsampled = np.asarray(pcd_down.points)
        
        # Trouver les indices les plus proches dans le nuage original
        from scipy.spatial import cKDTree
        tree = cKDTree(points)
        _, indices = tree.query(downsampled)
        
        return downsampled, indices

    # ==================== SEGMENTATION OPTIMISÉE ====================

    def segment_buildings_optimized(self,
                                   points: np.ndarray,
                                   eps: Optional[float] = None,
                                   min_points: Optional[int] = None) -> List[np.ndarray]:
        """
        Segmentation optimisée avec découpage spatial et suivi de progression
        """
        if eps is None:
            eps = self.dbscan_eps
        if min_points is None:
            min_points = self.dbscan_min_points

        logger.info(f"Segmentation DBSCAN optimisée (eps={eps}m, min_points={min_points})...")
        logger.info(f"Points à traiter: {len(points):,}")
        
        # Découpage spatial
        grid_cells = self.create_spatial_grid(points)
        
        all_clusters = []
        total_cells = len(grid_cells)
        
        # Traiter chaque cellule avec barre de progression
        logger.info("Clustering par cellule:")
        with tqdm(total=total_cells, desc="Cellules", unit="cell") as pbar:
            for (cx, cy), indices in grid_cells.items():
                cell_points = points[indices]
                
                # Si trop de points, sous-échantillonner pour DBSCAN
                if len(cell_points) > self.max_points_per_cluster:
                    logger.debug(f" Cellule ({cx},{cy}): {len(cell_points)} points → sous-échantillonnage")
                    cell_points_sample, sample_indices = self.downsample_points(
                        cell_points, 
                        self.max_points_per_cluster
                    )
                    # Mapper les indices
                    original_indices = indices[sample_indices]
                else:
                    cell_points_sample = cell_points
                    original_indices = indices
                
                # DBSCAN avec sklearn (plus efficace en mémoire)
                clustering = DBSCAN(
                    eps=eps,
                    min_samples=min_points,
                    algorithm='ball_tree',  # Plus efficace que brute force
                    n_jobs=1  # Éviter les problèmes de mémoire avec parallel
                )
                labels = clustering.fit_predict(cell_points_sample)
                
                # Extraire les clusters de cette cellule
                for label in np.unique(labels):
                    if label == -1:  # Bruit
                        continue
                    cluster_mask = labels == label
                    
                    # Récupérer les points originaux du cluster
                    if len(cell_points) > self.max_points_per_cluster:
                        # Étendre le cluster aux points proches non échantillonnés
                        cluster_center = cell_points_sample[cluster_mask].mean(axis=0)
                        distances = np.linalg.norm(cell_points - cluster_center, axis=1)
                        extended_mask = distances < (eps * 2)
                        cluster_points = cell_points[extended_mask]
                    else:
                        cluster_points = cell_points_sample[cluster_mask]
                    
                    if len(cluster_points) >= min_points:
                        all_clusters.append(cluster_points)
                
                pbar.update(1)
                
                # Libérer la mémoire
                del cell_points, cell_points_sample
                if (pbar.n % 10) == 0:
                    gc.collect()
        
        logger.info(f"Clusters avant fusion: {len(all_clusters)}")
        
        # Fusionner les clusters adjacents entre cellules
        if len(all_clusters) > 0:
            buildings = self.merge_adjacent_clusters(all_clusters, eps)
        else:
            buildings = []
        
        logger.info(f"Bâtiments finaux détectés: {len(buildings)}")
        
        # Libérer la mémoire
        del all_clusters, grid_cells
        gc.collect()
        
        return buildings

    # ==================== CHARGEMENT ====================

    def find_laz_files(self) -> List[Path]:
        """Trouve tous les fichiers .laz/.copc.laz (sans doublons)"""
        # Utiliser un set pour éviter les doublons (*.copc.laz match aussi *.laz)
        laz_files = set(self.input_dir.glob("*.laz"))
        laz_files.update(self.input_dir.glob("*.copc.laz"))
        laz_files = sorted(list(laz_files))  # Trier pour ordre déterministe
        
        logger.info(f"Fichiers .laz trouvés: {len(laz_files)}")
        for f in laz_files:
            logger.info(f" - {f.name}")
        return laz_files

    def load_point_cloud(self, filepath: Path) -> Tuple[np.ndarray, np.ndarray]:
        """Charge un fichier LAZ et retourne points + classifications"""
        logger.info(f"Chargement: {filepath.name}")
        las = laspy.read(str(filepath))

        points = np.vstack((las.x, las.y, las.z)).transpose()

        if hasattr(las, 'classification'):
            classifications = np.array(las.classification)
        else:
            classifications = np.zeros(len(points), dtype=np.uint8)

        logger.info(f" Points: {len(points):,}")
        logger.info(f" Classes: {np.unique(classifications)}")

        return points, classifications

    def extract_buildings(self, points: np.ndarray,
                         classifications: np.ndarray) -> np.ndarray:
        """Extrait les points classifiés comme 'Bâtiment' (classe 6 LAS)"""
        building_mask = classifications == 6
        building_points = points[building_mask]
        logger.info(f" Bâtiments: {len(building_points):,} points")
        return building_points

    # ==================== DÉTECTION DE COURS (simplifié) ====================

    def detect_courtyard_2d(self, points: np.ndarray,
                            alpha: float = 0.8) -> Tuple[np.ndarray, List[np.ndarray]]:
        """Détecte les cours intérieures (version allégée)"""
        # Projeter sur le plan XY
        points_2d = points[:, :2]

        # Pour éviter les problèmes de mémoire, limiter le nombre de points
        if len(points_2d) > 10000:
            indices = np.random.choice(len(points_2d), 10000, replace=False)
            points_2d_sample = points_2d[indices]
        else:
            points_2d_sample = points_2d

        try:
            alpha_shape_2d = alphashape.alphashape(points_2d_sample, alpha)
        except Exception as e:
            logger.warning(f"Alpha shape échoué: {e}")
            if HAS_SCIPY:
                hull = ConvexHull(points_2d_sample)
                exterior = points_2d_sample[hull.vertices]
            else:
                exterior = points_2d_sample
            return exterior, []

        if isinstance(alpha_shape_2d, MultiPolygon):
            alpha_shape_2d = max(alpha_shape_2d.geoms, key=lambda p: p.area)

        if isinstance(alpha_shape_2d, Polygon):
            exterior = np.array(alpha_shape_2d.exterior.coords[:-1])
            holes = [np.array(hole.coords[:-1]) for hole in alpha_shape_2d.interiors]
            return exterior, holes

        return points_2d_sample, []

    def validate_courtyards(self, points: np.ndarray,
                           holes_2d: List[np.ndarray]) -> List[CourtyardInfo]:
        """Validation simplifiée des cours"""
        courtyards = []
        
        for hole in holes_2d:
            if len(hole) < 4:
                continue
                
            poly = Polygon(hole)
            area = poly.area
            
            if area < 10 or area > 2000:  # Filtres de taille
                continue
            
            # Hauteur moyenne des points dans le trou
            hole_poly_buffered = poly.buffer(0.5)
            mask = [hole_poly_buffered.contains(Point(p[:2])) for p in points[:min(len(points), 1000)]]
            
            if any(mask):
                points_in_hole = points[mask]
                height_m = float(points_in_hole[:, 2].mean())
                wall_height = float(points[:, 2].max() - height_m)
            else:
                height_m = float(points[:, 2].min())
                wall_height = float(points[:, 2].max() - height_m)
            
            courtyards.append(CourtyardInfo(
                boundary_2d=hole,
                height_m=height_m,
                area_m2=float(area),
                wall_height_m=wall_height
            ))
        
        return courtyards

    def extract_planes_ransac(self, points: np.ndarray) -> List[Dict]:
        """Extraction de plans avec RANSAC (version allégée)"""
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(points)
        
        planes = []
        max_iterations = 5
        remaining_points = pcd
        
        for i in range(max_iterations):
            if len(remaining_points.points) < 100:
                break
            
            try:
                plane_model, inliers = remaining_points.segment_plane(
                    distance_threshold=self.distance_threshold,
                    ransac_n=3,
                    num_iterations=1000
                )
                
                if len(inliers) < 100:
                    break
                
                planes.append({
                    'model': plane_model.tolist(),
                    'num_points': len(inliers)
                })
                
                remaining_points = remaining_points.select_by_index(inliers, invert=True)
                
            except Exception as e:
                logger.warning(f"RANSAC échoué: {e}")
                break
        
        return planes

    def create_building_mesh_with_courtyards(self, points: np.ndarray) -> o3d.geometry.TriangleMesh:
        """Création de mesh simplifiée"""
        # Sous-échantillonner si trop de points
        if len(points) > 20000:
            pcd = o3d.geometry.PointCloud()
            pcd.points = o3d.utility.Vector3dVector(points)
            pcd = pcd.voxel_down_sample(0.2)
            points = np.asarray(pcd.points)
        
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(points)
        
        try:
            pcd.estimate_normals(
                search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=1.0, max_nn=30)
            )
            pcd.orient_normals_consistent_tangent_plane(30)
            
            mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
                pcd, depth=8, width=0, scale=1.1, linear_fit=False
            )
            
            # Nettoyage
            mesh.remove_duplicated_vertices()
            mesh.remove_duplicated_triangles()
            mesh.remove_degenerate_triangles()
            mesh.compute_vertex_normals()
            
            return mesh
            
        except Exception as e:
            logger.warning(f"Poisson échoué: {e}, utilisation alpha shape")
            try:
                mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(pcd, 0.5)
                mesh.compute_vertex_normals()
                return mesh
            except:
                return o3d.geometry.TriangleMesh()

    # ==================== MÉTADONNÉES ====================

    def compute_building_metadata(self,
                                 building_id: str,
                                 points: np.ndarray,
                                 planes: List[Dict],
                                 num_courtyards: int = 0) -> BuildingMetadata:
        """Calcule les métadonnées"""
        bbox_min = points.min(axis=0).tolist()
        bbox_max = points.max(axis=0).tolist()
        center = points.mean(axis=0).tolist()

        footprint_points = points[points[:, 2] < np.percentile(points[:, 2], 20)]
        if len(footprint_points) > 0:
            x_range = footprint_points[:, 0].max() - footprint_points[:, 0].min()
            y_range = footprint_points[:, 1].max() - footprint_points[:, 1].min()
            area_m2 = float(x_range * y_range)
        else:
            area_m2 = 0.0

        height_m = float(bbox_max[2] - bbox_min[2])

        return BuildingMetadata(
            id=building_id,
            num_points=len(points),
            num_planes=len(planes),
            bbox_min=bbox_min,
            bbox_max=bbox_max,
            center=center,
            area_m2=area_m2,
            height_m=height_m,
            num_courtyards=num_courtyards
        )

    def export_to_glb(self, mesh: o3d.geometry.TriangleMesh, output_path: Path):
        """Exporte un mesh au format GLB"""
        try:
            o3d.io.write_triangle_mesh(
                str(output_path),
                mesh,
                write_ascii=False,
                compressed=True
            )
            logger.info(f"  ✓ Exporté: {output_path.name}")
        except Exception as e:
            logger.error(f"  Erreur export GLB: {e}")

    # ==================== ORCHESTRATION ====================

    def process_all(self):
        """Traite tous les fichiers .laz"""
        logger.info("=" * 70)
        logger.info("TRAITEMENT OPTIMISÉ - GESTION RAM")
        logger.info("=" * 70)

        laz_files = self.find_laz_files()
        if not laz_files:
            logger.warning("Aucun fichier .laz trouvé!")
            return

        all_buildings = []
        building_counter = 0

        for laz_file in laz_files:
            logger.info(f"\n{'='*70}")
            logger.info(f"Fichier: {laz_file.name}")
            logger.info(f"{'='*70}")

            # Charger
            points, classifications = self.load_point_cloud(laz_file)

            # Extraire bâtiments
            building_points = self.extract_buildings(points, classifications)
            if len(building_points) == 0:
                logger.warning(" Aucun point de bâtiment trouvé")
                continue

            # Libérer mémoire
            del points, classifications
            gc.collect()

            # Segmentation optimisée
            buildings = self.segment_buildings_optimized(building_points)

            # Traiter chaque bâtiment
            for i, bldg_points in enumerate(buildings):
                building_counter += 1
                building_id = f"building_{building_counter:04d}"

                logger.info(f"\n {building_id}: {len(bldg_points):,} points")

                try:
                    exterior_2d, holes_2d = self.detect_courtyard_2d(bldg_points, alpha=0.8)
                    courtyards = self.validate_courtyards(bldg_points, holes_2d)
                    planes = self.extract_planes_ransac(bldg_points)

                    logger.info(f"  → {len(courtyards)} cours validées")

                    mesh = self.create_building_mesh_with_courtyards(bldg_points)

                    logger.info(f"  → Mesh: {len(mesh.vertices):,} V, {len(mesh.triangles):,} T")

                    metadata = self.compute_building_metadata(
                        building_id,
                        bldg_points,
                        planes,
                        num_courtyards=len(courtyards)
                    )
                    self.metadata.append(metadata)

                    output_path = self.buildings_dir / f"{building_id}.glb"
                    self.export_to_glb(mesh, output_path)

                    all_buildings.append(mesh)

                except Exception as e:
                    logger.error(f"  ✗ Erreur: {e}")
                    continue

                # Libérer mémoire régulièrement
                if building_counter % 10 == 0:
                    gc.collect()

        # Résumé
        logger.info(f"\n{'='*70}")
        logger.info(f"RÉSUMÉ")
        logger.info(f"{'='*70}")
        logger.info(f"Bâtiments traités: {building_counter}")
        logger.info(f"Cours détectées: {sum(m.num_courtyards for m in self.metadata)}")

        if all_buildings:
            self._create_merged_model(all_buildings)

        self._save_metadata()

    def _create_merged_model(self, meshes: List[o3d.geometry.TriangleMesh]):
        """Crée un modèle merged"""
        logger.info("\nCréation du modèle merged...")

        combined = o3d.geometry.TriangleMesh()

        for i, mesh in enumerate(meshes):
            mesh.remove_duplicated_vertices()
            mesh.remove_duplicated_triangles()
            mesh.compute_vertex_normals()
            combined += mesh

            if (i + 1) % 50 == 0:
                logger.info(f" {i+1}/{len(meshes)} bâtiments...")
                gc.collect()

        combined.remove_duplicated_vertices()
        combined.remove_duplicated_triangles()
        combined.compute_vertex_normals()

        output_path = self.output_dir / "buildings_merged.glb"
        self.export_to_glb(combined, output_path)

        logger.info(f"✓ Merged: {len(combined.vertices):,} V, {len(combined.triangles):,} T")

    def _save_metadata(self):
        """Sauvegarde les métadonnées"""
        metadata_path = self.output_dir / "metadata.json"

        data = {
            'buildings': [asdict(m) for m in self.metadata],
            'total_buildings': len(self.metadata),
            'total_courtyards': sum(m.num_courtyards for m in self.metadata),
            'processing_params': {
                'distance_threshold': self.distance_threshold,
                'dbscan_eps': self.dbscan_eps,
                'dbscan_min_points': self.dbscan_min_points,
                'grid_size': self.grid_size,
                'max_points_per_cluster': self.max_points_per_cluster
            }
        }

        with open(metadata_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        logger.info(f"\n✓ Métadonnées: {metadata_path}")


def main():
    """Point d'entrée"""
    processor = OptimizedBuildingProcessor(
        input_dir=None,
        output_dir=None,
        distance_threshold=0.3,
        dbscan_eps=8.5,  # Distance max entre points
        dbscan_min_points=100,  # Points min par bâtiment
        grid_size=100.0,  # Taille grille spatiale en mètres
        max_points_per_cluster=50000  # Limite pour sous-échantillonnage
    )

    processor.process_all()

    logger.info("\n" + "="*70)
    logger.info("✓ TRAITEMENT TERMINÉ!")
    logger.info("="*70)


if __name__ == "__main__":
    main()