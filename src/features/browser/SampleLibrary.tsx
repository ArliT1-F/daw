import { useState, type DragEvent } from 'react';
import type { AudioAsset, Channel } from '../../core/project/model';
import { Icon } from '../../components/Icon';
import { describeAsset } from './sampleFormat';

/** MIME type used when dragging a library row onto a Channel Rack row. */
export const ASSET_DRAG_TYPE = 'application/x-gridline-asset';

export interface LibraryNotice {
  tone: 'info' | 'error';
  message: string;
}

interface SampleLibraryProps {
  assets: readonly AudioAsset[];
  isLoaded: (assetId: string) => boolean;
  /** Channel that "Assign" targets, or null when no channel is selected. */
  activeChannel: Channel | null;
  busy: boolean;
  notice: LibraryNotice | null;
  onDismissNotice: () => void;
  onImportFiles: (files: File[]) => void;
  onLoadStarterPack: () => void;
  onPreviewAsset: (assetId: string) => void;
  onAssignAsset: (channelId: string, assetId: string) => void;
}

const ACCEPT = 'audio/*,.wav,.mp3,.ogg,.oga,.flac,.m4a,.aac,.opus,.webm,.aif,.aiff';

export function SampleLibrary({
  assets,
  isLoaded,
  activeChannel,
  busy,
  notice,
  onDismissNotice,
  onImportFiles,
  onLoadStarterPack,
  onPreviewAsset,
  onAssignAsset,
}: SampleLibraryProps) {
  const [dragging, setDragging] = useState(false);
  const missingCount = assets.filter((asset) => !isLoaded(asset.id)).length;

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    setDragging(true);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length > 0) onImportFiles(files);
  }

  return (
    <section aria-label="Sample library" className="library-section">
      <div className="browser-section-head">
        <span className="eyebrow">SAMPLES</span>
        <span className="browser-count">{assets.length}{missingCount > 0 ? ` · ${missingCount} missing` : ''}</span>
      </div>

      <div
        className={`library-drop ${dragging ? 'library-drop--active' : ''}`}
        onDragLeave={() => setDragging(false)}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <label className="library-import-button">
          <input
            accept={ACCEPT}
            aria-label="Import audio files into the sample library"
            className="sr-only-input"
            disabled={busy}
            multiple
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = '';
              if (files.length > 0) onImportFiles(files);
            }}
            type="file"
          />
          <Icon name="plus" size={11} /> Import
        </label>
        <span className="library-drop-hint">{busy ? 'Decoding…' : 'Drop audio files here'}</span>
      </div>

      <button className="button button--quiet library-pack-button" disabled={busy} onClick={onLoadStarterPack} type="button">
        Add 808 starter kit (CC0)
      </button>

      {notice ? (
        <div className={`library-notice library-notice--${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          <span>{notice.message}</span>
          <button aria-label="Dismiss library message" className="rack-row-error-dismiss" onClick={onDismissNotice} type="button">
            <Icon name="close" size={10} />
          </button>
        </div>
      ) : null}

      {assets.length === 0 ? (
        <p className="library-empty">No samples yet. Imported files appear here and can be assigned to any channel.</p>
      ) : (
        <ul aria-label="Loaded samples" className="library-list">
          {assets.map((asset) => {
            const loaded = isLoaded(asset.id);
            return (
              <li
                aria-label={`${asset.name}${loaded ? '' : ', missing'}`}
                className={`library-item ${loaded ? '' : 'library-item--missing'}`}
                draggable={loaded}
                key={asset.id}
                onDragStart={(event) => {
                  event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
                  event.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <div className="library-item-main">
                  <span className="library-item-name" title={asset.name}>{asset.name}</span>
                  <span className="library-item-meta">
                    {loaded ? describeAsset(asset) : 'Missing from this session — import the same file to relink it'}
                  </span>
                </div>
                <button
                  aria-label={`Preview ${asset.name}`}
                  className="rack-preview-button"
                  disabled={!loaded}
                  onClick={() => onPreviewAsset(asset.id)}
                  title={loaded ? `Play ${asset.name}` : 'This sample is missing'}
                  type="button"
                >
                  <Icon name="play" size={10} />
                </button>
                <button
                  aria-label={activeChannel ? `Assign ${asset.name} to ${activeChannel.name}` : `Assign ${asset.name}`}
                  className="button button--quiet library-assign"
                  disabled={!loaded || !activeChannel}
                  onClick={() => activeChannel && onAssignAsset(activeChannel.id, asset.id)}
                  title={activeChannel ? `Assign to ${activeChannel.name}` : 'Select a channel first'}
                  type="button"
                >
                  {activeChannel ? `→ ${activeChannel.name}` : 'Assign'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="library-footnote">Drag a sample onto a Channel Rack row to assign it.</p>
    </section>
  );
}
