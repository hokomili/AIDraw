import { useCallback, useEffect, useRef, useState } from 'react';
import { DiamondPlus, Pause, Play, RotateCcw, Trash2 } from 'lucide-react';
import {
  HUMAN_ACTOR,
  createId,
  illustrationKeyframesForObject,
  illustrationPlaybackTime,
  nowIso,
  type CanvasOperation,
  type IllustrationDocument,
  type IllustrationKeyframe,
  type IllustrationKeyframeEasing,
} from '@aidraw/core';
import { useEditorStore } from '../store';

function timeLabel(timeMs: number): string { return `${(timeMs / 1_000).toFixed(2)}s`; }

export function IllustrationAnimationPanel({ document }: { document: IllustrationDocument }) {
  const apply = useEditorStore((state) => state.apply);
  const animationState = useEditorStore((state) => state.canvasAnimation);
  const setCanvasAnimation = useEditorStore((state) => state.setCanvasAnimation);
  const selectedIds = useEditorStore((state) => state.selectedEntityIds);
  const setSelected = useEditorStore((state) => state.setSelectedEntities);
  const [easing, setEasing] = useState<IllustrationKeyframeEasing>('ease-in-out');
  const elapsedRef = useRef(0);
  const selectedObjects = selectedIds.map((id) => document.objects[id]).filter((object) => Boolean(object));
  const timeMs = Math.max(0, Math.min(document.animation.durationMs, animationState?.illustrationTimeMs ?? 0));
  const playing = animationState?.illustrationTimeMs !== undefined && animationState.playing;

  const publish = useCallback((nextTime: number, nextPlaying: boolean) => setCanvasAnimation({
    playing: nextPlaying,
    onionSkin: false,
    direction: document.animation.playback === 'ping-pong' ? 'ping-pong' : 'forward',
    illustrationTimeMs: Math.max(0, Math.min(document.animation.durationMs, nextTime)),
  }), [document.animation.durationMs, document.animation.playback, setCanvasAnimation]);

  useEffect(() => {
    elapsedRef.current = 0;
    setCanvasAnimation({ playing: false, onionSkin: false, direction: document.animation.playback === 'ping-pong' ? 'ping-pong' : 'forward', illustrationTimeMs: 0 });
    return () => {
      if (useEditorStore.getState().canvasAnimation?.illustrationTimeMs !== undefined) setCanvasAnimation(undefined);
    };
  }, [document.animation.playback, document.id, setCanvasAnimation]);

  useEffect(() => {
    if (!playing) return;
    const step = Math.max(16, Math.round(1_000 / document.animation.framesPerSecond));
    const timer = window.setInterval(() => {
      elapsedRef.current += step;
      if (document.animation.playback === 'once' && elapsedRef.current >= document.animation.durationMs) {
        publish(document.animation.durationMs, false);
        return;
      }
      publish(illustrationPlaybackTime(document.animation, elapsedRef.current), true);
    }, step);
    return () => window.clearInterval(timer);
  }, [document.animation, playing, publish]);

  const scrub = (nextTime: number) => {
    elapsedRef.current = nextTime;
    publish(nextTime, false);
  };

  const togglePlayback = () => {
    if (!document.animation.keyframeIds.length) return;
    if (playing) { publish(timeMs, false); return; }
    const restart = document.animation.playback === 'once' && timeMs >= document.animation.durationMs;
    elapsedRef.current = restart ? 0 : timeMs;
    publish(restart ? 0 : timeMs, true);
  };

  const changeSettings = (settings: Partial<IllustrationDocument['animation']>) => void apply('Change illustration animation', [{
    kind: 'illustration.animation.settings.replace',
    settings: { durationMs: document.animation.durationMs, framesPerSecond: document.animation.framesPerSecond, playback: document.animation.playback, ...settings },
    expectedRevision: document.revision,
  }]);

  const keyframesAtPlayhead = selectedObjects.flatMap((object) => illustrationKeyframesForObject(document, object.id).filter((keyframe) => keyframe.timeMs === Math.round(timeMs)));
  const captureKeyframes = async () => {
    const timestamp = nowIso(); const operations: CanvasOperation[] = [];
    for (const object of selectedObjects) {
      const existing = illustrationKeyframesForObject(document, object.id).find((keyframe) => keyframe.timeMs === Math.round(timeMs));
      const keyframe: IllustrationKeyframe = {
        id: existing?.id ?? createId('keyframe'), revision: existing?.revision ?? 0, name: `${object.name} · ${timeLabel(timeMs)}`,
        createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp, createdBy: existing?.createdBy ?? HUMAN_ACTOR.id,
        objectId: object.id, timeMs: Math.round(timeMs), transform: structuredClone(object.transform), opacity: object.opacity, visible: object.visible, easing,
      };
      operations.push({ kind: 'illustration.animation.keyframe.upsert', keyframe, expectedRevision: existing?.revision });
    }
    await apply(keyframesAtPlayhead.length ? 'Update illustration keyframe' : 'Add illustration keyframe', operations);
  };

  const deleteAtPlayhead = () => void apply('Delete illustration keyframe', keyframesAtPlayhead.map((keyframe) => ({ kind: 'illustration.animation.keyframe.delete', keyframeId: keyframe.id, expectedRevision: keyframe.revision })));
  const orderedKeyframes = document.animation.keyframeIds.map((id) => document.animation.keyframes[id]).filter((entry) => Boolean(entry)).sort((left, right) => left.timeMs - right.timeMs || left.objectId.localeCompare(right.objectId));

  return <div className="illustration-animation-panel">
    <div className="animation-transport">
      <button className="animation-play" disabled={!orderedKeyframes.length} onClick={togglePlayback} title={playing ? 'Pause illustration animation' : 'Play illustration animation'}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
      <button onClick={() => scrub(0)} title="Return to the design pose"><RotateCcw size={14} /></button>
      <strong>{timeLabel(timeMs)}</strong><span>/ {timeLabel(document.animation.durationMs)}</span>
    </div>
    <div className="illustration-time-track">
      <input aria-label="Illustration animation playhead" type="range" min={0} max={document.animation.durationMs} step={1} value={Math.round(timeMs)} onChange={(event) => scrub(Number(event.target.value))} />
      <div className="illustration-keyframe-markers" aria-label={`${orderedKeyframes.length} illustration keyframes`}>
        {orderedKeyframes.map((keyframe) => <button key={keyframe.id} style={{ left: `${keyframe.timeMs / document.animation.durationMs * 100}%` }} className={Math.round(timeMs) === keyframe.timeMs ? 'is-active' : ''} title={`${document.objects[keyframe.objectId]?.name ?? 'Orphaned object'} · ${timeLabel(keyframe.timeMs)}`} onClick={() => { scrub(keyframe.timeMs); if (document.objects[keyframe.objectId]) setSelected([keyframe.objectId]); }} />)}
      </div>
    </div>
    <div className="animation-settings-grid">
      <label><span>Duration</span><input key={`${document.id}:${document.animation.durationMs}`} type="number" min={0.1} max={600} step={0.1} defaultValue={document.animation.durationMs / 1_000} onBlur={(event) => { const durationMs = Math.round(Number(event.target.value) * 1_000); if (Number.isFinite(durationMs) && durationMs >= 1 && durationMs <= 600_000 && durationMs !== document.animation.durationMs) changeSettings({ durationMs }); }} /></label>
      <label><span>FPS</span><select value={document.animation.framesPerSecond} onChange={(event) => changeSettings({ framesPerSecond: Number(event.target.value) })}>{[6, 8, 12, 15, 24, 30, 60].map((fps) => <option key={fps} value={fps}>{fps}</option>)}</select></label>
      <label><span>Playback</span><select value={document.animation.playback} onChange={(event) => changeSettings({ playback: event.target.value as IllustrationDocument['animation']['playback'] })}><option value="once">Once</option><option value="loop">Loop</option><option value="ping-pong">Ping-pong</option></select></label>
    </div>
    <div className="animation-keyframe-actions">
      <label><span>Transition</span><select value={easing} onChange={(event) => setEasing(event.target.value as IllustrationKeyframeEasing)}><option value="ease-in-out">Ease in/out</option><option value="linear">Linear</option><option value="hold">Hold</option></select></label>
      <button disabled={!selectedObjects.length} onClick={() => void captureKeyframes()}><DiamondPlus size={14} />{keyframesAtPlayhead.length ? 'Update pose' : 'Capture pose'}</button>
      <button className="danger" disabled={!keyframesAtPlayhead.length} onClick={deleteAtPlayhead}><Trash2 size={14} />Delete</button>
    </div>
    <p className="animation-selection-note">{selectedObjects.length ? `${selectedObjects.length} selected object${selectedObjects.length === 1 ? '' : 's'} · captures transform, opacity, and visibility.` : 'Select one or more vector objects, move to a time, then capture their pose.'}</p>
    <div className="animation-keyframe-list">
      {orderedKeyframes.length ? orderedKeyframes.slice(0, 200).map((keyframe) => <button key={keyframe.id} className={Math.round(timeMs) === keyframe.timeMs ? 'is-active' : ''} onClick={() => { scrub(keyframe.timeMs); if (document.objects[keyframe.objectId]) setSelected([keyframe.objectId]); }}><span>{document.objects[keyframe.objectId]?.name ?? 'Orphaned object'}</span><small>{timeLabel(keyframe.timeMs)} · {keyframe.easing}</small></button>) : <span className="empty-animation">No keyframes yet.</span>}
      {orderedKeyframes.length > 200 && <span className="empty-animation">Showing the first 200 of {orderedKeyframes.length} keyframes.</span>}
    </div>
  </div>;
}
