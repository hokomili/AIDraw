import type { Actor } from '@aidraw/core';
import type { CSSProperties } from 'react';

export interface PlaybackLaneEntry {
  actor: Actor;
  label: string;
  lane: number;
  progress: number;
}

export function PlaybackLanes({ playbacks }: { playbacks: PlaybackLaneEntry[] }) {
  if (playbacks.length === 0) return null;
  const ordered = [...playbacks].sort((left, right) => left.lane - right.lane || left.actor.name.localeCompare(right.actor.name));

  return (
    <div className="playback-lanes" role="region" aria-label="Active agent playback lanes">
      {ordered.map((playback) => {
        const progress = Math.max(0, Math.min(1, playback.progress));
        return (
          <div
            className="playback-lane"
            data-playback-lane={playback.lane}
            key={`${playback.lane}:${playback.actor.id}`}
            style={{ '--actor': playback.actor.color } as CSSProperties}
            title={playback.label}
          >
            <span className="playback-lane-dot" />
            <strong>Lane {playback.lane + 1}</strong>
            <span className="playback-lane-agent">{playback.actor.name}</span>
            <progress aria-label={`${playback.actor.name} playback progress`} max={1} value={progress} />
          </div>
        );
      })}
    </div>
  );
}
