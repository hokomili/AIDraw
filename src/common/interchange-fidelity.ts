export const INTERCHANGE_FIDELITY_CODES = [
  'raster-fallback',
  'flattened-layer',
  'font-substitution',
  'searchable-text-retained',
  'searchable-text-omitted',
  'animation-frames-omitted',
] as const;

export type InterchangeFidelityCode = typeof INTERCHANGE_FIDELITY_CODES[number];

export const INTERCHANGE_FIDELITY_SUBJECT_TYPES = ['document', 'layer', 'object'] as const;
export type InterchangeFidelitySubjectType = typeof INTERCHANGE_FIDELITY_SUBJECT_TYPES[number];

export interface InterchangeFidelityEntry {
  code: InterchangeFidelityCode;
  subjectType: InterchangeFidelitySubjectType;
  subjectId: string;
  subjectName: string;
  detail?: string;
}

export const MAX_INTERCHANGE_FIDELITY_ENTRIES = 4_096;
export const MAX_INTERCHANGE_FIDELITY_SUBJECT_CHARACTERS = 1_024;
export const MAX_INTERCHANGE_FIDELITY_DETAIL_CHARACTERS = 4_096;

const codes = new Set<string>(INTERCHANGE_FIDELITY_CODES);
const subjectTypes = new Set<string>(INTERCHANGE_FIDELITY_SUBJECT_TYPES);

function hasExactKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => ['code', 'subjectType', 'subjectId', 'subjectName', 'detail'].includes(key))
    && ['code', 'subjectType', 'subjectId', 'subjectName'].every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function boundedString(value: unknown, maximum: number, allowEmpty = true): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0);
}

export function isInterchangeFidelityEntry(value: unknown): value is InterchangeFidelityEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  if (!hasExactKeys(source)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  if (Object.values(descriptors).some((descriptor) => !Object.prototype.hasOwnProperty.call(descriptor, 'value'))) return false;
  const code = descriptors.code.value; const subjectType = descriptors.subjectType.value;
  const subjectId = descriptors.subjectId.value; const subjectName = descriptors.subjectName.value; const detail = descriptors.detail?.value;
  return typeof code === 'string' && codes.has(code)
    && typeof subjectType === 'string' && subjectTypes.has(subjectType)
    && boundedString(subjectId, MAX_INTERCHANGE_FIDELITY_SUBJECT_CHARACTERS, false)
    && boundedString(subjectName, MAX_INTERCHANGE_FIDELITY_SUBJECT_CHARACTERS)
    && (detail === undefined || boundedString(detail, MAX_INTERCHANGE_FIDELITY_DETAIL_CHARACTERS));
}

export function normalizeInterchangeFidelityEntries(value: unknown): InterchangeFidelityEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => isInterchangeFidelityEntry(entry) ? [structuredClone(entry)] : [])
    .slice(0, MAX_INTERCHANGE_FIDELITY_ENTRIES);
}

export function tryAppendInterchangeFidelityEntry(target: InterchangeFidelityEntry[], entry: InterchangeFidelityEntry): boolean {
  if (target.length >= MAX_INTERCHANGE_FIDELITY_ENTRIES) return false;
  target.push(entry);
  return true;
}

export function interchangeFidelityCodeLabel(code: InterchangeFidelityCode): string {
  switch (code) {
    case 'raster-fallback': return 'Raster fallback';
    case 'flattened-layer': return 'Flattened layer';
    case 'font-substitution': return 'Font substitution';
    case 'searchable-text-retained': return 'Searchable text retained';
    case 'searchable-text-omitted': return 'Searchable text omitted';
    case 'animation-frames-omitted': return 'Animation frames omitted';
  }
}
