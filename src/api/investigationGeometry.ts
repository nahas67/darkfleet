/** Separate analyst geometry endpoint, not SAR measurement / sensor evidence. */
import { api, ContractViolation, request } from './errors';
import { validateShape } from './validateGenerated';
import {
  GEOMETRYOUT_FIELDS, GEOMETRYLISTOUT_FIELDS,
  GEOMETRYINPUT_FIELDS, MEASUREMENTS_FIELDS,
} from './contract';
import type {
  GeometryCreate, GeometryInput, GeometryOut, GeometryListOut, Measurements,
} from './contract';

export type GeometryKind = GeometryInput['kind'];
export type LonLat = [number, number];
export type GeoShape = GeometryInput & { readonly radius_m: number | null };
export type GeoDraft = GeometryCreate & { readonly geometry: GeoShape };
// Backend serializes nullable fields even though generated schema marks their
// Pydantic defaults optional; validate their presence before narrowing here.
export type GeoMeasurements = Required<Measurements>;
export type GeoAnnotation = Omit<GeometryOut, 'geometry' | 'measurements' | 'provenance'> & {
  readonly provenance: 'OPERATOR_ANNOTATION_NOT_SENSOR_EVIDENCE';
  readonly geometry: GeoShape;
  readonly measurements: GeoMeasurements;
};

const kinds: ReadonlyArray<string> = ['point', 'polyline', 'polygon', 'range_ring'];
const scalar = (o: Record<string, unknown>, name: string, nullable = false): number | null => {
  const value = o[name];
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ContractViolation(`geometry.${name}`, 'Expected a finite number.');
  }
  return value;
};
const string = (o: Record<string, unknown>, key: string): string => {
  if (typeof o[key] !== 'string') {
    throw new ContractViolation(`geometry.${key}`, 'Expected a string.');
  }
  return o[key] as string;
};

export function readGeoAnnotation(payload: unknown): GeoAnnotation {
  const result = validateShape<GeometryOut>(payload, GEOMETRYOUT_FIELDS, 'GeometryOut');
  for (const field of ['id', 'investigation_id', 'label', 'notes', 'created_at', 'updated_at']) {
    string(result as unknown as Record<string, unknown>, field);
  }
  if (result.scan_id !== null && typeof result.scan_id !== 'string') {
    throw new ContractViolation('geometry.scan_id', 'Expected a scan ID or null.');
  }
  if (result.provenance !== 'OPERATOR_ANNOTATION_NOT_SENSOR_EVIDENCE') {
    throw new ContractViolation('geometry.provenance', 'Operator provenance declaration missing.');
  }
  const shape = validateShape<GeometryInput>(
    result.geometry, GEOMETRYINPUT_FIELDS, 'GeometryInput',
  );
  if (typeof shape.kind !== 'string' || !kinds.includes(shape.kind)) {
    throw new ContractViolation('geometry.kind', 'Unrecognized geometry type.');
  }
  if (!Array.isArray(shape.coordinates) || shape.coordinates.length < 1 || shape.coordinates.length > 250) {
    throw new ContractViolation('geometry.coordinates', 'Expected a bounded list of WGS84 vertices.');
  }
  for (const pair of shape.coordinates) {
    if (!Array.isArray(pair) || pair.length !== 2 ||
        !pair.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) ||
        pair[0] < -180 || pair[0] > 180 || pair[1] < -90 || pair[1] > 90) {
      throw new ContractViolation('geometry.coordinates', 'Vertex is not a WGS84 lon/lat pair.');
    }
  }
  scalar(shape as unknown as Record<string, unknown>, 'radius_m', true);
  const measurements = validateShape<Measurements>(
    result.measurements, MEASUREMENTS_FIELDS, 'Measurements',
  );
  if (measurements.ellipsoid !== 'WGS84') {
    throw new ContractViolation('geometry.ellipsoid', 'Expected the WGS84 ellipsoid.');
  }
  string(measurements as unknown as Record<string, unknown>, 'method');
  for (const metric of [
    'length_m', 'length_km', 'length_nm', 'initial_bearing_deg',
    'perimeter_m', 'perimeter_km', 'perimeter_nm', 'area_m2', 'area_km2',
    'radius_m', 'radius_km', 'radius_nm',
  ]) scalar(measurements as unknown as Record<string, unknown>, metric, true);
  return result as GeoAnnotation;
}

const endpoint = (caseId: string) => `/api/investigations/${encodeURIComponent(caseId)}/geometries`;

export async function listGeoAnnotations(caseId: string): Promise<GeoAnnotation[]> {
  const result = validateShape<GeometryListOut>(
    await api.get<unknown>(endpoint(caseId)), GEOMETRYLISTOUT_FIELDS, 'GeometryListOut',
  );
  if (!Array.isArray(result.geometries)) {
    throw new ContractViolation('GeometryListOut.geometries', 'Expected an array, not an empty assumption.');
  }
  return result.geometries.map(readGeoAnnotation);
}

export async function createGeoAnnotation(caseId: string, draft: GeoDraft): Promise<GeoAnnotation> {
  return readGeoAnnotation(await api.post<unknown>(endpoint(caseId), draft));
}

export async function updateGeoAnnotation(
  caseId: string, annotationId: string, draft: GeoDraft,
): Promise<GeoAnnotation> {
  return readGeoAnnotation(await request<unknown>(
    `${endpoint(caseId)}/${encodeURIComponent(annotationId)}`,
    { method: 'PUT', body: JSON.stringify(draft) },
  ));
}

export async function deleteGeoAnnotation(caseId: string, annotationId: string): Promise<void> {
  await api.delete(`${endpoint(caseId)}/${encodeURIComponent(annotationId)}`);
}

/** UI parser only: backend performs authoritative shape and geodesy validation. */
export function parseLonLatLines(input: string): LonLat[] {
  const lines = input.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 250) throw new Error('Provide 1–250 WGS84 vertices.');
  return lines.map((line, index) => {
    const parts = line.split(/[\s,;]+/);
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (parts.length !== 2 || !parts.every((part) => part.length > 0) ||
        !Number.isFinite(lon) || !Number.isFinite(lat) ||
        lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw new Error(`Vertex ${index + 1}: enter longitude, latitude in WGS84 degrees.`);
    }
    return [lon, lat];
  });
}
