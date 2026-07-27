import {
  BlobReader,
  BlobWriter,
  TextReader,
  TextWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js';
import * as THREE from 'three';
import type { Mesh as ItkMesh } from 'itk-wasm';
import { connectMeshComponents } from './meshComponentConnector.ts';

export const DEFAULT_THREE_MF_COLOR_COUNT = 4;
export const MAX_THREE_MF_COLOR_COUNT = 16;
// Color detail ("sensitivity") for the multi-color export: 0 keeps large,
// rough color regions, 100 preserves per-triangle/texture detail. Slider
// position 50 still reproduces the historical fixed behavior exactly; the
// default sits above the midpoint so exports pick up texture-driven subdivision
// (forceTextureDetail) for finer color regions out of the box.
export const DEFAULT_THREE_MF_COLOR_DETAIL = 75;

const CORE_NAMESPACE =
  'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const MATERIAL_NAMESPACE =
  'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
const PRODUCTION_NAMESPACE =
  'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const SLIC3R_NAMESPACE = 'http://schemas.slic3r.org/3mf/2017/06';
const RELATIONSHIPS_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/content-types';
const BAMBU_OBJECT_MODEL_PATH = '3D/Objects/Object_1_1.model';
const BAMBU_OBJECT_MODEL_REL_TARGET = '/3D/Objects/Object_1_1.model';
// Classic multi-color exports keep the old-Studio-friendly version so they open
// in every Bambu Studio release. Full-spectrum exports carry mixed-filament
// project settings that only a newer Studio understands, so they advertise a
// real release that supports them.
const BAMBU_STUDIO_VERSION = '01.08.02.56';
const BAMBU_STUDIO_MIXED_FILAMENT_VERSION = '02.07.00.55';
const BAMBU_SUPPORTED_VERSIONS = [
  BAMBU_STUDIO_VERSION,
  BAMBU_STUDIO_MIXED_FILAMENT_VERSION,
];
const buildBambuStudioApplication = (version: string): string =>
  `BambuStudio-${version}`;
const BAMBU_PROJECT_SETTINGS_TEMPLATE_FILAMENT_COUNT = 3;
const BAMBU_PROJECT_SETTINGS_TEMPLATE_JSON =
  '{"accel_to_decel_enable":"0","accel_to_decel_factor":"50%","activate_air_filtration":["0","0","0"],"additional_cooling_fan_speed":["70","70","70"],"auxiliary_fan":"1","bed_custom_model":"","bed_custom_texture":"","bed_exclude_area":["0x0","18x0","18x28","0x28"],"before_layer_change_gcode":"","best_object_pos":"0.5,0.5","bottom_shell_layers":"4","bottom_shell_thickness":"0","bottom_surface_pattern":"monotonic","bridge_angle":"0","bridge_flow":"1","bridge_no_support":"0","bridge_speed":"50","brim_object_gap":"0.1","brim_type":"auto_brim","brim_width":"5","chamber_temperatures":["0","0","0"],"change_filament_gcode":"","close_fan_the_first_x_layers":["1","1","1"],"compatible_printers_condition":"","complete_print_exhaust_fan_speed":["70","70","70"],"cool_plate_temp":["35","35","35"],"cool_plate_temp_initial_layer":["35","35","35"],"curr_bed_type":"Cool Plate","default_acceleration":"10000","default_filament_colour":["","",""],"default_filament_profile":["Bambu PLA Basic @BBL X1C"],"default_jerk":"0","default_print_profile":"0.20mm Standard @BBL X1C","deretraction_speed":["30"],"detect_narrow_internal_solid_infill":"1","detect_overhang_wall":"1","detect_thin_wall":"0","different_settings_to_system":["","","","",""],"draft_shield":"disabled","during_print_exhaust_fan_speed":["70","70","70"],"elefant_foot_compensation":"0.15","enable_arc_fitting":"1","enable_long_retraction_when_cut":"2","enable_overhang_bridge_fan":["1","1","1"],"enable_overhang_speed":"1","enable_pressure_advance":["0","0","0"],"enable_prime_tower":"1","enable_support":"0","enforce_support_layers":"0","eng_plate_temp":["0","0","0"],"eng_plate_temp_initial_layer":["0","0","0"],"ensure_vertical_shell_thickness":"1","exclude_object":"1","extruder_clearance_height_to_lid":"90","extruder_clearance_height_to_rod":"34","extruder_clearance_max_radius":"68","extruder_clearance_radius":"57","extruder_colour":["#018001"],"extruder_offset":["0x2"],"extruder_type":["DirectDrive"],"fan_cooling_layer_time":["100","100","100"],"fan_max_speed":["100","100","100"],"fan_min_speed":["100","100","100"],"filament_colour":["#00AE42","#FFFF00","#FF0000"],"filament_cost":["24.99","24.99","24.99"],"filament_density":["1.26","1.26","1.26"],"filament_deretraction_speed":["nil","nil","nil"],"filament_diameter":["1.75","1.75","1.75"],"filament_end_gcode":["","",""],"filament_flow_ratio":["0.98","0.98","0.98"],"filament_ids":["GFA00","GFA00","GFA00"],"filament_is_support":["0","0","0"],"filament_long_retractions_when_cut":["1","1","1"],"filament_max_volumetric_speed":["21","21","21"],"filament_minimal_purge_on_wipe_tower":["15","15","15"],"filament_notes":"","filament_retract_before_wipe":["nil","nil","nil"],"filament_retract_restart_extra":["nil","nil","nil"],"filament_retract_when_changing_layer":["nil","nil","nil"],"filament_retraction_distances_when_cut":["18","18","18"],"filament_retraction_length":["nil","nil","nil"],"filament_retraction_minimum_travel":["nil","nil","nil"],"filament_retraction_speed":["nil","nil","nil"],"filament_settings_id":["Bambu PLA Basic @BBL X1C","Bambu PLA Basic @BBL X1C","Bambu PLA Basic @BBL X1C"],"filament_soluble":["0","0","0"],"filament_start_gcode":["","",""],"filament_type":["PLA","PLA","PLA"],"filament_vendor":["Bambu Lab","Bambu Lab","Bambu Lab"],"filament_wipe":["nil","nil","nil"],"filament_wipe_distance":["nil","nil","nil"],"filament_z_hop":["nil","nil","nil"],"filament_z_hop_types":["nil","nil","nil"],"filename_format":"{input_filename_base}_{filament_type[0]}_{print_time}.gcode","filter_out_gap_fill":"0","first_layer_print_sequence":["0"],"flush_into_infill":"0","flush_into_objects":"0","flush_into_support":"1","flush_multiplier":"1","flush_volumes_matrix":["0","615","318","308","0","363","469","647","0"],"flush_volumes_vector":["140","140","140","140","140","140"],"from":"project","full_fan_speed_layer":["0","0","0"],"fuzzy_skin":"none","fuzzy_skin_point_distance":"0.8","fuzzy_skin_thickness":"0.3","gap_infill_speed":"300","gcode_add_line_number":"0","gcode_flavor":"marlin","has_scarf_joint_seam":"0","head_wrap_detect_zone":[],"host_type":"octoprint","hot_plate_temp":["55","55","55"],"hot_plate_temp_initial_layer":["55","55","55"],"independent_support_layer_height":"1","infill_combination":"0","infill_direction":"45","infill_jerk":"9","infill_wall_overlap":"15%","inherits_group":["","","","",""],"initial_layer_acceleration":"500","initial_layer_flow_ratio":"1","initial_layer_infill_speed":"105","initial_layer_jerk":"9","initial_layer_line_width":"0.5","initial_layer_print_height":"0.2","initial_layer_speed":"50","inner_wall_acceleration":"0","inner_wall_jerk":"9","inner_wall_line_width":"0.45","inner_wall_speed":"300","interface_shells":"0","internal_bridge_support_thickness":"0.8","internal_solid_infill_line_width":"0.42","internal_solid_infill_pattern":"zig-zag","internal_solid_infill_speed":"300","ironing_direction":"45","ironing_flow":"10%","ironing_pattern":"zig-zag","ironing_spacing":"0.15","ironing_speed":"30","ironing_type":"no ironing","is_infill_first":"0","layer_change_gcode":"","layer_height":"0.16","line_width":"0.42","long_retractions_when_cut":["0"],"machine_end_gcode":"","machine_load_filament_time":"29","machine_max_acceleration_e":["5000","5000"],"machine_max_acceleration_extruding":["20000","20000"],"machine_max_acceleration_retracting":["5000","5000"],"machine_max_acceleration_travel":["9000","9000"],"machine_max_acceleration_x":["20000","20000"],"machine_max_acceleration_y":["20000","20000"],"machine_max_acceleration_z":["500","200"],"machine_max_jerk_e":["2.5","2.5"],"machine_max_jerk_x":["9","9"],"machine_max_jerk_y":["9","9"],"machine_max_jerk_z":["3","3"],"machine_max_speed_e":["30","30"],"machine_max_speed_x":["500","200"],"machine_max_speed_y":["500","200"],"machine_max_speed_z":["20","20"],"machine_min_extruding_rate":["0","0"],"machine_min_travel_rate":["0","0"],"machine_pause_gcode":"","machine_start_gcode":"","machine_unload_filament_time":"28","max_bridge_length":"10","max_layer_height":["0.28"],"max_travel_detour_distance":"0","min_bead_width":"85%","min_feature_size":"25%","min_layer_height":["0.08"],"minimum_sparse_infill_area":"15","mmu_segmented_region_interlocking_depth":"0","mmu_segmented_region_max_width":"0","name":"project_settings","nozzle_diameter":["0.4"],"nozzle_height":"4.2","nozzle_temperature":["220","220","220"],"nozzle_temperature_initial_layer":["220","220","220"],"nozzle_temperature_range_high":["240","240","240"],"nozzle_temperature_range_low":["190","190","190"],"nozzle_type":"hardened_steel","nozzle_volume":"107","only_one_wall_first_layer":"0","ooze_prevention":"0","other_layers_print_sequence":["0"],"other_layers_print_sequence_nums":"0","outer_wall_acceleration":"5000","outer_wall_jerk":"9","outer_wall_line_width":"0.42","outer_wall_speed":"200","overhang_1_4_speed":"60","overhang_2_4_speed":"30","overhang_3_4_speed":"10","overhang_4_4_speed":"10","overhang_fan_speed":["100","100","100"],"overhang_fan_threshold":["50%","50%","50%"],"post_process":[],"precise_z_height":"0","pressure_advance":["0.02","0.02","0.02"],"prime_tower_brim_width":"3","prime_tower_width":"35","prime_volume":"45","print_compatible_printers":["Bambu Lab X1 Carbon 0.4 nozzle","Bambu Lab X1 0.4 nozzle","Bambu Lab P1S 0.4 nozzle","Bambu Lab X1E 0.4 nozzle"],"print_flow_ratio":"1","print_sequence":"by layer","print_settings_id":"0.16mm Optimal @BBL X1C","printable_area":["0x0","256x0","256x256","0x256"],"printable_height":"250","printer_model":"Bambu Lab X1 Carbon","printer_notes":"","printer_settings_id":"Bambu Lab X1 Carbon 0.4 nozzle","printer_structure":"corexy","printer_technology":"FFF","printer_variant":"0.4","printhost_authorization_type":"key","printhost_ssl_ignore_revoke":"0","printing_by_object_gcode":"","process_notes":"","raft_contact_distance":"0.1","raft_expansion":"1.5","raft_first_layer_density":"90%","raft_first_layer_expansion":"2","raft_layers":"0","reduce_crossing_wall":"0","reduce_fan_stop_start_freq":["1","1","1"],"reduce_infill_retraction":"1","required_nozzle_HRC":["3","3","3"],"resolution":"0.012","retract_before_wipe":["0%"],"retract_length_toolchange":["2"],"retract_lift_above":["0"],"retract_lift_below":["249"],"retract_restart_extra":["0"],"retract_restart_extra_toolchange":["0"],"retract_when_changing_layer":["1"],"retraction_distances_when_cut":["18"],"retraction_length":["0.8"],"retraction_minimum_travel":["1"],"retraction_speed":["30"],"scan_first_layer":"1","scarf_angle_threshold":"155","seam_gap":"15%","seam_position":"aligned","seam_slope_conditional":"1","seam_slope_entire_loop":"0","seam_slope_inner_walls":"1","seam_slope_min_length":"10","seam_slope_start_height":"50%","seam_slope_steps":"10","seam_slope_type":"none","silent_mode":"0","single_extruder_multi_material":"1","skirt_distance":"2","skirt_height":"1","skirt_loops":"0","slice_closing_radius":"0.049","slicing_mode":"regular","slow_down_for_layer_cooling":["1","1","1"],"slow_down_layer_time":["4","4","4"],"slow_down_min_speed":["20","20","20"],"small_perimeter_speed":"50%","small_perimeter_threshold":"0","solid_infill_filament":"1","sparse_infill_acceleration":"100%","sparse_infill_anchor":"400%","sparse_infill_anchor_max":"20","sparse_infill_density":"15%","sparse_infill_filament":"1","sparse_infill_line_width":"0.45","sparse_infill_pattern":"grid","sparse_infill_speed":"330","spiral_mode":"0","spiral_mode_max_xy_smoothing":"200%","spiral_mode_smooth":"0","standby_temperature_delta":"-5","start_end_points":["30x-3","54x245"],"support_air_filtration":"0","support_angle":"0","support_base_pattern":"default","support_base_pattern_spacing":"2.5","support_bottom_interface_spacing":"0.5","support_bottom_z_distance":"0.16","support_chamber_temp_control":"0","support_critical_regions_only":"0","support_expansion":"0","support_filament":"0","support_interface_bottom_layers":"2","support_interface_filament":"0","support_interface_loop_pattern":"0","support_interface_not_for_body":"1","support_interface_pattern":"auto","support_interface_spacing":"0.5","support_interface_speed":"80","support_interface_top_layers":"2","support_line_width":"0.42","support_object_first_layer_gap":"0.2","support_object_xy_distance":"0.35","support_on_build_plate_only":"0","support_remove_small_overhang":"1","support_speed":"150","support_style":"default","support_threshold_angle":"25","support_top_z_distance":"0.16","support_type":"normal(auto)","temperature_vitrification":["45","45","45"],"template_custom_gcode":"","textured_plate_temp":["55","55","55"],"textured_plate_temp_initial_layer":["55","55","55"],"thick_bridges":"0","thumbnail_size":["50x50"],"time_lapse_gcode":"","timelapse_type":"0","top_area_threshold":"100%","top_one_wall_type":"all top","top_shell_layers":"6","top_shell_thickness":"1","top_solid_infill_flow_ratio":"1","top_surface_acceleration":"2000","top_surface_jerk":"9","top_surface_line_width":"0.42","top_surface_pattern":"monotonicline","top_surface_speed":"200","travel_jerk":"9","travel_speed":"500","travel_speed_z":"0","tree_support_branch_angle":"45","tree_support_branch_diameter":"2","tree_support_branch_distance":"5","tree_support_brim_width":"0","tree_support_wall_count":"0","upward_compatible_machine":["Bambu Lab P1S 0.4 nozzle","Bambu Lab P1P 0.4 nozzle","Bambu Lab X1 0.4 nozzle","Bambu Lab X1E 0.4 nozzle","Bambu Lab A1 0.4 nozzle"],"use_firmware_retraction":"0","use_relative_e_distances":"1","version":"01.08.02.56","wall_distribution_count":"1","wall_filament":"1","wall_generator":"classic","wall_loops":"2","wall_sequence":"inner wall/outer wall","wall_transition_angle":"10","wall_transition_filter_deviation":"25%","wall_transition_length":"100%","wipe":["1"],"wipe_distance":["2"],"wipe_speed":"80%","wipe_tower_no_sparse_layers":"0","wipe_tower_rotation_angle":"0","wipe_tower_x":["15"],"wipe_tower_y":["221"],"xy_contour_compensation":"0","xy_hole_compensation":"0","z_hop":["0.4"],"z_hop_types":["Auto Lift"]}';
const BAMBU_ORCA_FILAMENT_SLOT_CODES = [
  '4',
  '8',
  '0C',
  '1C',
  '2C',
  '3C',
  '4C',
  '5C',
  '6C',
  '7C',
  '8C',
  '9C',
  'AC',
  'BC',
  'CC',
  'DC',
];
const VERTEX_KEY_PRECISION = 1e-6;
const DEGENERATE_TRIANGLE_AREA_SQUARED = 1e-20;
const SMALL_COLOR_ISLAND_TRIANGLE_COUNT = 24;
const SIMILAR_COLOR_ISLAND_DISTANCE_SQUARED = 0.03;
const TARGET_MATERIAL_ID_SILVER = 0;
const TARGET_MATERIAL_ID_BLACK = 1;
const TARGET_MATERIAL_ID_GREEN = 2;
const TARGET_MATERIAL_ID_YELLOW = 3;
const BAMBU_BUILD_PLATE_CENTER_MM = 125;
const THREE_MF_REPAIR_VERTEX_WELD_TOLERANCE_MM = 0.01;
const TEXTURE_TRIANGLE_SAMPLE_BARYCENTRICS: VectorTuple[] = [
  [1 / 3, 1 / 3, 1 / 3],
  [0.6, 0.2, 0.2],
  [0.2, 0.6, 0.2],
  [0.2, 0.2, 0.6],
  [0.8, 0.1, 0.1],
  [0.1, 0.8, 0.1],
  [0.1, 0.1, 0.8],
  [0.45, 0.45, 0.1],
  [0.45, 0.1, 0.45],
  [0.1, 0.45, 0.45],
];
const TEXTURE_DOMINANT_BUCKET_MIN_SHARE = 0.35;
const TEXTURE_DOMINANT_BUCKET_MIN_SAMPLES = 2;
const TEXTURE_SAMPLE_BUCKET_SCALE = 15;
const TEXTURE_DETAIL_SUBDIVISION_PIXEL_SPAN = 48;
const TEXTURE_DETAIL_MAX_SUBDIVISION_LEVEL = 4;
const MAX_BOUNDARY_FILL_LOOP_EDGES = 96;
const MAX_SMALL_BOUNDARY_FILL_LOOP_EDGES = 8;
const MAX_SMALL_PLANAR_BOUNDARY_FILL_SPAN_MM = 3;
const MANIFOLD_FILTER_MIN_TRIANGLES = 512;

type VectorTuple = [number, number, number];

type TexturedTrianglePatch = {
  vertices: [VectorTuple, VectorTuple, VectorTuple];
  uvs: [THREE.Vector2, THREE.Vector2, THREE.Vector2];
  barycentric: [VectorTuple, VectorTuple, VectorTuple];
};

export type ThreeMfTriangle = {
  v1: number;
  v2: number;
  v3: number;
  colorIndex: number;
};

export type ThreeMfSemanticMaterialClass = {
  id: number;
  name: string;
  color: string;
};

export type ThreeMfSemanticMaterialMap = {
  classes: ThreeMfSemanticMaterialClass[];
  triangleMaterialIds?: number[];
};

export type ThreeMfTargetMaterialPalette = string[];

export type ThreeMfModelInput = {
  modelName: string;
  vertices: VectorTuple[];
  triangles: ThreeMfTriangle[];
  palette: string[];
};

type ColorSample = {
  color: THREE.Color;
  weight: number;
};

type TexturePixels = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

type SceneGeometry = {
  vertices: VectorTuple[];
  triangles: Array<
    Omit<ThreeMfTriangle, 'colorIndex'> & {
      color: THREE.Color;
      semanticMaterialId?: number;
    }
  >;
};

type RepairedSceneGeometry = {
  vertices: VectorTuple[];
  triangles: Array<Omit<ThreeMfTriangle, 'colorIndex'>>;
};

type IndexedTriangle = Pick<ThreeMfTriangle, 'v1' | 'v2' | 'v3'>;

type IndexedTriangleGeometry<
  TTriangle extends IndexedTriangle = IndexedTriangle,
> = {
  vertices: VectorTuple[];
  triangles: TTriangle[];
};

type ThreeMfPackageParts = {
  contentTypesXml: string;
  relationshipsXml: string;
  modelRelationshipsXml: string;
  rootModelXml: string;
  objectModelXml: string;
  modelSettingsConfig: string;
  sliceInfoConfig: string;
  projectSettingsConfig: string;
};

export type ThreeMfMeshTopology = {
  vertexCount: number;
  weldedVertexCount: number;
  triangleCount: number;
  invalidVertexReferenceCount: number;
  degenerateTriangleCount: number;
  uniqueEdges: number;
  edgeUseHistogram: Record<number, number>;
  boundaryEdges: number;
  overSharedEdges: number;
  materialTransitionEdges: number;
};

type ZipTextEntry = {
  getData?: (writer: TextWriter) => Promise<string>;
};

const texturePixelCache = new WeakMap<THREE.Texture, TexturePixels | null>();

export function clampThreeMfColorCount(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_THREE_MF_COLOR_COUNT;
  }

  return Math.min(MAX_THREE_MF_COLOR_COUNT, Math.max(1, Math.round(value)));
}

export type ThreeMfColorDetailSettings = {
  smoothingIterations: number;
  smallColorIslandTriangleCount: number;
  similarColorIslandDistanceSquared: number;
  /** Subdivide textured triangles for color detail even without a target palette. */
  forceTextureDetail: boolean;
  textureDetailSubdivisionPixelSpan: number;
  textureDetailMaxSubdivisionLevel: number;
};

export function clampThreeMfColorDetail(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_THREE_MF_COLOR_DETAIL;
  }

  return Math.min(100, Math.max(0, Math.round(value)));
}

export function getThreeMfColorDetailSettings(
  colorDetail: number,
): ThreeMfColorDetailSettings {
  const detail = clampThreeMfColorDetail(colorDetail);
  // Piecewise-linear between the roughest setting (0), the historical fixed
  // behavior (50) and the most detailed setting (100), so the default slider
  // position reproduces existing exports bit-for-bit.
  const blend = (rough: number, base: number, fine: number): number =>
    detail <= 50
      ? rough + ((base - rough) * detail) / 50
      : base + ((fine - base) * (detail - 50)) / 50;

  return {
    smoothingIterations: Math.round(blend(5, 3, 0)),
    smallColorIslandTriangleCount: Math.round(
      blend(120, SMALL_COLOR_ISLAND_TRIANGLE_COUNT, 0),
    ),
    similarColorIslandDistanceSquared: blend(
      0.2,
      SIMILAR_COLOR_ISLAND_DISTANCE_SQUARED,
      0,
    ),
    forceTextureDetail: detail > 50,
    textureDetailSubdivisionPixelSpan: Math.round(
      blend(
        TEXTURE_DETAIL_SUBDIVISION_PIXEL_SPAN,
        TEXTURE_DETAIL_SUBDIVISION_PIXEL_SPAN,
        20,
      ),
    ),
    textureDetailMaxSubdivisionLevel: Math.round(
      blend(
        TEXTURE_DETAIL_MAX_SUBDIVISION_LEVEL,
        TEXTURE_DETAIL_MAX_SUBDIVISION_LEVEL,
        5,
      ),
    ),
  };
}

export function buildThreeMfContentTypesXml(): string {
  return xmlDeclaration(`\
<Types xmlns="${CONTENT_TYPES_NAMESPACE}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="application/octet-stream"/>
</Types>`);
}

export function buildThreeMfRelationshipsXml(): string {
  return xmlDeclaration(`\
<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">
  <Relationship Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/>
</Relationships>`);
}

export function buildThreeMfModelRelationshipsXml(): string {
  return xmlDeclaration(`\
<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">
  <Relationship Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="${BAMBU_OBJECT_MODEL_REL_TARGET}"/>
</Relationships>`);
}

export function buildThreeMfModelXml({
  modelName,
  vertices,
  triangles,
  palette,
}: ThreeMfModelInput): string {
  const normalizedPalette = normalizePalette(palette);
  const baseMaterials = normalizedPalette
    .map((color, index) => {
      const filamentNumber = index + 1;
      return `      <base name="Generic PLA ${filamentNumber} (${color})" displaycolor="${color}FF"/>`;
    })
    .join('\n');
  const colors = normalizedPalette
    .map((color) => `      <m:color color="${color}FF"/>`)
    .join('\n');
  const vertexXml = vertices
    .map(
      ([x, y, z]) =>
        `        <vertex x="${formatNumber(x)}" y="${formatNumber(y)}" z="${formatNumber(z)}"/>`,
    )
    .join('\n');
  const triangleXml = triangles
    .map((triangle) => {
      const colorIndex = clampIndex(
        triangle.colorIndex,
        normalizedPalette.length,
      );
      const paintColor = getBambuOrcaPaintColor(colorIndex);
      return `        <triangle v1="${triangle.v1}" v2="${triangle.v2}" v3="${triangle.v3}" pid="1" p1="${colorIndex}" p2="${colorIndex}" p3="${colorIndex}" paint_color="${paintColor}"/>`;
    })
    .join('\n');

  return xmlDeclaration(`\
<model unit="millimeter" xml:lang="en-US" requiredextensions="m" xmlns="${CORE_NAMESPACE}" xmlns:m="${MATERIAL_NAMESPACE}">
  <metadata name="Title">${escapeXml(modelName)}</metadata>
  <metadata name="Designer">AzureFilm Generator</metadata>
  <resources>
    <basematerials id="1">
${baseMaterials}
    </basematerials>
    <m:colorgroup id="2">
${colors}
    </m:colorgroup>
    <object id="1" type="model" pid="1" pindex="0">
      <mesh>
        <vertices>
${vertexXml}
        </vertices>
        <triangles>
${triangleXml}
        </triangles>
      </mesh>
    </object>
  </resources>
</model>`);
}

export function buildThreeMfRootModelXml(
  modelName: string,
  version: string = BAMBU_STUDIO_VERSION,
): string {
  return xmlDeclaration(`\
<model unit="millimeter" xml:lang="en-US" requiredextensions="p" xmlns="${CORE_NAMESPACE}" xmlns:slic3rpe="${SLIC3R_NAMESPACE}" xmlns:p="${PRODUCTION_NAMESPACE}">
  <metadata name="Application">${buildBambuStudioApplication(version)}</metadata>
  <metadata name="BambuStudio:3mfVersion">1</metadata>
  <metadata name="Title">${escapeXml(modelName)}</metadata>
  <metadata name="Designer">AzureFilm Generator</metadata>
  <resources>
    <object id="2" p:UUID="00000001-61cb-4c03-9d28-80fed5dfa1dc" type="model">
      <components>
        <component p:path="${BAMBU_OBJECT_MODEL_REL_TARGET}" objectid="1" p:UUID="00010000-b206-40ff-9872-83e8017abed1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
      </components>
    </object>
  </resources>
  <build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369">
    <item objectid="2" p:UUID="00000002-b1ec-4553-aec9-835e5b724bb4" transform="1 0 0 0 1 0 0 0 1 ${BAMBU_BUILD_PLATE_CENTER_MM} ${BAMBU_BUILD_PLATE_CENTER_MM} 0" printable="1"/>
  </build>
</model>`);
}

export function buildThreeMfModelSettingsConfig(modelName: string): string {
  return xmlDeclaration(`\
<config>
  <object id="2">
    <metadata key="name" value="${escapeXml(modelName)}"/>
    <metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="${escapeXml(modelName)}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="source_file" value="${escapeXml(modelName)}.3mf"/>
      <metadata key="source_object_id" value="0"/>
      <metadata key="source_volume_id" value="0"/>
      <metadata key="source_offset_x" value="0"/>
      <metadata key="source_offset_y" value="0"/>
      <metadata key="source_offset_z" value="0"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <model_instance>
      <metadata key="object_id" value="2"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="8"/>
    </model_instance>
  </plate>
  <assemble>
  </assemble>
</config>`);
}

export function buildThreeMfSliceInfoConfig(
  version: string = BAMBU_STUDIO_VERSION,
): string {
  return xmlDeclaration(`\
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="${version}"/>
  </header>
</config>`);
}

export function buildThreeMfProjectSettingsConfig(
  palette: string[],
  {
    version = BAMBU_STUDIO_VERSION,
    mixedSlots,
  }: { version?: string; mixedSlots?: MixedFilamentSlotInfo[] } = {},
): string {
  const normalizedPalette = normalizePalette(palette);
  const settings = buildBambuProjectSettings(normalizedPalette, {
    version,
    mixedSlots,
  });

  return JSON.stringify(settings, null, 2);
}

function buildBambuProjectSettings(
  normalizedPalette: string[],
  {
    version = BAMBU_STUDIO_VERSION,
    mixedSlots,
  }: { version?: string; mixedSlots?: MixedFilamentSlotInfo[] } = {},
): Record<string, unknown> {
  const settings = JSON.parse(BAMBU_PROJECT_SETTINGS_TEMPLATE_JSON) as Record<
    string,
    unknown
  >;
  const repeat = (value: string) => normalizedPalette.map(() => value);

  for (const [key, value] of Object.entries(settings)) {
    if (
      Array.isArray(value) &&
      value.length === BAMBU_PROJECT_SETTINGS_TEMPLATE_FILAMENT_COUNT
    ) {
      settings[key] = repeat(String(value[0] ?? ''));
    }
  }

  Object.assign(settings, {
    name: 'project_settings',
    from: 'project',
    version,
    filament_colour: normalizedPalette,
    // Bambu uses filament_colour for the active project colors; native project
    // files leave default_filament_colour empty so the loaded colors are not
    // replaced by preset defaults.
    default_filament_colour: repeat(''),
    filament_type: repeat('PLA'),
    filament_settings_id: repeat('Bambu PLA Basic @BBL P1P'),
    filament_vendor: repeat('Bambu Lab'),
    filament_ids: repeat('GFA00'),
    printer_model: 'Bambu Lab P1P',
    printer_settings_id: 'Bambu Lab P1P 0.4 nozzle',
    print_settings_id: '0.20mm Standard @BBL P1P',
    default_print_profile: '0.20mm Standard @BBL P1P',
    print_compatible_printers: ['Bambu Lab P1P 0.4 nozzle'],
    upward_compatible_machine: ['Bambu Lab P1P 0.4 nozzle'],
    flush_volumes_matrix: buildFlushVolumesMatrix(normalizedPalette.length),
    flush_volumes_vector: repeatFlushVolumeVector(normalizedPalette.length),
    single_extruder_multi_material: '1',
    // These are sized [print, one per filament slot, printer] — the template
    // ships 5 entries for its 3-filament preset, so they must be re-sized to the
    // real slot count. Both stay all-empty here; the mixed-filament branch fills
    // the process (first) entry to opt its overrides in.
    inherits_group: buildDifferentSettingsToSystem(
      normalizedPalette.length,
      [],
    ),
    different_settings_to_system: buildDifferentSettingsToSystem(
      normalizedPalette.length,
      [],
    ),
  });

  if (mixedSlots) {
    Object.assign(
      settings,
      buildMixedFilamentProjectSettings(normalizedPalette, mixedSlots),
    );
  }

  return settings;
}

// Per-slot mixed-filament project settings. Physical slots (loaded spools)
// carry empty mixed fields; mixed slots blend a few physical slots layer by
// layer to reproduce a color the loaded spools cannot print directly. The
// keys/formats mirror Bambu Studio's PrintConfig.cpp mixed-filament options.
function buildMixedFilamentProjectSettings(
  slotColors: string[],
  mixedSlots: MixedFilamentSlotInfo[],
): Record<string, unknown> {
  const slotCount = slotColors.length;
  const at = (index: number): MixedFilamentSlotInfo =>
    mixedSlots[index] ?? { isMixed: false, components: [], ratios: [] };
  const repeatSlots = (value: string) =>
    Array.from({ length: slotCount }, () => value);

  return {
    // "1" = default color (not gradient) for every slot.
    filament_colour_type: repeatSlots('1'),
    // Normal slots repeat their own hex; mixed slots repeat the achieved hex.
    filament_multi_colour: [...slotColors],
    filament_is_mixed: slotColors.map((_, index) =>
      at(index).isMixed ? '1' : '0',
    ),
    filament_mixed_components: slotColors.map((_, index) =>
      at(index).components.join(','),
    ),
    filament_mixed_sublayer_ratios: slotColors.map((_, index) =>
      formatSublayerRatios(at(index).ratios),
    ),
    // Gradient blending is left off; the fields still need one entry per slot.
    filament_mixed_gradient: repeatSlots('0'),
    filament_mixed_gradient_range: repeatSlots(''),
    filament_mixed_gradient_curve: repeatSlots(''),
    filament_mixed_gradient_per_part: repeatSlots('0'),
    // Bambu serializes every scalar as a string; a numeric entry here makes its
    // JSON loader reject the array and silently stop parsing every key that
    // sorts after "filament_map", so this MUST stay a string array.
    filament_map: repeatSlots('1'),
    // Process-level flag that turns on sublayer splitting for the mixed slots.
    enable_mixed_color_sublayer: '1',
    // Studio only honors project process overrides that are listed here, so the
    // sublayer flag must be declared as a diff from the system process preset or
    // its checkbox arrives unchecked.
    different_settings_to_system: buildDifferentSettingsToSystem(slotCount, [
      'enable_mixed_color_sublayer',
    ]),
  };
}

// Format a mixed slot's per-component layer ratios as 2-decimal strings that
// sum to exactly 1.0 — the last component absorbs the rounding residue.
function formatSublayerRatios(ratios: number[]): string {
  if (ratios.length === 0) {
    return '';
  }
  if (ratios.length === 1) {
    return '1.00';
  }

  const roundedHead = ratios
    .slice(0, -1)
    .map((ratio) => Math.round(ratio * 100) / 100);
  const headSum = roundedHead.reduce((sum, ratio) => sum + ratio, 0);
  const last = Math.round((1 - headSum) * 100) / 100;
  return [...roundedHead, last].map((ratio) => ratio.toFixed(2)).join(',');
}

function buildFlushVolumesMatrix(filamentCount: number): string[] {
  const matrix: string[] = [];
  for (let row = 0; row < filamentCount; row += 1) {
    for (let column = 0; column < filamentCount; column += 1) {
      matrix.push(row === column ? '0' : '140');
    }
  }
  return matrix;
}

function repeatFlushVolumeVector(filamentCount: number): string[] {
  return Array.from({ length: filamentCount * 2 }, () => '140');
}

// Bambu's per-preset override lists are [process, one per filament slot,
// printer]; Studio only applies the listed process overrides on top of the
// selected system process preset. Process diffs go in the first entry as a
// semicolon-separated list; filament and printer entries stay empty.
function buildDifferentSettingsToSystem(
  filamentCount: number,
  processDiffs: string[],
): string[] {
  const entries = Array.from({ length: filamentCount + 2 }, () => '');
  entries[0] = processDiffs.join(';');
  return entries;
}

export type ThreeMfColoredMesh = {
  /**
   * Vertices in three.js (y-up) world coordinates. The 3MF z-up axis
   * conversion happens when the mesh is packaged into a blob, so this same
   * data can drive an on-screen preview directly.
   */
  vertices: VectorTuple[];
  triangles: ThreeMfTriangle[];
  palette: string[];
};

/**
 * Full-spectrum export plan: the loaded physical filaments plus, for each
 * detected palette color (in palette order), the layer recipe that reproduces
 * it. Structurally compatible with fullSpectrumMixing's FullSpectrumPlan so the
 * dialog can hand its computed plan straight through without this module having
 * to depend on the mixing advisor.
 */
export type ThreeMfMixedFilamentPlan = {
  presetFilaments: { name?: string; hex: string }[];
  recipes: Array<{
    achievedHex: string;
    /** Zero-based indexes into presetFilaments, one entry per printed layer. */
    layerFilamentIndexes: number[];
  }>;
};

// One project-settings slot: a physical loaded spool (isMixed false) or a
// mixed slot built by alternating physical spools layer by layer.
type MixedFilamentSlotInfo = {
  isMixed: boolean;
  /** 1-based physical slot indices this mixed slot blends (empty if physical). */
  components: number[];
  /** Layer-count fraction per component, aligned to components (empty if physical). */
  ratios: number[];
};

type MixedFilamentSlotPlan = {
  /** Slot colors in slot order: physical filaments first, then mixed slots. */
  slotColors: string[];
  /** Maps each detected palette index to the slot index it prints on. */
  paletteToSlot: number[];
  /** Per-slot mixed metadata, aligned to slotColors. */
  mixedSlots: MixedFilamentSlotInfo[];
};

// Expand a detected palette into printer slots for a full-spectrum export.
// Physical slots 1..P are the preset filaments; a palette color whose recipe
// uses a single filament prints directly on that physical slot, otherwise it
// gets its own mixed slot. Total slots are capped at the 16-slot code table;
// a color that would overflow falls back to its recipe's dominant filament.
function buildMixedFilamentSlotPlan(
  palette: string[],
  plan: ThreeMfMixedFilamentPlan,
): MixedFilamentSlotPlan {
  const physicalCount = Math.max(1, plan.presetFilaments.length);
  const slotColors = plan.presetFilaments.map((filament) =>
    normalizeHexColor(filament.hex),
  );
  const mixedSlots: MixedFilamentSlotInfo[] = slotColors.map(() => ({
    isMixed: false,
    components: [],
    ratios: [],
  }));
  const paletteToSlot: number[] = [];

  palette.forEach((paletteHex, paletteIndex) => {
    const recipe = plan.recipes[paletteIndex];
    const layerIndexes =
      recipe && recipe.layerFilamentIndexes.length > 0
        ? recipe.layerFilamentIndexes.map((index) =>
            clampIndex(index, physicalCount),
          )
        : [0];

    const uniquePhysical: number[] = [];
    for (const layerIndex of layerIndexes) {
      if (!uniquePhysical.includes(layerIndex)) {
        uniquePhysical.push(layerIndex);
      }
    }

    // Single filament: print straight on its physical slot, no mixed slot.
    if (uniquePhysical.length <= 1) {
      paletteToSlot.push(uniquePhysical[0] ?? 0);
      return;
    }

    // Cap total slots at the 16-entry paint-code table; overflow colors fall
    // back to the physical slot they use most so the package stays valid.
    if (slotColors.length >= MAX_THREE_MF_COLOR_COUNT) {
      paletteToSlot.push(getDominantLayerFilamentIndex(layerIndexes));
      return;
    }

    const layerCounts = new Map<number, number>();
    for (const layerIndex of layerIndexes) {
      layerCounts.set(layerIndex, (layerCounts.get(layerIndex) ?? 0) + 1);
    }
    const components = uniquePhysical.map((index) => index + 1);
    const ratios = uniquePhysical.map(
      (index) => (layerCounts.get(index) ?? 0) / layerIndexes.length,
    );

    paletteToSlot.push(slotColors.length);
    slotColors.push(normalizeHexColor(recipe?.achievedHex ?? paletteHex));
    mixedSlots.push({ isMixed: true, components, ratios });
  });

  return { slotColors, paletteToSlot, mixedSlots };
}

function getDominantLayerFilamentIndex(layerIndexes: number[]): number {
  const counts = new Map<number, number>();
  for (const index of layerIndexes) {
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  let dominant = layerIndexes[0] ?? 0;
  let dominantCount = -1;
  for (const [index, count] of counts) {
    if (count > dominantCount) {
      dominant = index;
      dominantCount = count;
    }
  }
  return dominant;
}

function normalizeHexColor(hex: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  return match ? `#${match[1].toUpperCase()}` : '#CCCCCC';
}

export async function computeThreeMfColoredMesh({
  scene,
  colorCount,
  colorDetail = DEFAULT_THREE_MF_COLOR_DETAIL,
  semanticMaterialMap,
  targetMaterialPalette,
}: {
  scene: THREE.Scene;
  colorCount: number;
  colorDetail?: number;
  semanticMaterialMap?: ThreeMfSemanticMaterialMap | null;
  targetMaterialPalette?: ThreeMfTargetMaterialPalette | null;
}): Promise<ThreeMfColoredMesh> {
  const targetColorCount = clampThreeMfColorCount(colorCount);
  const detailSettings = getThreeMfColorDetailSettings(colorDetail);
  const sourceGeometry = applySemanticMaterialMap(
    extractSceneGeometry(scene, {
      preserveTextureDetail:
        Boolean(targetMaterialPalette) || detailSettings.forceTextureDetail,
      textureDetailSubdivisionPixelSpan:
        detailSettings.textureDetailSubdivisionPixelSpan,
      textureDetailMaxSubdivisionLevel:
        detailSettings.textureDetailMaxSubdivisionLevel,
    }),
    semanticMaterialMap,
  );
  // Run the printable repair pass before palette quantization and 3MF color ids.
  const repairedGeometry =
    await repairSceneGeometryForThreeMfExport(sourceGeometry);

  if (
    repairedGeometry.vertices.length === 0 ||
    repairedGeometry.triangles.length === 0
  ) {
    throw new Error('No printable mesh geometry was found for 3MF export.');
  }

  // Fuse any disconnected bodies (floating parts) into a single printable solid.
  // Geometry here is welded and mm-scale, so the connector's mm thresholds and
  // strut sizing apply directly. Strut triangles carry no source color; they
  // inherit the nearest existing triangle's color in assignColorsToRepairedTriangles.
  const geometry = connectMeshComponents(
    repairedGeometry,
    (triangle) => triangle,
  );

  const coloredTriangles = assignColorsToRepairedTriangles(
    geometry,
    sourceGeometry,
  );
  const semanticAssignments = buildSemanticMaterialAssignments(
    coloredTriangles,
    semanticMaterialMap,
  );
  const targetPaletteAssignments = semanticAssignments
    ? null
    : buildTargetMaterialPaletteAssignments(
        coloredTriangles,
        targetMaterialPalette,
        targetColorCount,
      );
  const hasAuthoritativeSemanticMaterialIds = coloredTriangles.some(
    (triangle) => triangle.semanticMaterialId !== undefined,
  );
  const palette =
    semanticAssignments?.palette ??
    targetPaletteAssignments?.palette ??
    quantizeTriangleColors(
      coloredTriangles.map((triangle) => ({
        color: triangle.color,
        weight: getTriangleArea(geometry.vertices, triangle),
      })),
      targetColorCount,
    );

  const indexedTriangles = coloredTriangles.map((triangle, index) => ({
    v1: triangle.v1,
    v2: triangle.v2,
    v3: triangle.v3,
    colorIndex:
      semanticAssignments?.colorIndexes[index] ??
      targetPaletteAssignments?.colorIndexes[index] ??
      findNearestPaletteIndex(triangle.color, palette),
  }));
  let recoveredTriangles = indexedTriangles;
  const shouldRecoverTargetPaletteRegions =
    targetPaletteAssignments &&
    !semanticAssignments &&
    !hasAuthoritativeSemanticMaterialIds;
  if (shouldRecoverTargetPaletteRegions) {
    recoveredTriangles = recoverBadgeTargetMaterialRegions(
      recoveredTriangles,
      geometry.vertices,
      palette,
    );
  }
  // Semantic/authoritative color ids are trusted as-is at the default
  // sensitivity so those exports stay byte-identical. Below the midpoint the
  // slider still merges small color islands (above it, texture subdivision in
  // extractSceneGeometry already adds detail), so the control does something
  // for generated models instead of being inert.
  const hasSemanticColorIndexes =
    Boolean(semanticAssignments) || hasAuthoritativeSemanticMaterialIds;
  const smoothSemanticIslands =
    hasSemanticColorIndexes &&
    clampThreeMfColorDetail(colorDetail) < DEFAULT_THREE_MF_COLOR_DETAIL;
  let outputTriangles =
    hasSemanticColorIndexes && !smoothSemanticIslands
      ? recoveredTriangles
      : smoothTriangleColorIndexes(recoveredTriangles, palette, detailSettings);
  if (shouldRecoverTargetPaletteRegions) {
    outputTriangles = recoverRaisedBadgeLetterRegions(
      outputTriangles,
      geometry.vertices,
      palette,
    );
  }
  const { palette: usedPalette, triangles } = removeUnusedPaletteEntries(
    palette,
    outputTriangles,
  );

  return {
    vertices: geometry.vertices,
    triangles,
    palette: usedPalette.map(colorToHex),
  };
}

/**
 * Build a colored mesh from geometry that ALREADY carries a color per triangle.
 *
 * Same palette pipeline as `computeThreeMfColoredMesh` (quantize → nearest slot
 * → small-island smoothing → drop unused slots) but without scene extraction,
 * printable repair, or `connectMeshComponents`. Callers whose geometry must keep
 * its disconnected bodies — the Flexi Toy result, whose segments would be welded
 * solid by the connector — use this instead of the scene path.
 */
export function buildThreeMfColoredMeshFromTriangleColors({
  vertices,
  triangles,
  colorCount,
  colorDetail = DEFAULT_THREE_MF_COLOR_DETAIL,
}: {
  vertices: VectorTuple[];
  triangles: Array<
    Omit<ThreeMfTriangle, 'colorIndex'> & { color: THREE.Color }
  >;
  colorCount: number;
  colorDetail?: number;
}): ThreeMfColoredMesh {
  const detailSettings = getThreeMfColorDetailSettings(colorDetail);
  const palette = quantizeTriangleColors(
    triangles.map((triangle) => ({
      color: triangle.color,
      weight: getTriangleArea(vertices, triangle),
    })),
    clampThreeMfColorCount(colorCount),
  );

  const indexedTriangles = triangles.map((triangle) => ({
    v1: triangle.v1,
    v2: triangle.v2,
    v3: triangle.v3,
    colorIndex: findNearestPaletteIndex(triangle.color, palette),
  }));
  const smoothedTriangles = smoothTriangleColorIndexes(
    indexedTriangles,
    palette,
    detailSettings,
  );
  const { palette: usedPalette, triangles: outputTriangles } =
    removeUnusedPaletteEntries(palette, smoothedTriangles);

  return {
    vertices,
    triangles: outputTriangles,
    palette: usedPalette.map(colorToHex),
  };
}

export async function createThreeMfBlobFromColoredMesh({
  coloredMesh,
  filename,
  fullSpectrum,
}: {
  coloredMesh: ThreeMfColoredMesh;
  filename: string;
  fullSpectrum?: ThreeMfMixedFilamentPlan | null;
}): Promise<Blob> {
  // Full-spectrum exports expand the detected palette into physical + mixed
  // printer slots and advertise a Studio version that understands them; classic
  // exports keep the old palette-as-slots layout and the old version verbatim.
  const useFullSpectrum = Boolean(
    fullSpectrum && fullSpectrum.presetFilaments.length > 0,
  );
  const slotPlan =
    useFullSpectrum && fullSpectrum
      ? buildMixedFilamentSlotPlan(coloredMesh.palette, fullSpectrum)
      : null;
  const version = useFullSpectrum
    ? BAMBU_STUDIO_MIXED_FILAMENT_VERSION
    : BAMBU_STUDIO_VERSION;
  const objectPalette = slotPlan ? slotPlan.slotColors : coloredMesh.palette;
  const objectTriangles = slotPlan
    ? coloredMesh.triangles.map((triangle) => ({
        ...triangle,
        colorIndex: slotPlan.paletteToSlot[triangle.colorIndex] ?? 0,
      }))
    : coloredMesh.triangles;

  const objectModelXml = buildThreeMfModelXml({
    modelName: filename,
    vertices: convertThreeJsVerticesToThreeMfVertices(coloredMesh.vertices),
    triangles: objectTriangles,
    palette: objectPalette,
  });

  const packageParts = {
    contentTypesXml: buildThreeMfContentTypesXml(),
    relationshipsXml: buildThreeMfRelationshipsXml(),
    modelRelationshipsXml: buildThreeMfModelRelationshipsXml(),
    rootModelXml: buildThreeMfRootModelXml(filename, version),
    objectModelXml,
    modelSettingsConfig: buildThreeMfModelSettingsConfig(filename),
    sliceInfoConfig: buildThreeMfSliceInfoConfig(version),
    projectSettingsConfig: buildThreeMfProjectSettingsConfig(objectPalette, {
      version,
      mixedSlots: slotPlan?.mixedSlots,
    }),
  };
  validateThreeMfPackageParts(packageParts);

  const blob = await createThreeMfPackage(packageParts);
  await validateThreeMfBlob(blob);
  return blob;
}

export async function createThreeMfBlobFromScene({
  scene,
  filename,
  colorCount,
  colorDetail = DEFAULT_THREE_MF_COLOR_DETAIL,
  semanticMaterialMap,
  targetMaterialPalette,
}: {
  scene: THREE.Scene;
  filename: string;
  colorCount: number;
  colorDetail?: number;
  semanticMaterialMap?: ThreeMfSemanticMaterialMap | null;
  targetMaterialPalette?: ThreeMfTargetMaterialPalette | null;
}): Promise<Blob> {
  const coloredMesh = await computeThreeMfColoredMesh({
    scene,
    colorCount,
    colorDetail,
    semanticMaterialMap,
    targetMaterialPalette,
  });

  return createThreeMfBlobFromColoredMesh({ coloredMesh, filename });
}

function convertThreeJsVerticesToThreeMfVertices(
  vertices: VectorTuple[],
): VectorTuple[] {
  return vertices.map(([x, y, z]) => [x, -z, y]);
}

async function createThreeMfPackage({
  contentTypesXml,
  relationshipsXml,
  modelRelationshipsXml,
  rootModelXml,
  objectModelXml,
  modelSettingsConfig,
  sliceInfoConfig,
  projectSettingsConfig,
}: ThreeMfPackageParts): Promise<Blob> {
  const zipWriter = new ZipWriter(new BlobWriter('model/3mf'));
  await zipWriter.add('[Content_Types].xml', new TextReader(contentTypesXml));
  await zipWriter.add('_rels/.rels', new TextReader(relationshipsXml));
  await zipWriter.add(
    '3D/_rels/3dmodel.model.rels',
    new TextReader(modelRelationshipsXml),
  );
  await zipWriter.add('3D/3dmodel.model', new TextReader(rootModelXml));
  await zipWriter.add(BAMBU_OBJECT_MODEL_PATH, new TextReader(objectModelXml));
  await zipWriter.add(
    'Metadata/model_settings.config',
    new TextReader(modelSettingsConfig),
  );
  await zipWriter.add(
    'Metadata/slice_info.config',
    new TextReader(sliceInfoConfig),
  );
  await zipWriter.add(
    'Metadata/project_settings.config',
    new TextReader(projectSettingsConfig),
  );
  return zipWriter.close();
}

export async function validateThreeMfBlob(blob: Blob): Promise<void> {
  const zipReader = new ZipReader(new BlobReader(blob));

  try {
    const entries = await zipReader.getEntries();
    const entriesByName = new Map<string, ZipTextEntry>(
      entries.map((entry) => [entry.filename, entry as ZipTextEntry]),
    );

    const objectModelFilename = entriesByName.has(BAMBU_OBJECT_MODEL_PATH)
      ? BAMBU_OBJECT_MODEL_PATH
      : '3D/3dmodel.model';

    for (const filename of [
      '[Content_Types].xml',
      '_rels/.rels',
      '3D/3dmodel.model',
      'Metadata/project_settings.config',
    ]) {
      if (!entriesByName.has(filename)) {
        throw new Error(`3MF package is missing ${filename}`);
      }
    }

    const contentTypesXml = await readRequiredZipText(
      entriesByName,
      '[Content_Types].xml',
    );
    const relationshipsXml = await readRequiredZipText(
      entriesByName,
      '_rels/.rels',
    );
    const modelXml = await readRequiredZipText(
      entriesByName,
      '3D/3dmodel.model',
    );
    const objectModelXml =
      objectModelFilename === '3D/3dmodel.model'
        ? modelXml
        : await readRequiredZipText(entriesByName, objectModelFilename);
    const projectSettingsConfig = await readRequiredZipText(
      entriesByName,
      'Metadata/project_settings.config',
    );

    validateThreeMfPackageParts({
      contentTypesXml,
      relationshipsXml,
      modelRelationshipsXml: entriesByName.has('3D/_rels/3dmodel.model.rels')
        ? await readRequiredZipText(
            entriesByName,
            '3D/_rels/3dmodel.model.rels',
          )
        : '',
      rootModelXml: modelXml,
      objectModelXml,
      modelSettingsConfig: entriesByName.has('Metadata/model_settings.config')
        ? await readRequiredZipText(
            entriesByName,
            'Metadata/model_settings.config',
          )
        : '',
      sliceInfoConfig: entriesByName.has('Metadata/slice_info.config')
        ? await readRequiredZipText(entriesByName, 'Metadata/slice_info.config')
        : '',
      projectSettingsConfig,
    });
  } finally {
    await zipReader.close();
  }
}

export function analyzeThreeMfMeshTopology(
  modelXml: string,
  options: { weldTolerance?: number } = {},
): ThreeMfMeshTopology {
  const vertices: VectorTuple[] = [];
  for (const match of modelXml.matchAll(/<vertex\b([^>]*)\/>/g)) {
    const attributes = parseXmlAttributes(match[1]);
    vertices.push([
      Number.parseFloat(attributes.get('x') ?? '0'),
      Number.parseFloat(attributes.get('y') ?? '0'),
      Number.parseFloat(attributes.get('z') ?? '0'),
    ]);
  }

  const remappedVertices = remapTopologyVertices(
    vertices,
    options.weldTolerance,
  );
  const triangles: Array<{
    vertices: [number, number, number];
    materialIndex: number | null;
  }> = [];
  let invalidVertexReferenceCount = 0;
  let degenerateTriangleCount = 0;

  for (const match of modelXml.matchAll(/<triangle\b([^>]*)\/>/g)) {
    const attributes = parseXmlAttributes(match[1]);
    const rawVertexIndexes = ['v1', 'v2', 'v3'].map((name) =>
      Number.parseInt(attributes.get(name) ?? '', 10),
    );

    if (
      rawVertexIndexes.some(
        (index) =>
          !Number.isInteger(index) || index < 0 || index >= vertices.length,
      )
    ) {
      invalidVertexReferenceCount += 1;
      continue;
    }

    const vertexIndexes = rawVertexIndexes.map(
      (index) => remappedVertices.vertexIndexes[index],
    ) as [number, number, number];
    if (new Set(vertexIndexes).size !== 3) {
      degenerateTriangleCount += 1;
    }

    triangles.push({
      vertices: vertexIndexes,
      materialIndex: Number.isInteger(
        Number.parseInt(attributes.get('p1') ?? '', 10),
      )
        ? Number.parseInt(attributes.get('p1') ?? '', 10)
        : null,
    });
  }

  const edgeUseCounts = new Map<string, number>();
  const edgeMaterialIndexes = new Map<string, Set<number>>();
  for (const triangle of triangles) {
    if (new Set(triangle.vertices).size !== 3) {
      continue;
    }

    for (const [a, b] of [
      [triangle.vertices[0], triangle.vertices[1]],
      [triangle.vertices[1], triangle.vertices[2]],
      [triangle.vertices[2], triangle.vertices[0]],
    ]) {
      const edgeKey = getEdgeKey(a, b);
      edgeUseCounts.set(edgeKey, (edgeUseCounts.get(edgeKey) ?? 0) + 1);
      if (triangle.materialIndex !== null) {
        const materialIndexes = edgeMaterialIndexes.get(edgeKey) ?? new Set();
        materialIndexes.add(triangle.materialIndex);
        edgeMaterialIndexes.set(edgeKey, materialIndexes);
      }
    }
  }

  const edgeUseHistogram: Record<number, number> = {};
  let boundaryEdges = 0;
  let overSharedEdges = 0;
  for (const count of edgeUseCounts.values()) {
    edgeUseHistogram[count] = (edgeUseHistogram[count] ?? 0) + 1;
    if (count === 1) {
      boundaryEdges += 1;
    } else if (count > 2) {
      overSharedEdges += 1;
    }
  }

  let materialTransitionEdges = 0;
  for (const materialIndexes of edgeMaterialIndexes.values()) {
    if (materialIndexes.size > 1) {
      materialTransitionEdges += 1;
    }
  }

  return {
    vertexCount: vertices.length,
    weldedVertexCount: remappedVertices.vertexCount,
    triangleCount: triangles.length,
    invalidVertexReferenceCount,
    degenerateTriangleCount,
    uniqueEdges: edgeUseCounts.size,
    edgeUseHistogram,
    boundaryEdges,
    overSharedEdges,
    materialTransitionEdges,
  };
}

function validateThreeMfPackageParts({
  contentTypesXml,
  relationshipsXml,
  modelRelationshipsXml,
  rootModelXml,
  objectModelXml,
  modelSettingsConfig,
  sliceInfoConfig,
  projectSettingsConfig,
}: ThreeMfPackageParts): void {
  if (
    !contentTypesXml.includes(
      'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
    )
  ) {
    throw new Error('3MF package is missing the model content type');
  }

  if (!relationshipsXml.includes('Target="/3D/3dmodel.model"')) {
    throw new Error('3MF package is missing the 3D model relationship');
  }

  if (!rootModelXml.includes(`xmlns="${CORE_NAMESPACE}"`)) {
    throw new Error('3MF root model is missing the core namespace');
  }

  const applicationMatch = rootModelXml.match(
    /<metadata name="Application">BambuStudio-([^<]+)<\/metadata>/,
  );
  if (
    !applicationMatch ||
    !BAMBU_SUPPORTED_VERSIONS.includes(applicationMatch[1])
  ) {
    throw new Error(
      '3MF root model is missing Bambu Studio application metadata',
    );
  }

  if (
    modelRelationshipsXml &&
    !modelRelationshipsXml.includes(`Target="${BAMBU_OBJECT_MODEL_REL_TARGET}"`)
  ) {
    throw new Error('3MF package is missing the Bambu object relationship');
  }

  if (modelSettingsConfig && !modelSettingsConfig.includes('<mesh_stat ')) {
    throw new Error('3MF package is missing Bambu model mesh stats');
  }

  if (sliceInfoConfig && !sliceInfoConfig.includes('X-BBL-Client-Version')) {
    throw new Error('3MF package is missing Bambu slice metadata');
  }

  if (!objectModelXml.includes(`xmlns="${CORE_NAMESPACE}"`)) {
    throw new Error('3MF model is missing the core namespace');
  }

  if (!objectModelXml.includes(`xmlns:m="${MATERIAL_NAMESPACE}"`)) {
    throw new Error('3MF model is missing the material namespace');
  }

  const resourceMaterialCounts = getMaterialResourceCounts(objectModelXml);
  const vertexCount = objectModelXml.match(/<vertex\b/g)?.length ?? 0;
  if (vertexCount === 0) {
    throw new Error('3MF model has no vertices');
  }

  const objectIds = new Set<string>();
  for (const match of objectModelXml.matchAll(/<object\b([^>]*)>/g)) {
    const attributes = parseXmlAttributes(match[1]);
    const objectId = attributes.get('id');
    if (objectId) {
      objectIds.add(objectId);
    }

    const pid = attributes.get('pid');
    const pindex = attributes.get('pindex');
    if (pid && pindex) {
      validateMaterialIndex(
        pid,
        Number.parseInt(pindex, 10),
        resourceMaterialCounts,
      );
    }
  }

  if (objectIds.size === 0) {
    throw new Error('3MF model has no object resources');
  }

  const rootObjectIds = new Set<string>();
  for (const match of rootModelXml.matchAll(/<object\b([^>]*)>/g)) {
    const objectId = parseXmlAttributes(match[1]).get('id');
    if (objectId) {
      rootObjectIds.add(objectId);
    }
  }

  for (const match of rootModelXml.matchAll(/<item\b([^>]*)\/>/g)) {
    const objectId = parseXmlAttributes(match[1]).get('objectid');
    if (!objectId || !rootObjectIds.has(objectId)) {
      throw new Error(
        `3MF build item references missing root object ${objectId}`,
      );
    }
  }

  let triangleCount = 0;
  for (const match of objectModelXml.matchAll(/<triangle\b([^>]*)\/>/g)) {
    triangleCount += 1;
    const attributes = parseXmlAttributes(match[1]);
    const vertexIndexes = ['v1', 'v2', 'v3'].map((name) =>
      Number.parseInt(attributes.get(name) ?? '', 10),
    );

    if (vertexIndexes.some((index) => !Number.isInteger(index))) {
      throw new Error('3MF triangle has an invalid vertex index');
    }

    if (new Set(vertexIndexes).size !== 3) {
      throw new Error('3MF triangle has duplicate vertex indexes');
    }

    for (const vertexIndex of vertexIndexes) {
      if (vertexIndex < 0 || vertexIndex >= vertexCount) {
        throw new Error(
          `3MF triangle vertex index ${vertexIndex} exceeds ${vertexCount} available vertices`,
        );
      }
    }

    const pid = attributes.get('pid');
    if (!pid) {
      throw new Error('3MF triangle is missing a material pid');
    }

    for (const name of ['p1', 'p2', 'p3']) {
      const materialIndex = Number.parseInt(attributes.get(name) ?? '', 10);
      validateMaterialIndex(pid, materialIndex, resourceMaterialCounts);
    }

    const materialIndex = Number.parseInt(attributes.get('p1') ?? '', 10);
    const paintColor = attributes.get('paint_color');
    const expectedPaintColor = getBambuOrcaPaintColor(materialIndex);
    if (paintColor !== expectedPaintColor) {
      throw new Error(
        `3MF triangle paint_color ${paintColor} does not match material slot ${expectedPaintColor}`,
      );
    }
  }

  if (triangleCount === 0) {
    throw new Error('3MF model has no triangles');
  }

  validateProjectSettingsColors(projectSettingsConfig, objectModelXml);
}

async function readRequiredZipText(
  entriesByName: Map<string, ZipTextEntry>,
  filename: string,
): Promise<string> {
  const entry = entriesByName.get(filename);
  if (!entry?.getData) {
    throw new Error(`3MF package entry ${filename} cannot be read`);
  }

  return entry.getData(new TextWriter());
}

function extractSceneGeometry(
  scene: THREE.Scene,
  {
    preserveTextureDetail = false,
    textureDetailSubdivisionPixelSpan = TEXTURE_DETAIL_SUBDIVISION_PIXEL_SPAN,
    textureDetailMaxSubdivisionLevel = TEXTURE_DETAIL_MAX_SUBDIVISION_LEVEL,
  }: {
    preserveTextureDetail?: boolean;
    textureDetailSubdivisionPixelSpan?: number;
    textureDetailMaxSubdivisionLevel?: number;
  } = {},
): SceneGeometry {
  const vertices: VectorTuple[] = [];
  const triangles: SceneGeometry['triangles'] = [];
  const vertexMap = new Map<string, number>();

  scene.updateMatrixWorld(true);
  scene.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || !node.geometry.attributes.position) {
      return;
    }

    const geometry = node.geometry;
    const position = geometry.attributes.position;
    const colorAttribute = geometry.attributes.color;
    const uvAttribute = geometry.attributes.uv;
    const matrixWorld = node.matrixWorld;
    const materials = Array.isArray(node.material)
      ? node.material
      : [node.material];
    const groups = geometry.groups.length
      ? geometry.groups
      : [{ start: 0, count: getIndexCount(geometry), materialIndex: 0 }];
    const embeddedSemanticMaterialIds =
      getEmbeddedSemanticMaterialIds(geometry);
    const textureDetailEdgeSegments = preserveTextureDetail
      ? buildTextureDetailEdgeSegments({
          geometry,
          groups,
          materials,
          uvAttribute,
          position,
          matrixWorld,
          subdivisionPixelSpan: textureDetailSubdivisionPixelSpan,
          maxSubdivisionLevel: textureDetailMaxSubdivisionLevel,
        })
      : null;

    const getOrCreateVertex = (vertex: VectorTuple): number => {
      const key = getVertexKey(vertex);
      const existingIndex = vertexMap.get(key);

      if (existingIndex !== undefined) {
        return existingIndex;
      }

      const vertexIndex = vertices.length;
      vertices.push(vertex);
      vertexMap.set(key, vertexIndex);
      return vertexIndex;
    };

    const getOrCreateVertexIndex = (sourceIndex: number): number =>
      getOrCreateVertex(readWorldVertex(position, sourceIndex, matrixWorld));

    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0] ?? materials[0];
      const end = group.start + group.count;

      for (let offset = group.start; offset + 2 < end; offset += 3) {
        const a = getVertexIndex(geometry, offset);
        const b = getVertexIndex(geometry, offset + 1);
        const c = getVertexIndex(geometry, offset + 2);
        const vertexIndices: [number, number, number] = [a, b, c];
        const texturedSubTriangles = preserveTextureDetail
          ? subdivideTexturedTriangleForColorDetail({
              material,
              colorAttribute,
              uvAttribute,
              position,
              matrixWorld,
              vertexIndices,
              textureDetailEdgeSegments,
            })
          : null;

        if (texturedSubTriangles) {
          for (const texturedTriangle of texturedSubTriangles) {
            const v1 = getOrCreateVertex(texturedTriangle.vertices[0]);
            const v2 = getOrCreateVertex(texturedTriangle.vertices[1]);
            const v3 = getOrCreateVertex(texturedTriangle.vertices[2]);

            if (v1 === v2 || v2 === v3 || v1 === v3) {
              continue;
            }

            triangles.push({
              v1,
              v2,
              v3,
              color: texturedTriangle.color,
              semanticMaterialId:
                embeddedSemanticMaterialIds?.[Math.floor(offset / 3)] ??
                getTargetMaterialIdFromMaterial(material),
            });
          }
          continue;
        }

        const v1 = getOrCreateVertexIndex(a);
        const v2 = getOrCreateVertexIndex(b);
        const v3 = getOrCreateVertexIndex(c);

        if (v1 === v2 || v2 === v3 || v1 === v3) {
          continue;
        }

        const triangleColor = sampleTriangleColor({
          material,
          colorAttribute,
          uvAttribute,
          vertexIndices,
        });

        triangles.push({
          v1,
          v2,
          v3,
          color: triangleColor,
          semanticMaterialId:
            embeddedSemanticMaterialIds?.[Math.floor(offset / 3)] ??
            getTargetMaterialIdFromMaterial(material),
        });
      }
    }
  });

  return { vertices, triangles };
}

function getEmbeddedSemanticMaterialIds(
  geometry: THREE.BufferGeometry,
): number[] | null {
  const semanticMaterialIds = geometry.userData.semanticMaterialIds;
  if (
    Array.isArray(semanticMaterialIds) &&
    semanticMaterialIds.every((id) => Number.isInteger(id))
  ) {
    return semanticMaterialIds;
  }

  return null;
}

function getTargetMaterialIdFromMaterial(
  material: THREE.Material | undefined,
): number | undefined {
  const materialName = material?.name
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  if (!materialName) {
    return undefined;
  }

  if (/\b(black|dark|shadow)\b/.test(materialName)) {
    return TARGET_MATERIAL_ID_BLACK;
  }

  if (/\b(yellow|gold|accent)\b/.test(materialName)) {
    return TARGET_MATERIAL_ID_YELLOW;
  }

  if (/\b(green|lime|enamel|field)\b/.test(materialName)) {
    return TARGET_MATERIAL_ID_GREEN;
  }

  if (/\b(silver|grey|gray|metal|chrome|white|light)\b/.test(materialName)) {
    return TARGET_MATERIAL_ID_SILVER;
  }

  return undefined;
}

function applySemanticMaterialMap(
  geometry: SceneGeometry,
  semanticMaterialMap: ThreeMfSemanticMaterialMap | null | undefined,
): SceneGeometry {
  if (
    !isUsableSemanticMaterialMap(semanticMaterialMap, geometry.triangles.length)
  ) {
    return geometry;
  }

  return {
    vertices: geometry.vertices,
    triangles: geometry.triangles.map((triangle, index) => ({
      ...triangle,
      semanticMaterialId: semanticMaterialMap.triangleMaterialIds?.[index],
    })),
  };
}

async function repairSceneGeometryForThreeMfExport(
  geometry: SceneGeometry,
): Promise<RepairedSceneGeometry> {
  const manifoldGeometry =
    await repairSceneGeometryWithManifoldFilter(geometry);
  // Only run the (expensive) local topology repair on the raw holey mesh when
  // the manifold filter path is unavailable. When it succeeds we re-run the
  // topology pass on its output below instead, so computing the raw fallback
  // eagerly just to discard it doubled the repair work on the success path.
  if (!manifoldGeometry) {
    return repairSceneGeometryTopology(geometry);
  }

  return repairSceneGeometryTopology(manifoldGeometry);
}

function repairSceneGeometryTopology(
  geometry: IndexedTriangleGeometry,
): RepairedSceneGeometry {
  const weldedGeometry = weldSceneGeometryVertices(
    geometry,
    THREE_MF_REPAIR_VERTEX_WELD_TOLERANCE_MM,
  );
  const keptTriangleIndexes = new Set<number>();

  // Group non-degenerate triangles by their unordered vertex set. CSG unions
  // and AI-generated meshes routinely emit multiple coincident triangles on
  // the same three vertices — typically internal walls between solids, where
  // each side contributes a copy with opposite winding. Cancelling even
  // counts and keeping a single triangle for odd counts removes the
  // zero-volume sandwiches that Bambu Studio flags as non-manifold edges.
  const vertexSetGroups = new Map<string, number[]>();
  weldedGeometry.triangles.forEach((triangle, triangleIndex) => {
    if (isDegenerateTriangle(triangle, weldedGeometry.vertices)) {
      return;
    }
    const key = [triangle.v1, triangle.v2, triangle.v3]
      .sort((a, b) => a - b)
      .join('-');
    const group = vertexSetGroups.get(key) ?? [];
    group.push(triangleIndex);
    vertexSetGroups.set(key, group);
  });

  for (const group of vertexSetGroups.values()) {
    if (group.length % 2 === 1) {
      keptTriangleIndexes.add(group[0]);
    }
  }

  const edgeToTriangleIndexes = new Map<string, number[]>();
  for (const triangleIndex of keptTriangleIndexes) {
    const triangle = weldedGeometry.triangles[triangleIndex];
    for (const [a, b] of [
      [triangle.v1, triangle.v2],
      [triangle.v2, triangle.v3],
      [triangle.v3, triangle.v1],
    ]) {
      const key = getEdgeKey(a, b);
      const triangleIndexes = edgeToTriangleIndexes.get(key) ?? [];
      triangleIndexes.push(triangleIndex);
      edgeToTriangleIndexes.set(key, triangleIndexes);
    }
  }

  for (const triangleIndexes of edgeToTriangleIndexes.values()) {
    const currentlyKeptTriangleIndexes = triangleIndexes.filter(
      (triangleIndex) => keptTriangleIndexes.has(triangleIndex),
    );

    if (currentlyKeptTriangleIndexes.length <= 2) {
      continue;
    }

    for (const triangleIndex of currentlyKeptTriangleIndexes.slice(2)) {
      keptTriangleIndexes.delete(triangleIndex);
    }
  }

  const repairedTriangles = weldedGeometry.triangles
    .filter((_, index) => keptTriangleIndexes.has(index))
    .map(({ v1, v2, v3 }) => ({ v1, v2, v3 }));
  const sealedTriangles = fillBoundaryTriangleLoops(
    weldedGeometry.vertices,
    repairedTriangles,
  );
  const orientedTriangles =
    orientRepairedTrianglesConsistently(sealedTriangles);
  const outputTriangles =
    countSameDirectionSharedTriangleEdges(orientedTriangles) <=
    countSameDirectionSharedTriangleEdges(sealedTriangles)
      ? orientedTriangles
      : sealedTriangles;
  return compactSceneGeometry({
    vertices: weldedGeometry.vertices,
    triangles: outputTriangles,
  });
}

async function repairSceneGeometryWithManifoldFilter(
  geometry: IndexedTriangleGeometry,
): Promise<RepairedSceneGeometry | null> {
  if (
    geometry.vertices.length === 0 ||
    geometry.triangles.length < MANIFOLD_FILTER_MIN_TRIANGLES
  ) {
    return null;
  }

  try {
    const [itk, meshFilters] = await Promise.all([
      import('itk-wasm'),
      import('@itk-wasm/mesh-filters'),
    ]);
    const repairMesh =
      'repair' in meshFilters && typeof meshFilters.repair === 'function'
        ? meshFilters.repair
        : meshFilters.repairNode;
    if (typeof repairMesh !== 'function') {
      return null;
    }

    const { outputMesh } = await repairMesh(
      buildItkTriangleMesh(geometry, itk),
      {
        maximumHoleArea: 100,
        maximumHoleEdges: MAX_BOUNDARY_FILL_LOOP_EDGES * 4,
        mergeTolerance: 0.001,
      },
    );
    const repairedGeometry = convertItkTriangleMesh(outputMesh);
    return repairedGeometry
      ? removeManifoldFilterArtifactTriangles(repairedGeometry, geometry)
      : null;
  } catch (error) {
    console.warn(
      '3MF manifold repair filter failed; using local repair only.',
      error,
    );
    return null;
  }
}

function removeManifoldFilterArtifactTriangles(
  repairedGeometry: RepairedSceneGeometry,
  sourceGeometry: IndexedTriangleGeometry,
): RepairedSceneGeometry {
  const sourceTriangleKeys = new Set(
    sourceGeometry.triangles.map((triangle) =>
      getTriangleGeometryKey(sourceGeometry.vertices, triangle),
    ),
  );
  let triangles = repairedGeometry.triangles;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const overSharedEdges = [...getEdgeUseCounts(triangles).entries()].filter(
      ([, edgeUse]) => edgeUse.count > 2,
    );
    if (overSharedEdges.length === 0) {
      break;
    }

    const overSharedEdgeKeys = new Set(overSharedEdges.map(([key]) => key));
    const removableTriangleIndexes = new Set<number>();
    triangles.forEach((triangle, triangleIndex) => {
      const touchesOverSharedEdge = [
        [triangle.v1, triangle.v2],
        [triangle.v2, triangle.v3],
        [triangle.v3, triangle.v1],
      ].some(([a, b]) => overSharedEdgeKeys.has(getEdgeKey(a, b)));
      if (
        touchesOverSharedEdge &&
        !sourceTriangleKeys.has(
          getTriangleGeometryKey(repairedGeometry.vertices, triangle),
        )
      ) {
        removableTriangleIndexes.add(triangleIndex);
      }
    });

    if (removableTriangleIndexes.size === 0) {
      for (const [, edgeUse] of overSharedEdges) {
        const incidentTriangleIndexes = triangles
          .map((triangle, triangleIndex) =>
            [
              [triangle.v1, triangle.v2],
              [triangle.v2, triangle.v3],
              [triangle.v3, triangle.v1],
            ].some(
              ([a, b]) => getEdgeKey(a, b) === getEdgeKey(edgeUse.a, edgeUse.b),
            )
              ? triangleIndex
              : -1,
          )
          .filter((triangleIndex) => triangleIndex >= 0)
          .sort(
            (left, right) =>
              getTriangleAreaSquared(
                repairedGeometry.vertices,
                triangles[left],
              ) -
              getTriangleAreaSquared(
                repairedGeometry.vertices,
                triangles[right],
              ),
          );
        for (const triangleIndex of incidentTriangleIndexes.slice(
          0,
          Math.max(0, incidentTriangleIndexes.length - 2),
        )) {
          removableTriangleIndexes.add(triangleIndex);
        }
      }
    }

    if (removableTriangleIndexes.size === 0) {
      break;
    }

    triangles = fillBoundaryTriangleLoops(
      repairedGeometry.vertices,
      triangles.filter(
        (_, triangleIndex) => !removableTriangleIndexes.has(triangleIndex),
      ),
    );
  }

  return { vertices: repairedGeometry.vertices, triangles };
}

function buildItkTriangleMesh(
  geometry: IndexedTriangleGeometry,
  itk: typeof import('itk-wasm'),
): ItkMesh {
  const mesh = new itk.Mesh(
    new itk.MeshType(
      3,
      itk.FloatTypes.Float32,
      itk.IntTypes.UInt8,
      itk.PixelTypes.Scalar,
      0,
      itk.IntTypes.UInt32,
      itk.IntTypes.UInt8,
      itk.PixelTypes.Scalar,
      0,
    ),
  );
  mesh.numberOfPoints = geometry.vertices.length;
  mesh.points = new Float32Array(geometry.vertices.flat());
  mesh.numberOfPointPixels = 0;
  mesh.pointData = new Uint8Array();
  mesh.numberOfCells = geometry.triangles.length;
  mesh.cellBufferSize = geometry.triangles.length * 5;
  const cells = new Uint32Array(mesh.cellBufferSize);
  mesh.numberOfCellPixels = 0;
  mesh.cellData = new Uint8Array();

  geometry.triangles.forEach((triangle, triangleIndex) => {
    const offset = triangleIndex * 5;
    cells.set([2, 3, triangle.v1, triangle.v2, triangle.v3], offset);
  });
  mesh.cells = cells;

  return mesh;
}

function convertItkTriangleMesh(
  mesh: ItkMesh | undefined,
): RepairedSceneGeometry | null {
  if (!mesh?.points || !mesh.cells || mesh.numberOfPoints <= 0) {
    return null;
  }

  const vertices: VectorTuple[] = [];
  for (let offset = 0; offset + 2 < mesh.points.length; offset += 3) {
    vertices.push([
      Number(mesh.points[offset]),
      Number(mesh.points[offset + 1]),
      Number(mesh.points[offset + 2]),
    ]);
  }

  const triangles: RepairedSceneGeometry['triangles'] = [];
  for (let offset = 0; offset < mesh.cells.length; ) {
    offset += 1;
    const vertexCount = Number(mesh.cells[offset]);
    offset += 1;
    if (!Number.isInteger(vertexCount) || vertexCount <= 0) {
      return null;
    }

    if (vertexCount === 3 && offset + 2 < mesh.cells.length) {
      triangles.push({
        v1: Number(mesh.cells[offset]),
        v2: Number(mesh.cells[offset + 1]),
        v3: Number(mesh.cells[offset + 2]),
      });
    }

    offset += vertexCount;
  }

  return triangles.length > 0 ? { vertices, triangles } : null;
}

function orientRepairedTrianglesConsistently(
  triangles: RepairedSceneGeometry['triangles'],
): RepairedSceneGeometry['triangles'] {
  const adjacency = Array.from(
    { length: triangles.length },
    () =>
      [] as Array<{
        neighborIndex: number;
        shouldFlipRelative: boolean;
      }>,
  );
  const edgeUses = new Map<
    string,
    Array<{ triangleIndex: number; direction: 1 | -1 }>
  >();

  triangles.forEach((triangle, triangleIndex) => {
    for (const [a, b] of [
      [triangle.v1, triangle.v2],
      [triangle.v2, triangle.v3],
      [triangle.v3, triangle.v1],
    ]) {
      const key = getEdgeKey(a, b);
      const uses = edgeUses.get(key) ?? [];
      uses.push({
        triangleIndex,
        direction: a < b ? 1 : -1,
      });
      edgeUses.set(key, uses);
    }
  });

  for (const uses of edgeUses.values()) {
    if (uses.length !== 2) {
      continue;
    }

    const shouldFlipRelative = uses[0].direction === uses[1].direction;
    adjacency[uses[0].triangleIndex].push({
      neighborIndex: uses[1].triangleIndex,
      shouldFlipRelative,
    });
    adjacency[uses[1].triangleIndex].push({
      neighborIndex: uses[0].triangleIndex,
      shouldFlipRelative,
    });
  }

  const shouldFlip = new Array<boolean | undefined>(triangles.length);
  for (
    let triangleIndex = 0;
    triangleIndex < triangles.length;
    triangleIndex += 1
  ) {
    if (shouldFlip[triangleIndex] !== undefined) {
      continue;
    }

    shouldFlip[triangleIndex] = false;
    const stack = [triangleIndex];
    while (stack.length > 0) {
      const currentIndex = stack.pop() as number;
      const currentShouldFlip = shouldFlip[currentIndex] ?? false;

      for (const { neighborIndex, shouldFlipRelative } of adjacency[
        currentIndex
      ]) {
        const neighborShouldFlip = currentShouldFlip !== shouldFlipRelative;
        if (shouldFlip[neighborIndex] === undefined) {
          shouldFlip[neighborIndex] = neighborShouldFlip;
          stack.push(neighborIndex);
        }
      }
    }
  }

  return triangles.map((triangle, triangleIndex) =>
    shouldFlip[triangleIndex]
      ? { v1: triangle.v1, v2: triangle.v3, v3: triangle.v2 }
      : triangle,
  );
}

function fillBoundaryTriangleLoops(
  vertices: VectorTuple[],
  triangles: RepairedSceneGeometry['triangles'],
): RepairedSceneGeometry['triangles'] {
  const sourceEdgeUseCounts = getEdgeUseCounts(triangles);
  const boundaryEdges = getBoundaryEdges(sourceEdgeUseCounts);
  if (boundaryEdges.length === 0) {
    return triangles;
  }

  // Build two per-repair-pass edge indexes over the (loop-invariant) source
  // triangles so each candidate loop does O(loop length) work instead of
  // O(triangles):
  //   - sourceEdgeTriangleIndexes: unordered edge key -> triangle indices, so
  //     shouldFillBoundaryLoop can find a loop's incident triangles by lookup.
  //   - sourceDirectedEdgesByKey: unordered edge key -> the source triangles'
  //     directed edges, so orientCapTrianglesForSharedEdges can score cap flips
  //     incrementally against a fixed source instead of rebuilding a full-mesh
  //     edge map on every flip evaluation.
  const sourceEdgeTriangleIndexes = new Map<string, number[]>();
  const sourceDirectedEdgesByKey = new Map<
    string,
    Array<{ a: number; b: number }>
  >();
  triangles.forEach((triangle, triangleIndex) => {
    for (const [a, b] of [
      [triangle.v1, triangle.v2],
      [triangle.v2, triangle.v3],
      [triangle.v3, triangle.v1],
    ]) {
      const key = getEdgeKey(a, b);
      const triangleIndexes = sourceEdgeTriangleIndexes.get(key);
      if (triangleIndexes) {
        triangleIndexes.push(triangleIndex);
      } else {
        sourceEdgeTriangleIndexes.set(key, [triangleIndex]);
      }
      const directedEdges = sourceDirectedEdgesByKey.get(key);
      if (directedEdges) {
        directedEdges.push({ a, b });
      } else {
        sourceDirectedEdgesByKey.set(key, [{ a, b }]);
      }
    }
  });

  const usedTriangleKeys = new Set(
    triangles.map((triangle) => getUnorderedTriangleVertexKey(triangle)),
  );
  const capTriangles: RepairedSceneGeometry['triangles'] = [];

  for (const loop of getBoundaryEdgeLoops(boundaryEdges)) {
    if (loop.length < 3 || loop.length > MAX_BOUNDARY_FILL_LOOP_EDGES) {
      continue;
    }

    let candidateCapTriangles = triangulateBoundaryLoop(
      vertices,
      loop,
      sourceEdgeUseCounts,
    );
    if (
      candidateCapTriangles.length === 0 &&
      loop.length <= MAX_SMALL_BOUNDARY_FILL_LOOP_EDGES &&
      getBoundaryLoopMaxSpan(vertices, loop) <=
        MAX_SMALL_PLANAR_BOUNDARY_FILL_SPAN_MM
    ) {
      candidateCapTriangles = triangulateBoundaryLoopWithCenterVertex(
        vertices,
        loop,
      );
    }
    const loopEdgeKeys = getLoopEdgeKeys(loop);
    if (
      !shouldFillBoundaryLoop(
        vertices,
        triangles,
        loop,
        candidateCapTriangles,
        sourceEdgeTriangleIndexes,
      ) ||
      !isBoundaryLoopCapTopologySafe(
        candidateCapTriangles,
        sourceEdgeUseCounts,
        loopEdgeKeys,
      )
    ) {
      continue;
    }

    for (const triangle of orientCapTrianglesForSharedEdges(
      sourceDirectedEdgesByKey,
      candidateCapTriangles,
    )) {
      const triangleKey = getUnorderedTriangleVertexKey(triangle);
      if (
        usedTriangleKeys.has(triangleKey) ||
        isDegenerateTriangle(triangle, vertices)
      ) {
        continue;
      }

      usedTriangleKeys.add(triangleKey);
      capTriangles.push(triangle);
    }
  }

  return capTriangles.length > 0 ? [...triangles, ...capTriangles] : triangles;
}

function orientCapTrianglesForSharedEdges(
  sourceDirectedEdgesByKey: Map<string, Array<{ a: number; b: number }>>,
  capTriangles: RepairedSceneGeometry['triangles'],
): RepairedSceneGeometry['triangles'] {
  const orientedCapTriangles = capTriangles.map((triangle) => ({
    ...triangle,
  }));

  // sourceDirectedEdgesByKey holds every source triangle's directed edges keyed
  // by unordered edge key; it is built once per fillBoundaryTriangleLoops pass
  // (the source triangle list is identical for every candidate loop) and is
  // never mutated here. Only the caps' directed edges live in capDirectedEdges,
  // a small per-call map. Flipping a single cap merely reverses that cap's three
  // directed edges, so the change in countSameDirectionSharedTriangleEdges is
  // confined to those three unordered edge keys and is scored in O(1) by
  // combining the immutable source uses with the mutable cap uses. The flip
  // decisions are therefore identical to scoring the full source+cap triangle
  // list on every evaluation, at O(source) once instead of O(source) per flip.
  const capDirectedEdges = new Map<string, Array<{ a: number; b: number }>>();
  const addCapEdge = (a: number, b: number): void => {
    const key = getEdgeKey(a, b);
    const uses = capDirectedEdges.get(key);
    if (uses) {
      uses.push({ a, b });
    } else {
      capDirectedEdges.set(key, [{ a, b }]);
    }
  };
  const removeCapEdge = (a: number, b: number): void => {
    const key = getEdgeKey(a, b);
    const uses = capDirectedEdges.get(key);
    if (!uses) {
      return;
    }
    const index = uses.findIndex((use) => use.a === a && use.b === b);
    if (index >= 0) {
      uses.splice(index, 1);
    }
  };
  // Same "same-direction shared edge" predicate as
  // countSameDirectionSharedTriangleEdges, evaluated for a single edge key: an
  // unordered edge used by exactly two triangles (source + cap combined) that
  // traverse it in the same direction (the two directed edges are not reverses
  // of each other). The predicate is symmetric in the order of the two uses, so
  // combining the source and cap arrays in either order gives the same result
  // as a full rebuild.
  const sameDirectionSharedKeyScore = (key: string): number => {
    const sourceUses = sourceDirectedEdgesByKey.get(key);
    const capUses = capDirectedEdges.get(key);
    const sourceCount = sourceUses ? sourceUses.length : 0;
    const capCount = capUses ? capUses.length : 0;
    if (sourceCount + capCount !== 2) {
      return 0;
    }
    const uses: Array<{ a: number; b: number }> = [];
    if (sourceUses) {
      for (const use of sourceUses) {
        uses.push(use);
      }
    }
    if (capUses) {
      for (const use of capUses) {
        uses.push(use);
      }
    }
    return !(uses[0].a === uses[1].b && uses[0].b === uses[1].a) ? 1 : 0;
  };

  for (const triangle of orientedCapTriangles) {
    addCapEdge(triangle.v1, triangle.v2);
    addCapEdge(triangle.v2, triangle.v3);
    addCapEdge(triangle.v3, triangle.v1);
  }

  for (let iteration = 0; iteration < 2; iteration += 1) {
    let changed = false;
    for (
      let capTriangleIndex = 0;
      capTriangleIndex < orientedCapTriangles.length;
      capTriangleIndex += 1
    ) {
      const currentTriangle = orientedCapTriangles[capTriangleIndex];
      const flippedTriangle = {
        v1: currentTriangle.v1,
        v2: currentTriangle.v3,
        v3: currentTriangle.v2,
      };

      // Flipping preserves each edge's unordered key, so the current and
      // flipped triangles touch the same set of keys. Score each distinct key
      // once (a degenerate cap can repeat a key) to match the global count,
      // which credits each unordered edge at most once.
      const affectedKeys = new Set<string>([
        getEdgeKey(currentTriangle.v1, currentTriangle.v2),
        getEdgeKey(currentTriangle.v2, currentTriangle.v3),
        getEdgeKey(currentTriangle.v3, currentTriangle.v1),
      ]);

      let scoreBefore = 0;
      for (const key of affectedKeys) {
        scoreBefore += sameDirectionSharedKeyScore(key);
      }

      removeCapEdge(currentTriangle.v1, currentTriangle.v2);
      removeCapEdge(currentTriangle.v2, currentTriangle.v3);
      removeCapEdge(currentTriangle.v3, currentTriangle.v1);
      addCapEdge(flippedTriangle.v1, flippedTriangle.v2);
      addCapEdge(flippedTriangle.v2, flippedTriangle.v3);
      addCapEdge(flippedTriangle.v3, flippedTriangle.v1);

      let scoreAfter = 0;
      for (const key of affectedKeys) {
        scoreAfter += sameDirectionSharedKeyScore(key);
      }

      if (scoreAfter < scoreBefore) {
        orientedCapTriangles[capTriangleIndex] = flippedTriangle;
        changed = true;
      } else {
        // Keep the current orientation: undo the cap-edge edits for this cap.
        removeCapEdge(flippedTriangle.v1, flippedTriangle.v2);
        removeCapEdge(flippedTriangle.v2, flippedTriangle.v3);
        removeCapEdge(flippedTriangle.v3, flippedTriangle.v1);
        addCapEdge(currentTriangle.v1, currentTriangle.v2);
        addCapEdge(currentTriangle.v2, currentTriangle.v3);
        addCapEdge(currentTriangle.v3, currentTriangle.v1);
      }
    }

    if (!changed) {
      break;
    }
  }

  return orientedCapTriangles;
}

function countSameDirectionSharedTriangleEdges(
  triangles: RepairedSceneGeometry['triangles'],
): number {
  const edgeUses = new Map<string, Array<{ a: number; b: number }>>();
  for (const triangle of triangles) {
    for (const [a, b] of [
      [triangle.v1, triangle.v2],
      [triangle.v2, triangle.v3],
      [triangle.v3, triangle.v1],
    ]) {
      const key = getEdgeKey(a, b);
      const uses = edgeUses.get(key) ?? [];
      uses.push({ a, b });
      edgeUses.set(key, uses);
    }
  }

  return [...edgeUses.values()].filter(
    (uses) =>
      uses.length === 2 &&
      !(uses[0].a === uses[1].b && uses[0].b === uses[1].a),
  ).length;
}

function isBoundaryLoopCapTopologySafe(
  capTriangles: RepairedSceneGeometry['triangles'],
  sourceEdgeUseCounts: Map<string, { a: number; b: number; count: number }>,
  loopEdgeKeys: Set<string>,
): boolean {
  for (const triangle of capTriangles) {
    for (const [a, b] of [
      [triangle.v1, triangle.v2],
      [triangle.v2, triangle.v3],
      [triangle.v3, triangle.v1],
    ]) {
      const edgeKey = getEdgeKey(a, b);
      const sourceUseCount = sourceEdgeUseCounts.get(edgeKey)?.count ?? 0;
      if (loopEdgeKeys.has(edgeKey)) {
        if (sourceUseCount !== 1) {
          return false;
        }
        continue;
      }

      if (sourceUseCount > 0) {
        return false;
      }
    }
  }

  return true;
}

function shouldFillBoundaryLoop(
  vertices: VectorTuple[],
  sourceTriangles: RepairedSceneGeometry['triangles'],
  loop: number[],
  capTriangles: RepairedSceneGeometry['triangles'],
  sourceEdgeTriangleIndexes: Map<string, number[]>,
): boolean {
  const capNormal = getAverageTriangleNormal(vertices, capTriangles);
  if (capNormal.lengthSq() === 0) {
    return false;
  }

  const loopEdgeKeys = new Set(
    loop.map((vertexIndex, index) =>
      getEdgeKey(vertexIndex, loop[(index + 1) % loop.length]),
    ),
  );
  // Gather the source triangles incident to any loop edge via the prebuilt
  // edge index and dedupe them (a triangle touching two loop edges must still
  // contribute a single normal, matching the original per-triangle scan).
  const incidentTriangleIndexes = new Set<number>();
  for (const edgeKey of loopEdgeKeys) {
    const triangleIndexes = sourceEdgeTriangleIndexes.get(edgeKey);
    if (triangleIndexes) {
      for (const triangleIndex of triangleIndexes) {
        incidentTriangleIndexes.add(triangleIndex);
      }
    }
  }
  const incidentNormals: THREE.Vector3[] = [];
  for (const triangleIndex of incidentTriangleIndexes) {
    const normal = getTriangleNormal(vertices, sourceTriangles[triangleIndex]);
    if (normal.lengthSq() > 0) {
      incidentNormals.push(normal);
    }
  }

  if (
    loop.length <= MAX_SMALL_BOUNDARY_FILL_LOOP_EDGES &&
    incidentNormals.length >= 2 &&
    getBoundaryLoopMaxSpan(vertices, loop) <=
      MAX_SMALL_PLANAR_BOUNDARY_FILL_SPAN_MM
  ) {
    return true;
  }

  return incidentNormals.some(
    (normal) => Math.abs(normal.dot(capNormal)) < 0.98,
  );
}

function getBoundaryLoopMaxSpan(
  vertices: VectorTuple[],
  loop: number[],
): number {
  const bounds = loop.reduce(
    (currentBounds, vertexIndex) => {
      const vertex = vertices[vertexIndex];
      return {
        minX: Math.min(currentBounds.minX, vertex[0]),
        maxX: Math.max(currentBounds.maxX, vertex[0]),
        minY: Math.min(currentBounds.minY, vertex[1]),
        maxY: Math.max(currentBounds.maxY, vertex[1]),
        minZ: Math.min(currentBounds.minZ, vertex[2]),
        maxZ: Math.max(currentBounds.maxZ, vertex[2]),
      };
    },
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    },
  );

  return Math.max(
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ,
  );
}

function getEdgeUseCounts(
  triangles: RepairedSceneGeometry['triangles'],
): Map<string, { a: number; b: number; count: number }> {
  const edgeUseCounts = new Map<
    string,
    { a: number; b: number; count: number }
  >();
  for (const triangle of triangles) {
    for (const [a, b] of [
      [triangle.v1, triangle.v2],
      [triangle.v2, triangle.v3],
      [triangle.v3, triangle.v1],
    ]) {
      const key = getEdgeKey(a, b);
      const edgeUse = edgeUseCounts.get(key);
      if (edgeUse) {
        edgeUse.count += 1;
      } else {
        edgeUseCounts.set(key, { a, b, count: 1 });
      }
    }
  }

  return edgeUseCounts;
}

function getBoundaryEdges(
  edgeUses: Map<string, { a: number; b: number; count: number }>,
): Array<{ a: number; b: number }> {
  return [...edgeUses.values()]
    .filter((edgeUse) => edgeUse.count === 1)
    .map(({ a, b }) => ({ a, b }));
}

function getLoopEdgeKeys(loop: number[]): Set<string> {
  return new Set(
    loop.map((vertexIndex, index) =>
      getEdgeKey(vertexIndex, loop[(index + 1) % loop.length]),
    ),
  );
}

function getBoundaryEdgeLoops(
  boundaryEdges: Array<{ a: number; b: number }>,
): number[][] {
  const adjacency = new Map<number, Set<number>>();
  for (const { a, b } of boundaryEdges) {
    addBoundaryNeighbor(adjacency, a, b);
    addBoundaryNeighbor(adjacency, b, a);
  }

  const visitedEdges = new Set<string>();
  const loops: number[][] = [];
  for (const { a, b } of boundaryEdges) {
    const startKey = getEdgeKey(a, b);
    if (visitedEdges.has(startKey)) {
      continue;
    }

    const loop = traceBoundaryEdgeLoop(
      adjacency,
      visitedEdges,
      a,
      b,
      boundaryEdges.length,
    );
    if (loop.length >= 4 && loop[0] === loop[loop.length - 1]) {
      loops.push(loop.slice(0, -1));
    }
  }

  return loops;
}

function addBoundaryNeighbor(
  adjacency: Map<number, Set<number>>,
  vertex: number,
  neighbor: number,
): void {
  const neighbors = adjacency.get(vertex) ?? new Set<number>();
  neighbors.add(neighbor);
  adjacency.set(vertex, neighbors);
}

function traceBoundaryEdgeLoop(
  adjacency: Map<number, Set<number>>,
  visitedEdges: Set<string>,
  start: number,
  next: number,
  maxEdges: number,
): number[] {
  const loop = [start, next];
  visitedEdges.add(getEdgeKey(start, next));

  let previous = start;
  let current = next;
  while (current !== start && loop.length <= maxEdges + 1) {
    const candidates = [...(adjacency.get(current) ?? [])].filter(
      (candidate) => !visitedEdges.has(getEdgeKey(current, candidate)),
    );
    if (candidates.length === 0) {
      return [];
    }

    const candidate =
      candidates.find((candidateVertex) => candidateVertex !== previous) ??
      candidates[0];
    visitedEdges.add(getEdgeKey(current, candidate));
    loop.push(candidate);
    previous = current;
    current = candidate;
  }

  return current === start ? loop : [];
}

function triangulateBoundaryLoop(
  vertices: VectorTuple[],
  loop: number[],
  sourceEdgeUseCounts: Map<string, { a: number; b: number; count: number }>,
): RepairedSceneGeometry['triangles'] {
  if (loop.length < 3) {
    return [];
  }

  const loopEdgeKeys = getLoopEdgeKeys(loop);
  const triangles =
    triangulateBoundaryPolygon(
      vertices,
      loop,
      sourceEdgeUseCounts,
      loopEdgeKeys,
      0,
    ) ?? [];
  if (triangles.length === 0) {
    return [];
  }

  const loopNormal = getBoundaryLoopNormal(vertices, loop);
  const capNormal = getAverageTriangleNormal(vertices, triangles);
  if (loopNormal.lengthSq() > 0 && loopNormal.dot(capNormal) < 0) {
    return triangles.map((triangle) => ({
      v1: triangle.v1,
      v2: triangle.v3,
      v3: triangle.v2,
    }));
  }

  return triangles;
}

function triangulateBoundaryLoopWithCenterVertex(
  vertices: VectorTuple[],
  loop: number[],
): RepairedSceneGeometry['triangles'] {
  if (loop.length < 3) {
    return [];
  }

  const center = loop.reduce(
    (sum, vertexIndex) => {
      const vertex = vertices[vertexIndex];
      sum[0] += vertex[0];
      sum[1] += vertex[1];
      sum[2] += vertex[2];
      return sum;
    },
    [0, 0, 0] as VectorTuple,
  );
  center[0] /= loop.length;
  center[1] /= loop.length;
  center[2] /= loop.length;

  const centerVertexIndex = vertices.length;
  vertices.push(center);
  const triangles = loop.map((vertexIndex, index) => ({
    v1: centerVertexIndex,
    v2: vertexIndex,
    v3: loop[(index + 1) % loop.length],
  }));
  const loopNormal = getBoundaryLoopNormal(vertices, loop);
  const capNormal = getAverageTriangleNormal(vertices, triangles);
  if (loopNormal.lengthSq() > 0 && loopNormal.dot(capNormal) < 0) {
    return triangles.map((triangle) => ({
      v1: triangle.v1,
      v2: triangle.v3,
      v3: triangle.v2,
    }));
  }

  return triangles;
}

function triangulateBoundaryPolygon(
  vertices: VectorTuple[],
  polygon: number[],
  sourceEdgeUseCounts: Map<string, { a: number; b: number; count: number }>,
  loopEdgeKeys: Set<string>,
  depth: number,
): RepairedSceneGeometry['triangles'] | null {
  if (polygon.length < 3 || depth > MAX_BOUNDARY_FILL_LOOP_EDGES) {
    return null;
  }

  if (polygon.length === 3) {
    const triangle = { v1: polygon[0], v2: polygon[1], v3: polygon[2] };
    return isCapTriangleUsable(
      vertices,
      triangle,
      sourceEdgeUseCounts,
      loopEdgeKeys,
    )
      ? [triangle]
      : null;
  }

  for (let index = 0; index < polygon.length; index += 1) {
    const previous = polygon[(index - 1 + polygon.length) % polygon.length];
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const triangle = { v1: previous, v2: current, v3: next };
    if (
      !isCapTriangleUsable(
        vertices,
        triangle,
        sourceEdgeUseCounts,
        loopEdgeKeys,
      )
    ) {
      continue;
    }

    const remainingPolygon = polygon.filter(
      (_, vertexIndex) => vertexIndex !== index,
    );
    const remainingTriangles = triangulateBoundaryPolygon(
      vertices,
      remainingPolygon,
      sourceEdgeUseCounts,
      loopEdgeKeys,
      depth + 1,
    );
    if (remainingTriangles) {
      return [triangle, ...remainingTriangles];
    }
  }

  return null;
}

function isCapTriangleUsable(
  vertices: VectorTuple[],
  triangle: RepairedSceneGeometry['triangles'][number],
  sourceEdgeUseCounts: Map<string, { a: number; b: number; count: number }>,
  loopEdgeKeys: Set<string>,
): boolean {
  if (isDegenerateTriangle(triangle, vertices)) {
    return false;
  }

  for (const [a, b] of [
    [triangle.v1, triangle.v2],
    [triangle.v2, triangle.v3],
    [triangle.v3, triangle.v1],
  ]) {
    const edgeKey = getEdgeKey(a, b);
    const sourceUseCount = sourceEdgeUseCounts.get(edgeKey)?.count ?? 0;
    if (loopEdgeKeys.has(edgeKey)) {
      if (sourceUseCount !== 1) {
        return false;
      }
      continue;
    }

    if (sourceUseCount > 0) {
      return false;
    }
  }

  return true;
}

function getBoundaryLoopNormal(
  vertices: VectorTuple[],
  loop: number[],
): THREE.Vector3 {
  const normal = new THREE.Vector3();
  for (let index = 0; index < loop.length; index += 1) {
    const current = vertices[loop[index]];
    const next = vertices[loop[(index + 1) % loop.length]];
    normal.x += (current[1] - next[1]) * (current[2] + next[2]);
    normal.y += (current[2] - next[2]) * (current[0] + next[0]);
    normal.z += (current[0] - next[0]) * (current[1] + next[1]);
  }

  return normal.lengthSq() > 0 ? normal.normalize() : normal;
}

function getAverageTriangleNormal(
  vertices: VectorTuple[],
  triangles: RepairedSceneGeometry['triangles'],
): THREE.Vector3 {
  const normal = new THREE.Vector3();
  for (const triangle of triangles) {
    normal.add(getTriangleNormal(vertices, triangle));
  }

  return normal.lengthSq() > 0 ? normal.normalize() : normal;
}

function getTriangleNormal(
  vertices: VectorTuple[],
  triangle: Pick<ThreeMfTriangle, 'v1' | 'v2' | 'v3'>,
): THREE.Vector3 {
  const a = vertices[triangle.v1];
  const b = vertices[triangle.v2];
  const c = vertices[triangle.v3];
  if (!a || !b || !c) {
    return new THREE.Vector3();
  }

  const ab = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const ac = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  return ab.cross(ac).normalize();
}

function getUnorderedTriangleVertexKey(
  triangle: Pick<ThreeMfTriangle, 'v1' | 'v2' | 'v3'>,
): string {
  return [triangle.v1, triangle.v2, triangle.v3]
    .sort((a, b) => a - b)
    .join('-');
}

function weldSceneGeometryVertices<TTriangle extends IndexedTriangle>(
  geometry: IndexedTriangleGeometry<TTriangle>,
  tolerance: number,
): IndexedTriangleGeometry<TTriangle> {
  if (tolerance <= 0 || geometry.vertices.length === 0) {
    return geometry;
  }

  const toleranceSquared = tolerance * tolerance;
  const cells = new Map<string, number[]>();
  const vertexRemap: number[] = [];
  const vertices: VectorTuple[] = [];

  geometry.vertices.forEach((vertex) => {
    const cell = getSpatialCell(vertex, tolerance);
    let weldedIndex: number | undefined;

    for (let dx = -1; dx <= 1 && weldedIndex === undefined; dx += 1) {
      for (let dy = -1; dy <= 1 && weldedIndex === undefined; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const nearbyIndexes = cells.get(
            getSpatialCellKey(cell[0] + dx, cell[1] + dy, cell[2] + dz),
          );
          if (!nearbyIndexes) {
            continue;
          }

          weldedIndex = nearbyIndexes.find(
            (candidateIndex) =>
              getVertexDistanceSquared(vertex, vertices[candidateIndex]) <=
              toleranceSquared,
          );
          if (weldedIndex !== undefined) {
            break;
          }
        }
      }
    }

    if (weldedIndex === undefined) {
      weldedIndex = vertices.length;
      vertices.push(vertex);
      const cellKey = getSpatialCellKey(cell[0], cell[1], cell[2]);
      const cellIndexes = cells.get(cellKey) ?? [];
      cellIndexes.push(weldedIndex);
      cells.set(cellKey, cellIndexes);
    }

    vertexRemap.push(weldedIndex);
  });

  return {
    vertices,
    triangles: geometry.triangles.map((triangle) => ({
      ...triangle,
      v1: vertexRemap[triangle.v1],
      v2: vertexRemap[triangle.v2],
      v3: vertexRemap[triangle.v3],
    })),
  };
}

function compactSceneGeometry(
  geometry: RepairedSceneGeometry,
): RepairedSceneGeometry {
  const vertexRemap = new Map<number, number>();
  const vertices: VectorTuple[] = [];
  const triangles = geometry.triangles.map((triangle) => ({
    v1: remapVertexIndex(triangle.v1, vertexRemap, vertices, geometry.vertices),
    v2: remapVertexIndex(triangle.v2, vertexRemap, vertices, geometry.vertices),
    v3: remapVertexIndex(triangle.v3, vertexRemap, vertices, geometry.vertices),
  }));

  return { vertices, triangles };
}

function assignColorsToRepairedTriangles(
  repairedGeometry: RepairedSceneGeometry,
  sourceGeometry: SceneGeometry,
): SceneGeometry['triangles'] {
  const sourceTrianglesByGeometry = new Map<
    string,
    SceneGeometry['triangles']
  >();
  sourceGeometry.triangles.forEach((triangle) => {
    const key = getTriangleGeometryKey(sourceGeometry.vertices, triangle);
    const sourceTriangles = sourceTrianglesByGeometry.get(key) ?? [];
    sourceTriangles.push(triangle);
    sourceTrianglesByGeometry.set(key, sourceTriangles);
  });
  const sourceTriangleLookup = buildSourceTriangleSpatialLookup(sourceGeometry);

  return repairedGeometry.triangles.map((triangle) => {
    const exactSourceTriangles = sourceTrianglesByGeometry.get(
      getTriangleGeometryKey(repairedGeometry.vertices, triangle),
    );
    const color = exactSourceTriangles?.length
      ? getDominantTriangleColor(exactSourceTriangles)
      : getNearestTriangleColor(
          triangle,
          repairedGeometry.vertices,
          sourceTriangleLookup,
        );

    return {
      ...triangle,
      color,
      semanticMaterialId: exactSourceTriangles?.length
        ? getDominantTriangleSemanticMaterialId(exactSourceTriangles)
        : getNearestTriangleSemanticMaterialId(
            triangle,
            repairedGeometry.vertices,
            sourceTriangleLookup,
          ),
    };
  });
}

type SourceTriangleSpatialLookup = {
  sourceGeometry: SceneGeometry;
  centroids: THREE.Vector3[];
  cellSize: number;
  cells: Map<string, number[]>;
  semanticCells: Map<string, number[]>;
};

function buildSourceTriangleSpatialLookup(
  sourceGeometry: SceneGeometry,
): SourceTriangleSpatialLookup {
  const bounds = sourceGeometry.vertices.reduce(
    (currentBounds, vertex) => {
      currentBounds.min[0] = Math.min(currentBounds.min[0], vertex[0]);
      currentBounds.min[1] = Math.min(currentBounds.min[1], vertex[1]);
      currentBounds.min[2] = Math.min(currentBounds.min[2], vertex[2]);
      currentBounds.max[0] = Math.max(currentBounds.max[0], vertex[0]);
      currentBounds.max[1] = Math.max(currentBounds.max[1], vertex[1]);
      currentBounds.max[2] = Math.max(currentBounds.max[2], vertex[2]);
      return currentBounds;
    },
    {
      min: [
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      ] as VectorTuple,
      max: [
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ] as VectorTuple,
    },
  );
  const largestSpan = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
    THREE_MF_REPAIR_VERTEX_WELD_TOLERANCE_MM,
  );
  const cellSize = Math.max(
    largestSpan / 64,
    THREE_MF_REPAIR_VERTEX_WELD_TOLERANCE_MM,
  );
  const centroids: THREE.Vector3[] = [];
  const cells = new Map<string, number[]>();
  const semanticCells = new Map<string, number[]>();

  sourceGeometry.triangles.forEach((triangle, triangleIndex) => {
    const centroid = getTriangleCentroid(sourceGeometry.vertices, triangle);
    centroids.push(centroid);
    const cell = getSpatialCell([centroid.x, centroid.y, centroid.z], cellSize);
    const cellKey = getSpatialCellKey(cell[0], cell[1], cell[2]);
    const cellTriangleIndexes = cells.get(cellKey) ?? [];
    cellTriangleIndexes.push(triangleIndex);
    cells.set(cellKey, cellTriangleIndexes);

    if (triangle.semanticMaterialId !== undefined) {
      const semanticTriangleIndexes = semanticCells.get(cellKey) ?? [];
      semanticTriangleIndexes.push(triangleIndex);
      semanticCells.set(cellKey, semanticTriangleIndexes);
    }
  });

  return { sourceGeometry, centroids, cellSize, cells, semanticCells };
}

function getDominantTriangleSemanticMaterialId(
  triangles: SceneGeometry['triangles'],
): number | undefined {
  const countsByMaterialId = new Map<
    number,
    { materialId: number; count: number; firstIndex: number }
  >();

  triangles.forEach((triangle, index) => {
    if (triangle.semanticMaterialId === undefined) {
      return;
    }
    const existing = countsByMaterialId.get(triangle.semanticMaterialId);
    if (existing) {
      existing.count += 1;
      return;
    }

    countsByMaterialId.set(triangle.semanticMaterialId, {
      materialId: triangle.semanticMaterialId,
      count: 1,
      firstIndex: index,
    });
  });

  return [...countsByMaterialId.values()].sort(
    (a, b) => b.count - a.count || a.firstIndex - b.firstIndex,
  )[0]?.materialId;
}

function getNearestTriangleSemanticMaterialId(
  triangle: RepairedSceneGeometry['triangles'][number],
  vertices: VectorTuple[],
  lookup: SourceTriangleSpatialLookup,
): number | undefined {
  const centroid = getTriangleCentroid(vertices, triangle);
  const nearestTriangleIndex = findNearestSourceTriangleIndex(
    centroid,
    lookup,
    true,
  );
  return nearestTriangleIndex === null
    ? undefined
    : lookup.sourceGeometry.triangles[nearestTriangleIndex]?.semanticMaterialId;
}

function getDominantTriangleColor(
  triangles: SceneGeometry['triangles'],
): THREE.Color {
  const countsByColor = new Map<
    string,
    { color: THREE.Color; count: number; firstIndex: number }
  >();

  triangles.forEach((triangle, index) => {
    const colorKey = colorToHex(triangle.color);
    const existing = countsByColor.get(colorKey);
    if (existing) {
      existing.count += 1;
      return;
    }

    countsByColor.set(colorKey, {
      color: triangle.color,
      count: 1,
      firstIndex: index,
    });
  });

  const dominant = [...countsByColor.values()].sort(
    (a, b) => b.count - a.count || a.firstIndex - b.firstIndex,
  )[0];
  return dominant.color.clone();
}

function getNearestTriangleColor(
  triangle: RepairedSceneGeometry['triangles'][number],
  vertices: VectorTuple[],
  lookup: SourceTriangleSpatialLookup,
): THREE.Color {
  const centroid = getTriangleCentroid(vertices, triangle);
  const nearestTriangleIndex = findNearestSourceTriangleIndex(
    centroid,
    lookup,
    false,
  );
  return lookup.sourceGeometry.triangles[
    nearestTriangleIndex ?? 0
  ].color.clone();
}

function findNearestSourceTriangleIndex(
  centroid: THREE.Vector3,
  lookup: SourceTriangleSpatialLookup,
  semanticOnly: boolean,
): number | null {
  const cells = semanticOnly ? lookup.semanticCells : lookup.cells;
  if (cells.size === 0) {
    return null;
  }

  const cell = getSpatialCell(
    [centroid.x, centroid.y, centroid.z],
    lookup.cellSize,
  );
  let nearestTriangleIndex: number | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  const visitTriangleIndexes = (triangleIndexes: number[]): void => {
    for (const triangleIndex of triangleIndexes) {
      const sourceCentroid = lookup.centroids[triangleIndex];
      const distance = centroid.distanceToSquared(sourceCentroid);
      if (distance < nearestDistance) {
        nearestTriangleIndex = triangleIndex;
        nearestDistance = distance;
      }
    }
  };

  for (let radius = 0; radius <= 8; radius += 1) {
    let visitedCount = 0;
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (
            radius > 0 &&
            Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== radius
          ) {
            continue;
          }

          const triangleIndexes = cells.get(
            getSpatialCellKey(cell[0] + dx, cell[1] + dy, cell[2] + dz),
          );
          if (!triangleIndexes) {
            continue;
          }

          visitedCount += triangleIndexes.length;
          visitTriangleIndexes(triangleIndexes);
        }
      }
    }

    if (nearestTriangleIndex !== null && visitedCount >= 12) {
      return nearestTriangleIndex;
    }
  }

  if (nearestTriangleIndex !== null) {
    return nearestTriangleIndex;
  }

  for (const triangleIndexes of cells.values()) {
    visitTriangleIndexes(triangleIndexes);
  }
  return nearestTriangleIndex;
}

function buildSemanticMaterialAssignments(
  triangles: SceneGeometry['triangles'],
  semanticMaterialMap: ThreeMfSemanticMaterialMap | null | undefined,
): { palette: THREE.Color[]; colorIndexes: number[] } | null {
  if (!semanticMaterialMap) {
    return null;
  }

  if (
    !triangles.some((triangle) => triangle.semanticMaterialId !== undefined)
  ) {
    return null;
  }

  const classes = semanticMaterialMap.classes
    .map((materialClass) => ({
      ...materialClass,
      normalizedColor: normalizeSemanticColor(materialClass.color),
    }))
    .filter(
      (
        materialClass,
      ): materialClass is ThreeMfSemanticMaterialClass & {
        normalizedColor: string;
      } =>
        Number.isInteger(materialClass.id) &&
        typeof materialClass.name === 'string' &&
        materialClass.name.length > 0 &&
        materialClass.normalizedColor !== null,
    );

  const classIndexesById = new Map<number, number>();
  const palette: THREE.Color[] = [];
  for (const materialClass of classes) {
    if (classIndexesById.has(materialClass.id)) {
      continue;
    }
    classIndexesById.set(materialClass.id, palette.length);
    palette.push(new THREE.Color(materialClass.normalizedColor));
  }

  if (palette.length === 0) {
    return null;
  }

  const colorIndexes = triangles.map((triangle) => {
    if (triangle.semanticMaterialId === undefined) {
      return findNearestPaletteIndex(triangle.color, palette);
    }
    return (
      classIndexesById.get(triangle.semanticMaterialId) ??
      findNearestPaletteIndex(triangle.color, palette)
    );
  });

  return { palette, colorIndexes };
}

function buildTargetMaterialPaletteAssignments(
  triangles: SceneGeometry['triangles'],
  targetMaterialPalette: ThreeMfTargetMaterialPalette | null | undefined,
  targetColorCount: number,
): { palette: THREE.Color[]; colorIndexes: number[] } | null {
  const palette = normalizeTargetMaterialPalette(
    targetMaterialPalette,
    targetColorCount,
  );
  if (!palette) {
    return null;
  }

  return {
    palette,
    colorIndexes: triangles.map((triangle) =>
      triangle.semanticMaterialId !== undefined
        ? findTargetPaletteIndexForSemanticMaterialId(
            triangle.semanticMaterialId,
            palette,
          )
        : findNearestTargetMaterialPaletteIndex(triangle.color, palette),
    ),
  };
}

function findTargetPaletteIndexForSemanticMaterialId(
  semanticMaterialId: number,
  palette: THREE.Color[],
): number {
  const roles = getTargetPaletteRoles(palette);
  if (semanticMaterialId === TARGET_MATERIAL_ID_SILVER) {
    return roles.lightNeutral ?? 0;
  }

  if (semanticMaterialId === TARGET_MATERIAL_ID_BLACK) {
    return roles.dark ?? 0;
  }

  if (semanticMaterialId === TARGET_MATERIAL_ID_GREEN) {
    return roles.green ?? 0;
  }

  if (semanticMaterialId === TARGET_MATERIAL_ID_YELLOW) {
    return roles.yellow ?? 0;
  }

  return 0;
}

function normalizeTargetMaterialPalette(
  targetMaterialPalette: ThreeMfTargetMaterialPalette | null | undefined,
  targetColorCount: number,
): THREE.Color[] | null {
  if (!Array.isArray(targetMaterialPalette)) {
    return null;
  }

  const normalizedColors = [
    ...new Set(
      targetMaterialPalette
        .map((color) => normalizeSemanticColor(color))
        .filter((color): color is string => color !== null),
    ),
  ].slice(0, targetColorCount);

  if (normalizedColors.length < 2) {
    return null;
  }

  return normalizedColors.map((color) => new THREE.Color(color));
}

function findNearestTargetMaterialPaletteIndex(
  color: THREE.Color,
  palette: THREE.Color[],
): number {
  const roles = getTargetPaletteRoles(palette);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  const brightness = perceivedBrightness(color);
  const maxChannel = Math.max(color.r, color.g, color.b);

  if (roles.dark !== undefined && (maxChannel <= 0.24 || brightness <= 0.18)) {
    return roles.dark;
  }

  if (hsl.s >= 0.25) {
    if (roles.yellow !== undefined && isHueBetween(hsl.h, 0.11, 0.19)) {
      return roles.yellow;
    }

    if (roles.green !== undefined && isHueBetween(hsl.h, 0.19, 0.47)) {
      return roles.green;
    }
  }

  if (roles.lightNeutral !== undefined && hsl.s <= 0.22 && brightness >= 0.42) {
    return roles.lightNeutral;
  }

  return findNearestPaletteIndex(color, palette);
}

function getTargetPaletteRoles(palette: THREE.Color[]): {
  dark?: number;
  lightNeutral?: number;
  green?: number;
  yellow?: number;
} {
  const colorStats = palette.map((color, index) => {
    const hsl = { h: 0, s: 0, l: 0 };
    color.getHSL(hsl);
    return {
      index,
      hsl,
      brightness: perceivedBrightness(color),
    };
  });

  const dark = colorStats
    .slice()
    .sort((a, b) => a.brightness - b.brightness)[0]?.index;
  const lightNeutral =
    colorStats
      .filter((entry) => entry.hsl.s <= 0.24)
      .sort((a, b) => b.brightness - a.brightness)[0]?.index ??
    colorStats.slice().sort((a, b) => b.brightness - a.brightness)[0]?.index;
  const yellow = getClosestHueRole(colorStats, 0.16);
  const green = getClosestHueRole(colorStats, 0.27);

  return { dark, lightNeutral, green, yellow };
}

function getClosestHueRole(
  colorStats: Array<{
    index: number;
    hsl: { h: number; s: number; l: number };
    brightness: number;
  }>,
  targetHue: number,
): number | undefined {
  return colorStats
    .filter((entry) => entry.hsl.s >= 0.25)
    .sort(
      (a, b) =>
        getHueDistance(a.hsl.h, targetHue) - getHueDistance(b.hsl.h, targetHue),
    )[0]?.index;
}

function isHueBetween(hue: number, min: number, max: number): boolean {
  return hue >= min && hue < max;
}

function getHueDistance(a: number, b: number): number {
  const distance = Math.abs(a - b);
  return Math.min(distance, 1 - distance);
}

function recoverBadgeTargetMaterialRegions(
  triangles: ThreeMfTriangle[],
  vertices: VectorTuple[],
  palette: THREE.Color[],
): ThreeMfTriangle[] {
  if (triangles.length === 0 || palette.length < 4) {
    return triangles;
  }

  const roles = getTargetPaletteRoles(palette);
  if (
    roles.lightNeutral === undefined ||
    roles.green === undefined ||
    roles.dark === undefined
  ) {
    return triangles;
  }
  const lightNeutralColorIndex = roles.lightNeutral;
  const greenColorIndex = roles.green;
  const darkColorIndex = roles.dark;
  const yellowColorIndex = roles.yellow;

  const bounds = getVectorBounds(vertices);
  const frontTriangleStats = triangles
    .map((triangle) => ({
      triangle,
      normalZ: getTriangleNormalZ(vertices, triangle),
      centroid: getTriangleCentroid(vertices, triangle),
    }))
    .filter((stats) => stats.normalZ > 0.5);
  if (frontTriangleStats.length === 0) {
    return triangles;
  }

  const raisedZThreshold = getQuantile(
    frontTriangleStats.map((stats) => stats.centroid.z),
    0.76,
  );
  const adjacency = buildTriangleAdjacency(triangles);

  return triangles.map((triangle, triangleIndex) => {
    if (
      triangle.colorIndex === darkColorIndex ||
      triangle.colorIndex === yellowColorIndex ||
      triangle.colorIndex === greenColorIndex
    ) {
      return triangle;
    }

    if (triangle.colorIndex !== lightNeutralColorIndex) {
      return triangle;
    }

    const normalZ = getTriangleNormalZ(vertices, triangle);
    if (normalZ <= 0.5) {
      return triangle;
    }

    const centroid = getTriangleCentroid(vertices, triangle);
    if (
      hasNeighborWithColorIndex(
        adjacency,
        triangles,
        triangleIndex,
        darkColorIndex,
      ) ||
      centroid.z >= raisedZThreshold ||
      isNearProjectedOuterBadgeEdge(centroid, bounds)
    ) {
      return triangle;
    }

    return {
      ...triangle,
      colorIndex: greenColorIndex,
    };
  });
}

function recoverRaisedBadgeLetterRegions(
  triangles: ThreeMfTriangle[],
  vertices: VectorTuple[],
  palette: THREE.Color[],
): ThreeMfTriangle[] {
  if (triangles.length === 0 || palette.length < 4) {
    return triangles;
  }

  const roles = getTargetPaletteRoles(palette);
  if (roles.lightNeutral === undefined || roles.dark === undefined) {
    return triangles;
  }
  const lightNeutralColorIndex = roles.lightNeutral;
  const raisedLetterSourceColorIndexes = getRaisedLetterSourceColorIndexes(
    palette,
    roles,
  );
  if (raisedLetterSourceColorIndexes.size === 0) {
    return triangles;
  }

  const axes = getModelPrincipalAxes(vertices);
  const frontStats = triangles
    .map((triangle) => ({
      triangle,
      centroid: getTriangleCentroid(vertices, triangle),
      depthNormal: getTriangleNormalAxis(vertices, triangle, axes.depth),
    }))
    .filter((stats) => Math.abs(stats.depthNormal) > 0.45);

  if (frontStats.length === 0) {
    return triangles;
  }

  const frontDepths = frontStats.map((stats) =>
    stats.centroid.getComponent(axes.depth),
  );
  const frontDepthMin = Math.min(...frontDepths);
  const frontDepthMax = Math.max(...frontDepths);
  const frontDepthRange = frontDepthMax - frontDepthMin;
  if (frontDepthRange <= 1e-6) {
    return triangles;
  }
  const textDepthLowerThreshold = frontDepthMin + frontDepthRange * 0.22;
  const textDepthUpperThreshold = frontDepthMax - frontDepthRange * 0.22;
  const bounds = getVectorAxisBounds(vertices, axes);
  const ballMask = getProjectedBallMask(frontStats, axes, roles.dark, bounds);

  return triangles.map((triangle) => {
    if (!raisedLetterSourceColorIndexes.has(triangle.colorIndex)) {
      return triangle;
    }

    const centroid = getTriangleCentroid(vertices, triangle);
    if (!isWithinRaisedLetterBand(centroid, bounds, axes)) {
      return triangle;
    }

    if (ballMask && isInsideProjectedMask(centroid, axes, ballMask)) {
      return triangle;
    }

    const depthNormal = getTriangleNormalAxis(vertices, triangle, axes.depth);
    if (Math.abs(depthNormal) <= 0.45) {
      return triangle;
    }

    const depth = centroid.getComponent(axes.depth);
    if (depth > textDepthLowerThreshold && depth < textDepthUpperThreshold) {
      return triangle;
    }

    return {
      ...triangle,
      colorIndex: lightNeutralColorIndex,
    };
  });
}

function getRaisedLetterSourceColorIndexes(
  palette: THREE.Color[],
  roles: ReturnType<typeof getTargetPaletteRoles>,
): Set<number> {
  const colorIndexes = new Set<number>();
  if (roles.green !== undefined) {
    colorIndexes.add(roles.green);
  }
  if (roles.yellow !== undefined) {
    colorIndexes.add(roles.yellow);
  }

  palette.forEach((color, index) => {
    if (index === roles.lightNeutral || index === roles.dark) {
      return;
    }
    const hsl = { h: 0, s: 0, l: 0 };
    color.getHSL(hsl);
    if (hsl.s >= 0.2) {
      colorIndexes.add(index);
    }
  });

  return colorIndexes;
}

function getModelPrincipalAxes(vertices: VectorTuple[]): {
  horizontal: 0 | 1 | 2;
  vertical: 0 | 1 | 2;
  depth: 0 | 1 | 2;
} {
  const ranges = [0, 1, 2]
    .map((axis) => {
      const values = vertices.map((vertex) => vertex[axis]);
      return {
        axis: axis as 0 | 1 | 2,
        range: Math.max(...values) - Math.min(...values),
      };
    })
    .sort((a, b) => b.range - a.range);
  const faceAxes = ranges.slice(0, 2).map((entry) => entry.axis);
  return {
    horizontal: faceAxes.includes(0) ? 0 : faceAxes[0],
    vertical: faceAxes.includes(0)
      ? (faceAxes.find((axis) => axis !== 0) ?? faceAxes[1])
      : faceAxes[1],
    depth: ranges[2]?.axis ?? 1,
  };
}

function getVectorAxisBounds(
  vertices: VectorTuple[],
  axes: { horizontal: 0 | 1 | 2; vertical: 0 | 1 | 2 },
): {
  minHorizontal: number;
  maxHorizontal: number;
  minVertical: number;
  maxVertical: number;
} {
  return vertices.reduce(
    (bounds, vertex) => ({
      minHorizontal: Math.min(bounds.minHorizontal, vertex[axes.horizontal]),
      maxHorizontal: Math.max(bounds.maxHorizontal, vertex[axes.horizontal]),
      minVertical: Math.min(bounds.minVertical, vertex[axes.vertical]),
      maxVertical: Math.max(bounds.maxVertical, vertex[axes.vertical]),
    }),
    {
      minHorizontal: Number.POSITIVE_INFINITY,
      maxHorizontal: Number.NEGATIVE_INFINITY,
      minVertical: Number.POSITIVE_INFINITY,
      maxVertical: Number.NEGATIVE_INFINITY,
    },
  );
}

function isWithinRaisedLetterBand(
  centroid: THREE.Vector3,
  bounds: {
    minHorizontal: number;
    maxHorizontal: number;
    minVertical: number;
    maxVertical: number;
  },
  axes: { horizontal: 0 | 1 | 2; vertical: 0 | 1 | 2 },
): boolean {
  const centerHorizontal = (bounds.minHorizontal + bounds.maxHorizontal) / 2;
  const halfWidth = Math.max(
    (bounds.maxHorizontal - bounds.minHorizontal) / 2,
    1e-6,
  );
  const height = Math.max(bounds.maxVertical - bounds.minVertical, 1e-6);
  const horizontal = centroid.getComponent(axes.horizontal);
  const vertical = centroid.getComponent(axes.vertical);
  const normalizedHorizontal = Math.abs(
    (horizontal - centerHorizontal) / halfWidth,
  );
  const normalizedVertical = (vertical - bounds.minVertical) / height;

  return (
    normalizedHorizontal <= 0.78 &&
    normalizedVertical >= 0.38 &&
    normalizedVertical <= 0.82
  );
}

function getProjectedBallMask(
  frontStats: Array<{
    triangle: ThreeMfTriangle;
    centroid: THREE.Vector3;
  }>,
  axes: { horizontal: 0 | 1 | 2; vertical: 0 | 1 | 2 },
  darkColorIndex: number,
  modelBounds: {
    minHorizontal: number;
    maxHorizontal: number;
    minVertical: number;
    maxVertical: number;
  },
): {
  minHorizontal: number;
  maxHorizontal: number;
  minVertical: number;
  maxVertical: number;
} | null {
  const centerHorizontal =
    (modelBounds.minHorizontal + modelBounds.maxHorizontal) / 2;
  const halfWidth = Math.max(
    (modelBounds.maxHorizontal - modelBounds.minHorizontal) / 2,
    1e-6,
  );
  const height = Math.max(
    modelBounds.maxVertical - modelBounds.minVertical,
    1e-6,
  );
  const darkCentroids = frontStats
    .filter((stats) => {
      if (stats.triangle.colorIndex !== darkColorIndex) {
        return false;
      }
      const horizontal = stats.centroid.getComponent(axes.horizontal);
      const vertical = stats.centroid.getComponent(axes.vertical);
      const normalizedHorizontal = Math.abs(
        (horizontal - centerHorizontal) / halfWidth,
      );
      const normalizedVertical = (vertical - modelBounds.minVertical) / height;
      return normalizedHorizontal <= 0.72 && normalizedVertical <= 0.54;
    })
    .map((stats) => stats.centroid);
  if (darkCentroids.length === 0) {
    return null;
  }

  const bounds = darkCentroids.reduce(
    (currentBounds, centroid) => ({
      minHorizontal: Math.min(
        currentBounds.minHorizontal,
        centroid.getComponent(axes.horizontal),
      ),
      maxHorizontal: Math.max(
        currentBounds.maxHorizontal,
        centroid.getComponent(axes.horizontal),
      ),
      minVertical: Math.min(
        currentBounds.minVertical,
        centroid.getComponent(axes.vertical),
      ),
      maxVertical: Math.max(
        currentBounds.maxVertical,
        centroid.getComponent(axes.vertical),
      ),
    }),
    {
      minHorizontal: Number.POSITIVE_INFINITY,
      maxHorizontal: Number.NEGATIVE_INFINITY,
      minVertical: Number.POSITIVE_INFINITY,
      maxVertical: Number.NEGATIVE_INFINITY,
    },
  );
  const horizontalPadding =
    (bounds.maxHorizontal - bounds.minHorizontal) * 0.22;
  const verticalPadding = (bounds.maxVertical - bounds.minVertical) * 0.08;

  return {
    minHorizontal: bounds.minHorizontal - horizontalPadding,
    maxHorizontal: bounds.maxHorizontal + horizontalPadding,
    minVertical: bounds.minVertical - verticalPadding,
    maxVertical: Math.min(
      bounds.maxVertical + verticalPadding,
      modelBounds.minVertical + height * 0.54,
    ),
  };
}

function isInsideProjectedMask(
  centroid: THREE.Vector3,
  axes: { horizontal: 0 | 1 | 2; vertical: 0 | 1 | 2 },
  mask: {
    minHorizontal: number;
    maxHorizontal: number;
    minVertical: number;
    maxVertical: number;
  },
): boolean {
  const horizontal = centroid.getComponent(axes.horizontal);
  const vertical = centroid.getComponent(axes.vertical);
  return (
    horizontal >= mask.minHorizontal &&
    horizontal <= mask.maxHorizontal &&
    vertical >= mask.minVertical &&
    vertical <= mask.maxVertical
  );
}

function hasNeighborWithColorIndex(
  adjacency: number[][],
  triangles: ThreeMfTriangle[],
  triangleIndex: number,
  colorIndex: number | undefined,
): boolean {
  if (colorIndex === undefined) {
    return false;
  }

  return adjacency[triangleIndex].some(
    (neighborIndex) => triangles[neighborIndex]?.colorIndex === colorIndex,
  );
}

function getVectorBounds(vertices: VectorTuple[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  return vertices.reduce(
    (bounds, vertex) => ({
      minX: Math.min(bounds.minX, vertex[0]),
      maxX: Math.max(bounds.maxX, vertex[0]),
      minY: Math.min(bounds.minY, vertex[1]),
      maxY: Math.max(bounds.maxY, vertex[1]),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
}

function isNearProjectedOuterBadgeEdge(
  centroid: THREE.Vector3,
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  },
): boolean {
  const halfWidth = Math.max((bounds.maxX - bounds.minX) / 2, 1e-6);
  const halfHeight = Math.max((bounds.maxY - bounds.minY) / 2, 1e-6);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const normalizedX = Math.abs((centroid.x - centerX) / halfWidth);
  const normalizedY = Math.abs((centroid.y - centerY) / halfHeight);
  return Math.max(normalizedX, normalizedY) >= 0.78;
}

function getTriangleNormalZ(
  vertices: VectorTuple[],
  triangle: Pick<ThreeMfTriangle, 'v1' | 'v2' | 'v3'>,
): number {
  const a = vertices[triangle.v1];
  const b = vertices[triangle.v2];
  const c = vertices[triangle.v3];
  if (!a || !b || !c) {
    return 0;
  }

  const ab = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const ac = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const normal = ab.cross(ac);
  const length = normal.length();
  return length > 0 ? normal.z / length : 0;
}

function getTriangleNormalAxis(
  vertices: VectorTuple[],
  triangle: Pick<ThreeMfTriangle, 'v1' | 'v2' | 'v3'>,
  axis: 0 | 1 | 2,
): number {
  const a = vertices[triangle.v1];
  const b = vertices[triangle.v2];
  const c = vertices[triangle.v3];
  if (!a || !b || !c) {
    return 0;
  }

  const ab = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const ac = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const normal = ab.cross(ac);
  const length = normal.length();
  return length > 0 ? normal.getComponent(axis) / length : 0;
}

function getQuantile(values: number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sortedValues = values.slice().sort((a, b) => a - b);
  return sortedValues[
    clampIndex(
      Math.ceil((sortedValues.length - 1) * quantile),
      sortedValues.length,
    )
  ];
}

function isUsableSemanticMaterialMap(
  semanticMaterialMap: ThreeMfSemanticMaterialMap | null | undefined,
  triangleCount: number,
): semanticMaterialMap is ThreeMfSemanticMaterialMap {
  return (
    !!semanticMaterialMap &&
    Array.isArray(semanticMaterialMap.classes) &&
    Array.isArray(semanticMaterialMap.triangleMaterialIds) &&
    semanticMaterialMap.triangleMaterialIds.length === triangleCount
  );
}

function normalizeSemanticColor(color: string): string | null {
  const match = color.trim().match(/^#?([0-9a-fA-F]{6})$/);
  return match ? `#${match[1].toUpperCase()}` : null;
}

function smoothTriangleColorIndexes(
  triangles: ThreeMfTriangle[],
  palette: THREE.Color[],
  {
    smoothingIterations = 3,
    smallColorIslandTriangleCount = SMALL_COLOR_ISLAND_TRIANGLE_COUNT,
    similarColorIslandDistanceSquared = SIMILAR_COLOR_ISLAND_DISTANCE_SQUARED,
  }: {
    smoothingIterations?: number;
    smallColorIslandTriangleCount?: number;
    similarColorIslandDistanceSquared?: number;
  } = {},
): ThreeMfTriangle[] {
  if (
    triangles.length === 0 ||
    palette.length <= 1 ||
    smoothingIterations <= 0 ||
    smallColorIslandTriangleCount <= 0
  ) {
    return triangles;
  }

  const adjacency = buildTriangleAdjacency(triangles);
  const colorIndexes = triangles.map((triangle) => triangle.colorIndex);

  for (let iteration = 0; iteration < smoothingIterations; iteration += 1) {
    let changed = false;
    const components = getSameColorTriangleComponents(colorIndexes, adjacency);

    for (const component of components) {
      if (component.triangleIndexes.length > smallColorIslandTriangleCount) {
        continue;
      }

      const neighborCounts = new Map<number, number>();
      for (const triangleIndex of component.triangleIndexes) {
        for (const neighborIndex of adjacency[triangleIndex]) {
          const neighborColorIndex = colorIndexes[neighborIndex];
          if (neighborColorIndex !== component.colorIndex) {
            neighborCounts.set(
              neighborColorIndex,
              (neighborCounts.get(neighborColorIndex) ?? 0) + 1,
            );
          }
        }
      }

      const replacement = [...neighborCounts.entries()].sort(
        (a, b) => b[1] - a[1],
      )[0];
      if (!replacement) {
        continue;
      }

      const [replacementColorIndex] = replacement;
      const isSimilarColorIsland =
        colorDistanceSquared(
          palette[component.colorIndex],
          palette[replacementColorIndex],
        ) <= similarColorIslandDistanceSquared;
      if (!isSimilarColorIsland) {
        continue;
      }

      for (const triangleIndex of component.triangleIndexes) {
        colorIndexes[triangleIndex] = replacementColorIndex;
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  return triangles.map((triangle, index) => ({
    ...triangle,
    colorIndex: colorIndexes[index],
  }));
}

function removeUnusedPaletteEntries(
  palette: THREE.Color[],
  triangles: ThreeMfTriangle[],
): { palette: THREE.Color[]; triangles: ThreeMfTriangle[] } {
  const usedIndexes = [
    ...new Set(triangles.map((triangle) => triangle.colorIndex)),
  ].sort((a, b) => a - b);
  const remap = new Map<number, number>();
  usedIndexes.forEach((sourceIndex, targetIndex) => {
    remap.set(sourceIndex, targetIndex);
  });

  return {
    palette: usedIndexes.map((index) => palette[index].clone()),
    triangles: triangles.map((triangle) => ({
      ...triangle,
      colorIndex: remap.get(triangle.colorIndex) ?? 0,
    })),
  };
}

function buildTriangleAdjacency(
  triangles: Array<Omit<ThreeMfTriangle, 'colorIndex'>>,
): number[][] {
  const edgeToTriangleIndexes = new Map<string, number[]>();
  triangles.forEach((triangle, triangleIndex) => {
    for (const [a, b] of [
      [triangle.v1, triangle.v2],
      [triangle.v2, triangle.v3],
      [triangle.v3, triangle.v1],
    ]) {
      const edgeKey = getEdgeKey(a, b);
      const triangleIndexes = edgeToTriangleIndexes.get(edgeKey) ?? [];
      triangleIndexes.push(triangleIndex);
      edgeToTriangleIndexes.set(edgeKey, triangleIndexes);
    }
  });

  const adjacency = Array.from(
    { length: triangles.length },
    () => new Set<number>(),
  );
  for (const triangleIndexes of edgeToTriangleIndexes.values()) {
    for (const triangleIndex of triangleIndexes) {
      for (const neighborIndex of triangleIndexes) {
        if (triangleIndex !== neighborIndex) {
          adjacency[triangleIndex].add(neighborIndex);
        }
      }
    }
  }

  return adjacency.map((neighbors) => [...neighbors]);
}

function getSameColorTriangleComponents(
  colorIndexes: number[],
  adjacency: number[][],
): Array<{ colorIndex: number; triangleIndexes: number[] }> {
  const visited = new Set<number>();
  const components: Array<{ colorIndex: number; triangleIndexes: number[] }> =
    [];

  for (
    let triangleIndex = 0;
    triangleIndex < colorIndexes.length;
    triangleIndex += 1
  ) {
    if (visited.has(triangleIndex)) {
      continue;
    }

    const colorIndex = colorIndexes[triangleIndex];
    const component = { colorIndex, triangleIndexes: [] as number[] };
    const stack = [triangleIndex];
    visited.add(triangleIndex);

    while (stack.length > 0) {
      const currentIndex = stack.pop() as number;
      component.triangleIndexes.push(currentIndex);

      for (const neighborIndex of adjacency[currentIndex]) {
        if (
          !visited.has(neighborIndex) &&
          colorIndexes[neighborIndex] === colorIndex
        ) {
          visited.add(neighborIndex);
          stack.push(neighborIndex);
        }
      }
    }

    components.push(component);
  }

  return components;
}

function colorDistanceSquared(a: THREE.Color, b: THREE.Color): number {
  return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
}

function isDegenerateTriangle(
  triangle: Pick<ThreeMfTriangle, 'v1' | 'v2' | 'v3'>,
  vertices: VectorTuple[],
): boolean {
  return (
    getTriangleAreaSquared(vertices, triangle) <=
    DEGENERATE_TRIANGLE_AREA_SQUARED
  );
}

function getTriangleArea(
  vertices: VectorTuple[],
  triangle: Pick<ThreeMfTriangle, 'v1' | 'v2' | 'v3'>,
): number {
  return Math.sqrt(getTriangleAreaSquared(vertices, triangle)) / 2;
}

function getTriangleAreaSquared(
  vertices: VectorTuple[],
  triangle: Pick<ThreeMfTriangle, 'v1' | 'v2' | 'v3'>,
): number {
  const a = vertices[triangle.v1];
  const b = vertices[triangle.v2];
  const c = vertices[triangle.v3];

  if (!a || !b || !c) {
    return 0;
  }

  const ab = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const ac = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  return ab.cross(ac).lengthSq();
}

function sampleTriangleColor({
  material,
  colorAttribute,
  uvAttribute,
  vertexIndices,
}: {
  material: THREE.Material;
  colorAttribute?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  uvAttribute?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  vertexIndices: [number, number, number];
}): THREE.Color {
  const materialColor = getMaterialColor(material);
  const textureColor = sampleTextureColor(material, uvAttribute, vertexIndices);
  const vertexColor = sampleVertexColor(colorAttribute, vertexIndices);

  if (textureColor && vertexColor) {
    return textureColor.multiply(vertexColor).multiply(materialColor);
  }

  if (textureColor) {
    return textureColor.multiply(materialColor);
  }

  if (vertexColor) {
    return vertexColor.multiply(materialColor);
  }

  return materialColor;
}

function subdivideTexturedTriangleForColorDetail({
  material,
  colorAttribute,
  uvAttribute,
  position,
  matrixWorld,
  vertexIndices,
  textureDetailEdgeSegments,
}: {
  material: THREE.Material;
  colorAttribute?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  uvAttribute?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  matrixWorld: THREE.Matrix4;
  vertexIndices: [number, number, number];
  textureDetailEdgeSegments: Map<string, number> | null;
}): Array<{
  vertices: [VectorTuple, VectorTuple, VectorTuple];
  color: THREE.Color;
}> | null {
  if (!uvAttribute || !('map' in material)) {
    return null;
  }

  const texture = material.map;
  if (!(texture instanceof THREE.Texture)) {
    return null;
  }

  const pixels = getTexturePixels(texture);
  if (!pixels) {
    return null;
  }

  const uvs: [THREE.Vector2, THREE.Vector2, THREE.Vector2] = vertexIndices.map(
    (vertexIndex) => readUv(uvAttribute, vertexIndex),
  ) as [THREE.Vector2, THREE.Vector2, THREE.Vector2];
  const sourceVertices: [VectorTuple, VectorTuple, VectorTuple] =
    vertexIndices.map((vertexIndex) =>
      readWorldVertex(position, vertexIndex, matrixWorld),
    ) as [VectorTuple, VectorTuple, VectorTuple];
  const patches = getTexturedTriangleBoundaryPatches({
    vertices: sourceVertices,
    uvs,
    edgeSegments: getTextureDetailTriangleEdgeSegments(
      sourceVertices,
      textureDetailEdgeSegments,
    ),
  });
  if (patches.length <= 1) {
    return null;
  }

  const materialColor = getMaterialColor(material);
  const vertexColor = sampleVertexColor(colorAttribute, vertexIndices);

  return patches.map((patch) => {
    const color = sampleTextureUvTriangleColor(
      texture,
      pixels,
      patch.uvs,
    ).multiply(materialColor);

    if (vertexColor) {
      color.multiply(vertexColor);
    }

    return {
      vertices: patch.vertices,
      color,
    };
  });
}

function sampleTextureColor(
  material: THREE.Material,
  uvAttribute:
    | THREE.BufferAttribute
    | THREE.InterleavedBufferAttribute
    | undefined,
  vertexIndices: [number, number, number],
): THREE.Color | null {
  if (!uvAttribute || !('map' in material)) {
    return null;
  }

  const texture = material.map;
  if (!(texture instanceof THREE.Texture)) {
    return null;
  }

  const pixels = getTexturePixels(texture);
  if (!pixels) {
    return null;
  }

  try {
    const uvs = vertexIndices.map((vertexIndex) =>
      readUv(uvAttribute, vertexIndex),
    ) as [THREE.Vector2, THREE.Vector2, THREE.Vector2];
    return sampleTextureUvTriangleColor(texture, pixels, uvs);
  } catch {
    return null;
  }
}

function sampleTextureUvTriangleColor(
  texture: THREE.Texture,
  pixels: TexturePixels,
  uvs: [THREE.Vector2, THREE.Vector2, THREE.Vector2],
): THREE.Color {
  const samples = TEXTURE_TRIANGLE_SAMPLE_BARYCENTRICS.map(
    (barycentricWeights) => {
      const uv = interpolateUv(uvs, barycentricWeights);
      return getTexturePixelColor(pixels, uv.x, uv.y, texture.flipY);
    },
  );

  return getDominantTextureSampleColor(samples);
}

function readUv(
  uvAttribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  vertexIndex: number,
): THREE.Vector2 {
  return new THREE.Vector2(
    uvAttribute.getX(vertexIndex),
    uvAttribute.getY(vertexIndex),
  );
}

function getTexturePixelColor(
  pixels: TexturePixels,
  textureU: number,
  textureV: number,
  flipY: boolean,
): THREE.Color {
  const wrapU = wrapTextureCoordinate(textureU);
  const wrapV = wrapTextureCoordinate(textureV);
  const x = Math.min(
    pixels.width - 1,
    Math.max(0, Math.floor(wrapU * pixels.width)),
  );
  const sampledV = flipY ? 1 - wrapV : wrapV;
  const y = Math.min(
    pixels.height - 1,
    Math.max(0, Math.floor(sampledV * pixels.height)),
  );
  const offset = (y * pixels.width + x) * 4;
  return new THREE.Color(
    pixels.data[offset] / 255,
    pixels.data[offset + 1] / 255,
    pixels.data[offset + 2] / 255,
  );
}

function getUvPixelDistance(
  pixels: TexturePixels,
  left: THREE.Vector2,
  right: THREE.Vector2,
): number {
  return Math.hypot(
    (left.x - right.x) * pixels.width,
    (left.y - right.y) * pixels.height,
  );
}

function buildTextureDetailEdgeSegments({
  geometry,
  groups,
  materials,
  uvAttribute,
  position,
  matrixWorld,
  subdivisionPixelSpan = TEXTURE_DETAIL_SUBDIVISION_PIXEL_SPAN,
  maxSubdivisionLevel = TEXTURE_DETAIL_MAX_SUBDIVISION_LEVEL,
}: {
  geometry: THREE.BufferGeometry;
  groups: Array<{ start: number; count: number; materialIndex?: number }>;
  materials: THREE.Material[];
  uvAttribute?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  matrixWorld: THREE.Matrix4;
  subdivisionPixelSpan?: number;
  maxSubdivisionLevel?: number;
}): Map<string, number> | null {
  if (!uvAttribute) {
    return null;
  }

  const edgeSegments = new Map<string, number>();
  for (const group of groups) {
    const material = materials[group.materialIndex ?? 0] ?? materials[0];
    if (!('map' in material) || !(material.map instanceof THREE.Texture)) {
      continue;
    }

    const pixels = getTexturePixels(material.map);
    if (!pixels) {
      continue;
    }

    const end = group.start + group.count;
    for (let offset = group.start; offset + 2 < end; offset += 3) {
      const vertexIndices: [number, number, number] = [
        getVertexIndex(geometry, offset),
        getVertexIndex(geometry, offset + 1),
        getVertexIndex(geometry, offset + 2),
      ];
      const uvs = vertexIndices.map((vertexIndex) =>
        readUv(uvAttribute, vertexIndex),
      ) as [THREE.Vector2, THREE.Vector2, THREE.Vector2];
      const vertices = vertexIndices.map((vertexIndex) =>
        readWorldVertex(position, vertexIndex, matrixWorld),
      ) as [VectorTuple, VectorTuple, VectorTuple];

      for (const [leftIndex, rightIndex] of [
        [0, 1],
        [1, 2],
        [2, 0],
      ] as Array<[number, number]>) {
        const segmentCount = getTextureDetailSegmentCount(
          getUvPixelDistance(pixels, uvs[leftIndex], uvs[rightIndex]),
          subdivisionPixelSpan,
          maxSubdivisionLevel,
        );
        if (segmentCount <= 1) {
          continue;
        }

        const edgeKey = getWorldEdgeKey(
          vertices[leftIndex],
          vertices[rightIndex],
        );
        edgeSegments.set(
          edgeKey,
          Math.max(edgeSegments.get(edgeKey) ?? 1, segmentCount),
        );
      }
    }
  }

  return edgeSegments.size > 0 ? edgeSegments : null;
}

function getTextureDetailSegmentCount(
  pixelDistance: number,
  subdivisionPixelSpan: number = TEXTURE_DETAIL_SUBDIVISION_PIXEL_SPAN,
  maxSubdivisionLevel: number = TEXTURE_DETAIL_MAX_SUBDIVISION_LEVEL,
): number {
  let segmentCount = 1;
  let reducedDistance = pixelDistance;

  while (
    reducedDistance > subdivisionPixelSpan &&
    segmentCount < 2 ** maxSubdivisionLevel
  ) {
    segmentCount *= 2;
    reducedDistance /= 2;
  }

  return segmentCount;
}

function getTextureDetailTriangleEdgeSegments(
  vertices: [VectorTuple, VectorTuple, VectorTuple],
  textureDetailEdgeSegments: Map<string, number> | null,
): [number, number, number] {
  if (!textureDetailEdgeSegments) {
    return [1, 1, 1];
  }

  return [
    textureDetailEdgeSegments.get(getWorldEdgeKey(vertices[0], vertices[1])) ??
      1,
    textureDetailEdgeSegments.get(getWorldEdgeKey(vertices[1], vertices[2])) ??
      1,
    textureDetailEdgeSegments.get(getWorldEdgeKey(vertices[2], vertices[0])) ??
      1,
  ];
}

function getTexturedTriangleBoundaryPatches({
  vertices,
  uvs,
  edgeSegments,
}: {
  vertices: [VectorTuple, VectorTuple, VectorTuple];
  uvs: [THREE.Vector2, THREE.Vector2, THREE.Vector2];
  edgeSegments: [number, number, number];
}): TexturedTrianglePatch[] {
  return subdivideTexturedTrianglePatchByEdgeSegments(
    {
      vertices,
      uvs,
      barycentric: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    },
    edgeSegments,
    0,
  );
}

function subdivideTexturedTrianglePatchByEdgeSegments(
  patch: TexturedTrianglePatch,
  edgeSegments: [number, number, number],
  depth: number,
): TexturedTrianglePatch[] {
  if (depth > TEXTURE_DETAIL_MAX_SUBDIVISION_LEVEL * 12) {
    return [patch];
  }

  const splitEdgeIndex = getPatchBoundarySplitEdgeIndex(
    patch.barycentric,
    edgeSegments,
  );
  if (splitEdgeIndex === null) {
    return [patch];
  }

  return splitTexturedTrianglePatch(patch, splitEdgeIndex).flatMap(
    (childPatch) =>
      subdivideTexturedTrianglePatchByEdgeSegments(
        childPatch,
        edgeSegments,
        depth + 1,
      ),
  );
}

function getPatchBoundarySplitEdgeIndex(
  barycentric: [VectorTuple, VectorTuple, VectorTuple],
  edgeSegments: [number, number, number],
): number | null {
  let bestPatchEdgeIndex: number | null = null;
  let bestSpan = 1 + 1e-6;

  for (const [patchEdgeIndex, [leftIndex, rightIndex]] of [
    [0, [0, 1]],
    [1, [1, 2]],
    [2, [2, 0]],
  ] as Array<[number, [number, number]]>) {
    const sourceEdgeIndex = getSourceBoundaryEdgeIndex(
      barycentric[leftIndex],
      barycentric[rightIndex],
    );
    if (sourceEdgeIndex === null) {
      continue;
    }

    const span =
      getSourceBoundaryEdgeSpan(
        barycentric[leftIndex],
        barycentric[rightIndex],
        sourceEdgeIndex,
      ) * edgeSegments[sourceEdgeIndex];
    if (span > bestSpan) {
      bestSpan = span;
      bestPatchEdgeIndex = patchEdgeIndex;
    }
  }

  return bestPatchEdgeIndex;
}

function getSourceBoundaryEdgeIndex(
  left: VectorTuple,
  right: VectorTuple,
): number | null {
  const epsilon = 1e-8;
  if (Math.abs(left[2]) <= epsilon && Math.abs(right[2]) <= epsilon) {
    return 0;
  }

  if (Math.abs(left[0]) <= epsilon && Math.abs(right[0]) <= epsilon) {
    return 1;
  }

  if (Math.abs(left[1]) <= epsilon && Math.abs(right[1]) <= epsilon) {
    return 2;
  }

  return null;
}

function getSourceBoundaryEdgeSpan(
  left: VectorTuple,
  right: VectorTuple,
  sourceEdgeIndex: number,
): number {
  if (sourceEdgeIndex === 0) {
    return Math.abs(left[1] - right[1]);
  }

  if (sourceEdgeIndex === 1) {
    return Math.abs(left[2] - right[2]);
  }

  return Math.abs(left[0] - right[0]);
}

function splitTexturedTrianglePatch(
  patch: TexturedTrianglePatch,
  edgeIndex: number,
): [TexturedTrianglePatch, TexturedTrianglePatch] {
  const edgeVertexIndexes = [
    [0, 1],
    [1, 2],
    [2, 0],
  ][edgeIndex] as [number, number];
  const midpointVertex = midpointVectorTuple(
    patch.vertices[edgeVertexIndexes[0]],
    patch.vertices[edgeVertexIndexes[1]],
  );
  const midpointUv = patch.uvs[edgeVertexIndexes[0]]
    .clone()
    .add(patch.uvs[edgeVertexIndexes[1]])
    .multiplyScalar(0.5);
  const midpointBarycentric = midpointVectorTuple(
    patch.barycentric[edgeVertexIndexes[0]],
    patch.barycentric[edgeVertexIndexes[1]],
  );

  if (edgeIndex === 0) {
    return [
      {
        vertices: [patch.vertices[0], midpointVertex, patch.vertices[2]],
        uvs: [patch.uvs[0], midpointUv, patch.uvs[2]],
        barycentric: [
          patch.barycentric[0],
          midpointBarycentric,
          patch.barycentric[2],
        ],
      },
      {
        vertices: [midpointVertex, patch.vertices[1], patch.vertices[2]],
        uvs: [midpointUv, patch.uvs[1], patch.uvs[2]],
        barycentric: [
          midpointBarycentric,
          patch.barycentric[1],
          patch.barycentric[2],
        ],
      },
    ];
  }

  if (edgeIndex === 1) {
    return [
      {
        vertices: [patch.vertices[0], patch.vertices[1], midpointVertex],
        uvs: [patch.uvs[0], patch.uvs[1], midpointUv],
        barycentric: [
          patch.barycentric[0],
          patch.barycentric[1],
          midpointBarycentric,
        ],
      },
      {
        vertices: [patch.vertices[0], midpointVertex, patch.vertices[2]],
        uvs: [patch.uvs[0], midpointUv, patch.uvs[2]],
        barycentric: [
          patch.barycentric[0],
          midpointBarycentric,
          patch.barycentric[2],
        ],
      },
    ];
  }

  return [
    {
      vertices: [patch.vertices[1], patch.vertices[2], midpointVertex],
      uvs: [patch.uvs[1], patch.uvs[2], midpointUv],
      barycentric: [
        patch.barycentric[1],
        patch.barycentric[2],
        midpointBarycentric,
      ],
    },
    {
      vertices: [patch.vertices[1], midpointVertex, patch.vertices[0]],
      uvs: [patch.uvs[1], midpointUv, patch.uvs[0]],
      barycentric: [
        patch.barycentric[1],
        midpointBarycentric,
        patch.barycentric[0],
      ],
    },
  ];
}

function midpointVectorTuple(
  left: VectorTuple,
  right: VectorTuple,
): VectorTuple {
  return [
    (left[0] + right[0]) / 2,
    (left[1] + right[1]) / 2,
    (left[2] + right[2]) / 2,
  ];
}

function interpolateUv(
  uvs: [THREE.Vector2, THREE.Vector2, THREE.Vector2],
  barycentric: VectorTuple,
): THREE.Vector2 {
  return new THREE.Vector2(
    uvs[0].x * barycentric[0] +
      uvs[1].x * barycentric[1] +
      uvs[2].x * barycentric[2],
    uvs[0].y * barycentric[0] +
      uvs[1].y * barycentric[1] +
      uvs[2].y * barycentric[2],
  );
}

function getDominantTextureSampleColor(samples: THREE.Color[]): THREE.Color {
  const average = getAverageColor(samples);
  const buckets = new Map<
    string,
    { color: THREE.Color; count: number; firstIndex: number }
  >();

  samples.forEach((sample, index) => {
    const key = getTextureSampleBucketKey(sample);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.color.add(sample);
      bucket.count += 1;
      return;
    }

    buckets.set(key, {
      color: sample.clone(),
      count: 1,
      firstIndex: index,
    });
  });

  const dominantBucket = [...buckets.values()].sort(
    (a, b) =>
      b.count - a.count ||
      getColorDistanceSquared(getAverageBucketColor(a), average) -
        getColorDistanceSquared(getAverageBucketColor(b), average) ||
      a.firstIndex - b.firstIndex,
  )[0];

  if (
    dominantBucket &&
    dominantBucket.count >= TEXTURE_DOMINANT_BUCKET_MIN_SAMPLES &&
    dominantBucket.count / samples.length >= TEXTURE_DOMINANT_BUCKET_MIN_SHARE
  ) {
    return getAverageBucketColor(dominantBucket);
  }

  return average;
}

function getAverageColor(samples: THREE.Color[]): THREE.Color {
  const average = new THREE.Color(0, 0, 0);
  for (const sample of samples) {
    average.add(sample);
  }
  return average.multiplyScalar(1 / Math.max(1, samples.length));
}

function getAverageBucketColor(bucket: { color: THREE.Color; count: number }) {
  return bucket.color.clone().multiplyScalar(1 / Math.max(1, bucket.count));
}

function getTextureSampleBucketKey(color: THREE.Color): string {
  return [
    Math.round(color.r * TEXTURE_SAMPLE_BUCKET_SCALE),
    Math.round(color.g * TEXTURE_SAMPLE_BUCKET_SCALE),
    Math.round(color.b * TEXTURE_SAMPLE_BUCKET_SCALE),
  ].join('-');
}

function getColorDistanceSquared(a: THREE.Color, b: THREE.Color): number {
  return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
}

function getTexturePixels(texture: THREE.Texture): TexturePixels | null {
  if (texturePixelCache.has(texture)) {
    return texturePixelCache.get(texture) ?? null;
  }

  const image = texture.image as
    | HTMLImageElement
    | HTMLCanvasElement
    | ImageBitmap
    | undefined;
  if (!image || !('width' in image) || !('height' in image)) {
    texturePixelCache.set(texture, null);
    return null;
  }

  if (typeof document === 'undefined') {
    texturePixelCache.set(texture, null);
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    texturePixelCache.set(texture, null);
    return null;
  }

  try {
    context.drawImage(image, 0, 0);
    const imageData = context.getImageData(0, 0, image.width, image.height);
    const pixels = {
      data: imageData.data,
      width: image.width,
      height: image.height,
    };
    texturePixelCache.set(texture, pixels);
    return pixels;
  } catch {
    texturePixelCache.set(texture, null);
    return null;
  }
}

function sampleVertexColor(
  colorAttribute:
    | THREE.BufferAttribute
    | THREE.InterleavedBufferAttribute
    | undefined,
  vertexIndices: [number, number, number],
): THREE.Color | null {
  if (!colorAttribute) {
    return null;
  }

  const color = new THREE.Color();
  for (const vertexIndex of vertexIndices) {
    color.r += colorAttribute.getX(vertexIndex);
    color.g += colorAttribute.getY(vertexIndex);
    color.b += colorAttribute.getZ(vertexIndex);
  }

  color.multiplyScalar(1 / vertexIndices.length);
  return color;
}

function getMaterialColor(material: THREE.Material): THREE.Color {
  if ('color' in material && material.color instanceof THREE.Color) {
    return material.color.clone();
  }

  return new THREE.Color(0.8, 0.8, 0.8);
}

// Baseline perceptual gap (in the 0..1 luminance-weighted RGB metric) that two
// filament colors must keep at the strictest, low color counts. At high counts
// the user has explicitly asked for many shades, so near-duplicates are allowed.
const PALETTE_MIN_SEPARATION = 0.14;
const PALETTE_MERGE_ROUNDS = 4;

// Minimum separation required between palette colors, scaled by the requested
// count: strict for <= 4, relaxed linearly across 5-7, and disabled at >= 8.
function paletteMinSeparation(colorCount: number): number {
  if (colorCount >= 8) {
    return 0;
  }
  const relaxation = Math.min(1, Math.max(0, (8 - colorCount) / 4));
  return PALETTE_MIN_SEPARATION * relaxation;
}

// Luminance-weighted squared RGB distance (same 0.299/0.587/0.114 channel
// weights as perceivedBrightness) so a shift in green counts more than blue.
// Used only for the near-duplicate/separation logic; triangle-to-palette
// assignment still uses findNearestPaletteIndex's plain RGB distance.
function weightedColorDistanceSq(a: THREE.Color, b: THREE.Color): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return 0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db;
}

function aggregateSamplesByColor(samples: ColorSample[]): ColorSample[] {
  const byHex = new Map<string, ColorSample>();
  for (const sample of samples) {
    const hex = colorToHex(sample.color);
    const existing = byHex.get(hex);
    if (existing) {
      existing.weight += sample.weight;
    } else {
      byHex.set(hex, { color: sample.color.clone(), weight: sample.weight });
    }
  }
  return [...byHex.values()];
}

function mergeColorsByWeight(
  a: THREE.Color,
  weightA: number,
  b: THREE.Color,
  weightB: number,
): THREE.Color {
  const total = weightA + weightB;
  if (total <= 0) {
    return a.clone();
  }
  return new THREE.Color(
    (a.r * weightA + b.r * weightB) / total,
    (a.g * weightA + b.g * weightB) / total,
    (a.b * weightA + b.b * weightB) / total,
  );
}

// Collapse any weighted colors closer than the separation threshold into a
// single weight-proportional color, repeating until every remaining pair is
// distinct. Returns fewer colors rather than near-duplicates.
function collapseNearDuplicateColors(
  entries: ColorSample[],
  minSeparationSq: number,
): ColorSample[] {
  if (minSeparationSq <= 0) {
    return entries;
  }
  const merged = entries.map((entry) => ({
    color: entry.color.clone(),
    weight: entry.weight,
  }));
  while (merged.length > 1) {
    let closestPair: [number, number] | null = null;
    let closestDistanceSq = minSeparationSq;
    for (let i = 0; i < merged.length; i += 1) {
      for (let j = i + 1; j < merged.length; j += 1) {
        const distanceSq = weightedColorDistanceSq(
          merged[i].color,
          merged[j].color,
        );
        if (distanceSq < closestDistanceSq) {
          closestDistanceSq = distanceSq;
          closestPair = [i, j];
        }
      }
    }
    if (!closestPair) {
      break;
    }
    const [i, j] = closestPair;
    merged[i] = {
      color: mergeColorsByWeight(
        merged[i].color,
        merged[i].weight,
        merged[j].color,
        merged[j].weight,
      ),
      weight: merged[i].weight + merged[j].weight,
    };
    merged.splice(j, 1);
  }
  return merged;
}

function refineCentroids(
  centroids: THREE.Color[],
  samples: ColorSample[],
  iterations: number,
): void {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const buckets = centroids.map(() => ({
      color: new THREE.Color(0, 0, 0),
      weight: 0,
    }));

    for (const sample of samples) {
      const index = findNearestPaletteIndex(sample.color, centroids);
      buckets[index].color.r += sample.color.r * sample.weight;
      buckets[index].color.g += sample.color.g * sample.weight;
      buckets[index].color.b += sample.color.b * sample.weight;
      buckets[index].weight += sample.weight;
    }

    buckets.forEach((bucket, index) => {
      if (bucket.weight > 0) {
        centroids[index].setRGB(
          bucket.color.r / bucket.weight,
          bucket.color.g / bucket.weight,
          bucket.color.b / bucket.weight,
        );
      }
    });
  }
}

function computeCentroidWeights(
  centroids: THREE.Color[],
  samples: ColorSample[],
): number[] {
  const weights = centroids.map(() => 0);
  for (const sample of samples) {
    const index = findNearestPaletteIndex(sample.color, centroids);
    weights[index] += sample.weight;
  }
  return weights;
}

// Pick the color that best fills a freed slot: the one furthest from every
// current centroid, scaled by its weight so a few stray pixels can't claim a
// filament while a small-but-distinct region (e.g. black eye outlines) still
// can. Returns null when nothing is separated enough to deserve its own slot.
function findReseedColor(
  weightedColors: ColorSample[],
  centroids: THREE.Color[],
  minSeparationSq: number,
): THREE.Color | null {
  let best: THREE.Color | null = null;
  let bestScore = 0;
  for (const entry of weightedColors) {
    let nearestDistanceSq = Number.POSITIVE_INFINITY;
    for (const centroid of centroids) {
      const distanceSq = weightedColorDistanceSq(entry.color, centroid);
      if (distanceSq < nearestDistanceSq) {
        nearestDistanceSq = distanceSq;
      }
    }
    if (nearestDistanceSq < minSeparationSq) {
      continue;
    }
    const score = nearestDistanceSq * entry.weight;
    if (score > bestScore) {
      bestScore = score;
      best = entry.color;
    }
  }
  return best;
}

// Palette detection only needs a statistically representative sample of the
// triangle colors, not every triangle. Large textured meshes produce millions
// of samples, and centroid refinement over all of them blocks the UI thread
// for tens of seconds. A deterministic stride downsample keeps every region's
// share of the distribution (small regions keep proportional representation)
// while bounding the total palette work to a constant regardless of mesh size.
const MAX_QUANTIZE_REFINEMENT_SAMPLES = 50_000;

// Golden-ratio stepping instead of a fixed stride: triangle order often has
// periodic structure (repeating strips, tiled UV islands), and a fixed stride
// can resonate with that period and sample only one region. The irrational
// step visits a low-discrepancy permutation of the index range, so every
// region keeps proportional representation. Deterministic — no Math.random.
const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949;

function downsampleColorSamples(samples: ColorSample[]): ColorSample[] {
  if (samples.length <= MAX_QUANTIZE_REFINEMENT_SAMPLES) {
    return samples;
  }
  const picked: ColorSample[] = [];
  let position = 0;
  for (let i = 0; i < MAX_QUANTIZE_REFINEMENT_SAMPLES; i += 1) {
    position += GOLDEN_RATIO_CONJUGATE;
    position -= Math.floor(position);
    picked.push(samples[Math.floor(position * samples.length)]);
  }
  return picked;
}

export function quantizeTriangleColors(
  samples: ColorSample[],
  colorCount: number,
): THREE.Color[] {
  if (samples.length === 0) {
    return [new THREE.Color(0.8, 0.8, 0.8)];
  }

  const minSeparationSq = paletteMinSeparation(colorCount) ** 2;
  samples = downsampleColorSamples(samples);
  const weightedColors = aggregateSamplesByColor(samples);

  if (weightedColors.length <= colorCount) {
    return collapseNearDuplicateColors(weightedColors, minSeparationSq).map(
      (entry) => entry.color,
    );
  }

  const sortedColors = weightedColors
    .map((entry) => entry.color)
    .sort((a, b) => perceivedBrightness(a) - perceivedBrightness(b));
  const centroids = Array.from({ length: colorCount }, (_, index) => {
    const sourceIndex =
      colorCount === 1
        ? Math.floor(sortedColors.length / 2)
        : Math.round((index * (sortedColors.length - 1)) / (colorCount - 1));
    return sortedColors[sourceIndex].clone();
  });

  while (centroids.length < colorCount) {
    centroids.push(weightedColors[centroids.length].color.clone());
  }

  refineCentroids(centroids, samples, 8);

  // Two centroids closer than the (count-scaled) threshold would spend two
  // filament slots on the same visual color. Merge the closest such pair, then
  // try to re-seed the freed slot at the most distinct remaining color so a
  // small distinct region wins the slot instead of a second shade of the
  // dominant color. Bounded rounds guarantee termination.
  if (minSeparationSq > 0) {
    for (let round = 0; round < PALETTE_MERGE_ROUNDS; round += 1) {
      let closestPair: [number, number] | null = null;
      let closestDistanceSq = minSeparationSq;
      for (let i = 0; i < centroids.length; i += 1) {
        for (let j = i + 1; j < centroids.length; j += 1) {
          const distanceSq = weightedColorDistanceSq(
            centroids[i],
            centroids[j],
          );
          if (distanceSq < closestDistanceSq) {
            closestDistanceSq = distanceSq;
            closestPair = [i, j];
          }
        }
      }
      if (!closestPair) {
        break;
      }

      const [i, j] = closestPair;
      const weights = computeCentroidWeights(centroids, samples);
      centroids[i] = mergeColorsByWeight(
        centroids[i],
        weights[i],
        centroids[j],
        weights[j],
      );
      centroids.splice(j, 1);

      const reseedColor = findReseedColor(
        weightedColors,
        centroids,
        minSeparationSq,
      );
      if (reseedColor) {
        centroids.push(reseedColor.clone());
        refineCentroids(centroids, samples, 4);
      }
    }

    // Safety net: guarantee no near-duplicates survive even if the bounded loop
    // ran out of rounds, dropping to fewer colors before returning duplicates.
    const finalWeights = computeCentroidWeights(centroids, samples);
    return collapseNearDuplicateColors(
      centroids.map((color, index) => ({
        color,
        weight: finalWeights[index],
      })),
      minSeparationSq,
    ).map((entry) => entry.color);
  }

  return centroids;
}

function findNearestPaletteIndex(
  color: THREE.Color,
  palette: THREE.Color[],
): number {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  palette.forEach((paletteColor, index) => {
    const distance =
      (color.r - paletteColor.r) ** 2 +
      (color.g - paletteColor.g) ** 2 +
      (color.b - paletteColor.b) ** 2;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });

  return nearestIndex;
}

function perceivedBrightness(color: THREE.Color): number {
  return color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
}

function colorToHex(color: THREE.Color): string {
  return `#${color.getHexString().toUpperCase()}`;
}

function getBambuOrcaPaintColor(colorIndex: number): string {
  return (
    BAMBU_ORCA_FILAMENT_SLOT_CODES[
      clampIndex(colorIndex, BAMBU_ORCA_FILAMENT_SLOT_CODES.length)
    ] ?? BAMBU_ORCA_FILAMENT_SLOT_CODES[0]
  );
}

function normalizePalette(palette: string[]): string[] {
  const normalized = palette
    .map((color) => color.trim().toUpperCase())
    .filter((color) => /^#[0-9A-F]{6}$/.test(color));

  return normalized.length > 0 ? normalized : ['#CCCCCC'];
}

function getMaterialResourceCounts(modelXml: string): Map<string, number> {
  const resourceMaterialCounts = new Map<string, number>();

  for (const match of modelXml.matchAll(
    /<basematerials\b([^>]*)>([\s\S]*?)<\/basematerials>/g,
  )) {
    const id = parseXmlAttributes(match[1]).get('id');
    if (id) {
      resourceMaterialCounts.set(id, match[2].match(/<base\b/g)?.length ?? 0);
    }
  }

  for (const match of modelXml.matchAll(
    /<m:colorgroup\b([^>]*)>([\s\S]*?)<\/m:colorgroup>/g,
  )) {
    const id = parseXmlAttributes(match[1]).get('id');
    if (id) {
      resourceMaterialCounts.set(
        id,
        match[2].match(/<m:color\b/g)?.length ?? 0,
      );
    }
  }

  return resourceMaterialCounts;
}

function validateMaterialIndex(
  pid: string,
  materialIndex: number,
  resourceMaterialCounts: Map<string, number>,
): void {
  if (!Number.isInteger(materialIndex) || materialIndex < 0) {
    throw new Error(`3MF triangle has invalid material index ${materialIndex}`);
  }

  const materialCount = resourceMaterialCounts.get(pid);
  if (materialCount === undefined) {
    throw new Error(`3MF triangle references missing material resource ${pid}`);
  }

  if (materialIndex >= materialCount) {
    throw new Error(
      `3MF triangle material index ${materialIndex} exceeds ${materialCount} available materials`,
    );
  }
}

// Bambu Studio's ConfigBase::load_from_json parses each value as a string (or a
// depth-2 array of strings) and `break`s the load loop on the first value it
// can't read — silently dropping every key that sorts after it alphabetically.
// A single numeric/boolean/object leaf therefore truncates the whole config, so
// the generated settings must contain string leaves only.
function assertProjectSettingValuesAreStrings(settings: {
  [key: string]: unknown;
}): void {
  const isStringArray = (value: unknown): boolean =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string');

  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'string') {
      continue;
    }
    if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === 'string' || isStringArray(entry))
    ) {
      continue;
    }
    throw new Error(
      `3MF project settings ${key} has a non-string value; Bambu's loader stops parsing at the first non-string value`,
    );
  }
}

function validateProjectSettingsColors(
  projectSettingsConfig: string,
  modelXml: string,
): void {
  const projectSettings = JSON.parse(projectSettingsConfig) as {
    filament_colour?: unknown;
    [key: string]: unknown;
  };

  assertProjectSettingValuesAreStrings(projectSettings);

  if (!Array.isArray(projectSettings.filament_colour)) {
    throw new Error('3MF project settings are missing filament_colour');
  }

  const baseColors = [
    ...modelXml.matchAll(/displaycolor="(#[0-9A-Fa-f]{6})/g),
  ].map((match) => match[1].toUpperCase());
  const filamentColors = projectSettings.filament_colour.map((color) =>
    typeof color === 'string' ? color.toUpperCase() : '',
  );

  if (baseColors.length !== filamentColors.length) {
    throw new Error(
      '3MF project settings color count does not match materials',
    );
  }

  baseColors.forEach((color, index) => {
    if (filamentColors[index] !== color) {
      throw new Error(
        `3MF project settings color ${filamentColors[index]} does not match material ${color}`,
      );
    }
  });

  for (const key of [
    'default_filament_colour',
    'filament_type',
    'filament_settings_id',
    'filament_vendor',
    'filament_diameter',
    'filament_density',
    'filament_cost',
    'filament_ids',
    'filament_is_support',
    'filament_soluble',
    'filament_minimal_purge_on_wipe_tower',
    'filament_start_gcode',
    'filament_end_gcode',
    'filament_max_volumetric_speed',
    'filament_flow_ratio',
    'nozzle_temperature',
    'nozzle_temperature_initial_layer',
    'nozzle_temperature_range_high',
    'nozzle_temperature_range_low',
  ]) {
    const value = projectSettings[key];
    if (!Array.isArray(value) || value.length !== filamentColors.length) {
      throw new Error(
        `3MF project settings ${key} count does not match materials`,
      );
    }
  }

  if (Array.isArray(projectSettings.filament_is_mixed)) {
    validateMixedFilamentProjectSettings(
      projectSettings,
      filamentColors.length,
    );
  }
}

// Full-spectrum settings expand the palette into physical + mixed slots. Every
// per-filament mixed array must cover all slots, the mixed flags must line up
// with valid components referencing physical slots, and each mixed slot's
// sublayer ratios must parse and sum to 1.0.
function validateMixedFilamentProjectSettings(
  projectSettings: { [key: string]: unknown },
  slotCount: number,
): void {
  for (const key of [
    'filament_is_mixed',
    'filament_colour_type',
    'filament_multi_colour',
    'filament_mixed_components',
    'filament_mixed_sublayer_ratios',
    'filament_map',
  ]) {
    const value = projectSettings[key];
    if (!Array.isArray(value) || value.length !== slotCount) {
      throw new Error(`3MF project settings ${key} count does not match slots`);
    }
  }

  if (projectSettings.enable_mixed_color_sublayer !== '1') {
    throw new Error(
      '3MF mixed-filament settings must enable sublayer splitting',
    );
  }

  const isMixed = projectSettings.filament_is_mixed as unknown[];
  const physicalSlotCount = isMixed.filter((flag) => flag === '0').length;
  const components = projectSettings.filament_mixed_components as unknown[];
  const ratios = projectSettings.filament_mixed_sublayer_ratios as unknown[];

  isMixed.forEach((flag, index) => {
    if (flag !== '1') {
      return;
    }

    const slotComponents = String(components[index] ?? '')
      .split(',')
      .filter((part) => part.length > 0)
      .map((part) => Number.parseInt(part, 10));
    if (slotComponents.length < 2) {
      throw new Error('3MF mixed slot must blend at least two filaments');
    }
    for (const component of slotComponents) {
      if (
        !Number.isInteger(component) ||
        component < 1 ||
        component > physicalSlotCount
      ) {
        throw new Error(
          `3MF mixed slot component ${component} is not a physical slot`,
        );
      }
    }

    const slotRatios = String(ratios[index] ?? '')
      .split(',')
      .map((part) => Number.parseFloat(part));
    if (slotRatios.length !== slotComponents.length) {
      throw new Error(
        '3MF mixed slot ratio count does not match its components',
      );
    }
    const ratioSum = slotRatios.reduce((sum, ratio) => sum + ratio, 0);
    if (
      slotRatios.some((ratio) => !Number.isFinite(ratio)) ||
      Math.abs(ratioSum - 1) > 1e-6
    ) {
      throw new Error('3MF mixed slot sublayer ratios must sum to 1.0');
    }
  });
}

function parseXmlAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(
    /([A-Za-z_:][A-Za-z0-9_:.-]*)="([^"]*)"/g,
  )) {
    attributes.set(match[1], match[2]);
  }
  return attributes;
}

function readWorldVertex(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
  matrixWorld: THREE.Matrix4,
): VectorTuple {
  const vertex = new THREE.Vector3(
    position.getX(index),
    position.getY(index),
    position.getZ(index),
  );
  vertex.applyMatrix4(matrixWorld);
  return [vertex.x, vertex.y, vertex.z];
}

function getVertexKey([x, y, z]: VectorTuple): string {
  return [
    Math.round(x / VERTEX_KEY_PRECISION),
    Math.round(y / VERTEX_KEY_PRECISION),
    Math.round(z / VERTEX_KEY_PRECISION),
  ].join(',');
}

function getWorldEdgeKey(left: VectorTuple, right: VectorTuple): string {
  return [getVertexKey(left), getVertexKey(right)].sort().join('|');
}

function getSpatialCell([x, y, z]: VectorTuple, size: number): VectorTuple {
  return [Math.floor(x / size), Math.floor(y / size), Math.floor(z / size)];
}

function getSpatialCellKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function getVertexDistanceSquared(a: VectorTuple, b: VectorTuple): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function getTriangleGeometryKey(
  vertices: VectorTuple[],
  triangle: Omit<ThreeMfTriangle, 'colorIndex'>,
): string {
  return [triangle.v1, triangle.v2, triangle.v3]
    .map((index) => getVertexKey(vertices[index]))
    .sort()
    .join('|');
}

function getTriangleCentroid(
  vertices: VectorTuple[],
  triangle: Omit<ThreeMfTriangle, 'colorIndex'>,
): THREE.Vector3 {
  const a = vertices[triangle.v1];
  const b = vertices[triangle.v2];
  const c = vertices[triangle.v3];

  return new THREE.Vector3(
    (a[0] + b[0] + c[0]) / 3,
    (a[1] + b[1] + c[1]) / 3,
    (a[2] + b[2] + c[2]) / 3,
  );
}

function remapTopologyVertices(
  vertices: VectorTuple[],
  weldTolerance = 0,
): { vertexIndexes: number[]; vertexCount: number } {
  if (weldTolerance <= 0) {
    return {
      vertexIndexes: vertices.map((_, index) => index),
      vertexCount: vertices.length,
    };
  }

  const vertexIndexes: number[] = [];
  const weldedVertexIndexes = new Map<string, number>();
  for (const vertex of vertices) {
    const key = vertex
      .map((value) => Math.floor(value / weldTolerance))
      .join(',');
    let weldedIndex = weldedVertexIndexes.get(key);
    if (weldedIndex === undefined) {
      weldedIndex = weldedVertexIndexes.size;
      weldedVertexIndexes.set(key, weldedIndex);
    }
    vertexIndexes.push(weldedIndex);
  }

  return {
    vertexIndexes,
    vertexCount: weldedVertexIndexes.size,
  };
}

function getEdgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function remapVertexIndex(
  sourceIndex: number,
  vertexRemap: Map<number, number>,
  vertices: VectorTuple[],
  sourceVertices: VectorTuple[],
): number {
  const existingIndex = vertexRemap.get(sourceIndex);
  if (existingIndex !== undefined) {
    return existingIndex;
  }

  const vertexIndex = vertices.length;
  vertexRemap.set(sourceIndex, vertexIndex);
  vertices.push(sourceVertices[sourceIndex]);
  return vertexIndex;
}

function getIndexCount(geometry: THREE.BufferGeometry): number {
  return geometry.index?.count ?? geometry.attributes.position.count;
}

function getVertexIndex(
  geometry: THREE.BufferGeometry,
  offset: number,
): number {
  return geometry.index ? geometry.index.getX(offset) : offset;
}

function wrapTextureCoordinate(value: number): number {
  return ((value % 1) + 1) % 1;
}

function clampIndex(value: number, length: number): number {
  return Math.min(Math.max(0, value), Math.max(0, length - 1));
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }

  return Number.parseFloat(value.toFixed(6)).toString();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlDeclaration(content: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${content}`;
}
