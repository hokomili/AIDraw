export type CustomPropertyValue = string | number | boolean;
export type CustomPropertyAction = 'set' | 'delete';

export function parseCustomPropertyDraft(value: string): CustomPropertyValue {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return value;
}

export function setCustomProperty(
  properties: Record<string, CustomPropertyValue>,
  submittedName: string,
  valueDraft: string,
): Record<string, CustomPropertyValue> {
  const key = submittedName.trim();
  if (!key) return properties;
  return { ...properties, [key]: parseCustomPropertyDraft(valueDraft) };
}

export function deleteCustomProperty(
  properties: Record<string, CustomPropertyValue>,
  exactKey: string,
): Record<string, CustomPropertyValue> {
  const next = { ...properties };
  delete next[exactKey];
  return next;
}
