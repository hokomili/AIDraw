import { Plus, Trash2 } from 'lucide-react';
import {
  deleteCustomProperty,
  setCustomProperty,
  type CustomPropertyAction,
  type CustomPropertyValue,
} from '../custom-properties';

function propertyType(value: CustomPropertyValue): 'string' | 'number' | 'boolean' {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function exactText(value: string): string {
  return JSON.stringify(value);
}

function valueText(value: CustomPropertyValue): string {
  return typeof value === 'string' ? exactText(value) : String(value);
}

export function CustomPropertyEditor({
  title,
  scopeLabel,
  className,
  properties,
  nameDraft,
  valueDraft,
  onNameDraftChange,
  onValueDraftChange,
  onChange,
}: {
  title: string;
  scopeLabel: string;
  className?: string;
  properties: Record<string, CustomPropertyValue>;
  nameDraft: string;
  valueDraft: string;
  onNameDraftChange: (value: string) => void;
  onValueDraftChange: (value: string) => void;
  onChange: (properties: Record<string, CustomPropertyValue>, action: CustomPropertyAction) => void;
}) {
  const submittedKey = nameDraft.trim();
  const overwriting = Boolean(submittedKey) && Object.hasOwn(properties, submittedKey);
  const scope = scopeLabel.toLowerCase();
  const setProperty = () => {
    if (!submittedKey) return;
    onChange(setCustomProperty(properties, nameDraft, valueDraft), 'set');
    onNameDraftChange('');
    onValueDraftChange('');
  };

  return (
    <section className={`custom-property-editor${className ? ` ${className}` : ''}`} aria-label={`${scopeLabel} custom properties`}>
      <div className="section-heading custom-property-heading"><span>{title}</span><small>{Object.keys(properties).length}</small></div>
      <div className="custom-property-fields">
        <label className="custom-property-field">
          <span>Name</span>
          <input aria-label={`${scopeLabel} property name`} placeholder="Property name" value={nameDraft} onChange={(event) => onNameDraftChange(event.currentTarget.value)} />
        </label>
        <label className="custom-property-field">
          <span>Value</span>
          <input aria-label={`${scopeLabel} property value`} placeholder="Property value" value={valueDraft} onChange={(event) => onValueDraftChange(event.currentTarget.value)} />
        </label>
        <button type="button" className="custom-property-set" disabled={!submittedKey} aria-label={`${overwriting ? 'Overwrite' : 'Add'} ${scope} property${submittedKey ? ` ${submittedKey}` : ''}`} onClick={setProperty}><Plus aria-hidden="true" /><span>{overwriting ? 'Overwrite property' : 'Add property'}</span></button>
      </div>
      <p className="custom-property-inference">Names trim on submit. Only lowercase true/false become boolean; other nonempty finite numbers become number; everything else remains exact text.</p>
      <div className="custom-property-list" role="list" aria-label={`${scopeLabel} retained custom properties`}>
        {Object.entries(properties).map(([key, value], index) => {
          const type = propertyType(value);
          return <article className="custom-property-entry" role="listitem" key={key} aria-label={`${scopeLabel} property ${index + 1}, key ${exactText(key)}, type ${type}, value ${valueText(value)}`}>
            <div className="custom-property-entry-heading"><strong>Property {index + 1}</strong><button type="button" aria-label={`Delete ${scope} property ${key}`} onClick={() => onChange(deleteCustomProperty(properties, key), 'delete')}><Trash2 aria-hidden="true" /><span>Delete property</span></button></div>
            <dl className="custom-property-details">
              <div className="custom-property-key"><dt>Key</dt><dd><code>{exactText(key)}</code></dd></div>
              <div className="custom-property-type"><dt>Type</dt><dd>{type}</dd></div>
              <div className="custom-property-value"><dt>Value</dt><dd><code>{valueText(value)}</code></dd></div>
            </dl>
          </article>;
        })}
        {Object.keys(properties).length === 0 && <p className="custom-property-empty" role="status">No {scope} custom properties.</p>}
      </div>
    </section>
  );
}
