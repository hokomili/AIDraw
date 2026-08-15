import { useState } from 'react';
import type { TileMapObject } from '@aidraw/core';
import {
  deleteTileObjectProperty,
  editTileObject,
  setTileObjectProperty,
} from '../../common/tile-object-authoring';

type PropertyType = 'string' | 'number' | 'boolean';

function propertyType(value: string | number | boolean): PropertyType {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function sameEditableFields(left: TileMapObject, right: TileMapObject): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
    && left.rotation === right.rotation
    && left.name === right.name
    && left.className === right.className
    && JSON.stringify(left.properties) === JSON.stringify(right.properties);
}

function numberDraft(value: string, label: string): number {
  if (!value.trim()) throw new RangeError(`${label} is required.`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new RangeError(`${label} must be a finite number.`);
  return number;
}

export function TileMapObjectInspector({
  object,
  identity,
  disabled = false,
  onReplace,
  onInvalid,
}: {
  object: TileMapObject;
  identity: string;
  disabled?: boolean;
  onReplace: (object: TileMapObject, label: string) => void;
  onInvalid: (message: string) => void;
}) {
  const [x, setX] = useState(String(object.x));
  const [y, setY] = useState(String(object.y));
  const [width, setWidth] = useState(String(object.width));
  const [height, setHeight] = useState(String(object.height));
  const [rotation, setRotation] = useState(String(object.rotation));
  const [name, setName] = useState(object.name);
  const [className, setClassName] = useState(object.className);
  const [propertyName, setPropertyName] = useState('');
  const [propertyTypeChoice, setPropertyTypeChoice] = useState<PropertyType>('string');
  const [propertyValue, setPropertyValue] = useState('');

  const resetDraft = () => {
    setX(String(object.x)); setY(String(object.y)); setWidth(String(object.width)); setHeight(String(object.height));
    setRotation(String(object.rotation)); setName(object.name); setClassName(object.className);
  };
  const applyFields = () => {
    try {
      const next = editTileObject(object, {
        x: numberDraft(x, 'Tile-object X'), y: numberDraft(y, 'Tile-object Y'), width: numberDraft(width, 'Tile-object width'), height: numberDraft(height, 'Tile-object height'), rotation: numberDraft(rotation, 'Tile-object clockwise rotation'),
        name, className, properties: object.properties,
      });
      if (sameEditableFields(next, object)) { resetDraft(); return; }
      onReplace(next, 'Edit tile object');
    } catch (error) {
      onInvalid(error instanceof Error ? error.message : 'The tile object fields are invalid.');
    }
  };
  const setProperty = () => {
    try {
      const exactExistingKey = Object.hasOwn(object.properties, propertyName);
      const effectiveKey = exactExistingKey ? propertyName : propertyName.trim();
      const next = setTileObjectProperty(object, propertyName, propertyTypeChoice, propertyValue);
      if (sameEditableFields(next, object)) { setPropertyName(''); setPropertyValue(''); return; }
      onReplace(next, Object.hasOwn(object.properties, effectiveKey) ? 'Edit tile object property' : 'Add tile object property');
      setPropertyName(''); setPropertyValue('');
    } catch (error) {
      onInvalid(error instanceof Error ? error.message : 'The tile object property is invalid.');
    }
  };

  return <section className="tile-object-inspector" aria-label="Selected tile object">
    <div className="section-heading"><span>Tile object</span><small>{identity}</small></div>
    <p className="tile-object-identity">Tile identity and transformed GID are fixed. Use the canvas Tile object tool to create another tile.</p>
    <div className="tile-object-field-grid">
      <label className="field"><span>X</span><input aria-label="Tile object X" type="number" value={x} disabled={disabled} onChange={(event) => setX(event.target.value)} /></label>
      <label className="field"><span>Y</span><input aria-label="Tile object Y" type="number" value={y} disabled={disabled} onChange={(event) => setY(event.target.value)} /></label>
      <label className="field"><span>Width</span><input aria-label="Tile object width" type="number" min="1" value={width} disabled={disabled} onChange={(event) => setWidth(event.target.value)} /></label>
      <label className="field"><span>Height</span><input aria-label="Tile object height" type="number" min="1" value={height} disabled={disabled} onChange={(event) => setHeight(event.target.value)} /></label>
      <label className="field"><span>Clockwise rotation</span><input aria-label="Tile object clockwise rotation" type="number" value={rotation} disabled={disabled} onChange={(event) => setRotation(event.target.value)} /></label>
      <label className="field"><span>Name</span><input aria-label="Tile object name" maxLength={200} value={name} disabled={disabled} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field"><span>Class</span><input aria-label="Tile object class" maxLength={200} value={className} disabled={disabled} onChange={(event) => setClassName(event.target.value)} /></label>
    </div>
    <div className="tile-object-actions"><button type="button" disabled={disabled} onClick={applyFields}>Apply tile object fields</button></div>
    <div className="section-heading"><span>Typed properties</span><small>{Object.keys(object.properties).length}</small></div>
    <div className="tile-object-property-editor">
      <input aria-label="Tile object property name" placeholder="name" maxLength={200} value={propertyName} disabled={disabled} onChange={(event) => setPropertyName(event.target.value)} />
      <select aria-label="Tile object property type" value={propertyTypeChoice} disabled={disabled} onChange={(event) => { const next = event.target.value as PropertyType; setPropertyTypeChoice(next); if (next === 'boolean' && propertyValue !== 'true' && propertyValue !== 'false') setPropertyValue('false'); }}><option value="string">String</option><option value="number">Number</option><option value="boolean">Boolean</option></select>
      {propertyTypeChoice === 'boolean'
        ? <select aria-label="Tile object property value" value={propertyValue} disabled={disabled} onChange={(event) => setPropertyValue(event.target.value)}><option value="false">false</option><option value="true">true</option></select>
        : <input aria-label="Tile object property value" value={propertyValue} disabled={disabled} onChange={(event) => setPropertyValue(event.target.value)} />}
      <button type="button" disabled={disabled || (!Object.hasOwn(object.properties, propertyName) && !propertyName.trim())} onClick={setProperty}>Set</button>
    </div>
    <div className="tile-object-property-list">{Object.entries(object.properties).map(([key, value]) => <div key={key}>
      <button type="button" className="tile-object-property-main" disabled={disabled} onClick={() => { setPropertyName(key); setPropertyTypeChoice(propertyType(value)); setPropertyValue(String(value)); }}><strong>{key}</strong><span>{propertyType(value)} · {String(value)}</span></button>
      <button type="button" disabled={disabled} aria-label={`Delete tile object property ${key}`} onClick={() => onReplace(deleteTileObjectProperty(object, key), 'Delete tile object property')}>×</button>
    </div>)}</div>
  </section>;
}
