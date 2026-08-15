export function focusDisclosureTriggerBeforeCollapse(
  expanded: boolean,
  activeElementInside: boolean,
  focusTrigger: () => void,
): boolean {
  if (!expanded || !activeElementInside) return false;
  focusTrigger();
  return true;
}
